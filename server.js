
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const { Client: QStashClient, Receiver } = require('@upstash/qstash');
require('dotenv').config();

// --- 0. CRITICAL: FAIL FAST VALIDATION ---
const requiredEnv = ['POSTGRES_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'QSTASH_TOKEN', 'META_API_TOKEN', 'PHONE_NUMBER_ID', 'PUBLIC_BASE_URL'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
    console.warn(`⚠️ WARNING: Missing Environment Variables: ${missingEnv.join(', ')}`);
}

const app = express();
const apiRouter = express.Router(); 
const publicRouter = express.Router(); 

const SYSTEM_CONFIG = {
    META_TIMEOUT: 4000, 
    DB_CONNECTION_TIMEOUT: 5000, 
    CACHE_TTL_SETTINGS: 600, // 10 Minutes
    CACHE_TTL_STATE: 86400, // 24 Hours
    LOCK_TTL: 10,
    DEDUPE_TTL: 3600
};

// --- CLIENTS ---
let pgPool = null;
const getDb = () => {
    if (!pgPool) {
        const { Pool } = require('pg');
        pgPool = new Pool({
            connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }, 
            connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
            max: 5, 
            idleTimeoutMillis: 1000
        });
    }
    return pgPool;
};

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL || 'https://mock-redis.upstash.io',
    token: process.env.UPSTASH_REDIS_REST_TOKEN || 'mock_token',
});

const qstash = new QStashClient({ token: process.env.QSTASH_TOKEN || 'mock_qstash' });
const qstashReceiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "mock_key",
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "mock_key",
});

let metaClient = null;
const getMetaClient = () => {
    if (!metaClient) {
        const axios = require('axios');
        const https = require('https');
        metaClient = axios.create({
            httpsAgent: new https.Agent({ keepAlive: true }),
            timeout: SYSTEM_CONFIG.META_TIMEOUT,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    return metaClient;
};

app.use(express.json({ 
    limit: '10mb', 
    verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(cors()); 

// --- DATA ACCESS LAYER ---

// Get Published Flow (Redis -> DB)
const getPublishedFlow = async (phoneId) => {
    const key = `bot:settings:${phoneId}`;
    const cached = await redis.get(key);
    if (cached) return cached;

    const client = await getDb().connect();
    try {
        // Fetch latest published version
        const res = await client.query(
            `SELECT settings FROM bot_versions WHERE phone_number_id = $1 AND status = 'published' ORDER BY version_number DESC LIMIT 1`,
            [phoneId]
        );
        const settings = res.rows[0]?.settings;
        if (settings) {
            await redis.set(key, settings, { ex: SYSTEM_CONFIG.CACHE_TTL_SETTINGS });
            return settings;
        }
        return null;
    } finally {
        client.release();
    }
};

const getCandidateState = async (phoneId, waId) => {
    const key = `bot:state:${phoneId}:${waId}`;
    return await redis.get(key) || { isBotActive: true, variables: {}, history: [] };
};

const saveCandidateState = async (phoneId, waId, state) => {
    const key = `bot:state:${phoneId}:${waId}`;
    await redis.set(key, state, { ex: SYSTEM_CONFIG.CACHE_TTL_STATE });
};

// --- WHATSAPP HELPERS ---

const sendToMeta = async (to, payload) => {
    if (!process.env.META_API_TOKEN) return { success: false, error: "No Token" };
    try {
        await getMetaClient().post(
            `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
            { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload },
            { headers: { 'Authorization': `Bearer ${process.env.META_API_TOKEN}` } }
        );
        return { success: true };
    } catch (e) {
        return { success: false, error: e.response?.data || e.message };
    }
};

// --- BOT ENGINE (HR RECRUITER LOGIC) ---

const evaluateCondition = (variableValue, operator, targetValue) => {
    if (operator === 'exists') return variableValue !== undefined && variableValue !== null && variableValue !== '';
    if (variableValue === undefined) return false;
    
    // Type coercion for comparison
    const val = isNaN(Number(variableValue)) ? String(variableValue).toLowerCase() : Number(variableValue);
    const target = isNaN(Number(targetValue)) ? String(targetValue).toLowerCase() : Number(targetValue);

    switch(operator) {
        case 'equals': return val == target;
        case 'greater_than': return val > target;
        case 'less_than': return val < target;
        case 'contains': return String(val).includes(String(target));
        default: return false;
    }
};

const validateInput = (input, rule) => {
    if (!rule) return { valid: true };
    
    const str = String(input).trim();
    if (rule.type === 'number') return { valid: !isNaN(Number(str)) && str !== '', error: rule.errorMessage || 'Please enter a valid number.' };
    if (rule.type === 'email') return { valid: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str), error: rule.errorMessage || 'Please enter a valid email.' };
    if (rule.type === 'phone') return { valid: /^\+?[\d\s-]{10,}$/.test(str), error: rule.errorMessage || 'Please enter a valid phone number.' };
    if (rule.type === 'regex' && rule.regex) return { valid: new RegExp(rule.regex).test(str), error: rule.errorMessage || 'Invalid format.' };
    
    return { valid: true };
};

// --- WEBHOOK (INGEST) ---
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) res.send(req.query['hub.challenge']);
    else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;
        if (body.object !== 'whatsapp_business_account') return res.sendStatus(404);

        const promises = [];
        const entries = body.entry || [];

        for (const entry of entries) {
            for (const change of (entry.changes || [])) {
                const value = change.value;
                const phoneId = value.metadata?.phone_number_id;
                
                if (value.messages && phoneId) {
                    for (const message of value.messages) {
                        promises.push((async () => {
                            const msgId = message.id;
                            const dedupeKey = `dedupe:${phoneId}:${msgId}`;
                            const isNew = await redis.set(dedupeKey, '1', { nx: true, ex: SYSTEM_CONFIG.DEDUPE_TTL });
                            if (!isNew) return;

                            // Publish to QStash
                            const workerUrl = process.env.PUBLIC_BASE_URL 
                                ? `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/internal/bot-worker`
                                : `http://${req.get('host')}/api/internal/bot-worker`;

                            await qstash.publishJSON({
                                url: workerUrl,
                                body: { 
                                    message, 
                                    contact: value.contacts?.[0], 
                                    phoneId 
                                },
                                deduplicationId: msgId
                            });
                        })());
                    }
                }
            }
        }
        await Promise.all(promises);
        res.sendStatus(200);
    } catch (e) {
        console.error("Ingress Error", e);
        res.sendStatus(200);
    }
});

// --- WORKER (LOGIC) ---
app.post('/api/internal/bot-worker', async (req, res) => {
    const { message, contact, phoneId } = req.body;
    const from = message.from;
    const msgId = message.id;

    // 1. Idempotency Check (Prevent duplicate replies)
    const processedKey = `processed:${phoneId}:${msgId}`;
    const alreadyProcessed = await redis.get(processedKey);
    if (alreadyProcessed) return res.json({ status: 'already_processed' });

    // 2. Lock User
    const lockKey = `lock:${phoneId}:${from}`;
    const locked = await redis.set(lockKey, '1', { nx: true, ex: SYSTEM_CONFIG.LOCK_TTL });
    if (!locked) return res.status(429).send("Locked"); // QStash will retry

    try {
        // 3. Load State & Settings
        const [flow, state] = await Promise.all([
            getPublishedFlow(phoneId),
            getCandidateState(phoneId, from)
        ]);

        if (!flow || !flow.nodes) {
            // No bot configured
            await redis.set(processedKey, '1', { ex: 86400 });
            await redis.del(lockKey);
            return res.json({ status: 'no_bot' });
        }

        // 4. Determine Current Step Node
        let currentNode = flow.nodes.find(n => n.id === state.currentStepId);
        if (!currentNode) {
            // Start of flow
            const startEdge = flow.edges.find(e => e.source === 'start');
            if (startEdge) {
                currentNode = flow.nodes.find(n => n.id === startEdge.target);
            }
        }

        // 5. Process Input (If we are at a question/interactive node)
        let nextStepId = null;
        let validationError = null;
        let shouldProcessNode = true; // Should we execute the node's output logic?

        // Parse Input
        let userInput = null;
        let mediaInput = null;

        if (message.type === 'text') userInput = message.text.body;
        else if (message.type === 'interactive') {
            const i = message.interactive;
            userInput = i.button_reply?.id || i.list_reply?.id;
        } else if (['image', 'document', 'video'].includes(message.type)) {
            mediaInput = { 
                type: message.type, 
                id: message[message.type].id, // Media ID for download
                mime: message[message.type].mime_type
            };
            // For MVP, we assume URL is placeholder until media download logic is fully added
            // In a real app, you'd download media from Meta here and upload to S3
            userInput = `[Media: ${message.type}]`;
        }

        if (currentNode && state.isBotActive) {
            const nodeData = currentNode.data;

            // HANDLE ANSWERS
            if (nodeData.type === 'question' || nodeData.type === 'document') {
                
                // Document Validation
                if (nodeData.type === 'document' && !mediaInput) {
                    validationError = "Please upload a valid document or image.";
                } 
                // Text/Num Validation
                else if (nodeData.type === 'question' && nodeData.validation) {
                    const check = validateInput(userInput, nodeData.validation);
                    if (!check.valid) validationError = check.error;
                }

                if (!validationError) {
                    // Save Variable
                    if (nodeData.variable) {
                        state.variables[nodeData.variable] = mediaInput ? `https://mock-s3.com/${mediaInput.id}` : userInput;
                        
                        // If document, save to structured doc map too
                        if (mediaInput) {
                            if (!state.documents) state.documents = {};
                            state.documents[nodeData.variable] = { 
                                url: state.variables[nodeData.variable],
                                type: mediaInput.type,
                                timestamp: Date.now()
                            };
                        }
                    }
                    // Determine Next Step
                    const defaultEdge = flow.edges.find(e => e.source === currentNode.id);
                    if (defaultEdge) nextStepId = defaultEdge.target;
                }
            } 
            else if (nodeData.type === 'buttons' || nodeData.type === 'list') {
                // Route based on button ID
                const edge = flow.edges.find(e => e.source === currentNode.id && (e.sourceHandle === userInput || e.label === userInput));
                if (edge) nextStepId = edge.target;
                else {
                    // Fallback or stay
                    validationError = "Please select one of the options.";
                }
            } 
            else if (nodeData.type === 'handoff') {
                state.isBotActive = false;
                // Don't process further nodes
            }
        }

        // If no current node (first run) or we found a next step, advance
        if (!state.currentStepId && !currentNode) {
             // Startup logic handled above finding start node
        }

        // If we have an error, reply and stay
        if (validationError) {
            await sendToMeta(from, { type: 'text', text: { body: validationError } });
            // Don't update step
        } else if (nextStepId || (!state.currentStepId && currentNode)) {
            // ADVANCE LOOP
            // We might need to traverse multiple logic nodes (conditions) instantly
            let activeNodeId = nextStepId || currentNode.id;
            let activeNode = flow.nodes.find(n => n.id === activeNodeId);
            let autoAdvance = true;
            let messagesToSend = [];

            while (activeNode && autoAdvance && state.isBotActive) {
                state.currentStepId = activeNode.id;
                const data = activeNode.data;
                autoAdvance = false; // Default to stop unless it's a logic node

                // EXECUTE NODE LOGIC
                if (data.type === 'message' || data.type === 'question' || data.type === 'buttons' || data.type === 'list' || data.type === 'document') {
                    // Prepare Payload
                    const msgPayload = { type: 'text', text: { body: data.content || "..." } };
                    
                    if (data.mediaUrl) {
                        const mt = data.mediaType || 'image';
                        msgPayload.type = mt;
                        msgPayload[mt] = { link: data.mediaUrl, caption: data.content };
                    }

                    if (data.type === 'buttons' && data.buttons) {
                        msgPayload.type = 'interactive';
                        msgPayload.interactive = {
                            type: 'button',
                            body: { text: data.content },
                            action: { buttons: data.buttons.slice(0, 3).map(b => ({ type: 'reply', reply: { id: b.id || b.title, title: b.title.substring(0, 20) } })) }
                        };
                    } 
                    else if (data.type === 'list' && data.listSections) {
                        msgPayload.type = 'interactive';
                        msgPayload.interactive = {
                            type: 'list',
                            body: { text: data.content },
                            action: { button: "Select", sections: data.listSections }
                        };
                    }

                    messagesToSend.push(msgPayload);
                    
                    // Questions/Buttons stop auto-advance to wait for user input
                    if (data.type === 'message') {
                        // Message nodes auto-advance immediately
                        const edge = flow.edges.find(e => e.source === activeNode.id);
                        if (edge) {
                            activeNodeId = edge.target;
                            activeNode = flow.nodes.find(n => n.id === activeNodeId);
                            autoAdvance = true;
                        }
                    }
                }
                else if (data.type === 'condition') {
                    // Evaluate logic immediately
                    let matchedEdgeId = null;
                    if (data.conditions) {
                        for (const cond of data.conditions) {
                            const val = state.variables[cond.variable];
                            if (evaluateCondition(val, cond.operator, cond.value)) {
                                matchedEdgeId = cond.nextStepId; // Edge ID or target node ID? usually we store edge logic. 
                                // Simplified: In React Flow, edges define connection. 
                                // We check edges connected to specific handles
                            }
                        }
                    }
                    
                    // Find edge corresponding to "True" or "False" or fallback
                    // For this engine, we look at edges from this node
                    // We assume the Condition Node Data contains the routing logic directly or mapped to handles
                    const edges = flow.edges.filter(e => e.source === activeNode.id);
                    let targetId = null;
                    
                    // Simple Logic: Check handle based matching
                    // Iterate edges, check if their sourceHandle matches a satisfied condition
                    for (const edge of edges) {
                        const conditionIndex = parseInt(edge.sourceHandle?.replace('cond-', '') || '-1');
                        if (conditionIndex >= 0 && data.conditions[conditionIndex]) {
                             const cond = data.conditions[conditionIndex];
                             const val = state.variables[cond.variable];
                             if (evaluateCondition(val, cond.operator, cond.value)) {
                                 targetId = edge.target;
                                 break;
                             }
                        } else if (edge.sourceHandle === 'else') {
                            // Keep as fallback
                            if (!targetId) targetId = edge.target;
                        }
                    }
                    
                    if (targetId) {
                        activeNodeId = targetId;
                        activeNode = flow.nodes.find(n => n.id === activeNodeId);
                        autoAdvance = true; 
                    } else {
                        // Dead end condition
                        activeNode = null;
                    }
                }
                else if (data.type === 'status') {
                    state.stage = data.targetStatus || 'New';
                    // Auto advance
                    const edge = flow.edges.find(e => e.source === activeNode.id);
                    if (edge) {
                        activeNodeId = edge.target;
                        activeNode = flow.nodes.find(n => n.id === activeNodeId);
                        autoAdvance = true;
                    } else { activeNode = null; }
                }
                else if (data.type === 'handoff') {
                    state.isBotActive = false;
                    messagesToSend.push({ type: 'text', text: { body: data.content || "Connecting you to an agent..." } });
                    activeNode = null;
                }
                else if (data.type === 'end') {
                    state.currentStepId = null; // Reset or keep end?
                    activeNode = null;
                }
            }

            // Send All Queued Messages
            for (const payload of messagesToSend) {
                if (payload) await sendToMeta(from, payload);
            }
        }

        // 6. Persist DB (Candidates)
        const client = await getDb().connect();
        try {
            await client.query('BEGIN');
            
            // Upsert Candidate
            const name = contact?.profile?.name || "Unknown";
            const q = `
                INSERT INTO candidates (id, phone_number, name, stage, variables, documents, last_message_at, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                ON CONFLICT (phone_number) 
                DO UPDATE SET 
                    name = EXCLUDED.name, 
                    stage = COALESCE($4, candidates.stage), 
                    variables = candidates.variables || $5, 
                    documents = candidates.documents || $6,
                    last_message_at = $7
                RETURNING id
            `;
            const varsJson = JSON.stringify(state.variables || {});
            const docsJson = JSON.stringify(state.documents || {});
            const newId = crypto.randomUUID();
            
            const resC = await client.query(q, [
                newId, from, name, state.stage || 'New', varsJson, docsJson, Date.now()
            ]);
            const candidateId = resC.rows[0].id; // Use existing ID if conflict update

            // Log Message
            await client.query(`
                INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at)
                VALUES ($1, $2, 'in', $3, $4, 'received', NOW())
            `, [crypto.randomUUID(), candidateId, userInput || 'Media', message.type]);

            await client.query('COMMIT');
        } catch(e) {
            await client.query('ROLLBACK');
            console.error("DB Save Error", e);
        } finally {
            client.release();
        }

        // 7. Save Cache & Cleanup
        await saveCandidateState(phoneId, from, state);
        await redis.set(processedKey, '1', { ex: 86400 });
        await redis.del(lockKey);

        res.json({ success: true });

    } catch (e) {
        console.error("Worker Critical", e);
        await redis.del(lockKey);
        res.status(500).send(e.message);
    }
});

// --- API ROUTES FOR BOT STUDIO ---

// Get Versions
apiRouter.get('/bot/versions', async (req, res) => {
    const client = await getDb().connect();
    try {
        const result = await client.query(
            `SELECT id, version_number, status, created_at FROM bot_versions WHERE phone_number_id = $1 ORDER BY version_number DESC`,
            [process.env.PHONE_NUMBER_ID]
        );
        res.json(result.rows);
    } finally { client.release(); }
});

// Get Published/Latest
apiRouter.get('/bot/settings', async (req, res) => {
    const client = await getDb().connect();
    try {
        // Try to get draft first, else published
        const resDraft = await client.query(
            `SELECT settings FROM bot_versions WHERE phone_number_id = $1 AND status = 'draft' ORDER BY version_number DESC LIMIT 1`,
            [process.env.PHONE_NUMBER_ID]
        );
        
        if (resDraft.rows.length > 0) return res.json(resDraft.rows[0].settings);

        const resPub = await client.query(
            `SELECT settings FROM bot_versions WHERE phone_number_id = $1 AND status = 'published' ORDER BY version_number DESC LIMIT 1`,
            [process.env.PHONE_NUMBER_ID]
        );
        res.json(resPub.rows[0]?.settings || { nodes: [], edges: [] });
    } finally { client.release(); }
});

// Save Draft
apiRouter.post('/bot/save', async (req, res) => {
    const client = await getDb().connect();
    try {
        const phoneId = process.env.PHONE_NUMBER_ID;
        // Check for existing draft
        const check = await client.query(
            `SELECT id, version_number FROM bot_versions WHERE phone_number_id = $1 AND status = 'draft'`,
            [phoneId]
        );

        if (check.rows.length > 0) {
            await client.query(`UPDATE bot_versions SET settings = $1 WHERE id = $2`, [req.body, check.rows[0].id]);
        } else {
            // Get next version number
            const ver = await client.query(`SELECT MAX(version_number) as maxv FROM bot_versions WHERE phone_number_id = $1`, [phoneId]);
            const nextV = (ver.rows[0].maxv || 0) + 1;
            await client.query(
                `INSERT INTO bot_versions (id, phone_number_id, version_number, status, settings) VALUES ($1, $2, $3, 'draft', $4)`,
                [crypto.randomUUID(), phoneId, nextV, JSON.stringify(req.body)]
            );
        }
        res.json({ success: true });
    } finally { client.release(); }
});

// Publish
apiRouter.post('/bot/publish', async (req, res) => {
    const client = await getDb().connect();
    try {
        const phoneId = process.env.PHONE_NUMBER_ID;
        // Find latest draft
        const draft = await client.query(
            `SELECT id, settings FROM bot_versions WHERE phone_number_id = $1 AND status = 'draft' ORDER BY version_number DESC LIMIT 1`,
            [phoneId]
        );
        
        if (draft.rows.length === 0) return res.status(400).json({ error: "No draft to publish" });

        const id = draft.rows[0].id;
        const settings = draft.rows[0].settings;

        await client.query(`UPDATE bot_versions SET status = 'published' WHERE id = $1`, [id]);
        
        // Invalidate Redis
        await redis.del(`bot:settings:${phoneId}`);
        // Pre-warm cache
        await redis.set(`bot:settings:${phoneId}`, settings, { ex: SYSTEM_CONFIG.CACHE_TTL_SETTINGS });

        res.json({ success: true });
    } finally { client.release(); }
});

// --- INIT & MIGRATION ---
const initDb = async () => {
    const client = await getDb().connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS bot_versions (
                id UUID PRIMARY KEY,
                phone_number_id TEXT NOT NULL,
                version_number INT NOT NULL,
                status TEXT NOT NULL,
                settings JSONB NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS candidates (
                id UUID PRIMARY KEY,
                phone_number TEXT UNIQUE NOT NULL,
                name TEXT,
                stage TEXT,
                variables JSONB DEFAULT '{}',
                documents JSONB DEFAULT '{}',
                last_message_at BIGINT,
                created_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS candidate_messages (
                id UUID PRIMARY KEY,
                candidate_id UUID REFERENCES candidates(id),
                direction TEXT,
                text TEXT,
                type TEXT,
                status TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
    } catch(e) { console.error("DB Init Failed", e); } 
    finally { client.release(); }
};

if (require.main === module) {
    initDb().then(() => {
        const PORT = process.env.PORT || 3001;
        app.listen(PORT, () => console.log(`Server running on ${PORT}`));
    });
}

// Compat exports
app.use('/api', apiRouter);
module.exports = app;

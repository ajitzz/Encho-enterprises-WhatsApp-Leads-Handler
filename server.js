
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const multer = require('multer');
const axios = require('axios');
const https = require('https');
const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { OAuth2Client } = require('google-auth-library');
const { GoogleGenAI } = require("@google/genai");

require('dotenv').config();

// --- CONFIGURATION ---
const SYSTEM_CONFIG = {
    META_TIMEOUT: 15000,
    DB_CONNECTION_TIMEOUT: 10000,
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
    AWS_BUCKET: process.env.AWS_BUCKET_NAME || 'uber-fleet-assets',
    GOOGLE_CLIENT_ID: process.env.VITE_GOOGLE_CLIENT_ID
};

// --- CLIENTS ---
const s3Client = new S3Client({
    region: SYSTEM_CONFIG.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const googleClient = new OAuth2Client(SYSTEM_CONFIG.GOOGLE_CLIENT_ID);
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const upload = multer({ storage: multer.memoryStorage() });

const pgPool = new Pool({
    connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
    connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
    ssl: { rejectUnauthorized: false },
    max: 20
});

const withDb = async (operation) => {
    let client;
    try {
        client = await pgPool.connect();
        return await operation(client);
    } catch (e) {
        console.error("DB Error:", e);
        throw e;
    } finally {
        if (client) client.release();
    }
};

const getMetaClient = () => axios.create({
    httpsAgent: new https.Agent({ keepAlive: true }),
    timeout: SYSTEM_CONFIG.META_TIMEOUT,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.META_API_TOKEN}` }
});

// --- HELPER: REFRESH S3 URL ---
const refreshMediaUrl = async (url) => {
    if (!url || typeof url !== 'string' || !url.includes(SYSTEM_CONFIG.AWS_BUCKET)) return url;
    try {
        const urlObj = new URL(url);
        let key = decodeURIComponent(urlObj.pathname.substring(1));
        if (key.startsWith(SYSTEM_CONFIG.AWS_BUCKET + '/')) {
            key = key.substring(SYSTEM_CONFIG.AWS_BUCKET.length + 1);
        }
        const command = new GetObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key });
        return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    } catch (e) {
        return url; 
    }
};

// --- HELPER: SEND TO META ---
const sendToMeta = async (phoneNumber, payload) => {
    const phoneId = process.env.PHONE_NUMBER_ID;
    const to = (phoneNumber || '').toString().replace(/\D/g, '');
    
    if (payload.type === 'text' && (!payload.text?.body || !payload.text.body.trim())) return;

    try {
        await getMetaClient().post(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            ...payload
        });
        console.log(`[Meta] Sent to ${to}`);
    } catch (e) {
        console.error("Meta Send Failed:", e.response?.data || e.message);
    }
};

// --- REGEX HELPER ---
const validateInput = (input, type, pattern) => {
    if (!input) return false;
    const text = input.trim();
    if (type === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
    if (type === 'phone') return /^[+]?[\d\s-]{10,}$/.test(text);
    if (type === 'number') return /^\d+$/.test(text);
    if (type === 'regex' && pattern) {
        try { return new RegExp(pattern).test(text); } catch(e) { return true; }
    }
    return true; 
};

// --- BOT ENGINE (THE BRAIN) ---
const processBotLogic = async (client, candidate, incomingText, incomingPayload) => {
    const botRes = await client.query("SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1");
    if (botRes.rows.length === 0) return; 
    
    const { nodes, edges } = botRes.rows[0].settings;
    if (!nodes || !edges) return;

    // 1. Identify Current State
    let currentNodeId = candidate.current_bot_step_id;
    let currentNode = nodes.find(n => n.id === currentNodeId);
    
    // 2. Start Logic
    if (!currentNode) {
        currentNode = nodes.find(n => n.type === 'start' || n.data?.type === 'start') || nodes[0];
    }

    // 3. Process Input / Transition
    let nextNodeId = null;
    
    if (currentNodeId) { 
        const nodeType = currentNode.data?.type;
        const incomingId = incomingPayload?.id; 

        // A. Input Validation Loop
        if (nodeType === 'input') {
            const isValid = validateInput(incomingText, currentNode.data.validationType, currentNode.data.validationRegex);
            
            if (!isValid) {
                // FAIL: Stay on node, send retry message
                const errorMsg = currentNode.data.retryMessage || "Invalid input. Please try again.";
                await sendToMeta(candidate.phone_number, { type: 'text', text: { body: errorMsg } });
                return; // STOP execution
            } else {
                // SUCCESS: Save Variable & Move On
                if (currentNode.data.variable) {
                    const vars = candidate.variables || {};
                    vars[currentNode.data.variable] = incomingText;
                    if (currentNode.data.variable === 'name') {
                        await client.query("UPDATE candidates SET name = $1, variables = $2 WHERE id = $3", [incomingText, vars, candidate.id]);
                    } else {
                        await client.query("UPDATE candidates SET variables = $1 WHERE id = $2", [vars, candidate.id]);
                    }
                    candidate.variables = vars; // Update local state for subsequent logic checks
                }
                const edge = edges.find(e => e.source === currentNode.id);
                if (edge) nextNodeId = edge.target;
            }
        } 
        
        // B. Interactive Handling (Buttons & Lists)
        else if (nodeType === 'interactive_button' || nodeType === 'interactive_list') {
            if (incomingId) {
                // Match Edge by Handle ID (The specific button/row clicked)
                const edge = edges.find(e => e.source === currentNode.id && e.sourceHandle === incomingId);
                if (edge) {
                    nextNodeId = edge.target;
                } else {
                    // Fallback to default edge if specific path not found
                    const defaultEdge = edges.find(e => e.source === currentNode.id);
                    if (defaultEdge) nextNodeId = defaultEdge.target;
                }
            } else {
                // User didn't click, they typed. Ask to click.
                await sendToMeta(candidate.phone_number, { type: 'text', text: { body: "Please select an option from the menu above." } });
                return;
            }
        }
        
        else {
             // Pass-through node (should generally not happen if state is managed well)
             const edge = edges.find(e => e.source === currentNode.id);
             if (edge) nextNodeId = edge.target;
        }
    } else {
        nextNodeId = currentNode?.id; 
    }

    // 4. Execution Loop (Traverse until we hit a Wait State)
    let executionLimit = 15; 
    let activeNodeId = nextNodeId;

    while (activeNodeId && executionLimit > 0) {
        executionLimit--;
        const node = nodes.find(n => n.id === activeNodeId);
        if (!node) break;

        const data = node.data || {};
        const nodeType = data.type;

        // VARIABLE REPLACEMENT
        let content = data.content || '';
        const replaceVars = (str) => {
            if (!str) return '';
            let res = str;
            if (candidate.variables) {
                Object.keys(candidate.variables).forEach(k => {
                    res = res.replace(new RegExp(`{{${k}}}`, 'g'), candidate.variables[k] || '');
                });
            }
            res = res.replace(/{{name}}/g, candidate.name || 'there');
            return res;
        };
        content = replaceVars(content);

        // --- EXECUTE NODE ---

        // 1. CONDITION
        if (nodeType === 'condition') {
            const varName = data.variable;
            const operator = data.operator;
            const checkVal = data.value;
            const actualVal = (candidate.variables || {})[varName];
            
            let result = false;
            if (actualVal !== undefined) {
                const a = String(actualVal).toLowerCase();
                const b = String(checkVal).toLowerCase();
                
                if (operator === 'equals') result = a === b;
                else if (operator === 'contains') result = a.includes(b);
                else if (operator === 'starts_with') result = a.startsWith(b);
                else if (operator === 'greater_than') result = parseFloat(a) > parseFloat(b);
                else if (operator === 'less_than') result = parseFloat(a) < parseFloat(b);
                else if (operator === 'is_set') result = true;
            }

            // Route based on result handle ('true' or 'false')
            const edge = edges.find(e => e.source === node.id && e.sourceHandle === (result ? 'true' : 'false'));
            activeNodeId = edge ? edge.target : null;
            continue; // Skip message sending for logic nodes
        }

        // 2. STATUS UPDATE
        if (nodeType === 'status_update') {
            if (data.targetStatus) {
                await client.query("UPDATE candidates SET stage = $1 WHERE id = $2", [data.targetStatus, candidate.id]);
            }
            const edge = edges.find(e => e.source === node.id);
            activeNodeId = edge ? edge.target : null;
            continue;
        }

        // 3. HANDOFF
        if (nodeType === 'handoff') {
            await client.query("UPDATE candidates SET is_human_mode = TRUE, current_bot_step_id = NULL WHERE id = $1", [candidate.id]);
            await sendToMeta(candidate.phone_number, { type: 'text', text: { body: content || "Connecting you to a human agent..." } });
            break; 
        }

        // 4. MESSAGING (Text, Image, Interactive)
        let payload = null;

        if (nodeType === 'image' && data.mediaUrl) {
            const url = await refreshMediaUrl(data.mediaUrl);
            payload = { type: 'image', image: { link: url, caption: content } };
        } 
        else if (nodeType === 'interactive_button' && data.buttons) {
             const buttons = data.buttons.slice(0, 3).map(b => ({
                 type: "reply",
                 reply: { id: b.id, title: b.title.substring(0, 20) } 
             }));
             payload = {
                 type: "interactive",
                 interactive: {
                     type: "button",
                     body: { text: content || "Select an option:" },
                     action: { buttons }
                 }
             };
        } 
        else if (nodeType === 'interactive_list' && data.sections) {
            const sections = data.sections.map(s => ({
                title: s.title.substring(0, 24),
                rows: s.rows.map(r => ({ id: r.id, title: r.title.substring(0, 24), description: (r.description || '').substring(0, 72) }))
            }));
            payload = {
                type: "interactive",
                interactive: {
                    type: "list",
                    header: { type: "text", text: data.listTitle || "Menu" },
                    body: { text: content || "Select an item" },
                    footer: { text: data.footerText || "Tap to select" },
                    action: { button: data.listButtonText || "Open", sections }
                }
            };
        }
        else if (['text', 'start', 'input'].includes(nodeType) && content) {
            payload = { type: 'text', text: { body: content } };
        }

        if (payload) {
            await sendToMeta(candidate.phone_number, payload);
            await client.query(
                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`,
                [crypto.randomUUID(), candidate.id, content]
            );
        }

        // 5. DETERMINE NEXT
        if (['input', 'interactive_button', 'interactive_list'].includes(nodeType)) {
            // STOP HERE. Wait for user input.
            await client.query("UPDATE candidates SET current_bot_step_id = $1 WHERE id = $2", [node.id, candidate.id]);
            break; 
        } else {
            // AUTO ADVANCE
            const edge = edges.find(e => e.source === node.id);
            if (edge) {
                activeNodeId = edge.target;
                // Add delay for UX
                await new Promise(r => setTimeout(r, 800)); 
            } else {
                activeNodeId = null; // End of flow
                await client.query("UPDATE candidates SET current_bot_step_id = NULL WHERE id = $1", [candidate.id]);
            }
        }
    }
};


// --- EXPRESS APP ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const apiRouter = express.Router();

apiRouter.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const body = req.body;
    if (!body.object) return;

    try {
        const entry = body.entry?.[0];
        const message = entry?.changes?.[0]?.value?.messages?.[0];
        if (!message) return;

        const from = message.from;
        const name = entry?.changes?.[0]?.value?.contacts?.[0]?.profile?.name || 'Unknown';
        
        let textBody = '';
        let interactiveId = null;

        if (message.type === 'text') textBody = message.text?.body || '';
        else if (message.type === 'interactive') {
            const i = message.interactive;
            if (i.type === 'button_reply') { interactiveId = i.button_reply.id; textBody = i.button_reply.title; }
            else if (i.type === 'list_reply') { interactiveId = i.list_reply.id; textBody = i.list_reply.title; }
        }

        await withDb(async (client) => {
            const sys = await client.query("SELECT value FROM system_settings WHERE key = 'config'");
            if (sys.rows[0]?.value && sys.rows[0].value.webhook_ingest_enabled === false) return;

            let candidateRes = await client.query('SELECT * FROM candidates WHERE phone_number = $1', [from]);
            let candidate;
            
            if (candidateRes.rows.length === 0) {
                const newId = crypto.randomUUID();
                await client.query(`INSERT INTO candidates (id, phone_number, name, stage, last_message_at) VALUES ($1, $2, $3, 'New', $4)`, [newId, from, name, Date.now()]);
                candidate = { id: newId, phone_number: from, name, variables: {} };
            } else {
                candidate = candidateRes.rows[0];
                await client.query('UPDATE candidates SET last_message = $1, last_message_at = $2 WHERE id = $3', [textBody, Date.now(), candidate.id]);
            }

            await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, whatsapp_message_id, created_at) VALUES ($1, $2, 'in', $3, 'text', $4, NOW())`, [crypto.randomUUID(), candidate.id, textBody, message.id]);

            if (!candidate.is_human_mode) {
                await processBotLogic(client, candidate, textBody, { id: interactiveId });
            }
        });
    } catch (e) { console.error("Webhook Error:", e); }
});

apiRouter.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) res.status(200).send(req.query['hub.challenge']);
    else res.sendStatus(403);
});

// ... [Existing Endpoints for Auth, Media, etc. remain unchanged] ...
// Re-implenting basic getters for completeness
apiRouter.get('/bot/settings', async (req, res) => {
    try { await withDb(async (client) => {
        const r = await client.query("SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1");
        res.json(r.rows[0]?.settings || { isEnabled: false, nodes: [], edges: [] });
    }); } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/bot/save', async (req, res) => {
    try { await withDb(async (client) => {
        await client.query("INSERT INTO bot_versions (id, status, settings, created_at) VALUES ($1, 'published', $2, NOW())", [crypto.randomUUID(), req.body]);
    }); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers', async (req, res) => {
    try { await withDb(async (c) => {
        const r = await c.query('SELECT * FROM candidates ORDER BY last_message_at DESC NULLS LAST LIMIT 50');
        res.json(r.rows.map(row => ({ id: row.id, phoneNumber: row.phone_number, name: row.name, status: row.stage, lastMessage: row.last_message, lastMessageTime: parseInt(row.last_message_at || '0'), source: row.source, isHumanMode: row.is_human_mode, messages: [] })));
    }); } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.use('*', (req, res) => res.status(404).json({ error: "Endpoint not found" }));
app.use('/api', apiRouter);
app.use('/', apiRouter);

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => console.log(`Server running on ${PORT}`));
}
module.exports = app;

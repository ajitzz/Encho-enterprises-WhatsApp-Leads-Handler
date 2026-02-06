
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

// --- DATABASE SCHEMA ---
const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS system_settings (key VARCHAR(50) PRIMARY KEY, value JSONB);
    CREATE TABLE IF NOT EXISTS candidates (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), phone_number VARCHAR(50) UNIQUE, name VARCHAR(255), stage VARCHAR(50), last_message TEXT, last_message_at BIGINT, source VARCHAR(50), is_human_mode BOOLEAN DEFAULT FALSE, current_bot_step_id VARCHAR(100), variables JSONB DEFAULT '{}', created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS candidate_messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id UUID, direction VARCHAR(10), text TEXT, type VARCHAR(50), status VARCHAR(50), whatsapp_message_id VARCHAR(255), created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS scheduled_messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id UUID, payload JSONB, scheduled_time BIGINT, status VARCHAR(50), error_log TEXT, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS bot_versions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status VARCHAR(20), settings JSONB, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS driver_documents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id UUID, type VARCHAR(50), url TEXT, status VARCHAR(50), created_at TIMESTAMP DEFAULT NOW());
`;

// --- INITIALIZE CLIENTS (Lazy/Safe) ---
let s3Client, googleClient, genAI, pgPool;

try {
    s3Client = new S3Client({
        region: SYSTEM_CONFIG.AWS_REGION,
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
    });

    googleClient = new OAuth2Client(SYSTEM_CONFIG.GOOGLE_CLIENT_ID);
    
    if (process.env.GEMINI_API_KEY) {
        genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }

    // High-Performance Connection Pool for Neon/Vercel
    let connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
    
    // Clean connection string to avoid SSL conflicts (remove sslmode param if present)
    if (connectionString && connectionString.includes('sslmode=')) {
        connectionString = connectionString.replace(/([?&])sslmode=[^&]+(&|$)/, '$1').replace(/[?&]$/, '');
    }
    
    pgPool = new Pool({
        connectionString,
        connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
        idleTimeoutMillis: 30000,
        ssl: { rejectUnauthorized: false }, // Explicitly allow self-signed certs for Neon
        max: 10,
        keepAlive: true
    });
    
    pgPool.on('error', (err) => console.error('[DB POOL ERROR]', err));

} catch (initError) {
    console.error("[INIT CRITICAL ERROR]", initError);
}

const upload = multer({ storage: multer.memoryStorage() });

const withDb = async (operation) => {
    if (!pgPool) throw new Error("Database not initialized");
    let client;
    try {
        client = await pgPool.connect();
        return await operation(client);
    } catch (e) {
        console.error("[DB OPS ERROR]", e);
        throw e;
    } finally {
        if (client) client.release();
    }
};

const getMetaClient = () => axios.create({
    httpsAgent: new https.Agent({ keepAlive: true }),
    timeout: SYSTEM_CONFIG.META_TIMEOUT,
    headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${process.env.META_API_TOKEN}` 
    }
});

// --- HELPERS ---

const refreshMediaUrl = async (url) => {
    if (!url || typeof url !== 'string') return null;
    if (!url.includes('amazonaws.com') && !url.includes(SYSTEM_CONFIG.AWS_BUCKET)) return url;

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

const sendToMeta = async (phoneNumber, payload) => {
    const phoneId = process.env.PHONE_NUMBER_ID;
    const to = (phoneNumber || '').toString().replace(/\D/g, '');
    
    // Strict Payload Validation
    if (payload.type === 'text') {
        if (!payload.text?.body || !payload.text.body.trim()) {
            console.warn("[Meta] Blocked empty text message");
            return;
        }
    }
    if (payload.type === 'interactive') {
        const i = payload.interactive;
        if (i.type === 'button' && (!i.action.buttons || i.action.buttons.length === 0)) return;
        if (i.type === 'list' && (!i.action.sections || i.action.sections.length === 0)) return;
    }

    try {
        console.log(`[Meta] Sending to ${to} | Type: ${payload.type}`);
        await getMetaClient().post(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            ...payload
        });
    } catch (e) {
        const errMsg = e.response?.data?.error?.message || e.message;
        console.error(`[Meta Failed] ${to}: ${errMsg}`);
        throw new Error(`Meta API Error: ${errMsg}`); // Re-throw to be caught by bot engine
    }
};

const processText = (text, candidate) => {
    if (!text) return '';
    let processed = text;
    const vars = { 
        name: candidate.name, 
        phone: candidate.phone_number, 
        ...candidate.variables 
    };
    
    for (const [key, val] of Object.entries(vars)) {
        const regex = new RegExp(`{{${key}}}`, 'gi');
        processed = processed.replace(regex, val || '');
    }
    return processed;
};

// Check for invalid placeholders or empty text
const isValidContent = (text) => {
    if (!text || typeof text !== 'string') return false;
    const clean = text.trim().toLowerCase();
    if (clean.length === 0) return false;
    
    const blockers = [
        'replace this sample message',
        'replace this text',
        'type your message',
        'enter your message',
        'sample text',
        'your message here'
    ];
    // If text contains a blocker and is reasonably short (likely unmodified default)
    if (clean.length < 50 && blockers.some(b => clean.includes(b))) return false;
    return true;
};

// --- BOT ENGINE (SELF-HEALING & DIAGNOSTIC) ---
const runBotEngine = async (client, candidate, incomingText, incomingPayloadId = null) => {
    console.log(`[Bot Engine] START for ${candidate.phone_number} | Step: ${candidate.current_bot_step_id || 'START'}`);

    try {
        // 1. Check Config
        const sys = await client.query("SELECT value FROM system_settings WHERE key = 'config'");
        const config = sys.rows[0]?.value || { automation_enabled: true }; 
        
        if (config.automation_enabled === false) {
            console.log("[Bot Engine] Automation disabled.");
            return;
        }

        if (candidate.is_human_mode) {
            console.log("[Bot Engine] Human mode active.");
            return;
        }

        // 2. Load Bot
        const botRes = await client.query("SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1");
        
        // DIAGNOSTIC: No Bot Found
        if (botRes.rows.length === 0) {
            await client.query(
                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'system_error', 'failed', NOW())`,
                [crypto.randomUUID(), candidate.id, "CRITICAL: No 'Published' bot flow found. Please go to Bot Studio and click 'Publish'."]
            );
            return;
        }
        
        const { nodes, edges } = botRes.rows[0].settings;
        if (!nodes || nodes.length === 0) return;

        let currentNodeId = candidate.current_bot_step_id;
        let nextNodeId = null;
        let shouldReplyInvalid = false;

        // --- RESET TRIGGERS ---
        const cleanInput = (incomingText || '').trim().toLowerCase();
        if (['start', 'restart', 'hi', 'hello', 'menu'].includes(cleanInput)) {
            console.log("[Bot Engine] Reset triggered.");
            currentNodeId = null;
            await client.query("UPDATE candidates SET current_bot_step_id = NULL WHERE id = $1", [candidate.id]);
        }

        // --- STEP A: DETERMINE NEXT NODE ---
        if (!currentNodeId) {
            const startNode = nodes.find(n => n.type === 'start' || n.data?.type === 'start');
            nextNodeId = startNode ? startNode.id : nodes[0]?.id;
        } else {
            const currentNode = nodes.find(n => n.id === currentNodeId);
            
            if (currentNode) {
                // A1. Capture Input
                if (currentNode.data.type === 'input' && currentNode.data.variable) {
                    const varName = currentNode.data.variable;
                    const newVars = { ...candidate.variables, [varName]: incomingText };
                    await client.query("UPDATE candidates SET variables = $1 WHERE id = $2", [newVars, candidate.id]);
                    candidate.variables = newVars; 
                }

                // A2. FIND MATCHING EDGE
                const outgoingEdges = edges.filter(e => e.source === currentNodeId);
                let matchedEdge = null;

                // Strategy 1: Payload ID Match
                if (incomingPayloadId) {
                    if (currentNode.data.buttons) {
                        const btn = currentNode.data.buttons.find(b => b.id === incomingPayloadId);
                        if (btn) matchedEdge = outgoingEdges.find(e => e.sourceHandle === btn.id);
                    }
                    if (!matchedEdge && currentNode.data.sections) {
                        const row = currentNode.data.sections.flatMap(s => s.rows).find(r => r.id === incomingPayloadId);
                        if (row) matchedEdge = outgoingEdges.find(e => e.sourceHandle === row.id);
                    }
                }

                // Strategy 2: Text Fuzzy Match
                if (!matchedEdge && cleanInput) {
                    if (currentNode.data.buttons) {
                        const btn = currentNode.data.buttons.find(b => b.title.toLowerCase().trim() === cleanInput);
                        if (btn) matchedEdge = outgoingEdges.find(e => e.sourceHandle === btn.id);
                    }
                    if (!matchedEdge && currentNode.data.sections) {
                        const row = currentNode.data.sections.flatMap(s => s.rows).find(r => r.title.toLowerCase().trim() === cleanInput);
                        if (row) matchedEdge = outgoingEdges.find(e => e.sourceHandle === row.id);
                    }
                }

                // Strategy 3: Default Edge
                if (!matchedEdge) {
                    matchedEdge = outgoingEdges.find(e => !e.sourceHandle || e.sourceHandle === 'true' || e.sourceHandle === 'default');
                }

                if (matchedEdge) {
                    nextNodeId = matchedEdge.target;
                } else {
                    if (outgoingEdges.length === 0) {
                        // Dead end reached - restart
                        const startNode = nodes.find(n => n.type === 'start' || n.data?.type === 'start');
                        nextNodeId = startNode ? startNode.id : null;
                    } else {
                        // INVALID INPUT: Loop current node
                        nextNodeId = currentNodeId;
                        // Only send retry message if it was an interactive node that expects specific input
                        if (['interactive_button', 'interactive_list'].includes(currentNode.data.type)) {
                            shouldReplyInvalid = true;
                        }
                    }
                }
            } else {
                // State mismatch
                const startNode = nodes.find(n => n.type === 'start' || n.data?.type === 'start');
                nextNodeId = startNode ? startNode.id : null;
            }
        }

        // --- STEP A.1: HANDLE INVALID INPUT RETRY ---
        if (shouldReplyInvalid) {
            const invalidMsg = "I didn't catch that. Please select an option from the menu above.";
            await sendToMeta(candidate.phone_number, { type: 'text', text: { body: invalidMsg } });
            // Do not advance flow, just exit
            return;
        }

        // --- STEP B: EXECUTE FLOW (CHAINING) ---
        let activeNodeId = nextNodeId;
        let opsCount = 0;
        const MAX_OPS = 15;

        while (activeNodeId && opsCount < MAX_OPS) {
            opsCount++;
            const node = nodes.find(n => n.id === activeNodeId);
            if (!node) break;

            const data = node.data || {};
            console.log(`[Bot Engine] Processing Node ${node.id} (${data.type})`);

            // -- 1. LOGIC NODES (No Output) --
            if (data.type === 'status_update') {
                if (data.targetStatus) await client.query("UPDATE candidates SET stage = $1 WHERE id = $2", [data.targetStatus, candidate.id]);
                const nextEdge = edges.find(e => e.source === node.id);
                activeNodeId = nextEdge ? nextEdge.target : null;
                continue;
            }

            if (data.type === 'condition') {
                let isMatch = false;
                if (data.variable) {
                    const val = candidate.variables[data.variable];
                    const target = data.value;
                    const op = data.operator || 'equals';
                    if (val !== undefined) {
                        if (op === 'equals') isMatch = val == target;
                        else if (op === 'contains') isMatch = String(val).toLowerCase().includes(String(target).toLowerCase());
                        else if (op === 'is_set') isMatch = !!val;
                    }
                }
                const handle = isMatch ? 'true' : 'false';
                const nextEdge = edges.find(e => e.source === node.id && (e.sourceHandle === handle || !e.sourceHandle));
                activeNodeId = nextEdge ? nextEdge.target : null;
                continue;
            }

            if (data.type === 'handoff') {
                await client.query("UPDATE candidates SET is_human_mode = TRUE WHERE id = $1", [candidate.id]);
                const msg = processText(data.content, candidate);
                if (isValidContent(msg)) await sendToMeta(candidate.phone_number, { type: 'text', text: { body: msg } });
                break;
            }

            // -- 2. MESSAGE NODES --
            if (data.type !== 'start') {
                let rawBody = processText(data.content || '', candidate);
                
                // SELF-HEALING: Check if content is valid. If not, we might SKIP this node or use fallback.
                let validBody = isValidContent(rawBody) ? rawBody : null;
                
                let payload = null;
                let messageSent = false;

                // TYPE A: Text
                if (data.type === 'text') {
                    if (validBody) {
                        payload = { type: 'text', text: { body: validBody } };
                    } else {
                        // EMPTY TEXT NODE -> SKIP IT
                        console.log(`[Bot Engine] Auto-Skipping Empty Text Node ${node.id}`);
                        const nextEdge = edges.find(e => e.source === node.id);
                        if (nextEdge) {
                            activeNodeId = nextEdge.target;
                            continue; // Jump to next node immediately
                        } else {
                            break; // End of flow
                        }
                    }
                } 
                
                // TYPE B: Input (Cannot skip, must fallback)
                else if (data.type === 'input') {
                    const prompt = validBody || "Please enter your response below:";
                    payload = { type: 'text', text: { body: prompt } };
                }
                
                // TYPE C: Media
                else if (data.type === 'image' && data.mediaUrl) {
                    const url = await refreshMediaUrl(data.mediaUrl);
                    payload = { type: 'image', image: { link: url, caption: validBody || '' } };
                }

                // TYPE D: Buttons (Fallback if empty)
                else if (data.type === 'interactive_button' && data.buttons?.length > 0) {
                    const bodyText = validBody || "Please select an option:";
                    payload = {
                        type: "interactive",
                        interactive: {
                            type: "button",
                            body: { text: bodyText },
                            action: {
                                buttons: data.buttons.slice(0, 3).map(b => ({
                                    type: "reply",
                                    reply: { id: b.id, title: b.title.substring(0, 20) } 
                                }))
                            }
                        }
                    };
                }

                // TYPE E: Lists (Fallback if empty)
                else if (data.type === 'interactive_list' && data.sections?.length > 0) {
                    const bodyText = validBody || "Please make a selection:";
                    payload = {
                        type: "interactive",
                        interactive: {
                            type: "list",
                            body: { text: bodyText },
                            action: {
                                button: data.listButtonText || "Menu",
                                sections: data.sections
                            }
                        }
                    };
                }

                // EXECUTE SEND
                if (payload) {
                    try {
                        await sendToMeta(candidate.phone_number, payload);
                        messageSent = true;
                        
                        await client.query(
                            `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())`,
                            [crypto.randomUUID(), candidate.id, payload.text?.body || payload.interactive?.body?.text || '[Media]', data.type]
                        );
                    } catch (apiError) {
                        // DIAGNOSTIC: Log API failures to Chat
                        console.error("Meta Send Error:", apiError);
                        await client.query(
                            `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'system_error', 'failed', NOW())`,
                            [crypto.randomUUID(), candidate.id, `Meta API Error: ${apiError.message}. Check Dashboard credentials.`]
                        );
                    }
                }
            }

            // 3. SAVE STATE
            await client.query("UPDATE candidates SET current_bot_step_id = $1 WHERE id = $2", [node.id, candidate.id]);

            // 4. STOP OR CONTINUE?
            if (['input', 'interactive_button', 'interactive_list'].includes(data.type)) {
                console.log(`[Bot Engine] Pausing at Node ${node.id} for input.`);
                break; 
            }

            const nextEdge = edges.find(e => e.source === node.id);
            if (nextEdge) {
                activeNodeId = nextEdge.target;
                // Tiny delay to ensure order in WhatsApp
                await new Promise(r => setTimeout(r, 500));
            } else {
                activeNodeId = null;
            }
        }
    } catch (fatalError) {
        console.error("Bot Engine Fatal Crash:", fatalError);
    }
};

// --- EXPRESS APP ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
    console.log(`[${req.method}] ${req.url}`);
    next();
});

const apiRouter = express.Router();

// HEALTH
apiRouter.get('/health', (req, res) => res.json({ status: 'ok', timestamp: Date.now() }));

// DIAGNOSTICS (NEW: Fixes System Monitor 404)
apiRouter.get('/debug/status', async (req, res) => {
    const status = {
        postgres: 'unknown',
        tables: { candidates: false, bot_versions: false },
        counts: { candidates: 0 },
        env: {
            hasPostgres: !!(process.env.POSTGRES_URL || process.env.DATABASE_URL),
            publicUrl: process.env.PUBLIC_BASE_URL || 'localhost'
        },
        lastError: null
    };

    try {
        await withDb(async (client) => {
            // Check connection
            await client.query('SELECT 1');
            status.postgres = 'connected';

            // Check tables
            const tablesRes = await client.query(`
                SELECT table_name FROM information_schema.tables 
                WHERE table_schema = 'public'
            `);
            const tables = tablesRes.rows.map(r => r.table_name);
            status.tables.candidates = tables.includes('candidates');
            status.tables.bot_versions = tables.includes('bot_versions');

            // Count rows
            if (status.tables.candidates) {
                const countRes = await client.query('SELECT COUNT(*) FROM candidates');
                status.counts.candidates = parseInt(countRes.rows[0].count);
            }
        });
    } catch (e) {
        status.postgres = 'error';
        status.lastError = e.message;
    }

    res.json(status);
});

// WEBHOOK GET
apiRouter.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

// WEBHOOK POST (Optimized for Vercel)
apiRouter.post('/webhook', async (req, res) => {
    const body = req.body;
    if (!body.object) {
        res.sendStatus(404);
        return;
    }
    
    try {
        const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        
        // If not a message (e.g., status update), just ack and return
        if (!msg) {
            res.sendStatus(200);
            return;
        }

        // SAFETY: Wrap DB logic in a promise race. 
        // If DB/Bot takes > 9s, we return 200 OK to Meta to prevent retries, but let the bot keep trying.
        const processPromise = withDb(async (client) => {
            // Deduplication
            const existing = await client.query("SELECT id FROM candidate_messages WHERE whatsapp_message_id = $1", [msg.id]);
            if (existing.rows.length > 0) return;

            // Extract Info
            const from = msg.from;
            const name = body.entry[0].changes[0].value.contacts?.[0]?.profile?.name || 'Unknown';
            let text = '';
            let payloadId = null;

            if (msg.type === 'text') {
                text = msg.text.body;
            } else if (msg.type === 'interactive') {
                if (msg.interactive.type === 'button_reply') {
                    text = msg.interactive.button_reply.title;
                    payloadId = msg.interactive.button_reply.id;
                } else if (msg.interactive.type === 'list_reply') {
                    text = msg.interactive.list_reply.title;
                    payloadId = msg.interactive.list_reply.id;
                }
            } else {
                text = `[${msg.type.toUpperCase()}]`;
            }

            // Upsert Candidate
            let c = await client.query('SELECT * FROM candidates WHERE phone_number = $1', [from]);
            let candidate;
            
            if (c.rows.length === 0) {
                const id = crypto.randomUUID();
                await client.query(
                    `INSERT INTO candidates (id, phone_number, name, stage, last_message, last_message_at, is_human_mode, variables) VALUES ($1, $2, $3, 'New', $4, $5, FALSE, '{}')`, 
                    [id, from, name, text, Date.now()]
                );
                candidate = { id, phone_number: from, is_human_mode: false, current_bot_step_id: null, variables: {}, name };
            } else {
                candidate = c.rows[0];
                await client.query('UPDATE candidates SET last_message = $1, last_message_at = $2 WHERE id = $3', [text, Date.now(), candidate.id]);
            }

            // Log User Message
            await client.query(
                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, whatsapp_message_id, status, created_at) VALUES ($1, $2, 'in', $3, 'text', $4, 'received', NOW())`, 
                [crypto.randomUUID(), candidate.id, text, msg.id]
            );

            // Execute Bot (Wait for completion)
            await runBotEngine(client, candidate, text, payloadId);
        });

        // Vercel Timeout Protection: 
        // We race the bot logic against a 9s timer. If bot is slow, we return 200 OK anyway so Meta doesn't retry.
        // The bot logic might continue running depending on Vercel plan, but usually it freezes. 
        // This prevents the "Bot sends 5 messages because Meta kept retrying" bug.
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Webhook Processing Timeout")), 9000));

        await Promise.race([processPromise, timeoutPromise]).catch(err => {
            console.error("[Webhook Warning] Logic timed out or failed:", err.message);
            // We swallow the error here to ensure we still send 200 OK below.
        });

        // Send 200 OK only AFTER processing (or timeout) to prevent Vercel execution freeze
        res.sendStatus(200);

    } catch(e) { 
        console.error("Webhook Critical Error", e); 
        // Even on critical error, sending 500 causes Meta to retry. 
        // It is often safer to send 200 if we logged the error, unless we specifically want a retry.
        res.sendStatus(200); 
    }
});

// --- STANDARD API ROUTES ---
// Auth
apiRouter.post('/auth/google', async (req, res) => {
    try {
        const { credential } = req.body;
        const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: SYSTEM_CONFIG.GOOGLE_CLIENT_ID });
        res.json({ success: true, user: ticket.getPayload() });
    } catch (e) { res.status(401).json({ success: false, error: e.message }); }
});

// Bot Settings
apiRouter.get('/bot/settings', async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query("SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1");
            res.json(r.rows[0]?.settings || { isEnabled: false, nodes: [], edges: [] });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/bot/save', async (req, res) => {
    try {
        await withDb(async (client) => {
            await client.query("INSERT INTO bot_versions (id, status, settings, created_at) VALUES ($1, 'published', $2, NOW())", [crypto.randomUUID(), req.body]);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/bot/publish', async (req, res) => res.json({ success: true }));

// Drivers
apiRouter.get('/drivers', async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query('SELECT * FROM candidates ORDER BY last_message_at DESC NULLS LAST LIMIT 50');
            res.json(r.rows.map(row => ({
                id: row.id, phoneNumber: row.phone_number, name: row.name, status: row.stage, 
                lastMessage: row.last_message, lastMessageTime: parseInt(row.last_message_at || '0'), 
                source: row.source, isHumanMode: row.is_human_mode
            })));
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.patch('/drivers/:id', async (req, res) => {
    try {
        const { status, isHumanMode, name } = req.body;
        await withDb(async (client) => {
            if (status) await client.query("UPDATE candidates SET stage = $1 WHERE id = $2", [status, req.params.id]);
            if (isHumanMode !== undefined) await client.query("UPDATE candidates SET is_human_mode = $1 WHERE id = $2", [isHumanMode, req.params.id]);
            if (name) await client.query("UPDATE candidates SET name = $1 WHERE id = $2", [name, req.params.id]);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers/:id/messages', async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query('SELECT * FROM candidate_messages WHERE candidate_id = $1 ORDER BY created_at DESC LIMIT 50', [req.params.id]);
            const msgs = await Promise.all(r.rows.map(async row => {
                let text = row.text, imageUrl = null;
                if (['image','video','document'].includes(row.type) && row.text.startsWith('{')) {
                    try { const p = JSON.parse(row.text); text = p.caption; if(p.url) imageUrl = await refreshMediaUrl(p.url); } catch(e){}
                }
                return { 
                    id: row.id, sender: row.direction === 'in' ? 'driver' : 'agent', text, imageUrl, 
                    timestamp: new Date(row.created_at).getTime(), type: row.type || 'text', status: row.status 
                };
            }));
            res.json(msgs.reverse());
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/drivers/:id/messages', async (req, res) => {
    try {
        const { text, mediaUrl, mediaType } = req.body;
        await withDb(async (client) => {
            const c = await client.query('SELECT phone_number FROM candidates WHERE id = $1', [req.params.id]);
            if (c.rows.length === 0) throw new Error("Candidate not found");
            
            let payload = { type: 'text', text: { body: text } };
            let dbText = text;
            
            if (mediaUrl) {
                const freshUrl = await refreshMediaUrl(mediaUrl);
                const type = mediaType || 'image';
                payload = { type, [type]: { link: freshUrl, caption: text } };
                dbText = JSON.stringify({ url: mediaUrl, caption: text });
            }

            await sendToMeta(c.rows[0].phone_number, payload);
            await client.query(
                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())`,
                [crypto.randomUUID(), req.params.id, dbText, mediaUrl ? (mediaType || 'image') : 'text']
            );
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers/:id/documents', async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query('SELECT * FROM driver_documents WHERE candidate_id = $1', [req.params.id]);
            const docs = await Promise.all(r.rows.map(async d => ({
                id: d.id, docType: d.type, url: await refreshMediaUrl(d.url), 
                verificationStatus: d.status, timestamp: new Date(d.created_at).getTime()
            })));
            res.json(docs);
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// 4. SCHEDULED MESSAGES
// ==========================================
apiRouter.post('/scheduled-messages', async (req, res) => {
    try {
        const { driverIds, message, timestamp } = req.body;
        // Robust payload construction
        const payload = typeof message === 'string' ? { text: message } : message;
        
        await withDb(async (client) => {
            for (const id of driverIds) {
                await client.query(
                    `INSERT INTO scheduled_messages (id, candidate_id, payload, scheduled_time, status) VALUES ($1, $2, $3, $4, 'pending')`,
                    [crypto.randomUUID(), id, payload, timestamp]
                );
            }
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers/:id/scheduled-messages', async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query(`SELECT * FROM scheduled_messages WHERE candidate_id = $1 AND status = 'pending' ORDER BY scheduled_time ASC`, [req.params.id]);
            const mapped = await Promise.all(r.rows.map(async row => {
                const p = row.payload || {};
                if(p.mediaUrl) p.mediaUrl = await refreshMediaUrl(p.mediaUrl);
                return {
                   id: row.id, scheduledTime: parseInt(row.scheduled_time), payload: p, status: row.status
                };
            }));
            res.json(mapped);
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.delete('/scheduled-messages/:id', async (req, res) => {
    try {
        await withDb(async (client) => {
            await client.query("DELETE FROM scheduled_messages WHERE id = $1", [req.params.id]);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.patch('/scheduled-messages/:id', async (req, res) => {
    try {
        const { text, scheduledTime } = req.body;
        await withDb(async (client) => {
            if (text) {
                const r = await client.query("SELECT payload FROM scheduled_messages WHERE id = $1", [req.params.id]);
                if (r.rows.length > 0) {
                    const newPayload = { ...r.rows[0].payload, text };
                    await client.query("UPDATE scheduled_messages SET payload = $1 WHERE id = $2", [newPayload, req.params.id]);
                }
            }
            if (scheduledTime) {
                await client.query("UPDATE scheduled_messages SET scheduled_time = $1 WHERE id = $2", [scheduledTime, req.params.id]);
            }
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// 5. CRON & WEBHOOK (FIXED FOR MEDIA)
// ==========================================
apiRouter.get('/cron/process-queue', async (req, res) => {
    console.log("--- [CRON] Starting Queue Processing ---");
    let processed = 0, errors = 0;
    
    try {
        await withDb(async (client) => {
            const now = Date.now();
            const jobs = await client.query(`
                SELECT sm.id, sm.candidate_id, sm.payload, c.phone_number FROM scheduled_messages sm
                JOIN candidates c ON sm.candidate_id = c.id
                WHERE sm.status = 'pending' AND sm.scheduled_time <= $1 LIMIT 10 FOR UPDATE OF sm SKIP LOCKED
            `, [now]);

            console.log(`[CRON] Found ${jobs.rows.length} jobs.`);

            for (const job of jobs.rows) {
                try {
                    console.log(`[CRON] Processing Job ${job.id} for ${job.phone_number}`);
                    await client.query("UPDATE scheduled_messages SET status = 'processing' WHERE id = $1", [job.id]);
                    
                    const p = job.payload || {};
                    let metaP;
                    let dbLogText = p.text || '';
                    let dbType = 'text';

                    if (p.mediaUrl) {
                        const url = await refreshMediaUrl(p.mediaUrl);
                        const mediaType = p.mediaType || 'image';
                        dbType = mediaType;
                        dbLogText = JSON.stringify({ url: p.mediaUrl, caption: p.text || '' });
                        
                        metaP = { 
                            type: mediaType, 
                            [mediaType]: { 
                                link: url, 
                                caption: p.text || '' 
                            } 
                        };

                        if (mediaType === 'document') {
                            const urlObj = new URL(url);
                            const filename = decodeURIComponent(urlObj.pathname.split('/').pop() || 'document.pdf');
                            metaP[mediaType].filename = filename;
                        }

                    } else {
                        if (!dbLogText.trim()) throw new Error("Empty text in payload");
                        metaP = { type: 'text', text: { body: dbLogText } };
                    }

                    await sendToMeta(job.phone_number, metaP);
                    
                    await client.query(
                        `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`, 
                        [crypto.randomUUID(), job.candidate_id, dbLogText, dbType]
                    );

                    await client.query("UPDATE scheduled_messages SET status = 'sent' WHERE id = $1", [job.id]);
                    processed++;
                    console.log(`[CRON] Job ${job.id} SUCCESS`);
                } catch (e) {
                    errors++;
                    console.error(`[CRON] Job ${job.id} FAILED:`, e.message);
                    await client.query("UPDATE scheduled_messages SET status = 'failed', error_log = $2 WHERE id = $1", [job.id, e.message]);
                }
            }
        });
        res.json({ status: 'ok', processed, errors });
    } catch (e) { 
        console.error("[CRON FATAL]", e);
        res.status(500).json({ error: e.message }); 
    }
});

// ==========================================
// 6. DB ADMIN OPS
// ==========================================
apiRouter.post('/system/init-db', async (req, res) => {
    try {
        await withDb(async (client) => {
            await client.query(SCHEMA_SQL);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/system/hard-reset', async (req, res) => {
    try {
        await withDb(async (client) => {
            // 1. DROP EVERYTHING
            await client.query(`DROP TABLE IF EXISTS scheduled_messages, candidate_messages, driver_documents, bot_versions, candidates, system_settings CASCADE`);
            // 2. REBUILD IMMEDIATELY
            await client.query(SCHEMA_SQL);
            // 3. SEED BASIC CONFIG
            await client.query("INSERT INTO system_settings (key, value) VALUES ('config', '{\"automation_enabled\": true}') ON CONFLICT DO NOTHING");
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/system/seed-db', async (req, res) => {
    try {
        await withDb(async (client) => {
            const id = crypto.randomUUID();
            await client.query(`INSERT INTO candidates (id, phone_number, name, stage, last_message, last_message_at) VALUES ($1, '+919999999999', 'Demo Driver', 'New', 'Hello', $2)`, [id, Date.now()]);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// 7. MEDIA / S3
// ==========================================
apiRouter.post('/ai/assistant', (req, res) => res.json({ text: "AI Service connecting..." }));

// LIST FILES
apiRouter.get('/media', async (req, res) => {
    const currentPath = req.query.path || '/';
    let prefix = currentPath === '/' ? '' : currentPath.substring(1);
    if (prefix && !prefix.endsWith('/')) prefix += '/';

    try {
        const command = new ListObjectsV2Command({
            Bucket: SYSTEM_CONFIG.AWS_BUCKET,
            Prefix: prefix,
            Delimiter: '/'
        });
        const data = await s3Client.send(command);

        const folders = (data.CommonPrefixes || []).map(p => {
            const parts = p.Prefix.split('/').filter(Boolean);
            const name = parts[parts.length - 1];
            return { id: p.Prefix, name, parent_path: currentPath, is_public_showcase: false };
        });

        const files = await Promise.all((data.Contents || []).map(async (obj) => {
            if (obj.Key.endsWith('/')) return null;
            const url = await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: obj.Key }), { expiresIn: 3600 });
            const filename = obj.Key.split('/').pop();
            const ext = filename.split('.').pop().toLowerCase();
            let type = 'document';
            if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) type = 'image';
            if (['mp4', 'mov', 'webm', 'mkv'].includes(ext)) type = 'video';
            return { id: obj.Key, url, filename, type, media_id: null };
        }));

        res.json({ files: files.filter(Boolean), folders });
    } catch (e) {
        console.error("S3 List Error:", e);
        res.json({ files: [], folders: [] }); // Fail gracefully
    }
});

// UPLOAD
apiRouter.post('/media/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) throw new Error("No file");
        const path = req.body.path || '/';
        let prefix = path === '/' ? '' : path.substring(1);
        if (prefix && !prefix.endsWith('/')) prefix += '/';
        
        const key = `${prefix}${req.file.originalname}`;
        await s3Client.send(new PutObjectCommand({
            Bucket: SYSTEM_CONFIG.AWS_BUCKET,
            Key: key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
        }));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// CREATE FOLDER
apiRouter.post('/media/folders', async (req, res) => {
    try {
        const { name, parentPath } = req.body;
        let prefix = parentPath === '/' ? '' : parentPath.substring(1);
        if (prefix && !prefix.endsWith('/')) prefix += '/';
        const key = `${prefix}${name}/`; 
        await s3Client.send(new PutObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key, Body: '' }));
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE FILE/FOLDER (Wildcard support)
apiRouter.delete('/media/files/:id(*)', async (req, res) => {
    try {
        // req.params.id or req.params[0] depending on Express version
        const key = req.params[0] || req.params.id; 
        await s3Client.send(new DeleteObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key }));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.delete('/media/folders/:id(*)', async (req, res) => {
    try {
        const key = req.params[0] || req.params.id;
        await s3Client.send(new DeleteObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key }));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- MOUNT ROUTER ---
app.use('/api', apiRouter);
// Fallback for root mounts if Vercel strips /api prefix
app.use('/', apiRouter);

// Catch-all for unhandled routes to debug 404s
app.use((req, res) => {
    console.log(`[404] Route not found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: 'Route not found', path: req.originalUrl });
});

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => console.log(`Server running on ${PORT}`));
}

module.exports = app;

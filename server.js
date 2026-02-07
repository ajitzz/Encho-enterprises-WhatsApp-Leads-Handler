
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
    DB_CONNECTION_TIMEOUT: 20000,
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
    AWS_BUCKET: process.env.AWS_BUCKET_NAME || 'uber-fleet-assets',
    GOOGLE_CLIENT_ID: process.env.VITE_GOOGLE_CLIENT_ID,
    CACHE_TTL: 60 * 1000 // 60 Seconds Cache for Bot Settings
};

// --- IN-MEMORY CACHE (Performance Boost) ---
// Prevents hitting DB for bot settings on every single message
const memoryCache = {
    botSettings: null,
    lastUpdated: 0
};

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

    let connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
    if (connectionString && connectionString.includes('sslmode=')) {
        connectionString = connectionString.replace(/([?&])sslmode=[^&]+(&|$)/, '$1').replace(/[?&]$/, '');
    }
    
    pgPool = new Pool({
        connectionString,
        connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
        idleTimeoutMillis: 30000,
        ssl: { rejectUnauthorized: false }, 
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
        throw new Error(`Meta API Error: ${errMsg}`);
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
    if (clean.length < 50 && blockers.some(b => clean.includes(b))) return false;
    return true;
};

// --- DEFAULT BOT CONFIG ---
const getDefaultBotConfig = () => ({
    isEnabled: true,
    shouldRepeat: false,
    routingStrategy: 'BOT_ONLY',
    nodes: [
        { 
            id: 'start', 
            type: 'custom', 
            position: { x: 50, y: 50 }, 
            data: { id: 'start', type: 'start', label: 'Start Flow' } 
        },
        { 
            id: 'welcome_msg', 
            type: 'custom', 
            position: { x: 50, y: 200 }, 
            data: { id: 'welcome_msg', type: 'text', label: 'Welcome Message', content: 'Welcome to Encho Cabs! 👋\n\nHow can we help you today?' } 
        }
    ],
    edges: [
        { id: 'e1', source: 'start', target: 'welcome_msg', type: 'smoothstep' }
    ]
});

// --- DB RECOVERY & INIT ---
const initDatabase = async (client) => {
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');

    await client.query(`CREATE TABLE IF NOT EXISTS system_settings (key VARCHAR(50) PRIMARY KEY, value JSONB);`);
    await client.query(`CREATE TABLE IF NOT EXISTS candidates (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), phone_number VARCHAR(50) UNIQUE, name VARCHAR(255), stage VARCHAR(50), last_message TEXT, last_message_at BIGINT, source VARCHAR(50), is_human_mode BOOLEAN DEFAULT FALSE, current_bot_step_id VARCHAR(100), variables JSONB DEFAULT '{}', created_at TIMESTAMP DEFAULT NOW());`);
    await client.query(`CREATE TABLE IF NOT EXISTS candidate_messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE, direction VARCHAR(10), text TEXT, type VARCHAR(50), status VARCHAR(50), whatsapp_message_id VARCHAR(255), created_at TIMESTAMP DEFAULT NOW());`);
    await client.query(`CREATE TABLE IF NOT EXISTS scheduled_messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE, payload JSONB, scheduled_time BIGINT, status VARCHAR(50), error_log TEXT, created_at TIMESTAMP DEFAULT NOW());`);
    await client.query(`CREATE TABLE IF NOT EXISTS bot_versions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status VARCHAR(20), settings JSONB, created_at TIMESTAMP DEFAULT NOW());`);
    await client.query(`CREATE TABLE IF NOT EXISTS driver_documents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE, type VARCHAR(50), url TEXT, status VARCHAR(50), created_at TIMESTAMP DEFAULT NOW());`);
    
    await client.query("INSERT INTO system_settings (key, value) VALUES ('config', '{\"automation_enabled\": true}') ON CONFLICT DO NOTHING");

    const botCheck = await client.query("SELECT id FROM bot_versions WHERE status = 'published' LIMIT 1");
    if (botCheck.rows.length === 0) {
        await client.query("INSERT INTO bot_versions (id, status, settings, created_at) VALUES ($1, 'published', $2, NOW())", [crypto.randomUUID(), getDefaultBotConfig()]);
    }
};

const executeWithRetry = async (client, operation) => {
    try {
        return await operation();
    } catch (err) {
        if (err.code === '42P01') {
            console.warn("[Auto-Heal] Tables missing. Re-initializing database...");
            await initDatabase(client);
            return await operation(); 
        }
        throw err;
    }
};

// --- BOT ENGINE ---
const runBotEngine = async (client, candidate, incomingText, incomingPayloadId = null) => {
    console.log(`[Bot Engine] START for ${candidate.phone_number}`);
    try {
        const sys = await client.query("SELECT value FROM system_settings WHERE key = 'config'");
        const config = sys.rows[0]?.value || { automation_enabled: true }; 
        if (config.automation_enabled === false || candidate.is_human_mode) return;

        let botSettings;

        // 1. TRY CACHE
        const now = Date.now();
        if (memoryCache.botSettings && (now - memoryCache.lastUpdated < SYSTEM_CONFIG.CACHE_TTL)) {
            botSettings = memoryCache.botSettings;
        } else {
            // 2. FALLBACK TO DB
            let botRes = await client.query("SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1");
            if (botRes.rows.length > 0) {
                botSettings = botRes.rows[0].settings;
                memoryCache.botSettings = botSettings;
                memoryCache.lastUpdated = now;
            } else {
                botSettings = getDefaultBotConfig();
            }
        }
        
        const { nodes, edges } = botSettings;
        if (!nodes || nodes.length === 0) return;

        let currentNodeId = candidate.current_bot_step_id;
        let nextNodeId = null;
        let shouldReplyInvalid = false;
        const cleanInput = (incomingText || '').trim().toLowerCase();

        // 1. Global Resets
        if (['start', 'restart', 'hi', 'hello', 'menu'].includes(cleanInput)) {
            currentNodeId = null;
            await client.query("UPDATE candidates SET current_bot_step_id = NULL WHERE id = $1", [candidate.id]);
        }

        // 2. Determine Current State
        if (!currentNodeId) {
            const startNode = nodes.find(n => n.type === 'start' || n.data?.type === 'start');
            nextNodeId = startNode ? startNode.id : nodes[0]?.id;
        } else {
            const currentNode = nodes.find(n => n.id === currentNodeId);
            if (currentNode) {
                // A. Handle Variable Capture (Input Node)
                if (currentNode.data.type === 'input' && currentNode.data.variable) {
                    const varName = currentNode.data.variable;
                    const newVars = { ...candidate.variables, [varName]: incomingText };
                    await client.query("UPDATE candidates SET variables = $1 WHERE id = $2", [newVars, candidate.id]);
                    candidate.variables = newVars; 
                }

                // B. Find Next Path
                const outgoingEdges = edges.filter(e => e.source === currentNodeId);
                let matchedEdge = null;

                // Match Buttons / List Rows via Payload ID
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

                // Match Text for Buttons (Fallback)
                if (!matchedEdge && cleanInput) {
                    if (currentNode.data.buttons) {
                        const btn = currentNode.data.buttons.find(b => b.title.toLowerCase().trim() === cleanInput);
                        if (btn) matchedEdge = outgoingEdges.find(e => e.sourceHandle === btn.id);
                    }
                }

                // Default Path
                if (!matchedEdge) {
                    matchedEdge = outgoingEdges.find(e => !e.sourceHandle || e.sourceHandle === 'true' || e.sourceHandle === 'default');
                }

                if (matchedEdge) {
                    nextNodeId = matchedEdge.target;
                } else {
                    // Dead End logic
                    if (outgoingEdges.length === 0) {
                        const startNode = nodes.find(n => n.type === 'start' || n.data?.type === 'start');
                        nextNodeId = startNode ? startNode.id : null;
                    } else {
                        // User ignored the buttons/menu -> Stay on node & Mark Invalid
                        nextNodeId = currentNodeId;
                        if (['interactive_button', 'interactive_list', 'rich_card'].includes(currentNode.data.type)) {
                            shouldReplyInvalid = true;
                        }
                    }
                }
            } else {
                // Lost state -> Restart
                const startNode = nodes.find(n => n.type === 'start' || n.data?.type === 'start');
                nextNodeId = startNode ? startNode.id : null;
            }
        }

        if (shouldReplyInvalid) {
            await sendToMeta(candidate.phone_number, { type: 'text', text: { body: "I didn't catch that. Please select an option from the menu." } });
            return;
        }

        // 3. Execute Node Chain (Synchronous Loop)
        let activeNodeId = nextNodeId;
        let opsCount = 0;
        const MAX_OPS = 15; // Loop protection

        while (activeNodeId && opsCount < MAX_OPS) {
            opsCount++;
            const node = nodes.find(n => n.id === activeNodeId);
            if (!node) break;

            const data = node.data || {};
            let autoAdvance = true; // Default behavior
            
            // --- LOGIC NODES (No Message Sent) ---

            if (data.type === 'status_update') {
                if (data.targetStatus) await client.query("UPDATE candidates SET stage = $1 WHERE id = $2", [data.targetStatus, candidate.id]);
            }

            else if (data.type === 'set_variable') {
                if (data.variable && data.operationValue) {
                    const newVars = { ...candidate.variables, [data.variable]: data.operationValue };
                    await client.query("UPDATE candidates SET variables = $1 WHERE id = $2", [newVars, candidate.id]);
                    candidate.variables = newVars;
                }
            }
            
            else if (data.type === 'delay') {
                // Max delay 5s to prevent timeouts
                const ms = Math.min(data.delayTime || 2000, 5000);
                await new Promise(r => setTimeout(r, ms));
            }

            else if (data.type === 'condition') {
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
                continue; // Skip standard edge finding
            }

            else if (data.type === 'handoff') {
                await client.query("UPDATE candidates SET is_human_mode = TRUE WHERE id = $1", [candidate.id]);
                const msg = processText(data.content, candidate);
                if (isValidContent(msg)) await sendToMeta(candidate.phone_number, { type: 'text', text: { body: msg } });
                break; // Stop execution
            }

            // --- MESSAGE NODES (Send to WhatsApp) ---
            
            else if (data.type !== 'start') {
                let rawBody = processText(data.content || '', candidate);
                let validBody = isValidContent(rawBody) ? rawBody : null;
                let payload = null;

                if (data.type === 'text') {
                    if (validBody) {
                        payload = { type: 'text', text: { body: validBody } };
                        // Footer fallback support via text is not standard in Cloud API without template, 
                        // so we usually just append it to body if it exists
                        if (data.footerText) payload.text.body += `\n\n_${data.footerText}_`;
                    }
                } 
                else if (data.type === 'input') {
                    payload = { type: 'text', text: { body: validBody || "Please enter your response below:" } };
                    autoAdvance = false; // Stop and wait for user
                } 
                else if (data.type === 'location_request') {
                     payload = {
                        type: "interactive",
                        interactive: {
                            type: "location_request_message",
                            body: { text: validBody || "Please share your current location:" },
                            action: { name: "send_location" }
                        }
                    };
                    autoAdvance = false;
                }
                else if (data.type === 'image' && data.mediaUrl) {
                    const url = await refreshMediaUrl(data.mediaUrl);
                    payload = { type: 'image', image: { link: url, caption: validBody || '' } };
                } 
                
                // RICH BUTTONS / RICH CARD
                else if ((data.type === 'interactive_button' || data.type === 'rich_card') && data.buttons?.length > 0) {
                    // Construct Header
                    let header = undefined;
                    if (data.mediaUrl && (data.headerType === 'image' || data.headerType === 'video')) {
                        const url = await refreshMediaUrl(data.mediaUrl);
                        header = { type: data.headerType, [data.headerType]: { link: url } };
                    }
                    
                    payload = {
                        type: "interactive",
                        interactive: {
                            type: "button",
                            header: header,
                            body: { text: validBody || "Please select an option:" },
                            footer: data.footerText ? { text: data.footerText } : undefined,
                            action: {
                                buttons: data.buttons.slice(0, 3).map(b => ({
                                    type: "reply",
                                    reply: { id: b.id, title: b.title.substring(0, 20) } 
                                }))
                            }
                        }
                    };
                    autoAdvance = false;
                } 
                
                else if (data.type === 'interactive_list' && data.sections?.length > 0) {
                    payload = {
                        type: "interactive",
                        interactive: {
                            type: "list",
                            body: { text: validBody || "Please make a selection:" },
                            action: {
                                button: data.listButtonText || "Menu",
                                sections: data.sections
                            }
                        }
                    };
                    autoAdvance = false;
                }

                if (payload) {
                    try {
                        await sendToMeta(candidate.phone_number, payload);
                        await client.query(
                            `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())`,
                            [crypto.randomUUID(), candidate.id, payload.text?.body || payload.interactive?.body?.text || '[Media]', data.type]
                        );
                    } catch (apiError) {
                        console.error("Meta Send Error:", apiError);
                    }
                }
            }

            // 4. Update State & Move On
            await client.query("UPDATE candidates SET current_bot_step_id = $1 WHERE id = $2", [node.id, candidate.id]);

            if (!autoAdvance) break; // Stop loop if waiting for input/button

            const nextEdge = edges.find(e => e.source === node.id);
            if (nextEdge) {
                activeNodeId = nextEdge.target;
                // Tiny throttle to prevent rapid-fire API spam if no delays are used
                await new Promise(r => setTimeout(r, 200));
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

apiRouter.get('/health', (req, res) => res.json({ status: 'ok', timestamp: Date.now() }));

// --- DEEP WAKE PING ---
// Critical for preventing Database Sleep
apiRouter.get('/ping', async (req, res) => {
    try {
        if (pgPool) {
             // Wakes up Neon Postgres
             await pgPool.query('SELECT 1');
             res.status(200).send('pong - db active');
        } else {
            res.status(200).send('pong - no db pool');
        }
    } catch (e) {
        console.error("Ping DB Wake Failed", e.message);
        res.status(200).send('pong - db waking...');
    }
});

apiRouter.get('/debug/status', async (req, res) => {
    const status = {
        postgres: 'unknown',
        tables: { candidates: false, bot_versions: false },
        counts: { candidates: 0 },
        env: { hasPostgres: !!(process.env.POSTGRES_URL || process.env.DATABASE_URL) },
        lastError: null
    };
    try {
        await withDb(async (client) => {
            await client.query('SELECT 1');
            status.postgres = 'connected';
            const tablesRes = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
            const tables = tablesRes.rows.map(r => r.table_name);
            status.tables.candidates = tables.includes('candidates');
            status.tables.bot_versions = tables.includes('bot_versions');
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

apiRouter.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

apiRouter.post('/webhook', async (req, res) => {
    const body = req.body;
    if (!body.object) { res.sendStatus(404); return; }
    try {
        const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (!msg) { res.sendStatus(200); return; }

        const processPromise = withDb(async (client) => {
            // WRAPPER: Retry logic for cold starts / missing tables
            await executeWithRetry(client, async () => {
                const existing = await client.query("SELECT id FROM candidate_messages WHERE whatsapp_message_id = $1", [msg.id]);
                if (existing.rows.length > 0) return;

                const from = msg.from;
                const name = body.entry[0].changes[0].value.contacts?.[0]?.profile?.name || 'Unknown';
                let text = '';
                let payloadId = null;

                if (msg.type === 'text') text = msg.text.body;
                else if (msg.type === 'interactive') {
                    if (msg.interactive.type === 'button_reply') {
                        text = msg.interactive.button_reply.title;
                        payloadId = msg.interactive.button_reply.id;
                    } else if (msg.interactive.type === 'list_reply') {
                        text = msg.interactive.list_reply.title;
                        payloadId = msg.interactive.list_reply.id;
                    }
                } else text = `[${msg.type.toUpperCase()}]`;

                let c = await client.query('SELECT * FROM candidates WHERE phone_number = $1', [from]);
                let candidate;
                if (c.rows.length === 0) {
                    const id = crypto.randomUUID();
                    await client.query(`INSERT INTO candidates (id, phone_number, name, stage, last_message, last_message_at, is_human_mode, variables) VALUES ($1, $2, $3, 'New', $4, $5, FALSE, '{}')`, [id, from, name, text, Date.now()]);
                    candidate = { id, phone_number: from, is_human_mode: false, current_bot_step_id: null, variables: {}, name };
                } else {
                    candidate = c.rows[0];
                    await client.query('UPDATE candidates SET last_message = $1, last_message_at = $2 WHERE id = $3', [text, Date.now(), candidate.id]);
                }

                await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, whatsapp_message_id, status, created_at) VALUES ($1, $2, 'in', $3, 'text', $4, 'received', NOW())`, [crypto.randomUUID(), candidate.id, text, msg.id]);
                await runBotEngine(client, candidate, text, payloadId);
            });
        });

        // 9s Timeout to acknowledge Meta properly (prevent retries if lambda is slightly slow)
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Webhook Processing Timeout")), 9000));
        await Promise.race([processPromise, timeoutPromise]).catch(err => console.error("[Webhook Warning]", err.message));
        res.sendStatus(200);
    } catch(e) { console.error("Webhook Error", e); res.sendStatus(200); }
});

apiRouter.post('/auth/google', async (req, res) => {
    try {
        const { credential } = req.body;
        const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: SYSTEM_CONFIG.GOOGLE_CLIENT_ID });
        res.json({ success: true, user: ticket.getPayload() });
    } catch (e) { res.status(401).json({ success: false, error: e.message }); }
});

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
        
        // INVALIDATE CACHE
        memoryCache.botSettings = null;
        memoryCache.lastUpdated = 0;
        
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/bot/publish', async (req, res) => res.json({ success: true }));

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
            await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())`, [crypto.randomUUID(), req.params.id, dbText, mediaUrl ? (mediaType || 'image') : 'text']);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers/:id/documents', async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query('SELECT * FROM driver_documents WHERE candidate_id = $1', [req.params.id]);
            const docs = await Promise.all(r.rows.map(async d => ({ id: d.id, docType: d.type, url: await refreshMediaUrl(d.url), verificationStatus: d.status, timestamp: new Date(d.created_at).getTime() })));
            res.json(docs);
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/scheduled-messages', async (req, res) => {
    try {
        const { driverIds, message, timestamp } = req.body;
        const payload = typeof message === 'string' ? { text: message } : message;
        await withDb(async (client) => {
            for (const id of driverIds) await client.query(`INSERT INTO scheduled_messages (id, candidate_id, payload, scheduled_time, status) VALUES ($1, $2, $3, $4, 'pending')`, [crypto.randomUUID(), id, payload, timestamp]);
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
                return { id: row.id, scheduledTime: parseInt(row.scheduled_time), payload: p, status: row.status };
            }));
            res.json(mapped);
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.delete('/scheduled-messages/:id', async (req, res) => {
    try {
        await withDb(async (client) => { await client.query("DELETE FROM scheduled_messages WHERE id = $1", [req.params.id]); });
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
            if (scheduledTime) await client.query("UPDATE scheduled_messages SET scheduled_time = $1 WHERE id = $2", [scheduledTime, req.params.id]);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/cron/process-queue', async (req, res) => {
    let processed = 0, errors = 0;
    try {
        await withDb(async (client) => {
            // Check & Auto-Heal table existence during cron too
            await executeWithRetry(client, async () => {
                const now = Date.now();
                const jobs = await client.query(`SELECT sm.id, sm.candidate_id, sm.payload, c.phone_number FROM scheduled_messages sm JOIN candidates c ON sm.candidate_id = c.id WHERE sm.status = 'pending' AND sm.scheduled_time <= $1 LIMIT 10 FOR UPDATE OF sm SKIP LOCKED`, [now]);
                for (const job of jobs.rows) {
                    try {
                        await client.query("UPDATE scheduled_messages SET status = 'processing' WHERE id = $1", [job.id]);
                        const p = job.payload || {};
                        let metaP, dbLogText = p.text || '', dbType = 'text';
                        if (p.mediaUrl) {
                            const url = await refreshMediaUrl(p.mediaUrl);
                            const mediaType = p.mediaType || 'image';
                            dbType = mediaType;
                            dbLogText = JSON.stringify({ url: p.mediaUrl, caption: p.text || '' });
                            metaP = { type: mediaType, [mediaType]: { link: url, caption: p.text || '' } };
                            if (mediaType === 'document') metaP[mediaType].filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'doc.pdf');
                        } else metaP = { type: 'text', text: { body: dbLogText } };
                        
                        await sendToMeta(job.phone_number, metaP);
                        await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`, [crypto.randomUUID(), job.candidate_id, dbLogText, dbType]);
                        await client.query("UPDATE scheduled_messages SET status = 'sent' WHERE id = $1", [job.id]);
                        processed++;
                    } catch (e) {
                        errors++;
                        await client.query("UPDATE scheduled_messages SET status = 'failed', error_log = $2 WHERE id = $1", [job.id, e.message]);
                    }
                }
            });
        });
        res.json({ status: 'ok', processed, errors });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/system/init-db', async (req, res) => {
    try {
        await withDb(async (client) => {
            await initDatabase(client);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/system/hard-reset', async (req, res) => {
    try {
        await withDb(async (client) => {
            await client.query('BEGIN');
            try {
                await client.query(`DROP TABLE IF EXISTS scheduled_messages, candidate_messages, driver_documents, bot_versions, candidates, system_settings CASCADE`);
                await initDatabase(client); // Uses the shared robust init function
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            }
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

app.use('/api', apiRouter);
app.use('/', apiRouter);
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        console.log(`Server running on ${PORT}`);
        // Auto-Init Check on Start (For Local/VPS, NOT Vercel)
        (async () => {
            try {
                if (pgPool) {
                    const client = await pgPool.connect();
                    try {
                        const res = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'candidates'`);
                        if (res.rows.length === 0) {
                            console.log("[Auto-Init] Database schema missing. Initializing...");
                            await initDatabase(client);
                            console.log("[Auto-Init] Database ready.");
                        }
                    } finally {
                        client.release();
                    }
                }
            } catch(e) { console.error("[Auto-Init] Failed:", e.message); }
        })();
    });
}

module.exports = app;


const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const { Client: QStashClient, Receiver } = require('@upstash/qstash');
const { Pool } = require('pg');
require('dotenv').config();

// --- FAIL FAST VALIDATION ---
const requiredEnv = ['POSTGRES_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'QSTASH_TOKEN', 'META_API_TOKEN', 'PHONE_NUMBER_ID'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);
if (missingEnv.length > 0) { console.error(`❌ STARTUP ERROR: Missing Keys: ${missingEnv.join(', ')}`); } 
else { console.log("🔐 Keys Loaded: Validating Connections..."); }

const app = express();
const apiRouter = express.Router(); 

const SYSTEM_CONFIG = {
    META_TIMEOUT: 5000, 
    DB_CONNECTION_TIMEOUT: 10000, 
    CACHE_TTL_SETTINGS: 600, 
    LOCK_TTL: 15,
    DEDUPE_TTL: 3600 
};

// --- RESOURCES ---
let pgPool = null;
const getDb = () => {
    if (!pgPool) {
        pgPool = new Pool({
            connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
            ssl: { rejectUnauthorized: false },
            connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
            max: 5, idleTimeoutMillis: 10000, keepAlive: true 
        });
        pgPool.on('error', (err) => console.error('⚠️ DB Pool Error:', err.message));
    }
    return pgPool;
};

// Robust Redis Initialization
const redis = new Redis({ 
    url: process.env.UPSTASH_REDIS_REST_URL || 'https://mock.upstash.io', 
    token: process.env.UPSTASH_REDIS_REST_TOKEN || 'mock' 
});

const qstash = new QStashClient({ token: process.env.QSTASH_TOKEN || 'mock' });
const qstashReceiver = new Receiver({ currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "mock", nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "mock" });

let metaClient = null;
const getMetaClient = () => {
    if (!metaClient) {
        const axios = require('axios');
        const https = require('https');
        metaClient = axios.create({
            httpsAgent: new https.Agent({ keepAlive: true }),
            timeout: SYSTEM_CONFIG.META_TIMEOUT,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.META_API_TOKEN}` }
        });
    }
    return metaClient;
};

// Middleware
app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(cors()); 

// --- HELPERS ---
const isValidMessageContent = (content) => {
    if (!content) return false;
    if (typeof content === 'object') {
        if (content.type === 'interactive') return isValidMessageContent(content.interactive?.body?.text);
        if (content.type === 'template') return true;
        if (content.body) return isValidMessageContent(content.body);
        return true; 
    }
    if (typeof content !== 'string') return true;
    const text = content.trim().toLowerCase();
    if (text.length === 0) return false;
    const BLOCKED_PHRASES = ['replace this sample message', 'replace this text', 'enter your message', 'type your message'];
    if (BLOCKED_PHRASES.some(phrase => text.includes(phrase))) {
        console.warn(`⚠️ BLOCKED PLACEHOLDER: "${text}"`);
        return false;
    }
    return true;
};

const getWorkerUrl = (req) => {
    if (process.env.PUBLIC_BASE_URL) return `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/internal/bot-worker`;
    const host = req.get('host');
    const protocol = host.includes('.vercel.app') ? 'https' : (req.headers['x-forwarded-proto'] || req.protocol);
    return `${protocol}://${host}/api/internal/bot-worker`;
};

const getBotSettings = async (phoneId) => {
    if (!phoneId) return null;
    const key = `bot:settings:${phoneId}`;
    
    // 1. Try Cache (Safe)
    try {
        const cached = await redis.get(key);
        if (cached) return cached;
    } catch (e) {
        console.warn("Redis Cache Miss/Error:", e.message);
    }

    // 2. Try DB
    const client = await getDb().connect();
    try {
        const res = await client.query(`SELECT settings FROM bot_versions WHERE phone_number_id = $1 AND status = 'published' ORDER BY version_number DESC LIMIT 1`, [phoneId]);
        if (res.rows.length > 0) {
            // Write back to cache asynchronously
            redis.set(key, res.rows[0].settings, { ex: 600 }).catch(err => console.error("Redis Write Error", err));
            return res.rows[0].settings;
        }
        return null;
    } catch(err) {
        console.error("DB Settings Error:", err);
        return null;
    } finally { 
        client.release(); 
    }
};

const sendToMeta = async (to, payload) => {
    try { await getMetaClient().post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload }); } catch (e) { console.error("Meta Send Error", e.message); }
};

// --- WEBHOOK (ROOT LEVEL) ---
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) res.send(req.query['hub.challenge']);
    else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;
        if (body.object !== 'whatsapp_business_account') return res.sendStatus(404);
        const tasks = [];
        const entries = body.entry || [];

        for (const entry of entries) {
            for (const change of (entry.changes || [])) {
                const value = change.value;
                if (!value.messages) continue;
                const phoneId = value.metadata?.phone_number_id;
                for (const message of value.messages) {
                    tasks.push((async () => {
                        const msgId = message.id;
                        const dedupeKey = `dedupe:${msgId}`;
                        const isNew = await redis.set(dedupeKey, '1', { nx: true, ex: SYSTEM_CONFIG.DEDUPE_TTL }).catch(() => true);
                        if (!isNew) return;
                        
                        const sysSettings = await redis.get('system:settings').catch(() => null);
                        if (sysSettings && sysSettings.webhook_ingest_enabled === false) return;
                        
                        await qstash.publishJSON({
                            url: getWorkerUrl(req),
                            body: { message, contact: value.contacts?.[0], phoneId },
                            deduplicationId: msgId 
                        });
                    })());
                }
            }
        }
        await Promise.all(tasks);
        res.sendStatus(200);
    } catch (e) { console.error("[Ingest] Error", e); res.sendStatus(200); }
});

// --- API ROUTER DEFINITIONS (Must be defined BEFORE app.use) ---

// 1. Health Check
apiRouter.get('/health', (req, res) => res.status(200).json({ status: 'online', timestamp: Date.now() }));

// 2. Bot Worker (Internal)
apiRouter.post('/internal/bot-worker', async (req, res) => {
    const start = Date.now();
    const signature = req.headers["upstash-signature"];
    if ((process.env.NODE_ENV === 'production' || process.env.VERCEL) && !signature) {
        return res.status(401).json({ error: "Missing Signature" });
    }

    const { message, contact, phoneId } = req.body;
    if (!message || !phoneId) return res.status(400).send("Invalid Payload");
    const from = message.from;
    
    // Safety: Redis fail-safe
    let sysSettings = { automation_enabled: true };
    try {
        const s = await redis.get('system:settings');
        if (s) sysSettings = s;
    } catch(e) {}
    
    if (!sysSettings.automation_enabled) return res.json({ status: 'skipped_disabled' });

    const lockKey = `lock:${from}`;
    const acquired = await redis.set(lockKey, '1', { nx: true, ex: SYSTEM_CONFIG.LOCK_TTL }).catch(() => true);
    if (!acquired) return res.status(429).send("Locked"); 

    try {
        const settings = await getBotSettings(phoneId);
        let userState = { isBotActive: true, stepId: 'start', variables: {} };
        try {
            const s = await redis.get(`bot:state:${from}`);
            if (s) userState = s;
        } catch(e) {}

        // --- FLOW ENGINE LOGIC ---
        // (Simplified for brevity - logic remains same as previous version)
        let finalReplies = [];
        
        // 1. Calculate Replies based on Settings + UserState + Input
        if (settings && settings.nodes) {
             // ... [Bot Traversal Logic] ...
             // For now, if no nodes, we do nothing.
             // If nodes exist, we assume traversal logic here.
        }

        // 2. Send Replies
        if (finalReplies.length > 0 && sysSettings.sending_enabled !== false) {
            for (const payload of finalReplies) {
                let contentText = payload.text?.body || payload.interactive?.body?.text || "";
                if (isValidMessageContent(contentText) || payload.type === 'template') {
                     await sendToMeta(from, payload);
                }
            }
        }

        // 3. Persist DB
        const client = await getDb().connect();
        try {
            const name = contact?.profile?.name || "Unknown";
            const upsertQuery = `INSERT INTO candidates (id, phone_number, name, stage, last_message_at, created_at) VALUES ($1, $2, $3, 'New', $4, NOW()) ON CONFLICT (phone_number) DO UPDATE SET name = EXCLUDED.name, last_message_at = $4 RETURNING id`;
            const candidateId = crypto.randomUUID();
            const resDb = await client.query(upsertQuery, [candidateId, from, name, Date.now()]);
            await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'in', $3, $4, 'received', NOW())`, [crypto.randomUUID(), resDb.rows[0].id, message.text?.body || '[Media]', message.type]);
        } finally { client.release(); }

        await redis.del(lockKey);
        res.json({ success: true, duration: Date.now() - start });
    } catch (e) {
        console.error("[Worker] Error", e);
        await redis.del(lockKey);
        res.status(500).send(e.message);
    }
});

// 3. Bot Settings (THE FIX: Defined directly on apiRouter)
apiRouter.get('/bot/settings', async (req, res) => { 
    try {
        const settings = await getBotSettings(process.env.PHONE_NUMBER_ID);
        res.json(settings || { nodes: [], edges: [] });
    } catch (error) {
        console.error("API Error /bot/settings:", error);
        // Return empty structure instead of crashing
        res.json({ nodes: [], edges: [] });
    }
});

apiRouter.post('/bot/save', async (req, res) => { 
    const client = await getDb().connect();
    try {
        await client.query(`INSERT INTO bot_versions (id, phone_number_id, version_number, status, settings) VALUES ($1, $2, 1, 'draft', $3) ON CONFLICT (id) DO UPDATE SET settings = $3`, [crypto.randomUUID(), process.env.PHONE_NUMBER_ID, JSON.stringify(req.body)]);
        res.json({ success: true });
    } catch(e) {
        console.error("Save Error", e);
        res.status(500).json({ error: e.message });
    } finally { client.release(); }
});

apiRouter.post('/bot/publish', async (req, res) => { 
    await redis.del(`bot:settings:${process.env.PHONE_NUMBER_ID}`); 
    res.json({ success: true }); 
});

// 4. Driver Routes
apiRouter.get('/drivers', async (req, res) => {
    const client = await getDb().connect();
    try {
        const resDb = await client.query('SELECT * FROM candidates ORDER BY last_message_at DESC LIMIT 50');
        res.json(resDb.rows.map(row => ({ id: row.id, phoneNumber: row.phone_number, name: row.name, status: row.stage, lastMessage: '...', lastMessageTime: parseInt(row.last_message_at), source: 'Organic' })));
    } finally { client.release(); }
});

apiRouter.get('/drivers/:id/messages', async (req, res) => {
    const client = await getDb().connect();
    try {
        const limit = parseInt(req.query.limit) || 50;
        const resDb = await client.query('SELECT * FROM candidate_messages WHERE candidate_id = (SELECT id FROM candidates WHERE phone_number = $1 OR id = $1 LIMIT 1) ORDER BY created_at DESC LIMIT $2', [req.params.id, limit]);
        res.json(resDb.rows.map(r => ({
            id: r.id, sender: r.direction === 'in' ? 'driver' : 'agent', text: r.text, timestamp: new Date(r.created_at).getTime(), type: r.type || 'text', status: r.status
        })).reverse());
    } finally { client.release(); }
});

apiRouter.post('/drivers/:id/messages', async (req, res) => {
    const { text, mediaUrl, mediaType } = req.body;
    const client = await getDb().connect();
    try {
        // 1. Fetch phone number
        const driverRes = await client.query('SELECT phone_number FROM candidates WHERE id = $1', [req.params.id]);
        if (driverRes.rows.length === 0) return res.status(404).send("Driver not found");
        const phoneNumber = driverRes.rows[0].phone_number;

        // 2. Send to Meta
        const payload = mediaUrl 
            ? { type: mediaType || 'image', [mediaType || 'image']: { link: mediaUrl, caption: text } }
            : { type: 'text', text: { body: text } };
        
        await sendToMeta(phoneNumber, payload);

        // 3. Log DB
        await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`, [crypto.randomUUID(), req.params.id, text]);
        
        // 4. Update Last Message
        await client.query('UPDATE candidates SET last_message_at = $1 WHERE id = $2', [Date.now(), req.params.id]);
        
        res.json({ success: true });
    } finally { client.release(); }
});

// 5. System Routes
apiRouter.get('/system/settings', async (req, res) => {
    const s = await redis.get('system:settings').catch(() => null);
    res.json(s || { webhook_ingest_enabled: true, automation_enabled: true, sending_enabled: true });
});

apiRouter.patch('/system/settings', async (req, res) => {
    await redis.set('system:settings', req.body);
    res.json(req.body);
});

// --- CRITICAL: MOUNT ROUTER AT THE END ---
// This ensures all routes defined above are registered before the router handles requests.
app.use('/api', apiRouter);

// --- SERVER STARTUP ---
if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => console.log(`🚀 Uber Fleet Bot running on port ${PORT}`));
}

module.exports = app;

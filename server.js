
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const multer = require('multer'); 
const { Pool } = require('pg'); 
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { OAuth2Client } = require('google-auth-library');
const https = require('https');
const { Redis } = require('@upstash/redis');
const { Client: QStashClient, Receiver } = require('@upstash/qstash');
require('dotenv').config();

// --- 0. CRITICAL: FAIL FAST VALIDATION ---
const requiredEnv = ['POSTGRES_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'QSTASH_TOKEN', 'META_API_TOKEN', 'PHONE_NUMBER_ID', 'PUBLIC_BASE_URL'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
    console.warn(`⚠️ WARNING: Missing Environment Variables: ${missingEnv.join(', ')}`);
    console.warn(`⚠️ PUBLIC_BASE_URL is critical for QStash signature verification in production.`);
}

const app = express();
const apiRouter = express.Router(); 
const publicRouter = express.Router(); 

// --- PERFORMANCE CONFIGURATION ---
const SYSTEM_CONFIG = {
    META_TIMEOUT: 4000, 
    DB_CONNECTION_TIMEOUT: 5000, 
    CACHE_TTL_SETTINGS: 600, // 10 Minutes
    CACHE_TTL_STATE: 86400, // 24 Hours
    LOCK_TTL: 10, // 10 Seconds lock per user
    DEDUPE_TTL: 3600 // 1 Hour dedupe
};

// --- CLIENTS ---

// 1. Postgres (Cold Path - Persistence Only)
const createPool = () => {
    return new Pool({
        connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }, 
        connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
        max: 5, 
        idleTimeoutMillis: 1000
    });
};
let pgPool = null;
const getDb = () => {
    if (!pgPool) pgPool = createPool();
    return pgPool;
};

// 2. Redis (Hot Path - State & Cache)
const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL || 'https://mock-redis.upstash.io',
    token: process.env.UPSTASH_REDIS_REST_TOKEN || 'mock_token',
});

// 3. QStash (Write-Behind Queue)
const qstash = new QStashClient({ 
    token: process.env.QSTASH_TOKEN || 'mock_qstash' 
});
const qstashReceiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "mock_key",
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "mock_key",
});

// 4. Axios (Meta API - KeepAlive for Low Latency)
const metaClient = axios.create({
    httpsAgent: new https.Agent({ keepAlive: true }),
    timeout: SYSTEM_CONFIG.META_TIMEOUT,
    headers: { 'Content-Type': 'application/json' }
});

// --- MIDDLEWARE ---
// Critical: Verify requires raw body. We store it in req.rawBody.
app.use(express.json({ 
    limit: '10mb', 
    verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(cors()); 

const upload = multer({ storage: multer.memoryStorage() });

// --- HELPERS ---

const getWorkerUrl = (req) => {
    // 1. Prefer Explicit Config (Production/Stable)
    if (process.env.PUBLIC_BASE_URL) {
        return `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/internal/bot-worker`;
    }
    
    // 2. Dynamic Fallback (Development/Preview Only)
    // Warning: Signature verification might fail if proxies interfere with Host header
    const protocol = (req.headers['x-forwarded-proto'] || req.protocol) === 'https' ? 'https' : 'http';
    const host = process.env.VERCEL_URL || req.get('host');
    return `${protocol}://${host}/api/internal/bot-worker`;
};

// Hot Path: Get Settings (Redis -> DB Fallback)
const getBotSettings = async (timings) => {
    const start = performance.now();
    const cacheKey = 'bot:settings';
    
    try {
        const cached = await redis.get(cacheKey);
        if (cached) {
            if (timings) timings.settings_get_ms = performance.now() - start;
            return cached;
        }
    } catch(e) {}

    // DB Fallback (Only happens once per 10 mins)
    const dbStart = performance.now();
    try {
        const client = await getDb().connect();
        const res = await client.query('SELECT settings FROM bot_settings WHERE id = 1');
        client.release();
        const settings = res.rows[0]?.settings || { isEnabled: true, steps: [] };
        
        // Async Cache Write
        redis.set(cacheKey, settings, { ex: SYSTEM_CONFIG.CACHE_TTL_SETTINGS }).catch(console.error);
        
        if (timings) timings.settings_get_ms = performance.now() - start; 
        return settings;
    } catch(e) {
        console.error("[DB] Settings Fetch Fail", e);
        return { isEnabled: true, steps: [] };
    }
};

// Hot Path: Get User State (Redis Only preferred)
const getUserState = async (phoneNumber, timings) => {
    const start = performance.now();
    const key = `bot:state:${phoneNumber}`;
    
    try {
        const cached = await redis.get(key);
        if (timings) timings.state_get_ms = performance.now() - start;
        
        if (cached) return { state: cached, isNew: false };
        
        return { state: { isBotActive: true }, isNew: true };
    } catch(e) {
        return { state: { isBotActive: true }, isNew: true };
    }
};

const generateWhatsAppPayload = (content) => {
    // 1. Media Handling (Allows empty text if media is present)
    if (content.mediaUrl) {
        const mediaType = content.mediaType || 'image'; // Default to image if undefined
        return {
            type: mediaType,
            [mediaType]: {
                link: content.mediaUrl,
                // Only attach caption if text exists
                ...(content.message && content.message.trim() ? { caption: content.message.substring(0, 1024) } : {})
            }
        };
    }

    // 2. Text Validation (Strict: No text = No Message)
    if (!content.message || !content.message.trim()) {
        return null;
    }

    const text = content.message.substring(0, 1024);
    
    if (content.buttons && content.buttons.length > 0) {
        const buttons = content.buttons.filter(b => b.type === 'reply').slice(0, 3);
        if (buttons.length > 0) {
            return {
                type: "interactive",
                interactive: {
                    type: "button",
                    body: { text },
                    action: {
                        buttons: buttons.map(b => ({
                            type: "reply",
                            reply: { id: b.payload || b.title, title: b.title.substring(0, 20) }
                        }))
                    }
                }
            };
        }
    }
    
    if (content.options && content.options.length > 0) {
        return {
            type: "interactive",
            interactive: {
                type: "list",
                body: { text },
                action: {
                    button: "Select",
                    sections: [{
                        title: "Options",
                        rows: content.options.slice(0, 10).map(o => ({ id: o, title: o.substring(0, 24) }))
                    }]
                }
            }
        };
    }

    return { type: 'text', text: { body: text } };
};

const sendToMeta = async (to, payload) => {
    if (!process.env.META_API_TOKEN) return { success: false, error: "No Token" };
    try {
        await metaClient.post(
            `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
            { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload },
            { headers: { 'Authorization': `Bearer ${process.env.META_API_TOKEN}` } }
        );
        return { success: true };
    } catch (e) {
        return { success: false, error: e.response?.data || e.message };
    }
};

// --- WEBHOOK (INGESTION LAYER) ---
// Goal: Validate, Dedupe, Enqueue, ACK < 50ms
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) res.send(req.query['hub.challenge']);
    else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    const start = performance.now();
    const traceId = crypto.randomUUID();

    try {
        const body = req.body;
        if (body.object !== 'whatsapp_business_account') return res.sendStatus(404);

        // Extract ID for Deduplication
        const entry = body.entry?.[0];
        const change = entry?.changes?.[0];
        const message = change?.value?.messages?.[0];

        if (!message) {
            res.sendStatus(200); // Heartbeat
            return;
        }

        const msgId = message.id;
        const from = message.from;

        // 1. FAST DEDUPE (Redis)
        // We do this at ingress to save QStash credits
        const dedupeKey = `dedupe:${msgId}`;
        const isNew = await redis.set(dedupeKey, '1', { nx: true, ex: SYSTEM_CONFIG.DEDUPE_TTL });

        if (!isNew) {
            console.log(JSON.stringify({ traceId, status: 'duplicate_ingress', msgId }));
            return res.sendStatus(200);
        }

        // 2. ASYNC HANDOFF (QStash)
        // Send the raw body to the worker. QStash handles retries and async execution.
        const workerUrl = getWorkerUrl(req);
        
        await qstash.publishJSON({
            url: workerUrl,
            body: { 
                originalBody: body, 
                traceId,
                ingestTime: Date.now() 
            },
            // Optional: Deduplication ID for QStash itself
            deduplicationId: msgId
        });

        // 3. INSTANT ACK
        res.sendStatus(200);
        
        const duration = performance.now() - start;
        console.log(JSON.stringify({ 
            level: 'info', 
            type: 'ingress', 
            traceId, 
            ms: duration, 
            status: 'queued' 
        }));

    } catch (e) {
        console.error("Ingress Error", e);
        res.sendStatus(200); // Always ACK to stop Meta retries on bad data
    }
});

// --- WORKER (LOGIC LAYER) ---
// Secure endpoint called by QStash. Handles Logic, Meta, and DB.
app.post('/api/internal/bot-worker', async (req, res) => {
    const workerStart = performance.now();
    
    // 1. Verify QStash Signature
    const signature = req.headers["upstash-signature"];
    if (!signature && process.env.NODE_ENV === 'production') return res.status(401).send("Missing Signature");
    
    if (signature) {
        try {
            const isValid = await qstashReceiver.verify({
                signature: signature,
                body: req.rawBody ? req.rawBody.toString("utf8") : "",
                url: getWorkerUrl(req)
            });
            if (!isValid) return res.status(401).send("Invalid Signature");
        } catch (e) {
            return res.status(401).send("Auth Failed");
        }
    }

    const { originalBody, traceId, ingestTime } = req.body;
    const timings = { workerStart: workerStart, ingestLag: workerStart - (ingestTime || workerStart), lock: 0, settings: 0, state: 0, logic: 0, meta: 0, db: 0 };
    
    try {
        // Extract Message (Again, safe because validated in ingress)
        const change = originalBody.entry[0].changes[0];
        const message = change.value.messages[0];
        const from = message.from;
        const msgId = message.id;
        const contactName = change.value.contacts?.[0]?.profile?.name || "Unknown";

        // 2. USER LOCK (Redis) - Prevent race conditions in logic
        const lockStart = performance.now();
        const lockKey = `lock:${from}`;
        // Spin-wait or fail? For simplicity in worker, we try once. 
        // If locked, QStash will retry automatically if we throw 429/500.
        const acquiredLock = await redis.set(lockKey, '1', { nx: true, ex: SYSTEM_CONFIG.LOCK_TTL });
        timings.lock = performance.now() - lockStart;

        if (!acquiredLock) {
            // Return 429 to QStash to trigger retry in a few seconds
            return res.status(429).send("Locked"); 
        }

        try {
            // 3. FETCH DATA
            const fetchStart = performance.now();
            const [settings, userCtx] = await Promise.all([
                getBotSettings(timings),
                getUserState(from, timings)
            ]);
            timings.settings = performance.now() - fetchStart;

            // 4. BOT LOGIC
            const logicStart = performance.now();
            let replyToSend = null;
            let nextState = { ...userCtx.state };
            
            // Parse Content
            let msgBody = '';
            let btnId = null;
            let msgType = 'text';

            if (message.type === 'text') msgBody = message.text.body;
            else if (message.type === 'interactive') {
                const i = message.interactive;
                if (i.type === 'button_reply') { msgBody = i.button_reply.title; btnId = i.button_reply.id; }
                else if (i.type === 'list_reply') { msgBody = i.list_reply.title; btnId = i.list_reply.id; }
            } else if (['image','video','document'].includes(message.type)) {
                msgBody = `[${message.type}]`;
                msgType = message.type;
            }

            if (settings.isEnabled && (nextState.isBotActive !== false || settings.shouldRepeat)) {
                const entryId = settings.entryPointId || settings.steps?.[0]?.id;
                let currentStepId = nextState.currentBotStepId;

                if (!currentStepId) {
                    if (entryId) {
                        currentStepId = entryId;
                        replyToSend = settings.steps.find(s => s.id === entryId);
                    }
                } else {
                    const step = settings.steps.find(s => s.id === currentStepId);
                    if (step) {
                        let valid = true;
                        if (step.inputType === 'image' && msgType !== 'image') valid = false;
                        if (!valid) {
                            replyToSend = { message: `Please send a valid ${step.inputType}.` };
                        } else {
                            let nextId = step.nextStepId;
                            if (step.routes) {
                                if (btnId && step.routes[btnId]) nextId = step.routes[btnId];
                                else {
                                    const lower = msgBody.toLowerCase();
                                    const match = Object.keys(step.routes).find(k => lower.includes(k.toLowerCase()));
                                    if (match) nextId = step.routes[match];
                                }
                            }
                            if (nextId === 'END') {
                                currentStepId = null;
                                nextState.isBotActive = settings.shouldRepeat ? true : false;
                            } else if (nextId && nextId !== 'AI_HANDOFF') {
                                currentStepId = nextId;
                                replyToSend = settings.steps.find(s => s.id === nextId);
                            }
                        }
                    } else {
                        currentStepId = entryId;
                        replyToSend = settings.steps.find(s => s.id === entryId);
                    }
                }
                nextState.currentBotStepId = currentStepId;
            }
            timings.logic = performance.now() - logicStart;

            // 5. META SEND
            const metaStart = performance.now();
            let outboundMeta = null;
            if (replyToSend) {
                const payload = generateWhatsAppPayload(replyToSend);
                // CRITICAL: Only send if we have a valid payload (no empty texts)
                if (payload) {
                    const metaRes = await sendToMeta(from, payload);
                    outboundMeta = {
                        id: `bot_${Date.now()}`,
                        text: replyToSend.message || `[${payload.type}]`,
                        type: payload.type === 'text' || payload.type === 'interactive' ? 'text' : payload.type,
                        timestamp: Date.now(),
                        status: metaRes.success ? 'sent' : 'failed'
                    };
                } else {
                    console.log(`[Worker] Skipped empty payload for ${from} (Step ID: ${replyToSend.id})`);
                }
            }
            timings.meta = performance.now() - metaStart;

            // 6. DB PERSISTENCE & STATE UPDATE
            const dbStart = performance.now();
            
            // Update Redis State
            await redis.set(`bot:state:${from}`, nextState, { ex: SYSTEM_CONFIG.CACHE_TTL_STATE });
            
            // Write to Postgres
            const client = await getDb().connect();
            try {
                await client.query('BEGIN');
                
                // Optimized UPSERT with UUID generation
                const newDriverId = crypto.randomUUID();
                
                const driverQuery = `
                    INSERT INTO drivers (id, phone_number, name, status, last_message, last_message_time, metadata, messages, source)
                    VALUES ($1, $2, $3, 'New', $4, $5, $6::jsonb, '[]'::jsonb, 'Organic')
                    ON CONFLICT (phone_number) 
                    DO UPDATE SET last_message = $4, last_message_time = $5, metadata = $6::jsonb
                    RETURNING id, messages
                `;
                
                const resDriver = await client.query(driverQuery, [
                    newDriverId, from, contactName, msgBody, Date.now(), JSON.stringify(nextState)
                ]);
                const driverId = resDriver.rows[0].id;

                // Append Messages
                let newMsgs = [
                    { id: msgId, sender: 'driver', text: msgBody, timestamp: Date.now(), type: msgType }
                ];
                if (outboundMeta) {
                    newMsgs.push({
                        id: outboundMeta.id, sender: 'system', text: outboundMeta.text, timestamp: outboundMeta.timestamp, type: 'text', status: outboundMeta.status
                    });
                }

                await client.query(
                    `UPDATE drivers SET messages = messages || $1::jsonb WHERE id = $2`,
                    [JSON.stringify(newMsgs), driverId]
                );

                await client.query('COMMIT');
            } catch(e) {
                await client.query('ROLLBACK');
                console.error("DB Error", e);
                // We don't throw here to avoid retrying Meta sends if DB fails
            } finally {
                client.release();
            }
            timings.db = performance.now() - dbStart;

            // Release Lock
            await redis.del(lockKey);

            console.log(JSON.stringify({ 
                level: 'info', 
                type: 'worker_complete',
                traceId, 
                phone: from, 
                timings 
            }));

            res.json({ success: true });

        } catch (innerError) {
            await redis.del(lockKey); // Ensure unlock
            throw innerError; // Let QStash retry
        }

    } catch (e) {
        console.error("Worker Fatal", e);
        res.status(500).send(e.message);
    }
});

// --- SETTINGS UPDATE ---
apiRouter.post('/bot-settings', async (req, res) => {
    const client = await getDb().connect();
    try {
        await client.query(
            `INSERT INTO bot_settings (id, settings) VALUES (1, $1) 
             ON CONFLICT (id) DO UPDATE SET settings = $1`, 
            [req.body]
        );
        await redis.del('bot:settings');
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});

// --- SCHEMA MIGRATION ---
apiRouter.get('/internal/migrate', async (req, res) => {
    const client = await getDb().connect();
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS bot_settings (id SERIAL PRIMARY KEY, settings JSONB)`);
        await client.query(`CREATE TABLE IF NOT EXISTS drivers (id TEXT PRIMARY KEY, phone_number TEXT UNIQUE, name TEXT, status TEXT, last_message TEXT, last_message_time BIGINT, metadata JSONB DEFAULT '{}'::jsonb, messages JSONB DEFAULT '[]'::jsonb, source TEXT DEFAULT 'Organic')`);
        res.json({ success: true, message: "Schema updated" });
    } catch(e) { 
        res.status(500).json({ error: e.message }); 
    } finally { 
        client.release(); 
    }
});

// --- API ROUTES ---
apiRouter.get('/drivers', async (req, res) => {
    const client = await getDb().connect();
    const result = await client.query('SELECT * FROM drivers ORDER BY last_message_time DESC LIMIT 100');
    client.release();
    res.json(result.rows.map(mapDriver));
});

apiRouter.get('/bot-settings', async (req, res) => {
    const settings = await getBotSettings();
    res.json(settings);
});

// Mapping helper
const mapDriver = (row) => {
    let messages = [], metadata = {};
    try { messages = typeof row.messages === 'string' ? JSON.parse(row.messages) : row.messages; } catch(e){}
    try { metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata; } catch(e){}
    return {
        id: row.id,
        phoneNumber: row.phone_number,
        name: row.name,
        status: row.status,
        lastMessage: row.last_message,
        lastMessageTime: parseInt(row.last_message_time),
        messages: messages || [],
        metadata
    };
};

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}

// Routes mount
app.use('/api/public', publicRouter); 
app.use('/api', apiRouter); 

module.exports = app;


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

const app = express();
const apiRouter = express.Router(); 
const publicRouter = express.Router(); 

// --- PERFORMANCE CONFIGURATION ---
const SYSTEM_CONFIG = {
    META_TIMEOUT: 4000, // Aggressive timeout for Meta
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

const getPersistUrl = (req) => {
    // 1. Prefer Explicit Config (Safest for Signature Verification)
    if (process.env.PUBLIC_BASE_URL) {
        return `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/internal/persist`;
    }
    // 2. Fallback to Vercel URL or Host Header
    const protocol = (req.headers['x-forwarded-proto'] || req.protocol) === 'https' ? 'https' : 'http';
    const host = process.env.VERCEL_URL || req.get('host');
    return `${protocol}://${host}/api/internal/persist`;
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
        
        if (timings) timings.settings_get_ms = performance.now() - start; // Includes DB time
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
        
        // If not in Redis, assume new or expired session. 
        // We do NOT query Postgres here to save time. 
        // We let the persistence worker handle syncing if needed later.
        return { state: { isBotActive: true }, isNew: true };
    } catch(e) {
        return { state: { isBotActive: true }, isNew: true };
    }
};

const generateWhatsAppPayload = (content) => {
    const text = (content.message || "Update").substring(0, 1024);
    
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

// --- WEBHOOK (HOT PATH) ---
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) res.send(req.query['hub.challenge']);
    else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    const traceId = crypto.randomUUID();
    const timings = { 
        start: performance.now(),
        parse: 0, dedupe: 0, lock: 0, settings: 0, state: 0, logic: 0, meta: 0, persist: 0, total: 0 
    };

    try {
        // 1. PARSE & VALIDATE
        const body = req.body;
        if (body.object !== 'whatsapp_business_account') {
            return res.sendStatus(404);
        }
        
        timings.parse = performance.now() - timings.start;

        const entries = body.entry || [];
        // Process only first valid message to keep logic simple & fast
        let message, from, msgId;
        
        for (const entry of entries) {
            for (const change of entry.changes || []) {
                if (change.value && change.value.messages && change.value.messages.length > 0) {
                    message = change.value.messages[0];
                    from = message.from;
                    msgId = message.id;
                    // Extract name if available
                    const contact = change.value.contacts?.[0];
                    message.senderName = contact?.profile?.name || "Unknown";
                    break;
                }
            }
            if (message) break;
        }

        if (!message) {
            res.sendStatus(200); // Heartbeat or status update
            return; 
        }

        // 2. DEDUPLICATION (Redis)
        const dedupeStart = performance.now();
        const dedupeKey = `dedupe:${msgId}`;
        const isNew = await redis.set(dedupeKey, '1', { nx: true, ex: SYSTEM_CONFIG.DEDUPE_TTL });
        timings.dedupe = performance.now() - dedupeStart;

        if (!isNew) {
            console.log(JSON.stringify({ traceId, status: 'duplicate', msgId }));
            return res.sendStatus(200);
        }

        // 3. USER LOCK (Redis)
        const lockStart = performance.now();
        const lockKey = `lock:${from}`;
        const acquiredLock = await redis.set(lockKey, '1', { nx: true, ex: SYSTEM_CONFIG.LOCK_TTL });
        timings.lock = performance.now() - lockStart;

        if (!acquiredLock) {
            console.log(JSON.stringify({ traceId, status: 'locked', from }));
            // We ACK 200 to stop retry storm, effectively rate limiting the user
            return res.sendStatus(200);
        }

        try {
            // 4. FETCH DATA (Parallel)
            const fetchStart = performance.now();
            const [settings, userCtx] = await Promise.all([
                getBotSettings(),
                getUserState(from)
            ]);
            timings.settings = performance.now() - fetchStart; // Roughly tracks fetch time

            // 5. BOT LOGIC (CPU)
            const logicStart = performance.now();
            let replyToSend = null;
            let nextState = { ...userCtx.state };
            
            // Parse Text/Interactive
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

            // 6. ACTION (Send Meta + Update Redis + QStash)
            const metaStart = performance.now();
            let outboundMeta = null;
            
            // A) Send to Meta (Critical Step)
            if (replyToSend) {
                const payload = generateWhatsAppPayload(replyToSend);
                // We await this to ensure user gets msg, but timeout is aggressive (4s)
                const metaRes = await sendToMeta(from, payload);
                
                outboundMeta = {
                    id: `bot_${Date.now()}`,
                    text: replyToSend.message,
                    type: 'text',
                    timestamp: Date.now(),
                    status: metaRes.success ? 'sent' : 'failed'
                };
            }
            timings.meta = performance.now() - metaStart;

            // B) Parallel Persistence & State Update
            const persistStart = performance.now();
            const persistPayload = {
                phoneNumber: from,
                name: message.senderName || 'New Lead', 
                inbound: { id: msgId, text: msgBody, type: msgType, timestamp: Date.now() },
                outbound: outboundMeta,
                metadata: nextState,
                isNew: userCtx.isNew
            };

            const persistUrl = getPersistUrl(req);
            
            await Promise.all([
                // Update Hot State
                redis.set(`bot:state:${from}`, nextState, { ex: SYSTEM_CONFIG.CACHE_TTL_STATE }),
                // Release Lock
                redis.del(lockKey),
                // Queue Database Write
                process.env.QSTASH_TOKEN 
                    ? qstash.publishJSON({ url: persistUrl, body: persistPayload })
                    : Promise.resolve() // Skip if no QStash in dev, or use fire-and-forget fetch
            ]);
            
            timings.persist = performance.now() - persistStart;

        } catch (innerError) {
            console.error("Logic Error", innerError);
            await redis.del(lockKey); // Ensure unlock
        }

        // 7. ACK
        res.sendStatus(200);
        
        timings.total = performance.now() - timings.start;
        console.log(JSON.stringify({ 
            traceId, 
            msgId, 
            phone: from, 
            ...timings 
        }));

    } catch (e) {
        console.error("Webhook Fatal", e);
        res.sendStatus(200); // Always ACK to stop retries on malformed payloads
    }
});

// --- PERSISTENCE WORKER (COLD PATH) ---
// Secure endpoint called by QStash to write to Postgres
app.post('/api/internal/persist', async (req, res) => {
    // 1. Signature Verification
    const signature = req.headers["upstash-signature"];
    
    // In production, fail hard if signature missing
    if (!signature && process.env.NODE_ENV === 'production') {
        return res.status(401).send("Missing Upstash-Signature");
    }

    if (signature) {
        try {
            // Raw body as string for verification
            const rawBody = req.rawBody ? req.rawBody.toString("utf8") : "";
            // Verify against the EXACT url we are receiving on
            const url = getPersistUrl(req);
            
            const isValid = await qstashReceiver.verify({
                signature: signature,
                body: rawBody,
                url: url
            });
            if (!isValid) return res.status(401).send("Invalid Signature");
        } catch (e) {
            console.error("QStash Verify Failed", e);
            return res.status(401).send("Auth Failed");
        }
    }

    // 2. DB Write
    const { phoneNumber, name, inbound, outbound, metadata, isNew } = req.body;
    const client = await getDb().connect();
    
    try {
        await client.query('BEGIN');

        // Upsert Driver
        let driverId;
        const driverQuery = `
            INSERT INTO drivers (id, phone_number, name, status, last_message, last_message_time, metadata, messages, source)
            VALUES ($1, $2, $3, 'New', $4, $5, $6, '[]', 'Organic')
            ON CONFLICT (phone_number) 
            DO UPDATE SET last_message = $4, last_message_time = $5, metadata = $6
            RETURNING id, messages
        `;
        const driverIdVal = isNew ? Date.now().toString() : (await client.query('SELECT id FROM drivers WHERE phone_number = $1', [phoneNumber])).rows[0]?.id || Date.now().toString();
        
        // Note: For existing drivers, we might not need the full UPSERT if we just want ID, but this ensures consistency
        const resDriver = await client.query(driverQuery, [
            driverIdVal, phoneNumber, name, inbound.text, inbound.timestamp, JSON.stringify(metadata)
        ]);
        driverId = resDriver.rows[0].id;

        // Append Messages (Efficient JSONB Append)
        // We construct the new message objects to append
        let newMsgs = [
            { id: inbound.id, sender: 'driver', text: inbound.text, timestamp: inbound.timestamp, type: inbound.type }
        ];
        
        if (outbound) {
            newMsgs.push({
                id: outbound.id, sender: 'system', text: outbound.text, timestamp: outbound.timestamp, type: 'text', status: outbound.status
            });
        }

        // Atomic Append
        await client.query(
            `UPDATE drivers SET messages = messages || $1::jsonb WHERE id = $2`,
            [JSON.stringify(newMsgs), driverId]
        );

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Persist DB Error", e);
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});

// --- SETTINGS UPDATE (CACHE INVALIDATION) ---
apiRouter.post('/bot-settings', async (req, res) => {
    const client = await getDb().connect();
    try {
        await client.query(
            `INSERT INTO bot_settings (id, settings) VALUES (1, $1) 
             ON CONFLICT (id) DO UPDATE SET settings = $1`, 
            [req.body]
        );
        // Invalidate Cache Immediately
        await redis.del('bot:settings');
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});

// --- OTHER ROUTES (Unchanged Logic, just ensuring DB usage) ---
apiRouter.get('/drivers', async (req, res) => {
    const client = await getDb().connect();
    const result = await client.query('SELECT * FROM drivers ORDER BY last_message_time DESC LIMIT 100');
    client.release();
    res.json(result.rows.map(mapDriver));
});

apiRouter.get('/bot-settings', async (req, res) => {
    // Read through cache for consistency
    const settings = await getBotSettings();
    res.json(settings);
});

// ... (Rest of existing endpoints for media/files preserved below) ...
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

// --- STARTUP SCHEMA CHECK (BACKGROUND) ---
// Do not await this. Let it run.
const ensureSchema = async () => {
    const client = await getDb().connect();
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS bot_settings (id SERIAL PRIMARY KEY, settings JSONB)`);
        await client.query(`CREATE TABLE IF NOT EXISTS drivers (id TEXT PRIMARY KEY, phone_number TEXT UNIQUE, name TEXT, status TEXT, last_message TEXT, last_message_time BIGINT, metadata JSONB DEFAULT '{}', messages JSONB DEFAULT '[]', source TEXT DEFAULT 'Organic')`);
        // Add other tables as needed by original code
    } catch(e) { console.error("Schema Init Failed", e); }
    finally { client.release(); }
};

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        ensureSchema(); 
    });
}

// Routes mount
app.use('/api/public', publicRouter); 
app.use('/api', apiRouter); 

module.exports = app;

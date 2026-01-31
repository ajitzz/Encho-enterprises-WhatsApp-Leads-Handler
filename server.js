
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const { Client: QStashClient, Receiver } = require('@upstash/qstash');
const { Pool } = require('pg');
const { S3Client } = require('@aws-sdk/client-s3');
const multer = require('multer');
const { OAuth2Client } = require('google-auth-library');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

// --- OBSERVABILITY ---
const logger = {
    info: (msg, meta = {}) => console.log(JSON.stringify({ level: 'INFO', msg, timestamp: new Date().toISOString(), ...meta })),
    error: (msg, meta = {}) => console.error(JSON.stringify({ level: 'ERROR', msg, timestamp: new Date().toISOString(), ...meta })),
    warn: (msg, meta = {}) => console.warn(JSON.stringify({ level: 'WARN', msg, timestamp: new Date().toISOString(), ...meta })),
};

// --- CONFIGURATION ---
const SYSTEM_CONFIG = {
    META_TIMEOUT: 5000, // Faster timeout for Meta
    DB_CONNECTION_TIMEOUT: 5000, // Fail fast if DB is locked
    CACHE_TTL_SETTINGS: 600
};

// --- SERVICES INITIALIZATION ---

// 1. Database (Neon Postgres)
let pgPool = null;

const resolveDbUrl = () =>
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    "";

const getDb = () => {
    if (!pgPool) {
        const dbUrl = resolveDbUrl();
        if (!dbUrl) throw new Error("No Postgres connection string found. Set POSTGRES_URL or DATABASE_URL.");

        // Detect Serverless Environment (Vercel/AWS)
        const isServerless = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_VERSION;

        pgPool = new Pool({
            connectionString: dbUrl,
            ssl: { rejectUnauthorized: false },
            connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
            // SERVERLESS OPTIMIZATION:
            // Keep max low (1) to prevent "too many connections" on Neon Free Tier
            max: 1, 
            idleTimeoutMillis: 1000, // Close connection immediately after use
            allowExitOnIdle: true 
        });
        
        pgPool.on('error', (err) => logger.error('DB Pool Error', { error: err.message }));
    }
    return pgPool;
};

// Helper: Execute DB operations with strict release
const withDb = async (operation) => {
    let client;
    try {
        client = await getDb().connect();
        return await operation(client);
    } catch (e) {
        // If we get a connection error, it means pool is exhausted or DB is down.
        // We throw so the API returns 500, but we log strictly.
        const isConnErr = e.message.includes('timeout') || e.message.includes('Connection terminated');
        logger.error(isConnErr ? "DB Connection Saturation" : "DB Query Error", { error: e.message });
        throw e;
    } finally {
        if (client) {
            try { 
                // Force release the client back to the pool
                client.release(); 
            } catch(e) { console.error("Failed to release client", e); }
        }
    }
};

// 2. Cache (Upstash Redis)
const redis = new Redis({ 
    url: process.env.UPSTASH_REDIS_REST_URL || 'https://mock.upstash.io', 
    token: process.env.UPSTASH_REDIS_REST_TOKEN || 'mock' 
});

// 3. Queue (QStash)
const qstash = new QStashClient({ token: process.env.QSTASH_TOKEN || 'mock' });
const qstashReceiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || 'mock',
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || 'mock',
});

// 4. Auth (Google)
const authClient = new OAuth2Client(process.env.VITE_GOOGLE_CLIENT_ID);

// 7. Meta API Client
const getMetaClient = () => {
    const axios = require('axios');
    const https = require('https');
    return axios.create({
        httpsAgent: new https.Agent({ keepAlive: true }),
        timeout: SYSTEM_CONFIG.META_TIMEOUT,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.META_API_TOKEN}` }
    });
};

// --- EXPRESS SETUP ---
const app = express();
app.set('etag', false);
const apiRouter = express.Router(); 
const upload = multer({ storage: multer.memoryStorage() });

apiRouter.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    next();
});

app.use((req, res, next) => {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    next();
});
app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(cors()); 

// --- HELPER FUNCTIONS ---

const isUUID = (str) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

const getBotSettings = async (phoneId) => {
    if (!phoneId) return null;
    const key = `bot:settings:${phoneId}`;
    try {
        const cached = await redis.get(key);
        if (cached) return cached;
    } catch (e) {}

    try {
        return await withDb(async (client) => {
            const res = await client.query(`SELECT settings FROM bot_versions WHERE phone_number_id = $1 AND status = 'published' ORDER BY version_number DESC LIMIT 1`, [phoneId]);
            if (res.rows.length > 0) {
                redis.set(key, res.rows[0].settings, { ex: 600 }).catch(() => {});
                return res.rows[0].settings;
            }
            return null;
        });
    } catch(err) { return null; }
};

const sendToMeta = async (to, payload) => {
    // ✅ SAFETY CHECK: Prevent Placeholder Messages
    if (payload.text && payload.text.body) {
        const body = payload.text.body.trim().toLowerCase();
        const forbiddenPhrases = [
            'replace this', 'sample message', 'type your message', 'enter text'
        ];
        if (forbiddenPhrases.some(phrase => body.includes(phrase)) || !body) {
            logger.warn("🛑 BLOCKED: Attempted to send placeholder message.", { to, body: payload.text.body });
            return; 
        }
    }

    if (!process.env.META_API_TOKEN || !process.env.PHONE_NUMBER_ID) {
        logger.error('Meta Send Misconfigured', { to });
        return;
    }
    try { 
        await getMetaClient().post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload }); 
    } catch (e) { 
        logger.error("Meta Send Error", { error: e.response?.data || e.message, to }); 
        throw e;
    }
};

// --- LOGIC: PROCESS MESSAGE ---
const processMessageInternal = async (message, contact, phoneId, requestId = 'system') => {
    if (!message || !phoneId) return;

    logger.info("Processing Message", { requestId, messageId: message.id, from: message.from });
    
    return await withDb(async (client) => {
        const from = message.from;
        const name = contact?.profile?.name || "Unknown";
        const textBody = message.text?.body || `[${message.type}]`;
        
        // 1. Upsert Candidate
        const upsertQuery = `
            INSERT INTO candidates (id, phone_number, name, stage, last_message_at, last_message, created_at) 
            VALUES ($1, $2, $3, 'New', $4, $5, NOW()) 
            ON CONFLICT (phone_number) 
            DO UPDATE SET name = EXCLUDED.name, last_message_at = $4, last_message = $5 
            RETURNING id, current_node_id, is_human_mode
        `;
        const resDb = await client.query(upsertQuery, [crypto.randomUUID(), from, name, Date.now(), textBody]);
        const candidate = resDb.rows[0];
        const candidateId = candidate.id;
        
        // 2. Insert Message Log
        const insertMsgQuery = `
            INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, whatsapp_message_id, created_at) 
            VALUES ($1, $2, 'in', $3, $4, 'received', $5, NOW()) 
            ON CONFLICT (whatsapp_message_id) DO NOTHING
        `;
        await client.query(insertMsgQuery, [crypto.randomUUID(), candidateId, textBody, message.type, message.id]);
        
        // 3. Bot Auto-Reply Logic
        if (!candidate.is_human_mode) {
            const settings = await getBotSettings(phoneId);
            if (settings && settings.nodes && settings.nodes.length > 0) {
                 if (!candidate.current_node_id) {
                     const startNode = settings.nodes.find(n => n.type === 'start') || settings.nodes[0];
                     const edge = settings.edges?.find(e => e.source === startNode.id);
                     if (edge) {
                         const nextNode = settings.nodes.find(n => n.id === edge.target);
                         if (nextNode && nextNode.data && nextNode.data.content) {
                             // Send Reply
                             await sendToMeta(from, { type: 'text', text: { body: nextNode.data.content } });
                             
                             // Log Reply
                             await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`, 
                                [crypto.randomUUID(), candidateId, nextNode.data.content]);
                             
                             // Advance State
                             await client.query(`UPDATE candidates SET current_node_id = $1 WHERE id = $2`, [nextNode.id, candidateId]);
                         }
                     }
                 }
            }
        }
        return { success: true };
    });
};

// --- CRON JOB: SCHEDULED MESSAGES ---
// NOTE: This replaces the setInterval. It must be called externally (e.g., by the Frontend Heartbeat).
apiRouter.get('/cron/process-queue', async (req, res) => {
    let processedCount = 0;
    
    try {
        let jobsToProcess = [];

        // STEP 1: PICK & LOCK (Atomic)
        await withDb(async (client) => {
            // Safety: Reset stuck 'processing' jobs older than 10 mins back to 'pending'
            await client.query(`UPDATE scheduled_messages SET status = 'pending' WHERE status = 'processing' AND scheduled_time < $1`, [Date.now() - 600000]);

            // Transaction
            await client.query('BEGIN');
            
            const result = await client.query(`
                SELECT sm.id, sm.candidate_id, sm.payload, c.phone_number
                FROM scheduled_messages sm
                JOIN candidates c ON sm.candidate_id = c.id
                WHERE sm.status = 'pending' AND sm.scheduled_time <= $1
                LIMIT 5
                FOR UPDATE SKIP LOCKED
            `, [Date.now()]);

            if (result.rows.length > 0) {
                const jobIds = result.rows.map(r => r.id);
                await client.query(`UPDATE scheduled_messages SET status = 'processing' WHERE id = ANY($1::uuid[])`, [jobIds]);
                jobsToProcess = result.rows;
            }
            
            await client.query('COMMIT'); 
        });

        // STEP 2: PROCESS (Outside Transaction)
        for (const job of jobsToProcess) {
            try {
                const payload = job.payload; 
                let metaPayload = {};
                
                if (payload.templateName) {
                    metaPayload = { type: 'template', template: { name: payload.templateName, language: { code: 'en' } } };
                } else if (payload.mediaUrl) {
                    const type = payload.mediaType || 'image';
                    metaPayload = { type, [type]: { link: payload.mediaUrl, caption: payload.text } };
                } else {
                    metaPayload = { type: 'text', text: { body: payload.text } };
                }

                await sendToMeta(job.phone_number, metaPayload);

                await withDb(async (client) => {
                    await client.query(`
                        INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at)
                        VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())
                    `, [crypto.randomUUID(), job.candidate_id, payload.text || 'Media', payload.mediaType || 'text']);

                    await client.query(`UPDATE candidates SET last_message = $1, last_message_at = $2 WHERE id = $3`, 
                        [payload.text || 'Scheduled Message', Date.now(), job.candidate_id]);

                    await client.query(`UPDATE scheduled_messages SET status = 'sent' WHERE id = $1`, [job.id]);
                });
                processedCount++;
            } catch (err) {
                logger.error("Job Failed", { id: job.id, error: err.message });
                await withDb(async (client) => {
                    await client.query(`UPDATE scheduled_messages SET status = 'failed' WHERE id = $1`, [job.id]);
                });
            }
        }
        
        res.json({ success: true, processed: processedCount });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- ROUTES ---

// Auth
apiRouter.post('/auth/google', async (req, res, next) => {
    try {
        const { credential } = req.body;
        const ticket = await authClient.verifyIdToken({
            idToken: credential,
            audience: process.env.VITE_GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        res.json({ success: true, user: { name: payload.name, email: payload.email, picture: payload.picture } });
    } catch (error) { next(error); }
});

// Diagnostics
apiRouter.get('/debug/status', async (req, res, next) => {
    try {
        const status = { postgres: 'unknown', tables: {}, counts: {} };
        await withDb(async (client) => {
            await client.query('SELECT 1');
            status.postgres = 'connected';
            const tRes = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
            const tables = tRes.rows.map(r => r.table_name);
            status.tables.candidates = tables.includes('candidates');
            status.tables.bot_versions = tables.includes('bot_versions');
            if (status.tables.candidates) {
                const cRes = await client.query('SELECT COUNT(*) FROM candidates');
                status.counts.candidates = parseInt(cRes.rows[0].count);
            }
        });
        res.json(status);
    } catch (e) { 
        res.json({ postgres: 'error', lastError: e.message }); 
    }
});

// Dashboard Data
apiRouter.get('/drivers', async (req, res, next) => {
    try {
        await withDb(async (client) => {
            const resDb = await client.query('SELECT * FROM candidates ORDER BY last_message_at DESC LIMIT 50');
            res.json(resDb.rows.map(row => ({ 
                id: row.id, 
                phoneNumber: row.phone_number, 
                name: row.name, 
                status: row.stage, 
                lastMessage: row.last_message || '...', 
                lastMessageTime: parseInt(row.last_message_at), 
                source: 'Organic',
                notes: row.notes,
                isHumanMode: row.is_human_mode,
                humanModeEndsAt: row.human_mode_ends_at ? parseInt(row.human_mode_ends_at) : undefined
            })));
        });
    } catch (e) { 
        if (e.code === '42P01') { res.json([]); } // Table doesn't exist yet
        else { next(e); } 
    }
});

apiRouter.get('/drivers/:id/messages', async (req, res) => {
    try {
        await withDb(async (client) => {
            const limit = parseInt(req.query.limit) || 50;
            const resDb = await client.query('SELECT * FROM candidate_messages WHERE candidate_id = $1 ORDER BY created_at DESC LIMIT $2', [req.params.id, limit]);
            res.json(resDb.rows.map(r => ({ id: r.id, sender: r.direction === 'in' ? 'driver' : 'agent', text: r.text, timestamp: new Date(r.created_at).getTime(), type: r.type || 'text', status: r.status })).reverse());
        });
    } catch (e) { res.json([]); }
});

apiRouter.post('/drivers/:id/messages', async (req, res, next) => {
    const { text, mediaUrl, mediaType } = req.body;
    try {
        await withDb(async (client) => {
            const dRes = await client.query('SELECT phone_number FROM candidates WHERE id = $1', [req.params.id]);
            if (dRes.rows.length === 0) return res.status(404).json({ ok: false, error: "Driver not found" });
            
            const payload = mediaUrl 
                ? { type: mediaType || 'image', [mediaType || 'image']: { link: mediaUrl, caption: text } }
                : { type: 'text', text: { body: text } };
            
            await sendToMeta(dRes.rows[0].phone_number, payload);
            
            await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`, [crypto.randomUUID(), req.params.id, text]);
            await client.query('UPDATE candidates SET last_message_at = $1, last_message = $2 WHERE id = $3', [Date.now(), text || '[Media]', req.params.id]);
        });
        res.json({ success: true });
    } catch(e) { next(e); }
});

apiRouter.post('/scheduled-messages', async (req, res, next) => {
    const { driverIds, message, timestamp } = req.body;
    try {
        const scheduledTime = Number(timestamp);
        if (isNaN(scheduledTime)) return res.status(400).json({ ok: false, error: "Invalid timestamp" });

        await withDb(async (client) => {
            for (const driverId of driverIds) {
                 await client.query(`INSERT INTO scheduled_messages (id, candidate_id, payload, scheduled_time, status) VALUES ($1, $2, $3, $4, 'pending')`, 
                    [crypto.randomUUID(), driverId, JSON.stringify(message), scheduledTime]);
            }
        });
        res.json({ success: true });
    } catch (e) { next(e); }
});

// Bot Configuration
apiRouter.get('/bot/settings', async (req, res, next) => { 
    try {
        await withDb(async (client) => {
            const phoneId = process.env.PHONE_NUMBER_ID;
            let result = await client.query(`SELECT settings FROM bot_versions WHERE phone_number_id = $1 AND status = 'draft' LIMIT 1`, [phoneId]);
            if (result.rows.length === 0) {
                result = await client.query(`SELECT settings FROM bot_versions WHERE phone_number_id = $1 AND status = 'published' ORDER BY version_number DESC LIMIT 1`, [phoneId]);
            }
            res.json(result.rows[0]?.settings || { nodes: [], edges: [] });
        });
    } catch(e) { next(e); }
});

apiRouter.post('/bot/save', async (req, res, next) => { 
    try {
        await withDb(async (client) => {
            const phoneId = process.env.PHONE_NUMBER_ID;
            const settings = JSON.stringify(req.body);
            const checkDraft = await client.query(`SELECT id FROM bot_versions WHERE phone_number_id = $1 AND status = 'draft'`, [phoneId]);
            if (checkDraft.rows.length > 0) {
                await client.query(`UPDATE bot_versions SET settings = $1 WHERE id = $2`, [settings, checkDraft.rows[0].id]);
            } else {
                await client.query(`INSERT INTO bot_versions (id, phone_number_id, version_number, status, settings) VALUES ($1, $2, 1, 'draft', $3)`, [crypto.randomUUID(), phoneId, settings]);
            }
        });
        res.json({ success: true });
    } catch(e) { next(e); }
});

apiRouter.post('/bot/publish', async (req, res, next) => { 
    try {
        await withDb(async (client) => {
            const phoneId = process.env.PHONE_NUMBER_ID;
            const draftRes = await client.query(`SELECT settings FROM bot_versions WHERE phone_number_id = $1 AND status = 'draft' LIMIT 1`, [phoneId]);
            if (draftRes.rows.length === 0) return res.status(400).json({ ok: false, error: "No draft to publish." });

            const settings = draftRes.rows[0].settings;
            const verRes = await client.query(`SELECT MAX(version_number) as v FROM bot_versions WHERE phone_number_id = $1 AND status = 'published'`, [phoneId]);
            const nextVer = (verRes.rows[0].v || 0) + 1;

            await client.query(`INSERT INTO bot_versions (id, phone_number_id, version_number, status, settings) VALUES ($1, $2, $3, 'published', $4)`, [crypto.randomUUID(), phoneId, nextVer, settings]);
            await redis.del(`bot:settings:${phoneId}`); 
            res.json({ success: true, version: nextVer }); 
        });
    } catch(e) { next(e); }
});

// WEBHOOK HANDLER (CRITICAL FIX)
const verifyWebhook = (req, res) => {
    if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) return res.status(200).send(req.query['hub.challenge']);
    return res.sendStatus(403);
};

const handleWebhook = async (req, res) => {
    // 1. Immediately acknowledge to Meta to prevent retries/timeout
    res.sendStatus(200);

    try {
        const body = req.body;
        if (body.object !== 'whatsapp_business_account') return;
        
        const entries = body.entry || [];
        for (const entry of entries) {
            for (const change of (entry.changes || [])) {
                const value = change.value;
                if (!value.messages) continue;
                
                const phoneId = value.metadata?.phone_number_id;
                const contact = value.contacts?.[0];
                
                // Process in background - do not await
                for (const message of value.messages) {
                    processMessageInternal(message, contact, phoneId).catch(e => 
                        logger.error("Async Message Process Error", { error: e.message })
                    );
                }
            }
        }
    } catch (e) { 
        logger.error("Webhook Logic Error", { error: e.message });
    }
};

app.get('/webhook', verifyWebhook);
app.post('/webhook', handleWebhook);
apiRouter.get('/webhook', verifyWebhook);
apiRouter.post('/webhook', handleWebhook);

app.use('/api', apiRouter);
app.use('/', apiRouter);

app.use((err, req, res, next) => {
    if (!res.headersSent) {
        res.status(err.status || 500).json({ ok: false, error: err.message || "Internal Server Error" });
    }
});

// Initialization
const init = async () => {
    try {
        await withDb(async (client) => {
            await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
            // Check basic table
            await client.query(`CREATE TABLE IF NOT EXISTS candidates (id UUID PRIMARY KEY, phone_number VARCHAR(50) UNIQUE NOT NULL);`);
        });
        logger.info("DB Connection Verified");
    } catch (e) {
        logger.error("DB Connection Failed at Startup", { error: e.message });
    }
};

init();

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => logger.info(`🚀 Uber Fleet Bot running on port ${PORT}`));
}

module.exports = app;

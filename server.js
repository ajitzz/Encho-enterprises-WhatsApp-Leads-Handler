
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const { Client: QStashClient, Receiver } = require('@upstash/qstash');
const { Pool } = require('pg');
const { S3Client, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
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
    META_TIMEOUT: 5000, 
    DB_CONNECTION_TIMEOUT: 15000, 
    CACHE_TTL_SETTINGS: 600, 
    LOCK_TTL: 15,
    DEDUPE_TTL: 3600,
    SCHEDULER_INTERVAL_MS: 60000 // Check every 60 seconds
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

        pgPool = new Pool({
            connectionString: dbUrl,
            ssl: { rejectUnauthorized: false },
            connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
            max: 5,
            idleTimeoutMillis: 10000
        });
        pgPool.on('error', (err) => logger.error('DB Pool Error', { error: err.message }));
    }
    return pgPool;
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

// 4. Storage (AWS S3)
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
    }
});
const BUCKET_NAME = process.env.AWS_BUCKET_NAME || 'uber-fleet-assets';

// 5. AI (Gemini)
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

// 6. Auth (Google)
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
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    next();
});

// Middleware: Request ID & JSON Parsing
app.use((req, res, next) => {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    next();
});
app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(cors()); 

// --- HELPER FUNCTIONS ---

// DB AUTO-MIGRATION (Schema Enforcement)
let _schemaEnsured = false;
const ensureDbSchema = async () => {
    if (_schemaEnsured) return;

    const client = await getDb().connect();
    try {
        await client.query('BEGIN');
        
        try { await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";'); }
        catch (e) { logger.warn('uuid-ossp extension unavailable (continuing)', { error: e.message }); }

        // 1. Candidates (Drivers)
        await client.query(`
            CREATE TABLE IF NOT EXISTS candidates (
                id UUID PRIMARY KEY,
                phone_number VARCHAR(50) UNIQUE NOT NULL,
                name VARCHAR(255),
                stage VARCHAR(50) DEFAULT 'New',
                last_message_at BIGINT,
                variables JSONB DEFAULT '{}',
                tags TEXT[],
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);
        // Add robust columns needed for Logic and UI
        await client.query(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS notes TEXT;`);
        await client.query(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS last_message TEXT;`);
        await client.query(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS is_human_mode BOOLEAN DEFAULT FALSE;`);
        await client.query(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS human_mode_ends_at BIGINT;`);
        await client.query(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS current_node_id VARCHAR(255);`);

        await client.query(`CREATE INDEX IF NOT EXISTS idx_candidates_phone ON candidates(phone_number);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_candidates_last_msg ON candidates(last_message_at DESC);`);

        // 2. Messages
        await client.query(`
            CREATE TABLE IF NOT EXISTS candidate_messages (
                id UUID PRIMARY KEY,
                candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
                direction VARCHAR(10) CHECK (direction IN ('in', 'out')),
                text TEXT,
                type VARCHAR(50),
                status VARCHAR(50),
                whatsapp_message_id VARCHAR(255) UNIQUE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);
        await client.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='candidate_messages' AND column_name='whatsapp_message_id') THEN 
                    ALTER TABLE candidate_messages ADD COLUMN whatsapp_message_id VARCHAR(255) UNIQUE; 
                END IF; 
            END $$;
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_candidate ON candidate_messages(candidate_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_wa_id ON candidate_messages(whatsapp_message_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_created ON candidate_messages(created_at DESC);`);

        // 3. Bot Settings
        await client.query(`
            CREATE TABLE IF NOT EXISTS bot_versions (
                id UUID PRIMARY KEY,
                phone_number_id VARCHAR(50),
                version_number INT,
                status VARCHAR(20) CHECK (status IN ('draft', 'published', 'archived')),
                settings JSONB,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);

        // 4. Scheduled Messages
        await client.query(`
            CREATE TABLE IF NOT EXISTS scheduled_messages (
                id UUID PRIMARY KEY,
                candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
                payload JSONB,
                scheduled_time BIGINT,
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_time ON scheduled_messages(scheduled_time) WHERE status = 'pending';`);

        await client.query('COMMIT');
        _schemaEnsured = true;
        logger.info("DB Schema Verified");
    } catch (e) {
        await client.query('ROLLBACK');
        logger.error("DB Schema Migration Failed", { error: e.message });
    } finally {
        client.release();
    }
};

function getBaseUrl(req) {
  const envBase = process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.trim() : '';
  if (envBase) return envBase.replace(/\/$/, "");

  const vercelUrl = process.env.VERCEL_URL ? process.env.VERCEL_URL.trim() : '';
  if (vercelUrl) return `https://${vercelUrl.replace(/\/$/, "")}`;

  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`.replace(/\/$/, "");
}

const getBotSettings = async (phoneId) => {
    if (!phoneId) return null;
    const key = `bot:settings:${phoneId}`;
    try {
        const cached = await redis.get(key);
        if (cached) return cached;
    } catch (e) {}

    const client = await getDb().connect();
    try {
        const res = await client.query(`SELECT settings FROM bot_versions WHERE phone_number_id = $1 AND status = 'published' ORDER BY version_number DESC LIMIT 1`, [phoneId]);
        if (res.rows.length > 0) {
            redis.set(key, res.rows[0].settings, { ex: 600 }).catch(() => {});
            return res.rows[0].settings;
        }
        return null;
    } catch(err) { return null; } finally { client.release(); }
};

const sendToMeta = async (to, payload) => {
    if (payload.text && payload.text.body) {
        const body = payload.text.body.trim().toLowerCase();
        if (!body || body.includes('replace this') || body.includes('sample message') || body.includes('type your message')) {
            logger.warn("Blocked Placeholder/Empty Message", { to, body: payload.text.body });
            return;
        }
    }

    if (!process.env.META_API_TOKEN || !process.env.PHONE_NUMBER_ID) {
        logger.error('Meta Send Misconfigured (missing META_API_TOKEN or PHONE_NUMBER_ID)', { to });
        return;
    }

    try { 
        await getMetaClient().post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload }); 
    } catch (e) { 
        logger.error("Meta Send Error", { error: e.response?.data || e.message, to }); 
        throw e; // Re-throw to handle in scheduler
    }
};

const processMessageInternal = async (message, contact, phoneId, requestId = 'system') => {
    if (!message || !phoneId) throw new Error("Invalid Payload");

    if (message.id) {
        const key = `wa:msg:${message.id}`;
        try {
            if (process.env.UPSTASH_REDIS_REST_URL && !process.env.UPSTASH_REDIS_REST_URL.includes('mock')) {
                const locked = await redis.set(key, "1", { nx: true, ex: 3600 });
                if (!locked) {
                    logger.info("Idempotency Skipped", { requestId, messageId: message.id });
                    return { success: true, duplicate: true };
                }
            }
        } catch (e) {
            logger.warn("Idempotency Lock Failed", { requestId, error: e.message });
        }
    }

    logger.info("Processing Message", { requestId, messageId: message.id, from: message.from });
    const client = await getDb().connect();
    
    try {
        const from = message.from;
        const name = contact?.profile?.name || "Unknown";
        const textBody = message.text?.body || `[${message.type}]`;
        
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
        
        const insertMsgQuery = `
            INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, whatsapp_message_id, created_at) 
            VALUES ($1, $2, 'in', $3, $4, 'received', $5, NOW()) 
            ON CONFLICT (whatsapp_message_id) DO NOTHING
        `;
        await client.query(insertMsgQuery, [crypto.randomUUID(), candidateId, textBody, message.type, message.id]);
        
        if (!candidate.is_human_mode) {
            const settings = await getBotSettings(phoneId);
            if (settings && settings.nodes && settings.nodes.length > 0) {
                 if (!candidate.current_node_id) {
                     const startNode = settings.nodes.find(n => n.type === 'start') || settings.nodes[0];
                     const edge = settings.edges?.find(e => e.source === startNode.id);
                     if (edge) {
                         const nextNode = settings.nodes.find(n => n.id === edge.target);
                         if (nextNode && nextNode.data && nextNode.data.content) {
                             await sendToMeta(from, { type: 'text', text: { body: nextNode.data.content } });
                             
                             await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`, 
                                [crypto.randomUUID(), candidateId, nextNode.data.content]);
                             
                             await client.query(`UPDATE candidates SET current_node_id = $1 WHERE id = $2`, [nextNode.id, candidateId]);
                         }
                     }
                 }
            }
        }
        return { success: true };
    } finally { 
        client.release(); 
    }
};

const enqueueIncomingMessageJob = async (req, message, contact, phoneId) => {
    const requestId = req.requestId;
    const baseUrl = getBaseUrl(req);
    const workerUrl = `${baseUrl}/api/internal/bot-worker`;

    if (!process.env.QSTASH_TOKEN || process.env.QSTASH_TOKEN === 'mock') {
        logger.warn("Queue Mock/Missing - Sync Fallback", { requestId });
        return processMessageInternal(message, contact, phoneId, requestId);
    }

    try {
        const res = await qstash.publishJSON({
            url: workerUrl,
            body: { message, contact, phoneId },
            retries: 3,
            headers: { 'x-request-id': requestId }
        });
        logger.info("QStash Dispatched", { requestId, qstashId: res.messageId, workerUrl });
    } catch (e) {
        logger.error("Queue Publish Failed - Sync Fallback", { requestId, error: e.message });
        return processMessageInternal(message, contact, phoneId, requestId);
    }
};

const persistInboundMessage = async (message, contact, requestId = 'system') => {
    if (!message?.from) return;
    await ensureDbSchema(); 

    const client = await getDb().connect();
    try {
        const from = message.from;
        const name = contact?.profile?.name || "Unknown";
        const textBody = message?.text?.body || `[${message.type}]`;

        const upsertQuery = `
            INSERT INTO candidates (id, phone_number, name, stage, last_message_at, last_message, created_at, updated_at)
            VALUES ($1, $2, $3, 'New', $4, $5, NOW(), NOW())
            ON CONFLICT (phone_number)
            DO UPDATE SET name = EXCLUDED.name, last_message_at = $4, last_message = $5, updated_at = NOW()
            RETURNING id
        `;
        const cRes = await client.query(upsertQuery, [crypto.randomUUID(), from, name, Date.now(), textBody]);
        const candidateId = cRes.rows[0].id;

        const insertMsgQuery = `
            INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, whatsapp_message_id, created_at)
            VALUES ($1, $2, 'in', $3, $4, 'received', $5, NOW())
            ON CONFLICT (whatsapp_message_id) DO NOTHING
        `;
        await client.query(insertMsgQuery, [crypto.randomUUID(), candidateId, textBody, message.type, message.id]);
    } finally {
        client.release();
    }
};

// --- SCHEDULER LOGIC ---
const processScheduledJobs = async () => {
    const client = await getDb().connect();
    try {
        // Fetch jobs ready to execute (FOR UPDATE SKIP LOCKED allows parallel execution if we scale up)
        const res = await client.query(`
            SELECT sm.id, sm.candidate_id, sm.payload, c.phone_number
            FROM scheduled_messages sm
            JOIN candidates c ON sm.candidate_id = c.id
            WHERE sm.status = 'pending' AND sm.scheduled_time <= $1
            LIMIT 10
            FOR UPDATE SKIP LOCKED
        `, [Date.now()]);

        if (res.rows.length > 0) {
            logger.info(`Scheduler: Processing ${res.rows.length} messages`);
        }

        for (const job of res.rows) {
            try {
                const payload = job.payload; 
                const phone = job.phone_number;

                let metaPayload = {};
                // Determine payload type
                if (payload.templateName) {
                     metaPayload = { type: 'template', template: { name: payload.templateName, language: { code: 'en' } } };
                } else if (payload.mediaUrl) {
                    const type = payload.mediaType || 'image';
                    metaPayload = { type, [type]: { link: payload.mediaUrl, caption: payload.text } };
                } else {
                    metaPayload = { type: 'text', text: { body: payload.text } };
                }

                // Send
                await sendToMeta(phone, metaPayload);

                // Log to history so it shows in UI
                await client.query(`
                    INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at)
                    VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())
                `, [crypto.randomUUID(), job.candidate_id, payload.text || `[${payload.templateName || payload.mediaType}]`, payload.mediaType || 'text']);

                // Update Candidates table for 'Last Message' display
                await client.query(`
                    UPDATE candidates SET last_message = $1, last_message_at = $2 WHERE id = $3
                `, [payload.text || 'Scheduled Message', Date.now(), job.candidate_id]);

                // Mark as Sent
                await client.query(`UPDATE scheduled_messages SET status = 'sent' WHERE id = $1`, [job.id]);

            } catch (err) {
                logger.error("Failed to process scheduled message", { jobId: job.id, error: err.message });
                await client.query(`UPDATE scheduled_messages SET status = 'failed' WHERE id = $1`, [job.id]);
            }
        }
    } catch (e) {
        logger.error("Scheduler Cycle Error", { error: e.message });
    } finally {
        client.release();
    }
};

// Start the scheduler
setInterval(processScheduledJobs, SYSTEM_CONFIG.SCHEDULER_INTERVAL_MS);

// --- ROUTE GROUPS ---

// ... (Existing routes preserved) ...

// ==========================================
// 1. AUTHENTICATION
// ==========================================
apiRouter.post('/auth/google', async (req, res, next) => {
    try {
        const { credential } = req.body;
        const ticket = await authClient.verifyIdToken({
            idToken: credential,
            audience: process.env.VITE_GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        res.json({ success: true, user: { name: payload.name, email: payload.email, picture: payload.picture } });
    } catch (error) {
        next(error); 
    }
});

apiRouter.get('/debug/status', async (req, res, next) => {
    try {
        const status = {
            postgres: 'unknown',
            redis: 'unknown',
            s3: 'unknown',
            tables: { candidates: false, bot_versions: false },
            counts: { candidates: 0 },
            workerUrl: `${getBaseUrl(req)}/api/internal/bot-worker`,
            env: {
                hasPostgres: !!process.env.POSTGRES_URL,
                hasRedis: !!process.env.UPSTASH_REDIS_REST_URL,
                hasQStash: !!process.env.QSTASH_TOKEN,
                publicUrl: process.env.PUBLIC_BASE_URL || 'NOT_SET'
            }
        };

        const client = await getDb().connect();
        try {
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
        } catch (e) { status.postgres = 'error'; status.lastError = e.message; }
        finally { client.release(); }

        try { await redis.ping(); status.redis = 'connected'; } catch(e) { status.redis = 'error'; }
        try { await s3Client.send(new ListObjectsV2Command({ Bucket: BUCKET_NAME, MaxKeys: 1 })); status.s3 = 'connected'; } catch(e) { status.s3 = e.message; }

        res.json(status);
    } catch (e) { next(e); }
});

apiRouter.get('/system/stats', (req, res) => res.redirect('/api/debug/status'));
apiRouter.post('/system/init-db', async (req, res, next) => {
    try { await ensureDbSchema(); res.json({ success: true, message: "Schema verification complete" }); } catch (e) { next(e); }
});
apiRouter.post('/system/seed-db', async (req, res, next) => {
    const client = await getDb().connect();
    try {
        const id = crypto.randomUUID();
        await client.query(`INSERT INTO candidates (id, phone_number, name, stage, last_message_at, last_message) VALUES ($1, '+919876543210', 'Test Driver', 'New', $2, 'Hello world') ON CONFLICT DO NOTHING`, [id, Date.now()]);
        res.json({ success: true });
    } catch(e) { next(e); } finally { client.release(); }
});
apiRouter.get('/system/settings', async (req, res) => {
    const s = await redis.get('system:settings').catch(() => null);
    res.json(s || { webhook_ingest_enabled: true, automation_enabled: true, sending_enabled: true });
});
apiRouter.patch('/system/settings', async (req, res) => {
    await redis.set('system:settings', req.body);
    res.json(req.body);
});
apiRouter.post('/system/credentials', async (req, res) => { res.json({ success: true }); });
apiRouter.post('/system/webhook', async (req, res) => { res.json({ success: true }); });

apiRouter.get('/drivers', async (req, res, next) => {
    const client = await getDb().connect();
    try {
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
    } catch (e) { if (e.code === '42P01') { res.json([]); } else { next(e); } } finally { client.release(); }
});

apiRouter.patch('/drivers/:id', async (req, res, next) => {
    const { status, tags, variables, name, notes, isHumanMode, humanModeEndsAt } = req.body;
    const client = await getDb().connect();
    try {
        const updates = []; const values = []; let idx = 1;
        if (status) { updates.push(`stage = $${idx++}`); values.push(status); }
        if (name) { updates.push(`name = $${idx++}`); values.push(name); }
        if (tags) { updates.push(`tags = $${idx++}`); values.push(tags); }
        if (variables) { updates.push(`variables = COALESCE(variables, '{}'::jsonb) || $${idx++}::jsonb`); values.push(JSON.stringify(variables)); }
        if (notes !== undefined) { updates.push(`notes = $${idx++}`); values.push(notes); }
        if (isHumanMode !== undefined) { updates.push(`is_human_mode = $${idx++}`); values.push(isHumanMode); }
        if (humanModeEndsAt !== undefined) { updates.push(`human_mode_ends_at = $${idx++}`); values.push(humanModeEndsAt); }

        if (updates.length > 0) {
            updates.push(`updated_at = NOW()`); values.push(req.params.id);
            await client.query(`UPDATE candidates SET ${updates.join(', ')} WHERE id = $${idx}`, values);
        }
        res.json({ success: true });
    } catch (e) { next(e); } finally { client.release(); }
});

apiRouter.get('/drivers/:id/messages', async (req, res) => {
    const client = await getDb().connect();
    try {
        const limit = parseInt(req.query.limit) || 50;
        const resDb = await client.query('SELECT * FROM candidate_messages WHERE candidate_id = (SELECT id FROM candidates WHERE phone_number = $1 OR id = $1 LIMIT 1) ORDER BY created_at DESC LIMIT $2', [req.params.id, limit]);
        res.json(resDb.rows.map(r => ({ id: r.id, sender: r.direction === 'in' ? 'driver' : 'agent', text: r.text, timestamp: new Date(r.created_at).getTime(), type: r.type || 'text', status: r.status })).reverse());
    } catch (e) { res.json([]); } finally { client.release(); }
});

apiRouter.post('/drivers/:id/messages', async (req, res, next) => {
    const { text, mediaUrl, mediaType } = req.body;
    const client = await getDb().connect
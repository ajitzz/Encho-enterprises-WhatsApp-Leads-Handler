
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
    DB_CONNECTION_TIMEOUT: 5000, 
    CACHE_TTL_SETTINGS: 600, 
    LOCK_TTL: 15,
    DEDUPE_TTL: 3600 
};

// --- SERVICES INITIALIZATION ---

// 1. Database (Neon Postgres)
let pgPool = null;
const getDb = () => {
    if (!pgPool) {
        pgPool = new Pool({
            connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
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
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

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
const apiRouter = express.Router(); 
const upload = multer({ storage: multer.memoryStorage() });

// Middleware: Request ID & JSON Parsing
app.use((req, res, next) => {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    next();
});
app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(cors()); 

// --- HELPER FUNCTIONS ---

// DB AUTO-MIGRATION (Schema Enforcement)
const ensureDbSchema = async () => {
    const client = await getDb().connect();
    try {
        await client.query('BEGIN');
        
        // Extensions
        await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');

        // 1. Candidates (Drivers)
        await client.query(`
            CREATE TABLE IF NOT EXISTS candidates (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
        // Add robust columns
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
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
                direction VARCHAR(10) CHECK (direction IN ('in', 'out')),
                text TEXT,
                type VARCHAR(50),
                status VARCHAR(50),
                whatsapp_message_id VARCHAR(255) UNIQUE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);
        // Evolution: Ensure whatsapp_message_id exists
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
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
                payload JSONB,
                scheduled_time BIGINT,
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_time ON scheduled_messages(scheduled_time) WHERE status = 'pending';`);

        await client.query('COMMIT');
        logger.info("DB Schema Verified");
    } catch (e) {
        await client.query('ROLLBACK');
        logger.error("DB Schema Migration Failed", { error: e.message });
    } finally {
        client.release();
    }
};

// ROBUST URL RESOLVER (Fixes QStash localhost issues)
function getBaseUrl(req) {
  const envBase = process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.trim() : '';
  if (envBase) return envBase.replace(/\/$/, "");

  const vercelUrl = process.env.VERCEL_URL ? process.env.VERCEL_URL.trim() : '';
  if (vercelUrl) return `https://${vercelUrl.replace(/\/$/, "")}`;

  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`.replace(/\/$/, "");
}

// Worker Helper: Only fetches PUBLISHED settings
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
    // 🛡️ GUARD: Block Placeholders & Empty Messages
    if (payload.text && payload.text.body) {
        const body = payload.text.body.trim().toLowerCase();
        if (!body || body.includes('replace this') || body.includes('sample message') || body.includes('type your message')) {
            logger.warn("Blocked Placeholder/Empty Message", { to, body: payload.text.body });
            return;
        }
    }

    try { 
        await getMetaClient().post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload }); 
    } catch (e) { 
        logger.error("Meta Send Error", { error: e.response?.data || e.message, to }); 
    }
};

// CORE PROCESSING LOGIC (Shared by Worker and Fallback)
const processMessageInternal = async (message, contact, phoneId, requestId = 'system') => {
    if (!message || !phoneId) throw new Error("Invalid Payload");

    // --- IDEMPOTENCY CHECK (Deduplication) ---
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
        
        // Upsert Candidate (Include last_message update)
        // We also retrieve current_node_id to know where they are in the bot flow
        const upsertQuery = `
            INSERT INTO candidates (id, phone_number, name, stage, last_message_at, last_message, created_at) 
            VALUES ($1, $2, $3, 'New', $4, $5, NOW()) 
            ON CONFLICT (phone_number) 
            DO UPDATE SET name = EXCLUDED.name, last_message_at = $4, last_message = $5 
            RETURNING id, current_node_id
        `;
        const resDb = await client.query(upsertQuery, [crypto.randomUUID(), from, name, Date.now(), textBody]);
        const candidate = resDb.rows[0];
        const candidateId = candidate.id;
        
        logger.info("Candidate Upserted", { requestId, candidateId });

        // Insert Message
        const insertMsgQuery = `
            INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, whatsapp_message_id, created_at) 
            VALUES ($1, $2, 'in', $3, $4, 'received', $5, NOW()) 
            ON CONFLICT (whatsapp_message_id) DO NOTHING
        `;
        await client.query(insertMsgQuery, [crypto.randomUUID(), candidateId, textBody, message.type, message.id]);
        
        // --- BOT AUTO-REPLY LOGIC ---
        const settings = await getBotSettings(phoneId);
        if (settings && settings.nodes && settings.nodes.length > 0) {
             logger.info("Bot Logic Active", { requestId });
             
             // Simple Logic: If no current node, find start node and reply
             if (!candidate.current_node_id) {
                 const startNode = settings.nodes.find(n => n.type === 'start') || settings.nodes[0];
                 // Find edges coming OUT of start node
                 const edge = settings.edges?.find(e => e.source === startNode.id);
                 if (edge) {
                     const nextNode = settings.nodes.find(n => n.id === edge.target);
                     if (nextNode && nextNode.data && nextNode.data.content) {
                         // Send Reply
                         await sendToMeta(from, { type: 'text', text: { body: nextNode.data.content } });
                         
                         // Log Reply
                         await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`, 
                            [crypto.randomUUID(), candidateId, nextNode.data.content]);
                         
                         // Update State
                         await client.query(`UPDATE candidates SET current_node_id = $1 WHERE id = $2`, [nextNode.id, candidateId]);
                     }
                 }
             }
        }
        return { success: true };
    } finally { 
        client.release(); 
    }
};

// FAULT-TOLERANT QUEUE DISPATCHER
const enqueueIncomingMessageJob = async (req, message, contact, phoneId) => {
    const requestId = req.requestId;
    const baseUrl = getBaseUrl(req);
    const workerUrl = `${baseUrl}/api/internal/bot-worker`;

    // 1. Check Configuration
    if (!process.env.QSTASH_TOKEN || process.env.QSTASH_TOKEN === 'mock') {
        logger.warn("Queue Mock/Missing - Sync Fallback", { requestId });
        return processMessageInternal(message, contact, phoneId, requestId);
    }

    // 2. Try Async Publish
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
        // 3. Fallback on Failure (Critical for Data Integrity)
        return processMessageInternal(message, contact, phoneId, requestId);
    }
};

// --- ROUTE GROUPS ---

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
        next(error); // Pass to global handler
    }
});

// ==========================================
// 2. SYSTEM & DIAGNOSTICS
// ==========================================
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
    try {
        await ensureDbSchema();
        res.json({ success: true, message: "Schema verification complete" });
    } catch (e) { next(e); }
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

// ==========================================
// 3. DRIVERS & MESSAGES
// ==========================================
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
    } catch (e) {
        if (e.code === '42P01') { res.json([]); } 
        else { next(e); }
    } finally { client.release(); }
});

apiRouter.patch('/drivers/:id', async (req, res, next) => {
    const { status, tags, variables, name, notes, isHumanMode, humanModeEndsAt } = req.body;
    const client = await getDb().connect();
    try {
        const updates = [];
        const values = [];
        let idx = 1;

        if (status) { updates.push(`stage = $${idx++}`); values.push(status); }
        if (name) { updates.push(`name = $${idx++}`); values.push(name); }
        if (tags) { updates.push(`tags = $${idx++}`); values.push(tags); }
        if (variables) { updates.push(`variables = COALESCE(variables, '{}'::jsonb) || $${idx++}::jsonb`); values.push(JSON.stringify(variables)); }
        if (notes !== undefined) { updates.push(`notes = $${idx++}`); values.push(notes); }
        if (isHumanMode !== undefined) { updates.push(`is_human_mode = $${idx++}`); values.push(isHumanMode); }
        if (humanModeEndsAt !== undefined) { updates.push(`human_mode_ends_at = $${idx++}`); values.push(humanModeEndsAt); }

        if (updates.length > 0) {
            updates.push(`updated_at = NOW()`);
            values.push(req.params.id);
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
        res.json(resDb.rows.map(r => ({
            id: r.id, sender: r.direction === 'in' ? 'driver' : 'agent', text: r.text, timestamp: new Date(r.created_at).getTime(), type: r.type || 'text', status: r.status
        })).reverse());
    } catch (e) { res.json([]); } finally { client.release(); }
});

apiRouter.post('/drivers/:id/messages', async (req, res, next) => {
    const { text, mediaUrl, mediaType } = req.body;
    const client = await getDb().connect();
    try {
        const dRes = await client.query('SELECT phone_number FROM candidates WHERE id = $1', [req.params.id]);
        if (dRes.rows.length === 0) return res.status(404).json({ ok: false, error: "Driver not found" });
        
        const payload = mediaUrl 
            ? { type: mediaType || 'image', [mediaType || 'image']: { link: mediaUrl, caption: text } }
            : { type: 'text', text: { body: text } };
        
        await sendToMeta(dRes.rows[0].phone_number, payload);
        
        await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`, [crypto.randomUUID(), req.params.id, text]);
        await client.query('UPDATE candidates SET last_message_at = $1, last_message = $2 WHERE id = $3', [Date.now(), text || '[Media]', req.params.id]);
        res.json({ success: true });
    } catch(e) { next(e); } finally { client.release(); }
});

// Alias for generic send (requested by user spec)
apiRouter.post('/messages/send', async (req, res, next) => {
    // Expects { driverId: '...', text: '...' }
    const { driverId, text, mediaUrl, mediaType } = req.body;
    if (!driverId) return res.status(400).json({ ok: false, error: 'driverId required' });
    req.params.id = driverId;
    // Route to the existing handler logic
    return apiRouter.handle({ ...req, url: `/drivers/${driverId}/messages`, method: 'POST' }, res, next);
});

apiRouter.get('/drivers/:id/documents', async (req, res) => { res.json([]); });

// Scheduled Messages
apiRouter.get('/drivers/:id/scheduled-messages', async (req, res, next) => {
    const client = await getDb().connect();
    try {
        const result = await client.query(`SELECT * FROM scheduled_messages WHERE candidate_id = $1 ORDER BY scheduled_time ASC`, [req.params.id]);
        res.json(result.rows.map(r => ({
            id: r.id,
            scheduledTime: parseInt(r.scheduled_time),
            payload: r.payload,
            status: r.status
        })));
    } catch (e) { next(e); } finally { client.release(); }
});

apiRouter.post('/scheduled-messages', async (req, res, next) => {
    const { driverIds, message, timestamp } = req.body;
    const client = await getDb().connect();
    try {
        for (const driverId of driverIds) {
             await client.query(`INSERT INTO scheduled_messages (id, candidate_id, payload, scheduled_time, status) VALUES ($1, $2, $3, $4, 'pending')`, 
                [crypto.randomUUID(), driverId, JSON.stringify(message), timestamp || Date.now()]);
        }
        res.json({ success: true, count: driverIds.length });
    } catch (e) { next(e); } finally { client.release(); }
});

apiRouter.delete('/scheduled-messages/:id', async (req, res, next) => {
    const client = await getDb().connect();
    try {
        await client.query('DELETE FROM scheduled_messages WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) { next(e); } finally { client.release(); }
});

apiRouter.patch('/scheduled-messages/:id', async (req, res, next) => {
    const { text, scheduledTime } = req.body;
    const client = await getDb().connect();
    try {
        const old = await client.query('SELECT payload FROM scheduled_messages WHERE id = $1', [req.params.id]);
        if (old.rows.length === 0) return res.status(404).json({ ok: false, error: "Not found" });
        
        const newPayload = { ...old.rows[0].payload, text: text || old.rows[0].payload.text };
        const updates = [`payload = $1`];
        const values = [JSON.stringify(newPayload)];
        let idx = 2;
        
        if (scheduledTime) {
            updates.push(`scheduled_time = $${idx++}`);
            values.push(scheduledTime);
        }
        
        values.push(req.params.id);
        await client.query(`UPDATE scheduled_messages SET ${updates.join(', ')} WHERE id = $${idx}`, values);
        res.json({ success: true });
    } catch (e) { next(e); } finally { client.release(); }
});

// ==========================================
// 4. BOT SETTINGS
// ==========================================

apiRouter.get('/bot/settings', async (req, res, next) => { 
    const client = await getDb().connect();
    try {
        const phoneId = process.env.PHONE_NUMBER_ID;
        let result = await client.query(
            `SELECT settings FROM bot_versions WHERE phone_number_id = $1 AND status = 'draft' LIMIT 1`,
            [phoneId]
        );
        if (result.rows.length === 0) {
            result = await client.query(
                `SELECT settings FROM bot_versions WHERE phone_number_id = $1 AND status = 'published' ORDER BY version_number DESC LIMIT 1`,
                [phoneId]
            );
        }
        res.json(result.rows[0]?.settings || { nodes: [], edges: [], steps: [] });
    } catch(e) { next(e); } finally { client.release(); }
});

apiRouter.get('/bot-settings', (req, res) => res.redirect('/api/bot/settings'));

apiRouter.post('/bot/save', async (req, res, next) => { 
    const client = await getDb().connect();
    try {
        const phoneId = process.env.PHONE_NUMBER_ID;
        const settings = JSON.stringify(req.body);

        const checkDraft = await client.query(
            `SELECT id FROM bot_versions WHERE phone_number_id = $1 AND status = 'draft'`,
            [phoneId]
        );

        if (checkDraft.rows.length > 0) {
            await client.query(`UPDATE bot_versions SET settings = $1 WHERE id = $2`, [settings, checkDraft.rows[0].id]);
        } else {
            await client.query(`INSERT INTO bot_versions (phone_number_id, version_number, status, settings) VALUES ($1, 1, 'draft', $2)`, [phoneId, settings]);
        }
        res.json({ success: true });
    } catch(e) { next(e); } finally { client.release(); }
});

apiRouter.post('/bot/publish', async (req, res, next) => { 
    const client = await getDb().connect();
    try {
        const phoneId = process.env.PHONE_NUMBER_ID;
        const draftRes = await client.query(`SELECT settings FROM bot_versions WHERE phone_number_id = $1 AND status = 'draft' LIMIT 1`, [phoneId]);

        if (draftRes.rows.length === 0) return res.status(400).json({ ok: false, error: "No draft changes to publish." });

        const settings = draftRes.rows[0].settings;
        const verRes = await client.query(`SELECT MAX(version_number) as v FROM bot_versions WHERE phone_number_id = $1 AND status = 'published'`, [phoneId]);
        const nextVer = (verRes.rows[0].v || 0) + 1;

        await client.query(`INSERT INTO bot_versions (phone_number_id, version_number, status, settings) VALUES ($1, $2, 'published', $3)`, [phoneId, nextVer, settings]);
        await redis.del(`bot:settings:${phoneId}`); 
        
        res.json({ success: true, version: nextVer }); 
    } catch(e) { next(e); } finally { client.release(); }
});

// ==========================================
// 5. MEDIA & SHOWCASE (S3)
// ==========================================
apiRouter.get('/media', async (req, res, next) => {
    const prefix = req.query.path && req.query.path !== '/' ? req.query.path.replace(/^\//, '') + '/' : '';
    try {
        const command = new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: prefix, Delimiter: '/' });
        const response = await s3Client.send(command);
        
        const publicFolders = await redis.smembers('system:public_folders');

        const folders = (response.CommonPrefixes || []).map(p => {
            const name = p.Prefix.replace(prefix, '').replace('/', '');
            const fullPath = p.Prefix.slice(0, -1);
            return {
                id: fullPath,
                name: name,
                parent_path: prefix,
                is_public_showcase: publicFolders.includes(fullPath)
            };
        });

        const files = (response.Contents || []).map(c => {
            if (c.Key === prefix) return null;
            const ext = c.Key.split('.').pop().toLowerCase();
            let type = 'document';
            if (['jpg','jpeg','png','gif'].includes(ext)) type = 'image';
            if (['mp4','mov'].includes(ext)) type = 'video';
            return {
                id: c.Key,
                filename: c.Key.replace(prefix, ''),
                url: `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${c.Key}`,
                type
            };
        }).filter(Boolean);

        res.json({ folders, files });
    } catch (e) { next(e); }
});

apiRouter.post('/media/upload', upload.single('file'), async (req, res, next) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file' });
    const path = req.body.path && req.body.path !== '/' ? req.body.path.replace(/^\//, '') + '/' : '';
    try {
        await s3Client.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: `${path}${req.file.originalname}`,
            Body: req.file.buffer,
            ContentType: req.file.mimetype,
            ACL: 'public-read' 
        }));
        res.json({ success: true });
    } catch (e) { next(e); }
});

apiRouter.post('/media/folders', async (req, res, next) => {
    const { name, parentPath } = req.body;
    const path = parentPath && parentPath !== '/' ? parentPath.replace(/^\//, '') + '/' : '';
    try {
        await s3Client.send(new PutObjectCommand({ Bucket: BUCKET_NAME, Key: `${path}${name}/`, Body: '' }));
        res.json({ success: true });
    } catch(e) { next(e); }
});

apiRouter.delete('/media/files/:id', async (req, res, next) => {
    try { await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: req.params.id })); res.json({ success: true }); }
    catch(e) { next(e); }
});

apiRouter.delete('/media/folders/:id', async (req, res, next) => {
    try { await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: req.params.id + '/' })); res.json({ success: true }); }
    catch(e) { next(e); }
});

apiRouter.post('/media/folders/:id/public', async (req, res) => {
    await redis.sadd('system:public_folders', req.params.id);
    await redis.set('system:active_showcase', req.params.id);
    res.json({ success: true });
});

apiRouter.delete('/media/folders/:id/public', async (req, res) => {
    await redis.srem('system:public_folders', req.params.id);
    res.json({ success: true });
});

apiRouter.get('/showcase/status', async (req, res) => {
    const active = await redis.get('system:active_showcase');
    if (!active) return res.json({ active: false });
    res.json({ active: true, folderId: active, folderName: active.split('/').pop() });
});

apiRouter.get('/showcase/:folderName?', async (req, res, next) => {
    let folderName = req.params.folderName;
    if (!folderName) {
        const active = await redis.get('system:active_showcase');
        if (active) folderName = active;
        else return res.json({ items: [], title: 'No Showcase Active' });
    }
    const prefix = folderName.endsWith('/') ? folderName : `${folderName}/`;
    try {
        const command = new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: prefix });
        const response = await s3Client.send(command);
        const items = (response.Contents || []).map(c => {
             if (c.Key === prefix) return null;
             const ext = c.Key.split('.').pop().toLowerCase();
             let type = 'image';
             if (['mp4','mov'].includes(ext)) type = 'video';
             if (['pdf','doc'].includes(ext)) type = 'document';
             return {
                 id: c.Key,
                 url: `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${c.Key}`,
                 type,
                 filename: c.Key.replace(prefix, '')
             };
        }).filter(Boolean);
        res.json({ title: folderName.replace(/\/$/, ''), items });
    } catch(e) { next(e); }
});

apiRouter.post('/media/sync-s3', async (req, res) => { res.json({ success: true, added: 0 }); });

// ==========================================
// 6. AI & GEMINI
// ==========================================
apiRouter.post('/ai/generate', async (req, res, next) => {
    if (!genAI) return res.status(503).json({ ok: false, error: "AI Not Configured" });
    try {
        const { model, contents, config } = req.body;
        const aiModel = genAI.getGenerativeModel({ model: model || 'gemini-1.5-flash' });
        const result = await aiModel.generateContent({
            contents: [{ role: 'user', parts: [{ text: contents }] }],
            generationConfig: config
        });
        const response = await result.response;
        res.json({ text: response.text() });
    } catch(e) { next(e); }
});

apiRouter.post('/ai/assistant', async (req, res, next) => {
    if (!genAI) return res.status(503).json({ ok: false, error: "AI Not Configured" });
    try {
        const { input, history } = req.body;
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const chat = model.startChat({
            history: history.map(h => ({ role: h.role, parts: h.parts })),
            generationConfig: { maxOutputTokens: 100 }
        });
        const result = await chat.sendMessage(input);
        res.json({ text: result.response.text() });
    } catch(e) { next(e); }
});

// ==========================================
// 7. WEBHOOK (With Robust QStash Resolution & Fallback)
// ==========================================
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) res.send(req.query['hub.challenge']);
    else res.sendStatus(403);
});

app.post('/webhook', async (req, res, next) => {
    try {
        const body = req.body;
        if (body.object !== 'whatsapp_business_account') return res.sendStatus(404);
        
        const entries = body.entry || [];
        for (const entry of entries) {
            for (const change of (entry.changes || [])) {
                const value = change.value;
                if (!value.messages) continue;
                const phoneId = value.metadata?.phone_number_id;
                for (const message of value.messages) {
                    await enqueueIncomingMessageJob(req, message, value.contacts?.[0], phoneId);
                }
            }
        }
        res.sendStatus(200);
    } catch (e) { next(e); }
});

// ==========================================
// 8. WORKER (Queue Handler)
// ==========================================
apiRouter.post('/internal/bot-worker', async (req, res, next) => {
    const signature = req.headers["upstash-signature"];
    const secretHeader = req.headers["x-internal-secret"];
    const expectedSecret = process.env.INTERNAL_WORKER_SECRET;

    let isAuthorized = false;

    if (expectedSecret && secretHeader === expectedSecret) {
        isAuthorized = true;
    } 
    else if (signature && process.env.QSTASH_CURRENT_SIGNING_KEY) {
        try {
            const body = req.rawBody ? req.rawBody.toString() : JSON.stringify(req.body);
            isAuthorized = await qstashReceiver.verify({ signature, body });
        } catch (e) {
            logger.warn("Worker Signature Verification Failed", { error: e.message });
        }
    } 
    else if (!process.env.QSTASH_CURRENT_SIGNING_KEY || process.env.QSTASH_CURRENT_SIGNING_KEY === 'mock') {
        isAuthorized = true;
    }

    if (!isAuthorized) {
        logger.warn("Unauthorized Worker Access");
        return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    try {
        const { message, contact, phoneId } = req.body;
        await processMessageInternal(message, contact, phoneId, req.headers['x-request-id']);
        res.json({ success: true });
    } catch(e) { next(e); }
});

// --- GLOBAL ERROR HANDLER ---
app.use((err, req, res, next) => {
    logger.error("Unhandled API Error", { requestId: req.requestId, error: err.message, stack: err.stack, url: req.url });
    if (!res.headersSent) {
        res.status(err.status || 500).json({ ok: false, error: err.message || "Internal Server Error" });
    }
});

// --- MOUNT ---
app.use('/api', apiRouter);
app.use('/', apiRouter);

// --- STARTUP SCHEMA CHECK ---
ensureDbSchema().then(() => {
    logger.info("Startup DB Check Complete");
}).catch(e => logger.error("Startup DB Check Failed", { error: e.message }));

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => logger.info(`🚀 Uber Fleet Bot running on port ${PORT}`));
}

module.exports = app;

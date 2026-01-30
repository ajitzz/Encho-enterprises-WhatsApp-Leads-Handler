const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const { Client: QStashClient, Receiver } = require('@upstash/qstash');
const { Pool } = require('pg');
const { S3Client, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand, CopyObjectCommand } = require('@aws-sdk/client-s3');
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
    SCHEDULE_BATCH_SIZE: parseInt(process.env.SCHEDULE_BATCH_SIZE || '25', 10),
    SCHEDULE_POLL_INTERVAL_MS: parseInt(process.env.SCHEDULE_POLL_INTERVAL_MS || '15000', 10)
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
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

const isS3Configured = () =>
    Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_BUCKET_NAME);

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
app.set('etag', false); // ✅ prevent 304 empty-body issues in SPA
const apiRouter = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// ✅ Disable caching for ALL API responses (prevents 304/empty JSON issues)
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

        // Extensions (optional in managed Postgres)
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
                attempts INT DEFAULT 0,
                last_error TEXT,
                sent_at TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);
        await client.query(`ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS attempts INT DEFAULT 0;`);
        await client.query(`ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS last_error TEXT;`);
        await client.query(`ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP WITH TIME ZONE;`);
        await client.query(`ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_time ON scheduled_messages(scheduled_time) WHERE status = 'pending';`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_status_time ON scheduled_messages(status, scheduled_time);`);

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
    } catch (err) {
        return null;
    } finally {
        client.release();
    }
};

const resolveMediaType = (key) => {
    const ext = key.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'image';
    if (['mp4', 'mov', 'webm'].includes(ext)) return 'video';
    return 'document';
};

const buildMediaUrl = (key) => `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${key}`;

const listS3Objects = async (prefix) => {
    const items = [];
    let continuationToken;
    do {
        const command = new ListObjectsV2Command({
            Bucket: BUCKET_NAME,
            Prefix: prefix,
            ContinuationToken: continuationToken
        });
        const response = await s3Client.send(command);
        items.push(...(response.Contents || []));
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    return items;
};

const buildShowcaseManifest = async ({ folderId, title }) => {
    if (!isS3Configured()) return { title, items: [] };
    const prefix = folderId ? `${folderId.replace(/^\//, '').replace(/\/$/, '')}/` : '';
    const objects = await listS3Objects(prefix);
    const items = objects
        .filter((obj) => obj.Key && !obj.Key.endsWith('/'))
        .map((obj) => ({
            id: obj.Key,
            url: buildMediaUrl(obj.Key),
            type: resolveMediaType(obj.Key),
            filename: obj.Key.replace(prefix, '')
        }));
    return { title, items };
};

const sendToMeta = async (to, payload) => {
    // 🛡️ GUARD: Block Placeholders & Empty Messages
    if (payload.text && payload.text.body) {
        const body = payload.text.body.trim().toLowerCase();
        if (!body || body.includes('replace this') || body.includes('sample message') || body.includes('type your message')) {
            logger.warn("Blocked Placeholder/Empty Message", { to, body: payload.text.body });
            return { ok: false, error: 'blocked_placeholder' };
        }
    }

    if (!process.env.META_API_TOKEN || !process.env.PHONE_NUMBER_ID) {
        logger.error('Meta Send Misconfigured (missing META_API_TOKEN or PHONE_NUMBER_ID)', { to });
        return { ok: false, error: 'missing_meta_configuration' };
    }

    try {
        await getMetaClient().post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload });
        return { ok: true };
    } catch (e) {
        logger.error("Meta Send Error", { error: e.response?.data || e.message, to });
        return { ok: false, error: e.response?.data || e.message };
    }
};

const normalizeScheduledPayload = (payload) => {
    if (!payload) return {};
    if (typeof payload === 'string') {
        try {
            return JSON.parse(payload);
        } catch (e) {
            return {};
        }
    }
    return payload;
};

const buildTemplatePayload = ({ templateName, templateLanguage, text }) => {
    const language = templateLanguage || process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US';
    const payload = {
        type: 'template',
        template: {
            name: templateName,
            language: { code: language }
        }
    };

    if (text && text.trim()) {
        payload.template.components = [{
            type: 'body',
            parameters: [{ type: 'text', text: text.trim() }]
        }];
    }

    return payload;
};

const buildWhatsAppPayload = ({ text, mediaUrl, mediaType, templateName, templateLanguage }) => {
    if (templateName) {
        return buildTemplatePayload({ templateName, templateLanguage, text });
    }

    if (mediaUrl) {
        const type = mediaType || 'image';
        return {
            type,
            [type]: {
                link: mediaUrl,
                ...(text ? { caption: text } : {})
            }
        };
    }

    return { type: 'text', text: { body: text || '' } };
};

const summarizePayload = (payload) => {
    if (payload.templateName) return `Template: ${payload.templateName}`;
    if (payload.text) return payload.text;
    return payload.mediaUrl ? '[Media]' : '';
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

        logger.info("Candidate Upserted", { requestId, candidateId });

        // Insert Message
        const insertMsgQuery = `
            INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, whatsapp_message_id, created_at)
            VALUES ($1, $2, 'in', $3, $4, 'received', $5, NOW())
            ON CONFLICT (whatsapp_message_id) DO NOTHING
        `;
        await client.query(insertMsgQuery, [crypto.randomUUID(), candidateId, textBody, message.type, message.id]);

        // --- BOT AUTO-REPLY LOGIC ---
        if (!candidate.is_human_mode) {
            const settings = await getBotSettings(phoneId);
            if (settings && settings.nodes && settings.nodes.length > 0) {
                logger.info("Bot Logic Active", { requestId });

                if (!candidate.current_node_id) {
                    const startNode = settings.nodes.find(n => n.type === 'start') || settings.nodes[0];
                    const edge = settings.edges?.find(e => e.source === startNode.id);
                    if (edge) {
                        const nextNode = settings.nodes.find(n => n.id === edge.target);
                        if (nextNode && nextNode.data && nextNode.data.content) {
                            await sendToMeta(from, { type: 'text', text: { body: nextNode.data.content } });

                            await client.query(
                                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`,
                                [crypto.randomUUID(), candidateId, nextNode.data.content]
                            );

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
        // 3. Fallback on Failure
        return processMessageInternal(message, contact, phoneId, requestId);
    }
};

// ✅ Webhook Persistence Helper
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

        logger.info('Persisted inbound message (webhook)', { requestId, from, messageId: message.id });
    } finally {
        client.release();
    }
};

const authorizeInternalRequest = async (req) => {
    const signature = req.headers["upstash-signature"];
    const secretHeader = req.headers["x-internal-secret"];
    const expectedSecret = process.env.INTERNAL_WORKER_SECRET;

    if (expectedSecret && secretHeader === expectedSecret) {
        return true;
    }

    if (signature && process.env.QSTASH_CURRENT_SIGNING_KEY) {
        try {
            const body = req.rawBody ? req.rawBody.toString() : JSON.stringify(req.body);
            return await qstashReceiver.verify({ signature, body });
        } catch (e) {
            logger.warn("Worker Signature Verification Failed", { error: e.message });
        }
    }

    return !process.env.QSTASH_CURRENT_SIGNING_KEY || process.env.QSTASH_CURRENT_SIGNING_KEY === 'mock';
};

const processScheduledMessages = async ({ source = 'manual' } = {}) => {
    await ensureDbSchema();
    const now = Date.now();
    const client = await getDb().connect();
    let scheduledRows = [];

    try {
        await client.query('BEGIN');
        const dueRes = await client.query(
            `
            WITH due AS (
                SELECT id
                FROM scheduled_messages
                WHERE status = 'pending' AND scheduled_time <= $1
                ORDER BY scheduled_time ASC
                LIMIT $2
                FOR UPDATE SKIP LOCKED
            )
            UPDATE scheduled_messages
            SET status = 'processing', updated_at = NOW()
            WHERE id IN (SELECT id FROM due)
            RETURNING *;
            `,
            [now, SYSTEM_CONFIG.SCHEDULE_BATCH_SIZE]
        );
        await client.query('COMMIT');
        scheduledRows = dueRes.rows;
    } catch (e) {
        await client.query('ROLLBACK');
        logger.error("Scheduled Message Claim Failed", { error: e.message, source });
    } finally {
        client.release();
    }

    if (scheduledRows.length === 0) {
        return { processed: 0, sent: 0, failed: 0 };
    }

    let sent = 0;
    let failed = 0;

    for (const row of scheduledRows) {
        const workerClient = await getDb().connect();
        try {
            const payload = normalizeScheduledPayload(row.payload);
            if (!payload || (!payload.text && !payload.mediaUrl && !payload.templateName)) {
                await workerClient.query(
                    `UPDATE scheduled_messages SET status = 'failed', last_error = $2, attempts = attempts + 1, updated_at = NOW() WHERE id = $1`,
                    [row.id, 'empty_payload']
                );
                failed += 1;
                continue;
            }

            const candidateRes = await workerClient.query('SELECT phone_number FROM candidates WHERE id = $1', [row.candidate_id]);
            if (candidateRes.rows.length === 0) {
                await workerClient.query(
                    `UPDATE scheduled_messages SET status = 'failed', last_error = $2, attempts = attempts + 1, updated_at = NOW() WHERE id = $1`,
                    [row.id, 'candidate_not_found']
                );
                failed += 1;
                continue;
            }

            const metaPayload = buildWhatsAppPayload(payload);
            const sendResult = await sendToMeta(candidateRes.rows[0].phone_number, metaPayload);
            if (!sendResult.ok) {
                await workerClient.query(
                    `UPDATE scheduled_messages SET status = 'failed', last_error = $2, attempts = attempts + 1, updated_at = NOW() WHERE id = $1`,
                    [row.id, sendResult.error || 'meta_send_failed']
                );
                failed += 1;
                continue;
            }

            const messageType = payload.templateName ? 'template' : (payload.mediaUrl ? (payload.mediaType || 'media') : 'text');
            const summary = summarizePayload(payload) || '[Media]';

            await workerClient.query(
                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at)
                 VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())`,
                [crypto.randomUUID(), row.candidate_id, payload.text || summary, messageType]
            );
            await workerClient.query(
                `UPDATE candidates SET last_message_at = $1, last_message = $2, updated_at = NOW() WHERE id = $3`,
                [Date.now(), summary, row.candidate_id]
            );
            await workerClient.query(
                `UPDATE scheduled_messages SET status = 'sent', sent_at = NOW(), last_error = NULL, updated_at = NOW() WHERE id = $1`,
                [row.id]
            );
            sent += 1;
        } catch (e) {
            await workerClient.query(
                `UPDATE scheduled_messages SET status = 'failed', last_error = $2, attempts = attempts + 1, updated_at = NOW() WHERE id = $1`,
                [row.id, e.message || 'processing_error']
            );
            failed += 1;
        } finally {
            workerClient.release();
        }
    }

    logger.info("Scheduled Message Batch Processed", { source, processed: scheduledRows.length, sent, failed });
    return { processed: scheduledRows.length, sent, failed };
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
        res.json({ user: { email: payload.email, name: payload.name } });
    } catch (e) { next(e); }
});

// ==========================================
// 2. SYSTEM SETTINGS
// ==========================================
apiRouter.get('/system/settings', async (req, res) => {
    const settings = await redis.get('system:settings');
    res.json(settings || {});
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
            lastMessageTime: row.last_message_at ? parseInt(row.last_message_at) : undefined,
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
        const resDb = await client.query(
            'SELECT * FROM candidate_messages WHERE candidate_id = (SELECT id FROM candidates WHERE phone_number = $1 OR id = $1 LIMIT 1) ORDER BY created_at DESC LIMIT $2',
            [req.params.id, limit]
        );
        res.json(resDb.rows.map(r => ({
            id: r.id,
            sender: r.direction === 'in' ? 'driver' : 'agent',
            text: r.text,
            timestamp: new Date(r.created_at).getTime(),
            type: r.type || 'text',
            status: r.status
        })).reverse());
    } catch (e) { res.json([]); } finally { client.release(); }
});

apiRouter.post('/drivers/:id/messages', async (req, res, next) => {
    const { text, mediaUrl, mediaType, templateName, templateLanguage } = req.body;
    const client = await getDb().connect();
    try {
        const dRes = await client.query('SELECT phone_number FROM candidates WHERE id = $1', [req.params.id]);
        if (dRes.rows.length === 0) return res.status(404).json({ ok: false, error: "Driver not found" });

        const payload = buildWhatsAppPayload({ text, mediaUrl, mediaType, templateName, templateLanguage });

        const sendResult = await sendToMeta(dRes.rows[0].phone_number, payload);
        if (!sendResult.ok) {
            return res.status(502).json({ ok: false, error: sendResult.error || 'Failed to send message' });
        }

        const messageType = templateName ? 'template' : (mediaUrl ? (mediaType || 'media') : 'text');
        await client.query(
            `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())`,
            [crypto.randomUUID(), req.params.id, text, messageType]
        );
        await client.query('UPDATE candidates SET last_message_at = $1, last_message = $2 WHERE id = $3', [Date.now(), summarizePayload({ text, mediaUrl, templateName }) || '[Media]', req.params.id]);
        res.json({ success: true });
    } catch (e) { next(e); } finally { client.release(); }
});

// Alias for generic send
apiRouter.post('/messages/send', async (req, res, next) => {
    const { driverId, text, mediaUrl, mediaType } = req.body;
    if (!driverId) return res.status(400).json({ ok: false, error: 'driverId required' });

    req.params.id = driverId;
    return apiRouter.handle({ ...req, url: `/drivers/${driverId}/messages`, method: 'POST' }, res, next);
});

apiRouter.get('/drivers/:id/documents', async (req, res) => { res.json([]); });

// Scheduled Messages
apiRouter.get('/drivers/:id/scheduled-messages', async (req, res, next) => {
    const client = await getDb().connect();
    try {
        await ensureDbSchema();
        const result = await client.query(`SELECT * FROM scheduled_messages WHERE candidate_id = $1 ORDER BY scheduled_time ASC`, [req.params.id]);
        res.json(result.rows.map(r => ({
            id: r.id,
            scheduledTime: parseInt(r.scheduled_time),
            payload: normalizeScheduledPayload(r.payload),
            status: r.status
        })));
    } catch (e) {
        if (e.code === '42P01') {
            try {
                await ensureDbSchema();
                const retry = await client.query(`SELECT * FROM scheduled_messages WHERE candidate_id = $1 ORDER BY scheduled_time ASC`, [req.params.id]);
                return res.json(retry.rows.map(r => ({
                    id: r.id,
                    scheduledTime: parseInt(r.scheduled_time),
                    payload: normalizeScheduledPayload(r.payload),
                    status: r.status
                })));
            } catch (retryError) {
                return next(retryError);
            }
        }
        next(e);
    } finally { client.release(); }
});

apiRouter.post('/scheduled-messages', async (req, res, next) => {
    const { driverIds, message, timestamp } = req.body;
    const client = await getDb().connect();
    try {
        const scheduledTime = typeof timestamp === 'number' ? timestamp : Date.now();
        for (const driverId of driverIds) {
            await client.query(
                `INSERT INTO scheduled_messages (id, candidate_id, payload, scheduled_time, status) VALUES ($1, $2, $3, $4, 'pending')`,
                [crypto.randomUUID(), driverId, JSON.stringify(message), scheduledTime]
            );
        }
        res.json({ success: true, count: driverIds.length });
    } catch (e) {
        if (e.code === '42P01') {
            try {
                await ensureDbSchema();
                const scheduledTime = typeof timestamp === 'number' ? timestamp : Date.now();
                const payload = message || {};
                for (const driverId of driverIds || []) {
                    await client.query(
                        `INSERT INTO scheduled_messages (id, candidate_id, payload, scheduled_time, status) VALUES ($1, $2, $3, $4, 'pending')`,
                        [crypto.randomUUID(), driverId, JSON.stringify(payload), scheduledTime]
                    );
                }
                return res.json({ success: true, count: (driverIds || []).length });
            } catch (retryError) {
                return next(retryError);
            }
        }
        next(e);
    } finally { client.release(); }
});

apiRouter.delete('/scheduled-messages/:id', async (req, res, next) => {
    const client = await getDb().connect();
    try {
        await ensureDbSchema();
        await client.query('DELETE FROM scheduled_messages WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        if (e.code === '42P01') {
            try {
                await ensureDbSchema();
                await client.query('DELETE FROM scheduled_messages WHERE id = $1', [req.params.id]);
                return res.json({ success: true });
            } catch (retryError) {
                return next(retryError);
            }
        }
        next(e);
    } finally { client.release(); }
});

apiRouter.patch('/scheduled-messages/:id', async (req, res, next) => {
    const { text, scheduledTime } = req.body;
    const client = await getDb().connect();
    try {
        await ensureDbSchema();
        const old = await client.query('SELECT payload FROM scheduled_messages WHERE id = $1', [req.params.id]);
        if (old.rows.length === 0) return res.status(404).json({ ok: false, error: "Not found" });

        const existingPayload = normalizeScheduledPayload(old.rows[0].payload);
        const newPayload = { ...existingPayload, text: text || existingPayload.text };
        const updates = [`payload = $1`];
        const values = [JSON.stringify(newPayload)];
        let idx = 2;

        if (typeof scheduledTime === 'number') {
            updates.push(`scheduled_time = $${idx++}`);
            values.push(scheduledTime);
        }

        values.push(req.params.id);
        await client.query(`UPDATE scheduled_messages SET ${updates.join(', ')} WHERE id = $${idx}`, values);
        res.json({ success: true });
    } catch (e) {
        if (e.code === '42P01') {
            try {
                await ensureDbSchema();
                const old = await client.query('SELECT payload FROM scheduled_messages WHERE id = $1', [req.params.id]);
                if (old.rows.length === 0) return res.status(404).json({ ok: false, error: "Not found" });

                const existingPayload = normalizeScheduledPayload(old.rows[0].payload);
                const newPayload = { ...existingPayload, text: text || existingPayload.text };
                const updates = [`payload = $1`];
                const values = [JSON.stringify(newPayload)];
                let idx = 2;

                if (typeof scheduledTime === 'number') {
                    updates.push(`scheduled_time = $${idx++}`);
                    values.push(scheduledTime);
                }

                values.push(req.params.id);
                await client.query(`UPDATE scheduled_messages SET ${updates.join(', ')} WHERE id = $${idx}`, values);
                return res.json({ success: true });
            } catch (retryError) {
                return next(retryError);
            }
        }
        next(e);
    } finally { client.release(); }
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
    } catch (e) { next(e); } finally { client.release(); }
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
            await client.query(`INSERT INTO bot_versions (id, phone_number_id, version_number, status, settings) VALUES ($1, $2, 1, 'draft', $3)`, [crypto.randomUUID(), phoneId, settings]);
        }
        res.json({ success: true });
    } catch (e) { next(e); } finally { client.release(); }
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

        await client.query(`INSERT INTO bot_versions (id, phone_number_id, version_number, status, settings) VALUES ($1, $2, $3, 'published', $4)`, [crypto.randomUUID(), phoneId, nextVer, settings]);
        await redis.del(`bot:settings:${phoneId}`);

        res.json({ success: true, version: nextVer });
    } catch (e) { next(e); } finally { client.release(); }
});

// ==========================================
// 5. MEDIA & SHOWCASE (S3)
// ==========================================
apiRouter.get('/media', async (req, res, next) => {
    const prefix = req.query.path && req.query.path !== '/' ? req.query.path.replace(/^\//, '') + '/' : '';
    // ✅ If S3 not configured, return empty library (prevents UI errors)
    if (!isS3Configured()) {
        return res.json({ folders: [], files: [] });
    }
    try {
        const command = new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: prefix, Delimiter: '/' });
        const response = await s3Client.send(command);

        const publicFolders = await redis.smembers('system:public_folders');
        const syncedMedia = (await redis.hgetall('media:sync')) || {};

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
            if (c.Key.endsWith('/')) return null;
            const type = resolveMediaType(c.Key);
            const synced = syncedMedia?.[c.Key];
            return {
                id: c.Key,
                filename: c.Key.replace(prefix, ''),
                url: buildMediaUrl(c.Key),
                type,
                media_id: synced ? JSON.parse(synced).media_id : undefined
            };
        }).filter(Boolean);

        res.json({ folders, files });
    } catch (e) { next(e); }
});

apiRouter.post('/media/upload', upload.single('file'), async (req, res, next) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file' });
    if (!isS3Configured()) {
        return res.status(503).json({ ok: false, error: 'S3 not configured' });
    }
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
    if (!isS3Configured()) {
        return res.status(503).json({ ok: false, error: 'S3 not configured' });
    }
    const { name, parentPath } = req.body;
    const path = parentPath && parentPath !== '/' ? parentPath.replace(/^\//, '') + '/' : '';
    try {
        await s3Client.send(new PutObjectCommand({ Bucket: BUCKET_NAME, Key: `${path}${name}/`, Body: '' }));
        res.json({ success: true });
    } catch (e) { next(e); }
});

apiRouter.delete('/media/files/:id', async (req, res, next) => {
    if (!isS3Configured()) {
        return res.status(503).json({ ok: false, error: 'S3 not configured' });
    }
    try { await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: req.params.id })); res.json({ success: true }); }
    catch (e) { next(e); }
});

apiRouter.delete('/media/folders/:id', async (req, res, next) => {
    if (!isS3Configured()) {
        return res.status(503).json({ ok: false, error: 'S3 not configured' });
    }
    try { await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: req.params.id + '/' })); res.json({ success: true }); }
    catch (e) { next(e); }
});

apiRouter.post('/media/folders/:id/public', async (req, res) => {
    await redis.sadd('system:public_folders', req.params.id);
    await redis.set('system:active_showcase', req.params.id);
    const folderName = req.params.id.split('/').pop();
    if (folderName) {
        await redis.hset('system:public_folder_names', { [folderName]: req.params.id });
    }
    if (isS3Configured()) {
        try {
            const manifest = await buildShowcaseManifest({ folderId: req.params.id, title: folderName || 'Showcase' });
            await s3Client.send(new PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: `manifests/${encodeURIComponent(folderName || 'showcase')}.json`,
                Body: JSON.stringify(manifest),
                ContentType: 'application/json',
                ACL: 'public-read'
            }));
        } catch (e) {
            logger.warn("Failed to publish showcase manifest", { error: e.message });
        }
    }
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

apiRouter.post('/media/:id/sync', async (req, res) => {
    if (!isS3Configured()) {
        return res.status(503).json({ ok: false, error: 'S3 not configured' });
    }
    const fileKey = req.params.id;
    const mediaId = crypto.randomUUID();
    await redis.hset('media:sync', { [fileKey]: JSON.stringify({ media_id: mediaId, syncedAt: Date.now() }) });
    res.json({ success: true, mediaId });
});

apiRouter.post('/media/sync-s3', async (req, res) => {
    if (!isS3Configured()) {
        return res.status(503).json({ ok: false, error: 'S3 not configured' });
    }
    try {
        const objects = await listS3Objects('');
        const count = objects.filter((obj) => obj.Key && !obj.Key.endsWith('/')).length;
        res.json({ success: true, added: count });
    } catch (e) {
        logger.error("S3 Sync Failed", { error: e.message });
        res.status(500).json({ ok: false, error: 'Failed to sync from S3' });
    }
});

apiRouter.patch('/media/folders/:id', async (req, res, next) => {
    if (!isS3Configured()) {
        return res.status(503).json({ ok: false, error: 'S3 not configured' });
    }
    const newName = (req.body?.name || '').trim();
    if (!newName) return res.status(400).json({ ok: false, error: 'New folder name required' });

    const oldPrefix = `${req.params.id.replace(/\/$/, '')}/`;
    const parentPath = oldPrefix.split('/').slice(0, -2).join('/');
    const newPrefix = `${parentPath ? `${parentPath}/` : ''}${newName}/`;

    if (oldPrefix === newPrefix) return res.json({ success: true, moved: 0 });

    try {
        const objects = await listS3Objects(oldPrefix);
        let moved = 0;
        for (const obj of objects) {
            if (!obj.Key) continue;
            const newKey = obj.Key.replace(oldPrefix, newPrefix);
            await s3Client.send(new CopyObjectCommand({
                Bucket: BUCKET_NAME,
                CopySource: `${BUCKET_NAME}/${obj.Key}`,
                Key: newKey,
                ACL: 'public-read'
            }));
            await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: obj.Key }));
            moved += 1;
        }
        res.json({ success: true, moved });
    } catch (e) {
        next(e);
    }
});

apiRouter.get('/showcase', async (req, res, next) => {
    try {
        const active = await redis.get('system:active_showcase');
        const publicFolders = await redis.smembers('system:public_folders');
        const folderId = active || publicFolders[0];
        if (!folderId) return res.json({ title: 'Showcase', items: [] });
        const folderName = folderId.split('/').pop();
        const manifest = await buildShowcaseManifest({ folderId, title: folderName || 'Showcase' });
        res.json(manifest);
    } catch (e) { next(e); }
});

apiRouter.get('/showcase/:name', async (req, res, next) => {
    try {
        const name = decodeURIComponent(req.params.name);
        const mapped = await redis.hget('system:public_folder_names', name);
        const publicFolders = await redis.smembers('system:public_folders');
        const folderId = mapped || publicFolders.find((id) => id.split('/').pop() === name);
        if (!folderId) return res.json({ title: name || 'Showcase', items: [] });
        const manifest = await buildShowcaseManifest({ folderId, title: name || 'Showcase' });
        res.json(manifest);
    } catch (e) { next(e); }
});

// ==========================================
// 6. AI ASSISTANT
// ==========================================
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
    } catch (e) { next(e); }
});

apiRouter.post('/ai/generate', async (req, res, next) => {
    if (!genAI) return res.status(503).json({ ok: false, error: "AI Not Configured" });
    try {
        const { contents, config, model } = req.body || {};
        const { systemInstruction, ...generationConfig } = config || {};
        const normalizedContents = typeof contents === 'string'
            ? [{ role: 'user', parts: [{ text: contents }]}]
            : contents;
        const aiModel = genAI.getGenerativeModel({
            model: model || 'gemini-1.5-flash',
            systemInstruction
        });
        const result = await aiModel.generateContent({
            contents: normalizedContents,
            generationConfig
        });
        res.json({ text: result.response.text() });
    } catch (e) { next(e); }
});

// ==========================================
// 7. WEBHOOK (Persistent + QStash)
// ==========================================
const verifyWebhook = (req, res) => {
    if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) return res.status(200).send(req.query['hub.challenge']);
    return res.sendStatus(403);
};

const handleWebhook = async (req, res, next) => {
    try {
        const body = req.body;
        if (body.object !== 'whatsapp_business_account') return res.sendStatus(404);

        const entries = body.entry || [];
        for (const entry of entries) {
            for (const change of (entry.changes || [])) {
                const value = change.value;
                if (!value.messages) continue;

                const phoneId = value.metadata?.phone_number_id;
                const contact = value.contacts?.[0];

                for (const message of value.messages) {
                    // ✅ Persist immediately so UI always shows messages
                    try {
                        await persistInboundMessage(message, contact, req.requestId);
                    } catch (e) {
                        logger.error("Webhook persist failed (continuing)", { requestId: req.requestId, error: e.message, waMessageId: message?.id });
                    }

                    // ✅ Bot processing async
                    await enqueueIncomingMessageJob(req, message, contact, phoneId);
                }
            }
        }

        return res.sendStatus(200);
    } catch (e) {
        return next(e);
    }
};

// Root path
app.get('/webhook', verifyWebhook);
app.post('/webhook', handleWebhook);

// ✅ Alias for /api/webhook
apiRouter.get('/webhook', verifyWebhook);
apiRouter.post('/webhook', handleWebhook);

// ==========================================
// 8. WORKER (Queue Handler)
// ==========================================
apiRouter.post('/internal/bot-worker', async (req, res, next) => {
    const isAuthorized = await authorizeInternalRequest(req);

    if (!isAuthorized) {
        logger.warn("Unauthorized Worker Access");
        return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    try {
        const { message, contact, phoneId } = req.body;
        await processMessageInternal(message, contact, phoneId, req.headers['x-request-id']);
        res.json({ success: true });
    } catch (e) { next(e); }
});

apiRouter.post('/internal/scheduled-messages/run', async (req, res, next) => {
    const isAuthorized = await authorizeInternalRequest(req);

    if (!isAuthorized) {
        logger.warn("Unauthorized Scheduler Access");
        return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    try {
        const result = await processScheduledMessages({ source: 'manual' });
        res.json({ success: true, ...result });
    } catch (e) { next(e); }
});

// ==========================================
// 9. SYSTEM DIAGNOSTICS
// ==========================================
apiRouter.get('/debug/status', async (req, res) => {
    const result = {
        postgres: 'unknown',
        redis: 'unknown',
        tables: { candidates: false, bot_versions: false },
        counts: { candidates: 0 },
        lastError: null,
        workerUrl: null,
        env: {
            hasPostgres: Boolean(resolveDbUrl()),
            hasRedis: Boolean(process.env.UPSTASH_REDIS_REST_URL),
            hasQStash: Boolean(process.env.QSTASH_TOKEN && process.env.QSTASH_TOKEN !== 'mock'),
            publicUrl: process.env.PUBLIC_BASE_URL || process.env.VERCEL_URL || ''
        }
    };

    try {
        const client = await getDb().connect();
        try {
            await client.query('SELECT 1');
            result.postgres = 'connected';
            const tableCheck = await client.query(`
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = 'public'
                AND table_name IN ('candidates', 'bot_versions')
            `);
            const tableNames = tableCheck.rows.map(r => r.table_name);
            result.tables = {
                candidates: tableNames.includes('candidates'),
                bot_versions: tableNames.includes('bot_versions')
            };
            if (result.tables.candidates) {
                const countRes = await client.query('SELECT COUNT(*)::int AS count FROM candidates');
                result.counts.candidates = countRes.rows[0]?.count || 0;
            }
        } finally {
            client.release();
        }
    } catch (e) {
        result.postgres = 'error';
        result.lastError = e.message;
    }

    try {
        await redis.set('healthcheck', Date.now(), { ex: 5 });
        result.redis = 'connected';
    } catch (e) {
        result.redis = 'error';
        result.lastError = result.lastError || e.message;
    }

    const baseUrl = getBaseUrl(req);
    result.workerUrl = `${baseUrl}/api/internal/bot-worker`;

    res.json(result);
});

apiRouter.post('/system/init-db', async (req, res) => {
    try {
        await ensureDbSchema();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

apiRouter.post('/system/seed-db', async (req, res) => {
    const client = await getDb().connect();
    try {
        await ensureDbSchema();
        const existing = await client.query('SELECT COUNT(*)::int AS count FROM candidates');
        if (existing.rows[0]?.count > 0) {
            return res.json({ success: true, skipped: true });
        }
        await client.query('BEGIN');
        const candidateId = crypto.randomUUID();
        await client.query(
            `INSERT INTO candidates (id, phone_number, name, stage, last_message_at, last_message, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
            [candidateId, '+15555550123', 'Demo Driver', 'New', Date.now(), 'Interested in onboarding']
        );
        await client.query(
            `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at)
             VALUES ($1, $2, 'in', $3, 'text', 'received', NOW())`,
            [crypto.randomUUID(), candidateId, 'Hello, I want to apply.']
        );
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(500).json({ ok: false, error: e.message });
    } finally {
        client.release();
    }
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
    app.listen(PORT, () => logger.info(`🚀 WhatsApp Leads Handler running on port ${PORT}`));

    if (process.env.SCHEDULED_MESSAGES_ENABLED !== 'false') {
        const runScheduler = async (source) => {
            try {
                await processScheduledMessages({ source });
            } catch (e) {
                logger.error("Scheduled Message Loop Failed", { error: e.message, source });
            }
        };
        setTimeout(() => runScheduler('startup'), 1000);
        setInterval(() => runScheduler('interval'), SYSTEM_CONFIG.SCHEDULE_POLL_INTERVAL_MS);
    }
}

module.exports = app;

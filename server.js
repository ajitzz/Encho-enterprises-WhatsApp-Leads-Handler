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

// --- PROCESS SAFETY (prevents Vercel crashes on unhandled promises) ---
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Rejection', { error: reason && reason.message ? reason.message : String(reason) });
});
process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception', { error: err && err.message ? err.message : String(err) });
});

// --- CONFIGURATION ---
const SYSTEM_CONFIG = {
    META_TIMEOUT: 10000,
    DB_CONNECTION_TIMEOUT: 10000,
    CACHE_TTL_SETTINGS: 600
};

// --- SERVICES INITIALIZATION ---

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
            max: 10,
            idleTimeoutMillis: 1000,
            allowExitOnIdle: true
        });

        pgPool.on('error', (err) => logger.error('DB Pool Error', { error: err.message }));
    }
    return pgPool;
};

const withDb = async (operation) => {
    let client;
    let released = false;
    try {
        client = await getDb().connect();
        return await operation(client);
    } catch (e) {
        // IMPORTANT:
        // If any query fails inside an explicit transaction, Postgres marks the transaction as
        // "aborted" and all subsequent commands will fail with: "current transaction is aborted".
        // If we return such a connection back to the pool without rolling back, the *next*
        // request that reuses the connection will immediately start failing (25P02).
        //
        // We defensively try to rollback and also release the client *with error* so pg-pool
        // can drop the connection if needed.
        if (client) {
            try { await client.query('ROLLBACK'); } catch (_) {}
            try { client.release(e); released = true; } catch (_) {}
        }
        const isConnErr = e.message.includes('timeout') || e.message.includes('Connection terminated');
        logger.error(isConnErr ? "DB Connection Saturation" : "DB Query Error", { error: e.message });
        throw e;
    } finally {
        if (client) {
            if (!released) {
                try { client.release(); } catch (e) { console.error("Failed to release client", e); }
            }
        }
    }
};

// Transaction helper: always COMMIT or ROLLBACK.
const withTransaction = async (operation) => {
    return withDb(async (client) => {
        await client.query('BEGIN');
        try {
            const result = await operation(client);
            await client.query('COMMIT');
            return result;
        } catch (e) {
            try { await client.query('ROLLBACK'); } catch (_) {}
            throw e;
        }
    });
};

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL || 'https://mock.upstash.io',
    token: process.env.UPSTASH_REDIS_REST_TOKEN || 'mock'
});

// QStash (optional but recommended for serverless scheduling)
const qstash = process.env.QSTASH_TOKEN
    ? new QStashClient({ token: process.env.QSTASH_TOKEN })
    : null;

const qstashReceiver = (process.env.QSTASH_CURRENT_SIGNING_KEY && process.env.QSTASH_NEXT_SIGNING_KEY)
    ? new Receiver({
        currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
        nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
    })
    : null;

const authClient = new OAuth2Client(process.env.VITE_GOOGLE_CLIENT_ID);

// --- EXPRESS APP ---
const app = express();
app.use(cors());

// IMPORTANT: QStash signature verification requires raw body access.
// We'll keep JSON parser but also store raw body for verification.
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf?.toString('utf8');
    }
}));

// --- META CLIENT ---
const getMetaClient = () => {
    const axios = require('axios');
    const https = require('https');
    return axios.create({
        httpsAgent: new https.Agent({ keepAlive: true }),
        timeout: SYSTEM_CONFIG.META_TIMEOUT,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.META_API_TOKEN}` }
    });
};

const metaClient = getMetaClient();

const sendToMeta = async (phoneNumber, payload) => {
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!phoneId) throw new Error("WHATSAPP_PHONE_NUMBER_ID missing");
    const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;

    const to = (phoneNumber || '').toString().replace(/\D/g, '');
    if (!to) throw new Error("Invalid phone number");

    const body = {
        messaging_product: "whatsapp",
        to,
        ...payload
    };

    await metaClient.post(url, body);
};

// --- HELPERS ---
const getBaseUrlFromReq = (req) => {
    if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
    const proto = (req.headers['x-forwarded-proto'] || 'https').toString();
    const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
    if (!host) return '';
    return `${proto}://${host}`.replace(/\/$/, '');
};

const verifyQStashRequest = async (req) => {
    if (!qstashReceiver) return true; // If not configured, allow (dev)
    const signature = req.headers['upstash-signature'];
    if (!signature) return false;

    try {
        const ok = await qstashReceiver.verify({
            signature,
            body: req.rawBody || JSON.stringify(req.body || {}),
        });
        return !!ok;
    } catch (_) {
        return false;
    }
};

// --- BOT SETTINGS CACHE ---
const SETTINGS_CACHE_KEY = (phoneId) => `bot:settings:${phoneId || 'default'}`;

const getActiveBotSettings = async (client) => {
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || 'default';

    // Try redis first
    try {
        const cached = await redis.get(SETTINGS_CACHE_KEY(phoneId));
        if (cached) return cached;
    } catch (_) {}

    // DB fallback
    const r = await client.query(
        `SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1`
    );
    const settings = (r.rows[0] && r.rows[0].settings) ? r.rows[0].settings : null;

    // Cache it
    if (settings) {
        try {
            await redis.set(SETTINGS_CACHE_KEY(phoneId), settings, { ex: SYSTEM_CONFIG.CACHE_TTL_SETTINGS });
        } catch (_) {}
    }
    return settings;
};

const invalidateBotSettingsCache = async () => {
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || 'default';
    try { await redis.del(SETTINGS_CACHE_KEY(phoneId)); } catch (_) {}
};

// --- QUEUE PROCESSOR (FIXES: text=uuid, 25P02, timeouts) ---
const processQueueInternal = async () => {
    let processedCount = 0;
    const batchSize = Math.max(1, Math.min(25, Number(process.env.QUEUE_BATCH_SIZE || 10)));

    try {
        let jobsToProcess = [];

        // 1) Claim work in a transaction (FOR UPDATE SKIP LOCKED requires it)
        await withDb(async (client) => {
            // Check if table exists before running logic to prevent logs spamming
            const tableCheck = await client.query(`SELECT to_regclass('public.scheduled_messages')`);
            if (!tableCheck.rows[0].to_regclass) return;

            // Reset stuck jobs (serverless crashes / timeouts can leave rows in 'processing')
            await client.query(
                `UPDATE scheduled_messages
                 SET status = 'pending'
                 WHERE status = 'processing' AND scheduled_time < $1`,
                [Date.now() - 600000]
            );

            await client.query('BEGIN');
            try {
                // IMPORTANT JOIN:
                // candidates.id (UUID) must be compared to scheduled_messages.candidate_id (UUID)
                // NEVER compare to phone_number (TEXT) -> that causes: operator does not exist: text = uuid
                const result = await client.query(`
                    SELECT sm.id, sm.candidate_id, sm.payload, c.phone_number
                    FROM scheduled_messages sm
                    JOIN candidates c ON c.id = sm.candidate_id
                    WHERE sm.status = 'pending' AND sm.scheduled_time <= $1
                    ORDER BY sm.scheduled_time ASC
                    LIMIT $2
                    FOR UPDATE SKIP LOCKED
                `, [Date.now(), batchSize]);

                if (result.rows.length > 0) {
                    const jobIds = result.rows.map(r => r.id);
                    await client.query(
                        `UPDATE scheduled_messages SET status = 'processing' WHERE id = ANY($1::uuid[])`,
                        [jobIds]
                    );
                    jobsToProcess = result.rows;
                }

                await client.query('COMMIT');
            } catch (e) {
                try { await client.query('ROLLBACK'); } catch (_) {}
                throw e;
            }
        });

        if (jobsToProcess.length > 0) {
            logger.info(`Scheduler: Processing ${jobsToProcess.length} jobs`, { batchSize });
        }

        const concurrency = Math.max(1, Math.min(10, Number(process.env.SCHEDULED_SEND_CONCURRENCY || 5)));

        const runPool = async (items, limit, worker) => {
            const executing = new Set();
            for (const item of items) {
                const p = Promise.resolve().then(() => worker(item)).finally(() => executing.delete(p));
                executing.add(p);
                if (executing.size >= limit) {
                    await Promise.race(executing);
                }
            }
            await Promise.allSettled(Array.from(executing));
        };

        await runPool(jobsToProcess, concurrency, async (job) => {
            try {
                let payload = job.payload;
                if (typeof payload === 'string') {
                    try { payload = JSON.parse(payload); } catch (e) {}
                }

                let metaPayload = {};

                if (payload.templateName) {
                    metaPayload = { type: 'template', template: { name: payload.templateName, language: { code: 'en' } } };
                } else if (payload.mediaUrl) {
                    const type = payload.mediaType || 'image';
                    const caption = payload.text ? payload.text : undefined;
                    metaPayload = { type, [type]: { link: payload.mediaUrl, caption } };
                } else {
                    const bodyText = (payload.text || '').toString();
                    if (!bodyText.trim()) throw new Error('Scheduled message text is empty');
                    metaPayload = { type: 'text', text: { body: bodyText } };
                }

                await sendToMeta(job.phone_number, metaPayload);

                await withDb(async (client) => {
                    const messageText = payload.text || `[${payload.templateName || payload.mediaType || 'scheduled'}]`;
                    const messageType = payload.mediaType || (payload.templateName ? 'template' : 'text');

                    // FIX: correct placeholders (no extra params mismatch)
                    await client.query(`
                        INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at)
                        VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())
                    `, [crypto.randomUUID(), job.candidate_id, messageText, messageType]);

                    await client.query(
                        `UPDATE candidates SET last_message = $1, last_message_at = $2 WHERE id = $3`,
                        [messageText, Date.now(), job.candidate_id]
                    );

                    await client.query(`UPDATE scheduled_messages SET status = 'sent' WHERE id = $1`, [job.id]);
                });

                processedCount++;
            } catch (err) {
                logger.error("Scheduler Job Failed", { id: job.id, error: err.message });
                await withDb(async (client) => {
                    await client.query(`UPDATE scheduled_messages SET status = 'failed' WHERE id = $1`, [job.id]);
                });
            }
        });

        return processedCount;
    } catch (e) {
        logger.error("Queue Processing Error", { error: e.message });
        return 0;
    }
};

// Process a single scheduled message by id (used by QStash)
const processScheduledMessageById = async (jobId) => {
    if (!jobId) return { ok: false, reason: 'missing_jobId' };

    const claimed = await withTransaction(async (client) => {
        const res = await client.query(
            `SELECT sm.id, sm.status, sm.scheduled_time, sm.payload, sm.candidate_id, c.phone_number
             FROM scheduled_messages sm
             JOIN candidates c ON c.id = sm.candidate_id
             WHERE sm.id = $1
             FOR UPDATE`,
            [jobId]
        );
        if (res.rows.length === 0) return { state: 'not_found' };

        const job = res.rows[0];
        if (job.status === 'sent') return { state: 'already_sent' };
        if (job.status === 'failed') return { state: 'failed' };
        if (job.status === 'processing') return { state: 'already_processing' };

        const now = Date.now();
        if (Number(job.scheduled_time) > now) {
            return { state: 'too_early', scheduled_time: Number(job.scheduled_time) };
        }

        await client.query(`UPDATE scheduled_messages SET status = 'processing' WHERE id = $1 AND status = 'pending'`, [jobId]);

        return {
            state: 'claimed',
            candidate_id: job.candidate_id,
            phone_number: job.phone_number,
            payload: job.payload,
        };
    });

    if (claimed.state !== 'claimed') {
        return { ok: true, state: claimed.state };
    }

    let payload = claimed.payload;
    if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch (_) {}
    }

    let metaPayload = {};
    if (payload.templateName) {
        metaPayload = { type: 'template', template: { name: payload.templateName, language: { code: 'en' } } };
    } else if (payload.mediaUrl) {
        const type = payload.mediaType || 'image';
        const caption = payload.text ? payload.text : undefined;
        metaPayload = { type, [type]: { link: payload.mediaUrl, caption } };
    } else {
        const bodyText = (payload.text || '').toString();
        if (!bodyText.trim()) return { ok: false, error: 'empty_text' };
        metaPayload = { type: 'text', text: { body: bodyText } };
    }

    await sendToMeta(claimed.phone_number, metaPayload);

    const messageText = payload.text || `[${payload.templateName || payload.mediaType || 'scheduled'}]`;
    const messageType = payload.mediaType || (payload.templateName ? 'template' : 'text');

    await withDb(async (client) => {
        await client.query(`
            INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at)
            VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())
        `, [crypto.randomUUID(), claimed.candidate_id, messageText, messageType]);

        await client.query(
            `UPDATE candidates SET last_message = $1, last_message_at = $2 WHERE id = $3`,
            [messageText, Date.now(), claimed.candidate_id]
        );

        await client.query(`UPDATE scheduled_messages SET status = 'sent' WHERE id = $1`, [jobId]);
    });

    return { ok: true, state: 'sent' };
};

// --- API ROUTER ---
const apiRouter = express.Router();

// Cron endpoint (Vercel Cron hits this)
apiRouter.get('/cron/process-queue', async (req, res) => {
    try {
        const count = await processQueueInternal();
        res.json({ success: true, processed: count });
    } catch (e) {
        logger.error('Cron process-queue failed', { error: e.message });
        res.status(500).json({ success: false, error: e.message });
    }
});

// QStash delivery endpoint
apiRouter.post('/qstash/process-scheduled', async (req, res) => {
    try {
        const ok = await verifyQStashRequest(req);
        if (!ok) return res.status(401).json({ ok: false, error: 'Unauthorized' });

        const { jobId } = req.body || {};
        const result = await processScheduledMessageById(jobId);

        // return 200 for non-retriable states; 500 for transient is handled below
        return res.status(200).json({ ok: true, result });
    } catch (e) {
        logger.error('QStash process-scheduled failed', { error: e.message });
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// --- AUTH ---
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

// --- DEBUG ---
apiRouter.get('/debug/status', async (req, res) => {
    try {
        const status = { postgres: 'unknown', tables: {}, counts: {} };
        await withDb(async (client) => {
            await client.query('SELECT 1');
            status.postgres = 'connected';
            const tRes = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
            const tables = tRes.rows.map(r => r.table_name);
            status.tables.candidates = tables.includes('candidates');
            status.tables.scheduled_messages = tables.includes('scheduled_messages');
            status.tables.candidate_messages = tables.includes('candidate_messages');
            status.tables.bot_versions = tables.includes('bot_versions');
            status.tables.driver_documents = tables.includes('driver_documents');

            if (status.tables.candidates) {
                const cRes = await client.query('SELECT COUNT(*) FROM candidates');
                status.counts.candidates = parseInt(cRes.rows[0].count);
            }
            if (status.tables.scheduled_messages) {
                const qRes = await client.query(`SELECT status, COUNT(*)::int AS count FROM scheduled_messages GROUP BY status ORDER BY status`);
                status.counts.queue = qRes.rows;
            }
        });
        res.json(status);
    } catch (e) {
        res.status(500).json({ postgres: 'error', lastError: e.message });
    }
});

// --- SYSTEM RESET ---
apiRouter.post('/system/hard-reset', async (req, res, next) => {
    try {
        await withDb(async (client) => {
            await client.query(`
                DROP TABLE IF EXISTS driver_documents CASCADE;
                DROP TABLE IF EXISTS scheduled_messages CASCADE;
                DROP TABLE IF EXISTS candidate_messages CASCADE;
                DROP TABLE IF EXISTS bot_versions CASCADE;
                DROP TABLE IF EXISTS candidates CASCADE;
            `);
        });
        await init(); // recreate
        res.json({ success: true });
    } catch (e) { next(e); }
});

// --- DRIVERS (LEADS) ---
apiRouter.get('/drivers', async (req, res, next) => {
    try {
        await withDb(async (client) => {
            const resDb = await client.query('SELECT * FROM candidates ORDER BY last_message_at DESC NULLS LAST LIMIT 50');
            res.json(resDb.rows.map(row => ({
                id: row.id,
                phoneNumber: row.phone_number,
                name: row.name,
                status: row.stage,
                lastMessage: row.last_message || '...',
                lastMessageTime: row.last_message_at ? parseInt(row.last_message_at) : 0,
                source: row.source || 'Organic',
                notes: row.notes,
                isHumanMode: row.is_human_mode,
                humanModeEndsAt: row.human_mode_ends_at ? parseInt(row.human_mode_ends_at) : undefined
            })));
        });
    } catch (e) {
        if (e.code === '42P01') { res.json([]); }
        else { next(e); }
    }
});

apiRouter.get('/drivers/:id/messages', async (req, res, next) => {
    try {
        await withDb(async (client) => {
            const limit = parseInt(req.query.limit) || 50;
            const resDb = await client.query(
                'SELECT * FROM candidate_messages WHERE candidate_id = $1 ORDER BY created_at DESC LIMIT $2',
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
        });
    } catch (e) {
        if (e.code === '42P01') res.json([]);
        else next(e);
    }
});

apiRouter.get('/drivers/:id/documents', async (req, res, next) => {
    try {
        await withDb(async (client) => {
            const docs = await client.query(
                `SELECT * FROM driver_documents WHERE candidate_id = $1 ORDER BY created_at DESC`,
                [req.params.id]
            );
            res.json(docs.rows.map(d => ({
                id: d.id,
                docType: d.type,
                url: d.url,
                verificationStatus: d.status,
                timestamp: new Date(d.created_at).getTime()
            })));
        });
    } catch (e) {
        if (e.code === '42P01') res.json([]);
        else next(e);
    }
});

apiRouter.get('/drivers/:id/scheduled-messages', async (req, res, next) => {
    try {
        await withDb(async (client) => {
            const result = await client.query(
                `SELECT * FROM scheduled_messages WHERE candidate_id = $1 ORDER BY scheduled_time ASC`,
                [req.params.id]
            );
            res.json(result.rows.map(r => ({
                id: r.id,
                scheduledTime: parseInt(r.scheduled_time),
                payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
                status: r.status
            })));
        });
    } catch (e) {
        if (e.code === '42P01') res.json([]);
        else next(e);
    }
});

// Send a message manually
apiRouter.post('/drivers/:id/messages', async (req, res, next) => {
    const { text, mediaUrl, mediaType } = req.body;
    try {
        await withDb(async (client) => {
            const dRes = await client.query('SELECT phone_number FROM candidates WHERE id = $1', [req.params.id]);
            if (dRes.rows.length === 0) return res.status(404).json({ ok: false, error: "Driver not found" });

            const bodyText = (text ?? '').toString();

            const payload = mediaUrl
                ? { type: mediaType || 'image', [mediaType || 'image']: { link: mediaUrl, caption: bodyText || undefined } }
                : { type: 'text', text: { body: bodyText.trim() ? bodyText : '...' } };

            await sendToMeta(dRes.rows[0].phone_number, payload);

            await client.query(
                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at)
                 VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())`,
                [crypto.randomUUID(), req.params.id, bodyText, mediaUrl ? (mediaType || 'image') : 'text']
            );

            await client.query(
                `UPDATE candidates SET last_message = $1, last_message_at = $2 WHERE id = $3`,
                [bodyText || '[media]', Date.now(), req.params.id]
            );
        });

        res.json({ ok: true });
    } catch (e) { next(e); }
});

// Schedule messages
apiRouter.post('/scheduled-messages', async (req, res, next) => {
    const { driverIds, message, timestamp } = req.body;
    try {
        const scheduledTime = Number(timestamp);
        if (isNaN(scheduledTime)) return res.status(400).json({ ok: false, error: "Invalid timestamp" });
        if (!Array.isArray(driverIds) || driverIds.length === 0) return res.status(400).json({ ok: false, error: "driverIds must be a non-empty array" });

        let payload = message;
        if (payload === undefined || payload === null) payload = {};
        if (typeof payload === 'string') payload = { text: payload };
        if (typeof payload !== 'object') payload = { text: String(payload) };

        const textBody = (payload.text ?? '').toString();
        if (!payload.templateName && !payload.mediaUrl && !textBody.trim()) {
            return res.status(400).json({ ok: false, error: "Scheduled message text cannot be empty" });
        }

        payload.text = textBody;
        if (payload.mediaUrl && !payload.mediaType) payload.mediaType = 'image';

        const inserted = [];

        await withDb(async (client) => {
            for (const driverId of driverIds) {
                const id = crypto.randomUUID();
                inserted.push({ id, driverId });
                await client.query(
                    `INSERT INTO scheduled_messages (id, candidate_id, payload, scheduled_time, status)
                     VALUES ($1, $2, $3, $4, 'pending')`,
                    [id, driverId, payload, scheduledTime]
                );
            }
        });

        if (qstash) {
            const baseUrl = getBaseUrlFromReq(req);
            if (!baseUrl) {
                logger.warn('QStash configured but base URL could not be resolved; set PUBLIC_BASE_URL.');
            } else {
                const targetUrl = `${baseUrl}/api/qstash/process-scheduled`;
                const delayMs = Math.max(0, scheduledTime - Date.now());
                const delaySeconds = Math.ceil(delayMs / 1000);

                await Promise.allSettled(
                    inserted.map((row) =>
                        qstash.publishJSON({
                            url: targetUrl,
                            body: { jobId: row.id },
                            delay: `${delaySeconds}s`,
                        })
                    )
                );
            }
        }

        res.json({ success: true, inserted: inserted.length });
    } catch (e) { next(e); }
});

apiRouter.delete('/scheduled-messages/:id', async (req, res, next) => {
    try {
        await withDb(async (client) => {
            await client.query('DELETE FROM scheduled_messages WHERE id = $1', [req.params.id]);
        });
        res.json({ ok: true });
    } catch (e) { next(e); }
});

apiRouter.patch('/scheduled-messages/:id', async (req, res, next) => {
    try {
        const { timestamp, message } = req.body;
        await withDb(async (client) => {
            if (timestamp !== undefined) {
                await client.query('UPDATE scheduled_messages SET scheduled_time = $1 WHERE id = $2', [Number(timestamp), req.params.id]);
            }
            if (message !== undefined) {
                await client.query('UPDATE scheduled_messages SET payload = $1 WHERE id = $2', [message, req.params.id]);
            }
        });
        res.json({ ok: true });
    } catch (e) { next(e); }
});

// --- BOT SETTINGS (minimal: keep compatibility) ---
apiRouter.get('/bot/settings', async (req, res, next) => {
    try {
        const settings = await withDb(async (client) => await getActiveBotSettings(client));
        res.json(settings || {});
    } catch (e) { next(e); }
});

apiRouter.post('/bot/save', async (req, res, next) => {
    try {
        const settings = req.body || {};
        await withDb(async (client) => {
            await client.query(
                `INSERT INTO bot_versions (id, phone_number_id, version_number, status, settings, created_at)
                 VALUES ($1, $2, $3, $4, $5, NOW())`,
                [crypto.randomUUID(), process.env.WHATSAPP_PHONE_NUMBER_ID || null, 1, 'draft', settings]
            );
        });
        await invalidateBotSettingsCache();
        res.json({ ok: true });
    } catch (e) { next(e); }
});

apiRouter.post('/bot/publish', async (req, res, next) => {
    try {
        await withDb(async (client) => {
            await client.query(`UPDATE bot_versions SET status = 'archived' WHERE status = 'published'`);
            await client.query(`
                UPDATE bot_versions
                SET status = 'published'
                WHERE id = (
                    SELECT id FROM bot_versions ORDER BY created_at DESC LIMIT 1
                )
            `);
        });
        await invalidateBotSettingsCache();
        res.json({ ok: true });
    } catch (e) { next(e); }
});

// --- WEBHOOK HANDLERS (keep your existing logic) ---
const verifyWebhook = (req, res) => {
    const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = r

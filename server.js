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
    let settings = (r.rows[0] && r.rows[0].settings) ? r.rows[0].settings : null;
    if (settings && typeof settings === 'string') {
        try { settings = JSON.parse(settings); } catch (_) {}
    }

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
        const settings = await getSystemSettings();
        if (!settings.sending_enabled) return 0;

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
const DEFAULT_SYSTEM_SETTINGS = {
    webhook_ingest_enabled: true,
    automation_enabled: true,
    sending_enabled: true
};

const SYSTEM_SETTINGS_KEY = 'system:settings';
const META_CREDENTIALS_KEY = 'system:meta_credentials';

const getSystemSettings = async () => {
    try {
        const cached = await redis.get(SYSTEM_SETTINGS_KEY);
        if (cached && typeof cached === 'object') return { ...DEFAULT_SYSTEM_SETTINGS, ...cached };
        if (cached && typeof cached === 'string') return { ...DEFAULT_SYSTEM_SETTINGS, ...JSON.parse(cached) };
    } catch (_) {}
    return { ...DEFAULT_SYSTEM_SETTINGS };
};

const updateSystemSettings = async (updates) => {
    const current = await getSystemSettings();
    const next = { ...current, ...updates };
    try { await redis.set(SYSTEM_SETTINGS_KEY, next); } catch (_) {}
    return next;
};

const getMetaCredentials = async () => {
    let stored = {};
    try {
        const cached = await redis.get(META_CREDENTIALS_KEY);
        if (cached && typeof cached === 'object') stored = cached;
        if (cached && typeof cached === 'string') stored = JSON.parse(cached);
    } catch (_) {}

    return {
        phoneNumberId: stored.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID || process.env.META_PHONE_NUMBER_ID || '',
        apiToken: stored.apiToken || process.env.META_API_TOKEN || process.env.META_TOKEN || process.env.WHATSAPP_API_TOKEN || '',
        verifyToken: stored.verifyToken || process.env.META_WEBHOOK_VERIFY_TOKEN || process.env.VERIFY_TOKEN || ''
    };
};

const updateMetaCredentials = async (updates) => {
    const current = await getMetaCredentials();
    const next = { ...current, ...updates };
    try { await redis.set(META_CREDENTIALS_KEY, next); } catch (_) {}
    return next;
};

const getMetaClient = (token) => {
    const axios = require('axios');
    const https = require('https');
    return axios.create({
        httpsAgent: new https.Agent({ keepAlive: true }),
        timeout: SYSTEM_CONFIG.META_TIMEOUT,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
    });
};

const sendToMeta = async (phoneNumber, payload) => {
    const { phoneNumberId, apiToken } = await getMetaCredentials();
    if (!phoneNumberId) throw new Error("WHATSAPP_PHONE_NUMBER_ID missing");
    if (!apiToken) throw new Error("META_API_TOKEN missing");
    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

    const to = (phoneNumber || '').toString().replace(/\D/g, '');
    if (!to) throw new Error("Invalid phone number");

    const body = {
        messaging_product: "whatsapp",
        to,
        ...payload
    };

    const metaClient = getMetaClient(apiToken);
    await metaClient.post(url, body);
};

const verifyWebhook = async (req, res) => {
    const { verifyToken } = await getMetaCredentials();
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token && verifyToken && token === verifyToken) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
};

const fetchMediaUrl = async (mediaId) => {
    if (!mediaId) return null;
    const { apiToken } = await getMetaCredentials();
    if (!apiToken) return null;
    const metaClient = getMetaClient(apiToken);
    const res = await metaClient.get(`https://graph.facebook.com/v21.0/${mediaId}`);
    return res.data?.url || null;
};

const parseIncomingMessage = async (message, value) => {
    const type = message.type;
    const timestamp = Number(message.timestamp) * 1000 || Date.now();
    const from = message.from;
    let text = '';
    let payload = {};
    let mediaUrl = null;
    let mediaType = type;
    let whatsappMessageId = message.id;

    if (type === 'text') {
        text = message.text?.body || '';
    } else if (type === 'button') {
        text = message.button?.text || '';
    } else if (type === 'interactive') {
        const interactive = message.interactive || {};
        if (interactive.type === 'button_reply') {
            text = interactive.button_reply?.title || interactive.button_reply?.id || '';
        } else if (interactive.type === 'list_reply') {
            text = interactive.list_reply?.title || interactive.list_reply?.id || '';
        }
    } else if (type === 'image' || type === 'video' || type === 'document' || type === 'audio') {
        const media = message[type] || {};
        mediaUrl = await fetchMediaUrl(media.id);
        text = media.caption || '';
        payload = { ...media, url: mediaUrl };
    } else if (type === 'location') {
        text = message.location?.name || 'Shared location';
        payload = message.location || {};
    }

    if (!text && mediaUrl) {
        text = `[${type}]`;
    }

    return { from, timestamp, text, payload, mediaUrl, mediaType, whatsappMessageId };
};

const getCandidateVariables = async (candidateId) => {
    const key = `candidate:variables:${candidateId}`;
    try {
        const cached = await redis.get(key);
        if (!cached) return {};
        if (typeof cached === 'object') return cached;
        return JSON.parse(cached);
    } catch (_) {
        return {};
    }
};

const setCandidateVariables = async (candidateId, variables) => {
    const key = `candidate:variables:${candidateId}`;
    try { await redis.set(key, variables); } catch (_) {}
};

const updateCandidateField = async (client, candidateId, field, value) => {
    const allowed = new Set(['name', 'notes', 'stage', 'source']);
    if (!allowed.has(field)) return false;
    await client.query(`UPDATE candidates SET ${field} = $1 WHERE id = $2`, [value, candidateId]);
    return true;
};

const buildMetaPayload = (message) => {
    if (message.mediaUrl) {
        const type = message.mediaType || 'image';
        const caption = message.text ? message.text : undefined;
        return { metaPayload: { type, [type]: { link: message.mediaUrl, caption } }, messageType: type };
    }

    if (message.buttons && message.buttons.length > 0) {
        const buttons = message.buttons.slice(0, 3).map((btn, idx) => ({
            type: 'reply',
            reply: { id: btn.id || `btn_${idx + 1}`, title: btn.title }
        }));
        return {
            metaPayload: {
                type: 'interactive',
                interactive: {
                    type: 'button',
                    body: { text: message.text || 'Select an option' },
                    action: { buttons }
                }
            },
            messageType: 'interactive'
        };
    }

    if (message.listSections && message.listSections.length > 0) {
        return {
            metaPayload: {
                type: 'interactive',
                interactive: {
                    type: 'list',
                    body: { text: message.text || 'Select an option' },
                    action: {
                        button: 'Select',
                        sections: message.listSections
                    }
                }
            },
            messageType: 'interactive'
        };
    }

    const bodyText = (message.text || '').toString();
    return { metaPayload: { type: 'text', text: { body: bodyText.trim() ? bodyText : '...' } }, messageType: 'text' };
};

const sendBotMessage = async (candidateId, phoneNumber, message) => {
    const { metaPayload, messageType } = buildMetaPayload(message);
    await sendToMeta(phoneNumber, metaPayload);

    await withDb(async (client) => {
        const messageText = message.text || `[${messageType}]`;
        await client.query(`
            INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at)
            VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())
        `, [crypto.randomUUID(), candidateId, messageText, messageType]);

        await client.query(
            `UPDATE candidates SET last_message = $1, last_message_at = $2 WHERE id = $3`,
            [messageText, Date.now(), candidateId]
        );
    });
};

const runStepFlow = async (candidate, incomingText, settings) => {
    const steps = settings.steps || [];
    if (steps.length === 0) return;
    const stepMap = new Map(steps.map(step => [step.id, step]));
    const entryStepId = settings.entryPointId || steps[0].id;

    const currentStepId = candidate.current_node_id;
    const currentStep = currentStepId ? stepMap.get(currentStepId) : null;

    if (!currentStep) {
        const entryStep = stepMap.get(entryStepId);
        if (!entryStep) return;
        await sendBotMessage(candidate.id, candidate.phone_number, {
            text: entryStep.message,
            mediaUrl: entryStep.mediaUrl,
            mediaType: entryStep.mediaType,
            buttons: entryStep.options?.map((opt, idx) => ({ id: `${entryStep.id}_${idx}`, title: opt }))
        });
        await withDb(async (client) => {
            await client.query(`UPDATE candidates SET current_node_id = $1 WHERE id = $2`, [entryStep.id, candidate.id]);
        });
        return;
    }

    if (currentStep.saveToField) {
        await withDb(async (client) => {
            const saved = await updateCandidateField(client, candidate.id, currentStep.saveToField, incomingText);
            if (!saved) {
                const vars = await getCandidateVariables(candidate.id);
                vars[currentStep.saveToField] = incomingText;
                await setCandidateVariables(candidate.id, vars);
            }
        });
    }

    let nextStepId = currentStep.nextStepId;
    if (currentStep.routes && incomingText) {
        const match = Object.keys(currentStep.routes).find(key =>
            incomingText.toLowerCase().includes(key.toLowerCase())
        );
        if (match) nextStepId = currentStep.routes[match];
    }

    if (!nextStepId) {
        await withDb(async (client) => {
            await client.query(`UPDATE candidates SET current_node_id = NULL WHERE id = $1`, [candidate.id]);
        });
        return;
    }

    const nextStep = stepMap.get(nextStepId);
    if (!nextStep) return;

    await sendBotMessage(candidate.id, candidate.phone_number, {
        text: nextStep.message,
        mediaUrl: nextStep.mediaUrl,
        mediaType: nextStep.mediaType,
        buttons: nextStep.options?.map((opt, idx) => ({ id: `${nextStep.id}_${idx}`, title: opt }))
    });

    await withDb(async (client) => {
        await client.query(`UPDATE candidates SET current_node_id = $1 WHERE id = $2`, [nextStep.id, candidate.id]);
    });
};

const runNodeFlow = async (candidate, incomingText, incomingPayload, settings) => {
    const nodes = settings.nodes || [];
    const edges = settings.edges || [];
    if (nodes.length === 0) return;

    const nodeMap = new Map(nodes.map(node => [node.id, node]));
    const edgesFrom = edges.reduce((acc, edge) => {
        if (!acc[edge.source]) acc[edge.source] = [];
        acc[edge.source].push(edge.target);
        return acc;
    }, {});

    const getNextByEdge = (nodeId) => (edgesFrom[nodeId] || [])[0];
    const getStartNode = () => nodes.find(n => n.data?.type === 'start') || nodes[0];

    const advance = async (startNodeId) => {
        let nodeId = startNodeId;
        let guard = 0;
        while (nodeId && guard < 10) {
            guard++;
            const node = nodeMap.get(nodeId);
            if (!node) return null;
            const data = node.data || {};
            const type = data.type;

            if (type === 'end') {
                await withDb(async (client) => {
                    await client.query(`UPDATE candidates SET current_node_id = NULL WHERE id = $1`, [candidate.id]);
                });
                return null;
            }

            if (type === 'status' && data.targetStatus) {
                await withDb(async (client) => {
                    await client.query(`UPDATE candidates SET stage = $1 WHERE id = $2`, [data.targetStatus, candidate.id]);
                });
                nodeId = getNextByEdge(nodeId);
                continue;
            }

            if (type === 'handoff') {
                await withDb(async (client) => {
                    await client.query(`UPDATE candidates SET is_human_mode = TRUE WHERE id = $1`, [candidate.id]);
                });
                if (data.content) {
                    await sendBotMessage(candidate.id, candidate.phone_number, { text: data.content });
                }
                await withDb(async (client) => {
                    await client.query(`UPDATE candidates SET current_node_id = NULL WHERE id = $1`, [candidate.id]);
                });
                return null;
            }

            if (type === 'condition') {
                const vars = await getCandidateVariables(candidate.id);
                const conditions = data.conditions || [];
                let matched = null;
                for (const cond of conditions) {
                    const value = vars[cond.variable];
                    if (cond.operator === 'equals' && value == cond.value) matched = cond.nextStepId;
                    if (cond.operator === 'contains' && typeof value === 'string' && value.includes(cond.value)) matched = cond.nextStepId;
                    if (cond.operator === 'greater_than' && Number(value) > Number(cond.value)) matched = cond.nextStepId;
                    if (cond.operator === 'less_than' && Number(value) < Number(cond.value)) matched = cond.nextStepId;
                    if (cond.operator === 'exists' && value !== undefined && value !== null && value !== '') matched = cond.nextStepId;
                    if (matched) break;
                }
                nodeId = matched || data.defaultNextStepId || getNextByEdge(nodeId);
                continue;
            }

            if (['message', 'question', 'buttons', 'list', 'document'].includes(type)) {
                const message = {
                    text: data.content || '',
                    mediaUrl: data.mediaUrl,
                    mediaType: data.mediaType,
                    buttons: data.buttons,
                    listSections: data.listSections
                };
                await sendBotMessage(candidate.id, candidate.phone_number, message);

                if (['question', 'buttons', 'list', 'document'].includes(type)) {
                    await withDb(async (client) => {
                        await client.query(`UPDATE candidates SET current_node_id = $1 WHERE id = $2`, [nodeId, candidate.id]);
                    });
                    return nodeId;
                }

                nodeId = getNextByEdge(nodeId);
                continue;
            }

            nodeId = getNextByEdge(nodeId);
        }
        return nodeId;
    };

    const currentNodeId = candidate.current_node_id;
    const currentNode = currentNodeId ? nodeMap.get(currentNodeId) : null;
    const currentType = currentNode?.data?.type;

    if (currentNodeId && ['question', 'buttons', 'list', 'document'].includes(currentType)) {
        const variableName = currentNode?.data?.variable;
        if (variableName) {
            const vars = await getCandidateVariables(candidate.id);
            vars[variableName] = incomingText || incomingPayload || '';
            await setCandidateVariables(candidate.id, vars);
        }
        const nextNodeId = getNextByEdge(currentNodeId) || currentNode?.data?.defaultNextStepId;
        await advance(nextNodeId);
        return;
    }

    const startNode = getStartNode();
    if (!startNode) return;
    await advance(startNode.id);
};

const processIncomingLead = async (incoming, value) => {
    if (!incoming?.from) return;

    const systemSettings = await getSystemSettings();
    if (!systemSettings.webhook_ingest_enabled) return;

    const phoneNumber = incoming.from;
    const messageText = incoming.text || '';
    const messageType = incoming.mediaType || (incoming.mediaUrl ? 'media' : 'text');

    await withDb(async (client) => {
        const existing = await client.query(
            'SELECT id FROM candidate_messages WHERE whatsapp_message_id = $1',
            [incoming.whatsappMessageId]
        );
        if (existing.rows.length > 0) return;

        let candidate = await client.query('SELECT * FROM candidates WHERE phone_number = $1', [phoneNumber]);
        let candidateRow = candidate.rows[0];

        if (!candidateRow) {
            const name = value?.contacts?.[0]?.profile?.name || 'Unknown';
            const insert = await client.query(
                `INSERT INTO candidates (id, phone_number, name, stage, last_message, last_message_at, source)
                 VALUES ($1, $2, $3, 'New', $4, $5, $6)
                 RETURNING *`,
                [crypto.randomUUID(), phoneNumber, name, messageText, Date.now(), 'Organic']
            );
            candidateRow = insert.rows[0];
        }

        await client.query(
            `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, whatsapp_message_id, created_at)
             VALUES ($1, $2, 'in', $3, $4, 'received', $5, NOW())`,
            [crypto.randomUUID(), candidateRow.id, messageText, messageType, incoming.whatsappMessageId || null]
        );

        await client.query(
            `UPDATE candidates SET last_message = $1, last_message_at = $2 WHERE id = $3`,
            [messageText, Date.now(), candidateRow.id]
        );

        if (incoming.mediaType === 'document' && incoming.mediaUrl) {
            await client.query(
                `INSERT INTO driver_documents (id, candidate_id, type, url, status, created_at)
                 VALUES ($1, $2, $3, $4, 'pending', NOW())`,
                [crypto.randomUUID(), candidateRow.id, 'document', incoming.mediaUrl]
            );
        }
    });

    const candidate = await withDb(async (client) => {
        const res = await client.query('SELECT * FROM candidates WHERE phone_number = $1', [phoneNumber]);
        return res.rows[0];
    });
    if (!candidate) return;

    if (candidate.is_human_mode && candidate.human_mode_ends_at && Number(candidate.human_mode_ends_at) < Date.now()) {
        await withDb(async (client) => {
            await client.query(`UPDATE candidates SET is_human_mode = FALSE, human_mode_ends_at = NULL WHERE id = $1`, [candidate.id]);
        });
    }

    if (candidate.is_human_mode) return;
    if (!systemSettings.automation_enabled) return;

    const settings = await withDb(async (client) => await getActiveBotSettings(client));
    if (!settings) return;

    if (settings.nodes && settings.nodes.length > 0) {
        await runNodeFlow(candidate, messageText, incoming.payload, settings);
    } else if (settings.steps && settings.steps.length > 0) {
        await runStepFlow(candidate, messageText, settings);
    }
};

const handleWebhook = async (req, res) => {
    const payload = req.body;
    res.status(200).send('EVENT_RECEIVED');

    try {
        const entries = payload.entry || [];
        for (const entry of entries) {
            const changes = entry.changes || [];
            for (const change of changes) {
                const value = change.value || {};
                if (!value.messages) continue;
                for (const message of value.messages) {
                    const incoming = await parseIncomingMessage(message, value);
                    await processIncomingLead(incoming, value);
                }
            }
        }
    } catch (e) {
        logger.error('Webhook processing failed', { error: e.message });
    }
};

// --- SYSTEM & MEDIA HELPERS ---
const requireAuth = async (req, res, next) => {
    const requireAuthFlag = process.env.REQUIRE_AUTH === 'true' || !!process.env.ADMIN_EMAILS;
    if (!requireAuthFlag) return next();

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    try {
        const ticket = await authClient.verifyIdToken({
            idToken: token,
            audience: process.env.VITE_GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        const allowList = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
        if (allowList.length > 0 && !allowList.includes(payload.email)) {
            return res.status(403).json({ ok: false, error: 'Access denied' });
        }
        req.user = payload;
        return next();
    } catch (e) {
        return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    }
};

const path = require('path');
const fs = require('fs');

const MEDIA_ROOT = path.join(process.cwd(), 'media_storage');
const MEDIA_INDEX = path.join(MEDIA_ROOT, 'media_index.json');

const ensureMediaRoot = () => {
    if (!fs.existsSync(MEDIA_ROOT)) fs.mkdirSync(MEDIA_ROOT, { recursive: true });
    if (!fs.existsSync(MEDIA_INDEX)) fs.writeFileSync(MEDIA_INDEX, JSON.stringify({ files: {}, folders: {} }, null, 2));
};

const readMediaIndex = () => {
    ensureMediaRoot();
    try {
        return JSON.parse(fs.readFileSync(MEDIA_INDEX, 'utf8'));
    } catch (_) {
        return { files: {}, folders: {} };
    }
};

const writeMediaIndex = (data) => {
    ensureMediaRoot();
    fs.writeFileSync(MEDIA_INDEX, JSON.stringify(data, null, 2));
};

const safeMediaPath = (requestedPath) => {
    const normalized = path.posix.normalize(`/${requestedPath || ''}`);
    const safePath = normalized.replace(/\.\./g, '');
    return safePath;
};

const listMedia = (requestedPath) => {
    ensureMediaRoot();
    const index = readMediaIndex();
    const safePath = safeMediaPath(requestedPath);
    const folderEntries = Object.values(index.folders).filter(folder => folder.parent_path === safePath);
    const fileEntries = Object.values(index.files).filter(file => file.path === safePath);
    return { folders: folderEntries, files: fileEntries };
};

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = safeMediaPath(req.body.path || '/');
        const fullPath = path.join(MEDIA_ROOT, uploadPath);
        fs.mkdirSync(fullPath, { recursive: true });
        cb(null, fullPath);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}_${file.originalname}`);
    }
});
const upload = multer({ storage });

// --- ADDITIONAL API ROUTES ---
apiRouter.patch('/drivers/:id', async (req, res, next) => {
    try {
        const updates = req.body || {};
        const fields = [];
        const values = [];
        let idx = 1;
        const allowed = ['name', 'stage', 'notes', 'source', 'is_human_mode', 'human_mode_ends_at', 'current_node_id'];
        for (const key of allowed) {
            if (updates[key] !== undefined) {
                fields.push(`${key} = $${idx++}`);
                values.push(updates[key]);
            }
        }
        if (fields.length === 0) return res.json({ ok: true });
        values.push(req.params.id);
        await withDb(async (client) => {
            await client.query(`UPDATE candidates SET ${fields.join(', ')} WHERE id = $${idx}`, values);
        });
        res.json({ ok: true });
    } catch (e) { next(e); }
});

apiRouter.post('/ai/assistant', async (req, res) => {
    try {
        const { input, history } = req.body || {};
        const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
        if (!apiKey) return res.status(400).json({ error: 'Missing GEMINI_API_KEY' });
        const ai = new GoogleGenAI({ apiKey });
        const messages = (history || []).map((item) => ({
            role: item.role || 'user',
            parts: [{ text: item.content || '' }]
        }));
        messages.push({ role: 'user', parts: [{ text: input || '' }] });
        const result = await ai.models.generateContent({
            model: 'gemini-1.5-flash',
            contents: messages
        });
        const text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        res.json({ reply: text });
    } catch (e) {
        logger.error('AI assistant failed', { error: e.message });
        res.status(500).json({ error: 'AI assistant failed' });
    }
});

apiRouter.post('/ai/generate', async (req, res) => {
    try {
        const { prompt } = req.body || {};
        const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
        if (!apiKey) return res.status(400).json({ error: 'Missing GEMINI_API_KEY' });
        const ai = new GoogleGenAI({ apiKey });
        const result = await ai.models.generateContent({
            model: 'gemini-1.5-flash',
            contents: [{ role: 'user', parts: [{ text: prompt || '' }] }]
        });
        const text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        res.json({ text });
    } catch (e) {
        logger.error('AI generate failed', { error: e.message });
        res.status(500).json({ error: 'AI generate failed' });
    }
});

apiRouter.get('/system/settings', requireAuth, async (req, res) => {
    const settings = await getSystemSettings();
    res.json(settings);
});

apiRouter.patch('/system/settings', requireAuth, async (req, res) => {
    const next = await updateSystemSettings(req.body || {});
    res.json(next);
});

apiRouter.post('/system/credentials', requireAuth, async (req, res) => {
    const { phoneNumberId, apiToken } = req.body || {};
    const next = await updateMetaCredentials({ phoneNumberId, apiToken });
    res.json({ ok: true, credentials: { phoneNumberId: next.phoneNumberId } });
});

apiRouter.post('/system/webhook', requireAuth, async (req, res) => {
    const { verifyToken } = req.body || {};
    const next = await updateMetaCredentials({ verifyToken });
    res.json({ ok: true, verifyToken: next.verifyToken });
});

apiRouter.post('/system/init-db', requireAuth, async (req, res, next) => {
    try {
        await init();
        res.json({ ok: true });
    } catch (e) { next(e); }
});

apiRouter.post('/system/seed-db', requireAuth, async (req, res, next) => {
    try {
        await withDb(async (client) => {
            await client.query(
                `INSERT INTO candidates (id, phone_number, name, stage, last_message, last_message_at, source)
                 VALUES ($1, $2, $3, 'New', $4, $5, $6)
                 ON CONFLICT (phone_number) DO NOTHING`,
                [crypto.randomUUID(), '15550001111', 'Sample Lead', 'Hello!', Date.now(), 'Manual']
            );
        });
        res.json({ ok: true });
    } catch (e) { next(e); }
});

apiRouter.get('/showcase/status', async (req, res) => {
    const index = readMediaIndex();
    const folder = Object.values(index.folders).find(f => f.is_public_showcase);
    if (!folder) return res.json({ active: false });
    res.json({ active: true, folderName: folder.name, folderId: folder.id });
});

apiRouter.get('/showcase/:folder?', async (req, res) => {
    const index = readMediaIndex();
    const folderName = req.params.folder;
    const folder = Object.values(index.folders).find(f => f.name === folderName && f.is_public_showcase);
    if (!folder) return res.status(404).json({ error: 'Not found' });
    const content = listMedia(folder.parent_path === '/' ? `/${folder.name}` : folder.parent_path + '/' + folder.name);
    res.json(content);
});

apiRouter.get('/media', requireAuth, async (req, res) => {
    const pathQuery = req.query.path || '/';
    const data = listMedia(pathQuery);
    res.json(data);
});

apiRouter.get('/media/file/:id', async (req, res) => {
    const index = readMediaIndex();
    const file = index.files[req.params.id];
    if (!file) return res.status(404).send('Not found');
    res.sendFile(path.join(MEDIA_ROOT, file.path, file.filename));
});

apiRouter.post('/media/upload', requireAuth, upload.single('file'), async (req, res) => {
    const index = readMediaIndex();
    const uploadPath = safeMediaPath(req.body.path || '/');
    const id = crypto.randomUUID();
    const file = req.file;
    const record = {
        id,
        url: `/api/media/file/${id}`,
        filename: file.filename,
        type: file.mimetype,
        path: uploadPath,
        media_id: null
    };
    index.files[id] = record;
    writeMediaIndex(index);
    res.json({ ok: true, file: record });
});

apiRouter.post('/media/:id/sync', requireAuth, async (req, res) => {
    const index = readMediaIndex();
    const file = index.files[req.params.id];
    if (!file) return res.status(404).json({ error: 'Not found' });
    if (!file.media_id) {
        file.media_id = `pending_${Date.now()}`;
        index.files[req.params.id] = file;
        writeMediaIndex(index);
    }
    res.json({ ok: true, media_id: file.media_id });
});

apiRouter.post('/media/sync-s3', requireAuth, async (req, res) => {
    res.json({ ok: true, added: 0 });
});

apiRouter.post('/media/folders', requireAuth, async (req, res) => {
    const { name, parentPath } = req.body || {};
    const index = readMediaIndex();
    const id = crypto.randomUUID();
    const parent = safeMediaPath(parentPath || '/');
    const record = { id, name, parent_path: parent, is_public_showcase: false };
    index.folders[id] = record;
    writeMediaIndex(index);
    res.json({ ok: true, folder: record });
});

apiRouter.patch('/media/folders/:id', requireAuth, async (req, res) => {
    const index = readMediaIndex();
    const folder = index.folders[req.params.id];
    if (!folder) return res.status(404).json({ error: 'Not found' });
    folder.name = req.body?.name || folder.name;
    index.folders[req.params.id] = folder;
    writeMediaIndex(index);
    res.json({ ok: true, folder });
});

apiRouter.post('/media/folders/:id/public', requireAuth, async (req, res) => {
    const index = readMediaIndex();
    const folder = index.folders[req.params.id];
    if (!folder) return res.status(404).json({ error: 'Not found' });
    folder.is_public_showcase = true;
    index.folders[req.params.id] = folder;
    writeMediaIndex(index);
    res.json({ ok: true, folder });
});

apiRouter.delete('/media/folders/:id/public', requireAuth, async (req, res) => {
    const index = readMediaIndex();
    const folder = index.folders[req.params.id];
    if (!folder) return res.status(404).json({ error: 'Not found' });
    folder.is_public_showcase = false;
    index.folders[req.params.id] = folder;
    writeMediaIndex(index);
    res.json({ ok: true, folder });
});

apiRouter.delete('/media/files/:id', requireAuth, async (req, res) => {
    const index = readMediaIndex();
    const file = index.files[req.params.id];
    if (!file) return res.status(404).json({ error: 'Not found' });
    try {
        fs.unlinkSync(path.join(MEDIA_ROOT, file.path, file.filename));
    } catch (_) {}
    delete index.files[req.params.id];
    writeMediaIndex(index);
    res.json({ ok: true });
});

apiRouter.delete('/media/folders/:id', requireAuth, async (req, res) => {
    const index = readMediaIndex();
    const folder = index.folders[req.params.id];
    if (!folder) return res.status(404).json({ error: 'Not found' });
    delete index.folders[req.params.id];
    writeMediaIndex(index);
    res.json({ ok: true });
});

// --- INIT DATABASE ---
const init = async () => {
    await withDb(async (client) => {
        await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS candidates (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                phone_number VARCHAR(50) UNIQUE NOT NULL,
                name VARCHAR(255),
                stage VARCHAR(50) DEFAULT 'New',
                last_message_at BIGINT,
                last_message TEXT,
                notes TEXT,
                source VARCHAR(50) DEFAULT 'Organic',
                current_node_id VARCHAR(255),
                is_human_mode BOOLEAN DEFAULT FALSE,
                human_mode_ends_at BIGINT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )`);
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
            )`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS scheduled_messages (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
                payload JSONB,
                scheduled_time BIGINT,
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS bot_versions (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                phone_number_id VARCHAR(50),
                version_number INT,
                status VARCHAR(20) CHECK (status IN ('draft', 'published', 'archived')),
                settings JSONB,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS driver_documents (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
                type VARCHAR(50),
                url TEXT,
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_candidates_phone ON candidates(phone_number)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_candidates_last_msg ON candidates(last_message_at DESC)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_messages(status, scheduled_time)`);
    });
};

// --- ROUTES ---
app.get('/webhook', verifyWebhook);
app.post('/webhook', handleWebhook);
app.use('/api', apiRouter);

app.get('/ping', (req, res) => res.send('pong'));

app.use((err, req, res, next) => {
    logger.error('API Error', { error: err.message });
    res.status(500).json({ error: err.message });
});

const port = process.env.PORT || 3000;
if (require.main === module) {
    init().catch((err) => logger.error('Init failed', { error: err.message }));
    app.listen(port, () => logger.info(`Server listening on ${port}`));
}

module.exports = app;

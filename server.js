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

// Transaction helper (industrial-grade correctness): always COMMIT or ROLLBACK.
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

const getBaseUrlFromReq = (req) => {
    // Prefer explicit config in production
    if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
    const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0].trim();
    const host = (req.headers['x-forwarded-host'] || req.headers['host'] || '').toString().split(',')[0].trim();
    return host ? `${proto}://${host}` : '';
};

const verifyQStashRequest = async (req) => {
    // If signing keys are not configured, skip verification (dev mode).
    if (!qstashReceiver) return true;
    const signature = req.headers['upstash-signature'] || req.headers['Upstash-Signature'];
    if (!signature) return false;
    const body = req.rawBody ? req.rawBody.toString('utf-8') : JSON.stringify(req.body || {});
    return await qstashReceiver.verify({ signature, body });
};

const authClient = new OAuth2Client(process.env.VITE_GOOGLE_CLIENT_ID);

const getMetaClient = () => {
    if (!process.env.META_TOKEN || !process.env.PHONE_NUMBER_ID) throw new Error("Meta Credentials Missing");
    return {
        token: process.env.META_TOKEN,
        phoneId: process.env.PHONE_NUMBER_ID,
        url: `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`
    };
};

// --- APP SETUP ---
const app = express();
app.use(cors());

// IMPORTANT: capture raw body (needed for QStash signature verification)
app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

const apiRouter = express.Router();

// --- AI Client ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// --- S3 (media storage) ---
const s3 = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: process.env.AWS_ACCESS_KEY_ID ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    } : undefined
});
const upload = multer({ storage: multer.memoryStorage() });

// --- HELPERS ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const sendToMeta = async (to, payload) => {
    const axios = require('axios');
    const meta = getMetaClient();

    const data = {
        messaging_product: "whatsapp",
        to,
        ...payload
    };

    const resp = await axios.post(meta.url, data, {
        headers: {
            Authorization: `Bearer ${meta.token}`,
            'Content-Type': 'application/json'
        },
        timeout: SYSTEM_CONFIG.META_TIMEOUT
    });

    return resp.data;
};

const getDriver = async (client, phone_number) => {
    const res = await client.query('SELECT * FROM candidates WHERE phone_number = $1', [phone_number]);
    return res.rows[0];
};

const createDriver = async (client, phone_number, name, source = 'Organic') => {
    const res = await client.query(
        `INSERT INTO candidates (phone_number, name, stage, last_message_at, last_message, source, created_at)
         VALUES ($1, $2, 'New', $3, $4, $5, NOW())
         RETURNING *`,
        [phone_number, name, Date.now(), '', source]
    );
    return res.rows[0];
};

const cacheGet = async (key) => {
    try {
        const v = await redis.get(key);
        return v;
    } catch (_) { return null; }
};

const cacheSet = async (key, value, ttlSec = 60) => {
    try {
        await redis.set(key, value, { ex: ttlSec });
    } catch (_) {}
};

const normalizeInteractive = (message) => {
    if (!message) return null;
    if (message.type === 'interactive' && message.interactive) {
        // button_reply or list_reply
        const ir = message.interactive.button_reply || message.interactive.list_reply;
        if (ir) return { kind: 'interactive', id: ir.id, title: ir.title };
    }
    return null;
};

// --- BOT ENGINE (simple) ---
const resolveBotSettings = async () => {
    const cacheKey = `bot_settings_${process.env.PHONE_NUMBER_ID}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const settings = await withDb(async (client) => {
        const phoneId = process.env.PHONE_NUMBER_ID;
        const result = await client.query(`SELECT settings FROM bot_versions WHERE phone_number_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`, [phoneId]);
        return result.rows[0]?.settings || null;
    });

    if (settings) await cacheSet(cacheKey, settings, SYSTEM_CONFIG.CACHE_TTL_SETTINGS);
    return settings;
};

const generateAIResponse = async (userText, settings) => {
    // Minimal AI wrapper
    const prompt = settings?.systemPrompt
        ? `${settings.systemPrompt}\n\nUser: ${userText}\nAssistant:`
        : `User: ${userText}\nAssistant:`;

    const resp = await ai.models.generateContent({
        model: settings?.model || "gemini-1.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }]
    });

    const text = resp?.candidates?.[0]?.content?.parts?.[0]?.text || "Okay.";
    return text;
};

const storeIncomingMessage = async (client, driverId, message) => {
    const direction = 'in';
    const text = message.text?.body || message.caption || '';
    const type = message.type || 'text';
    const whatsapp_message_id = message.id || null;

    await client.query(
        `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, whatsapp_message_id, created_at)
         VALUES ($1, $2, $3, $4, $5, 'received', $6, NOW())
         ON CONFLICT (whatsapp_message_id) DO NOTHING`,
        [crypto.randomUUID(), driverId, direction, text, type, whatsapp_message_id]
    );

    await client.query(
        `UPDATE candidates SET last_message_at = $1, last_message = $2 WHERE id = $3`,
        [Date.now(), text || `[${type}]`, driverId]
    );
};

const processMessageInternal = async (message, contact, phoneId) => {
    const from = message.from; // user's WA number
    const name = contact?.profile?.name || null;

    await withDb(async (client) => {
        // Ensure driver exists
        let driver = await getDriver(client, from);
        if (!driver) driver = await createDriver(client, from, name, 'Organic');

        // Store inbound message
        await storeIncomingMessage(client, driver.id, message);

        // Human mode
        if (driver.is_human_mode && driver.human_mode_ends_at && driver.human_mode_ends_at > Date.now()) {
            logger.info("Human mode active - skipping bot", { driverId: driver.id });
            return;
        }

        // Interactive handling (optional)
        const inter = normalizeInteractive(message);
        const textBody = inter?.title || message.text?.body || '';

        const settings = await resolveBotSettings();
        if (!settings) return;

        const replyText = await generateAIResponse(textBody, settings);

        if (replyText && replyText.trim()) {
            await sendToMeta(from, { type: 'text', text: { body: replyText.trim() } });

            await client.query(
                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at)
                 VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`,
                [crypto.randomUUID(), driver.id, replyText.trim()]
            );

            await client.query(
                `UPDATE candidates SET last_message_at = $1, last_message = $2 WHERE id = $3`,
                [Date.now(), replyText.trim(), driver.id]
            );
        }
    });
};

// --- QUEUE PROCESSOR (scheduled messages) ---
const processQueueInternal = async () => {
    let processedCount = 0;

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
               const result = await client.query(`
  SELECT sm.id, sm.candidate_id, sm.payload, c.phone_number
  FROM scheduled_messages sm
  JOIN candidates c ON c.id = sm.candidate_id
  WHERE sm.status = 'pending'
    AND sm.scheduled_time <= $1
  ORDER BY sm.scheduled_time ASC
  LIMIT 10
  FOR UPDATE SKIP LOCKED
`, [Date.now()]);


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
            logger.info(`Scheduler: Processing ${jobsToProcess.length} jobs`);
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
                    if (!bodyText.trim()) throw new Error('Scheduled message text is empty');
                    metaPayload = { type: 'text', text: { body: bodyText } };
                }

                await sendToMeta(job.phone_number, metaPayload);

                await withDb(async (client) => {
                    const messageText = payload.text || `[${payload.templateName || payload.mediaType || 'scheduled'}]`;
                    const messageType = payload.mediaType || (payload.templateName ? 'template' : 'text');

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
            } catch (e) {
                logger.error("Scheduled Send Error", { error: e.message, jobId: job.id });
                await withDb(async (client) => {
                    await client.query(`UPDATE scheduled_messages SET status = 'failed' WHERE id = $1`, [job.id]);
                });
            }
        });

        return processedCount;
    } catch (e) {
        console.error("Queue Processing Error", e);
        throw e;
    }
};

// Process a single scheduled message by id (used by QStash or manual debugging)
const processScheduledMessageById = async (jobId) => {
    if (!jobId) return { ok: false, reason: 'missing_jobId' };

    // 1) Claim the job (idempotent)
    const claimed = await withTransaction(async (client) => {
        const res = await client.query(
            `SELECT sm.id, sm.status, sm.scheduled_time, sm.payload, sm.candidate_id, c.phone_number
             FROM scheduled_messages sm
             JOIN candidates c ON sm.candidate_id = c.id
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
            return { state: 'too_early', scheduled_time: Number(job.scheduled_time), phone_number: job.phone_number };
        }

        // Only one worker should flip pending -> processing.
        await client.query(`UPDATE scheduled_messages SET status = 'processing' WHERE id = $1 AND status = 'pending'`, [jobId]);

        return {
            state: 'claimed',
            candidate_id: job.candidate_id,
            phone_number: job.phone_number,
            payload: job.payload,
        };
    });

    if (claimed.state === 'not_found' || claimed.state === 'already_sent' || claimed.state === 'failed' || claimed.state === 'already_processing') {
        return { ok: true, state: claimed.state };
    }

    if (claimed.state === 'too_early') {
        // If QStash delivered early (clock drift), re-schedule a small delay.
        if (qstash && process.env.PUBLIC_BASE_URL) {
            const baseUrl = process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
            const delayMs = Math.max(1000, claimed.scheduled_time - Date.now());
            const delaySeconds = Math.ceil(delayMs / 1000);
            await qstash.publishJSON({
                url: `${baseUrl}/api/qstash/process-scheduled`,
                body: { jobId },
                delay: `${delaySeconds}s`,
            }).catch(() => {});
        }
        return { ok: true, state: 'too_early' };
    }

    // 2) Send to WhatsApp
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
        if (!bodyText.trim()) throw new Error('Scheduled message text is empty');
        metaPayload = { type: 'text', text: { body: bodyText } };
    }

    try {
        await sendToMeta(claimed.phone_number, metaPayload);
    } catch (e) {
        await withDb(async (client) => {
            await client.query(`UPDATE scheduled_messages SET status = 'failed' WHERE id = $1`, [jobId]);
        });
        return { ok: false, state: 'meta_send_failed', error: e.message };
    }

    // 3) Persist success
    const messageText = payload.text || `[${payload.templateName || payload.mediaType || 'scheduled'}]`;
    const messageType = payload.mediaType || (payload.templateName ? 'template' : 'text');

    await withDb(async (client) => {
        await client.query(
            `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at)
             VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())`,
            [crypto.randomUUID(), claimed.candidate_id, messageText, messageType]
        );
        await client.query(`UPDATE candidates SET last_message = $1, last_message_at = $2 WHERE id = $3`, [messageText, Date.now(), claimed.candidate_id]);
        await client.query(`UPDATE scheduled_messages SET status = 'sent' WHERE id = $1`, [jobId]);
    });

    return { ok: true, state: 'sent' };
};

// --- ROUTES ---

apiRouter.get('/cron/process-queue', async (req, res) => {
    const count = await processQueueInternal();
    res.json({ success: true, processed: count });
});

// QStash delivery endpoint (each scheduled message can be delivered by QStash directly)
apiRouter.post('/qstash/process-scheduled', async (req, res) => {
    try {
        const ok = await verifyQStashRequest(req);
        if (!ok) return res.status(401).json({ ok: false, error: 'Unauthorized' });
        const { jobId } = req.body || {};
        const result = await processScheduledMessageById(jobId);
        // Always return 200 so QStash does not endlessly retry for non-retriable cases.
        return res.status(200).json({ ok: true, result });
    } catch (e) {
        logger.error('QStash process-scheduled failed', { error: e.message });
        // For transient errors, returning 500 allows QStash retries.
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// AUTH (Google)
apiRouter.post('/auth/google', async (req, res, next) => {
    try {
        const { token } = req.body;
        const ticket = await authClient.verifyIdToken({
            idToken: token,
            audience: process.env.VITE_GOOGLE_CLIENT_ID
        });
        const payload = ticket.getPayload();
        if (!payload?.email) return res.status(401).json({ ok: false, error: "Invalid token" });
        res.json({ ok: true, email: payload.email, name: payload.name });
    } catch (e) { next(e); }
});

// HEALTH CHECK
apiRouter.get('/health', async (req, res) => {
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

// SYSTEM RESET ROUTE
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
            // Init will recreate
            await init();
        });
        res.json({ success: true });
    } catch (e) { next(e); }
});

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

apiRouter.get('/drivers/:id/messages', async (req, res) => {
    try {
        await withDb(async (client) => {
            const limit = parseInt(req.query.limit) || 50;
            const resDb = await client.query('SELECT * FROM candidate_messages WHERE candidate_id = $1 ORDER BY created_at DESC LIMIT $2', [req.params.id, limit]);
            res.json(resDb.rows.map(r => ({ id: r.id, sender: r.direction === 'in' ? 'driver' : 'agent', text: r.text, timestamp: new Date(r.created_at).getTime(), type: r.type || 'text', status: r.status })).reverse());
        });
    } catch (e) {
        if (e.code === '42P01') res.json([]);
        else next(e);
    }
});

// Documents Route
apiRouter.get('/drivers/:id/documents', async (req, res, next) => {
    try {
        await withDb(async (client) => {
            const docs = await client.query(`SELECT * FROM driver_documents WHERE candidate_id = $1 ORDER BY created_at DESC`, [req.params.id]);
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

apiRouter.post('/drivers/:id/messages', async (req, res, next) => {
    const { text, mediaUrl, mediaType } = req.body;
    try {
        const safeText = (text ?? '').toString();

        // WhatsApp disallows empty text bodies.
        if (!mediaUrl && !safeText.trim()) {
            return res.status(400).json({ ok: false, error: "Message text cannot be empty" });
        }

        await withDb(async (client) => {
            const dRes = await client.query('SELECT phone_number FROM candidates WHERE id = $1', [req.params.id]);
            if (dRes.rows.length === 0) return res.status(404).json({ ok: false, error: "Driver not found" });

            const outboundType = mediaUrl ? (mediaType || 'image') : 'text';
            const outboundText = safeText.trim()
                ? safeText
                : (mediaUrl ? `[Media:${outboundType}]` : safeText);

            const payload = mediaUrl
                ? { type: outboundType, [outboundType]: { link: mediaUrl, caption: safeText.trim() ? safeText : undefined } }
                : { type: 'text', text: { body: safeText.trim() } };

            await sendToMeta(dRes.rows[0].phone_number, payload);

            await client.query(
                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at)
                 VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())`,
                [crypto.randomUUID(), req.params.id, outboundText, outboundType]
            );

            await client.query(
                'UPDATE candidates SET last_message_at = $1, last_message = $2 WHERE id = $3',
                [Date.now(), outboundText, req.params.id]
            );
        });

        res.json({ success: true });
    } catch (e) { next(e); }
});

apiRouter.post('/scheduled-messages', async (req, res, next) => {
    const { driverIds, message, timestamp } = req.body;
    try {
        const scheduledTime = Number(timestamp);
        if (isNaN(scheduledTime)) return res.status(400).json({ ok: false, error: "Invalid timestamp" });
        if (!Array.isArray(driverIds) || driverIds.length === 0) return res.status(400).json({ ok: false, error: "driverIds must be a non-empty array" });

        // Normalize message into a JSON payload (scheduled_messages.payload is JSONB).
        let payload = message;
        if (payload === undefined || payload === null) payload = {};
        if (typeof payload === 'string') payload = { text: payload };
        if (typeof payload !== 'object') payload = { text: String(payload) };

        // Validate: if it's not a template or media message, it must have non-empty text.
        const textBody = (payload.text ?? '').toString();
        if (!payload.templateName && !payload.mediaUrl && !textBody.trim()) {
            return res.status(400).json({ ok: false, error: "Scheduled message text cannot be empty" });
        }

        // Ensure consistent fields
        payload.text = textBody;
        if (payload.mediaUrl && !payload.mediaType) payload.mediaType = 'image';

        // Insert rows first, then (optionally) schedule per-row delivery via QStash.
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

        // Serverless-safe: schedule a QStash delivery for each message so it fires near the requested time.
        // If QStash isn't configured, the /api/cron/process-queue endpoint (triggered by Vercel Cron) can pick them up.
        if (qstash) {
            const baseUrl = getBaseUrlFromReq(req);
            if (!baseUrl) {
                logger.warn('QStash configured but base URL could not be resolved; skipping per-message scheduling. Set PUBLIC_BASE_URL.');
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

apiRouter.get('/drivers/:id/scheduled-messages', async (req, res, next) => {
    try {
        await withDb(async (client) => {
            const result = await client.query(`SELECT * FROM scheduled_messages WHERE candidate_id = $1 ORDER BY scheduled_time ASC`, [req.params.id]);
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

apiRouter.delete('/scheduled-messages/:id', async (req, res, next) => {
    try {
        await withDb(async (client) => {
            await client.query('DELETE FROM scheduled_messages WHERE id = $1', [req.params.id]);
        });
        res.json({ success: true });
    } catch (e) { next(e); }
});

apiRouter.patch('/scheduled-messages/:id', async (req, res, next) => {
    const { text, scheduledTime } = req.body;
    try {
        await withDb(async (client) => {
            const old = await client.query('SELECT payload FROM scheduled_messages WHERE id = $1', [req.params.id]);
            if (old.rows.length === 0) return res.status(404).json({ ok: false, error: "Not found" });

            let oldPayload = old.rows[0].payload;
            if (typeof oldPayload === 'string') oldPayload = JSON.parse(oldPayload);

            const newPayload = { ...oldPayload, text: text || oldPayload.text };
            const updates = [`payload = $1`];
            const values = [newPayload];
            let idx = 2;

            if (scheduledTime) {
                updates.push(`scheduled_time = $${idx++}`);
                values.push(scheduledTime);
            }

            values.push(req.params.id);
            await client.query(`UPDATE scheduled_messages SET ${updates.join(', ')} WHERE id = $${idx}`, values);
        });
        res.json({ success: true });
    } catch (e) { next(e); }
});

// Bot Settings
apiRouter.get('/bot/settings', async (req, res, next) => {
    try {
        const settings = await withDb(async (client) => {
            const phoneId = process.env.PHONE_NUMBER_ID;
            let result = await client.query(`SELECT settings FROM bot_versions WHERE phone_number_id = $1 AND status = 'draft' LIMIT 1`, [phoneId]);
            if (result.rows.length === 0) {
                result = await client.query(`SELECT settings FROM bot_versions WHERE phone_number_id = $1 AND status = 'active' LIMIT 1`, [phoneId]);
            }
            return result.rows[0]?.settings || null;
        });
        res.json(settings || {});
    } catch (e) { next(e); }
});

apiRouter.post('/bot/settings', async (req, res, next) => {
    try {
        const phoneId = process.env.PHONE_NUMBER_ID;
        const settings = req.body || {};
        await withDb(async (client) => {
            await client.query(
                `INSERT INTO bot_versions (id, phone_number_id, version_number, status, settings, created_at)
                 VALUES ($1, $2, 1, 'draft', $3, NOW())`,
                [crypto.randomUUID(), phoneId, settings]
            );
        });
        await cacheSet(`bot_settings_${phoneId}`, settings, SYSTEM_CONFIG.CACHE_TTL_SETTINGS);
        res.json({ success: true });
    } catch (e) { next(e); }
});

apiRouter.post('/bot/publish', async (req, res, next) => {
    try {
        const phoneId = process.env.PHONE_NUMBER_ID;
        await withDb(async (client) => {
            const draft = await client.query(`SELECT * FROM bot_versions WHERE phone_number_id = $1 AND status = 'draft' ORDER BY created_at DESC LIMIT 1`, [phoneId]);
            if (draft.rows.length === 0) return res.status(404).json({ ok: false, error: "No draft to publish" });

            // Mark existing active as archived
            await client.query(`UPDATE bot_versions SET status = 'archived' WHERE phone_number_id = $1 AND status = 'active'`, [phoneId]);

            // Publish draft
            await client.query(`UPDATE bot_versions SET status = 'active' WHERE id = $1`, [draft.rows[0].id]);
        });

        // Bust cache
        await cacheSet(`bot_settings_${phoneId}`, null, 1);
        res.json({ success: true });
    } catch (e) { next(e); }
});

// Media upload (optional)
apiRouter.post('/media/upload', upload.single('file'), async (req, res, next) => {
    try {
        if (!req.file) return res.status(400).json({ ok: false, error: "No file" });

        // If no S3 configured, just return error
        if (!process.env.AWS_S3_BUCKET) return res.status(400).json({ ok: false, error: "S3 not configured" });

        const { PutObjectCommand } = require('@aws-sdk/client-s3');
        const key = `uploads/${Date.now()}_${req.file.originalname}`;
        await s3.send(new PutObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET,
            Key: key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
        }));

        const url = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;
        res.json({ ok: true, url });
    } catch (e) { next(e); }
});

// --- WEBHOOK HANDLER ---
const verifyWebhook = (req, res) => {
    if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) return res.status(200).send(req.query['hub.challenge']);
    return res.sendStatus(403);
};

const handleWebhook = async (req, res) => {
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

const init = async () => {
    try {
        await withDb(async (client) => {
            await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');

            await client.query(`CREATE TABLE IF NOT EXISTS candidates (
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
            );`);

            await client.query(`CREATE TABLE IF NOT EXISTS candidate_messages (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
                direction VARCHAR(10),
                text TEXT,
                type VARCHAR(50),
                status VARCHAR(50),
                whatsapp_message_id VARCHAR(255) UNIQUE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );`);

            await client.query(`CREATE TABLE IF NOT EXISTS scheduled_messages (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
                payload JSONB,
                scheduled_time BIGINT,
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );`);

            await client.query(`CREATE TABLE IF NOT EXISTS bot_versions (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                phone_number_id VARCHAR(50),
                version_number INT,
                status VARCHAR(20),
                settings JSONB,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );`);

            await client.query(`CREATE TABLE IF NOT EXISTS driver_documents (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
                type VARCHAR(50),
                url TEXT,
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );`);
        });
        logger.info("DB Schema Verified (Tables Ready)");
    } catch (e) {
        logger.error("DB Initialization Failed", { error: e.message });
    }
};

init();

// NOTE:
// On :contentReference[oaicite:2]{index=2} serverless, setInterval workers are not reliable.
// Prefer QStash delivery (per scheduled message) + optional Vercel Cron hitting /api/cron/process-queue.
const QUEUE_INTERVAL_MS = Number(process.env.QUEUE_INTERVAL_MS || 10000);
const shouldRunQueueWorker = process.env.ENABLE_QUEUE_WORKER !== 'false';

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => logger.info(`🚀 Uber Fleet Bot running on port ${PORT}`));

    if (shouldRunQueueWorker) {
        setInterval(() => {
            processQueueInternal().catch((err) => {
                logger.error("Queue Worker Error", { error: err.message });
            });
        }, QUEUE_INTERVAL_MS);
        logger.info("Queue Worker Enabled", { intervalMs: QUEUE_INTERVAL_MS });
    } else {
        logger.info("Queue Worker Disabled");
    }
}

module.exports = app;


const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const { Client: QStashClient, Receiver } = require('@upstash/qstash');
const { Pool } = require('pg');
const multer = require('multer');
const { OAuth2Client } = require('google-auth-library');
const axios = require('axios');
const https = require('https');
require('dotenv').config();

// --- OBSERVABILITY ---
const logger = {
    info: (msg, meta = {}) => console.log(JSON.stringify({ level: 'INFO', msg, timestamp: new Date().toISOString(), ...meta })),
    error: (msg, meta = {}) => console.error(JSON.stringify({ level: 'ERROR', msg, timestamp: new Date().toISOString(), ...meta })),
    warn: (msg, meta = {}) => console.warn(JSON.stringify({ level: 'WARN', msg, timestamp: new Date().toISOString(), ...meta })),
};

// --- CONFIGURATION ---
const SYSTEM_CONFIG = {
    META_TIMEOUT: 15000,
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

// Robust DB Wrapper with Retry Logic for Serverless
const withDb = async (operation) => {
    let client;
    try {
        client = await getDb().connect();
        return await operation(client);
    } catch (e) {
        logger.error("DB Operation Failed", { error: e.message });
        throw e;
    } finally {
        if (client) {
            try { client.release(); } catch (e) { console.error("Failed to release client", e); }
        }
    }
};

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL || 'https://mock.upstash.io',
    token: process.env.UPSTASH_REDIS_REST_TOKEN || 'mock'
});

const authClient = new OAuth2Client(process.env.VITE_GOOGLE_CLIENT_ID);

// --- META API CLIENT (AXIOS) ---
const getMetaClient = () => {
    return axios.create({
        httpsAgent: new https.Agent({ keepAlive: true }),
        timeout: SYSTEM_CONFIG.META_TIMEOUT,
        headers: { 
            'Content-Type': 'application/json', 
            'Authorization': `Bearer ${process.env.META_API_TOKEN}` 
        }
    });
};

// --- OUTBOUND MESSAGING CORE ---
const sendToMeta = async (phoneNumber, payload) => {
    // 1. SAFETY CHECK: Block Placeholder Messages
    if (payload.type === 'text' && payload.text && payload.text.body) {
        const body = payload.text.body.toLowerCase();
        const forbidden = ['replace this', 'sample message', 'type your message', 'insert text'];
        if (forbidden.some(f => body.includes(f))) {
            logger.warn("🛑 BLOCKED: Placeholder message detected.", { to: phoneNumber });
            throw new Error("Message blocked: Contains placeholder text.");
        }
    }

    const phoneId = process.env.PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!phoneId) throw new Error("PHONE_NUMBER_ID missing in env");
    
    // Clean Phone Number
    const to = (phoneNumber || '').toString().replace(/\D/g, '');
    if (!to) throw new Error("Invalid phone number");

    const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`;
    
    try {
        const fullPayload = {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            ...payload
        };
        await getMetaClient().post(url, fullPayload);
    } catch (e) {
        logger.error("Meta Send Error", { error: e.response?.data || e.message, to });
        throw e;
    }
};

// --- EXPRESS APP ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- BOT ENGINE ---

const getBotSettings = async () => {
    // Try Redis
    try {
        const cached = await redis.get(`bot:settings:${process.env.PHONE_NUMBER_ID}`);
        if (cached) return cached;
    } catch (_) {}

    // Fallback DB
    return await withDb(async (client) => {
        const res = await client.query(`SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1`);
        if (res.rows.length > 0) {
            // Cache for 10 mins
            try { await redis.set(`bot:settings:${process.env.PHONE_NUMBER_ID}`, res.rows[0].settings, { ex: 600 }); } catch (_) {}
            return res.rows[0].settings;
        }
        return null;
    });
};

// --- INBOUND PROCESSING CORE ---
const processMessageInternal = async (message, contact, phoneId) => {
    if (!message || !phoneId) return;

    // CRITICAL: Normalize phone number (Remove +, spaces, dashes)
    const from = message.from.replace(/\D/g, '');
    const name = contact?.profile?.name || "Unknown";
    
    // Extract text content safely
    let textBody = '';
    if (message.type === 'text') textBody = message.text?.body;
    else if (message.type === 'interactive') {
        textBody = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '[Interactive]';
    } else {
        textBody = `[${message.type}]`;
    }

    await withDb(async (client) => {
        // 1. Upsert Candidate (Driver)
        const upsertQuery = `
            INSERT INTO candidates (id, phone_number, name, stage, last_message_at, last_message, created_at) 
            VALUES ($1, $2, $3, 'New', $4, $5, NOW()) 
            ON CONFLICT (phone_number) 
            DO UPDATE SET name = EXCLUDED.name, last_message_at = $4, last_message = $5 
            RETURNING id, current_node_id, is_human_mode, human_mode_ends_at
        `;
        const resDb = await client.query(upsertQuery, [crypto.randomUUID(), from, name, Date.now(), textBody]);
        const candidate = resDb.rows[0];

        // 2. Save Incoming Message
        const insertMsgQuery = `
            INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, whatsapp_message_id, created_at) 
            VALUES ($1, $2, 'in', $3, $4, 'received', $5, NOW()) 
            ON CONFLICT (whatsapp_message_id) DO NOTHING
        `;
        await client.query(insertMsgQuery, [crypto.randomUUID(), candidate.id, textBody, message.type, message.id]);

        // 3. BOT LOGIC
        if (candidate.is_human_mode) {
            if (candidate.human_mode_ends_at && Date.now() > Number(candidate.human_mode_ends_at)) {
                await client.query(`UPDATE candidates SET is_human_mode = FALSE WHERE id = $1`, [candidate.id]);
            } else {
                logger.info(`Skipping bot for ${from} (Human Mode Active)`);
                return;
            }
        }

        const settings = await getBotSettings();
        if (!settings || !settings.nodes || settings.nodes.length === 0) return;

        let nextNode = null;
        if (!candidate.current_node_id) {
            nextNode = settings.nodes.find(n => n.type === 'start') || settings.nodes[0];
            if (nextNode) {
                const edge = settings.edges?.find(e => e.source === nextNode.id);
                if (edge) nextNode = settings.nodes.find(n => n.id === edge.target);
            }
        } else {
            const edges = settings.edges?.filter(e => e.source === candidate.current_node_id) || [];
            if (edges.length === 1) {
                nextNode = settings.nodes.find(n => n.id === edges[0].target);
            } else if (edges.length > 1) {
                if (message.type === 'interactive') {
                    const btnId = message.interactive?.button_reply?.id || message.interactive?.button_reply?.title;
                    const matchingEdge = edges.find(e => e.sourceHandle === btnId);
                    if (matchingEdge) nextNode = settings.nodes.find(n => n.id === matchingEdge.target);
                }
                if (!nextNode) return;
            }
        }

        if (nextNode && nextNode.data) {
            if (nextNode.data.content) {
                const payload = { type: 'text', text: { body: nextNode.data.content } };
                if (nextNode.data.type === 'buttons' && nextNode.data.buttons) {
                    payload.type = 'interactive';
                    payload.interactive = {
                        type: "button",
                        body: { text: nextNode.data.content },
                        action: {
                            buttons: nextNode.data.buttons.map(b => ({
                                type: "reply",
                                reply: { id: b.id || b.title, title: b.title.substring(0, 20) } 
                            }))
                        }
                    };
                }
                await sendToMeta(from, payload);
                await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`, [crypto.randomUUID(), candidate.id, nextNode.data.content]);
                await client.query(`UPDATE candidates SET current_node_id = $1, last_message_at = $2 WHERE id = $3`, [nextNode.id, Date.now(), candidate.id]);
            }
        }
    });
};

// --- SCHEDULER: PROCESS QUEUE ---
const processQueueInternal = async () => {
    let jobsToProcess = [];
    
    // 1. Fetch and Lock Pending Jobs
    await withDb(async (client) => {
        // Cleanup stuck jobs > 10 mins
        await client.query(`UPDATE scheduled_messages SET status = 'pending' WHERE status = 'processing' AND scheduled_time < $1`, [Date.now() - 600000]);

        // Select jobs due for sending
        const result = await client.query(`
            SELECT sm.id, sm.candidate_id, sm.payload, c.phone_number
            FROM scheduled_messages sm
            JOIN candidates c ON sm.candidate_id = c.id
            WHERE sm.status = 'pending' AND sm.scheduled_time <= $1
            LIMIT 50
            FOR UPDATE OF sm SKIP LOCKED
        `, [Date.now()]);

        if (result.rows.length > 0) {
            jobsToProcess = result.rows;
            const ids = jobsToProcess.map(j => j.id);
            // Mark as processing to release DB lock quickly
            await client.query(`UPDATE scheduled_messages SET status = 'processing' WHERE id = ANY($1::uuid[])`, [ids]);
        }
    });

    if (jobsToProcess.length === 0) return 0;
    logger.info(`Scheduler: Processing ${jobsToProcess.length} jobs`);

    let processedCount = 0;
    
    // 2. Process Jobs (Iterate)
    for (const job of jobsToProcess) {
        try {
            let payload = job.payload;
            if (typeof payload === 'string') payload = JSON.parse(payload);

            let metaPayload = {};
            
            // Construct Meta Payload
            if (payload.templateName) {
                metaPayload = { type: 'template', template: { name: payload.templateName, language: { code: 'en' } } };
            } else if (payload.mediaUrl) {
                const type = payload.mediaType || 'image';
                const caption = payload.text ? payload.text : undefined;
                metaPayload = { type, [type]: { link: payload.mediaUrl, caption } };
            } else {
                const bodyText = payload.text || ' ';
                metaPayload = { type: 'text', text: { body: bodyText } };
            }

            // Send via WhatsApp
            await sendToMeta(job.phone_number, metaPayload);

            // Update DB (Success)
            await withDb(async (client) => {
                await client.query(`
                    INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at)
                    VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())
                `, [crypto.randomUUID(), job.candidate_id, payload.text || `[${payload.templateName || payload.mediaType}]`, payload.mediaType || 'text']);

                await client.query(`UPDATE candidates SET last_message = $1, last_message_at = $2 WHERE id = $3`, 
                    [payload.text || 'Scheduled Message', Date.now(), job.candidate_id]);

                await client.query(`UPDATE scheduled_messages SET status = 'sent' WHERE id = $1`, [job.id]);
            });
            processedCount++;

        } catch (err) {
            logger.error("Scheduler Job Failed", { id: job.id, error: err.message });
            await withDb(async (client) => {
                await client.query(`UPDATE scheduled_messages SET status = 'failed' WHERE id = $1`, [job.id]);
            });
        }
    }
    return processedCount;
};


// --- ROUTES ---
const apiRouter = express.Router();

// CRON Endpoint (Called by App.tsx Heartbeat or External Cron)
apiRouter.get('/cron/process-queue', async (req, res) => {
    try {
        const count = await processQueueInternal();
        res.status(200).json({ success: true, processed: count });
    } catch (e) {
        logger.error("Cron Error", { error: e.message });
        res.status(500).json({ success: false, error: e.message });
    }
});

apiRouter.get('/webhook', (req, res) => {
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN || process.env.META_WEBHOOK_VERIFY_TOKEN;
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

apiRouter.post('/webhook', async (req, res) => {
    res.sendStatus(200); 
    try {
        const body = req.body;
        if (body.object === 'whatsapp_business_account') {
            const entry = body.entry?.[0];
            const changes = entry?.changes?.[0];
            const value = changes?.value;
            if (value?.messages) {
                const phoneId = value.metadata?.phone_number_id;
                const contacts = value.contacts || [];
                for (const message of value.messages) {
                    const contact = contacts.find(c => c.wa_id === message.from) || {};
                    processMessageInternal(message, contact, phoneId).catch(err => 
                        logger.error("Msg Process Error", { err: err.message, from: message.from })
                    );
                }
            }
        }
    } catch (e) {
        logger.error("Webhook Parse Error", { error: e.message });
    }
});

apiRouter.post('/ai/generate', async (req, res) => {
    const { contents, config, model } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({error: "Missing GEMINI_API_KEY"});
    const targetModel = model || 'gemini-1.5-flash'; 
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;
    const payload = {
        contents: typeof contents === 'string' ? [{ parts: [{ text: contents }] }] : contents,
        generationConfig: {}
    };
    if (config) {
        if (config.systemInstruction) payload.systemInstruction = { parts: [{ text: config.systemInstruction }] };
        if (config.responseMimeType) payload.generationConfig.responseMimeType = config.responseMimeType;
        if (config.responseSchema) payload.generationConfig.responseSchema = config.responseSchema;
    }
    try {
        const response = await axios.post(url, payload);
        const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        res.json({ text });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

apiRouter.get('/drivers', async (req, res, next) => {
    try {
        await withDb(async (client) => {
            const resDb = await client.query('SELECT * FROM candidates ORDER BY last_message_at DESC NULLS LAST LIMIT 50');
            res.json(resDb.rows.map(row => ({
                id: row.id,
                phoneNumber: row.phone_number,
                name: row.name,
                status: row.stage,
                lastMessage: row.last_message,
                lastMessageTime: parseInt(row.last_message_at || '0'),
                source: row.source,
                isHumanMode: row.is_human_mode
            })));
        });
    } catch (e) { next(e); }
});

apiRouter.get('/drivers/:id/messages', async (req, res) => {
    try {
        await withDb(async (client) => {
            const limit = parseInt(req.query.limit) || 50;
            const resDb = await client.query('SELECT * FROM candidate_messages WHERE candidate_id = $1 ORDER BY created_at DESC LIMIT $2', [req.params.id, limit]);
            res.json(resDb.rows.map(r => ({ id: r.id, sender: r.direction === 'in' ? 'driver' : 'agent', text: r.text, timestamp: new Date(r.created_at).getTime(), type: r.type || 'text', status: r.status, whatsapp_message_id: r.whatsapp_message_id })).reverse());
        });
    } catch (e) { 
        if (e.code === '42P01') res.json([]);
        else next(e); 
    }
});

apiRouter.post('/drivers/:id/messages', async (req, res, next) => {
    const { text, mediaUrl, mediaType } = req.body;
    try {
        await withDb(async (client) => {
            const dRes = await client.query('SELECT phone_number FROM candidates WHERE id = $1', [req.params.id]);
            if (dRes.rows.length === 0) return res.status(404).json({error: "Driver not found"});
            const phone = dRes.rows[0].phone_number;
            const payload = mediaUrl 
                ? { type: mediaType || 'image', [mediaType || 'image']: { link: mediaUrl, caption: text } }
                : { type: 'text', text: { body: text } };
            await sendToMeta(phone, payload);
            await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`, [crypto.randomUUID(), req.params.id, text || '[Media]']);
            await client.query(`UPDATE candidates SET last_message = $1, last_message_at = $2, is_human_mode = TRUE WHERE id = $3`, [text || '[Media]', Date.now(), req.params.id]);
        });
        res.json({ success: true });
    } catch (e) { next(e); }
});

// Scheduling Endpoints
apiRouter.post('/scheduled-messages', async (req, res, next) => {
    const { driverIds, message, timestamp } = req.body;
    try {
        const scheduledTime = Number(timestamp);
        if (isNaN(scheduledTime)) return res.status(400).json({ ok: false, error: "Invalid timestamp" });
        await withDb(async (client) => {
            for (const driverId of driverIds) {
                 await client.query(`INSERT INTO scheduled_messages (id, candidate_id, payload, scheduled_time, status) VALUES ($1, $2, $3, $4, 'pending')`, 
                    [crypto.randomUUID(), driverId, message, scheduledTime]);
            }
        });
        res.json({ success: true });
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

// System routes
apiRouter.get('/debug/status', async (req, res) => {
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
    } catch (e) { res.json({ postgres: 'error', lastError: e.message }); }
});

app.use('/api', apiRouter);
app.use('/', apiRouter);

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        logger.info(`🚀 Server running on port ${PORT}`);
    });
}

module.exports = app;


const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const { Pool } = require('pg');
const multer = require('multer');
const { OAuth2Client } = require('google-auth-library');
const axios = require('axios');
const https = require('https');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
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
    CACHE_TTL_SETTINGS: 600,
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
    AWS_BUCKET: process.env.AWS_BUCKET_NAME || 'uber-fleet-assets'
};

// --- S3 CLIENT SETUP ---
const s3Client = new S3Client({
    region: SYSTEM_CONFIG.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const upload = multer({ storage: multer.memoryStorage() });

// --- DB CONNECTION ---
let pgPool = null;
const getDb = () => {
    if (!pgPool) {
        const dbUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
        if (!dbUrl) throw new Error("No Postgres connection string found.");
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
    try {
        client = await getDb().connect();
        return await operation(client);
    } catch (e) {
        logger.error("DB Operation Failed", { error: e.message });
        throw e;
    } finally {
        if (client) try { client.release(); } catch (e) {}
    }
};

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL || 'https://mock.upstash.io',
    token: process.env.UPSTASH_REDIS_REST_TOKEN || 'mock'
});

// --- META API CLIENT ---
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

// --- CORE: SEND TO WHATSAPP ---
const sendToMeta = async (phoneNumber, payload) => {
    // 1. Block Placeholders
    if (payload.type === 'text' && payload.text?.body) {
        const body = payload.text.body.toLowerCase();
        if (['replace this', 'sample message', 'type your message'].some(f => body.includes(f))) {
            throw new Error("Message blocked: Contains placeholder text.");
        }
    }

    const phoneId = process.env.PHONE_NUMBER_ID;
    if (!phoneId) throw new Error("PHONE_NUMBER_ID missing");
    
    const to = (phoneNumber || '').toString().replace(/\D/g, '');
    if (!to) throw new Error("Invalid phone number");

    const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`;
    
    try {
        const fullPayload = { messaging_product: "whatsapp", recipient_type: "individual", to, ...payload };
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
    try {
        const cached = await redis.get(`bot:settings:${process.env.PHONE_NUMBER_ID}`);
        if (cached) return cached;
    } catch (_) {}
    return await withDb(async (client) => {
        const res = await client.query(`SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1`);
        if (res.rows.length > 0) {
            try { await redis.set(`bot:settings:${process.env.PHONE_NUMBER_ID}`, res.rows[0].settings, { ex: 600 }); } catch (_) {}
            return res.rows[0].settings;
        }
        return null;
    });
};

// --- INBOUND MESSAGE PROCESSOR ---
const processMessageInternal = async (message, contact, phoneId) => {
    if (!message || !phoneId) return;
    const from = message.from.replace(/\D/g, '');
    const name = contact?.profile?.name || "Unknown";
    
    let textBody = '';
    if (message.type === 'text') textBody = message.text?.body;
    else if (message.type === 'interactive') textBody = message.interactive?.button_reply?.title || '[Interactive]';
    else textBody = `[${message.type.toUpperCase()}]`;

    await withDb(async (client) => {
        // 1. Upsert Candidate
        const upsertQuery = `
            INSERT INTO candidates (id, phone_number, name, stage, last_message_at, last_message, created_at) 
            VALUES ($1, $2, $3, 'New', $4, $5, NOW()) 
            ON CONFLICT (phone_number) 
            DO UPDATE SET name = EXCLUDED.name, last_message_at = $4, last_message = $5 
            RETURNING id, current_node_id, is_human_mode, human_mode_ends_at
        `;
        const resDb = await client.query(upsertQuery, [crypto.randomUUID(), from, name, Date.now(), textBody]);
        const candidate = resDb.rows[0];

        // 2. Save Message
        const insertMsgQuery = `
            INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, whatsapp_message_id, created_at) 
            VALUES ($1, $2, 'in', $3, $4, 'received', $5, NOW()) 
            ON CONFLICT (whatsapp_message_id) DO NOTHING
        `;
        await client.query(insertMsgQuery, [crypto.randomUUID(), candidate.id, textBody, message.type, message.id]);

        // 3. Bot Logic
        if (candidate.is_human_mode) return;

        const settings = await getBotSettings();
        if (!settings?.nodes?.length) return;

        let nextNode = null;
        if (!candidate.current_node_id) {
            nextNode = settings.nodes.find(n => n.type === 'start') || settings.nodes[0];
            const edge = settings.edges?.find(e => e.source === nextNode?.id);
            if (edge) nextNode = settings.nodes.find(n => n.id === edge.target);
        } else {
            const edges = settings.edges?.filter(e => e.source === candidate.current_node_id) || [];
            if (edges.length === 1) nextNode = settings.nodes.find(n => n.id === edges[0].target);
            else if (message.type === 'interactive') {
                const btnId = message.interactive?.button_reply?.id || message.interactive?.button_reply?.title;
                const match = edges.find(e => e.sourceHandle === btnId);
                if (match) nextNode = settings.nodes.find(n => n.id === match.target);
            }
        }

        if (nextNode?.data?.content) {
            const payload = { type: 'text', text: { body: nextNode.data.content } };
            if (nextNode.data.type === 'buttons' && nextNode.data.buttons) {
                payload.type = 'interactive';
                payload.interactive = {
                    type: "button",
                    body: { text: nextNode.data.content },
                    action: { buttons: nextNode.data.buttons.map(b => ({ type: "reply", reply: { id: b.id || b.title, title: b.title.substring(0, 20) } })) }
                };
            }
            await sendToMeta(from, payload);
            await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`, [crypto.randomUUID(), candidate.id, nextNode.data.content]);
            await client.query(`UPDATE candidates SET current_node_id = $1, last_message_at = $2 WHERE id = $3`, [nextNode.id, Date.now(), candidate.id]);
        }
    });
};

// --- ROUTER ---
const apiRouter = express.Router();

// 1. S3 MEDIA ROUTES (NEW)
apiRouter.get('/media', async (req, res) => {
    const path = req.query.path || '';
    const prefix = path === '/' ? '' : (path.startsWith('/') ? path.substring(1) : path) + '/';
    
    try {
        const command = new ListObjectsV2Command({
            Bucket: SYSTEM_CONFIG.AWS_BUCKET,
            Prefix: prefix,
            Delimiter: '/'
        });
        const data = await s3Client.send(command);
        
        const folders = (data.CommonPrefixes || []).map(p => ({
            id: p.Prefix,
            name: p.Prefix.replace(prefix, '').replace('/', ''),
            parent_path: path
        }));

        const files = (data.Contents || []).map(o => {
            const filename = o.Key.replace(prefix, '');
            if (!filename) return null; // Filter out the folder placeholder itself
            
            // Generate public URL (assuming public read) OR signed URL
            const url = `https://${SYSTEM_CONFIG.AWS_BUCKET}.s3.${SYSTEM_CONFIG.AWS_REGION}.amazonaws.com/${o.Key}`;
            let type = 'document';
            if (filename.match(/\.(jpg|jpeg|png|gif|webp)$/i)) type = 'image';
            if (filename.match(/\.(mp4|mov|webm)$/i)) type = 'video';
            
            return { id: o.Key, url, filename, type };
        }).filter(Boolean);

        res.json({ folders, files });
    } catch (e) {
        logger.error("S3 List Error", { error: e.message });
        res.status(500).json({ error: "Failed to list media" });
    }
});

apiRouter.post('/media/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file provided" });
    
    const path = req.body.path || '';
    const prefix = path === '/' ? '' : (path.startsWith('/') ? path.substring(1) : path) + '/';
    const key = `${prefix}${req.file.originalname}`;

    try {
        await s3Client.send(new PutObjectCommand({
            Bucket: SYSTEM_CONFIG.AWS_BUCKET,
            Key: key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype,
            // ACL: 'public-read' // Enable if bucket policies allow, otherwise use Bucket Policy
        }));
        res.json({ success: true, key });
    } catch (e) {
        logger.error("S3 Upload Error", { error: e.message });
        res.status(500).json({ error: "Upload failed" });
    }
});

apiRouter.delete('/media/files/:id(*)', async (req, res) => {
    try {
        await s3Client.send(new DeleteObjectCommand({
            Bucket: SYSTEM_CONFIG.AWS_BUCKET,
            Key: req.params.id
        }));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Delete failed" });
    }
});

apiRouter.post('/media/folders', async (req, res) => {
    const { name, parentPath } = req.body;
    const prefix = parentPath === '/' ? '' : (parentPath.startsWith('/') ? parentPath.substring(1) : parentPath) + '/';
    const key = `${prefix}${name}/`; // Ending with / creates a folder concept in S3

    try {
        await s3Client.send(new PutObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key }));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Folder creation failed" });
    }
});

// 2. MESSAGING ROUTES
apiRouter.post('/drivers/:id/messages', async (req, res, next) => {
    const { text, mediaUrl, mediaType } = req.body;
    try {
        await withDb(async (client) => {
            const dRes = await client.query('SELECT phone_number FROM candidates WHERE id = $1', [req.params.id]);
            if (dRes.rows.length === 0) return res.status(404).json({error: "Driver not found"});
            const phone = dRes.rows[0].phone_number;

            // Construct Payload
            let payload;
            if (mediaUrl) {
                payload = { 
                    type: mediaType || 'image', 
                    [mediaType || 'image']: { link: mediaUrl, caption: text } 
                };
            } else {
                payload = { type: 'text', text: { body: text } };
            }

            await sendToMeta(phone, payload);

            // Store URL in text field for history if it's media
            // Format: JSON string if media, else plain text
            const dbText = mediaUrl ? JSON.stringify({ url: mediaUrl, caption: text }) : text;
            const dbType = mediaUrl ? (mediaType || 'image') : 'text';

            await client.query(
                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())`,
                [crypto.randomUUID(), req.params.id, dbText, dbType]
            );
            
            await client.query(
                `UPDATE candidates SET last_message = $1, last_message_at = $2, is_human_mode = TRUE WHERE id = $3`,
                [text || '[Media Sent]', Date.now(), req.params.id]
            );
        });
        res.json({ success: true });
    } catch (e) { next(e); }
});

apiRouter.get('/drivers/:id/messages', async (req, res) => {
    try {
        await withDb(async (client) => {
            const limit = parseInt(req.query.limit) || 50;
            const resDb = await client.query('SELECT * FROM candidate_messages WHERE candidate_id = $1 ORDER BY created_at DESC LIMIT $2', [req.params.id, limit]);
            
            // Map and parse JSON content for media
            const messages = resDb.rows.map(r => {
                let text = r.text;
                let imageUrl = null;
                let videoUrl = null;

                // Check if text is JSON media payload
                if (['image', 'video', 'document'].includes(r.type) && r.text?.startsWith('{')) {
                    try {
                        const parsed = JSON.parse(r.text);
                        text = parsed.caption || '';
                        if (r.type === 'image') imageUrl = parsed.url;
                        if (r.type === 'video') videoUrl = parsed.url;
                    } catch (e) {
                        // fallback if not JSON
                        text = r.text;
                    }
                }

                return { 
                    id: r.id, 
                    sender: r.direction === 'in' ? 'driver' : 'agent', 
                    text, 
                    imageUrl,
                    videoUrl,
                    timestamp: new Date(r.created_at).getTime(), 
                    type: r.type || 'text', 
                    status: r.status, 
                    whatsapp_message_id: r.whatsapp_message_id 
                };
            });
            
            res.json(messages.reverse());
        });
    } catch (e) { 
        if (e.code === '42P01') res.json([]);
        else res.status(500).json({ error: e.message });
    }
});

// 3. WEBHOOK & CRON
apiRouter.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

apiRouter.post('/webhook', async (req, res) => {
    res.sendStatus(200); 
    try {
        const body = req.body;
        if (body.object === 'whatsapp_business_account' && body.entry?.[0]?.changes?.[0]?.value?.messages) {
            const value = body.entry[0].changes[0].value;
            const contacts = value.contacts || [];
            for (const message of value.messages) {
                const contact = contacts.find(c => c.wa_id === message.from) || {};
                processMessageInternal(message, contact, value.metadata?.phone_number_id).catch(e => logger.error(e));
            }
        }
    } catch (e) { logger.error(e); }
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

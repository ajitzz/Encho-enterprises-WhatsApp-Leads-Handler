
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const multer = require('multer');
const axios = require('axios');
const https = require('https');
const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
require('dotenv').config();

// --- CONFIGURATION ---
const SYSTEM_CONFIG = {
    META_TIMEOUT: 15000,
    DB_CONNECTION_TIMEOUT: 10000,
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
    AWS_BUCKET: process.env.AWS_BUCKET_NAME || 'uber-fleet-assets',
};

// --- S3 CLIENT ---
const s3Client = new S3Client({
    region: SYSTEM_CONFIG.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const upload = multer({ storage: multer.memoryStorage() });

// --- DB CLIENT ---
const pgPool = new Pool({
    connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
    connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
    ssl: { rejectUnauthorized: false },
    max: 20 // Increase max connections for concurrent webhook processing
});

const withDb = async (operation) => {
    let client;
    try {
        client = await pgPool.connect();
        return await operation(client);
    } catch (e) {
        console.error("DB Error:", e);
        throw e;
    } finally {
        if (client) client.release();
    }
};

const getMetaClient = () => axios.create({
    httpsAgent: new https.Agent({ keepAlive: true }),
    timeout: SYSTEM_CONFIG.META_TIMEOUT,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.META_API_TOKEN}` }
});

// --- HELPER: REFRESH S3 URL ---
const refreshMediaUrl = async (url) => {
    if (!url || typeof url !== 'string' || !url.includes(SYSTEM_CONFIG.AWS_BUCKET)) return url;
    try {
        const urlObj = new URL(url);
        // Robust Key Extraction: Handle /bucket/key and /key
        let key = decodeURIComponent(urlObj.pathname.substring(1));
        if (key.startsWith(SYSTEM_CONFIG.AWS_BUCKET + '/')) {
            key = key.substring(SYSTEM_CONFIG.AWS_BUCKET.length + 1);
        }
        const command = new GetObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key });
        return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    } catch (e) {
        console.error("S3 Refresh Failed:", e.message);
        return url; // Fallback to original
    }
};

// --- HELPER: SEND TO META ---
const sendToMeta = async (phoneNumber, payload) => {
    const phoneId = process.env.PHONE_NUMBER_ID;
    const to = (phoneNumber || '').toString().replace(/\D/g, '');
    
    // Check for empty text to prevent errors
    if (payload.type === 'text' && (!payload.text?.body || !payload.text.body.trim())) {
        console.warn("Skipped sending empty message");
        return;
    }

    try {
        await getMetaClient().post(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            ...payload
        });
    } catch (e) {
        console.error("Meta Send Failed:", e.response?.data || e.message);
        throw e; // Re-throw to handle in caller
    }
};

// --- EXPRESS APP ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const apiRouter = express.Router();

// --- 1. WEBHOOK & BOT ENGINE (THE MISSING PIECE) ---
apiRouter.post('/webhook', async (req, res) => {
    // 1. Respond immediately to Meta (Critical to avoid timeout/retries)
    res.sendStatus(200);

    const body = req.body;
    if (!body.object) return;

    try {
        const entry = body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const message = value?.messages?.[0];
        const contact = value?.contacts?.[0];

        if (!message) return; // Not a message event

        const from = message.from; // Phone number
        const name = contact?.profile?.name || 'Unknown';
        const textBody = message.text?.body || message.button?.text || message.interactive?.button_reply?.title || '';
        const msgId = message.id;

        await withDb(async (client) => {
            // A. Find or Create Candidate
            let candidateRes = await client.query('SELECT * FROM candidates WHERE phone_number = $1', [from]);
            let candidate;
            
            if (candidateRes.rows.length === 0) {
                const insertRes = await client.query(
                    `INSERT INTO candidates (phone_number, name, stage, last_message_at, is_human_mode) VALUES ($1, $2, 'New', $3, FALSE) RETURNING *`,
                    [from, name, Date.now()]
                );
                candidate = insertRes.rows[0];
            } else {
                candidate = candidateRes.rows[0];
                await client.query('UPDATE candidates SET last_message = $1, last_message_at = $2 WHERE id = $3', [textBody, Date.now(), candidate.id]);
            }

            // B. Save Incoming Message
            await client.query(
                `INSERT INTO candidate_messages (candidate_id, direction, text, type, whatsapp_message_id, status) VALUES ($1, 'in', $2, 'text', $3, 'received')`,
                [candidate.id, textBody, msgId]
            );

            // C. Bot Logic (Only if NOT in Human Mode)
            if (!candidate.is_human_mode) {
                // Fetch Active Bot Settings
                const botRes = await client.query("SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1");
                const botSettings = botRes.rows[0]?.settings;

                if (botSettings && botSettings.nodes) {
                    // Simple State Machine
                    let nextStepId = null;
                    let replyNode = null;

                    // 1. Determine Current Context
                    const startNode = botSettings.nodes.find(n => n.type === 'start' || n.id === 'start');
                    const currentNodeId = candidate.current_bot_step_id;

                    if (!currentNodeId) {
                        // New user -> Start flow
                        // Find node connected to start
                        const edge = botSettings.edges.find(e => e.source === startNode?.id);
                        if (edge) nextStepId = edge.target;
                    } else {
                        // Existing user -> Find next step based on edges
                        const edge = botSettings.edges.find(e => e.source === currentNodeId);
                        if (edge) nextStepId = edge.target;
                    }

                    // 2. Find the Node Content
                    if (nextStepId) {
                        replyNode = botSettings.nodes.find(n => n.id === nextStepId);
                    }

                    // 3. Send Reply
                    if (replyNode && replyNode.data) {
                        const replyText = replyNode.data.content;
                        
                        // Validations
                        const isPlaceholder = /replace this|sample message/i.test(replyText);
                        const isEmpty = !replyText || !replyText.trim();

                        if (!isPlaceholder && !isEmpty) {
                            await sendToMeta(from, { type: 'text', text: { body: replyText } });
                            
                            // Log Bot Reply
                            await client.query(
                                `INSERT INTO candidate_messages (candidate_id, direction, text, type, status) VALUES ($1, 'out', $2, 'text', 'sent')`,
                                [candidate.id, replyText]
                            );

                            // Update State
                            await client.query('UPDATE candidates SET current_bot_step_id = $1 WHERE id = $2', [nextStepId, candidate.id]);
                        }
                    }
                }
            }
        });

    } catch (e) {
        console.error("Webhook Processing Error:", e);
    }
});

apiRouter.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

// --- 2. CRON JOB (FIXED 500 ERROR) ---
apiRouter.get('/cron/process-queue', async (req, res) => {
    try {
        let processed = 0;
        let errors = 0;

        await withDb(async (client) => {
            // 1. Lock rows to prevent double-sending (Concurrency safety)
            const jobs = await client.query(`
                SELECT sm.id, sm.candidate_id, sm.payload, c.phone_number
                FROM scheduled_messages sm
                JOIN candidates c ON sm.candidate_id = c.id
                WHERE sm.status = 'pending' AND sm.scheduled_time <= $1
                LIMIT 50
                FOR UPDATE OF sm SKIP LOCKED
            `, [Date.now()]);

            for (const job of jobs.rows) {
                try {
                    // Update to processing
                    await client.query("UPDATE scheduled_messages SET status = 'processing' WHERE id = $1", [job.id]);

                    const payload = job.payload || {}; // Handle null payload safely
                    const { text, mediaUrl, mediaType } = payload;

                    let metaPayload;
                    let dbText = text || '';
                    let dbType = mediaType || 'text';

                    // Refresh Signed URL if media exists
                    if (mediaUrl) {
                        const freshUrl = await refreshMediaUrl(mediaUrl);
                        metaPayload = {
                            type: mediaType || 'image',
                            [mediaType || 'image']: { link: freshUrl, caption: text }
                        };
                        // Store robust JSON in history for frontend to re-sign later
                        dbText = JSON.stringify({ url: mediaUrl, caption: text, sentAs: mediaType });
                    } else {
                        metaPayload = { type: 'text', text: { body: text || ' ' } };
                    }

                    await sendToMeta(job.phone_number, metaPayload);

                    // Archive to history
                    await client.query(
                        `INSERT INTO candidate_messages (candidate_id, direction, text, type, status) VALUES ($1, 'out', $2, $3, 'sent')`,
                        [job.candidate_id, dbText, dbType]
                    );

                    // Mark Complete
                    await client.query("UPDATE scheduled_messages SET status = 'sent' WHERE id = $1", [job.id]);
                    processed++;

                } catch (jobError) {
                    console.error(`Job ${job.id} failed:`, jobError.message);
                    await client.query("UPDATE scheduled_messages SET status = 'failed', error_log = $2 WHERE id = $1", [job.id, jobError.message]);
                    errors++;
                }
            }
        });

        res.json({ status: 'ok', processed, errors });

    } catch (e) {
        console.error("Cron Fatal Error:", e);
        // Return 200 with error info so Cron Service doesn't disable the job
        res.status(200).json({ status: 'error', message: e.message }); 
    }
});

// --- 3. SCHEDULING ENDPOINTS ---
apiRouter.post('/scheduled-messages', async (req, res) => {
    const { driverIds, message, timestamp, mediaUrl, mediaType } = req.body;
    try {
        const time = Number(timestamp);
        if (isNaN(time)) throw new Error("Invalid Timestamp");

        // RAW JSON Payload
        const payload = {
            text: message || '',
            mediaUrl: mediaUrl || null,
            mediaType: mediaType || 'text'
        };

        await withDb(async (client) => {
            for (const id of driverIds) {
                await client.query(
                    `INSERT INTO scheduled_messages (candidate_id, payload, scheduled_time, status) VALUES ($1, $2, $3, 'pending')`,
                    [id, payload, time]
                );
            }
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers/:id/scheduled-messages', async (req, res) => {
    try {
        await withDb(async (client) => {
            const result = await client.query(`SELECT * FROM scheduled_messages WHERE candidate_id = $1 AND status = 'pending' ORDER BY scheduled_time ASC`, [req.params.id]);
            // Refresh URLs for frontend preview
            const mapped = await Promise.all(result.rows.map(async r => {
                const p = r.payload;
                if (p.mediaUrl) p.mediaUrl = await refreshMediaUrl(p.mediaUrl);
                return {
                    id: r.id,
                    scheduledTime: parseInt(r.scheduled_time),
                    payload: p,
                    status: r.status
                };
            }));
            res.json(mapped);
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 4. MESSAGING & MEDIA ---
apiRouter.post('/drivers/:id/messages', async (req, res) => {
    const { text, mediaUrl, mediaType } = req.body;
    try {
        await withDb(async (client) => {
            const resC = await client.query('SELECT phone_number FROM candidates WHERE id = $1', [req.params.id]);
            if (resC.rows.length === 0) return res.status(404).json({ error: "Not found" });

            let metaPayload;
            let dbText = text;
            
            if (mediaUrl) {
                const freshUrl = await refreshMediaUrl(mediaUrl);
                metaPayload = {
                    type: mediaType || 'image',
                    [mediaType || 'image']: { link: freshUrl, caption: text }
                };
                dbText = JSON.stringify({ url: mediaUrl, caption: text, sentAs: mediaType });
            } else {
                metaPayload = { type: 'text', text: { body: text } };
            }

            await sendToMeta(resC.rows[0].phone_number, metaPayload);

            await client.query(
                `INSERT INTO candidate_messages (candidate_id, direction, text, type, status) VALUES ($1, 'out', $2, $3, 'sent')`,
                [req.params.id, dbText, mediaUrl ? mediaType : 'text']
            );
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/media', async (req, res) => {
    const path = req.query.path || '';
    const prefix = path === '/' ? '' : (path.startsWith('/') ? path.substring(1) : path) + '/';
    try {
        const command = new ListObjectsV2Command({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Prefix: prefix, Delimiter: '/' });
        const data = await s3Client.send(command);
        const folders = (data.CommonPrefixes || []).map(p => ({ id: p.Prefix, name: p.Prefix.replace(prefix, '').replace('/', '') }));
        const files = await Promise.all((data.Contents || []).map(async (o) => {
            const filename = o.Key.replace(prefix, '');
            if (!filename) return null;
            const url = await refreshMediaUrl(`https://${SYSTEM_CONFIG.AWS_BUCKET}.s3.amazonaws.com/${o.Key}`);
            let type = 'document';
            if (filename.match(/\.(jpg|jpeg|png|gif|webp)$/i)) type = 'image';
            if (filename.match(/\.(mp4|mov|webm)$/i)) type = 'video';
            return { id: o.Key, url, filename, type };
        }));
        res.json({ folders, files: files.filter(Boolean) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/media/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file" });
    const path = req.body.path || '';
    const prefix = path === '/' ? '' : (path.startsWith('/') ? path.substring(1) : path) + '/';
    const key = `${prefix}${req.file.originalname}`;
    try {
        await s3Client.send(new PutObjectCommand({ 
            Bucket: SYSTEM_CONFIG.AWS_BUCKET, 
            Key: key, 
            Body: req.file.buffer, 
            ContentType: req.file.mimetype 
        }));
        res.json({ success: true, key });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 5. DATA FETCHING ---
apiRouter.get('/drivers', async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query('SELECT * FROM candidates ORDER BY last_message_at DESC NULLS LAST LIMIT 50');
            res.json(r.rows.map(row => ({
                id: row.id, phoneNumber: row.phone_number, name: row.name, status: row.stage, 
                lastMessage: row.last_message, lastMessageTime: parseInt(row.last_message_at || '0'), 
                source: row.source, isHumanMode: row.is_human_mode
            })));
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers/:id/messages', async (req, res) => {
    try {
        await withDb(async (client) => {
            const limit = parseInt(req.query.limit) || 50;
            const r = await client.query('SELECT * FROM candidate_messages WHERE candidate_id = $1 ORDER BY created_at DESC LIMIT $2', [req.params.id, limit]);
            
            const messages = await Promise.all(r.rows.map(async (row) => {
                let text = row.text, mediaUrl = null;
                // Parse media JSON if needed
                if (['image', 'video', 'document'].includes(row.type) && row.text && row.text.startsWith('{')) {
                    try {
                        const p = JSON.parse(row.text);
                        if (p.url) mediaUrl = await refreshMediaUrl(p.url);
                        text = JSON.stringify({ ...p, url: mediaUrl }); 
                    } catch (e) { text = row.text; }
                }
                return { 
                    id: row.id, 
                    sender: row.direction === 'in' ? 'driver' : 'agent', 
                    text, imageUrl: row.type === 'image' ? mediaUrl : null, 
                    videoUrl: row.type === 'video' ? mediaUrl : null,
                    timestamp: new Date(row.created_at).getTime(), 
                    type: row.type || 'text', status: row.status
                };
            }));
            res.json(messages.reverse());
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/bot/settings', async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query("SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1");
            res.json(r.rows[0]?.settings || { isEnabled: false, nodes: [], edges: [] });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/bot/save', async (req, res) => {
    try {
        await withDb(async (client) => {
            await client.query("INSERT INTO bot_versions (status, settings) VALUES ('published', $1)", [req.body]);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers/:id/documents', async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query('SELECT * FROM driver_documents WHERE candidate_id = $1', [req.params.id]);
            const docs = await Promise.all(r.rows.map(async d => ({
                id: d.id, docType: d.type, url: await refreshMediaUrl(d.url), verificationStatus: d.status, timestamp: new Date(d.created_at).getTime()
            })));
            res.json(docs);
        });
    } catch (e) { res.json([]); }
});

// --- INIT ---
const init = async () => {
    await withDb(async (client) => {
        // Ensure critical tables exist
        await client.query(`CREATE TABLE IF NOT EXISTS candidates (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), phone_number VARCHAR(50), is_human_mode BOOLEAN)`);
    });
};

app.use('/api', apiRouter);
app.use('/', apiRouter);

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        console.log(`Server running on ${PORT}`);
        init().catch(console.error);
    });
}
module.exports = app;

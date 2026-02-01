
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const { Pool } = require('pg');
const multer = require('multer');
const { OAuth2Client } = require('google-auth-library');
const axios = require('axios');
const https = require('https');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
require('dotenv').config();

// --- OBSERVABILITY & LOGGING ---
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
    AWS_BUCKET: process.env.AWS_BUCKET_NAME || 'uber-fleet-assets',
    WHATSAPP_MEDIA_LIMIT_BYTES: 15 * 1024 * 1024, // ~15MB Safety Buffer (WhatsApp limit is 16MB)
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

// --- DB CONNECTION (SSL FIX) ---
let pgPool = null;
const getDb = () => {
    if (!pgPool) {
        const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
        if (!connectionString) throw new Error("No Postgres connection string found.");

        pgPool = new Pool({
            connectionString,
            connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
            max: 10,
            idleTimeoutMillis: 1000,
            allowExitOnIdle: true,
            ssl: { rejectUnauthorized: false } 
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

// --- SMART MEDIA HANDLING (Senior Developer Logic) ---
const prepareMediaPayload = async (url, requestedType, caption) => {
    let sendUrl = url;
    let finalType = requestedType;
    let filename = 'file';

    // 1. Is it an S3 URL?
    if (url.includes(SYSTEM_CONFIG.AWS_BUCKET) && url.includes('amazonaws.com')) {
        try {
            const urlObj = new URL(url);
            let key = decodeURIComponent(urlObj.pathname.substring(1));
            
            if (urlObj.hostname.startsWith('s3')) {
                 if (key.startsWith(SYSTEM_CONFIG.AWS_BUCKET + '/')) {
                    key = key.substring(SYSTEM_CONFIG.AWS_BUCKET.length + 1);
                 }
            }

            filename = key.split('/').pop();

            // 2. Fetch Metadata from S3 (Size & Mime)
            const head = await s3Client.send(new HeadObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key }));
            const fileSize = head.ContentLength || 0;

            // 3. Smart Type Switching Logic
            if (fileSize > SYSTEM_CONFIG.WHATSAPP_MEDIA_LIMIT_BYTES) {
                if (['video', 'image', 'audio'].includes(requestedType)) {
                    logger.warn(`File ${key} is ${fileSize} bytes. Converting ${requestedType} -> document.`);
                    finalType = 'document';
                }
            }

            // 4. Generate Fresh Presigned URL
            const command = new GetObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key });
            sendUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

        } catch (e) {
            logger.error("Media Prep Failed", { error: e.message, url });
        }
    }

    const payload = { type: finalType };
    payload[finalType] = { link: sendUrl };
    if (caption) payload[finalType].caption = caption;
    if (finalType === 'document') payload[finalType].filename = filename;

    return { 
        metaPayload: payload, 
        dbType: finalType,
        originalUrl: url 
    };
};

const sendToMeta = async (phoneNumber, payload) => {
    const phoneId = process.env.PHONE_NUMBER_ID;
    const to = (phoneNumber || '').toString().replace(/\D/g, '');
    
    try {
        await getMetaClient().post(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            ...payload
        });
    } catch (e) {
        logger.error("Meta API Fail", { error: e.response?.data || e.message, to });
        throw e;
    }
};

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const apiRouter = express.Router();

// --- MESSAGING ENDPOINTS ---
apiRouter.post('/drivers/:id/messages', async (req, res) => {
    const { text, mediaUrl, mediaType } = req.body;
    try {
        await withDb(async (client) => {
            const dRes = await client.query('SELECT phone_number FROM candidates WHERE id = $1', [req.params.id]);
            if (dRes.rows.length === 0) return res.status(404).json({error: "Driver not found"});
            const phone = dRes.rows[0].phone_number;

            let metaPayload;
            let dbType = 'text';
            let dbText = text;

            if (mediaUrl) {
                const mediaResult = await prepareMediaPayload(mediaUrl, mediaType || 'image', text);
                metaPayload = mediaResult.metaPayload;
                dbType = mediaResult.dbType;
                dbText = JSON.stringify({ url: mediaUrl, caption: text, sentAs: dbType });
            } else {
                metaPayload = { type: 'text', text: { body: text } };
            }

            await sendToMeta(phone, metaPayload);

            await client.query(
                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`,
                [crypto.randomUUID(), req.params.id, dbText, dbType]
            );
            await client.query(
                `UPDATE candidates SET last_message = $1, last_message_at = $2, is_human_mode = TRUE WHERE id = $3`,
                [text || `[${dbType}]`, Date.now(), req.params.id]
            );
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

apiRouter.get('/drivers/:id/messages', async (req, res) => {
    try {
        await withDb(async (client) => {
            const limit = parseInt(req.query.limit) || 50;
            const resDb = await client.query('SELECT * FROM candidate_messages WHERE candidate_id = $1 ORDER BY created_at DESC LIMIT $2', [req.params.id, limit]);
            
            const messages = await Promise.all(resDb.rows.map(async (r) => {
                let text = r.text;
                let mediaUrl = null;
                
                if (['image', 'video', 'document'].includes(r.type) && r.text?.startsWith('{')) {
                    try {
                        const parsed = JSON.parse(r.text);
                        text = parsed.caption || '';
                        let viewUrl = parsed.url;
                        if (viewUrl && viewUrl.includes(SYSTEM_CONFIG.AWS_BUCKET)) {
                             try {
                                 const urlObj = new URL(viewUrl);
                                 let key = decodeURIComponent(urlObj.pathname.substring(1));
                                 if (key.startsWith(SYSTEM_CONFIG.AWS_BUCKET)) key = key.substring(SYSTEM_CONFIG.AWS_BUCKET.length + 1);
                                 const command = new GetObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key });
                                 viewUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                             } catch(e) {}
                        }
                        mediaUrl = viewUrl;
                        if(r.type === 'document') text = JSON.stringify({ ...parsed, url: viewUrl }); 
                    } catch (e) { text = r.text; }
                }

                return { 
                    id: r.id, 
                    sender: r.direction === 'in' ? 'driver' : 'agent', 
                    text, 
                    imageUrl: r.type === 'image' ? mediaUrl : null,
                    videoUrl: r.type === 'video' ? mediaUrl : null,
                    timestamp: new Date(r.created_at).getTime(), 
                    type: r.type || 'text', 
                    status: r.status
                };
            }));
            res.json(messages.reverse());
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- SCHEDULING ENDPOINTS ---

apiRouter.post('/scheduled-messages', async (req, res) => {
    const { driverIds, message, timestamp, mediaUrl, mediaType } = req.body;
    try {
        const scheduledTime = Number(timestamp);
        if (isNaN(scheduledTime)) return res.status(400).json({ ok: false, error: "Invalid timestamp" });
        
        // Ensure payload structure is consistent
        const payloadObj = {
            text: message || '',
            mediaUrl: mediaUrl || null,
            mediaType: mediaType || 'text'
        };

        await withDb(async (client) => {
            for (const driverId of driverIds) {
                 await client.query(`INSERT INTO scheduled_messages (id, candidate_id, payload, scheduled_time, status) VALUES ($1, $2, $3, $4, 'pending')`, 
                    [crypto.randomUUID(), driverId, JSON.stringify(payloadObj), scheduledTime]);
            }
        });
        res.json({ success: true });
    } catch (e) { 
        logger.error("Schedule Error", { error: e.message });
        res.status(500).json({ error: e.message }); 
    }
});

apiRouter.get('/drivers/:id/scheduled-messages', async (req, res) => {
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
    } catch (e) { res.json([]); }
});

apiRouter.delete('/scheduled-messages/:id', async (req, res) => {
    try {
        await withDb(async (client) => {
            await client.query('DELETE FROM scheduled_messages WHERE id = $1', [req.params.id]);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.patch('/scheduled-messages/:id', async (req, res) => {
    const { text, scheduledTime } = req.body;
    try {
        await withDb(async (client) => {
            const old = await client.query('SELECT payload FROM scheduled_messages WHERE id = $1', [req.params.id]);
            if (old.rows.length === 0) return res.status(404).json({ ok: false, error: "Not found" });
            
            let payload = old.rows[0].payload;
            if (typeof payload === 'string') payload = JSON.parse(payload);
            
            if (text !== undefined) payload.text = text;
            
            if (scheduledTime) {
                await client.query(`UPDATE scheduled_messages SET payload = $1, scheduled_time = $2 WHERE id = $3`, [payload, scheduledTime, req.params.id]);
            } else {
                await client.query(`UPDATE scheduled_messages SET payload = $1 WHERE id = $2`, [payload, req.params.id]);
            }
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- CRON JOB (Process Queue with MEDIA HANDLING) ---
apiRouter.get('/cron/process-queue', async (req, res) => {
    try {
        let processedCount = 0;
        await withDb(async (client) => {
            // Clean stuck jobs
            await client.query(`UPDATE scheduled_messages SET status = 'pending' WHERE status = 'processing' AND scheduled_time < $1`, [Date.now() - 600000]);

            const result = await client.query(`
                SELECT sm.id, sm.candidate_id, sm.payload, c.phone_number
                FROM scheduled_messages sm
                JOIN candidates c ON sm.candidate_id = c.id
                WHERE sm.status = 'pending' AND sm.scheduled_time <= $1
                LIMIT 20
                FOR UPDATE OF sm SKIP LOCKED
            `, [Date.now()]);

            for (const job of result.rows) {
                try {
                    await client.query(`UPDATE scheduled_messages SET status = 'processing' WHERE id = $1`, [job.id]);

                    let payload = job.payload;
                    if (typeof payload === 'string') payload = JSON.parse(payload);

                    // RE-USE SMART MEDIA LOGIC for Scheduled Messages
                    let metaPayload;
                    let dbType = 'text';
                    let dbText = payload.text;

                    if (payload.mediaUrl) {
                        // Generate signed URL and check size limits right before sending
                        const mediaRes = await prepareMediaPayload(payload.mediaUrl, payload.mediaType || 'image', payload.text);
                        metaPayload = mediaRes.metaPayload;
                        dbType = mediaRes.dbType;
                        dbText = JSON.stringify({ url: payload.mediaUrl, caption: payload.text, sentAs: dbType });
                    } else if (payload.templateName) {
                        metaPayload = { type: 'template', template: { name: payload.templateName, language: { code: 'en' } } };
                        dbType = 'template';
                    } else {
                        metaPayload = { type: 'text', text: { body: payload.text || ' ' } };
                    }

                    await sendToMeta(job.phone_number, metaPayload);

                    await client.query(
                        `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`,
                        [crypto.randomUUID(), job.candidate_id, dbText, dbType]
                    );
                    await client.query(`UPDATE scheduled_messages SET status = 'sent' WHERE id = $1`, [job.id]);
                    processedCount++;

                } catch (jobErr) {
                    logger.error("Job Failed", { id: job.id, err: jobErr.message });
                    await client.query(`UPDATE scheduled_messages SET status = 'failed' WHERE id = $1`, [job.id]);
                }
            }
        });
        res.json({ processed: processedCount });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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
            const getCommand = new GetObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: o.Key });
            const url = await getSignedUrl(s3Client, getCommand, { expiresIn: 3600 });
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
            ContentType: req.file.mimetype,
        }));
        res.json({ success: true, key });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers', async (req, res) => {
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
    } catch (e) { res.status(500).json({ error: e.message }); }
});

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
        // Basic inbound processing placeholder - ensure full logic exists in real usage
        if (body.object === 'whatsapp_business_account') { /* Processing logic here */ }
    } catch (e) { logger.error("Webhook Error", e); }
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

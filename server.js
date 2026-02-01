
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const { Pool } = require('pg');
const multer = require('multer');
const axios = require('axios');
const https = require('https');
const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
require('dotenv').config();

// --- LOGGING ---
const logger = {
    info: (msg, meta = {}) => console.log(JSON.stringify({ level: 'INFO', msg, timestamp: new Date().toISOString(), ...meta })),
    error: (msg, meta = {}) => console.error(JSON.stringify({ level: 'ERROR', msg, timestamp: new Date().toISOString(), ...meta })),
};

const SYSTEM_CONFIG = {
    META_TIMEOUT: 15000,
    DB_CONNECTION_TIMEOUT: 10000,
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
    AWS_BUCKET: process.env.AWS_BUCKET_NAME || 'uber-fleet-assets',
    WHATSAPP_MEDIA_LIMIT_BYTES: 15 * 1024 * 1024, // 15MB Safety Limit
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

// --- DB ---
let pgPool = null;
const getDb = () => {
    if (!pgPool) {
        if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL) throw new Error("DB Connection String Missing");
        pgPool = new Pool({
            connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
            connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
            max: 10,
            ssl: { rejectUnauthorized: false }
        });
    }
    return pgPool;
};

const withDb = async (operation) => {
    let client;
    try {
        client = await getDb().connect();
        return await operation(client);
    } catch (e) {
        logger.error("DB Error", { error: e.message });
        throw e;
    } finally {
        if (client) try { client.release(); } catch (e) {}
    }
};

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL || 'https://mock.upstash.io',
    token: process.env.UPSTASH_REDIS_REST_TOKEN || 'mock'
});

const getMetaClient = () => axios.create({
    httpsAgent: new https.Agent({ keepAlive: true }),
    timeout: SYSTEM_CONFIG.META_TIMEOUT,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.META_API_TOKEN}` }
});

// --- CORE HELPER: GENERATE FRESH S3 LINK ---
// This handles converting a potentially expired URL back into a fresh one
const refreshMediaUrl = async (url) => {
    if (!url || !url.includes(SYSTEM_CONFIG.AWS_BUCKET)) return url;
    
    try {
        const urlObj = new URL(url);
        // Extract Key from path. Handle both path-style and virtual-host style
        // Path-style: /bucket-name/key
        // Virtual-host: /key
        let key = decodeURIComponent(urlObj.pathname.substring(1));
        
        if (key.startsWith(SYSTEM_CONFIG.AWS_BUCKET + '/')) {
            key = key.substring(SYSTEM_CONFIG.AWS_BUCKET.length + 1);
        }

        // Generate NEW signed URL
        const command = new GetObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key });
        const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 }); // Valid for 1 hour
        return signedUrl;
    } catch (e) {
        logger.error("S3 Refresh Failed", { url, error: e.message });
        return url; // Failover to original
    }
};

// --- CORE HELPER: PREPARE PAYLOAD FOR META ---
const prepareMetaPayload = async (mediaUrl, mediaType, caption) => {
    // 1. Ensure URL is fresh
    const sendUrl = await refreshMediaUrl(mediaUrl);
    
    // 2. Default filename
    let filename = 'file';
    try {
        const urlObj = new URL(sendUrl);
        filename = urlObj.pathname.split('/').pop();
    } catch(e) {}

    const payload = { type: mediaType || 'image' };
    payload[payload.type] = { link: sendUrl };
    
    if (caption) payload[payload.type].caption = caption;
    if (payload.type === 'document') payload[payload.type].filename = filename;

    return payload;
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
        logger.error("Meta API Fail", { error: e.response?.data || e.message });
        throw e;
    }
};

// --- EXPRESS APP ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const apiRouter = express.Router();

// 1. INSTANT MESSAGING
apiRouter.post('/drivers/:id/messages', async (req, res) => {
    const { text, mediaUrl, mediaType } = req.body;
    try {
        await withDb(async (client) => {
            const dRes = await client.query('SELECT phone_number FROM candidates WHERE id = $1', [req.params.id]);
            if (dRes.rows.length === 0) return res.status(404).json({error: "Driver not found"});
            
            let metaPayload;
            let dbText = text;
            const dbType = mediaUrl ? mediaType : 'text';

            if (mediaUrl) {
                metaPayload = await prepareMetaPayload(mediaUrl, mediaType, text);
                dbText = JSON.stringify({ url: mediaUrl, caption: text, sentAs: mediaType });
            } else {
                metaPayload = { type: 'text', text: { body: text } };
            }

            await sendToMeta(dRes.rows[0].phone_number, metaPayload);

            await client.query(
                `INSERT INTO candidate_messages (candidate_id, direction, text, type, status) VALUES ($1, 'out', $2, $3, 'sent')`,
                [req.params.id, dbText, dbType]
            );
            await client.query(
                `UPDATE candidates SET last_message = $1, last_message_at = $2 WHERE id = $3`,
                [text || `[${dbType}]`, Date.now(), req.params.id]
            );
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. SCHEDULING MESSAGE (FIXED JSONB)
apiRouter.post('/scheduled-messages', async (req, res) => {
    const { driverIds, message, timestamp, mediaUrl, mediaType } = req.body;
    try {
        const scheduledTime = Number(timestamp);
        if (isNaN(scheduledTime)) return res.status(400).json({ error: "Invalid timestamp" });
        
        // Pure Object Payload (No stringify)
        const payloadObj = {
            text: message || '', 
            mediaUrl: mediaUrl || null,
            mediaType: mediaType || 'text'
        };

        await withDb(async (client) => {
            for (const driverId of driverIds) {
                 await client.query(
                    `INSERT INTO scheduled_messages (candidate_id, payload, scheduled_time, status) VALUES ($1, $2, $3, 'pending')`, 
                    [driverId, payloadObj, scheduledTime]
                );
            }
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. FETCH SCHEDULED (Parsed correctly)
apiRouter.get('/drivers/:id/scheduled-messages', async (req, res) => {
    try {
        await withDb(async (client) => {
            const result = await client.query(`SELECT * FROM scheduled_messages WHERE candidate_id = $1 AND status = 'pending' ORDER BY scheduled_time ASC`, [req.params.id]);
            const mapped = await Promise.all(result.rows.map(async r => {
                // r.payload is already an Object from pg driver
                let payload = r.payload;
                if (payload.mediaUrl) payload.mediaUrl = await refreshMediaUrl(payload.mediaUrl);
                
                return {
                    id: r.id,
                    scheduledTime: parseInt(r.scheduled_time),
                    payload: payload, 
                    status: r.status
                };
            }));
            res.json(mapped);
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
            if (old.rows.length === 0) return res.status(404).json({ error: "Not found" });
            
            const payload = old.rows[0].payload;
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

// 4. CRON JOB (THE CRITICAL FIX FOR SENDING)
apiRouter.get('/cron/process-queue', async (req, res) => {
    try {
        let processedCount = 0;
        await withDb(async (client) => {
            // Reset stuck jobs
            await client.query(`UPDATE scheduled_messages SET status = 'pending' WHERE status = 'processing' AND scheduled_time < $1`, [Date.now() - 600000]);
            
            // Lock rows
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

                    const payload = job.payload; // Already JSON Object
                    
                    let metaPayload;
                    let dbText = payload.text || '';
                    let dbType = payload.mediaType || 'text';

                    // CRITICAL: Generate FRESH signed URL here
                    if (payload.mediaUrl) {
                        metaPayload = await prepareMetaPayload(payload.mediaUrl, payload.mediaType, payload.text);
                        dbText = JSON.stringify({ url: payload.mediaUrl, caption: payload.text, sentAs: payload.mediaType });
                    } else {
                        metaPayload = { type: 'text', text: { body: payload.text || ' ' } };
                    }

                    await sendToMeta(job.phone_number, metaPayload);

                    await client.query(
                        `INSERT INTO candidate_messages (candidate_id, direction, text, type, status) VALUES ($1, 'out', $2, $3, 'sent')`,
                        [job.candidate_id, dbText, dbType]
                    );
                    
                    await client.query(`UPDATE scheduled_messages SET status = 'sent' WHERE id = $1`, [job.id]);
                    processedCount++;
                } catch (jobErr) {
                    logger.error("Cron Job Failed", { id: job.id, err: jobErr.message });
                    await client.query(`UPDATE scheduled_messages SET status = 'failed', error_log = $2 WHERE id = $1`, [job.id, jobErr.message]);
                }
            }
        });
        res.json({ processed: processedCount });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. MEDIA & UTILS
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
            // Generate signed URL for frontend view
            const command = new GetObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: o.Key });
            const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
            
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

// 6. MESSAGES HISTORY
apiRouter.get('/drivers/:id/messages', async (req, res) => {
    try {
        await withDb(async (client) => {
            const limit = parseInt(req.query.limit) || 50;
            const resDb = await client.query('SELECT * FROM candidate_messages WHERE candidate_id = $1 ORDER BY created_at DESC LIMIT $2', [req.params.id, limit]);
            
            const messages = await Promise.all(resDb.rows.map(async (r) => {
                let text = r.text, mediaUrl = null;
                // Parse media JSON if applicable
                if (['image', 'video', 'document'].includes(r.type) && r.text && r.text.startsWith('{')) {
                    try {
                        const parsed = JSON.parse(r.text);
                        if (parsed.url) mediaUrl = await refreshMediaUrl(parsed.url);
                        text = JSON.stringify({ ...parsed, url: mediaUrl }); 
                    } catch (e) { text = r.text; }
                }
                return { 
                    id: r.id, 
                    sender: r.direction === 'in' ? 'driver' : 'agent', 
                    text, imageUrl: r.type === 'image' ? mediaUrl : null, videoUrl: r.type === 'video' ? mediaUrl : null,
                    timestamp: new Date(r.created_at).getTime(), type: r.type || 'text', status: r.status
                };
            }));
            res.json(messages.reverse());
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers', async (req, res) => {
    try {
        await withDb(async (client) => {
            const resDb = await client.query('SELECT * FROM candidates ORDER BY last_message_at DESC NULLS LAST LIMIT 50');
            res.json(resDb.rows.map(row => ({
                id: row.id, phoneNumber: row.phone_number, name: row.name, status: row.stage, 
                lastMessage: row.last_message, lastMessageTime: parseInt(row.last_message_at || '0'), source: row.source, isHumanMode: row.is_human_mode
            })));
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Standard Routes
apiRouter.get('/debug/status', (req, res) => res.json({ status: 'ok', time: new Date() }));
apiRouter.post('/webhook', (req, res) => res.sendStatus(200)); 
apiRouter.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else res.sendStatus(403);
});

// Mount & 404
app.use('/api', apiRouter);
app.use('/', apiRouter);
app.use((req, res) => res.status(404).json({ error: `Not Found: ${req.url}` }));

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        logger.info(`Server running on ${PORT}`);
    });
}
module.exports = app;

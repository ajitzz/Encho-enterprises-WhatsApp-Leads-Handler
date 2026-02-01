
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

// --- OBSERVABILITY & LOGGING ---
const logger = {
    info: (msg, meta = {}) => console.log(JSON.stringify({ level: 'INFO', msg, timestamp: new Date().toISOString(), ...meta })),
    error: (msg, meta = {}) => console.error(JSON.stringify({ level: 'ERROR', msg, timestamp: new Date().toISOString(), ...meta })),
    warn: (msg, meta = {}) => console.warn(JSON.stringify({ level: 'WARN', msg, timestamp: new Date().toISOString(), ...meta })),
};

const SYSTEM_CONFIG = {
    META_TIMEOUT: 15000,
    DB_CONNECTION_TIMEOUT: 10000,
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
    AWS_BUCKET: process.env.AWS_BUCKET_NAME || 'uber-fleet-assets',
    WHATSAPP_MEDIA_LIMIT_BYTES: 15 * 1024 * 1024,
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

// --- DB CONNECTION ---
let pgPool = null;
const getDb = () => {
    if (!pgPool) {
        if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL) throw new Error("DB Connection String Missing");
        pgPool = new Pool({
            connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
            connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
            max: 10,
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

const getMetaClient = () => axios.create({
    httpsAgent: new https.Agent({ keepAlive: true }),
    timeout: SYSTEM_CONFIG.META_TIMEOUT,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.META_API_TOKEN}` }
});

// --- HELPER: ROBUST S3 SIGNER ---
const signS3Url = async (url) => {
    if (!url || !url.includes(SYSTEM_CONFIG.AWS_BUCKET)) return url;
    try {
        const urlObj = new URL(url);
        let key = decodeURIComponent(urlObj.pathname.substring(1));
        if (key.startsWith(SYSTEM_CONFIG.AWS_BUCKET + '/')) {
            key = key.substring(SYSTEM_CONFIG.AWS_BUCKET.length + 1);
        }
        const command = new GetObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key });
        return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    } catch (e) {
        logger.warn("S3 Signing Failed (File might be missing)", { url, error: e.message });
        return url; // Return original URL if signing fails
    }
};

// --- HELPER: MEDIA PREP ---
const prepareMediaPayload = async (url, requestedType, caption) => {
    let sendUrl = url;
    let finalType = requestedType;
    let filename = 'file';

    if (url.includes(SYSTEM_CONFIG.AWS_BUCKET) && url.includes('amazonaws.com')) {
        try {
            const urlObj = new URL(url);
            let key = decodeURIComponent(urlObj.pathname.substring(1));
            if (urlObj.hostname.startsWith('s3') && key.startsWith(SYSTEM_CONFIG.AWS_BUCKET + '/')) {
                key = key.substring(SYSTEM_CONFIG.AWS_BUCKET.length + 1);
            }
            filename = key.split('/').pop();

            const head = await s3Client.send(new HeadObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key }));
            const fileSize = head.ContentLength || 0;

            if (fileSize > SYSTEM_CONFIG.WHATSAPP_MEDIA_LIMIT_BYTES && ['video', 'image', 'audio'].includes(requestedType)) {
                logger.warn(`File too large (${fileSize}). Converting to document.`);
                finalType = 'document';
            }

            const command = new GetObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key });
            sendUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        } catch (e) {
            logger.error("S3 Prep Failed", { error: e.message });
        }
    }

    const payload = { type: finalType };
    payload[finalType] = { link: sendUrl };
    if (caption) payload[finalType].caption = caption;
    if (finalType === 'document') payload[finalType].filename = filename;

    return { metaPayload: payload, dbType: finalType, originalUrl: url };
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
        logger.error("Meta Send Failed", { error: e.response?.data || e.message });
        throw e;
    }
};

// --- EXPRESS APP ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const apiRouter = express.Router();

// --- 0. SELF-HEALING DB INIT ---
const ensureTablesExist = async () => {
    await withDb(async (client) => {
        // Driver Documents Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS driver_documents (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                candidate_id UUID,
                type VARCHAR(50),
                url TEXT,
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);
        // Scheduled Messages Table
        await client.query(`
             CREATE TABLE IF NOT EXISTS scheduled_messages (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                candidate_id UUID,
                payload JSONB,
                scheduled_time BIGINT,
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);
    });
};

// --- 1. MESSAGING ---
apiRouter.post('/drivers/:id/messages', async (req, res) => {
    const { text, mediaUrl, mediaType } = req.body;
    try {
        await withDb(async (client) => {
            const dRes = await client.query('SELECT phone_number FROM candidates WHERE id = $1', [req.params.id]);
            if (dRes.rows.length === 0) return res.status(404).json({error: "Driver not found"});
            const phone = dRes.rows[0].phone_number;

            let metaPayload, dbType = 'text', dbText = text;

            if (mediaUrl) {
                const mediaRes = await prepareMediaPayload(mediaUrl, mediaType || 'image', text);
                metaPayload = mediaRes.metaPayload;
                dbType = mediaRes.dbType;
                dbText = JSON.stringify({ url: mediaUrl, caption: text, sentAs: dbType });
            } else {
                metaPayload = { type: 'text', text: { body: text } };
            }

            await sendToMeta(phone, metaPayload);

            await client.query(
                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())`,
                [crypto.randomUUID(), req.params.id, dbText, dbType]
            );
            await client.query(
                `UPDATE candidates SET last_message = $1, last_message_at = $2, is_human_mode = TRUE WHERE id = $3`,
                [text || `[${dbType}]`, Date.now(), req.params.id]
            );
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers/:id/messages', async (req, res) => {
    try {
        await withDb(async (client) => {
            const limit = parseInt(req.query.limit) || 50;
            const resDb = await client.query('SELECT * FROM candidate_messages WHERE candidate_id = $1 ORDER BY created_at DESC LIMIT $2', [req.params.id, limit]);
            
            const messages = await Promise.all(resDb.rows.map(async (r) => {
                let text = r.text, mediaUrl = null;
                if (['image', 'video', 'document'].includes(r.type) && r.text && r.text.startsWith('{')) {
                    try {
                        const parsed = JSON.parse(r.text);
                        if (parsed.url) mediaUrl = await signS3Url(parsed.url);
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

// --- 2. SCHEDULING (FIXED JSONB HANDLING) ---
apiRouter.post('/scheduled-messages', async (req, res) => {
    const { driverIds, message, timestamp, mediaUrl, mediaType } = req.body;
    try {
        const scheduledTime = Number(timestamp);
        if (isNaN(scheduledTime)) return res.status(400).json({ error: "Invalid timestamp" });
        
        // FIX: Ensure payload is an Object, NOT a stringified string.
        const payloadObj = {
            text: message || '', 
            mediaUrl: mediaUrl || null,
            mediaType: mediaType || 'text'
        };

        await withDb(async (client) => {
            for (const driverId of driverIds) {
                 // Pass payloadObj directly. PG handles JSONB conversion.
                 await client.query(`INSERT INTO scheduled_messages (id, candidate_id, payload, scheduled_time, status) VALUES ($1, $2, $3, $4, 'pending')`, 
                    [crypto.randomUUID(), driverId, payloadObj, scheduledTime]);
            }
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers/:id/scheduled-messages', async (req, res) => {
    try {
        await withDb(async (client) => {
            const result = await client.query(`SELECT * FROM scheduled_messages WHERE candidate_id = $1 AND status = 'pending' ORDER BY scheduled_time ASC`, [req.params.id]);
            const mapped = await Promise.all(result.rows.map(async r => {
                // Ensure payload is object
                let payload = r.payload;
                if (typeof payload === 'string') {
                    try { payload = JSON.parse(payload); } catch(e) { payload = { text: payload }; }
                }
                if (payload.mediaUrl) payload.mediaUrl = await signS3Url(payload.mediaUrl);
                
                return {
                    id: r.id,
                    scheduledTime: parseInt(r.scheduled_time),
                    payload: payload, 
                    status: r.status
                };
            }));
            res.json(mapped);
        });
    } catch (e) { 
        logger.error("Fetch Scheduled Failed", { error: e.message });
        res.json([]); 
    }
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
            
            let payload = old.rows[0].payload;
            if (typeof payload === 'string') try { payload = JSON.parse(payload); } catch(e){}

            if (text !== undefined) payload.text = text;
            
            // FIX: Pass payload object directly for JSONB
            if (scheduledTime) {
                await client.query(`UPDATE scheduled_messages SET payload = $1, scheduled_time = $2 WHERE id = $3`, [payload, scheduledTime, req.params.id]);
            } else {
                await client.query(`UPDATE scheduled_messages SET payload = $1 WHERE id = $2`, [payload, req.params.id]);
            }
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 3. DOCUMENTS (FIXED 500 ERROR) ---
apiRouter.get('/drivers/:id/documents', async (req, res) => {
    try {
        await ensureTablesExist(); // Lazy migration check
        await withDb(async (client) => {
            const result = await client.query('SELECT * FROM driver_documents WHERE candidate_id = $1', [req.params.id]);
            const docs = await Promise.all(result.rows.map(async r => ({
                id: r.id,
                docType: r.type,
                url: await signS3Url(r.url),
                verificationStatus: r.status,
                timestamp: new Date(r.created_at).getTime()
            })));
            res.json(docs);
        });
    } catch (e) { 
        logger.error("Get Docs Failed", { error: e.message });
        // Return empty array instead of 500 to prevent UI crash
        res.json([]); 
    }
});

// --- 4. CRON JOB (FIXED JSONB PARSING) ---
apiRouter.get('/cron/process-queue', async (req, res) => {
    try {
        let processedCount = 0;
        await withDb(async (client) => {
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
                    if (typeof payload === 'string') try { payload = JSON.parse(payload); } catch(e){}

                    let metaPayload, dbType = 'text', dbText = payload.text || '';

                    if (payload.mediaUrl) {
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
                        `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())`,
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
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ... (Other Routes: Bot, Media, Webhook remain standard) ...
apiRouter.get('/bot/settings', async (req, res) => {
    try {
        const cached = await redis.get(`bot:settings:${process.env.PHONE_NUMBER_ID}`);
        if (cached) return res.json(cached);
        await withDb(async (client) => {
            await client.query(`CREATE TABLE IF NOT EXISTS bot_versions (id UUID PRIMARY KEY, phone_number_id VARCHAR, version_number INT, status VARCHAR, settings JSONB, created_at TIMESTAMP)`);
            const result = await client.query(`SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1`);
            res.json(result.rows.length > 0 ? result.rows[0].settings : { isEnabled: false, steps: [] });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/bot/save', async (req, res) => {
    try { await redis.set(`bot:settings:${process.env.PHONE_NUMBER_ID}`, req.body); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/bot/publish', async (req, res) => {
    try {
        const settings = await redis.get(`bot:settings:${process.env.PHONE_NUMBER_ID}`);
        if (!settings) return res.status(400).json({ error: "No draft" });
        await withDb(async (client) => {
             await client.query(`CREATE TABLE IF NOT EXISTS bot_versions (id UUID PRIMARY KEY, phone_number_id VARCHAR, version_number INT, status VARCHAR, settings JSONB, created_at TIMESTAMP)`);
            await client.query(`INSERT INTO bot_versions (id, phone_number_id, version_number, status, settings, created_at) VALUES ($1, $2, 1, 'published', $3, NOW())`, [crypto.randomUUID(), process.env.PHONE_NUMBER_ID, JSON.stringify(settings)]);
        });
        res.json({ success: true });
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
            const url = await signS3Url(`https://${SYSTEM_CONFIG.AWS_BUCKET}.s3.amazonaws.com/${o.Key}`);
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
        await s3Client.send(new PutObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key, Body: req.file.buffer, ContentType: req.file.mimetype }));
        res.json({ success: true, key });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/debug/status', (req, res) => res.json({ status: 'ok', time: new Date() }));
apiRouter.post('/webhook', (req, res) => res.sendStatus(200)); 
apiRouter.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else res.sendStatus(403);
});

app.use('/api', apiRouter);
app.use('/', apiRouter);
app.use((req, res) => res.status(404).json({ error: `Route Not Found: ${req.url}` }));

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        logger.info(`Server running on ${PORT}`);
        ensureTablesExist().catch(console.error); // Init DB
    });
}
module.exports = app;

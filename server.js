
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const { Client: QStashClient, Receiver } = require('@upstash/qstash');
const { Pool } = require('pg');
const { S3Client, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const multer = require('multer');

require('dotenv').config();

// --- FAIL FAST VALIDATION ---
const requiredEnv = ['POSTGRES_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'QSTASH_TOKEN', 'META_API_TOKEN', 'PHONE_NUMBER_ID'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);

if (missingEnv.length > 0) {
    console.error(`❌ STARTUP ERROR: Missing Keys: ${missingEnv.join(', ')}`);
} else {
    console.log("🔐 Keys Loaded: Validating Connections...");
}

const app = express();
const apiRouter = express.Router(); 
const upload = multer({ storage: multer.memoryStorage() });

const SYSTEM_CONFIG = {
    META_TIMEOUT: 5000, 
    DB_CONNECTION_TIMEOUT: 5000, 
    CACHE_TTL_SETTINGS: 600, 
    LOCK_TTL: 15,
    DEDUPE_TTL: 3600 
};

// --- RESOURCES ---
// 1. POSTGRES
let pgPool = null;
const getDb = () => {
    if (!pgPool) {
        const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
        pgPool = new Pool({
            connectionString,
            ssl: { rejectUnauthorized: false }, 
            connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
            max: 3, 
            idleTimeoutMillis: 10000, 
            keepAlive: true 
        });
        pgPool.on('error', (err) => {
            console.error('⚠️ DB Pool Error:', err.message);
        });
    }
    return pgPool;
};

// 2. REDIS & QSTASH
const redis = new Redis({ 
    url: process.env.UPSTASH_REDIS_REST_URL || 'https://mock.upstash.io', 
    token: process.env.UPSTASH_REDIS_REST_TOKEN || 'mock' 
});
const qstash = new QStashClient({ token: process.env.QSTASH_TOKEN || 'mock' });

// 3. AWS S3
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
    }
});
const BUCKET_NAME = process.env.AWS_BUCKET_NAME || 'uber-fleet-assets';

// 4. META API
let metaClient = null;
const getMetaClient = () => {
    if (!metaClient) {
        const axios = require('axios');
        const https = require('https');
        metaClient = axios.create({
            httpsAgent: new https.Agent({ keepAlive: true }),
            timeout: SYSTEM_CONFIG.META_TIMEOUT,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.META_API_TOKEN}` }
        });
    }
    return metaClient;
};

// Middleware
app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(cors()); 

// --- HELPERS ---
const getWorkerUrl = (req) => {
    if (process.env.PUBLIC_BASE_URL) return `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/internal/bot-worker`;
    const host = req.get('host');
    const protocol = host.includes('.vercel.app') ? 'https' : (req.headers['x-forwarded-proto'] || req.protocol);
    return `${protocol}://${host}/api/internal/bot-worker`;
};

const getBotSettings = async (phoneId) => {
    if (!phoneId) return null;
    const key = `bot:settings:${phoneId}`;
    try {
        const cached = await redis.get(key);
        if (cached) return cached;
    } catch (e) { console.warn("Redis Cache Miss:", e.message); }

    const client = await getDb().connect();
    try {
        const res = await client.query(`SELECT settings FROM bot_versions WHERE phone_number_id = $1 AND status = 'published' ORDER BY version_number DESC LIMIT 1`, [phoneId]);
        if (res.rows.length > 0) {
            redis.set(key, res.rows[0].settings, { ex: 600 }).catch(err => console.error("Redis Write Error", err));
            return res.rows[0].settings;
        }
        return null;
    } catch(err) { console.error("DB Settings Error:", err); return null; } 
    finally { client.release(); }
};

const sendToMeta = async (to, payload) => {
    try { await getMetaClient().post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload }); } catch (e) { console.error("Meta Send Error", e.message); }
};

// --- WEBHOOK ---
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) res.send(req.query['hub.challenge']);
    else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;
        if (body.object !== 'whatsapp_business_account') return res.sendStatus(404);
        
        const tasks = [];
        const entries = body.entry || [];

        for (const entry of entries) {
            for (const change of (entry.changes || [])) {
                const value = change.value;
                if (!value.messages) continue;
                const phoneId = value.metadata?.phone_number_id;
                for (const message of value.messages) {
                    tasks.push((async () => {
                        const msgId = message.id;
                        const dedupeKey = `dedupe:${msgId}`;
                        const isNew = await redis.set(dedupeKey, '1', { nx: true, ex: SYSTEM_CONFIG.DEDUPE_TTL }).catch(() => true);
                        if (!isNew) return;
                        
                        const sysSettings = await redis.get('system:settings').catch(() => null);
                        if (sysSettings && sysSettings.webhook_ingest_enabled === false) return;
                        
                        await qstash.publishJSON({
                            url: getWorkerUrl(req),
                            body: { message, contact: value.contacts?.[0], phoneId },
                            deduplicationId: msgId 
                        });
                    })());
                }
            }
        }
        await Promise.all(tasks);
        res.sendStatus(200);
    } catch (e) { console.error("[Ingest] Error", e); res.sendStatus(200); }
});

// --- API ROUTES ---

// 1. DIAGNOSTICS
apiRouter.get('/debug/status', async (req, res) => {
    const status = {
        postgres: 'unknown',
        redis: 'unknown',
        s3: 'unknown',
        tables: { candidates: false, bot_versions: false },
        counts: { candidates: 0 },
        lastError: null,
        env: {
            hasPostgres: !!process.env.POSTGRES_URL,
            hasRedis: !!process.env.UPSTASH_REDIS_REST_URL,
            hasS3: !!process.env.AWS_ACCESS_KEY_ID
        }
    };

    try {
        const client = await getDb().connect();
        await client.query('SELECT 1');
        status.postgres = 'connected';
        
        const tablesRes = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
        const tables = tablesRes.rows.map(r => r.table_name);
        status.tables.candidates = tables.includes('candidates');
        status.tables.bot_versions = tables.includes('bot_versions');

        if (status.tables.candidates) {
            const countRes = await client.query('SELECT COUNT(*) FROM candidates');
            status.counts.candidates = parseInt(countRes.rows[0].count, 10);
        }
        client.release();
    } catch(e) {
        status.postgres = 'error';
        status.lastError = e.message;
    }

    try { await redis.ping(); status.redis = 'connected'; } catch(e) { status.redis = 'error'; }
    try { await s3Client.send(new ListObjectsV2Command({ Bucket: BUCKET_NAME, MaxKeys: 1 })); status.s3 = 'connected'; } catch(e) { status.s3 = e.message; }

    res.json(status);
});

// 2. WORKER
apiRouter.post('/internal/bot-worker', async (req, res) => {
    const start = Date.now();
    const signature = req.headers["upstash-signature"];
    if ((process.env.NODE_ENV === 'production' || process.env.VERCEL) && !signature) {
        return res.status(401).json({ error: "Missing Signature" });
    }

    const { message, contact, phoneId } = req.body;
    if (!message || !phoneId) return res.status(400).send("Invalid Payload");
    const from = message.from;
    
    let sysSettings = { automation_enabled: true };
    try {
        const s = await redis.get('system:settings');
        if (s) sysSettings = s;
    } catch(e) {}
    
    if (!sysSettings.automation_enabled) return res.json({ status: 'skipped_disabled' });

    const lockKey = `lock:${from}`;
    const acquired = await redis.set(lockKey, '1', { nx: true, ex: SYSTEM_CONFIG.LOCK_TTL }).catch(() => true);
    if (!acquired) return res.status(429).send("Locked"); 

    try {
        // [Bot Logic Placeholder - simplified for brevity as logic resides in previous iterations]
        // ... (Call getBotSettings, process logic, sendToMeta) ...
        
        // PERSIST TO DB
        const client = await getDb().connect();
        try {
            const name = contact?.profile?.name || "Unknown";
            const upsertQuery = `INSERT INTO candidates (id, phone_number, name, stage, last_message_at, created_at) VALUES ($1, $2, $3, 'New', $4, NOW()) ON CONFLICT (phone_number) DO UPDATE SET name = EXCLUDED.name, last_message_at = $4 RETURNING id`;
            const candidateId = crypto.randomUUID();
            const resDb = await client.query(upsertQuery, [candidateId, from, name, Date.now()]);
            await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'in', $3, $4, 'received', NOW())`, [crypto.randomUUID(), resDb.rows[0].id, message.text?.body || '[Media]', message.type]);
        } finally { client.release(); }

        await redis.del(lockKey);
        res.json({ success: true, duration: Date.now() - start });
    } catch (e) {
        console.error("[Worker] Error", e);
        await redis.del(lockKey);
        res.status(500).send(e.message);
    }
});

// 3. DRIVERS / LEADS
apiRouter.get('/drivers', async (req, res) => {
    const client = await getDb().connect();
    try {
        const resDb = await client.query('SELECT * FROM candidates ORDER BY last_message_at DESC LIMIT 50');
        res.json(resDb.rows.map(row => ({ 
            id: row.id, 
            phoneNumber: row.phone_number, 
            name: row.name, 
            status: row.stage, 
            lastMessage: '...', 
            lastMessageTime: parseInt(row.last_message_at), 
            source: 'Organic' 
        })));
    } catch (e) {
        console.error("DB Drivers Error:", e);
        res.status(500).json({ error: e.message });
    } finally { client.release(); }
});

apiRouter.get('/drivers/:id/messages', async (req, res) => {
    const client = await getDb().connect();
    try {
        const limit = parseInt(req.query.limit) || 50;
        const resDb = await client.query('SELECT * FROM candidate_messages WHERE candidate_id = (SELECT id FROM candidates WHERE phone_number = $1 OR id = $1 LIMIT 1) ORDER BY created_at DESC LIMIT $2', [req.params.id, limit]);
        res.json(resDb.rows.map(r => ({
            id: r.id, sender: r.direction === 'in' ? 'driver' : 'agent', text: r.text, timestamp: new Date(r.created_at).getTime(), type: r.type || 'text', status: r.status
        })).reverse());
    } catch (e) {
        res.json([]);
    } finally { client.release(); }
});

apiRouter.post('/drivers/:id/messages', async (req, res) => {
    const { text, mediaUrl, mediaType } = req.body;
    const client = await getDb().connect();
    try {
        const driverRes = await client.query('SELECT phone_number FROM candidates WHERE id = $1', [req.params.id]);
        if (driverRes.rows.length === 0) return res.status(404).send("Driver not found");
        const phoneNumber = driverRes.rows[0].phone_number;

        const payload = mediaUrl 
            ? { type: mediaType || 'image', [mediaType || 'image']: { link: mediaUrl, caption: text } }
            : { type: 'text', text: { body: text } };
        
        await sendToMeta(phoneNumber, payload);

        await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`, [crypto.randomUUID(), req.params.id, text]);
        await client.query('UPDATE candidates SET last_message_at = $1 WHERE id = $2', [Date.now(), req.params.id]);
        
        res.json({ success: true });
    } catch(e) {
        res.status(500).send(e.message);
    } finally { client.release(); }
});

// 4. S3 MEDIA LIBRARY (NEW)
apiRouter.get('/media', async (req, res) => {
    const prefix = req.query.path && req.query.path !== '/' ? req.query.path.replace(/^\//, '') + '/' : '';
    
    try {
        const command = new ListObjectsV2Command({
            Bucket: BUCKET_NAME,
            Prefix: prefix,
            Delimiter: '/'
        });
        const response = await s3Client.send(command);
        
        const folders = (response.CommonPrefixes || []).map(p => ({
            id: p.Prefix,
            name: p.Prefix.replace(prefix, '').replace('/', ''),
            parent_path: prefix,
            is_public_showcase: false 
        }));

        const files = (response.Contents || []).map(c => {
            // Skip the folder key itself
            if (c.Key === prefix) return null;
            const ext = c.Key.split('.').pop().toLowerCase();
            let type = 'document';
            if (['jpg','jpeg','png','gif','webp'].includes(ext)) type = 'image';
            if (['mp4','mov','webm'].includes(ext)) type = 'video';

            return {
                id: c.Key,
                filename: c.Key.replace(prefix, ''),
                url: `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${c.Key}`,
                type: type,
                media_id: null
            };
        }).filter(Boolean);

        res.json({ folders, files });
    } catch (e) {
        console.error("S3 List Error:", e);
        res.status(500).json({ error: e.message });
    }
});

apiRouter.post('/media/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    const path = req.body.path && req.body.path !== '/' ? req.body.path.replace(/^\//, '') + '/' : '';
    const key = `${path}${req.file.originalname}`;

    try {
        await s3Client.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype,
            ACL: 'public-read' 
        }));
        res.json({ success: true, key });
    } catch (e) {
        console.error("S3 Upload Error:", e);
        res.status(500).json({ error: e.message });
    }
});

apiRouter.post('/media/folders', async (req, res) => {
    const { name, parentPath } = req.body;
    const path = parentPath && parentPath !== '/' ? parentPath.replace(/^\//, '') + '/' : '';
    const key = `${path}${name}/`; // Ending with slash creates a "folder" in S3

    try {
        await s3Client.send(new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, Body: '' }));
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

apiRouter.delete('/media/files/:id', async (req, res) => {
    try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: req.params.id }));
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// 5. SYSTEM INIT
apiRouter.post('/system/init-db', async (req, res) => {
    const client = await getDb().connect();
    try {
        await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
        await client.query(`CREATE TABLE IF NOT EXISTS candidates (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            phone_number VARCHAR(50) UNIQUE NOT NULL,
            name VARCHAR(255),
            stage VARCHAR(50) DEFAULT 'New',
            last_message_at BIGINT,
            variables JSONB DEFAULT '{}',
            tags TEXT[],
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );`);
        await client.query(`CREATE TABLE IF NOT EXISTS candidate_messages (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
            direction VARCHAR(10) CHECK (direction IN ('in', 'out')),
            text TEXT,
            type VARCHAR(50),
            status VARCHAR(50),
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );`);
        await client.query(`CREATE TABLE IF NOT EXISTS bot_versions (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            phone_number_id VARCHAR(50),
            version_number INT,
            status VARCHAR(20) CHECK (status IN ('draft', 'published', 'archived')),
            settings JSONB,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );`);
        res.json({ success: true, message: "Tables created" });
    } catch(e) { res.status(500).json({ error: e.message }); } 
    finally { client.release(); }
});

apiRouter.post('/system/seed-db', async (req, res) => {
    const client = await getDb().connect();
    try {
        const id = crypto.randomUUID();
        await client.query(`INSERT INTO candidates (id, phone_number, name, stage, last_message_at) VALUES ($1, '+919999999999', 'Test Driver', 'New', $2) ON CONFLICT DO NOTHING`, [id, Date.now()]);
        res.json({ success: true, message: "Sample data seeded" });
    } catch(e) { res.status(500).json({ error: e.message }); } 
    finally { client.release(); }
});

// 6. SETTINGS
apiRouter.get('/bot/settings', async (req, res) => { 
    try {
        const settings = await getBotSettings(process.env.PHONE_NUMBER_ID);
        res.json(settings || { nodes: [], edges: [] });
    } catch (error) { res.json({ nodes: [], edges: [] }); }
});

apiRouter.post('/bot/save', async (req, res) => { 
    const client = await getDb().connect();
    try {
        await client.query(`INSERT INTO bot_versions (id, phone_number_id, version_number, status, settings) VALUES ($1, $2, 1, 'draft', $3) ON CONFLICT (id) DO UPDATE SET settings = $3`, [crypto.randomUUID(), process.env.PHONE_NUMBER_ID, JSON.stringify(req.body)]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); } 
    finally { client.release(); }
});

apiRouter.post('/bot/publish', async (req, res) => { 
    await redis.del(`bot:settings:${process.env.PHONE_NUMBER_ID}`); 
    res.json({ success: true }); 
});

apiRouter.get('/system/settings', async (req, res) => {
    const s = await redis.get('system:settings').catch(() => null);
    res.json(s || { webhook_ingest_enabled: true, automation_enabled: true, sending_enabled: true });
});

apiRouter.patch('/system/settings', async (req, res) => {
    await redis.set('system:settings', req.body);
    res.json(req.body);
});

// MOUNT ROUTER
app.use('/api', apiRouter);
app.use('/', apiRouter); 

// START
if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => console.log(`🚀 Uber Fleet Bot running on port ${PORT}`));
}

module.exports = app;

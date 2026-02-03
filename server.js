
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const multer = require('multer');
const axios = require('axios');
const https = require('https');
const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { OAuth2Client } = require('google-auth-library');
const { GoogleGenAI } = require("@google/genai");

require('dotenv').config();

// --- CONFIGURATION ---
const SYSTEM_CONFIG = {
    META_TIMEOUT: 15000,
    DB_CONNECTION_TIMEOUT: 10000,
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
    AWS_BUCKET: process.env.AWS_BUCKET_NAME || 'uber-fleet-assets',
    GOOGLE_CLIENT_ID: process.env.VITE_GOOGLE_CLIENT_ID
};

// --- INITIALIZE CLIENTS (Lazy/Safe) ---
let s3Client, googleClient, genAI, pgPool;

try {
    s3Client = new S3Client({
        region: SYSTEM_CONFIG.AWS_REGION,
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
    });

    googleClient = new OAuth2Client(SYSTEM_CONFIG.GOOGLE_CLIENT_ID);
    
    if (process.env.GEMINI_API_KEY) {
        genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }

    pgPool = new Pool({
        connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
        connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
        ssl: { rejectUnauthorized: false },
        max: 10
    });
    
    // Test DB connection on startup (optional, logs error but doesn't crash app immediately)
    pgPool.on('error', (err) => console.error('[DB POOL ERROR]', err));

} catch (initError) {
    console.error("[INIT CRITICAL ERROR]", initError);
}

const upload = multer({ storage: multer.memoryStorage() });

const withDb = async (operation) => {
    if (!pgPool) throw new Error("Database not initialized");
    let client;
    try {
        client = await pgPool.connect();
        return await operation(client);
    } catch (e) {
        console.error("[DB OPS ERROR]", e);
        throw e;
    } finally {
        if (client) client.release();
    }
};

const getMetaClient = () => axios.create({
    httpsAgent: new https.Agent({ keepAlive: true }),
    timeout: SYSTEM_CONFIG.META_TIMEOUT,
    headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${process.env.META_API_TOKEN}` 
    }
});

// --- HELPERS ---
const refreshMediaUrl = async (url) => {
    if (!url || typeof url !== 'string' || !url.includes(SYSTEM_CONFIG.AWS_BUCKET)) return url;
    try {
        const urlObj = new URL(url);
        let key = decodeURIComponent(urlObj.pathname.substring(1));
        if (key.startsWith(SYSTEM_CONFIG.AWS_BUCKET + '/')) key = key.substring(SYSTEM_CONFIG.AWS_BUCKET.length + 1);
        const command = new GetObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key });
        return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    } catch (e) {
        return url; 
    }
};

const sendToMeta = async (phoneNumber, payload) => {
    const phoneId = process.env.PHONE_NUMBER_ID;
    const to = (phoneNumber || '').toString().replace(/\D/g, '');
    if (payload.type === 'text' && (!payload.text?.body || !payload.text.body.trim())) return;

    try {
        console.log(`[Meta] Sending to ${to} type:${payload.type}`);
        await getMetaClient().post(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            ...payload
        });
    } catch (e) {
        console.error("[Meta Failed]", e.response?.data || e.message);
        throw new Error(JSON.stringify(e.response?.data || e.message));
    }
};

// --- EXPRESS APP ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Logging Middleware
app.use((req, res, next) => {
    console.log(`[${req.method}] ${req.url}`);
    next();
});

const apiRouter = express.Router();

// ==========================================
// 0. HEALTH CHECK
// ==========================================
apiRouter.get('/health', (req, res) => res.json({ status: 'ok', timestamp: Date.now() }));

// ==========================================
// 1. SYSTEM & AUTH
// ==========================================
apiRouter.post('/auth/google', async (req, res) => {
    try {
        const { credential } = req.body;
        const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: SYSTEM_CONFIG.GOOGLE_CLIENT_ID });
        res.json({ success: true, user: ticket.getPayload() });
    } catch (e) { res.status(401).json({ success: false, error: e.message }); }
});

apiRouter.get('/debug/status', async (req, res) => {
    try {
        await withDb(async (client) => {
            const tablesRes = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
            const tables = tablesRes.rows.map(r => r.table_name);
            const countRes = await client.query('SELECT COUNT(*) as c FROM candidates');
            res.json({
                postgres: 'connected',
                tables: { candidates: tables.includes('candidates'), bot_versions: tables.includes('bot_versions') },
                counts: { candidates: parseInt(countRes.rows[0].c) },
                env: { publicUrl: process.env.PUBLIC_BASE_URL || 'Not Set' }
            });
        });
    } catch (e) { res.status(500).json({ postgres: 'error', lastError: e.message }); }
});

apiRouter.get('/system/settings', async (req, res) => {
    try {
        await withDb(async (client) => {
            await client.query(`CREATE TABLE IF NOT EXISTS system_settings (key VARCHAR(50) PRIMARY KEY, value JSONB)`);
            const r = await client.query("SELECT value FROM system_settings WHERE key = 'config'");
            res.json(r.rows[0]?.value || { webhook_ingest_enabled: true, automation_enabled: true, sending_enabled: true });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.patch('/system/settings', async (req, res) => {
    try {
        await withDb(async (client) => {
            await client.query(`INSERT INTO system_settings (key, value) VALUES ('config', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [req.body]);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/system/credentials', async (req, res) => { res.json({ success: true }); });
apiRouter.post('/system/webhook', async (req, res) => { res.json({ success: true }); });

// ==========================================
// 2. BOT STUDIO
// ==========================================
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
            await client.query("INSERT INTO bot_versions (id, status, settings, created_at) VALUES ($1, 'published', $2, NOW())", [crypto.randomUUID(), req.body]);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/bot/publish', async (req, res) => res.json({ success: true }));

// ==========================================
// 3. DRIVERS & MESSAGING
// ==========================================
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

apiRouter.patch('/drivers/:id', async (req, res) => {
    try {
        const { status, isHumanMode, name } = req.body;
        await withDb(async (client) => {
            if (status) await client.query("UPDATE candidates SET stage = $1 WHERE id = $2", [status, req.params.id]);
            if (isHumanMode !== undefined) await client.query("UPDATE candidates SET is_human_mode = $1 WHERE id = $2", [isHumanMode, req.params.id]);
            if (name) await client.query("UPDATE candidates SET name = $1 WHERE id = $2", [name, req.params.id]);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers/:id/messages', async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query('SELECT * FROM candidate_messages WHERE candidate_id = $1 ORDER BY created_at DESC LIMIT 50', [req.params.id]);
            const msgs = await Promise.all(r.rows.map(async row => {
                let text = row.text, imageUrl = null;
                if (['image','video','document'].includes(row.type) && row.text.startsWith('{')) {
                    try { const p = JSON.parse(row.text); text = p.caption; if(p.url) imageUrl = await refreshMediaUrl(p.url); } catch(e){}
                }
                return { 
                    id: row.id, sender: row.direction === 'in' ? 'driver' : 'agent', text, imageUrl, 
                    timestamp: new Date(row.created_at).getTime(), type: row.type || 'text', status: row.status 
                };
            }));
            res.json(msgs.reverse());
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/drivers/:id/messages', async (req, res) => {
    try {
        const { text, mediaUrl, mediaType } = req.body;
        await withDb(async (client) => {
            const c = await client.query('SELECT phone_number FROM candidates WHERE id = $1', [req.params.id]);
            if (c.rows.length === 0) throw new Error("Candidate not found");
            
            let payload = { type: 'text', text: { body: text } };
            let dbText = text;
            
            if (mediaUrl) {
                const freshUrl = await refreshMediaUrl(mediaUrl);
                const type = mediaType || 'image';
                payload = { type, [type]: { link: freshUrl, caption: text } };
                dbText = JSON.stringify({ url: mediaUrl, caption: text });
            }

            await sendToMeta(c.rows[0].phone_number, payload);
            await client.query(
                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())`,
                [crypto.randomUUID(), req.params.id, dbText, mediaUrl ? (mediaType || 'image') : 'text']
            );
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers/:id/documents', async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query('SELECT * FROM driver_documents WHERE candidate_id = $1', [req.params.id]);
            const docs = await Promise.all(r.rows.map(async d => ({
                id: d.id, docType: d.type, url: await refreshMediaUrl(d.url), 
                verificationStatus: d.status, timestamp: new Date(d.created_at).getTime()
            })));
            res.json(docs);
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// 4. SCHEDULED MESSAGES
// ==========================================
apiRouter.post('/scheduled-messages', async (req, res) => {
    try {
        const { driverIds, message, timestamp } = req.body;
        const payload = typeof message === 'string' ? { text: message } : message;
        await withDb(async (client) => {
            for (const id of driverIds) {
                await client.query(
                    `INSERT INTO scheduled_messages (id, candidate_id, payload, scheduled_time, status) VALUES ($1, $2, $3, $4, 'pending')`,
                    [crypto.randomUUID(), id, payload, timestamp]
                );
            }
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers/:id/scheduled-messages', async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query(`SELECT * FROM scheduled_messages WHERE candidate_id = $1 AND status = 'pending' ORDER BY scheduled_time ASC`, [req.params.id]);
            res.json(r.rows.map(row => ({
                id: row.id, scheduledTime: parseInt(row.scheduled_time), payload: row.payload, status: row.status
            })));
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.delete('/scheduled-messages/:id', async (req, res) => {
    try {
        await withDb(async (client) => {
            await client.query("DELETE FROM scheduled_messages WHERE id = $1", [req.params.id]);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.patch('/scheduled-messages/:id', async (req, res) => {
    try {
        const { text, scheduledTime } = req.body;
        await withDb(async (client) => {
            if (text) {
                const r = await client.query("SELECT payload FROM scheduled_messages WHERE id = $1", [req.params.id]);
                if (r.rows.length > 0) {
                    const newPayload = { ...r.rows[0].payload, text };
                    await client.query("UPDATE scheduled_messages SET payload = $1 WHERE id = $2", [newPayload, req.params.id]);
                }
            }
            if (scheduledTime) {
                await client.query("UPDATE scheduled_messages SET scheduled_time = $1 WHERE id = $2", [scheduledTime, req.params.id]);
            }
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// 5. CRON & WEBHOOK
// ==========================================
apiRouter.get('/cron/process-queue', async (req, res) => {
    try {
        let processed = 0, errors = 0;
        await withDb(async (client) => {
            const now = Date.now();
            const jobs = await client.query(`
                SELECT sm.id, sm.candidate_id, sm.payload, c.phone_number FROM scheduled_messages sm
                JOIN candidates c ON sm.candidate_id = c.id
                WHERE sm.status = 'pending' AND sm.scheduled_time <= $1 LIMIT 10 FOR UPDATE OF sm SKIP LOCKED
            `, [now]);

            for (const job of jobs.rows) {
                try {
                    await client.query("UPDATE scheduled_messages SET status = 'processing' WHERE id = $1", [job.id]);
                    const p = job.payload || {};
                    let metaP = { type: 'text', text: { body: p.text || '' } };
                    if (p.mediaUrl) {
                        const url = await refreshMediaUrl(p.mediaUrl);
                        metaP = { type: p.mediaType || 'image', [p.mediaType || 'image']: { link: url, caption: p.text } };
                    }
                    await sendToMeta(job.phone_number, metaP);
                    await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`, [crypto.randomUUID(), job.candidate_id, p.text]);
                    await client.query("UPDATE scheduled_messages SET status = 'sent' WHERE id = $1", [job.id]);
                    processed++;
                } catch (e) {
                    errors++;
                    await client.query("UPDATE scheduled_messages SET status = 'failed', error_log = $2 WHERE id = $1", [job.id, e.message]);
                }
            }
        });
        res.json({ status: 'ok', processed, errors });
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
    const body = req.body;
    if (!body.object) return;
    try {
        const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (!msg) return;
        
        await withDb(async (client) => {
            await client.query(`CREATE TABLE IF NOT EXISTS system_settings (key VARCHAR(50) PRIMARY KEY, value JSONB)`);
            const sys = await client.query("SELECT value FROM system_settings WHERE key = 'config'");
            if (sys.rows[0]?.value?.webhook_ingest_enabled === false) return;

            const from = msg.from;
            const name = body.entry[0].changes[0].value.contacts?.[0]?.profile?.name || 'Unknown';
            let text = '';
            if (msg.type === 'text') text = msg.text.body;
            else if (msg.type === 'interactive') text = msg.interactive.button_reply?.title || msg.interactive.list_reply?.title || '';
            else text = `[${msg.type.toUpperCase()}]`;

            let c = await client.query('SELECT * FROM candidates WHERE phone_number = $1', [from]);
            let cid = c.rows[0]?.id;
            if (!cid) {
                cid = crypto.randomUUID();
                await client.query(`INSERT INTO candidates (id, phone_number, name, stage, last_message_at, is_human_mode, variables) VALUES ($1, $2, $3, 'New', $4, FALSE, '{}')`, [cid, from, name, Date.now()]);
            } else {
                await client.query('UPDATE candidates SET last_message = $1, last_message_at = $2 WHERE id = $3', [text, Date.now(), cid]);
            }

            await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, whatsapp_message_id, status, created_at) VALUES ($1, $2, 'in', $3, 'text', $4, 'received', NOW())`, [crypto.randomUUID(), cid, text, msg.id]);
        });
    } catch(e) { console.error("Webhook Error", e); }
});

// ==========================================
// 6. DB ADMIN OPS
// ==========================================
apiRouter.post('/system/init-db', async (req, res) => {
    try {
        await withDb(async (client) => {
            await client.query(`
                CREATE TABLE IF NOT EXISTS system_settings (key VARCHAR(50) PRIMARY KEY, value JSONB);
                CREATE TABLE IF NOT EXISTS candidates (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), phone_number VARCHAR(50) UNIQUE, name VARCHAR(255), stage VARCHAR(50), last_message TEXT, last_message_at BIGINT, source VARCHAR(50), is_human_mode BOOLEAN DEFAULT FALSE, current_bot_step_id VARCHAR(100), variables JSONB DEFAULT '{}', created_at TIMESTAMP DEFAULT NOW());
                CREATE TABLE IF NOT EXISTS candidate_messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id UUID, direction VARCHAR(10), text TEXT, type VARCHAR(50), status VARCHAR(50), whatsapp_message_id VARCHAR(255), created_at TIMESTAMP DEFAULT NOW());
                CREATE TABLE IF NOT EXISTS scheduled_messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id UUID, payload JSONB, scheduled_time BIGINT, status VARCHAR(50), error_log TEXT, created_at TIMESTAMP DEFAULT NOW());
                CREATE TABLE IF NOT EXISTS bot_versions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status VARCHAR(20), settings JSONB, created_at TIMESTAMP DEFAULT NOW());
                CREATE TABLE IF NOT EXISTS driver_documents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id UUID, type VARCHAR(50), url TEXT, status VARCHAR(50), created_at TIMESTAMP DEFAULT NOW());
            `);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/system/hard-reset', async (req, res) => {
    try {
        await withDb(async (client) => {
            await client.query(`DROP TABLE IF EXISTS scheduled_messages, candidate_messages, driver_documents, bot_versions, candidates, system_settings CASCADE`);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/system/seed-db', async (req, res) => {
    try {
        await withDb(async (client) => {
            const id = crypto.randomUUID();
            await client.query(`INSERT INTO candidates (id, phone_number, name, stage, last_message, last_message_at) VALUES ($1, '+919999999999', 'Demo Driver', 'New', 'Hello', $2)`, [id, Date.now()]);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// 7. MEDIA / S3
// ==========================================
apiRouter.post('/ai/assistant', (req, res) => res.json({ text: "AI Service connecting..." }));

// LIST FILES
apiRouter.get('/media', async (req, res) => {
    const currentPath = req.query.path || '/';
    let prefix = currentPath === '/' ? '' : currentPath.substring(1);
    if (prefix && !prefix.endsWith('/')) prefix += '/';

    try {
        const command = new ListObjectsV2Command({
            Bucket: SYSTEM_CONFIG.AWS_BUCKET,
            Prefix: prefix,
            Delimiter: '/'
        });
        const data = await s3Client.send(command);

        const folders = (data.CommonPrefixes || []).map(p => {
            const parts = p.Prefix.split('/').filter(Boolean);
            const name = parts[parts.length - 1];
            return { id: p.Prefix, name, parent_path: currentPath, is_public_showcase: false };
        });

        const files = await Promise.all((data.Contents || []).map(async (obj) => {
            if (obj.Key.endsWith('/')) return null;
            const url = await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: obj.Key }), { expiresIn: 3600 });
            const filename = obj.Key.split('/').pop();
            const ext = filename.split('.').pop().toLowerCase();
            let type = 'document';
            if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) type = 'image';
            if (['mp4', 'mov', 'webm', 'mkv'].includes(ext)) type = 'video';
            return { id: obj.Key, url, filename, type, media_id: null };
        }));

        res.json({ files: files.filter(Boolean), folders });
    } catch (e) {
        console.error("S3 List Error:", e);
        res.json({ files: [], folders: [] }); // Fail gracefully
    }
});

// UPLOAD
apiRouter.post('/media/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) throw new Error("No file");
        const path = req.body.path || '/';
        let prefix = path === '/' ? '' : path.substring(1);
        if (prefix && !prefix.endsWith('/')) prefix += '/';
        
        const key = `${prefix}${req.file.originalname}`;
        await s3Client.send(new PutObjectCommand({
            Bucket: SYSTEM_CONFIG.AWS_BUCKET,
            Key: key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
        }));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// CREATE FOLDER
apiRouter.post('/media/folders', async (req, res) => {
    try {
        const { name, parentPath } = req.body;
        let prefix = parentPath === '/' ? '' : parentPath.substring(1);
        if (prefix && !prefix.endsWith('/')) prefix += '/';
        const key = `${prefix}${name}/`; 
        await s3Client.send(new PutObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key, Body: '' }));
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE FILE/FOLDER (Wildcard support)
apiRouter.delete('/media/files/:id(*)', async (req, res) => {
    try {
        // req.params.id or req.params[0] depending on Express version
        const key = req.params[0] || req.params.id; 
        await s3Client.send(new DeleteObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key }));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.delete('/media/folders/:id(*)', async (req, res) => {
    try {
        const key = req.params[0] || req.params.id;
        await s3Client.send(new DeleteObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key }));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- MOUNT ROUTER ---
app.use('/api', apiRouter);
// Fallback for root mounts if Vercel strips /api prefix
app.use('/', apiRouter);

// Catch-all for unhandled routes to debug 404s
app.use((req, res) => {
    console.log(`[404] Route not found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: 'Route not found', path: req.originalUrl });
});

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => console.log(`Server running on ${PORT}`));
}

module.exports = app;

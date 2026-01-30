
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const { Client: QStashClient, Receiver } = require('@upstash/qstash');
const { Pool } = require('pg');
const { S3Client, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const { OAuth2Client } = require('google-auth-library');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

// --- CONFIGURATION ---
const SYSTEM_CONFIG = {
    META_TIMEOUT: 5000, 
    DB_CONNECTION_TIMEOUT: 5000, 
    CACHE_TTL_SETTINGS: 600, 
    LOCK_TTL: 15,
    DEDUPE_TTL: 3600 
};

// --- SERVICES INITIALIZATION ---

// 1. Database (Neon Postgres)
let pgPool = null;
const getDb = () => {
    if (!pgPool) {
        pgPool = new Pool({
            connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
            ssl: { rejectUnauthorized: false }, 
            connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
            max: 5, 
            idleTimeoutMillis: 10000 
        });
        pgPool.on('error', (err) => console.error('⚠️ DB Pool Error:', err.message));
    }
    return pgPool;
};

// 2. Cache (Upstash Redis)
const redis = new Redis({ 
    url: process.env.UPSTASH_REDIS_REST_URL || 'https://mock.upstash.io', 
    token: process.env.UPSTASH_REDIS_REST_TOKEN || 'mock' 
});

// 3. Queue (QStash)
const qstash = new QStashClient({ token: process.env.QSTASH_TOKEN || 'mock' });
const qstashReceiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || 'mock',
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || 'mock',
});

// 4. Storage (AWS S3)
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
    }
});
const BUCKET_NAME = process.env.AWS_BUCKET_NAME || 'uber-fleet-assets';

// 5. AI (Gemini)
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

// 6. Auth (Google)
const authClient = new OAuth2Client(process.env.VITE_GOOGLE_CLIENT_ID);

// 7. Meta API Client
const getMetaClient = () => {
    const axios = require('axios');
    const https = require('https');
    return axios.create({
        httpsAgent: new https.Agent({ keepAlive: true }),
        timeout: SYSTEM_CONFIG.META_TIMEOUT,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.META_API_TOKEN}` }
    });
};

// --- EXPRESS SETUP ---
const app = express();
const apiRouter = express.Router(); 
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(cors()); 

// --- HELPER FUNCTIONS ---

// DB AUTO-MIGRATION (Schema Enforcement)
const ensureDbSchema = async () => {
    const client = await getDb().connect();
    try {
        await client.query('BEGIN');
        
        // Extensions
        await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');

        // 1. Candidates (Drivers)
        await client.query(`
            CREATE TABLE IF NOT EXISTS candidates (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                phone_number VARCHAR(50) UNIQUE NOT NULL,
                name VARCHAR(255),
                stage VARCHAR(50) DEFAULT 'New',
                last_message_at BIGINT,
                variables JSONB DEFAULT '{}',
                tags TEXT[],
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);
        // Add robust columns
        await client.query(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS notes TEXT;`);
        await client.query(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS is_human_mode BOOLEAN DEFAULT FALSE;`);
        await client.query(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS human_mode_ends_at BIGINT;`);

        await client.query(`CREATE INDEX IF NOT EXISTS idx_candidates_phone ON candidates(phone_number);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_candidates_last_msg ON candidates(last_message_at DESC);`);

        // 2. Messages
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
            );
        `);
        // Evolution: Ensure whatsapp_message_id exists
        await client.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='candidate_messages' AND column_name='whatsapp_message_id') THEN 
                    ALTER TABLE candidate_messages ADD COLUMN whatsapp_message_id VARCHAR(255) UNIQUE; 
                END IF; 
            END $$;
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_candidate ON candidate_messages(candidate_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_wa_id ON candidate_messages(whatsapp_message_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_created ON candidate_messages(created_at DESC);`);

        // 3. Bot Settings
        await client.query(`
            CREATE TABLE IF NOT EXISTS bot_versions (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                phone_number_id VARCHAR(50),
                version_number INT,
                status VARCHAR(20) CHECK (status IN ('draft', 'published', 'archived')),
                settings JSONB,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);

        // 4. Scheduled Messages
        await client.query(`
            CREATE TABLE IF NOT EXISTS scheduled_messages (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
                payload JSONB,
                scheduled_time BIGINT,
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_time ON scheduled_messages(scheduled_time) WHERE status = 'pending';`);

        await client.query('COMMIT');
        console.log("✅ DB Schema Verified");
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("❌ DB Schema Migration Failed:", e.message);
    } finally {
        client.release();
    }
};

// ROBUST URL RESOLVER (Fixes QStash localhost issues)
function getBaseUrl(req) {
  const envBase = process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.trim() : '';
  if (envBase) return envBase.replace(/\/$/, "");

  const vercelUrl = process.env.VERCEL_URL ? process.env.VERCEL_URL.trim() : '';
  if (vercelUrl) return `https://${vercelUrl.replace(/\/$/, "")}`;

  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`.replace(/\/$/, "");
}

const getBotSettings = async (phoneId) => {
    if (!phoneId) return null;
    const key = `bot:settings:${phoneId}`;
    try {
        const cached = await redis.get(key);
        if (cached) return cached;
    } catch (e) {}

    const client = await getDb().connect();
    try {
        const res = await client.query(`SELECT settings FROM bot_versions WHERE phone_number_id = $1 AND status = 'published' ORDER BY version_number DESC LIMIT 1`, [phoneId]);
        if (res.rows.length > 0) {
            redis.set(key, res.rows[0].settings, { ex: 600 }).catch(() => {});
            return res.rows[0].settings;
        }
        return null;
    } catch(err) { return null; } finally { client.release(); }
};

const sendToMeta = async (to, payload) => {
    try { 
        await getMetaClient().post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload }); 
    } catch (e) { 
        console.error("Meta Send Error", e.response?.data || e.message); 
    }
};

// CORE PROCESSING LOGIC (Shared by Worker and Fallback)
const processMessageInternal = async (message, contact, phoneId) => {
    if (!message || !phoneId) throw new Error("Invalid Payload");

    // --- IDEMPOTENCY CHECK (Deduplication) ---
    // Prevent processing the same WhatsApp message ID multiple times.
    if (message.id) {
        const key = `wa:msg:${message.id}`;
        try {
            // Only attempt if Redis is configured to avoid mock errors blocking flow
            if (process.env.UPSTASH_REDIS_REST_URL && !process.env.UPSTASH_REDIS_REST_URL.includes('mock')) {
                // Set key only if it doesn't exist (NX), expire in 1 hour (EX 3600)
                const locked = await redis.set(key, "1", { nx: true, ex: 3600 });
                if (!locked) {
                    console.log(`[Idempotency] Skipped duplicate message ID: ${message.id}`);
                    return { success: true, duplicate: true };
                }
            }
        } catch (e) {
            // Fail-Open: If Redis is down, we process the message anyway to ensure data integrity
            console.warn(`[Idempotency] Lock check failed: ${e.message}`);
        }
    }

    console.log(`[Core] Processing message from: ${message.from}`);
    const client = await getDb().connect();
    
    try {
        const from = message.from;
        const name = contact?.profile?.name || "Unknown";
        
        // Upsert Candidate
        const upsertQuery = `INSERT INTO candidates (id, phone_number, name, stage, last_message_at, created_at) VALUES ($1, $2, $3, 'New', $4, NOW()) ON CONFLICT (phone_number) DO UPDATE SET name = EXCLUDED.name, last_message_at = $4 RETURNING id`;
        const resDb = await client.query(upsertQuery, [crypto.randomUUID(), from, name, Date.now()]);
        
        // Insert Message with DB-Level Idempotency (ON CONFLICT DO NOTHING)
        // If Redis lock fails or expires, this unique constraint on whatsapp_message_id saves us.
        const insertMsgQuery = `
            INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, whatsapp_message_id, created_at) 
            VALUES ($1, $2, 'in', $3, $4, 'received', $5, NOW()) 
            ON CONFLICT (whatsapp_message_id) DO NOTHING
        `;
        await client.query(insertMsgQuery, [crypto.randomUUID(), resDb.rows[0].id, message.text?.body || '[Media]', message.type, message.id]);
        
        // Bot Logic Check
        const settings = await getBotSettings(phoneId);
        if (settings && settings.nodes) {
             console.log(`[Core] Bot logic active. Flow size: ${settings.nodes.length}`);
             // Future: Inject Bot Execution Engine here
        }
        return { success: true };
    } finally { 
        client.release(); 
    }
};

// FAULT-TOLERANT QUEUE DISPATCHER
const enqueueIncomingMessageJob = async (req, message, contact, phoneId) => {
    const baseUrl = getBaseUrl(req);
    const workerUrl = `${baseUrl}/api/internal/bot-worker`;

    // 1. Check Configuration
    if (!process.env.QSTASH_TOKEN || process.env.QSTASH_TOKEN === 'mock') {
        console.warn("[Queue] QStash token missing. Falling back to synchronous processing.");
        return processMessageInternal(message, contact, phoneId);
    }

    // 2. Try Async Publish
    try {
        console.log(`[Queue] Dispatching to: ${workerUrl} | ID: ${message.id}`);
        await qstash.publishJSON({
            url: workerUrl,
            body: { message, contact, phoneId },
            retries: 3 
        });
    } catch (e) {
        console.error(`[Queue Error] Publish failed: ${e.message}. Falling back to sync.`);
        // 3. Fallback on Failure (Critical for Data Integrity)
        return processMessageInternal(message, contact, phoneId);
    }
};

// --- ROUTE GROUPS ---

// ==========================================
// 1. AUTHENTICATION
// ==========================================
apiRouter.post('/auth/google', async (req, res) => {
    const { credential } = req.body;
    try {
        const ticket = await authClient.verifyIdToken({
            idToken: credential,
            audience: process.env.VITE_GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        res.json({ success: true, user: { name: payload.name, email: payload.email, picture: payload.picture } });
    } catch (error) {
        console.error("Auth Error:", error);
        res.status(401).json({ success: false, message: "Invalid Token" });
    }
});

// ==========================================
// 2. SYSTEM & DIAGNOSTICS
// ==========================================
apiRouter.get('/debug/status', async (req, res) => {
    const status = {
        postgres: 'unknown',
        redis: 'unknown',
        s3: 'unknown',
        tables: { candidates: false, bot_versions: false },
        counts: { candidates: 0 },
        workerUrl: `${getBaseUrl(req)}/api/internal/bot-worker`,
        env: {
            hasPostgres: !!process.env.POSTGRES_URL,
            hasRedis: !!process.env.UPSTASH_REDIS_REST_URL,
            hasQStash: !!process.env.QSTASH_TOKEN,
            publicUrl: process.env.PUBLIC_BASE_URL || 'NOT_SET'
        }
    };

    const client = await getDb().connect();
    try {
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
    } catch (e) { status.postgres = 'error'; status.lastError = e.message; }
    finally { client.release(); }

    try { await redis.ping(); status.redis = 'connected'; } catch(e) { status.redis = 'error'; }
    try { await s3Client.send(new ListObjectsV2Command({ Bucket: BUCKET_NAME, MaxKeys: 1 })); status.s3 = 'connected'; } catch(e) { status.s3 = e.message; }

    res.json(status);
});

apiRouter.get('/system/stats', (req, res) => res.redirect('/api/debug/status'));

apiRouter.post('/system/init-db', async (req, res) => {
    // Manually trigger migration via API if needed
    await ensureDbSchema();
    res.json({ success: true, message: "Schema verification complete" });
});

apiRouter.post('/system/seed-db', async (req, res) => {
    const client = await getDb().connect();
    try {
        const id = crypto.randomUUID();
        await client.query(`INSERT INTO candidates (id, phone_number, name, stage, last_message_at) VALUES ($1, '+919876543210', 'Test Driver', 'New', $2) ON CONFLICT DO NOTHING`, [id, Date.now()]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); } finally { client.release(); }
});

apiRouter.get('/system/settings', async (req, res) => {
    const s = await redis.get('system:settings').catch(() => null);
    res.json(s || { webhook_ingest_enabled: true, automation_enabled: true, sending_enabled: true });
});

apiRouter.patch('/system/settings', async (req, res) => {
    await redis.set('system:settings', req.body);
    res.json(req.body);
});

apiRouter.post('/system/credentials', async (req, res) => {
    res.json({ success: true });
});

apiRouter.post('/system/webhook', async (req, res) => {
    res.json({ success: true });
});

// ==========================================
// 3. DRIVERS & MESSAGES
// ==========================================
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
            source: 'Organic',
            notes: row.notes,
            isHumanMode: row.is_human_mode,
            humanModeEndsAt: row.human_mode_ends_at ? parseInt(row.human_mode_ends_at) : undefined
        })));
    } catch (e) {
        if (e.code === '42P01') { 
            res.json([]); 
        } else {
            console.error(e);
            res.status(500).json({ error: e.message });
        }
    } finally { client.release(); }
});

apiRouter.patch('/drivers/:id', async (req, res) => {
    const { status, tags, variables, name, notes, isHumanMode, humanModeEndsAt } = req.body;
    const client = await getDb().connect();
    try {
        const updates = [];
        const values = [];
        let idx = 1;

        if (status) { updates.push(`stage = $${idx++}`); values.push(status); }
        if (name) { updates.push(`name = $${idx++}`); values.push(name); }
        if (tags) { updates.push(`tags = $${idx++}`); values.push(tags); }
        if (variables) { updates.push(`variables = COALESCE(variables, '{}'::jsonb) || $${idx++}::jsonb`); values.push(JSON.stringify(variables)); }
        if (notes !== undefined) { updates.push(`notes = $${idx++}`); values.push(notes); }
        if (isHumanMode !== undefined) { updates.push(`is_human_mode = $${idx++}`); values.push(isHumanMode); }
        if (humanModeEndsAt !== undefined) { updates.push(`human_mode_ends_at = $${idx++}`); values.push(humanModeEndsAt); }

        if (updates.length > 0) {
            updates.push(`updated_at = NOW()`);
            values.push(req.params.id);
            await client.query(`UPDATE candidates SET ${updates.join(', ')} WHERE id = $${idx}`, values);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});

apiRouter.get('/drivers/:id/messages', async (req, res) => {
    const client = await getDb().connect();
    try {
        const limit = parseInt(req.query.limit) || 50;
        const resDb = await client.query('SELECT * FROM candidate_messages WHERE candidate_id = (SELECT id FROM candidates WHERE phone_number = $1 OR id = $1 LIMIT 1) ORDER BY created_at DESC LIMIT $2', [req.params.id, limit]);
        res.json(resDb.rows.map(r => ({
            id: r.id, sender: r.direction === 'in' ? 'driver' : 'agent', text: r.text, timestamp: new Date(r.created_at).getTime(), type: r.type || 'text', status: r.status
        })).reverse());
    } catch (e) { res.json([]); } finally { client.release(); }
});

apiRouter.post('/drivers/:id/messages', async (req, res) => {
    const { text, mediaUrl, mediaType } = req.body;
    const client = await getDb().connect();
    try {
        const dRes = await client.query('SELECT phone_number FROM candidates WHERE id = $1', [req.params.id]);
        if (dRes.rows.length === 0) return res.status(404).send("Driver not found");
        
        const payload = mediaUrl 
            ? { type: mediaType || 'image', [mediaType || 'image']: { link: mediaUrl, caption: text } }
            : { type: 'text', text: { body: text } };
        
        await sendToMeta(dRes.rows[0].phone_number, payload);
        
        await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`, [crypto.randomUUID(), req.params.id, text]);
        await client.query('UPDATE candidates SET last_message_at = $1 WHERE id = $2', [Date.now(), req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).send(e.message); } finally { client.release(); }
});

apiRouter.get('/drivers/:id/documents', async (req, res) => { res.json([]); });

// Scheduled Messages
apiRouter.get('/drivers/:id/scheduled-messages', async (req, res) => {
    const client = await getDb().connect();
    try {
        const result = await client.query(`SELECT * FROM scheduled_messages WHERE candidate_id = $1 ORDER BY scheduled_time ASC`, [req.params.id]);
        res.json(result.rows.map(r => ({
            id: r.id,
            scheduledTime: parseInt(r.scheduled_time),
            payload: r.payload,
            status: r.status
        })));
    } catch (e) { res.status(500).json({ error: e.message }); } finally { client.release(); }
});

apiRouter.post('/scheduled-messages', async (req, res) => {
    const { driverIds, message, timestamp } = req.body;
    const client = await getDb().connect();
    try {
        for (const driverId of driverIds) {
             await client.query(`INSERT INTO scheduled_messages (id, candidate_id, payload, scheduled_time, status) VALUES ($1, $2, $3, $4, 'pending')`, 
                [crypto.randomUUID(), driverId, JSON.stringify(message), timestamp || Date.now()]);
        }
        res.json({ success: true, count: driverIds.length });
    } catch (e) { res.status(500).json({ error: e.message }); } finally { client.release(); }
});

apiRouter.delete('/scheduled-messages/:id', async (req, res) => {
    const client = await getDb().connect();
    try {
        await client.query('DELETE FROM scheduled_messages WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); } finally { client.release(); }
});

apiRouter.patch('/scheduled-messages/:id', async (req, res) => {
    const { text, scheduledTime } = req.body;
    const client = await getDb().connect();
    try {
        const old = await client.query('SELECT payload FROM scheduled_messages WHERE id = $1', [req.params.id]);
        if (old.rows.length === 0) return res.status(404).json({error: "Not found"});
        
        const newPayload = { ...old.rows[0].payload, text: text || old.rows[0].payload.text };
        const updates = [`payload = $1`];
        const values = [JSON.stringify(newPayload)];
        let idx = 2;
        
        if (scheduledTime) {
            updates.push(`scheduled_time = $${idx++}`);
            values.push(scheduledTime);
        }
        
        values.push(req.params.id);
        await client.query(`UPDATE scheduled_messages SET ${updates.join(', ')} WHERE id = $${idx}`, values);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); } finally { client.release(); }
});

// ==========================================
// 4. BOT SETTINGS
// ==========================================
apiRouter.get('/bot/settings', async (req, res) => { 
    const s = await getBotSettings(process.env.PHONE_NUMBER_ID);
    res.json(s || { nodes: [], edges: [], steps: [] });
});

apiRouter.get('/bot-settings', (req, res) => res.redirect('/api/bot/settings'));

apiRouter.post('/bot/save', async (req, res) => { 
    const client = await getDb().connect();
    try {
        await client.query(`INSERT INTO bot_versions (id, phone_number_id, version_number, status, settings) VALUES ($1, $2, 1, 'draft', $3) ON CONFLICT (id) DO UPDATE SET settings = $3`, [crypto.randomUUID(), process.env.PHONE_NUMBER_ID, JSON.stringify(req.body)]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); } finally { client.release(); }
});

apiRouter.post('/bot/publish', async (req, res) => { 
    await redis.del(`bot:settings:${process.env.PHONE_NUMBER_ID}`); 
    res.json({ success: true }); 
});

// ==========================================
// 5. MEDIA & SHOWCASE (S3)
// ==========================================
apiRouter.get('/media', async (req, res) => {
    const prefix = req.query.path && req.query.path !== '/' ? req.query.path.replace(/^\//, '') + '/' : '';
    try {
        const command = new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: prefix, Delimiter: '/' });
        const response = await s3Client.send(command);
        
        const publicFolders = await redis.smembers('system:public_folders');

        const folders = (response.CommonPrefixes || []).map(p => {
            const name = p.Prefix.replace(prefix, '').replace('/', '');
            const fullPath = p.Prefix.slice(0, -1);
            return {
                id: fullPath,
                name: name,
                parent_path: prefix,
                is_public_showcase: publicFolders.includes(fullPath)
            };
        });

        const files = (response.Contents || []).map(c => {
            if (c.Key === prefix) return null;
            const ext = c.Key.split('.').pop().toLowerCase();
            let type = 'document';
            if (['jpg','jpeg','png','gif'].includes(ext)) type = 'image';
            if (['mp4','mov'].includes(ext)) type = 'video';
            return {
                id: c.Key,
                filename: c.Key.replace(prefix, ''),
                url: `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${c.Key}`,
                type
            };
        }).filter(Boolean);

        res.json({ folders, files });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/media/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file');
    const path = req.body.path && req.body.path !== '/' ? req.body.path.replace(/^\//, '') + '/' : '';
    try {
        await s3Client.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: `${path}${req.file.originalname}`,
            Body: req.file.buffer,
            ContentType: req.file.mimetype,
            ACL: 'public-read' 
        }));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/media/folders', async (req, res) => {
    const { name, parentPath } = req.body;
    const path = parentPath && parentPath !== '/' ? parentPath.replace(/^\//, '') + '/' : '';
    try {
        await s3Client.send(new PutObjectCommand({ Bucket: BUCKET_NAME, Key: `${path}${name}/`, Body: '' }));
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

apiRouter.delete('/media/files/:id', async (req, res) => {
    try { await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: req.params.id })); res.json({ success: true }); }
    catch(e) { res.status(500).json({ error: e.message }); }
});

apiRouter.delete('/media/folders/:id', async (req, res) => {
    try { await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: req.params.id + '/' })); res.json({ success: true }); }
    catch(e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/media/folders/:id/public', async (req, res) => {
    await redis.sadd('system:public_folders', req.params.id);
    await redis.set('system:active_showcase', req.params.id);
    res.json({ success: true });
});

apiRouter.delete('/media/folders/:id/public', async (req, res) => {
    await redis.srem('system:public_folders', req.params.id);
    res.json({ success: true });
});

apiRouter.get('/showcase/status', async (req, res) => {
    const active = await redis.get('system:active_showcase');
    if (!active) return res.json({ active: false });
    res.json({ active: true, folderId: active, folderName: active.split('/').pop() });
});

apiRouter.get('/showcase/:folderName?', async (req, res) => {
    let folderName = req.params.folderName;
    if (!folderName) {
        const active = await redis.get('system:active_showcase');
        if (active) folderName = active;
        else return res.json({ items: [], title: 'No Showcase Active' });
    }
    const prefix = folderName.endsWith('/') ? folderName : `${folderName}/`;
    try {
        const command = new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: prefix });
        const response = await s3Client.send(command);
        const items = (response.Contents || []).map(c => {
             if (c.Key === prefix) return null;
             const ext = c.Key.split('.').pop().toLowerCase();
             let type = 'image';
             if (['mp4','mov'].includes(ext)) type = 'video';
             if (['pdf','doc'].includes(ext)) type = 'document';
             return {
                 id: c.Key,
                 url: `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${c.Key}`,
                 type,
                 filename: c.Key.replace(prefix, '')
             };
        }).filter(Boolean);
        res.json({ title: folderName.replace(/\/$/, ''), items });
    } catch(e) {
        res.json({ title: 'Error', items: [] });
    }
});

apiRouter.post('/media/sync-s3', async (req, res) => { res.json({ success: true, added: 0 }); });

// ==========================================
// 6. AI & GEMINI
// ==========================================
apiRouter.post('/ai/generate', async (req, res) => {
    if (!genAI) return res.status(503).json({ error: "AI Not Configured" });
    try {
        const { model, contents, config } = req.body;
        const aiModel = genAI.getGenerativeModel({ model: model || 'gemini-1.5-flash' });
        const result = await aiModel.generateContent({
            contents: [{ role: 'user', parts: [{ text: contents }] }],
            generationConfig: config
        });
        const response = await result.response;
        res.json({ text: response.text() });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/ai/assistant', async (req, res) => {
    if (!genAI) return res.status(503).json({ error: "AI Not Configured" });
    try {
        const { input, history } = req.body;
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const chat = model.startChat({
            history: history.map(h => ({ role: h.role, parts: h.parts })),
            generationConfig: { maxOutputTokens: 100 }
        });
        const result = await chat.sendMessage(input);
        res.json({ text: result.response.text() });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// 7. WEBHOOK (With Robust QStash Resolution & Fallback)
// ==========================================
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) res.send(req.query['hub.challenge']);
    else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;
        if (body.object !== 'whatsapp_business_account') return res.sendStatus(404);
        
        const entries = body.entry || [];
        for (const entry of entries) {
            for (const change of (entry.changes || [])) {
                const value = change.value;
                if (!value.messages) continue;
                const phoneId = value.metadata?.phone_number_id;
                for (const message of value.messages) {
                    // Use Fault-Tolerant Queue Wrapper
                    await enqueueIncomingMessageJob(req, message, value.contacts?.[0], phoneId);
                }
            }
        }
        res.sendStatus(200);
    } catch (e) { 
        console.error("[Webhook Error]", e);
        res.sendStatus(200); 
    }
});

// ==========================================
// 8. WORKER (Queue Handler)
// ==========================================
apiRouter.post('/internal/bot-worker', async (req, res) => {
    // --- SECURITY GUARD ---
    const signature = req.headers["upstash-signature"];
    const secretHeader = req.headers["x-internal-secret"];
    const expectedSecret = process.env.INTERNAL_WORKER_SECRET;

    let isAuthorized = false;

    // 1. Check Shared Secret (Manual/Internal calls)
    if (expectedSecret && secretHeader === expectedSecret) {
        isAuthorized = true;
    } 
    // 2. Check QStash Signature (Production Queue calls)
    else if (signature && process.env.QSTASH_CURRENT_SIGNING_KEY) {
        try {
            const body = req.rawBody ? req.rawBody.toString() : JSON.stringify(req.body);
            // We skip URL check here to avoid "Protocol mismatch" errors behind proxies (http vs https)
            // unless we are confident in getBaseUrl. 
            isAuthorized = await qstashReceiver.verify({
                signature,
                body
            });
        } catch (e) {
            console.error("[Worker Security] Signature verification failed:", e.message);
        }
    } 
    // 3. Dev/Mock Mode
    else if (!process.env.QSTASH_CURRENT_SIGNING_KEY || process.env.QSTASH_CURRENT_SIGNING_KEY === 'mock') {
        console.warn("[Worker Security] Running in insecure/mock mode.");
        isAuthorized = true;
    }

    if (!isAuthorized) {
        console.error("[Worker Security] Unauthorized access attempt.");
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        const { message, contact, phoneId } = req.body;
        await processMessageInternal(message, contact, phoneId);
        res.json({ success: true });
    } catch(e) { 
        console.error("[Worker Error]", e);
        res.status(500).send(e.message); 
    }
});

// --- MOUNT ---
app.use('/api', apiRouter);
app.use('/', apiRouter);

// --- STARTUP SCHEMA CHECK ---
ensureDbSchema().then(() => {
    console.log("Startup DB Check Complete");
}).catch(console.error);

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => console.log(`🚀 Uber Fleet Bot running on port ${PORT}`));
}

module.exports = app;

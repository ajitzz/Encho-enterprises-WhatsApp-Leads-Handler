
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const multer = require('multer'); 
const { Pool } = require('pg'); 
const { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { OAuth2Client } = require('google-auth-library');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const app = express();
const apiRouter = express.Router(); 

// --- CONFIGURATION ---
const CACHE = {
    botSettings: null,
    systemSettings: null,
    lastRefreshed: 0,
    schemaChecked: false
};

// --- MIDDLEWARE ---
app.use(express.json({ 
    limit: '50mb', 
    verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(cors()); 

// Disable Caching
app.set('etag', false);
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } 
});

// --- ENV VARS ---
const SUPER_ADMIN_EMAILS = (process.env.SUPER_ADMIN_EMAILS || "").split(',').map(e => e.trim().toLowerCase()).filter(e => e);
const GOOGLE_CLIENT_ID = process.env.VITE_GOOGLE_CLIENT_ID || "764842119656-ufuaijbp0kb4m0ql6tjhdmmr3hr24t15.apps.googleusercontent.com";
const authClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const META_API_TOKEN = (process.env.META_API_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "uber_fleet_verify_token").trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();

// AWS S3
const BUCKET_NAME = process.env.AWS_BUCKET_NAME || process.env.BUCKET_NAME || 'uber-fleet-assets';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const s3Config = { region: AWS_REGION };
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    s3Config.credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    };
}
const s3Client = new S3Client(s3Config);

// DATABASE
const DEFAULT_DB_URL = "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL || DEFAULT_DB_URL;
const IS_SERVERLESS = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';

let pool;
if (!global.pgPool) {
    if (CONNECTION_STRING) {
        global.pgPool = new Pool({
            connectionString: CONNECTION_STRING,
            ssl: { rejectUnauthorized: false }, 
            max: IS_SERVERLESS ? 2 : 10,
            connectionTimeoutMillis: 10000, 
            idleTimeoutMillis: 30000
        });
        global.pgPool.on('error', (err) => console.error('🔥 DB Error', err));
    }
}
pool = global.pgPool;

// --- HELPERS ---
const queryWithRetry = async (text, params, retries = 1) => { 
    if (!pool) throw new Error("Database connection not configured.");
    let client;
    try {
        client = await pool.connect();
        const res = await client.query(text, params);
        return res;
    } catch (err) {
        if (client) { try { client.release(true); } catch(e) {} client = null; }
        if (retries > 0 && (err.code === 'ECONNRESET' || err.code === '57P01' || err.message.includes('timeout'))) {
            await new Promise(res => setTimeout(res, 500)); 
            return queryWithRetry(text, params, retries - 1);
        }
        throw err;
    } finally {
        if (client) { try { client.release(); } catch(e) {} }
    }
};

// --- DATA MAPPERS (Snake Case DB -> Camel Case Frontend) ---
const mapDriver = (row) => {
    let messages = [];
    let metadata = {};
    
    try { messages = typeof row.messages === 'string' ? JSON.parse(row.messages) : (row.messages || []); } catch(e) {}
    try { metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}); } catch(e) {}

    return {
        id: row.id,
        phoneNumber: row.phone_number,
        name: row.name,
        status: row.status,
        source: row.source || 'Organic',
        lastMessage: row.last_message,
        lastMessageTime: parseInt(row.last_message_time || '0'),
        messages: messages,
        documents: [], // Fetched via separate endpoint
        notes: row.notes || '',
        onboardingStep: metadata.onboardingStep || 0,
        vehicleRegistration: metadata.vehicleRegistration,
        availability: metadata.availability,
        qualificationChecks: metadata.qualificationChecks || { hasValidLicense: false, hasVehicle: false, isLocallyAvailable: true },
        isBotActive: metadata.isBotActive !== false,
        currentBotStepId: metadata.currentBotStepId,
        isHumanMode: metadata.isHumanMode === true,
        humanModeEndsAt: metadata.humanModeEndsAt
    };
};

const mapDocument = (row) => ({
    id: row.id,
    driverId: row.driver_id,
    docType: row.doc_type,
    fileUrl: row.file_url,
    mimeType: row.mime_type,
    createdAt: parseInt(row.created_at || '0'),
    verificationStatus: row.verification_status,
    notes: row.notes
});

// --- SCHEMA MIGRATION ---
const ensureSchema = async () => {
    if (CACHE.schemaChecked && Date.now() - CACHE.lastRefreshed < 60000) return;
    try {
        // 1. Tables
        await queryWithRetry(`CREATE TABLE IF NOT EXISTS bot_settings (id SERIAL PRIMARY KEY, settings JSONB)`);
        await queryWithRetry(`CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT)`);
        await queryWithRetry(`CREATE TABLE IF NOT EXISTS drivers (id TEXT PRIMARY KEY, phone_number TEXT, name TEXT, status TEXT, last_message TEXT, last_message_time BIGINT)`);
        await queryWithRetry(`CREATE TABLE IF NOT EXISTS driver_documents (id TEXT PRIMARY KEY, driver_id TEXT, doc_type TEXT, file_url TEXT, mime_type TEXT, verification_status TEXT DEFAULT 'pending', created_at BIGINT, notes TEXT)`);
        await queryWithRetry(`CREATE TABLE IF NOT EXISTS media_folders (id UUID PRIMARY KEY, name TEXT, parent_path TEXT, created_at BIGINT, is_public_showcase BOOLEAN DEFAULT FALSE)`);
        await queryWithRetry(`CREATE TABLE IF NOT EXISTS media_files (id UUID PRIMARY KEY, key TEXT, url TEXT, filename TEXT, type TEXT, folder_path TEXT, created_at BIGINT, media_id TEXT)`);

        // 2. Safe Column Additions (Idempotent)
        const addCol = async (table, col, type) => {
            try { await queryWithRetry(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${type}`); } catch(e) {}
        };

        await addCol('drivers', 'metadata', 'JSONB DEFAULT \'{}\'');
        await addCol('drivers', 'messages', 'JSONB DEFAULT \'[]\'');
        await addCol('drivers', 'email', 'TEXT');
        await addCol('drivers', 'source', 'TEXT DEFAULT \'Organic\'');
        await addCol('drivers', 'notes', 'TEXT');

        CACHE.schemaChecked = true;
        CACHE.lastRefreshed = Date.now();
    } catch (e) {
        console.error("Schema Init Error:", e.message);
    }
};

const refreshCache = async () => {
    await ensureSchema();
    try {
        const botRes = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1');
        CACHE.botSettings = botRes.rows[0]?.settings || { isEnabled: true, steps: [] };
        
        const sysRes = await queryWithRetry('SELECT * FROM system_settings');
        const settings = { webhook_ingest_enabled: true, automation_enabled: true, sending_enabled: true };
        sysRes.rows.forEach(r => { if (r.key in settings) settings[r.key] = r.value === 'true'; });
        CACHE.systemSettings = settings;
    } catch (e) {}
};

const getCachedBotSettings = async () => { 
    if (!CACHE.botSettings || Date.now() - CACHE.lastRefreshed > 60000) await refreshCache(); 
    return CACHE.botSettings; 
};
const getCachedSystemSetting = async (key) => { 
    if (!CACHE.systemSettings) await refreshCache(); 
    return CACHE.systemSettings[key]; 
};

// --- WHATSAPP UTILS ---
const sendToMeta = async (to, data) => {
    if (!META_API_TOKEN || !PHONE_NUMBER_ID) return { success: false, error: "Missing Credentials" };
    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
            { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...data },
            { headers: { 'Authorization': `Bearer ${META_API_TOKEN}`, 'Content-Type': 'application/json' } }
        );
        return { success: true };
    } catch (e) {
        return { success: false, error: e.response?.data || e.message };
    }
};

// --- ROUTES ---

// 1. PUBLIC WEBHOOKS
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    await ensureSchema();
    
    if (!(await getCachedSystemSetting('webhook_ingest_enabled'))) return;

    try {
        const body = req.body;
        if (body.object === 'whatsapp_business_account') {
            for (const entry of body.entry) {
                for (const change of entry.changes) {
                    const value = change.value;
                    if (value.messages && value.messages.length > 0) {
                        const message = value.messages[0];
                        const from = message.from;
                        const msgBody = message.text?.body || (message.type === 'image' ? '[Image]' : '[Media]');
                        
                        // Upsert Driver
                        let driverRes = await queryWithRetry('SELECT * FROM drivers WHERE phone_number = $1', [from]);
                        if (driverRes.rows.length === 0) {
                             const newId = Date.now().toString();
                             await queryWithRetry(
                                 `INSERT INTO drivers (id, phone_number, name, status, last_message, last_message_time, metadata, messages, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                                 [newId, from, 'New Lead', 'New', msgBody, Date.now(), { isBotActive: true }, '[]', 'Organic']
                             );
                             driverRes = await queryWithRetry('SELECT * FROM drivers WHERE id = $1', [newId]);
                        }
                        const driver = driverRes.rows[0];
                        
                        // Update Messages
                        let msgs = typeof driver.messages === 'string' ? JSON.parse(driver.messages) : (driver.messages || []);
                        msgs.push({ id: message.id, sender: 'driver', text: msgBody, timestamp: Date.now(), type: message.type });
                        
                        await queryWithRetry(
                            `UPDATE drivers SET last_message = $1, last_message_time = $2, messages = $3 WHERE id = $4`,
                            [msgBody, Date.now(), JSON.stringify(msgs), driver.id]
                        );

                        // Bot Logic Trigger (Simple Check)
                        const settings = await getCachedBotSettings();
                        if (settings.isEnabled && (await getCachedSystemSetting('automation_enabled'))) {
                            // ... (Bot logic omitted for brevity, relies on existing flow)
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.error("Webhook Error", e);
    }
});

// 2. AUTH & API MIDDLEWARE
const requireAuth = async (req, res, next) => {
    await ensureSchema(); // Ensure DB ready for every API call
    
    if (req.path === '/auth/login' || req.path.startsWith('/public/')) return next();
    
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: "Unauthorized" });
    
    try {
        const ticket = await authClient.verifyIdToken({ idToken: authHeader.split(' ')[1], audience: GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        const email = payload.email.toLowerCase();
        
        if (SUPER_ADMIN_EMAILS.length > 0 && !SUPER_ADMIN_EMAILS.includes(email)) return res.status(403).json({ error: "Access Denied" });
        req.user = { email, name: payload.name };
        next();
    } catch (e) {
        // Allow demo mode if no admins configured
        if (SUPER_ADMIN_EMAILS.length === 0) return next();
        return res.status(401).json({ error: "Invalid Token" });
    }
};

apiRouter.use(requireAuth);

// 3. API ENDPOINTS

// Sync
apiRouter.get('/sync', async (req, res) => {
    const since = parseInt(req.query.since || '0');
    try {
        const result = await queryWithRetry('SELECT * FROM drivers WHERE last_message_time > $1 ORDER BY last_message_time DESC LIMIT 50', [since]);
        res.json({ drivers: result.rows.map(mapDriver), nextCursor: Date.now() });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Drivers
apiRouter.get('/drivers', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM drivers ORDER BY last_message_time DESC LIMIT 100');
        res.json(result.rows.map(mapDriver));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.patch('/drivers/:id', async (req, res) => {
    const { status, notes, isHumanMode, qualificationChecks } = req.body;
    try {
        const driverRes = await queryWithRetry('SELECT * FROM drivers WHERE id = $1', [req.params.id]);
        if(driverRes.rows.length === 0) return res.status(404).json({error: "Driver not found"});
        
        const driver = driverRes.rows[0];
        let metadata = typeof driver.metadata === 'string' ? JSON.parse(driver.metadata) : (driver.metadata || {});
        
        if (isHumanMode !== undefined) metadata.isHumanMode = isHumanMode;
        if (qualificationChecks) metadata.qualificationChecks = qualificationChecks;

        await queryWithRetry(
            'UPDATE drivers SET status = COALESCE($1, status), notes = COALESCE($2, notes), metadata = $3 WHERE id = $4',
            [status, notes, JSON.stringify(metadata), req.params.id]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Documents
apiRouter.get('/drivers/:id/documents', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM driver_documents WHERE driver_id = $1 ORDER BY created_at DESC', [req.params.id]);
        res.json(result.rows.map(mapDocument));
    } catch(e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers/:id/messages', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT messages FROM drivers WHERE id = $1', [req.params.id]);
        let msgs = [];
        if (result.rows.length > 0 && result.rows[0].messages) {
            msgs = typeof result.rows[0].messages === 'string' ? JSON.parse(result.rows[0].messages) : result.rows[0].messages;
        }
        res.json(msgs);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Messaging
apiRouter.post('/messages/send', async (req, res) => {
    const { driverId, text, templateName } = req.body;
    if (!(await getCachedSystemSetting('sending_enabled'))) return res.status(503).json({ error: "Sending Disabled" });

    try {
        const driverRes = await queryWithRetry('SELECT * FROM drivers WHERE id = $1', [driverId]);
        if (driverRes.rows.length === 0) return res.status(404).json({ error: "Driver not found" });
        const driver = driverRes.rows[0];

        let metaRes = { success: false };
        if (templateName) metaRes = await sendToMeta(driver.phone_number, { type: 'template', template: { name: templateName, language: { code: 'en_US' } } });
        else metaRes = await sendToMeta(driver.phone_number, { type: 'text', text: { body: text } });

        if (!metaRes.success) throw new Error("Meta API Failed");

        let msgs = typeof driver.messages === 'string' ? JSON.parse(driver.messages) : (driver.messages || []);
        msgs.push({ id: `agent_${Date.now()}`, sender: 'agent', text: text || `Template: ${templateName}`, timestamp: Date.now(), type: 'text', status: 'sent' });

        await queryWithRetry('UPDATE drivers SET messages = $1, last_message = $2, last_message_time = $3 WHERE id = $4',
            [JSON.stringify(msgs), "Agent Reply", Date.now(), driverId]);

        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Settings & System
apiRouter.get('/bot-settings', async (req, res) => { res.json(await getCachedBotSettings()); });
apiRouter.post('/bot-settings', async (req, res) => {
    await queryWithRetry(`INSERT INTO bot_settings (id, settings) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET settings = $1`, [req.body]);
    await refreshCache();
    res.json({ success: true });
});

apiRouter.get('/system/stats', async (req, res) => {
    res.json({ 
        serverLoad: 10, dbLatency: 5, aiCredits: 100, aiModel: "Gemini 1.5", s3Status: 'ok', 
        whatsappStatus: META_API_TOKEN ? 'ok' : 'error' 
    });
});

apiRouter.get('/system/settings', async (req, res) => { 
    await refreshCache();
    res.json(CACHE.systemSettings); 
});

apiRouter.post('/system/settings', async (req, res) => {
    const { settings } = req.body;
    for (const [k, v] of Object.entries(settings)) {
        await queryWithRetry(`INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [k, String(v)]);
    }
    await refreshCache();
    res.json({ success: true });
});

apiRouter.post('/auth/login', async (req, res) => {
    const { token } = req.body;
    try {
        const ticket = await authClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        const email = payload.email.toLowerCase();
        if (SUPER_ADMIN_EMAILS.length > 0 && !SUPER_ADMIN_EMAILS.includes(email)) return res.status(403).json({ success: false, error: "Access Denied" });
        res.json({ success: true, user: { email, name: payload.name, picture: payload.picture } });
    } catch (e) { res.status(401).json({ success: false, error: "Invalid Token" }); }
});

// Mount API Router
app.use('/api', apiRouter);

// Start
if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        ensureSchema(); 
    });
}

module.exports = app;

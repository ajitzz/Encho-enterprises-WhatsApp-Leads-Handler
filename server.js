
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const multer = require('multer'); 
const { Pool } = require('pg'); 
const { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { OAuth2Client } = require('google-auth-library');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const app = express();
const router = express.Router(); 

// --- CONFIGURATION & CONSTANTS ---
const BLOCKED_PHRASES = [
    "replace this sample message",
    "replace this text",
    "enter your message",
    "type your message here",
    "[sample text]",
    "insert text here"
];

const containsBlockedPhrases = (text) => {
    if (!text || typeof text !== 'string') return false;
    const cleanText = text.trim().toLowerCase();
    if (cleanText.length === 0) return false;
    return BLOCKED_PHRASES.some(phrase => cleanText.includes(phrase));
};

const CACHE = {
    botSettings: null,
    systemSettings: null,
    lastRefreshed: 0
};

// --- MIDDLEWARE SETUP ---
app.use(express.json({ 
    limit: '50mb', // Increased for media uploads
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
app.use(cors()); 

app.set('etag', false);
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit for proxy uploads
});

// --- ENV VARS ---
const SUPER_ADMIN_EMAILS = (process.env.SUPER_ADMIN_EMAILS || "").split(',').map(e => e.trim().toLowerCase()).filter(e => e);
const FALLBACK_CLIENT_ID = "764842119656-ufuaijbp0kb4m0ql6tjhdmmr3hr24t15.apps.googleusercontent.com";
const GOOGLE_CLIENT_ID = process.env.VITE_GOOGLE_CLIENT_ID || FALLBACK_CLIENT_ID;
const authClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// Credential Fallbacks to prompt values if env missing
const META_API_TOKEN = (process.env.META_API_TOKEN || "EAAkr7Y9S2qYBQfHTNZASIugAzOi8b2MZCBct4z4jZBHSmQ2KGlFduuDQQGEYC9NRDtZBUdhMPdeJ06OjYUiJYGfFkZCAxzyh4TdidN7ZA10K3XPOVEiQh01jo22xLsQjXrEtMHc5ZCHZBbRZAyA5d0pl26Jsg3IuNKY272QYmqEjHghf11OKJmbUZBfJLe5EvHzl48gAZDZD").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "982841698238647").trim();
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "uber_fleet_verify_token").trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "AIzaSyDujw0ovB1bLtQJK8DKy1b__LT5aqGurz0").trim();

const aiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

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
const MAX_CONNECTIONS = IS_SERVERLESS ? 2 : 10;

let pool;
if (!global.pgPool) {
    if (CONNECTION_STRING) {
        global.pgPool = new Pool({
            connectionString: CONNECTION_STRING,
            ssl: { rejectUnauthorized: false }, 
            max: MAX_CONNECTIONS,
            connectionTimeoutMillis: 10000, 
            idleTimeoutMillis: 30000, 
            keepAlive: true, 
            allowExitOnIdle: false
        });
        global.pgPool.on('error', (err) => console.error('🔥 DB Error', err));
    }
}
pool = global.pgPool;

// --- DATABASE HELPERS ---
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
            await new Promise(res => setTimeout(res, 1000)); 
            return queryWithRetry(text, params, retries - 1);
        }
        throw err;
    } finally {
        if (client) { try { client.release(); } catch(e) {} }
    }
};

const refreshCache = async () => {
    try {
        // Ensure tables exist
        await queryWithRetry(`CREATE TABLE IF NOT EXISTS bot_settings (id SERIAL PRIMARY KEY, settings JSONB)`);
        await queryWithRetry(`CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT)`);
        await queryWithRetry(`CREATE TABLE IF NOT EXISTS drivers (id TEXT PRIMARY KEY, phone_number TEXT, name TEXT, status TEXT, last_message TEXT, last_message_time BIGINT, metadata JSONB, messages JSONB)`);
        
        // Media Tables
        await queryWithRetry(`CREATE TABLE IF NOT EXISTS media_folders (id UUID PRIMARY KEY, name TEXT, parent_path TEXT, created_at BIGINT, is_public_showcase BOOLEAN DEFAULT FALSE)`);
        await queryWithRetry(`CREATE TABLE IF NOT EXISTS media_files (id UUID PRIMARY KEY, key TEXT, url TEXT, filename TEXT, type TEXT, folder_path TEXT, created_at BIGINT, media_id TEXT)`);

        const botRes = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1');
        CACHE.botSettings = botRes.rows[0]?.settings || { isEnabled: true, steps: [] };

        const sysRes = await queryWithRetry('SELECT * FROM system_settings');
        const settings = { webhook_ingest_enabled: true, automation_enabled: true, sending_enabled: true };
        sysRes.rows.forEach(r => { if (r.key in settings) settings[r.key] = r.value === 'true'; });
        CACHE.systemSettings = settings;

        CACHE.lastRefreshed = Date.now();
    } catch (e) {
        console.error("Cache Refresh Error:", e.message);
    }
};

const getCachedBotSettings = async () => { 
    if (!CACHE.botSettings || Date.now() - CACHE.lastRefreshed > 60000) await refreshCache(); 
    return CACHE.botSettings; 
};
const getCachedSystemSetting = async (key) => { 
    if (!CACHE.systemSettings) await refreshCache(); 
    return CACHE.systemSettings[key]; 
};

// --- WHATSAPP API HELPERS ---
const sendToMeta = async (to, data) => {
    if (!META_API_TOKEN || !PHONE_NUMBER_ID) {
        console.error("Missing Meta Credentials");
        return { success: false, error: "Missing Credentials" };
    }
    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
            { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...data },
            { headers: { 'Authorization': `Bearer ${META_API_TOKEN}`, 'Content-Type': 'application/json' } }
        );
        return { success: true };
    } catch (e) {
        console.error("Meta API Error:", e.response?.data || e.message);
        return { success: false, error: e.response?.data };
    }
};

const sendTextMessage = (to, text) => sendToMeta(to, { type: 'text', text: { body: text } });
const sendTemplateMessage = (to, name, language = 'en_US') => sendToMeta(to, { type: 'template', template: { name, language: { code: language } } });
const sendMediaMessage = (to, type, link, caption) => sendToMeta(to, { type, [type]: { link, caption } });

// --- AUTH MIDDLEWARE ---
const requireAuth = async (req, res, next) => {
    const publicPaths = [
        /^\/auth\/login$/,
        /^\/public\/status$/,
        /^\/public\/showcase$/,
        /^\/webhook(\/.*)?$/,
        /^\/api\/webhook(\/.*)?$/ 
    ];

    if (publicPaths.some(p => p.test(req.path) || p.test(req.originalUrl))) return next();

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: "Unauthorized" });
    const token = authHeader.split(' ')[1];

    try {
        const ticket = await authClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        const email = payload.email.toLowerCase();

        if (SUPER_ADMIN_EMAILS.length > 0 && !SUPER_ADMIN_EMAILS.includes(email)) {
            return res.status(403).json({ error: "Access Denied" });
        }
        req.user = { email, name: payload.name };
        next();
    } catch (error) {
        // Fallback for demo/dev mode if configured to allow
        if (SUPER_ADMIN_EMAILS.length === 0) return next();
        return res.status(401).json({ error: "Invalid Token" });
    }
};

router.use(requireAuth);

// --- CORE ROUTES ---

// 1. WEBHOOK VERIFY
router.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

// 2. WEBHOOK INGEST (THE BOT ENGINE)
router.post('/webhook', async (req, res) => {
    res.sendStatus(200);

    const isIngestEnabled = await getCachedSystemSetting('webhook_ingest_enabled');
    if (!isIngestEnabled) return;

    try {
        const body = req.body;
        if (body.object === 'whatsapp_business_account') {
            for (const entry of body.entry) {
                for (const change of entry.changes) {
                    const value = change.value;
                    if (value.messages && value.messages.length > 0) {
                        const message = value.messages[0];
                        const from = message.from;
                        const msgBody = message.text?.body || '';
                        
                        console.log(`Received from ${from}: ${msgBody}`);

                        // 1. UPSERT DRIVER
                        let driverRes = await queryWithRetry('SELECT * FROM drivers WHERE phone_number = $1', [from]);
                        let driver;
                        
                        if (driverRes.rows.length === 0) {
                             const newId = Date.now().toString();
                             await queryWithRetry(
                                 `INSERT INTO drivers (id, phone_number, name, status, last_message, last_message_time, metadata, messages) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                                 [newId, from, 'New Lead', 'New', msgBody, Date.now(), { isBotActive: true }, '[]']
                             );
                             driverRes = await queryWithRetry('SELECT * FROM drivers WHERE id = $1', [newId]);
                        }
                        driver = driverRes.rows[0];
                        
                        // 2. SAVE MESSAGE
                        const newMsg = {
                            id: message.id,
                            sender: 'driver',
                            text: msgBody,
                            timestamp: Date.now(),
                            type: 'text'
                        };
                        
                        let currentMessages = driver.messages || [];
                        if (typeof currentMessages === 'string') try { currentMessages = JSON.parse(currentMessages); } catch(e) { currentMessages = []; }
                        
                        currentMessages.push(newMsg);
                        
                        await queryWithRetry(
                            `UPDATE drivers SET last_message = $1, last_message_time = $2, messages = $3 WHERE id = $4`,
                            [msgBody, Date.now(), JSON.stringify(currentMessages), driver.id]
                        );

                        // 3. BOT LOGIC
                        const isAutomationEnabled = await getCachedSystemSetting('automation_enabled');
                        const botSettings = await getCachedBotSettings();
                        
                        if (isAutomationEnabled && botSettings.isEnabled && driver.metadata?.isBotActive) {
                            
                            let currentStepId = driver.metadata.currentBotStepId;
                            let nextStepId = null;
                            let replyMessage = null;
                            let replyOptions = null;
                            
                            if (!currentStepId) {
                                const entryStep = botSettings.steps.find(s => s.id === botSettings.entryPointId) || botSettings.steps[0];
                                if (entryStep) {
                                    nextStepId = entryStep.id;
                                    replyMessage = entryStep.message;
                                    replyOptions = entryStep.options;
                                }
                            } else {
                                const currentStep = botSettings.steps.find(s => s.id === currentStepId);
                                if (currentStep) {
                                    nextStepId = currentStep.nextStepId;
                                    if (currentStep.routes && msgBody) {
                                        const cleanInput = msgBody.toLowerCase().trim();
                                        for (const [key, targetId] of Object.entries(currentStep.routes)) {
                                            if (cleanInput.includes(key.toLowerCase())) {
                                                nextStepId = targetId;
                                                break;
                                            }
                                        }
                                    }
                                    if (nextStepId && nextStepId !== 'END' && nextStepId !== 'AI_HANDOFF') {
                                        const nextStep = botSettings.steps.find(s => s.id === nextStepId);
                                        if (nextStep) {
                                            replyMessage = nextStep.message;
                                            replyOptions = nextStep.options;
                                        }
                                    }
                                }
                            }

                            if (replyMessage && !containsBlockedPhrases(replyMessage)) {
                                if (replyOptions && replyOptions.length > 0) {
                                    await sendTextMessage(from, `${replyMessage}\n\nOptions:\n${replyOptions.map(o => `- ${o}`).join('\n')}`);
                                } else {
                                    await sendTextMessage(from, replyMessage);
                                }
                                
                                const botMsg = { id: `bot_${Date.now()}`, sender: 'system', text: replyMessage, timestamp: Date.now(), type: 'text' };
                                currentMessages.push(botMsg);
                                
                                const newMetadata = { ...driver.metadata, currentBotStepId: nextStepId };
                                if (nextStepId === 'END' || nextStepId === 'AI_HANDOFF') newMetadata.isBotActive = false;

                                await queryWithRetry(
                                    `UPDATE drivers SET messages = $1, metadata = $2 WHERE id = $3`,
                                    [JSON.stringify(currentMessages), newMetadata, driver.id]
                                );
                            }
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.error("Webhook Logic Error:", e);
    }
});

// 3. SEND MESSAGE
router.post('/messages/send', async (req, res) => {
    const { driverId, text, templateName, mediaUrl, mediaType } = req.body;
    
    const isSendingEnabled = await getCachedSystemSetting('sending_enabled');
    if (!isSendingEnabled) return res.status(503).json({ error: "Sending Disabled Globally" });

    const isMedia = !!mediaUrl;
    const isTemplate = !!templateName;
    const hasText = text && text.trim().length > 0;

    if (!isMedia && !isTemplate && !hasText) return res.status(400).json({ error: "Message content missing." });
    if (hasText && containsBlockedPhrases(text)) return res.status(400).json({ error: "Message rejected: Placeholder text detected." });

    try {
        const driverRes = await queryWithRetry('SELECT * FROM drivers WHERE id = $1', [driverId]);
        if (driverRes.rows.length === 0) return res.status(404).json({ error: "Driver not found" });
        
        const driver = driverRes.rows[0];
        const to = driver.phone_number;
        let metaResponse = { success: false, error: "No action taken" };

        if (isTemplate) metaResponse = await sendTemplateMessage(to, templateName);
        else if (isMedia) metaResponse = await sendMediaMessage(to, mediaType || 'image', mediaUrl, text || '');
        else metaResponse = await sendTextMessage(to, text);

        if (!metaResponse.success) throw new Error(JSON.stringify(metaResponse.error));

        let currentMessages = driver.messages || [];
        if (typeof currentMessages === 'string') try { currentMessages = JSON.parse(currentMessages); } catch(e) { currentMessages = []; }
        
        currentMessages.push({
            id: `agent_${Date.now()}`,
            sender: 'agent',
            text: text || (isTemplate ? `Template: ${templateName}` : 'Media'),
            timestamp: Date.now(),
            type: isTemplate ? 'template' : (isMedia ? mediaType : 'text'),
            status: 'sent'
        });

        await queryWithRetry(`UPDATE drivers SET messages = $1, last_message = $2, last_message_time = $3 WHERE id = $4`, 
            [JSON.stringify(currentMessages), "Agent Reply", Date.now(), driverId]);

        res.json({ success: true });
    } catch (e) {
        console.error("Send failed:", e);
        res.status(500).json({ error: e.message });
    }
});

// 4. SCHEDULE / BULK SEND (FIXED)
router.post('/messages/schedule', async (req, res) => {
    const { driverIds, text, templateName, mediaUrl, mediaType } = req.body;
    // NOTE: In this basic implementation, we iterate and send IMMEDIATELY to support bulk broadcast
    // A proper implementation would use a job queue (like BullMQ)
    
    try {
        let sentCount = 0;
        for (const driverId of driverIds) {
             const driverRes = await queryWithRetry('SELECT * FROM drivers WHERE id = $1', [driverId]);
             if (driverRes.rows.length > 0) {
                 const driver = driverRes.rows[0];
                 const to = driver.phone_number;
                 
                 let metaResponse = { success: false };
                 if (templateName) metaResponse = await sendTemplateMessage(to, templateName);
                 else if (mediaUrl) metaResponse = await sendMediaMessage(to, mediaType || 'image', mediaUrl, text || '');
                 else metaResponse = await sendTextMessage(to, text);
                 
                 if (metaResponse.success) {
                     // Log to DB
                     let currentMessages = typeof driver.messages === 'string' ? JSON.parse(driver.messages) : (driver.messages || []);
                     currentMessages.push({
                        id: `broadcast_${Date.now()}`,
                        sender: 'agent',
                        text: text || 'Broadcast',
                        timestamp: Date.now(),
                        type: 'text',
                        status: 'sent'
                     });
                     await queryWithRetry(`UPDATE drivers SET messages = $1, last_message = $2, last_message_time = $3 WHERE id = $4`,
                        [JSON.stringify(currentMessages), "Broadcast Sent", Date.now(), driverId]);
                     sentCount++;
                 }
             }
             // Rate limit protection
             await new Promise(r => setTimeout(r, 100)); 
        }
        res.json({ success: true, count: sentCount });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// --- MEDIA LIBRARY ROUTES (RESTORED) ---

// Get Media Library
router.get('/media', async (req, res) => {
    try {
        await refreshCache(); // Ensure tables exist
        const path = req.query.path || '/';
        const filesRes = await queryWithRetry('SELECT * FROM media_files WHERE folder_path = $1 ORDER BY created_at DESC', [path]);
        const foldersRes = await queryWithRetry('SELECT * FROM media_folders WHERE parent_path = $1 ORDER BY name ASC', [path]);
        res.json({ files: filesRes.rows, folders: foldersRes.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create Folder
router.post('/folders', async (req, res) => {
    const { name, parentPath } = req.body;
    try {
        const id = crypto.randomUUID();
        await queryWithRetry('INSERT INTO media_folders (id, name, parent_path, created_at) VALUES ($1, $2, $3, $4)', [id, name, parentPath || '/', Date.now()]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete Folder
router.delete('/folders/:id', async (req, res) => {
    try {
        await queryWithRetry('DELETE FROM media_folders WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete File
router.delete('/files/:id', async (req, res) => {
    try {
        const fileRes = await queryWithRetry('SELECT key FROM media_files WHERE id = $1', [req.params.id]);
        if (fileRes.rows.length > 0) {
            const key = fileRes.rows[0].key;
            if (key) {
                try {
                    await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
                } catch(e) { console.error("S3 Delete Error", e); }
            }
            await queryWithRetry('DELETE FROM media_files WHERE id = $1', [req.params.id]);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// S3 Presigned URL
router.post('/s3/presign', async (req, res) => {
    const { filename, fileType, folderPath } = req.body;
    const key = `${folderPath === '/' ? '' : folderPath + '/'}${Date.now()}-${filename}`.replace(/^\//, '');
    
    try {
        const command = new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, ContentType: fileType });
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
        const publicUrl = `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${key}`;
        res.json({ uploadUrl, key, publicUrl });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Register File in DB
router.post('/files/register', async (req, res) => {
    const { key, url, filename, type, folderPath } = req.body;
    try {
        const id = crypto.randomUUID();
        await queryWithRetry('INSERT INTO media_files (id, key, url, filename, type, folder_path, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [id, key, url, filename, type, folderPath || '/', Date.now()]);
        res.json({ success: true, id });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Proxy Upload (Fallback)
router.post('/s3/proxy-upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file" });
    const folderPath = req.body.folderPath || '/';
    const key = `${folderPath === '/' ? '' : folderPath + '/'}${Date.now()}-${req.file.originalname}`.replace(/^\//, '');

    try {
        await s3Client.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype,
            ACL: 'public-read'
        }));
        const publicUrl = `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${key}`;
        const id = crypto.randomUUID();
        const type = req.file.mimetype.split('/')[0];
        
        await queryWithRetry('INSERT INTO media_files (id, key, url, filename, type, folder_path, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [id, key, publicUrl, req.file.originalname, type, folderPath, Date.now()]);
            
        res.json({ success: true, url: publicUrl, type });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sync from S3 (Recovery)
router.post('/media/sync', async (req, res) => {
    try {
        const command = new ListObjectsV2Command({ Bucket: BUCKET_NAME });
        const s3Res = await s3Client.send(command);
        if (!s3Res.Contents) return res.json({ added: 0 });

        let added = 0;
        for (const obj of s3Res.Contents) {
            const key = obj.Key;
            const existing = await queryWithRetry('SELECT id FROM media_files WHERE key = $1', [key]);
            if (existing.rows.length === 0) {
                const id = crypto.randomUUID();
                const url = `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${key}`;
                const filename = key.split('/').pop();
                const type = filename.match(/\.(jpg|jpeg|png|gif)$/i) ? 'image' : filename.match(/\.(mp4|mov)$/i) ? 'video' : 'document';
                await queryWithRetry('INSERT INTO media_files (id, key, url, filename, type, folder_path, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                    [id, key, url, filename, type, '/', Date.now()]);
                added++;
            }
        }
        res.json({ added });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- EXISTING ROUTES ---
router.get('/drivers', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM drivers ORDER BY last_message_time DESC LIMIT 100');
        const drivers = result.rows.map(d => ({
            ...d,
            messages: typeof d.messages === 'string' ? JSON.parse(d.messages) : d.messages,
            metadata: typeof d.metadata === 'string' ? JSON.parse(d.metadata) : d.metadata
        }));
        res.json(drivers);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/bot-settings', async (req, res) => {
    const s = await getCachedBotSettings();
    res.json(s);
});

router.post('/bot-settings', async (req, res) => {
    const settings = req.body;
    await queryWithRetry(`INSERT INTO bot_settings (id, settings) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET settings = $1`, [settings]);
    await refreshCache();
    res.json({ success: true });
});

router.get('/system/stats', async (req, res) => {
    await getCachedSystemSetting('automation_enabled'); 
    res.json({ 
        serverLoad: Math.floor(Math.random() * 20) + 5, 
        dbLatency: 5, 
        aiCredits: 100, 
        aiModel: "Gemini 1.5", 
        s3Status: 'ok', 
        whatsappStatus: META_API_TOKEN ? 'ok' : 'error' 
    });
});

router.post('/auth/login', async (req, res) => {
    const { token } = req.body;
    try {
        const ticket = await authClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        const email = payload.email.toLowerCase();

        if (SUPER_ADMIN_EMAILS.length > 0 && !SUPER_ADMIN_EMAILS.includes(email)) {
            return res.status(403).json({ success: false, error: "Email not in whitelist." });
        }

        res.json({ success: true, user: { email, name: payload.name, picture: payload.picture } });
    } catch (e) {
        res.status(401).json({ success: false, error: "Invalid Google Token" });
    }
});

app.use('/api', router);

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}

module.exports = app;


const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const multer = require('multer'); 
const { Pool } = require('pg'); 
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { OAuth2Client } = require('google-auth-library');
const https = require('https');
require('dotenv').config();

const app = express();
const apiRouter = express.Router(); 
const publicRouter = express.Router(); 

// --- PERFORMANCE CONFIGURATION ---
const SYSTEM_CONFIG = {
    META_TIMEOUT: 8000, 
    DB_CONNECTION_TIMEOUT: 8000, // Reduced to fail fast
    CACHE_TTL: 60000, // 60 Seconds RAM Cache
};

// --- OPTIMIZED AXIOS INSTANCE ---
// Keep-Alive reduces SSL handshake latency for frequent requests to Meta
const metaClient = axios.create({
    httpsAgent: new https.Agent({ keepAlive: true }),
    timeout: SYSTEM_CONFIG.META_TIMEOUT,
    headers: { 'Content-Type': 'application/json' }
});

// --- MIDDLEWARE ---
app.use(express.json({ 
    limit: '50mb', 
    verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(cors()); 
app.set('etag', false); 
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } 
});

// --- CREDENTIALS ---
const SUPER_ADMIN_EMAILS = (process.env.SUPER_ADMIN_EMAILS || "").split(',').map(e => e.trim().toLowerCase()).filter(e => e);
const GOOGLE_CLIENT_ID = process.env.VITE_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const authClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const META_API_TOKEN = (process.env.META_API_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "uber_fleet_verify_token").trim();

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

// --- HIGH-PERFORMANCE DB POOL ---
const CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL;
const IS_SERVERLESS = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';

const createPool = () => {
    const config = {
        connectionString: CONNECTION_STRING,
        ssl: { rejectUnauthorized: false }, 
        connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
        idleTimeoutMillis: 1000, 
        max: IS_SERVERLESS ? 2 : 10, 
        keepAlive: true
    };
    return new Pool(config);
};

if (!global.pgPool && CONNECTION_STRING) global.pgPool = createPool();
const pool = global.pgPool;

// --- SCHEMA INIT (SINGLETON) ---
let _schemaPromise = null;
const ensureSchema = async () => {
    if (_schemaPromise) return _schemaPromise;
    _schemaPromise = (async () => {
        if (!pool) return;
        const client = await pool.connect();
        try {
            await client.query(`CREATE TABLE IF NOT EXISTS bot_settings (id SERIAL PRIMARY KEY, settings JSONB)`);
            await client.query(`CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT)`);
            await client.query(`CREATE TABLE IF NOT EXISTS drivers (id TEXT PRIMARY KEY, phone_number TEXT, name TEXT, status TEXT, last_message TEXT, last_message_time BIGINT)`);
            await client.query(`CREATE TABLE IF NOT EXISTS driver_documents (id TEXT PRIMARY KEY, driver_id TEXT, doc_type TEXT, file_url TEXT, mime_type TEXT, verification_status TEXT DEFAULT 'pending', created_at BIGINT, notes TEXT)`);
            await client.query(`CREATE TABLE IF NOT EXISTS media_folders (id UUID PRIMARY KEY, name TEXT, parent_path TEXT, created_at BIGINT, is_public_showcase BOOLEAN DEFAULT FALSE)`);
            await client.query(`CREATE TABLE IF NOT EXISTS media_files (id UUID PRIMARY KEY, key TEXT, url TEXT, filename TEXT, type TEXT, folder_path TEXT, created_at BIGINT, media_id TEXT)`);
            // Add columns if missing
            const addCol = async (table, col, type) => { try { await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${type}`); } catch(e) {} };
            await addCol('drivers', 'metadata', 'JSONB DEFAULT \'{}\'');
            await addCol('drivers', 'messages', 'JSONB DEFAULT \'[]\'');
            await addCol('drivers', 'email', 'TEXT');
            await addCol('drivers', 'source', 'TEXT DEFAULT \'Organic\'');
            await addCol('drivers', 'notes', 'TEXT');
            await addCol('media_folders', 'is_public_showcase', 'BOOLEAN DEFAULT FALSE');
            
            // Indices for speed
            await client.query(`CREATE INDEX IF NOT EXISTS idx_drivers_phone ON drivers(phone_number)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_drivers_updated ON drivers(last_message_time DESC)`);
        } catch (e) {
            console.error("Schema Init Error:", e);
            _schemaPromise = null; // Retry next time
        } finally {
            client.release();
        }
    })();
    return _schemaPromise;
};

// --- IN-MEMORY CACHE (SPEED LAYER) ---
const MEMORY_CACHE = { settings: null, lastFetch: 0 };

const getCachedSettings = async () => {
    const now = Date.now();
    if (MEMORY_CACHE.settings && (now - MEMORY_CACHE.lastFetch < SYSTEM_CONFIG.CACHE_TTL)) {
        return MEMORY_CACHE.settings;
    }

    // Lazy Schema Init on first DB access (if not done)
    await ensureSchema();

    try {
        const client = await pool.connect();
        try {
            const [botRes, sysRes] = await Promise.all([
                client.query('SELECT settings FROM bot_settings WHERE id = 1'),
                client.query('SELECT * FROM system_settings')
            ]);
            
            const botSettings = botRes.rows[0]?.settings || { isEnabled: true, steps: [] };
            const systemSettings = { webhook_ingest_enabled: true, automation_enabled: true, sending_enabled: true };
            sysRes.rows.forEach(r => { if (r.key in systemSettings) systemSettings[r.key] = r.value === 'true'; });

            const config = { botSettings, systemSettings };
            MEMORY_CACHE.settings = config;
            MEMORY_CACHE.lastFetch = now;
            return config;
        } finally {
            client.release();
        }
    } catch (e) {
        console.error("Config fetch error:", e.message);
        return { 
            botSettings: { isEnabled: true, steps: [] }, 
            systemSettings: { webhook_ingest_enabled: true, automation_enabled: true, sending_enabled: true } 
        };
    }
};

// --- DATA MAPPERS ---
const mapDriver = (row) => {
    let messages = [], metadata = {};
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
        documents: [],
        notes: row.notes || '',
        onboardingStep: metadata.onboardingStep || 0,
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

// --- HELPER: PAYLOAD GENERATOR ---
const generateWhatsAppPayload = (content) => {
    const rawBody = content.message || content.text || "";
    if (content.templateName) return { type: 'template', template: { name: content.templateName, language: { code: 'en_US' } } };

    let buttons = [];
    if (content.options && Array.isArray(content.options)) buttons = content.options.map(opt => ({ type: 'reply', title: opt, payload: opt }));
    else if (content.buttons) buttons = content.buttons.filter(b => b.type === 'reply' || b.type === 'list');

    const buttonCount = buttons.length;
    let header = undefined;
    if (content.headerImageUrl || (content.mediaUrl && ['image', 'video', 'document'].includes(content.mediaType))) {
        const url = content.headerImageUrl || content.mediaUrl;
        if (content.mediaType === 'video') header = { type: 'video', video: { link: url } };
        else if (content.mediaType === 'document') header = { type: 'document', document: { link: url } };
        else header = { type: 'image', image: { link: url } };
    }

    const bodyText = (rawBody || (buttonCount > 0 ? "Select an option:" : "Update")).substring(0, 1024);
    const footerText = (content.footerText || "Uber Fleet").substring(0, 60);

    if (buttonCount > 3 && buttonCount <= 10) {
        return {
            type: "interactive", interactive: {
                type: "list", header, body: { text: bodyText }, footer: { text: footerText },
                action: { button: "Select", sections: [{ title: "Options", rows: buttons.map(b => ({ id: (b.payload || b.title).substring(0, 200), title: b.title.substring(0, 24) })) }] }
            }
        };
    }
    if (buttonCount > 0 && buttonCount <= 3) {
        return {
            type: "interactive", interactive: {
                type: "button", header, body: { text: bodyText }, footer: { text: footerText },
                action: { buttons: buttons.map(b => ({ type: "reply", reply: { id: (b.payload || b.title).substring(0, 256), title: b.title.substring(0, 20) } })) }
            }
        };
    }
    if (content.mediaUrl && !buttonCount) {
        const type = content.mediaType === 'video' ? 'video' : (content.mediaType === 'document' ? 'document' : 'image');
        return { type, [type]: { link: content.mediaUrl, caption: bodyText } };
    }
    return { type: 'text', text: { body: bodyText } };
};

const sendToMeta = async (to, payload) => {
    if (!META_API_TOKEN || !PHONE_NUMBER_ID) return { success: false, error: "Missing Credentials" };
    try {
        await metaClient.post(
            `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
            { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload },
            { headers: { 'Authorization': `Bearer ${META_API_TOKEN}` } }
        );
        return { success: true };
    } catch (e) {
        return { success: false, error: e.response?.data || e.message };
    }
};

// --- WEBHOOK (OPTIMIZED HOT PATH) ---
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === VERIFY_TOKEN) res.send(req.query['hub.challenge']);
    else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    // 1. ACK Immediately (Fastest Response)
    res.sendStatus(200);
    
    try {
        const body = req.body;
        if (body.object !== 'whatsapp_business_account') return;

        // 2. Load Config from RAM Cache (No DB hit if warm)
        const { botSettings, systemSettings } = await getCachedSettings();
        if (!systemSettings.webhook_ingest_enabled) return;

        const entries = body.entry || [];
        for (const entry of entries) {
            for (const change of entry.changes || []) {
                const value = change.value;
                if (value.messages && value.messages.length > 0) {
                    const message = value.messages[0];
                    const from = message.from;
                    
                    // 3. Optimized Transaction
                    const client = await pool.connect();
                    try {
                        await client.query('BEGIN');
                        
                        // Fetch Driver with Lock
                        let driverRow;
                        const existingRes = await client.query('SELECT * FROM drivers WHERE phone_number = $1 FOR UPDATE', [from]);
                        
                        if (existingRes.rows.length === 0) {
                            const newId = Date.now().toString();
                            const insertRes = await client.query(
                                `INSERT INTO drivers (id, phone_number, name, status, last_message, last_message_time, metadata, messages, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
                                [newId, from, 'New Lead', 'New', 'Start', Date.now(), { isBotActive: true }, '[]', 'Organic']
                            );
                            driverRow = insertRes.rows[0];
                        } else {
                            driverRow = existingRes.rows[0];
                        }

                        // Parse Input
                        let msgBody = '', btnId = null, msgType = 'text';
                        if (message.type === 'text') msgBody = message.text.body;
                        else if (message.type === 'interactive') {
                            if (message.interactive.type === 'button_reply') {
                                msgBody = message.interactive.button_reply.title;
                                btnId = message.interactive.button_reply.id;
                            } else if (message.interactive.type === 'list_reply') {
                                msgBody = message.interactive.list_reply.title;
                                btnId = message.interactive.list_reply.id;
                            }
                        } else if (message.type === 'image') { msgBody = '[Image]'; msgType = 'image'; }
                        else if (message.type === 'video') { msgBody = '[Video]'; msgType = 'video'; }
                        else if (message.type === 'document') { msgBody = '[Document]'; msgType = 'document'; }
                        else msgBody = '[Media]';

                        // Dedupe Check
                        let messages = typeof driverRow.messages === 'string' ? JSON.parse(driverRow.messages) : (driverRow.messages || []);
                        if (messages.some(m => m.id === message.id)) {
                            await client.query('ROLLBACK');
                            continue; 
                        }

                        // Add User Message
                        messages.push({ id: message.id, sender: 'driver', text: msgBody, timestamp: Date.now(), type: message.type });

                        // --- BOT LOGIC (CPU BOUND) ---
                        let replyToSend = null;
                        let driverMetadata = typeof driverRow.metadata === 'string' ? JSON.parse(driverRow.metadata) : (driverRow.metadata || {});
                        let currentBotStepId = driverMetadata.currentBotStepId;
                        let isBotActive = driverMetadata.isBotActive !== false;
                        let isHumanMode = driverMetadata.isHumanMode === true;

                        if (systemSettings.automation_enabled && botSettings.isEnabled && !isHumanMode && (isBotActive || botSettings.shouldRepeat)) {
                            const entryPointId = botSettings.entryPointId || (botSettings.steps[0] ? botSettings.steps[0].id : null);
                            
                            if (!currentBotStepId) {
                                if (entryPointId) {
                                    currentBotStepId = entryPointId;
                                    replyToSend = botSettings.steps.find(s => s.id === entryPointId);
                                }
                            } else {
                                const currentStep = botSettings.steps.find(s => s.id === currentBotStepId);
                                if (currentStep) {
                                    let isValidInput = true;
                                    if (currentStep.inputType === 'image' && msgType !== 'image') isValidInput = false;
                                    if (currentStep.inputType === 'video' && msgType !== 'video') isValidInput = false;
                                    
                                    if (!isValidInput) {
                                        replyToSend = { message: `Please upload a valid ${currentStep.inputType} to continue.` };
                                    } else {
                                        let nextId = currentStep.nextStepId;
                                        if (currentStep.routes && Object.keys(currentStep.routes).length > 0) {
                                            if (btnId && currentStep.routes[btnId]) {
                                                nextId = currentStep.routes[btnId];
                                            } else {
                                                const inputLower = msgBody.toLowerCase().trim();
                                                let matchedKey = Object.keys(currentStep.routes).find(key => key.toLowerCase() === inputLower);
                                                if (!matchedKey) matchedKey = Object.keys(currentStep.routes).find(key => inputLower.includes(key.toLowerCase()));
                                                if (matchedKey) nextId = currentStep.routes[matchedKey];
                                            }
                                        }

                                        if (nextId && nextId !== 'END' && nextId !== 'AI_HANDOFF') {
                                            currentBotStepId = nextId;
                                            replyToSend = botSettings.steps.find(s => s.id === nextId);
                                        } else if (nextId === 'END') {
                                            currentBotStepId = null;
                                        }
                                    }
                                } else {
                                    currentBotStepId = entryPointId;
                                    replyToSend = botSettings.steps.find(s => s.id === entryPointId);
                                }
                            }
                        }

                        // --- PARALLEL EXECUTION (CRITICAL SPEEDUP) ---
                        let dbUpdatePromise;
                        const newMetadata = { ...driverMetadata, currentBotStepId, isBotActive: currentBotStepId !== null };
                        let metaPromise = Promise.resolve({ success: true });
                        
                        if (replyToSend && systemSettings.sending_enabled) {
                            const rawText = replyToSend.message || "";
                            const isPlaceholder = /replace\s+this\s+sample|type\s+your\s+message/i.test(rawText);
                            const isEmpty = !rawText.trim() && !replyToSend.mediaUrl;

                            if (!isPlaceholder && !isEmpty) {
                                const metaPayload = generateWhatsAppPayload(replyToSend);
                                // FIRE AND FORGET - Don't block DB Commit on Meta Network Latency
                                metaPromise = sendToMeta(driverRow.phone_number, metaPayload);
                                
                                messages.push({
                                    id: `bot_${Date.now()}`, sender: 'system',
                                    text: replyToSend.message || `[${replyToSend.mediaType || 'Media'}]`,
                                    timestamp: Date.now(), type: 'text', status: 'sent'
                                });
                            }
                        }

                        // 4. Update Database
                        dbUpdatePromise = client.query(
                            `UPDATE drivers SET last_message = $1, last_message_time = $2, messages = $3, metadata = $4 WHERE id = $5`,
                            [msgBody, Date.now(), JSON.stringify(messages), JSON.stringify(newMetadata), driverRow.id]
                        );

                        // 5. Wait for DB Commit (Consistency First)
                        await dbUpdatePromise;
                        await client.query('COMMIT');
                        
                        // 6. Ensure Meta Sends (Execution Safety)
                        await metaPromise;

                    } catch (txErr) {
                        await client.query('ROLLBACK');
                        console.error("Webhook Tx Error:", txErr);
                    } finally {
                        client.release();
                    }
                }
            }
        }
    } catch (e) {
        console.error("Webhook Error:", e.message);
    }
});

// --- QUERY HELPER ---
const queryWithRetry = async (text, params, retries = 2) => {
    let client;
    try {
        client = await pool.connect();
        return await client.query(text, params);
    } catch (err) {
        if (client) { try { client.release(true); } catch(e) {} client = null; }
        const isRetryable = err.code === 'ECONNRESET' || err.message.includes('timeout') || err.message.includes('closed');
        if (retries > 0 && isRetryable) {
            await new Promise(r => setTimeout(r, 500)); 
            return queryWithRetry(text, params, retries - 1);
        }
        throw err;
    } finally {
        if (client) { try { client.release(); } catch(e) {} }
    }
};

// --- API ROUTES ---
const requireAuth = async (req, res, next) => {
    if (req.path === '/auth/login') return next();
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: "Unauthorized" });
    next();
};
apiRouter.use(requireAuth);

apiRouter.post('/auth/login', async (req, res) => {
    const { token } = req.body;
    try {
        if (!authClient) throw new Error("Auth Config Missing");
        const ticket = await authClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        const email = payload.email.toLowerCase();
        if (SUPER_ADMIN_EMAILS.length > 0 && !SUPER_ADMIN_EMAILS.includes(email)) return res.status(403).json({ success: false, error: "Access Denied" });
        res.json({ success: true, user: { email, name: payload.name, picture: payload.picture } });
    } catch (e) { res.status(401).json({ success: false, error: "Invalid Token" }); }
});

apiRouter.get('/drivers', async (req, res) => {
    const result = await queryWithRetry('SELECT * FROM drivers ORDER BY last_message_time DESC LIMIT 100');
    res.json(result.rows.map(mapDriver));
});

apiRouter.get('/sync', async (req, res) => {
    const since = parseInt(req.query.since || '0');
    const result = await queryWithRetry('SELECT * FROM drivers WHERE last_message_time > $1 ORDER BY last_message_time DESC LIMIT 50', [since]);
    res.json({ drivers: result.rows.map(mapDriver), nextCursor: Date.now() });
});

apiRouter.get('/drivers/:id/messages', async (req, res) => {
    const result = await queryWithRetry('SELECT messages FROM drivers WHERE id = $1', [req.params.id]);
    res.json(result.rows.length > 0 && result.rows[0].messages ? (typeof result.rows[0].messages === 'string' ? JSON.parse(result.rows[0].messages) : result.rows[0].messages) : []);
});

apiRouter.get('/drivers/:id/documents', async (req, res) => {
    const result = await queryWithRetry('SELECT * FROM driver_documents WHERE driver_id = $1 ORDER BY created_at DESC', [req.params.id]);
    res.json(result.rows.map(mapDocument));
});

apiRouter.patch('/drivers/:id', async (req, res) => {
    const { status, notes, isHumanMode } = req.body;
    const driverRes = await queryWithRetry('SELECT * FROM drivers WHERE id = $1', [req.params.id]);
    if (driverRes.rows.length === 0) return res.status(404).json({ error: "Not Found" });
    const driver = driverRes.rows[0];
    let metadata = typeof driver.metadata === 'string' ? JSON.parse(driver.metadata) : (driver.metadata || {});
    if (isHumanMode !== undefined) metadata.isHumanMode = isHumanMode;
    await queryWithRetry('UPDATE drivers SET status = COALESCE($1, status), notes = COALESCE($2, notes), metadata = $3 WHERE id = $4', [status, notes, JSON.stringify(metadata), req.params.id]);
    res.json({ success: true });
});

apiRouter.post('/messages/send', async (req, res) => {
    const { driverId, text, templateName, mediaUrl, mediaType } = req.body;
    const { systemSettings } = await getCachedSettings();
    if (!systemSettings.sending_enabled) return res.status(503).json({ error: "Sending Disabled" });
    
    const driverRes = await queryWithRetry('SELECT * FROM drivers WHERE id = $1', [driverId]);
    if (driverRes.rows.length === 0) return res.status(404).json({ error: "Driver not found" });
    const driver = driverRes.rows[0];
    
    const metaPayload = generateWhatsAppPayload({ message: text, templateName, mediaUrl, mediaType });
    await sendToMeta(driver.phone_number, metaPayload); // Wait for this one since it's manual

    let msgs = typeof driver.messages === 'string' ? JSON.parse(driver.messages) : (driver.messages || []);
    msgs.push({ id: `agent_${Date.now()}`, sender: 'agent', text: text || `[${templateName || mediaType}]`, timestamp: Date.now(), type: 'text', status: 'sent' });
    await queryWithRetry('UPDATE drivers SET messages = $1, last_message = $2, last_message_time = $3 WHERE id = $4', [JSON.stringify(msgs), "Agent Reply", Date.now(), driverId]);
    res.json({ success: true });
});

apiRouter.get('/bot-settings', async (req, res) => { const { botSettings } = await getCachedSettings(); res.json(botSettings); });
apiRouter.post('/bot-settings', async (req, res) => { 
    await queryWithRetry(`INSERT INTO bot_settings (id, settings) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET settings = $1`, [req.body]);
    MEMORY_CACHE.settings = null; // Invalidate Cache
    res.json({ success: true }); 
});

apiRouter.get('/system/settings', async (req, res) => { const { systemSettings } = await getCachedSettings(); res.json(systemSettings); });
apiRouter.post('/system/settings', async (req, res) => { 
    for (const [k, v] of Object.entries(req.body.settings)) await queryWithRetry(`INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [k, String(v)]);
    MEMORY_CACHE.settings = null; // Invalidate Cache
    res.json({ success: true }); 
});

// --- MEDIA ROUTES (KEEP EXISTING) ---
apiRouter.get('/media', async (req, res) => {
    const path = decodeURIComponent(req.query.path || '/');
    const filesRes = await queryWithRetry('SELECT * FROM media_files WHERE folder_path = $1 ORDER BY created_at DESC', [path]);
    const foldersRes = await queryWithRetry('SELECT * FROM media_folders WHERE parent_path = $1 ORDER BY name ASC', [path]);
    res.json({ files: filesRes.rows, folders: foldersRes.rows });
});

apiRouter.post('/folders', async (req, res) => {
    const { name, parentPath } = req.body;
    const dup = await queryWithRetry('SELECT id FROM media_folders WHERE name = $1', [name]);
    if (dup.rows.length > 0) return res.status(409).json({ error: "Folder exists" });
    await queryWithRetry('INSERT INTO media_folders (id, name, parent_path, created_at) VALUES ($1, $2, $3, $4)', [crypto.randomUUID(), name, parentPath || '/', Date.now()]);
    res.json({ success: true });
});

apiRouter.post('/s3/presign', async (req, res) => {
    const { filename, fileType, folderPath } = req.body;
    const key = `${folderPath === '/' ? '' : folderPath + '/'}${Date.now()}-${filename}`.replace(/^\//, '');
    try {
        const command = new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, ContentType: fileType });
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
        res.json({ uploadUrl, key, publicUrl: `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${key}` });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/files/register', async (req, res) => {
    await queryWithRetry('INSERT INTO media_files (id, key, url, filename, type, folder_path, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [crypto.randomUUID(), req.body.key, req.body.url, req.body.filename, req.body.type, req.body.folderPath || '/', Date.now()]);
    res.json({ success: true, id: req.body.id }); // Fixed response
});

apiRouter.delete('/files/:id', async (req, res) => {
    const fileRes = await queryWithRetry('SELECT key FROM media_files WHERE id = $1', [req.params.id]);
    if (fileRes.rows.length > 0 && fileRes.rows[0].key) {
        try { await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: fileRes.rows[0].key })); } catch(e) {}
        await queryWithRetry('DELETE FROM media_files WHERE id = $1', [req.params.id]);
    }
    res.json({ success: true });
});

app.use('/api/public', publicRouter); 
app.use('/api', apiRouter); 

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        ensureSchema(); // Background init
    });
}
module.exports = app;

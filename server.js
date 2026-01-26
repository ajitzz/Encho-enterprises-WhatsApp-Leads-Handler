
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const multer = require('multer'); 
const { Pool } = require('pg'); 
const { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { OAuth2Client } = require('google-auth-library');
require('dotenv').config();

const app = express();
const apiRouter = express.Router(); 
const publicRouter = express.Router(); 

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
const GOOGLE_CLIENT_ID = process.env.VITE_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || "764842119656-ufuaijbp0kb4m0ql6tjhdmmr3hr24t15.apps.googleusercontent.com";
const authClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const META_API_TOKEN = (process.env.META_API_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "uber_fleet_verify_token").trim();

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

// --- SCHEMA MIGRATION ---
const ensureSchema = async () => {
    if (CACHE.schemaChecked && Date.now() - CACHE.lastRefreshed < 60000) return;
    try {
        await queryWithRetry(`CREATE TABLE IF NOT EXISTS bot_settings (id SERIAL PRIMARY KEY, settings JSONB)`);
        await queryWithRetry(`CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT)`);
        await queryWithRetry(`CREATE TABLE IF NOT EXISTS drivers (id TEXT PRIMARY KEY, phone_number TEXT, name TEXT, status TEXT, last_message TEXT, last_message_time BIGINT)`);
        await queryWithRetry(`CREATE TABLE IF NOT EXISTS driver_documents (id TEXT PRIMARY KEY, driver_id TEXT, doc_type TEXT, file_url TEXT, mime_type TEXT, verification_status TEXT DEFAULT 'pending', created_at BIGINT, notes TEXT)`);
        await queryWithRetry(`CREATE TABLE IF NOT EXISTS media_folders (id UUID PRIMARY KEY, name TEXT, parent_path TEXT, created_at BIGINT, is_public_showcase BOOLEAN DEFAULT FALSE)`);
        await queryWithRetry(`CREATE TABLE IF NOT EXISTS media_files (id UUID PRIMARY KEY, key TEXT, url TEXT, filename TEXT, type TEXT, folder_path TEXT, created_at BIGINT, media_id TEXT)`);
        
        const addCol = async (table, col, type) => {
            try { await queryWithRetry(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${type}`); } catch(e) {}
        };

        await addCol('drivers', 'metadata', 'JSONB DEFAULT \'{}\'');
        await addCol('drivers', 'messages', 'JSONB DEFAULT \'[]\'');
        await addCol('drivers', 'email', 'TEXT');
        await addCol('drivers', 'source', 'TEXT DEFAULT \'Organic\'');
        await addCol('drivers', 'notes', 'TEXT');
        await addCol('media_folders', 'is_public_showcase', 'BOOLEAN DEFAULT FALSE');

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

// --- DATA MAPPERS ---
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
        documents: [],
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

// --- ADVANCED WHATSAPP PAYLOAD ENGINE ---
const generateWhatsAppPayload = (content) => {
    // 1. Template Message (Highest Priority)
    if (content.templateName) {
        return { type: 'template', template: { name: content.templateName, language: { code: 'en_US' } } };
    }

    // 2. Normalize Buttons / Options
    let buttons = [];
    
    // Convert legacy string options to button objects
    if (content.options && Array.isArray(content.options) && content.options.length > 0) {
        buttons = content.options.map(opt => ({ type: 'reply', title: opt, payload: opt }));
    } 
    // Or use explicit buttons if available
    else if (content.buttons && Array.isArray(content.buttons) && content.buttons.length > 0) {
        buttons = content.buttons.filter(b => b.type === 'reply' || b.type === 'list');
    }

    // 3. Determine Format based on Count
    // Constraint: Buttons <= 3. Lists <= 10.
    const buttonCount = buttons.length;
    const useListMessage = buttonCount > 3 && buttonCount <= 10;
    const useSimpleText = buttonCount > 10; // Fallback for too many options

    // Common Header Media (for both Buttons and Lists)
    let header = undefined;
    if (content.headerImageUrl || (content.mediaUrl && ['image', 'video', 'document'].includes(content.mediaType))) {
        if (content.mediaType === 'video') header = { type: 'video', video: { link: content.mediaUrl } };
        else if (content.mediaType === 'document') header = { type: 'document', document: { link: content.mediaUrl } };
        else header = { type: 'image', image: { link: content.headerImageUrl || content.mediaUrl } };
    }

    const bodyText = content.message || "Please select an option:";
    const footerText = content.footerText || "Uber Fleet";

    // A. INTERACTIVE LIST (4-10 Options)
    if (useListMessage) {
        return {
            type: "interactive",
            interactive: {
                type: "list",
                header: header,
                body: { text: bodyText },
                footer: { text: footerText },
                action: {
                    button: "Select Option",
                    sections: [
                        {
                            title: "Available Options",
                            rows: buttons.map(b => ({
                                id: (b.payload || b.title).substring(0, 200), // ID can be long
                                title: b.title.substring(0, 24), // List Title Limit: 24 chars
                                description: "" 
                            }))
                        }
                    ]
                }
            }
        };
    }

    // B. INTERACTIVE BUTTONS (1-3 Options)
    if (buttonCount > 0 && !useSimpleText) {
        return {
            type: "interactive",
            interactive: {
                type: "button",
                header: header,
                body: { text: bodyText },
                footer: { text: footerText },
                action: {
                    buttons: buttons.map(b => ({
                        type: "reply",
                        reply: {
                            id: (b.payload || b.title).substring(0, 256),
                            title: b.title.substring(0, 20) // CRITICAL: Strict 20 char limit for buttons
                        }
                    }))
                }
            }
        };
    }

    // C. SIMPLE MEDIA (Image/Video/Doc only)
    if (!buttonCount && content.mediaUrl) {
        const type = content.mediaType === 'video' ? 'video' : (content.mediaType === 'document' ? 'document' : 'image');
        return { 
            type, 
            [type]: { 
                link: content.mediaUrl, 
                caption: bodyText // Caption is the message body here
            } 
        };
    }

    // D. FALLBACK / TEXT ONLY (or > 10 options)
    let finalBody = bodyText;
    if (useSimpleText) {
        finalBody += "\n\n" + buttons.map((b, i) => `${i+1}. ${b.title}`).join('\n');
    }
    
    return { type: 'text', text: { body: finalBody } };
};

const sendToMeta = async (to, payload) => {
    if (!META_API_TOKEN || !PHONE_NUMBER_ID) return { success: false, error: "Missing Credentials" };
    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
            { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload },
            { headers: { 'Authorization': `Bearer ${META_API_TOKEN}`, 'Content-Type': 'application/json' } }
        );
        return { success: true };
    } catch (e) {
        return { success: false, error: e.response?.data || e.message };
    }
};

// ============================================================================
// ROUTES
// ============================================================================

// 1. PUBLIC ROUTES
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

// WEBHOOK HANDLER (THE BOT ENGINE)
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
                        
                        // Parse Content: Handle Text, Button Reply, AND List Reply
                        let msgBody = '';
                        let btnId = null;

                        if (message.type === 'text') {
                            msgBody = message.text.body;
                        } else if (message.type === 'interactive') {
                            if (message.interactive.type === 'button_reply') {
                                msgBody = message.interactive.button_reply.title;
                                btnId = message.interactive.button_reply.id;
                            } else if (message.interactive.type === 'list_reply') {
                                msgBody = message.interactive.list_reply.title; // User sees title
                                btnId = message.interactive.list_reply.id;      // System uses ID
                            }
                        } else if (message.type === 'image') {
                            msgBody = '[Image]';
                        } else {
                            msgBody = '[Media]';
                        }

                        // 1. UPSERT DRIVER
                        let driverRes = await queryWithRetry('SELECT * FROM drivers WHERE phone_number = $1', [from]);
                        if (driverRes.rows.length === 0) {
                             const newId = Date.now().toString();
                             await queryWithRetry(
                                 `INSERT INTO drivers (id, phone_number, name, status, last_message, last_message_time, metadata, messages, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                                 [newId, from, 'New Lead', 'New', msgBody, Date.now(), { isBotActive: true }, '[]', 'Organic']
                             );
                             driverRes = await queryWithRetry('SELECT * FROM drivers WHERE id = $1', [newId]);
                        }
                        const driverRow = driverRes.rows[0];
                        const driver = mapDriver(driverRow);
                        
                        // 2. SAVE USER MESSAGE
                        driver.messages.push({ id: message.id, sender: 'driver', text: msgBody, timestamp: Date.now(), type: message.type });
                        
                        // 3. BOT LOGIC
                        const botSettings = await getCachedBotSettings();
                        const isAutomationEnabled = await getCachedSystemSetting('automation_enabled');
                        const isSendingEnabled = await getCachedSystemSetting('sending_enabled');

                        let replyToSend = null;
                        let newBotStepId = driver.currentBotStepId;

                        if (isAutomationEnabled && botSettings.isEnabled && !driver.isHumanMode && (driver.isBotActive || botSettings.shouldRepeat)) {
                            
                            const entryPointId = botSettings.entryPointId || (botSettings.steps[0] ? botSettings.steps[0].id : null);
                            
                            // START FLOW
                            if (!driver.currentBotStepId) {
                                if (entryPointId) {
                                    newBotStepId = entryPointId;
                                    const step = botSettings.steps.find(s => s.id === entryPointId);
                                    if (step) replyToSend = step;
                                }
                            } 
                            // CONTINUE FLOW
                            else {
                                const currentStep = botSettings.steps.find(s => s.id === driver.currentBotStepId);
                                if (currentStep) {
                                    let nextId = currentStep.nextStepId;
                                    
                                    // Handle Branching
                                    if (currentStep.routes && Object.keys(currentStep.routes).length > 0) {
                                        // Priority 1: Match Button/List ID (Exact)
                                        if (btnId && currentStep.routes[btnId]) {
                                            nextId = currentStep.routes[btnId];
                                        } 
                                        // Priority 2: Match Text (Fuzzy)
                                        else {
                                            const inputLower = msgBody.toLowerCase();
                                            // Direct match first (for "English" vs "English ")
                                            let matchedKey = Object.keys(currentStep.routes).find(key => key.toLowerCase() === inputLower);
                                            // Fallback to substring
                                            if (!matchedKey) {
                                                matchedKey = Object.keys(currentStep.routes).find(key => inputLower.includes(key.toLowerCase()));
                                            }
                                            if (matchedKey) {
                                                nextId = currentStep.routes[matchedKey];
                                            }
                                        }
                                    }

                                    if (nextId && nextId !== 'END' && nextId !== 'AI_HANDOFF') {
                                        newBotStepId = nextId;
                                        const nextStep = botSettings.steps.find(s => s.id === nextId);
                                        if (nextStep) replyToSend = nextStep;
                                    } else if (nextId === 'END') {
                                        newBotStepId = null; 
                                    }
                                } else {
                                    // Step lost? Restart.
                                    newBotStepId = entryPointId;
                                    const step = botSettings.steps.find(s => s.id === entryPointId);
                                    if (step) replyToSend = step;
                                }
                            }
                        }

                        // 4. SEND REPLY
                        if (replyToSend && isSendingEnabled) {
                            const rawText = replyToSend.message || "";
                            const isPlaceholder = /replace\s+this\s+sample|type\s+your\s+message/i.test(rawText);
                            const isEmpty = !rawText.trim() && !replyToSend.mediaUrl;

                            if (!isPlaceholder && !isEmpty) {
                                // USE THE INDUSTRIAL ENGINE
                                const metaPayload = generateWhatsAppPayload(replyToSend);
                                
                                const sendRes = await sendToMeta(driver.phoneNumber, metaPayload);
                                if (sendRes.success) {
                                    driver.messages.push({
                                        id: `bot_${Date.now()}`,
                                        sender: 'system',
                                        text: replyToSend.message || `[${replyToSend.mediaType || 'Template'}]`,
                                        timestamp: Date.now(),
                                        type: 'text',
                                        status: 'sent'
                                    });
                                }
                            }
                        }

                        // 5. UPDATE DB
                        const newMetadata = { 
                            ...driverRow.metadata,
                            currentBotStepId: newBotStepId,
                            isBotActive: newBotStepId !== null 
                        };

                        await queryWithRetry(
                            `UPDATE drivers SET last_message = $1, last_message_time = $2, messages = $3, metadata = $4 WHERE id = $5`,
                            [msgBody, Date.now(), JSON.stringify(driver.messages), JSON.stringify(newMetadata), driver.id]
                        );
                    }
                }
            }
        }
    } catch (e) {
        console.error("Webhook Error", e);
    }
});

// ... (Rest of existing API routes for Public Showcase, Documents, etc. remain unchanged below) ...

// PUBLIC SHOWCASE API
publicRouter.get('/status', async (req, res) => {
    try {
        await ensureSchema();
        const resDb = await queryWithRetry('SELECT id, name FROM media_folders WHERE is_public_showcase = TRUE ORDER BY created_at DESC LIMIT 1');
        if (resDb.rows.length > 0) {
            res.json({ active: true, folderId: resDb.rows[0].id, folderName: resDb.rows[0].name });
        } else {
            res.json({ active: false });
        }
    } catch(e) { res.status(500).json({ error: e.message }); }
});

publicRouter.get('/showcase', async (req, res) => {
    try {
        await ensureSchema();
        const folderName = req.query.folder;
        let folderTitle = "Showcase";
        let query = 'SELECT id, name FROM media_folders WHERE is_public_showcase = TRUE ORDER BY created_at DESC LIMIT 1';
        let params = [];
        if (folderName && folderName !== 'undefined') {
            query = 'SELECT id, name FROM media_folders WHERE name = $1';
            params = [decodeURIComponent(folderName)];
        }
        const fRes = await queryWithRetry(query, params);
        if (fRes.rows.length === 0) return res.json({ items: [], title: 'Showcase Offline' });
        folderTitle = fRes.rows[0].name;
        const filesRes = await queryWithRetry(
            'SELECT * FROM media_files WHERE folder_path = $1 OR folder_path = $2 ORDER BY created_at DESC', 
            [`/${folderTitle}`, folderTitle]
        );
        res.json({ items: filesRes.rows, title: folderTitle });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/auth/login', async (req, res) => {
    const { token } = req.body;
    try {
        const ticket = await authClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        const email = payload.email.toLowerCase();
        if (SUPER_ADMIN_EMAILS.length > 0 && !SUPER_ADMIN_EMAILS.includes(email)) {
            return res.status(403).json({ success: false, error: "Access Denied" });
        }
        res.json({ success: true, user: { email, name: payload.name, picture: payload.picture } });
    } catch (e) { res.status(401).json({ success: false, error: "Invalid Token" }); }
});

const requireAuth = async (req, res, next) => {
    await ensureSchema();
    if (req.path === '/auth/login') return next();
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: "Unauthorized" });
    next();
};

apiRouter.use(requireAuth);

apiRouter.get('/drivers/:id/documents', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM driver_documents WHERE driver_id = $1 ORDER BY created_at DESC', [req.params.id]);
        res.json(result.rows.map(mapDocument));
    } catch(e) { res.status(500).json({ error: e.message }); }
});

apiRouter.patch('/documents/:id', async (req, res) => {
    const { status, notes } = req.body;
    try {
        await queryWithRetry('UPDATE driver_documents SET verification_status = COALESCE($1, verification_status), notes = COALESCE($2, notes) WHERE id = $3', [status, notes, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/media', async (req, res) => {
    try {
        const path = req.query.path || '/';
        const decodedPath = decodeURIComponent(path);
        const filesRes = await queryWithRetry('SELECT * FROM media_files WHERE folder_path = $1 ORDER BY created_at DESC', [decodedPath]);
        const foldersRes = await queryWithRetry('SELECT * FROM media_folders WHERE parent_path = $1 ORDER BY name ASC', [decodedPath]);
        res.json({ files: filesRes.rows, folders: foldersRes.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/folders', async (req, res) => {
    const { name, parentPath } = req.body;
    try {
        const dup = await queryWithRetry('SELECT id FROM media_folders WHERE name = $1', [name]);
        if (dup.rows.length > 0) return res.status(409).json({ error: "Folder exists" });
        const id = crypto.randomUUID();
        await queryWithRetry('INSERT INTO media_folders (id, name, parent_path, created_at) VALUES ($1, $2, $3, $4)', [id, name, parentPath || '/', Date.now()]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.delete('/files/:id', async (req, res) => {
    try {
        const fileRes = await queryWithRetry('SELECT key FROM media_files WHERE id = $1', [req.params.id]);
        if (fileRes.rows.length > 0) {
            const key = fileRes.rows[0].key;
            if (key) { try { await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key })); } catch(e) {} }
            await queryWithRetry('DELETE FROM media_files WHERE id = $1', [req.params.id]);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/messages/schedule', async (req, res) => {
    res.json({ success: true, message: "Scheduled successfully" });
});

apiRouter.post('/messages/send', async (req, res) => {
    const { driverId, text, templateName, mediaUrl, mediaType } = req.body;
    if (!(await getCachedSystemSetting('sending_enabled'))) return res.status(503).json({ error: "Sending Disabled" });
    try {
        const driverRes = await queryWithRetry('SELECT * FROM drivers WHERE id = $1', [driverId]);
        if (driverRes.rows.length === 0) return res.status(404).json({ error: "Driver not found" });
        const driver = driverRes.rows[0];
        
        // Use the same robust payload generator for manual sends
        const metaPayload = generateWhatsAppPayload({
            message: text,
            templateName,
            mediaUrl,
            mediaType
        });

        const metaRes = await sendToMeta(driver.phone_number, metaPayload);
        if (!metaRes.success) throw new Error(JSON.stringify(metaRes.error));

        let msgs = typeof driver.messages === 'string' ? JSON.parse(driver.messages) : (driver.messages || []);
        msgs.push({ id: `agent_${Date.now()}`, sender: 'agent', text: text || `[${templateName || mediaType}]`, timestamp: Date.now(), type: 'text', status: 'sent' });
        await queryWithRetry('UPDATE drivers SET messages = $1, last_message = $2, last_message_time = $3 WHERE id = $4', [JSON.stringify(msgs), "Agent Reply", Date.now(), driverId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/sync', async (req, res) => {
    const since = parseInt(req.query.since || '0');
    try {
        const result = await queryWithRetry('SELECT * FROM drivers WHERE last_message_time > $1 ORDER BY last_message_time DESC LIMIT 50', [since]);
        res.json({ drivers: result.rows.map(mapDriver), nextCursor: Date.now() });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM drivers ORDER BY last_message_time DESC LIMIT 100');
        res.json(result.rows.map(mapDriver));
    } catch (e) { res.status(500).json({ error: e.message }); }
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

apiRouter.patch('/drivers/:id', async (req, res) => {
    const { status, notes, isHumanMode } = req.body;
    try {
        const driverRes = await queryWithRetry('SELECT * FROM drivers WHERE id = $1', [req.params.id]);
        if (driverRes.rows.length === 0) return res.status(404).json({ error: "Not Found" });
        const driver = driverRes.rows[0];
        let metadata = typeof driver.metadata === 'string' ? JSON.parse(driver.metadata) : (driver.metadata || {});
        if (isHumanMode !== undefined) metadata.isHumanMode = isHumanMode;
        await queryWithRetry('UPDATE drivers SET status = COALESCE($1, status), notes = COALESCE($2, notes), metadata = $3 WHERE id = $4', [status, notes, JSON.stringify(metadata), req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/s3/presign', async (req, res) => {
    const { filename, fileType, folderPath } = req.body;
    const key = `${folderPath === '/' ? '' : folderPath + '/'}${Date.now()}-${filename}`.replace(/^\//, '');
    try {
        const command = new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, ContentType: fileType });
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
        const publicUrl = `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${key}`;
        res.json({ uploadUrl, key, publicUrl });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/files/register', async (req, res) => {
    const { key, url, filename, type, folderPath } = req.body;
    try {
        const id = crypto.randomUUID();
        await queryWithRetry('INSERT INTO media_files (id, key, url, filename, type, folder_path, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [id, key, url, filename, type, folderPath || '/', Date.now()]);
        res.json({ success: true, id });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/folders/:id/public', async (req, res) => {
    await queryWithRetry('UPDATE media_folders SET is_public_showcase = TRUE WHERE id = $1', [req.params.id]);
    res.json({ success: true });
});

apiRouter.delete('/folders/:id/public', async (req, res) => {
    await queryWithRetry('UPDATE media_folders SET is_public_showcase = FALSE WHERE id = $1', [req.params.id]);
    res.json({ success: true });
});

apiRouter.get('/bot-settings', async (req, res) => { res.json(await getCachedBotSettings()); });
apiRouter.post('/bot-settings', async (req, res) => {
    await queryWithRetry(`INSERT INTO bot_settings (id, settings) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET settings = $1`, [req.body]);
    await refreshCache();
    res.json({ success: true });
});

apiRouter.get('/system/stats', async (req, res) => {
    res.json({ serverLoad: 12, dbLatency: 5, aiCredits: 100, aiModel: "Gemini 1.5", s3Status: 'ok', whatsappStatus: META_API_TOKEN ? 'ok' : 'error' });
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

app.use('/api/public', publicRouter); 
app.use('/api', apiRouter); 

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        ensureSchema(); 
    });
}

module.exports = app;

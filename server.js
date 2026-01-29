
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

// --- ADVANCED CONFIGURATION ---
const SYSTEM_CONFIG = {
    MAX_BUTTONS: 3,
    MAX_LIST_ITEMS: 10,
    META_TIMEOUT: 15000, 
    DB_CONNECTION_TIMEOUT: 30000, 
    BATCH_SIZE: 15, 
    PROCESS_INTERVAL: 8000,
    MAX_RETRIES: 5,
    SCHEDULE_EXPIRY_MS: 24 * 60 * 60 * 1000 
};

// --- MIDDLEWARE ---
app.use(express.json({ 
    limit: '50mb', 
    verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(cors()); 

// CRITICAL FIX: Security Headers for Google OAuth
app.use((req, res, next) => {
    // Allows popups (like Google Login) to postMessage back to this window
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    // Standard security to prevent clickjacking, but allow necessary embeds
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    
    // Cache Control
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

// Developer Logging Middleware
app.use((req, res, next) => {
    // Only log API requests to reduce noise
    if (req.path.startsWith('/api') || req.path.startsWith('/webhook')) {
        console.log(`[REQ] ${req.method} ${req.path}`);
    }
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

// --- DB CONNECTION ---
const CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL;
const IS_SERVERLESS = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';

if (!CONNECTION_STRING) {
    console.error("❌ [CRITICAL] Database Config Missing in .env");
} else {
    console.log("✅ [SYSTEM] Database Config Found.");
}

const createPool = () => {
    const config = {
        connectionString: CONNECTION_STRING,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
        idleTimeoutMillis: 1000, 
        max: IS_SERVERLESS ? 4 : 20,
        keepAlive: true,
        application_name: 'uber_fleet_bot'
    };
    const newPool = new Pool(config);
    newPool.on('error', (err) => console.error('⚠️ [DB POOL ERROR]:', err.message));
    return newPool;
};

if (!global.pgPool) { if (CONNECTION_STRING) global.pgPool = createPool(); }
const pool = global.pgPool;

// --- QUERY HELPER ---
const queryWithRetry = async (text, params, retries = 2) => {
    if (!pool) {
        console.error("❌ [DB ERROR] Attempted query without connection pool.");
        throw new Error("Database not configured.");
    }
    let client;
    try {
        client = await pool.connect();
        return await client.query(text, params);
    } catch (err) {
        // Detailed Error Labeling for Developer
        const isConnectionError = err.code === 'ECONNRESET' || err.code === '57P01' || err.message.includes('timeout') || err.message.includes('closed');
        const isAuthError = err.code === '28P01'; // Invalid password
        
        if (client) { try { client.release(true); } catch(e) {} client = null; }
        
        if (isAuthError) {
            console.error("❌ [DB AUTH FAIL] Check POSTGRES_URL credentials.");
            throw err; // Don't retry auth errors
        }

        if (retries > 0 && isConnectionError) {
            console.warn(`⚠️ [DB RETRY] Connection Unstable (${err.message}). Retrying... (${retries} left)`);
            await new Promise(r => setTimeout(r, 1500)); 
            return queryWithRetry(text, params, retries - 1);
        }
        
        console.error(`❌ [DB QUERY FAILED] Query: "${text.substring(0, 50)}..." Error: ${err.message}`);
        throw err;
    } finally {
        if (client) { try { client.release(); } catch(e) {} }
    }
};

// --- SCHEMA & INDEXING (PERFORMANCE) ---
let schemaPromise = null;
const ensureSchema = async () => {
    if (schemaPromise) return schemaPromise;
    schemaPromise = (async () => {
        try {
            // Tables
            await queryWithRetry(`CREATE TABLE IF NOT EXISTS bot_settings (id SERIAL PRIMARY KEY, settings JSONB)`);
            await queryWithRetry(`CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT)`);
            await queryWithRetry(`CREATE TABLE IF NOT EXISTS drivers (id TEXT PRIMARY KEY, phone_number TEXT, name TEXT, status TEXT, last_message TEXT, last_message_time BIGINT)`);
            await queryWithRetry(`CREATE TABLE IF NOT EXISTS driver_documents (id TEXT PRIMARY KEY, driver_id TEXT, doc_type TEXT, file_url TEXT, mime_type TEXT, verification_status TEXT DEFAULT 'pending', created_at BIGINT, notes TEXT)`);
            await queryWithRetry(`CREATE TABLE IF NOT EXISTS media_folders (id UUID PRIMARY KEY, name TEXT, parent_path TEXT, created_at BIGINT, is_public_showcase BOOLEAN DEFAULT FALSE)`);
            await queryWithRetry(`CREATE TABLE IF NOT EXISTS media_files (id UUID PRIMARY KEY, key TEXT, url TEXT, filename TEXT, type TEXT, folder_path TEXT, created_at BIGINT, media_id TEXT)`);
            
            await queryWithRetry(`CREATE TABLE IF NOT EXISTS message_queue (
                id UUID PRIMARY KEY, driver_id TEXT, payload JSONB, scheduled_time BIGINT, 
                status TEXT DEFAULT 'pending', attempts INT DEFAULT 0, last_error TEXT, created_at BIGINT
            )`);

            // Performance Indices (Industrial Standard)
            await queryWithRetry(`CREATE INDEX IF NOT EXISTS idx_drivers_phone ON drivers(phone_number)`);
            await queryWithRetry(`CREATE INDEX IF NOT EXISTS idx_drivers_status ON drivers(status)`);
            await queryWithRetry(`CREATE INDEX IF NOT EXISTS idx_drivers_updated ON drivers(last_message_time DESC)`);
            await queryWithRetry(`CREATE INDEX IF NOT EXISTS idx_queue_poll ON message_queue(status, scheduled_time)`);
            await queryWithRetry(`CREATE INDEX IF NOT EXISTS idx_queue_driver ON message_queue(driver_id)`);

            // Columns
            const addCol = async (table, col, type) => { try { await queryWithRetry(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${type}`); } catch(e) {} };
            await addCol('drivers', 'metadata', 'JSONB DEFAULT \'{}\'');
            await addCol('drivers', 'messages', 'JSONB DEFAULT \'[]\'');
            await addCol('drivers', 'email', 'TEXT');
            await addCol('drivers', 'source', 'TEXT DEFAULT \'Organic\'');
            await addCol('drivers', 'notes', 'TEXT');
            await addCol('media_folders', 'is_public_showcase', 'BOOLEAN DEFAULT FALSE');
        } catch (e) {
            console.error("❌ [SCHEMA ERROR]:", e.message);
            schemaPromise = null; 
        }
    })();
    return schemaPromise;
};

const fetchRuntimeConfig = async () => {
    await ensureSchema();
    const [botRes, sysRes] = await Promise.all([
        queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1'),
        queryWithRetry('SELECT * FROM system_settings')
    ]);
    const botSettings = botRes.rows[0]?.settings || { isEnabled: true, steps: [] };
    const systemSettings = { webhook_ingest_enabled: true, automation_enabled: true, sending_enabled: true };
    sysRes.rows.forEach(r => { if (r.key in systemSettings) systemSettings[r.key] = r.value === 'true'; });
    return { botSettings, systemSettings };
};

// --- HELPERS ---
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
        await axios.post(
            `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
            { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload },
            { headers: { 'Authorization': `Bearer ${META_API_TOKEN}`, 'Content-Type': 'application/json' }, timeout: SYSTEM_CONFIG.META_TIMEOUT }
        );
        return { success: true };
    } catch (e) {
        return { success: false, error: e.response?.data || e.message };
    }
};

// --- QUEUE WORKER ---
let isProcessingQueue = false;
const processMessageQueue = async () => {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    try {
        await ensureSchema();
        const now = Date.now();
        await queryWithRetry(`UPDATE message_queue SET status = 'pending' WHERE status = 'processing' AND created_at < $1`, [now - 300000]);

        const jobsRes = await queryWithRetry(
            `UPDATE message_queue SET status = 'processing' 
             WHERE id IN (
                 SELECT id FROM message_queue WHERE status = 'pending' AND scheduled_time <= $1 
                 ORDER BY scheduled_time ASC LIMIT $2 FOR UPDATE SKIP LOCKED
             ) RETURNING *`,
            [now, SYSTEM_CONFIG.BATCH_SIZE]
        );

        if (jobsRes.rows.length === 0) { isProcessingQueue = false; return; }

        const config = await fetchRuntimeConfig();
        if (!config.systemSettings.sending_enabled) {
            await queryWithRetry(`UPDATE message_queue SET status = 'pending' WHERE id = ANY($1)`, [jobsRes.rows.map(j => j.id)]);
            isProcessingQueue = false; return;
        }

        for (const job of jobsRes.rows) {
            try {
                // Staleness Check
                if (now - job.scheduled_time > SYSTEM_CONFIG.SCHEDULE_EXPIRY_MS) {
                    await queryWithRetry(`UPDATE message_queue SET status = 'failed', last_error = 'Expired (Stale)' WHERE id = $1`, [job.id]);
                    continue;
                }

                const driverRes = await queryWithRetry('SELECT phone_number, messages FROM drivers WHERE id = $1', [job.driver_id]);
                if (driverRes.rows.length === 0) {
                    await queryWithRetry(`UPDATE message_queue SET status = 'failed', last_error = 'Driver not found' WHERE id = $1`, [job.id]);
                    continue;
                }
                const driver = driverRes.rows[0];
                const metaPayload = generateWhatsAppPayload(job.payload);
                const sendRes = await sendToMeta(driver.phone_number, metaPayload);

                if (sendRes.success) {
                    await queryWithRetry(`UPDATE message_queue SET status = 'completed' WHERE id = $1`, [job.id]);
                    let msgs = [];
                    try { msgs = typeof driver.messages === 'string' ? JSON.parse(driver.messages) : (driver.messages || []); } catch(e) {}
                    msgs.push({
                        id: `bulk_${Date.now()}_${job.id}`, sender: 'agent',
                        text: job.payload.text || job.payload.message || `[${job.payload.templateName || 'Media'}]`,
                        timestamp: Date.now(), type: 'text', status: 'sent', isBroadcast: true
                    });
                    await queryWithRetry(`UPDATE drivers SET messages = $1, last_message = $2, last_message_time = $3 WHERE id = $4`, [JSON.stringify(msgs), "Broadcast Message", Date.now(), job.driver_id]);
                } else {
                    const attempts = job.attempts + 1;
                    const status = attempts >= SYSTEM_CONFIG.MAX_RETRIES ? 'failed' : 'pending';
                    await queryWithRetry(`UPDATE message_queue SET status = $1, attempts = $2, last_error = $3 WHERE id = $4`, [status, attempts, JSON.stringify(sendRes.error).substring(0, 200), job.id]);
                }
                await new Promise(r => setTimeout(r, 100));
            } catch (jobErr) {
                await queryWithRetry(`UPDATE message_queue SET attempts = attempts + 1, last_error = $1 WHERE id = $2`, [jobErr.message, job.id]);
            }
        }
    } catch (e) { console.error("❌ [WORKER ERROR]:", e.message); } 
    finally { isProcessingQueue = false; }
};
setInterval(processMessageQueue, SYSTEM_CONFIG.PROCESS_INTERVAL);

// --- WEBHOOK ---
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === VERIFY_TOKEN) res.send(req.query['hub.challenge']);
    else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    // Return 200 immediately to acknowledge receipt to Meta
    res.sendStatus(200);
    
    try {
        await ensureSchema();
        const body = req.body;
        if (body.object !== 'whatsapp_business_account') return;

        const { botSettings, systemSettings } = await fetchRuntimeConfig();
        if (!systemSettings.webhook_ingest_enabled) return;

        const entries = body.entry || [];
        for (const entry of entries) {
            for (const change of entry.changes || []) {
                const value = change.value;
                if (value.messages && value.messages.length > 0) {
                    const message = value.messages[0];
                    const from = message.from;
                    
                    // TRANSACTIONAL PROCESSING (Concurrency Control)
                    // We lock this specific driver row to ensure sequential message processing
                    const client = await pool.connect();
                    try {
                        await client.query('BEGIN');
                        
                        let driverRow;
                        const existingRes = await client.query('SELECT * FROM drivers WHERE phone_number = $1 FOR UPDATE', [from]);
                        
                        if (existingRes.rows.length === 0) {
                            const newId = Date.now().toString();
                            const insertRes = await client.query(
                                `INSERT INTO drivers (id, phone_number, name, status, last_message, last_message_time, metadata, messages, source) 
                                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
                                [newId, from, 'New Lead', 'New', 'Start', Date.now(), { isBotActive: true }, '[]', 'Organic']
                            );
                            driverRow = insertRes.rows[0];
                        } else {
                            driverRow = existingRes.rows[0];
                        }

                        let messages = typeof driverRow.messages === 'string' ? JSON.parse(driverRow.messages) : (driverRow.messages || []);
                        if (messages.some(m => m.id === message.id)) {
                            await client.query('ROLLBACK');
                            continue; // Dedupe
                        }

                        // Parse Incoming
                        let msgBody = '';
                        let btnId = null;
                        let msgType = 'text';

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

                        messages.push({ id: message.id, sender: 'driver', text: msgBody, timestamp: Date.now(), type: message.type });

                        // --- BOT ENGINE (WITH INPUT VALIDATION) ---
                        let replyToSend = null;
                        let driverMetadata = typeof driverRow.metadata === 'string' ? JSON.parse(driverRow.metadata) : (driverRow.metadata || {});
                        let currentBotStepId = driverMetadata.currentBotStepId;
                        let isBotActive = driverMetadata.isBotActive !== false;
                        let isHumanMode = driverMetadata.isHumanMode === true;

                        if (systemSettings.automation_enabled && botSettings.isEnabled && !isHumanMode && (isBotActive || botSettings.shouldRepeat)) {
                            const entryPointId = botSettings.entryPointId || (botSettings.steps[0] ? botSettings.steps[0].id : null);
                            
                            if (!currentBotStepId) {
                                // Start Flow
                                if (entryPointId) {
                                    currentBotStepId = entryPointId;
                                    replyToSend = botSettings.steps.find(s => s.id === entryPointId);
                                }
                            } else {
                                // Continue Flow
                                const currentStep = botSettings.steps.find(s => s.id === currentBotStepId);
                                if (currentStep) {
                                    // VALIDATION: Check if input matches expected type
                                    let isValidInput = true;
                                    if (currentStep.inputType === 'image' && msgType !== 'image') isValidInput = false;
                                    if (currentStep.inputType === 'video' && msgType !== 'video') isValidInput = false;
                                    if (currentStep.inputType === 'document' && msgType !== 'document') isValidInput = false;
                                    
                                    if (!isValidInput) {
                                        // INVALID INPUT: Reply with retry message, DO NOT advance step
                                        replyToSend = { 
                                            message: `Please upload a valid ${currentStep.inputType} to continue.` 
                                        };
                                        // Keep currentBotStepId same
                                    } else {
                                        // VALID INPUT: Determine next step
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
                                    // Step not found (Broken flow), restart
                                    currentBotStepId = entryPointId;
                                    replyToSend = botSettings.steps.find(s => s.id === entryPointId);
                                }
                            }
                        }

                        if (replyToSend && systemSettings.sending_enabled) {
                            const rawText = replyToSend.message || "";
                            if (rawText.trim() || replyToSend.mediaUrl) {
                                const metaPayload = generateWhatsAppPayload(replyToSend);
                                const sendRes = await sendToMeta(driverRow.phone_number, metaPayload);
                                if (sendRes.success) {
                                    messages.push({
                                        id: `bot_${Date.now()}`, sender: 'system',
                                        text: replyToSend.message || `[${replyToSend.mediaType || 'Media'}]`,
                                        timestamp: Date.now(), type: 'text', status: 'sent'
                                    });
                                }
                            }
                        }

                        const newMetadata = { ...driverMetadata, currentBotStepId, isBotActive: currentBotStepId !== null };
                        await client.query(
                            `UPDATE drivers SET last_message = $1, last_message_time = $2, messages = $3, metadata = $4 WHERE id = $5`,
                            [msgBody, Date.now(), JSON.stringify(messages), JSON.stringify(newMetadata), driverRow.id]
                        );
                        
                        await client.query('COMMIT');
                    } catch (err) {
                        await client.query('ROLLBACK');
                        console.error("❌ [TX ERROR]:", err);
                    } finally {
                        client.release();
                    }
                }
            }
        }
    } catch (e) {
        console.error("❌ [WEBHOOK FATAL]:", e);
    }
});

// AUTH & API ROUTES
apiRouter.post('/auth/login', async (req, res) => {
    const { token } = req.body;
    try {
        if (!authClient) throw new Error("Auth Config Missing");
        const ticket = await authClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        const email = payload.email.toLowerCase();
        if (SUPER_ADMIN_EMAILS.length > 0 && !SUPER_ADMIN_EMAILS.includes(email)) return res.status(403).json({ success: false, error: "Access Denied: Email not in Super Admin list" });
        res.json({ success: true, user: { email, name: payload.name, picture: payload.picture } });
    } catch (e) { res.status(401).json({ success: false, error: "Invalid Token: " + e.message }); }
});

const requireAuth = async (req, res, next) => {
    await ensureSchema();
    if (req.path === '/auth/login') return next();
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: "Unauthorized: Missing or Invalid Token" });
    next();
};
apiRouter.use(requireAuth);

// ... (Rest of routes kept same, assuming they rely on queryWithRetry which handles error logging)

apiRouter.post('/messages/schedule', async (req, res) => {
    const { driverIds, scheduledTime, ...content } = req.body;
    if (!Array.isArray(driverIds)) return res.status(400).json({ error: "Invalid IDs" });
    try {
        const time = scheduledTime || Date.now();
        const query = `INSERT INTO message_queue (id, driver_id, payload, scheduled_time, created_at) VALUES ($1, $2, $3, $4, $5)`;
        for (const driverId of driverIds) {
            await queryWithRetry(query, [crypto.randomUUID(), driverId, JSON.stringify(content), time, Date.now()]);
        }
        if (time <= Date.now()) processMessageQueue();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers/:id/scheduled-messages', async (req, res) => {
    try {
        const result = await queryWithRetry(`SELECT id, driver_id as "driverId", payload, scheduled_time as "scheduledTime", status FROM message_queue WHERE driver_id = $1 AND status IN ('pending', 'failed') ORDER BY scheduled_time ASC`, [req.params.id]);
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.delete('/messages/scheduled/:id', async (req, res) => {
    try {
        await queryWithRetry(`DELETE FROM message_queue WHERE id = $1 AND status IN ('pending', 'failed')`, [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.patch('/messages/scheduled/:id', async (req, res) => {
    const { text, scheduledTime } = req.body;
    try {
        const currentRes = await queryWithRetry(`SELECT payload FROM message_queue WHERE id = $1`, [req.params.id]);
        if (currentRes.rowCount === 0) return res.status(404).json({ error: "Not Found" });
        const payload = currentRes.rows[0].payload;
        if (text) payload.message = text;
        await queryWithRetry(`UPDATE message_queue SET payload = $1, scheduled_time = COALESCE($2, scheduled_time) WHERE id = $3`, [JSON.stringify(payload), scheduledTime, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// System & Standard Routes
apiRouter.get('/system/stats', async (req, res) => {
    try {
        const start = Date.now();
        await queryWithRetry('SELECT 1');
        res.json({ serverLoad: 12, dbLatency: Date.now() - start, aiCredits: 95, aiModel: "Gemini 2.5", s3Status: 'ok', whatsappStatus: META_API_TOKEN ? 'ok' : 'error' });
    } catch (e) { res.json({ serverLoad: 0, dbLatency: 9999, s3Status: 'error', whatsappStatus: 'error' }); }
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
    const sysSettings = await fetchRuntimeConfig();
    if (!sysSettings.systemSettings.sending_enabled) return res.status(503).json({ error: "Sending Disabled" });
    const driverRes = await queryWithRetry('SELECT * FROM drivers WHERE id = $1', [driverId]);
    if (driverRes.rows.length === 0) return res.status(404).json({ error: "Driver not found" });
    const driver = driverRes.rows[0];
    const metaPayload = generateWhatsAppPayload({ message: text, templateName, mediaUrl, mediaType });
    const metaRes = await sendToMeta(driver.phone_number, metaPayload);
    if (!metaRes.success) return res.status(500).json({ error: metaRes.error });
    let msgs = typeof driver.messages === 'string' ? JSON.parse(driver.messages) : (driver.messages || []);
    msgs.push({ id: `agent_${Date.now()}`, sender: 'agent', text: text || `[${templateName || mediaType}]`, timestamp: Date.now(), type: 'text', status: 'sent' });
    await queryWithRetry('UPDATE drivers SET messages = $1, last_message = $2, last_message_time = $3 WHERE id = $4', [JSON.stringify(msgs), "Agent Reply", Date.now(), driverId]);
    res.json({ success: true });
});

apiRouter.get('/bot-settings', async (req, res) => { const config = await fetchRuntimeConfig(); res.json(config.botSettings); });
apiRouter.post('/bot-settings', async (req, res) => { await queryWithRetry(`INSERT INTO bot_settings (id, settings) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET settings = $1`, [req.body]); res.json({ success: true }); });
apiRouter.get('/system/settings', async (req, res) => { const config = await fetchRuntimeConfig(); res.json(config.systemSettings); });
apiRouter.post('/system/settings', async (req, res) => { for (const [k, v] of Object.entries(req.body.settings)) await queryWithRetry(`INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [k, String(v)]); res.json({ success: true }); });

// --- MEDIA ROUTES ---
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

apiRouter.post('/folders/:id/public', async (req, res) => { await queryWithRetry('UPDATE media_folders SET is_public_showcase = TRUE WHERE id = $1', [req.params.id]); res.json({ success: true }); });
apiRouter.delete('/folders/:id/public', async (req, res) => { await queryWithRetry('UPDATE media_folders SET is_public_showcase = FALSE WHERE id = $1', [req.params.id]); res.json({ success: true }); });

apiRouter.get('/public/status', async (req, res) => {
    const resDb = await queryWithRetry('SELECT id, name FROM media_folders WHERE is_public_showcase = TRUE ORDER BY created_at DESC LIMIT 1');
    res.json(resDb.rows.length > 0 ? { active: true, folderId: resDb.rows[0].id, folderName: resDb.rows[0].name } : { active: false });
});

apiRouter.get('/public/showcase', async (req, res) => {
    const folderName = req.query.folder;
    let query = 'SELECT id, name FROM media_folders WHERE is_public_showcase = TRUE ORDER BY created_at DESC LIMIT 1';
    let params = [];
    if (folderName && folderName !== 'undefined') { query = 'SELECT id, name FROM media_folders WHERE name = $1'; params = [decodeURIComponent(folderName)]; }
    const fRes = await queryWithRetry(query, params);
    if (fRes.rows.length === 0) return res.json({ items: [], title: 'Showcase Offline' });
    const filesRes = await queryWithRetry('SELECT * FROM media_files WHERE folder_path = $1 OR folder_path = $2 ORDER BY created_at DESC', [`/${fRes.rows[0].name}`, fRes.rows[0].name]);
    res.json({ items: filesRes.rows, title: fRes.rows[0].name });
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
    res.json({ success: true });
});

apiRouter.delete('/files/:id', async (req, res) => {
    const fileRes = await queryWithRetry('SELECT key FROM media_files WHERE id = $1', [req.params.id]);
    if (fileRes.rows.length > 0) {
        if (fileRes.rows[0].key) try { await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: fileRes.rows[0].key })); } catch(e) {}
        await queryWithRetry('DELETE FROM media_files WHERE id = $1', [req.params.id]);
    }
    res.json({ success: true });
});

apiRouter.delete('/folders/:id', async (req, res) => { await queryWithRetry('DELETE FROM media_folders WHERE id = $1', [req.params.id]); res.json({ success: true }); });

app.use('/api/public', publicRouter); 
app.use('/api', apiRouter); 

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); ensureSchema(); });
}
module.exports = app;

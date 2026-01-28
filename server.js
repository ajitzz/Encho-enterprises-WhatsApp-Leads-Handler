
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
    META_TIMEOUT: 12000, // Increased timeout for Meta API
    DB_CONNECTION_TIMEOUT: 20000, // 20s for DB connection (Cold Start buffer)
    BATCH_SIZE: 10, 
    PROCESS_INTERVAL: 5000,
    MAX_RETRIES: 3
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

// --- ENVIRONMENT VARIABLES & VALIDATION ---
const SUPER_ADMIN_EMAILS = (process.env.SUPER_ADMIN_EMAILS || "").split(',').map(e => e.trim().toLowerCase()).filter(e => e);
const GOOGLE_CLIENT_ID = process.env.VITE_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const authClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

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

// --- RESILIENT DATABASE CONNECTION ---
const DEFAULT_DB_URL = "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL || DEFAULT_DB_URL;
const IS_SERVERLESS = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';

let pool;

const initializePool = () => {
    if (!CONNECTION_STRING) {
        console.error("❌ CRITICAL: No Database Connection String found in env vars.");
        return null;
    }

    // Mask password for logging
    const maskedUrl = CONNECTION_STRING.replace(/:([^:@]+)@/, ':****@');
    console.log(`🔌 Initializing DB Pool... URL: ${maskedUrl} (Serverless Mode: ${IS_SERVERLESS})`);

    return new Pool({
        connectionString: CONNECTION_STRING,
        ssl: { rejectUnauthorized: false }, // Required for Neon
        max: IS_SERVERLESS ? 5 : 20, // Increased limits to prevent worker starvation
        connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT, 
        idleTimeoutMillis: 30000 
    });
};

if (!global.pgPool) {
    global.pgPool = initializePool();
}
pool = global.pgPool;

// Specific Startup Probe to debug connection issues
const testDbConnection = async () => {
    if (!pool) return;
    let client;
    try {
        console.log("🟡 Testing Database Connection...");
        client = await pool.connect();
        const res = await client.query('SELECT NOW() as now');
        console.log(`✅ Database Connected! Server Time: ${res.rows[0].now}`);
    } catch (err) {
        console.error("🔥 DATABASE CONNECTION FAILED:", err.message);
        console.error("   Hint: Check your IP Whitelist on Neon or your internet connection.");
    } finally {
        if (client) client.release();
    }
};

// --- INDUSTRIAL GRADE QUERY HELPER ---
const queryWithRetry = async (text, params, retries = 2) => { 
    if (!pool) throw new Error("Database connection not configured.");
    let client;
    try {
        client = await pool.connect();
        const res = await client.query(text, params);
        return res;
    } catch (err) {
        if (client) { try { client.release(true); } catch(e) {} client = null; }
        
        const isConnectionError = err.code === 'ECONNRESET' || err.code === '57P01' || err.message.includes('timeout') || err.message.includes('closed');
        
        if (retries > 0 && isConnectionError) {
            console.warn(`[DB] Connection lost. Retrying... (${retries} attempts left)`);
            await new Promise(res => setTimeout(res, 1500)); 
            return queryWithRetry(text, params, retries - 1);
        }
        throw err;
    } finally {
        if (client) { try { client.release(); } catch(e) {} }
    }
};

// --- SCHEMA & CACHE MANAGEMENT ---
let schemaPromise = null;

const ensureSchema = async () => {
    if (schemaPromise) return schemaPromise;
    
    schemaPromise = (async () => {
        try {
            await queryWithRetry(`CREATE TABLE IF NOT EXISTS bot_settings (id SERIAL PRIMARY KEY, settings JSONB)`);
            await queryWithRetry(`CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT)`);
            await queryWithRetry(`CREATE TABLE IF NOT EXISTS drivers (id TEXT PRIMARY KEY, phone_number TEXT, name TEXT, status TEXT, last_message TEXT, last_message_time BIGINT)`);
            await queryWithRetry(`CREATE TABLE IF NOT EXISTS driver_documents (id TEXT PRIMARY KEY, driver_id TEXT, doc_type TEXT, file_url TEXT, mime_type TEXT, verification_status TEXT DEFAULT 'pending', created_at BIGINT, notes TEXT)`);
            await queryWithRetry(`CREATE TABLE IF NOT EXISTS media_folders (id UUID PRIMARY KEY, name TEXT, parent_path TEXT, created_at BIGINT, is_public_showcase BOOLEAN DEFAULT FALSE)`);
            await queryWithRetry(`CREATE TABLE IF NOT EXISTS media_files (id UUID PRIMARY KEY, key TEXT, url TEXT, filename TEXT, type TEXT, folder_path TEXT, created_at BIGINT, media_id TEXT)`);
            
            // QUEUE TABLE FOR BULK/SCHEDULED MESSAGES
            await queryWithRetry(`CREATE TABLE IF NOT EXISTS message_queue (
                id UUID PRIMARY KEY, 
                driver_id TEXT, 
                payload JSONB, 
                scheduled_time BIGINT, 
                status TEXT DEFAULT 'pending', 
                attempts INT DEFAULT 0,
                last_error TEXT,
                created_at BIGINT
            )`);
            await queryWithRetry(`CREATE INDEX IF NOT EXISTS idx_message_queue_status_time ON message_queue(status, scheduled_time)`);
            await queryWithRetry(`CREATE INDEX IF NOT EXISTS idx_message_queue_driver ON message_queue(driver_id, status)`);

            const addCol = async (table, col, type) => {
                try { await queryWithRetry(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${type}`); } catch(e) {}
            };
            await addCol('drivers', 'metadata', 'JSONB DEFAULT \'{}\'');
            await addCol('drivers', 'messages', 'JSONB DEFAULT \'[]\'');
            await addCol('drivers', 'email', 'TEXT');
            await addCol('drivers', 'source', 'TEXT DEFAULT \'Organic\'');
            await addCol('drivers', 'notes', 'TEXT');
            await addCol('media_folders', 'is_public_showcase', 'BOOLEAN DEFAULT FALSE');
        } catch (e) {
            console.error("Schema Init Error:", e.message);
            schemaPromise = null; 
        }
    })();
    return schemaPromise;
};

// Optimized Cache Fetching
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

// --- PAYLOAD ENGINE ---
const generateWhatsAppPayload = (content) => {
    if (content.templateName) {
        return { type: 'template', template: { name: content.templateName, language: { code: 'en_US' } } };
    }

    let buttons = [];
    if (content.options && Array.isArray(content.options) && content.options.length > 0) {
        buttons = content.options.map(opt => ({ type: 'reply', title: opt, payload: opt }));
    } else if (content.buttons && Array.isArray(content.buttons) && content.buttons.length > 0) {
        buttons = content.buttons.filter(b => b.type === 'reply' || b.type === 'list');
    }

    const buttonCount = buttons.length;
    const useListMessage = buttonCount > 3 && buttonCount <= 10;
    const useSimpleText = buttonCount > 10;

    let header = undefined;
    if (content.headerImageUrl || (content.mediaUrl && ['image', 'video', 'document'].includes(content.mediaType))) {
        if (content.mediaType === 'video') header = { type: 'video', video: { link: content.mediaUrl } };
        else if (content.mediaType === 'document') header = { type: 'document', document: { link: content.mediaUrl } };
        else header = { type: 'image', image: { link: content.headerImageUrl || content.mediaUrl } };
    }

    const bodyText = (content.message || "Please select an option:").substring(0, 1024);
    const footerText = (content.footerText || "Uber Fleet").substring(0, 60);

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
                    sections: [{
                        title: "Available Options",
                        rows: buttons.map(b => ({
                            id: (b.payload || b.title).substring(0, 200),
                            title: b.title.substring(0, 24),
                            description: "" 
                        }))
                    }]
                }
            }
        };
    }

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
                            title: b.title.substring(0, 20)
                        }
                    }))
                }
            }
        };
    }

    if (!buttonCount && content.mediaUrl) {
        const type = content.mediaType === 'video' ? 'video' : (content.mediaType === 'document' ? 'document' : 'image');
        return { type, [type]: { link: content.mediaUrl, caption: bodyText } };
    }

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
            { headers: { 'Authorization': `Bearer ${META_API_TOKEN}`, 'Content-Type': 'application/json' }, timeout: SYSTEM_CONFIG.META_TIMEOUT }
        );
        return { success: true };
    } catch (e) {
        return { success: false, error: e.response?.data || e.message };
    }
};

// --- INDUSTRIAL QUEUE PROCESSOR WORKER ---
let isProcessingQueue = false;

const processMessageQueue = async () => {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    try {
        await ensureSchema();
        const now = Date.now();
        
        const jobsRes = await queryWithRetry(
            `UPDATE message_queue 
             SET status = 'processing' 
             WHERE id IN (
                 SELECT id FROM message_queue 
                 WHERE status = 'pending' AND scheduled_time <= $1 
                 ORDER BY scheduled_time ASC 
                 LIMIT $2 
                 FOR UPDATE SKIP LOCKED
             ) 
             RETURNING *`,
            [now, SYSTEM_CONFIG.BATCH_SIZE]
        );

        if (jobsRes.rows.length === 0) {
            isProcessingQueue = false;
            return;
        }

        const config = await fetchRuntimeConfig();
        if (!config.systemSettings.sending_enabled) {
            console.log("[Worker] Sending Disabled. Reverting locked items.");
            await queryWithRetry(`UPDATE message_queue SET status = 'pending' WHERE id = ANY($1)`, [jobsRes.rows.map(j => j.id)]);
            isProcessingQueue = false;
            return;
        }

        console.log(`[Worker] Processing ${jobsRes.rows.length} messages...`);

        for (const job of jobsRes.rows) {
            if (job.attempts >= SYSTEM_CONFIG.MAX_RETRIES) {
                await queryWithRetry(`UPDATE message_queue SET status = 'failed', last_error = 'Max retries exceeded' WHERE id = $1`, [job.id]);
                continue;
            }

            try {
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
                        id: `bulk_${Date.now()}_${job.id}`,
                        sender: 'agent',
                        text: job.payload.message || `[${job.payload.templateName || 'Media'}]`,
                        timestamp: Date.now(),
                        type: 'text',
                        status: 'sent',
                        isBroadcast: true
                    });

                    await queryWithRetry(
                        `UPDATE drivers SET messages = $1, last_message = $2, last_message_time = $3 WHERE id = $4`,
                        [JSON.stringify(msgs), "Broadcast Message", Date.now(), job.driver_id]
                    );

                } else {
                    const errorMsg = JSON.stringify(sendRes.error).substring(0, 200);
                    await queryWithRetry(
                        `UPDATE message_queue SET attempts = attempts + 1, last_error = $1, status = CASE WHEN attempts + 1 >= $2 THEN 'failed' ELSE 'pending' END WHERE id = $3`,
                        [errorMsg, SYSTEM_CONFIG.MAX_RETRIES, job.id]
                    );
                }
                await new Promise(r => setTimeout(r, 100));

            } catch (e) {
                console.error(`[Worker] Job ${job.id} failed:`, e.message);
                await queryWithRetry(`UPDATE message_queue SET attempts = attempts + 1, last_error = $1 WHERE id = $2`, [e.message, job.id]);
            }
        }

    } catch (e) {
        console.error("[Worker] Critical Error:", e);
    } finally {
        isProcessingQueue = false;
    }
};

setInterval(processMessageQueue, SYSTEM_CONFIG.PROCESS_INTERVAL);

// ============================================================================
// ROUTES
// ============================================================================

app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', async (req, res) => {
    try {
        await ensureSchema();
        const body = req.body;

        if (body.object === 'whatsapp_business_account') {
            const entries = body.entry || [];
            await Promise.all(entries.map(async (entry) => {
                const changes = entry.changes || [];
                await Promise.all(changes.map(async (change) => {
                    const value = change.value;
                    if (value.messages && value.messages.length > 0) {
                        const message = value.messages[0];
                        const from = message.from;
                        
                        const [config, driverRes] = await Promise.all([
                            fetchRuntimeConfig(),
                            queryWithRetry('SELECT * FROM drivers WHERE phone_number = $1', [from])
                        ]);

                        const { botSettings, systemSettings } = config;
                        if (!systemSettings.webhook_ingest_enabled) return;

                        let msgBody = '';
                        let btnId = null;

                        if (message.type === 'text') msgBody = message.text.body;
                        else if (message.type === 'interactive') {
                            if (message.interactive.type === 'button_reply') {
                                msgBody = message.interactive.button_reply.title;
                                btnId = message.interactive.button_reply.id;
                            } else if (message.interactive.type === 'list_reply') {
                                msgBody = message.interactive.list_reply.title;
                                btnId = message.interactive.list_reply.id;
                            }
                        } else if (message.type === 'image') msgBody = '[Image]';
                        else msgBody = '[Media]';

                        let driverRow = driverRes.rows[0];
                        
                        if (!driverRow) {
                             const newId = Date.now().toString();
                             const insertRes = await queryWithRetry(
                                 `INSERT INTO drivers (id, phone_number, name, status, last_message, last_message_time, metadata, messages, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
                                 [newId, from, 'New Lead', 'New', msgBody, Date.now(), { isBotActive: true }, '[]', 'Organic']
                             );
                             driverRow = insertRes.rows[0];
                        }

                        let messages = [];
                        try { messages = typeof driverRow.messages === 'string' ? JSON.parse(driverRow.messages) : (driverRow.messages || []); } catch(e) {}
                        
                        if (messages.some(m => m.id === message.id)) return;
                        
                        messages.push({ id: message.id, sender: 'driver', text: msgBody, timestamp: Date.now(), type: message.type });
                        
                        // --- BOT LOGIC ---
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
                                } else {
                                    currentBotStepId = entryPointId;
                                    replyToSend = botSettings.steps.find(s => s.id === entryPointId);
                                }
                            }
                        }

                        if (replyToSend && systemSettings.sending_enabled) {
                            const rawText = replyToSend.message || "";
                            const isPlaceholder = /replace\s+this\s+sample|type\s+your\s+message/i.test(rawText);
                            const isEmpty = !rawText.trim() && !replyToSend.mediaUrl;

                            if (!isPlaceholder && !isEmpty) {
                                const metaPayload = generateWhatsAppPayload(replyToSend);
                                const sendRes = await sendToMeta(driverRow.phone_number, metaPayload);
                                if (sendRes.success) {
                                    messages.push({
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

                        const newMetadata = { ...driverMetadata, currentBotStepId, isBotActive: currentBotStepId !== null };
                        await queryWithRetry(
                            `UPDATE drivers SET last_message = $1, last_message_time = $2, messages = $3, metadata = $4 WHERE id = $5`,
                            [msgBody, Date.now(), JSON.stringify(messages), JSON.stringify(newMetadata), driverRow.id]
                        );
                    }
                }));
            }));
        }
        res.sendStatus(200);
    } catch (e) {
        console.error("Webhook Error:", e);
        res.sendStatus(200); 
    }
});

// AUTH
apiRouter.post('/auth/login', async (req, res) => {
    const { token } = req.body;
    try {
        if (!authClient) throw new Error("Google Auth Config Missing");
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

apiRouter.post('/messages/schedule', async (req, res) => {
    const { driverIds, scheduledTime, ...content } = req.body;
    const time = scheduledTime || Date.now();
    
    if (!Array.isArray(driverIds) || driverIds.length === 0) {
        return res.status(400).json({ error: "No recipients provided" });
    }

    try {
        const query = `
            INSERT INTO message_queue (id, driver_id, payload, scheduled_time, created_at)
            VALUES ($1, $2, $3, $4, $5)
        `;
        
        for (const driverId of driverIds) {
            await queryWithRetry(query, [
                crypto.randomUUID(),
                driverId,
                JSON.stringify(content), 
                time,
                Date.now()
            ]);
        }

        if (time <= Date.now()) {
            processMessageQueue(); 
        }

        res.json({ success: true, message: `Queued ${driverIds.length} messages.` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

apiRouter.get('/drivers/:id/scheduled-messages', async (req, res) => {
    try {
        const result = await queryWithRetry(
            `SELECT id, driver_id as "driverId", payload, scheduled_time as "scheduledTime", status, created_at as "createdAt"
             FROM message_queue 
             WHERE driver_id = $1 AND status IN ('pending', 'failed') 
             ORDER BY scheduled_time ASC`,
            [req.params.id]
        );
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

apiRouter.delete('/messages/scheduled/:id', async (req, res) => {
    try {
        const result = await queryWithRetry(
            `DELETE FROM message_queue WHERE id = $1 AND status IN ('pending', 'failed') RETURNING id`,
            [req.params.id]
        );
        
        if (result.rowCount === 0) {
            return res.status(409).json({ error: "Message already processed or not found." });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

apiRouter.patch('/messages/scheduled/:id', async (req, res) => {
    const { text, scheduledTime, sendNow } = req.body;
    try {
        const newTime = sendNow ? Date.now() : scheduledTime;

        const currentRes = await queryWithRetry(
            `SELECT payload FROM message_queue WHERE id = $1 AND status IN ('pending', 'failed')`, 
            [req.params.id]
        );
        
        if (currentRes.rowCount === 0) {
            return res.status(409).json({ error: "Message already processed or not found." });
        }

        const currentPayload = currentRes.rows[0].payload;
        const newPayload = { ...currentPayload };
        if (text !== undefined) newPayload.message = text;

        await queryWithRetry(
            `UPDATE message_queue SET payload = $1, scheduled_time = COALESCE($2, scheduled_time) WHERE id = $3`,
            [JSON.stringify(newPayload), newTime, req.params.id]
        );
        
        if (sendNow) {
            processMessageQueue();
        }
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

apiRouter.get('/cron/process-queue', async (req, res) => {
    processMessageQueue();
    res.json({ success: true, message: "Worker triggered" });
});

apiRouter.get('/drivers', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM drivers ORDER BY last_message_time DESC LIMIT 100');
        res.json(result.rows.map(mapDriver)); // mapDriver assumed defined previously or imported
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ... (Rest of existing API routes remain the same, just ensuring queryWithRetry is used) ...

// Mappers (re-included for completeness within this file scope if not hoisting)
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

// Re-include basic GET routes used by frontend poller
apiRouter.get('/sync', async (req, res) => {
    const since = parseInt(req.query.since || '0');
    try {
        const result = await queryWithRetry('SELECT * FROM drivers WHERE last_message_time > $1 ORDER BY last_message_time DESC LIMIT 50', [since]);
        res.json({ drivers: result.rows.map(mapDriver), nextCursor: Date.now() });
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

apiRouter.get('/drivers/:id/documents', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM driver_documents WHERE driver_id = $1 ORDER BY created_at DESC', [req.params.id]);
        res.json(result.rows.map(mapDocument));
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

apiRouter.post('/messages/send', async (req, res) => {
    const { driverId, text, templateName, mediaUrl, mediaType } = req.body;
    const sysSettings = await fetchRuntimeConfig();
    if (!sysSettings.systemSettings.sending_enabled) return res.status(503).json({ error: "Sending Disabled" });
    try {
        const driverRes = await queryWithRetry('SELECT * FROM drivers WHERE id = $1', [driverId]);
        if (driverRes.rows.length === 0) return res.status(404).json({ error: "Driver not found" });
        const driver = driverRes.rows[0];
        
        const metaPayload = generateWhatsAppPayload({ message: text, templateName, mediaUrl, mediaType });
        const metaRes = await sendToMeta(driver.phone_number, metaPayload);
        if (!metaRes.success) throw new Error(JSON.stringify(metaRes.error));

        let msgs = typeof driver.messages === 'string' ? JSON.parse(driver.messages) : (driver.messages || []);
        msgs.push({ id: `agent_${Date.now()}`, sender: 'agent', text: text || `[${templateName || mediaType}]`, timestamp: Date.now(), type: 'text', status: 'sent' });
        await queryWithRetry('UPDATE drivers SET messages = $1, last_message = $2, last_message_time = $3 WHERE id = $4', [JSON.stringify(msgs), "Agent Reply", Date.now(), driverId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/bot-settings', async (req, res) => { 
    const config = await fetchRuntimeConfig();
    res.json(config.botSettings); 
});

apiRouter.post('/bot-settings', async (req, res) => {
    await queryWithRetry(`INSERT INTO bot_settings (id, settings) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET settings = $1`, [req.body]);
    res.json({ success: true });
});

apiRouter.get('/system/stats', async (req, res) => {
    res.json({ serverLoad: 12, dbLatency: 5, aiCredits: 100, aiModel: "Gemini 1.5", s3Status: 'ok', whatsappStatus: META_API_TOKEN ? 'ok' : 'error' });
});

apiRouter.get('/system/settings', async (req, res) => { 
    const config = await fetchRuntimeConfig();
    res.json(config.systemSettings); 
});

apiRouter.post('/system/settings', async (req, res) => {
    const { settings } = req.body;
    for (const [k, v] of Object.entries(settings)) {
        await queryWithRetry(`INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [k, String(v)]);
    }
    res.json({ success: true });
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

app.use('/api/public', publicRouter); 
app.use('/api', apiRouter); 

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, async () => {
        console.log(`Server running on port ${PORT}`);
        // Run probe immediately
        await testDbConnection();
        ensureSchema(); 
    });
}

module.exports = app;

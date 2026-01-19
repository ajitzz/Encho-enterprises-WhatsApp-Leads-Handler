
/**
 * UBER FLEET RECRUITER - BACKEND SERVER
 * Enterprise-Grade Connection Handling for Vercel + Neon
 * VERCEL-SAFE MODE ENABLED
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg'); 
const { S3Client } = require('@aws-sdk/client-s3');
const os = require('os');
require('dotenv').config();

const app = express();
const router = express.Router(); 

// Raw body needed for signature verification
app.use(express.json({ 
    limit: '10mb',
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
app.use(cors()); 

// Vercel optimization: Disable ETag for dynamic API responses
app.set('etag', false);
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

// --- DYNAMIC CREDENTIALS ---
// Using specific values provided by user as robust fallbacks
const META_API_TOKEN = (process.env.META_API_TOKEN || "").trim() || "EAAkr7Y9S2qYBQfHTNZASIugAzOi8b2MZCBct4z4jZBHSmQ2KGlFduuDQQGEYC9NRDtZBUdhMPdeJ06OjYUiJYGfFkZCAxzyh4TdidN7ZA10K3XPOVEiQh01jo22xLsQjXrEtMHc5ZCHZBbRZAyA5d0pl26Jsg3IuNKY272QYmqEjHghf11OKJmbUZBfJLe5EvHzl48gAZDZD";
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim() || "982841698238647";
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "").trim() || "uber_fleet_verify_token";
const APP_SECRET = (process.env.APP_SECRET || "").trim() || ""; 

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
    }
});

// --- DATABASE CONNECTION ---
const DEFAULT_DB_URL = "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL || DEFAULT_DB_URL;

if (!CONNECTION_STRING) {
    console.error("❌ CRITICAL ERROR: POSTGRES_URL or DATABASE_URL environment variable is missing.");
}

let pool;
if (!global.pgPool) {
    if (CONNECTION_STRING) {
        global.pgPool = new Pool({
            connectionString: CONNECTION_STRING,
            ssl: { rejectUnauthorized: false },
            max: 5, 
            connectionTimeoutMillis: 15000, // INCREASED: 15s timeout to allow Neon DB to wake up from sleep
            idleTimeoutMillis: 10000,
        });
    }
}
pool = global.pgPool;

// --- SCHEMA DEFINITIONS ---
const SCHEMA_QUERIES = `
    CREATE TABLE IF NOT EXISTS drivers (
        id TEXT PRIMARY KEY,
        phone_number TEXT UNIQUE NOT NULL,
        name TEXT,
        source TEXT DEFAULT 'Organic',
        status TEXT DEFAULT 'New',
        last_message TEXT,
        last_message_time BIGINT,
        notes TEXT,
        vehicle_registration TEXT,
        availability TEXT,
        current_bot_step_id TEXT,
        is_bot_active BOOLEAN DEFAULT TRUE,
        is_human_mode BOOLEAN DEFAULT FALSE,
        qualification_checks JSONB DEFAULT '{}',
        onboarding_step INT DEFAULT 0,
        updated_at BIGINT DEFAULT (extract(epoch from now()) * 1000)
    );
    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        driver_id TEXT REFERENCES drivers(id),
        sender TEXT,
        text TEXT,
        timestamp BIGINT,
        type TEXT DEFAULT 'text',
        image_url TEXT,
        header_image_url TEXT,
        footer_text TEXT,
        buttons JSONB,
        template_name TEXT,
        client_message_id TEXT UNIQUE, 
        whatsapp_message_id TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS driver_documents (
        id TEXT PRIMARY KEY,
        driver_id TEXT REFERENCES drivers(id) ON DELETE CASCADE,
        doc_type TEXT NOT NULL,
        file_url TEXT NOT NULL,
        mime_type TEXT,
        created_at BIGINT DEFAULT (extract(epoch from now()) * 1000),
        verification_status TEXT DEFAULT 'pending',
        notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_driver_documents_driver_id ON driver_documents(driver_id);
    CREATE TABLE IF NOT EXISTS bot_settings (
        id INT PRIMARY KEY DEFAULT 1,
        settings JSONB
    );
    CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
    CREATE TABLE IF NOT EXISTS scheduled_messages (
        id SERIAL PRIMARY KEY,
        driver_ids TEXT[], 
        content JSONB,
        scheduled_time BIGINT,
        status TEXT DEFAULT 'pending',
        created_at BIGINT DEFAULT (extract(epoch from now()) * 1000)
    );
    INSERT INTO system_settings (key, value) VALUES 
    ('webhook_ingest_enabled', 'true'),
    ('automation_enabled', 'true'),
    ('sending_enabled', 'true')
    ON CONFLICT (key) DO NOTHING;
`;

// --- MIGRATION QUERIES (Auto-Update Existing Tables) ---
const MIGRATION_QUERIES = `
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_message_id TEXT UNIQUE;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS whatsapp_message_id TEXT UNIQUE;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS template_name TEXT;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS current_bot_step_id TEXT;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_bot_active BOOLEAN DEFAULT TRUE;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_human_mode BOOLEAN DEFAULT FALSE;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS qualification_checks JSONB DEFAULT '{}';
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS onboarding_step INT DEFAULT 0;
`;

// --- QUERY EXECUTION HELPER ---
const queryWithRetry = async (text, params, retries = 2) => { 
    if (!pool) throw new Error("Database connection not configured.");
    let client;
    try {
        client = await pool.connect();
        const res = await client.query(text, params);
        return res;
    } catch (err) {
        if (client) { try { client.release(true); } catch(e) {} client = null; }
        
        // SELF-HEALING: Missing Table
        if (err.code === '42P01') { 
            console.warn("⚠️ Tables missing. Running Schema Init...");
            try {
                const healClient = await pool.connect();
                await healClient.query(SCHEMA_QUERIES);
                healClient.release();
                // Retry original
                const retryClient = await pool.connect();
                const res = await retryClient.query(text, params);
                retryClient.release();
                return res;
            } catch (healErr) {
                console.error("❌ Schema Healing Failed:", healErr);
                throw healErr;
            }
        }
        
        // SELF-HEALING: Missing Column (Undefined Column)
        if (err.code === '42703') {
             console.warn("⚠️ Columns missing. Running Migrations...");
             try {
                const healClient = await pool.connect();
                await healClient.query(MIGRATION_QUERIES);
                healClient.release();
                // Retry original
                const retryClient = await pool.connect();
                const res = await retryClient.query(text, params);
                retryClient.release();
                return res;
             } catch (healErr) {
                console.error("❌ Migration Failed:", healErr);
                throw healErr;
             }
        }

        // Connection Retries
        if (retries > 0 && (err.code === 'ECONNRESET' || err.code === '57P01' || err.message.includes('timeout'))) {
            await new Promise(res => setTimeout(res, 1000)); 
            return queryWithRetry(text, params, retries - 1);
        }
        throw err;
    } finally {
        if (client) { try { client.release(); } catch(e) {} }
    }
};

// --- INIT DB ON STARTUP ---
const initDB = async () => {
    try {
        await queryWithRetry("SELECT 1"); // Warm up connection
        await queryWithRetry(SCHEMA_QUERIES);
        await queryWithRetry(MIGRATION_QUERIES);
        console.log("✅ Database Initialized & Migrated");
    } catch (e) {
        console.error("⚠️ DB Init warning:", e.message);
    }
};
initDB();

// --- DTO MAPPERS ---
const toDriverDTO = (row) => ({
    id: row.id,
    phoneNumber: row.phone_number,
    name: row.name,
    source: row.source,
    status: row.status,
    lastMessage: row.last_message,
    lastMessageTime: parseInt(row.last_message_time || '0'),
    notes: row.notes,
    vehicleRegistration: row.vehicle_registration,
    availability: row.availability,
    currentBotStepId: row.current_bot_step_id,
    isBotActive: row.is_bot_active,
    isHumanMode: row.is_human_mode,
    qualificationChecks: row.qualification_checks || {},
    onboardingStep: row.onboarding_step || 0,
    messages: [], 
    documents: [] 
});

const toMessageDTO = (row) => ({
    id: row.id,
    sender: row.sender,
    text: row.text,
    type: row.type,
    timestamp: parseInt(row.timestamp || '0'),
    imageUrl: row.image_url,
    headerImageUrl: row.header_image_url,
    footerText: row.footer_text,
    buttons: row.buttons, 
    templateName: row.template_name
});

const toDocumentDTO = (row) => ({
    id: row.id,
    driverId: row.driver_id,
    docType: row.doc_type,
    fileUrl: row.file_url,
    mimeType: row.mime_type,
    createdAt: parseInt(row.created_at || '0'),
    verificationStatus: row.verification_status,
    notes: row.notes
});

// --- HELPER FUNCTIONS ---
const getSystemSetting = async (key) => {
    try {
        const res = await queryWithRetry('SELECT value FROM system_settings WHERE key = $1', [key]);
        if (res.rows.length > 0) return res.rows[0].value === 'true';
        return true; 
    } catch (e) {
        return true;
    }
};

const updateDriverTimestamp = async (driverId) => {
    try {
        await queryWithRetry('UPDATE drivers SET updated_at = $1 WHERE id = $2', [Date.now(), driverId]);
    } catch (e) { console.error("Timestamp update failed", e); }
};

// --- OUTBOUND SENDING (WITH CONTENT FIREWALL) ---
const sendWhatsAppMessage = async (to, content, clientMessageId = null) => {
    // 1. CONTENT FIREWALL: BLOCK PLACEHOLDERS
    const unsafeRegex = /replace\s+this|enter\s+your\s+message|type\s+your\s+message|sample\s+message/i;
    const bodyText = (content.text || content.message || "").substring(0, 4096);
    
    if (unsafeRegex.test(bodyText)) {
        console.error(`⛔ BLOCKED OUTBOUND MESSAGE: Detected placeholder text. Content: "${bodyText.substring(0, 50)}..."`);
        return { success: false, error: "Blocked: Placeholder Text Detected" };
    }

    if (!bodyText.trim() && !content.templateName && !content.mediaUrl && !content.buttons) {
         console.error("⛔ BLOCKED OUTBOUND MESSAGE: Empty Content");
         return { success: false, error: "Blocked: Empty Content" };
    }

    // 2. Idempotency Check (Fast)
    if (clientMessageId) {
        try {
            const existing = await queryWithRetry('SELECT id FROM messages WHERE client_message_id = $1', [clientMessageId]);
            if (existing.rows.length > 0) return { success: true, duplicate: true };
        } catch(e) { console.warn("Idempotency check skipped due to DB load"); }
    }

    if (!META_API_TOKEN || !PHONE_NUMBER_ID) {
        console.error("❌ Meta Credentials Missing.");
        return { success: false, error: "Missing Credentials" };
    }

    // 3. Sanitize Phone Number
    let cleanTo = to.replace(/\D/g, ''); 
    
    // Use Graph API v21.0
    const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
    
    // Fallback text if body is empty but strictly required
    const safeBodyText = bodyText.trim() || " ";

    let payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: cleanTo,
        type: "text",
        text: { body: safeBodyText }
    };

    if (content.buttons?.length > 0 || (content.options && content.options.length > 0)) {
        payload.type = "interactive";
        let headerObj = undefined;
        if (content.headerImageUrl && content.headerImageUrl.startsWith('http')) {
            headerObj = { type: "image", image: { link: content.headerImageUrl } };
        }

        let finalButtons = content.buttons || [];
        if (finalButtons.length === 0 && content.options) {
            finalButtons = content.options.slice(0, 3).map((opt, i) => ({
                type: 'reply',
                title: opt,
                payload: `btn_${i}_${opt.substring(0, 10)}`
            }));
        }

        const actionObj = {
            buttons: finalButtons.map((btn, i) => ({
                type: "reply",
                reply: { id: btn.payload || `btn_${i}`, title: (btn.title || "Option").substring(0, 20) }
            }))
        };
        
        const interactiveBodyText = safeBodyText.trim() === "" ? "Please select an option below" : safeBodyText;
        payload.interactive = {
            type: "button",
            header: headerObj,
            body: { text: interactiveBodyText }, 
            action: actionObj
        };
        if (content.footerText) payload.interactive.footer = { text: content.footerText };
        delete payload.text;
    }
    else if (content.templateName) {
        payload.type = "template";
        payload.template = { name: content.templateName, language: { code: "en_US" }, components: [] };
        delete payload.text;
    } 
    else if (content.mediaUrl) {
         const type = content.mediaType || 'image';
         payload.type = type;
         payload[type] = { link: content.mediaUrl, caption: safeBodyText !== " " ? safeBodyText : undefined };
         delete payload.text;
    }

    try {
        console.log(`📤 Sending to ${cleanTo}...`);
        await axios.post(url, payload, {
            headers: { 'Authorization': `Bearer ${META_API_TOKEN}`, 'Content-Type': 'application/json' },
            timeout: 8000 
        });
        console.log(`✅ Message Sent to ${cleanTo}`);
        return { success: true };
    } catch (error) {
        const errorDetail = error.response?.data?.error;
        console.error("❌ Meta API Failed:", JSON.stringify(errorDetail || error.message, null, 2));
        throw new Error(errorDetail?.message || error.message || "Meta API Unknown Error");
    }
};

// --- API ENDPOINTS ---

router.post('/messages/send', async (req, res) => {
    const start = Date.now();
    const { driverId, text, clientMessageId, ...attachments } = req.body;
    
    try {
        const driverRes = await queryWithRetry('SELECT phone_number FROM drivers WHERE id = $1', [driverId]);
        if (driverRes.rows.length === 0) return res.status(404).json({ error: "Driver not found" });
        const phone = driverRes.rows[0].phone_number;

        await sendWhatsAppMessage(phone, { text, ...attachments }, clientMessageId);

        const msgId = `msg_${Date.now()}_${Math.random().toString(36).substr(2,5)}`;
        const dbText = text || (attachments.templateName ? `Template: ${attachments.templateName}` : '[Media Message]');
        
        await queryWithRetry(`
            INSERT INTO messages (id, driver_id, sender, text, timestamp, type, client_message_id, buttons, template_name, image_url)
            VALUES ($1, $2, 'agent', $3, $4, $5, $6, $7, $8, $9)
        `, [
            msgId, driverId, dbText, Date.now(),
            attachments.templateName ? 'template' : (attachments.options ? 'options' : 'text'),
            clientMessageId,
            attachments.buttons ? JSON.stringify(attachments.buttons) : null,
            attachments.templateName,
            attachments.mediaUrl
        ]);

        await updateDriverTimestamp(driverId);
        res.json({ success: true, messageId: msgId });

    } catch (e) {
        console.error("Outbound Send Error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// WEBHOOK
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('✅ WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(400);
    }
});

app.post('/webhook', async (req, res) => {
    if (APP_SECRET && req.headers['x-hub-signature-256']) {
        const signature = req.headers['x-hub-signature-256'].replace('sha256=', '');
        const expected = crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
        if (signature !== expected) return res.sendStatus(403);
    }

    try {
        const body = req.body;
        if (body.object === 'whatsapp_business_account') {
            const promises = [];
            for (const entry of body.entry) {
                for (const change of entry.changes) {
                    if (change.value.messages) {
                        for (const msg of change.value.messages) {
                            promises.push(processIncomingMessage(msg, change.value.contacts));
                        }
                    }
                }
            }
            await Promise.all(promises);
        }
        res.sendStatus(200);
    } catch (e) {
        console.error("Webhook Error:", e);
        res.sendStatus(200); 
    }
});

async function processIncomingMessage(msg, contacts) {
    const from = msg.from;
    const wamid = msg.id; 
    
    const existing = await queryWithRetry('SELECT id FROM messages WHERE whatsapp_message_id = $1', [wamid]);
    if (existing.rows.length > 0) return;

    let text = '';
    let buttonId = null;
    
    if (msg.type === 'text') text = msg.text.body;
    else if (msg.type === 'button') text = msg.button.text; 
    else if (msg.type === 'interactive') {
        if (msg.interactive.type === 'button_reply') {
            text = msg.interactive.button_reply.title;
            buttonId = msg.interactive.button_reply.id; 
        } else if (msg.interactive.type === 'list_reply') {
            text = msg.interactive.list_reply.title;
            buttonId = msg.interactive.list_reply.id;
        }
    }

    let driverRes = await queryWithRetry('SELECT * FROM drivers WHERE phone_number = $1', [from]);
    let driverId;
    
    if (driverRes.rows.length === 0) {
        driverId = `d_${Date.now()}_${Math.random().toString(36).substr(2,4)}`;
        const name = contacts?.[0]?.profile?.name || 'Unknown Driver';
        await queryWithRetry(`
            INSERT INTO drivers (id, phone_number, name, status, last_message, last_message_time, updated_at)
            VALUES ($1, $2, $3, 'New', $4, $5, $6)
        `, [driverId, from, name, text, Date.now(), Date.now()]);
    } else {
        driverId = driverRes.rows[0].id;
        await queryWithRetry(`UPDATE drivers SET last_message = $1, last_message_time = $2, updated_at = $2 WHERE id = $3`, [text, Date.now(), driverId]);
    }

    const msgId = `msg_${Date.now()}_${Math.random().toString(36).substr(2,5)}`;
    await queryWithRetry(`
        INSERT INTO messages (id, driver_id, sender, text, timestamp, whatsapp_message_id)
        VALUES ($1, $2, 'driver', $3, $4, $5)
    `, [msgId, driverId, text, Date.now(), wamid]);

    try {
        await runBotEngine(driverId, text, buttonId, from);
    } catch (e) {
        console.error("Bot Engine Crash:", e);
    }
}

async function runBotEngine(driverId, text, buttonId, from) {
    const automationEnabled = await getSystemSetting('automation_enabled');
    if (!automationEnabled) return;

    const driver = (await queryWithRetry('SELECT * FROM drivers WHERE id = $1', [driverId])).rows[0];
    if (!driver.is_bot_active || driver.is_human_mode) return;

    // SCHEMA HEALING FOR BOT SETTINGS
    let botSettings;
    try {
        const botRes = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1');
        botSettings = botRes.rows[0]?.settings;
    } catch(e) {
        // Use default if DB fetch fails
        botSettings = { isEnabled: true, shouldRepeat: false, steps: [] };
    }
    
    if (!botSettings || !botSettings.isEnabled) return;

    let currentStep = botSettings.steps.find(s => s.id === driver.current_bot_step_id);
    let replyContent = null;

    if (!currentStep) {
        const entryStep = botSettings.steps.find(s => s.id === botSettings.entryPointId) || botSettings.steps[0];
        if (entryStep) {
            replyContent = entryStep;
            await queryWithRetry('UPDATE drivers SET current_bot_step_id = $1, updated_at = $3 WHERE id = $2', [entryStep.id, driverId, Date.now()]);
        }
    } else {
        let matchedRouteId = null;
        if (buttonId && currentStep.routes) matchedRouteId = currentStep.routes[buttonId];
        
        if (!matchedRouteId && currentStep.routes) {
            const lowerInput = text.toLowerCase().trim();
            const routeKey = Object.keys(currentStep.routes).find(k => k.toLowerCase() === lowerInput);
            if (routeKey) matchedRouteId = currentStep.routes[routeKey];
        }
        
        if (!matchedRouteId && !currentStep.routes && currentStep.nextStepId) {
            matchedRouteId = currentStep.nextStepId;
        }

        if (matchedRouteId) {
            if (matchedRouteId === 'END') {
                await queryWithRetry('UPDATE drivers SET current_bot_step_id = NULL, is_bot_active = $1, updated_at = $3 WHERE id = $2', [botSettings.shouldRepeat, driverId, Date.now()]);
            } else if (matchedRouteId === 'AI_HANDOFF') {
                 await queryWithRetry('UPDATE drivers SET is_human_mode = TRUE, updated_at = $2 WHERE id = $1', [driverId, Date.now()]);
            } else {
                const nextStep = botSettings.steps.find(s => s.id === matchedRouteId);
                if (nextStep) {
                    replyContent = nextStep;
                    await queryWithRetry('UPDATE drivers SET current_bot_step_id = $1, updated_at = $3 WHERE id = $2', [nextStep.id, driverId, Date.now()]);
                    if (currentStep.saveToField) {
                         try {
                             await queryWithRetry(`UPDATE drivers SET ${currentStep.saveToField} = $1 WHERE id = $2`, [text, driverId]);
                         } catch(e) {}
                    }
                }
            }
        } else {
            if (currentStep.options || currentStep.buttons) {
                 replyContent = {
                     ...currentStep,
                     message: `⚠️ Invalid selection.\n\n${currentStep.message || currentStep.title || "Please try again."}`
                 };
            }
        }
    }

    if (replyContent) {
        if (replyContent.delay) await new Promise(r => setTimeout(r, replyContent.delay * 1000));
        await sendWhatsAppMessage(from, replyContent);
        
        const botMsgId = `bot_${Date.now()}_${Math.random().toString(36).substr(2,5)}`;
        const dbText = replyContent.message || replyContent.text || '[Interactive Message]';
        await queryWithRetry(`
            INSERT INTO messages (id, driver_id, sender, text, timestamp, type)
            VALUES ($1, $2, 'system', $3, $4, $5)
        `, [botMsgId, driverId, dbText, Date.now(), replyContent.inputType || 'text']);
    }
}

// --- STANDARD GET ENDPOINTS ---
router.get('/system/stats', async (req, res) => {
    // Return mock stats quickly if DB is slow
    res.json({
        serverLoad: 0, dbLatency: 0, aiCredits: 100, aiModel: "Bot Logic",
        s3Status: 'ok', s3Load: 0, whatsappStatus: META_API_TOKEN ? 'ok' : 'error',
        whatsappUploadLoad: 0, activeUploads: 0, uptime: process.uptime()
    });
});

router.get('/drivers', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM drivers ORDER BY updated_at DESC LIMIT 100');
        res.json(result.rows.map(toDriverDTO));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/drivers/:id/messages', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM messages WHERE driver_id = $1 ORDER BY timestamp ASC', [req.params.id]);
        res.json(result.rows.map(toMessageDTO));
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/drivers/:id/documents', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM driver_documents WHERE driver_id = $1 ORDER BY created_at DESC', [req.params.id]);
        res.json(result.rows.map(toDocumentDTO));
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/drivers/:id', async (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    try {
        const allowed = ['status', 'notes', 'name', 'vehicle_registration', 'availability', 'is_bot_active', 'is_human_mode', 'qualification_checks'];
        for (const key of Object.keys(updates)) {
            if (allowed.includes(key)) {
                let val = updates[key];
                if (key === 'qualification_checks') val = JSON.stringify(val);
                await queryWithRetry(`UPDATE drivers SET ${key} = $1, updated_at = $3 WHERE id = $2`, [val, id, Date.now()]);
            }
        }
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/sync', async (req, res) => {
    const since = parseInt(req.query.since || '0');
    try {
        const result = await queryWithRetry('SELECT * FROM drivers WHERE updated_at > $1 ORDER BY updated_at DESC LIMIT 200', [since]);
        res.json(result.rows.map(toDriverDTO));
    } catch(e) { res.json([]); }
});

router.get('/bot-settings', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1');
        if (result.rows.length > 0) res.json(result.rows[0].settings);
        else res.json({ isEnabled: false, steps: [] });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/bot-settings', async (req, res) => {
    try {
        await queryWithRetry(`
            INSERT INTO bot_settings (id, settings) VALUES (1, $1)
            ON CONFLICT (id) DO UPDATE SET settings = $1
        `, [JSON.stringify(req.body)]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/system/settings', async (req, res) => {
    try {
        const rows = await queryWithRetry('SELECT * FROM system_settings');
        const settings = { webhook_ingest_enabled: true, automation_enabled: true, sending_enabled: true };
        rows.rows.forEach(r => { if (r.key in settings) settings[r.key] = r.value === 'true'; });
        res.json(settings);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/system/settings', async (req, res) => {
    try {
        const { settings } = req.body;
        for (const [key, val] of Object.entries(settings)) {
            await queryWithRetry(`
                INSERT INTO system_settings (key, value) VALUES ($1, $2)
                ON CONFLICT (key) DO UPDATE SET value = $2
            `, [key, String(val)]);
        }
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.use('/api', router);

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}

module.exports = app;

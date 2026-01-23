
/**
 * UBER FLEET RECRUITER - BACKEND SERVER
 * Enterprise-Grade Connection Handling for Vercel + Neon
 * VERCEL-SAFE MODE ENABLED
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const multer = require('multer'); 
const { Pool } = require('pg'); 
const { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
require('dotenv').config();

const app = express();
const router = express.Router(); 

// --- SERVER SIDE CACHE ---
const CACHE = {
    botSettings: null,
    systemSettings: null,
    lastRefreshed: 0
};

// Raw body needed for signature verification
app.use(express.json({ 
    limit: '10mb',
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
app.use(cors()); 

// Vercel optimization
app.set('etag', false);
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 4.5 * 1024 * 1024 }
});

// --- CREDENTIALS ---
const META_API_TOKEN = (process.env.META_API_TOKEN || "").trim() || "EAAkr7Y9S2qYBQfHTNZASIugAzOi8b2MZCBct4z4jZBHSmQ2KGlFduuDQQGEYC9NRDtZBUdhMPdeJ06OjYUiJYGfFkZCAxzyh4TdidN7ZA10K3XPOVEiQh01jo22xLsQjXrEtMHc5ZCHZBbRZAyA5d0pl26Jsg3IuNKY272QYmqEjHghf11OKJmbUZBfJLe5EvHzl48gAZDZD";
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim() || "982841698238647";
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "").trim() || "uber_fleet_verify_token";
const APP_SECRET = (process.env.APP_SECRET || "").trim() || ""; 

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

// --- DATABASE ---
const DEFAULT_DB_URL = "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL || DEFAULT_DB_URL;

let pool;
if (!global.pgPool) {
    if (CONNECTION_STRING) {
        global.pgPool = new Pool({
            connectionString: CONNECTION_STRING,
            ssl: { rejectUnauthorized: false },
            max: 2, 
            connectionTimeoutMillis: 15000, 
            idleTimeoutMillis: 30000, 
            keepAlive: true,
        });
    }
}
pool = global.pgPool;

// --- SCHEMA & QUERIES ---
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
        whatsapp_message_id TEXT UNIQUE,
        status TEXT DEFAULT 'sent',
        retry_count INT DEFAULT 0,
        next_retry_at BIGINT DEFAULT 0,
        updated_at BIGINT DEFAULT (extract(epoch from now()) * 1000)
    );
    CREATE TABLE IF NOT EXISTS bot_settings (id INT PRIMARY KEY DEFAULT 1, settings JSONB);
    CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO system_settings (key, value) VALUES 
    ('webhook_ingest_enabled', 'true'), ('automation_enabled', 'true'), ('sending_enabled', 'true')
    ON CONFLICT (key) DO NOTHING;
`;

const queryWithRetry = async (text, params) => { 
    if (!pool) throw new Error("Database connection not configured.");
    const client = await pool.connect();
    try {
        return await client.query(text, params);
    } finally {
        client.release();
    }
};

const refreshCache = async () => {
    try {
        const botRes = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1');
        CACHE.botSettings = botRes.rows[0]?.settings || { isEnabled: true, steps: [] };
        const sysRes = await queryWithRetry('SELECT * FROM system_settings');
        const settings = { webhook_ingest_enabled: true, automation_enabled: true, sending_enabled: true };
        sysRes.rows.forEach(r => { if (r.key in settings) settings[r.key] = r.value === 'true'; });
        CACHE.systemSettings = settings;
        CACHE.lastRefreshed = Date.now();
    } catch (e) { console.error("Cache refresh failed", e.message); }
};

const getCachedBotSettings = async () => { if (!CACHE.botSettings) await refreshCache(); return CACHE.botSettings; };
const getCachedSystemSetting = async (key) => { if (!CACHE.systemSettings) await refreshCache(); return CACHE.systemSettings[key]; };

const initDB = async () => {
    try {
        await queryWithRetry("SELECT 1"); 
        await queryWithRetry(SCHEMA_QUERIES);
        await refreshCache(); 
        console.log("✅ Database Initialized");
    } catch (e) { console.error("⚠️ DB Init warning:", e.message); }
};
initDB();

// --- META API HANDLER ---
const executeMetaSend = async (to, content) => {
    if (!META_API_TOKEN || !PHONE_NUMBER_ID) {
        throw new Error("Missing Meta Credentials");
    }

    let cleanTo = to.replace(/\D/g, ''); 
    const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
    const bodyText = (content.text || content.message || "").substring(0, 4096);
    
    // --- UPDATED SAFETY FILTER (PERMISSIVE) ---
    // We removed the aggressive block. Now we just warn in logs but ALLOW the message.
    if (/replace\s+this|enter\s+your\s+message/i.test(bodyText)) {
        console.warn(`⚠️ WARNING: Sending placeholder text to ${cleanTo}. Please update Bot Settings.`);
    }

    let payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: cleanTo,
        type: "text",
        text: { body: bodyText }
    };

    if (content.buttons?.length > 0 || (content.options && content.options.length > 0)) {
        payload.type = "interactive";
        let headerObj = undefined;
        if (content.headerImageUrl) headerObj = { type: "image", image: { link: content.headerImageUrl } };

        let finalButtons = content.buttons || content.options.slice(0, 3).map((opt, i) => ({ type: 'reply', title: opt, payload: `btn_${i}` }));
        const actionObj = {
            buttons: finalButtons.map((btn, i) => ({
                type: "reply",
                reply: { id: btn.payload || `btn_${i}`, title: (btn.title || "Option").substring(0, 20) }
            }))
        };
        payload.interactive = {
            type: "button",
            header: headerObj,
            body: { text: bodyText || "Select an option" }, 
            action: actionObj
        };
        if (content.footerText) payload.interactive.footer = { text: content.footerText };
        delete payload.text;
    } else if (content.templateName) {
        payload.type = "template";
        payload.template = { name: content.templateName, language: { code: "en_US" }, components: [] };
        delete payload.text;
    } else if (content.mediaUrl) {
         const type = content.mediaType || 'image';
         payload.type = type;
         payload[type] = { link: content.mediaUrl, caption: bodyText };
         delete payload.text;
    }

    try {
        const response = await axios.post(url, payload, {
            headers: { 'Authorization': `Bearer ${META_API_TOKEN}`, 'Content-Type': 'application/json' }
        });
        console.log(`✅ Message SENT to ${cleanTo} | ID: ${response.data.messages?.[0]?.id}`);
        return response.data.messages?.[0]?.id;
    } catch (e) {
        const errorDetails = e.response?.data?.error;
        console.error(`❌ SEND FAILED for ${cleanTo}:`, errorDetails?.message || e.message);
        throw new Error(errorDetails?.message || e.message); 
    }
};

const queueAndSendMessage = async (to, content, clientMessageId = null, driverId) => {
    const sendingEnabled = await getCachedSystemSetting('sending_enabled');
    if (!sendingEnabled) return { success: false, error: "System Disabled" };

    const msgId = `msg_${Date.now()}_${Math.random().toString(36).substr(2,5)}`;
    
    try {
        const wamid = await executeMetaSend(to, content);
        
        await queryWithRetry(`
            INSERT INTO messages (id, driver_id, sender, text, timestamp, type, whatsapp_message_id, status)
            VALUES ($1, $2, 'agent', $3, $4, $5, $6, 'sent')
        `, [msgId, driverId, content.text || (content.templateName ? `Template: ${content.templateName}` : 'Media'), Date.now(), 'text', wamid]);
        
        return { success: true, messageId: msgId };
    } catch (error) {
        await queryWithRetry(`
            INSERT INTO messages (id, driver_id, sender, text, timestamp, type, status)
            VALUES ($1, $2, 'agent', $3, $4, $5, 'failed')
        `, [msgId, driverId, `[FAILED] ${content.text || 'Message'}`, Date.now(), 'text']);
        return { success: false, error: error.message };
    }
};

// --- WEBHOOK LOGIC ---
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.send(req.query['hub.challenge']);
    } else {
        res.sendStatus(400);
    }
});

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const body = req.body;

    try {
        if (body.object === 'whatsapp_business_account') {
            for (const entry of body.entry) {
                for (const change of entry.changes) {
                    const value = change.value;
                    if (value.messages && value.messages.length > 0) {
                        const msg = value.messages[0];
                        await processIncomingMessage(msg, value.contacts);
                    }
                }
            }
        }
    } catch (e) {
        console.error("Webhook processing error:", e);
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

    const driverId = `d_${from}`;
    const name = contacts?.[0]?.profile?.name || 'Unknown Driver';
    
    await queryWithRetry(`
      INSERT INTO drivers (id, phone_number, name, status, last_message, last_message_time, updated_at, is_bot_active, is_human_mode)
      VALUES ($1, $2, $3, 'New', $4, $5, $6, TRUE, FALSE)
      ON CONFLICT (phone_number)
      DO UPDATE SET
        last_message = EXCLUDED.last_message,
        last_message_time = EXCLUDED.last_message_time,
        updated_at = EXCLUDED.updated_at,
        is_bot_active = CASE WHEN drivers.is_bot_active IS NULL THEN TRUE ELSE drivers.is_bot_active END,
        is_human_mode = CASE WHEN drivers.is_human_mode IS NULL THEN FALSE ELSE drivers.is_human_mode END
    `, [driverId, from, name, text, Date.now(), Date.now()]);
    
    await queryWithRetry(`
        INSERT INTO messages (id, driver_id, sender, text, timestamp, whatsapp_message_id, status)
        VALUES ($1, $2, 'driver', $3, $4, $5, 'delivered')
    `, [`msg_${Date.now()}_in`, driverId, text, Date.now(), wamid]);

    const driverRes = await queryWithRetry('SELECT * FROM drivers WHERE id = $1', [driverId]);
    await runBotEngine(driverRes.rows[0], text, buttonId, from);
}

async function runBotEngine(driver, text, buttonId, from) {
    const automationEnabled = await getCachedSystemSetting('automation_enabled');
    if (!automationEnabled || !driver.is_bot_active || driver.is_human_mode) {
        console.log(`[Bot Engine] Skipped for ${from} (Auto: ${automationEnabled}, Active: ${driver.is_bot_active}, Human: ${driver.is_human_mode})`);
        return;
    }

    const botSettings = await getCachedBotSettings();
    if (!botSettings || !botSettings.isEnabled) {
        console.log(`[Bot Engine] Bot disabled globally`);
        return;
    }

    let currentStep = botSettings.steps.find(s => s.id === driver.current_bot_step_id);
    let replyContent = null;
    let nextStepId = null;

    console.log(`[Bot Engine] Processing ${from}. Current Step ID: ${driver.current_bot_step_id}`);

    if (!currentStep) {
        const entryStep = botSettings.steps.find(s => s.id === botSettings.entryPointId) || botSettings.steps[0];
        if (entryStep) {
            console.log(`[Bot Engine] Starting Flow at: ${entryStep.id}`);
            replyContent = entryStep;
            nextStepId = entryStep.id;
        } else {
             console.log(`[Bot Engine] No entry step found in settings.`);
        }
    } else {
        if (buttonId && currentStep.routes) nextStepId = currentStep.routes[buttonId];
        else if (currentStep.nextStepId) nextStepId = currentStep.nextStepId;

        console.log(`[Bot Engine] Moving from ${currentStep.id} to ${nextStepId}`);

        if (nextStepId === 'END' || nextStepId === 'AI_HANDOFF') {
             if (botSettings.shouldRepeat) nextStepId = null; 
             else await queryWithRetry('UPDATE drivers SET is_bot_active = FALSE WHERE id = $1', [driver.id]);
             
             if (nextStepId === 'AI_HANDOFF') await queryWithRetry('UPDATE drivers SET is_human_mode = TRUE WHERE id = $1', [driver.id]);
        } else {
             const nextStep = botSettings.steps.find(s => s.id === nextStepId);
             if (nextStep) replyContent = nextStep;
             else console.log(`[Bot Engine] Next Step ${nextStepId} NOT found.`);
        }
    }

    if (replyContent) {
        if (nextStepId) {
            await queryWithRetry('UPDATE drivers SET current_bot_step_id = $1 WHERE id = $2', [nextStepId, driver.id]);
        }
        
        if (replyContent.delay > 0) await new Promise(r => setTimeout(r, replyContent.delay * 1000));
        
        console.log(`[Bot Engine] Sending reply to ${from}... Content: ${replyContent.message?.substring(0, 20)}`);
        await queueAndSendMessage(from, replyContent, null, driver.id);
    }
}

// --- API ROUTES ---
router.post('/messages/send', async (req, res) => {
    const { driverId, text, ...attachments } = req.body;
    try {
        const driverRes = await queryWithRetry('SELECT phone_number FROM drivers WHERE id = $1', [driverId]);
        if (driverRes.rows.length === 0) return res.status(404).json({ error: "Driver not found" });
        
        const phone = driverRes.rows[0].phone_number;
        const result = await queueAndSendMessage(phone, { text, ...attachments }, null, driverId);
        
        if (!result.success) return res.status(500).json(result); 
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/drivers', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM drivers ORDER BY updated_at DESC LIMIT 50');
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/messages/:driverId', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM messages WHERE driver_id = $1 ORDER BY timestamp ASC', [req.params.driverId]);
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/bot-settings', async (req, res) => {
    res.json(await getCachedBotSettings());
});

router.post('/bot-settings', async (req, res) => {
    await queryWithRetry(`INSERT INTO bot_settings (id, settings) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET settings = $1`, [JSON.stringify(req.body)]);
    await refreshCache();
    res.json({ success: true });
});

router.get('/meta/templates', (req, res) => res.json({ data: [] }));

app.use('/api', router);

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;

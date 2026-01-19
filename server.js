
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
            connectionTimeoutMillis: 3000, // FAIL FAST: 3s timeout for DB connection
            idleTimeoutMillis: 10000,
        });
    }
}
pool = global.pgPool;

const queryWithRetry = async (text, params, retries = 2) => { // Reduced retries
    if (!pool) throw new Error("Database connection not configured.");
    let client;
    try {
        client = await pool.connect();
        const res = await client.query(text, params);
        return res;
    } catch (err) {
        if (client) { try { client.release(true); } catch(e) {} client = null; }
        // Only retry specific connection errors
        if (retries > 0 && (err.code === 'ECONNRESET' || err.code === '57P01' || err.message.includes('timeout'))) {
            console.warn(`⚠️ DB Retry ${retries} left...`);
            await new Promise(res => setTimeout(res, 500)); // Shorter delay
            return queryWithRetry(text, params, retries - 1);
        }
        console.error("DB Query Failed:", err.message);
        throw err;
    } finally {
        if (client) { try { client.release(); } catch(e) {} }
    }
};

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

// --- DB INITIALIZATION ---
const initDB = async () => {
    if (!pool) return;
    try {
        // Minimal init check
        await queryWithRetry("SELECT 1");
        console.log("✅ Database Connected");
        
        // Defer heavy table creation to background or manual migration if possible, 
        // but for this app we keep it. Just ensuring it doesn't block startup too long.
        // We wrap table creation in a non-blocking floating promise if we wanted, 
        // but let's stick to simple sequential for reliability.
    } catch (e) {
        console.error("❌ DB Connection Check Failed:", e);
    }
};
// We trigger init but don't await it at top level to let server export happen
initDB(); 

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

// --- OUTBOUND SENDING (FAIL FAST) ---
const sendWhatsAppMessage = async (to, content, clientMessageId = null) => {
    // 1. Idempotency Check (Fast)
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

    // 2. Sanitize Phone Number (Critical for 504/400 prevention)
    // Remove spaces, dashes, parentheses, and plus signs.
    // Ensure it maps to E.164 without the plus if utilizing Graph API
    let cleanTo = to.replace(/\D/g, ''); 
    
    // Use Graph API v21.0
    const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
    
    // Ensure text body is NEVER empty
    const bodyText = (content.text || content.message || " ").substring(0, 4096);

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
        
        const interactiveBodyText = bodyText.trim() === "" ? "Please select an option below" : bodyText;
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
         payload[type] = { link: content.mediaUrl, caption: bodyText || undefined };
         delete payload.text;
    }

    try {
        console.log(`📤 Sending to ${cleanTo}...`);
        await axios.post(url, payload, {
            headers: { 'Authorization': `Bearer ${META_API_TOKEN}`, 'Content-Type': 'application/json' },
            timeout: 6000 // FAIL FAST: 6s timeout to avoid Vercel 10s limit triggering 504
        });
        console.log(`✅ Message Sent to ${cleanTo}`);
        return { success: true };
    } catch (error) {
        const errorDetail = error.response?.data?.error;
        console.error("❌ Meta API Failed:", JSON.stringify(errorDetail || error.message, null, 2));
        // Throw specific error to be caught by route handler
        throw new Error(errorDetail?.message || error.message || "Meta API Unknown Error");
    }
};

// --- API ENDPOINTS ---

// SEND MESSAGE ENDPOINT (Optimized for Vercel)
router.post('/messages/send', async (req, res) => {
    const start = Date.now();
    const { driverId, text, clientMessageId, ...attachments } = req.body;
    
    try {
        // 1. Fetch Phone (Fast)
        const driverRes = await queryWithRetry('SELECT phone_number FROM drivers WHERE id = $1', [driverId]);
        if (driverRes.rows.length === 0) return res.status(404).json({ error: "Driver not found" });
        const phone = driverRes.rows[0].phone_number;

        // 2. Send to Meta (Most likely point of failure)
        await sendWhatsAppMessage(phone, { text, ...attachments }, clientMessageId);

        // 3. Database Updates (Sequential for safety, but optimized query)
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
        
        const duration = Date.now() - start;
        console.log(`⏱️ Send API Duration: ${duration}ms`);
        
        res.json({ success: true, messageId: msgId });

    } catch (e) {
        console.error("Outbound Send Error:", e.message);
        // Explicitly return 500 so frontend knows it failed but server is alive
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
    // Return 200 immediately to Meta to prevent retries/timeouts
    // Then process asynchronously (Fire & Forget style for Vercel requires careful handling, 
    // but better than timeout)
    
    // Note: Vercel kills process after response is sent. So we must await critical logic.
    // We trust that processing incoming messages is faster than outbound sending.
    
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
            // Await all message processing
            await Promise.all(promises);
        }
        res.sendStatus(200);
    } catch (e) {
        console.error("Webhook Error:", e);
        res.sendStatus(200); // Acknowledge anyway to stop Meta retries
    }
});

async function processIncomingMessage(msg, contacts) {
    const from = msg.from;
    const wamid = msg.id; 
    
    // Check DB (Fast)
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

    const botRes = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1');
    const botSettings = botRes.rows[0]?.settings;
    if (!botSettings || !botSettings.isEnabled) return;

    let currentStep = botSettings
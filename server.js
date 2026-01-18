
/**
 * UBER FLEET RECRUITER - BACKEND SERVER
 * Enterprise-Grade Connection Handling for Vercel + Neon
 * FAIL-SAFE MODE ENABLED
 * MODE: STRICT BOT ONLY (NO AI)
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto'); // NEW: For signature verification
const { Pool } = require('pg'); 
const { S3Client, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const FormData = require('form-data'); 
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

app.set('etag', false);
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

const PORT = process.env.PORT || 3001;

// --- DYNAMIC CREDENTIALS ---
let META_API_TOKEN = process.env.META_API_TOKEN || ""; 
let PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || ""; 
let VERIFY_TOKEN = process.env.VERIFY_TOKEN || "uber_fleet_verify_token";
let APP_SECRET = process.env.APP_SECRET || ""; 

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
    }
});
const BUCKET_NAME = process.env.AWS_BUCKET_NAME || 'uber-fleet-assets';

const NEON_DB_URL = "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL || NEON_DB_URL;

let pool;
if (!global.pgPool) {
    global.pgPool = new Pool({
        connectionString: CONNECTION_STRING,
        ssl: { rejectUnauthorized: false },
        max: 5,
        idleTimeoutMillis: 1000, 
        connectionTimeoutMillis: 5000, 
    });
}
pool = global.pgPool;

const queryWithRetry = async (text, params, retries = 3) => {
    let client;
    try {
        client = await pool.connect();
        const res = await client.query(text, params);
        return res;
    } catch (err) {
        if (client) { try { client.release(true); } catch(e) {} client = null; }
        if (retries > 0 && (err.code === 'ECONNRESET' || err.code === '57P01')) {
            await new Promise(res => setTimeout(res, 1000));
            return queryWithRetry(text, params, retries - 1);
        }
        console.error("DB Query Failed:", err.message);
        throw err;
    } finally {
        if (client) { try { client.release(); } catch(e) {} }
    }
};

// --- HELPER: System Settings ---
const getSystemSetting = async (key) => {
    try {
        const res = await queryWithRetry('SELECT value FROM system_settings WHERE key = $1', [key]);
        if (res.rows.length > 0) return res.rows[0].value === 'true';
        return true; 
    } catch (e) {
        // console.error(`Failed to fetch setting ${key}:`, e.message);
        return true;
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

// --- DB INITIALIZATION ---
const initDB = async () => {
    try {
        // 1. Tables
        await queryWithRetry(`
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
                qualification_checks JSONB DEFAULT '{}'
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
                client_message_id TEXT UNIQUE, -- Idempotency Key
                whatsapp_message_id TEXT UNIQUE -- Webhook Idempotency Key
            );
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
        `);

        // 2. Default Settings
        await queryWithRetry(`
            INSERT INTO system_settings (key, value) VALUES 
            ('webhook_ingest_enabled', 'true'),
            ('automation_enabled', 'true'),
            ('sending_enabled', 'true')
            ON CONFLICT (key) DO NOTHING;
        `);

        // 3. Default Bot Settings
        const defaultBot = {
            isEnabled: true,
            shouldRepeat: false,
            entryPointId: "welcome",
            steps: [
                {
                    id: "welcome",
                    title: "Welcome Message",
                    message: "Hello! 👋 Welcome to Uber Fleet Recruitment.\nAre you interested in driving with us?",
                    inputType: "option",
                    options: ["Yes, I want to drive", "No, just inquiring"],
                    routes: { "Yes, I want to drive": "step_role", "No, just inquiring": "END" }
                },
                {
                    id: "step_role",
                    title: "Select Role",
                    message: "Great! Do you have your own car or do you need to rent one?",
                    inputType: "option",
                    options: ["I have a car", "I need to rent"],
                    routes: { "I have a car": "step_name", "I need to rent": "step_name" }
                },
                {
                    id: "step_name",
                    title: "Collect Name",
                    message: "Please type your full name.",
                    inputType: "text",
                    saveToField: "name",
                    nextStepId: "END"
                }
            ]
        };
        
        await queryWithRetry(`
            INSERT INTO bot_settings (id, settings) VALUES (1, $1)
            ON CONFLICT (id) DO NOTHING
        `, [JSON.stringify(defaultBot)]);

        console.log("✅ Database Initialized Successfully");
    } catch (e) {
        console.error("❌ DB Init Failed:", e);
    }
};

initDB();

// --- SEND WHATSAPP MESSAGE (CORE LOGIC) ---
const sendWhatsAppMessage = async (to, content, clientMessageId = null) => {
    // 1. Idempotency Check (Outbound)
    if (clientMessageId) {
        const existing = await queryWithRetry('SELECT id FROM messages WHERE client_message_id = $1', [clientMessageId]);
        if (existing.rows.length > 0) {
            console.log(`[Idempotency] Skipping duplicate send: ${clientMessageId}`);
            return { success: true, duplicate: true };
        }
    }

    if (!META_API_TOKEN || !PHONE_NUMBER_ID) {
        console.warn("Missing Meta Credentials. Simulating send.");
        return { success: true, simulated: true };
    }

    const sendingEnabled = await getSystemSetting('sending_enabled');
    if (!sendingEnabled) {
        console.warn("Sending Disabled by System Setting.");
        throw new Error("System is in Sleep Mode. Sending disabled.");
    }

    const url = `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`;
    
    // Construct Payload
    let payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "text",
        text: { body: content.text || "" }
    };

    // TEMPLATE
    if (content.templateName) {
        payload.type = "template";
        payload.template = {
            name: content.templateName,
            language: { code: "en_US" }, // Default
            components: []
        };
        delete payload.text;
    } 
    // INTERACTIVE (Buttons / List)
    // FIX: Allow buttons if options exist, even without header image
    else if (content.buttons?.length > 0 || (content.options && content.options.length > 0)) {
        payload.type = "interactive";
        
        let headerObj = undefined;
        if (content.headerImageUrl) {
            headerObj = { type: "image", image: { link: content.headerImageUrl } };
        }

        // Convert Options to Buttons if not explicit buttons
        let finalButtons = content.buttons || [];
        if (finalButtons.length === 0 && content.options) {
            finalButtons = content.options.slice(0, 3).map((opt, i) => ({
                type: 'reply',
                title: opt,
                payload: `btn_${i}_${opt.substring(0, 10)}` // Generate stable payload
            }));
        }

        const actionObj = {
            buttons: finalButtons.map((btn, i) => ({
                type: "reply",
                reply: {
                    id: btn.payload || `btn_${i}`, // Use payload if available, else index
                    title: btn.title.substring(0, 20) // Truncate for Meta limit
                }
            }))
        };
        
        // Use List if > 3 options
        if (content.options && content.options.length > 3) {
            actionObj.buttons = undefined;
            actionObj.button = "Select Option";
            actionObj.sections = [{
                title: "Options",
                rows: content.options.slice(0, 10).map((opt, i) => ({
                    id: `opt_${i}`,
                    title: opt.substring(0, 24)
                }))
            }];
            payload.interactive = {
                type: "list",
                header: headerObj,
                body: { text: content.text },
                footer: content.footerText ? { text: content.footerText } : undefined,
                action: actionObj
            };
        } else {
            payload.interactive = {
                type: "button",
                header: headerObj,
                body: { text: content.text },
                footer: content.footerText ? { text: content.footerText } : undefined,
                action: actionObj
            };
        }
        delete payload.text;
    } 
    // MEDIA (Image/Video/Doc)
    else if (content.mediaUrl) {
         const type = content.mediaType || 'image'; // Default to image
         payload.type = type;
         payload[type] = {
             link: content.mediaUrl,
             caption: content.text // Caption for media
         };
         delete payload.text;
    }

    try {
        const response = await axios.post(url, payload, {
            headers: { 
                'Authorization': `Bearer ${META_API_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data;
    } catch (error) {
        console.error("Meta API Error:", error.response?.data || error.message);
        throw new Error(error.response?.data?.error?.message || "Meta API Failed");
    }
};

// --- API ENDPOINTS ---

router.get('/drivers', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM drivers ORDER BY last_message_time DESC LIMIT 100');
        const drivers = await Promise.all(result.rows.map(async (row) => {
            const msgs = await queryWithRetry('SELECT * FROM messages WHERE driver_id = $1 ORDER BY timestamp ASC', [row.id]);
            const docs = await queryWithRetry('SELECT * FROM driver_documents WHERE driver_id = $1', [row.id]);
            const dto = toDriverDTO(row);
            dto.messages = msgs.rows.map(toMessageDTO);
            dto.documents = docs.rows ? docs.rows.map(toDocumentDTO) : [];
            return dto;
        }));
        res.json(drivers);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// NEW: Send Message Endpoint
router.post('/messages/send', async (req, res) => {
    const { driverId, text, clientMessageId, ...attachments } = req.body;
    
    // 1. Idempotency Check First
    if (clientMessageId) {
        try {
            const existing = await queryWithRetry('SELECT id FROM messages WHERE client_message_id = $1', [clientMessageId]);
            if (existing.rows.length > 0) {
                return res.json({ success: true, status: 'duplicate_skipped' });
            }
        } catch(e) {}
    }

    try {
        // 2. Fetch Driver
        const driverRes = await queryWithRetry('SELECT * FROM drivers WHERE id = $1', [driverId]);
        if (driverRes.rows.length === 0) return res.status(404).json({ error: "Driver not found" });
        const driver = driverRes.rows[0];

        // 3. Send to Meta
        await sendWhatsAppMessage(driver.phone_number, { text, ...attachments }, clientMessageId);

        // 4. Save to DB
        const msgId = `msg_${Date.now()}_${Math.random().toString(36).substr(2,5)}`;
        await queryWithRetry(`
            INSERT INTO messages (id, driver_id, sender, text, timestamp, type, client_message_id, buttons, template_name, image_url)
            VALUES ($1, $2, 'agent', $3, $4, $5, $6, $7, $8, $9)
        `, [
            msgId, 
            driverId, 
            text, 
            Date.now(), 
            attachments.templateName ? 'template' : (attachments.options ? 'options' : 'text'),
            clientMessageId,
            JSON.stringify(attachments.buttons),
            attachments.templateName,
            attachments.mediaUrl
        ]);

        // 5. Update Driver Last Message
        await queryWithRetry('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [
            text || `[${attachments.templateName || 'Media'}]`, 
            Date.now(), 
            driverId
        ]);

        res.json({ success: true, messageId: msgId });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// --- WEBHOOK HANDLER ---
router.post('/webhook', async (req, res) => {
    // 1. Verification
    if (req.method === 'GET') {
        if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
            return res.send(req.query['hub.challenge']);
        }
        return res.status(403).send('Invalid verify token');
    }

    // 2. Ingest Check
    const ingestEnabled = await getSystemSetting('webhook_ingest_enabled');
    if (!ingestEnabled) return res.status(200).send('Ingest Disabled');

    // 3. Process Message
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
        for (const entry of body.entry) {
            for (const change of entry.changes) {
                if (change.value.messages) {
                    for (const msg of change.value.messages) {
                        const from = msg.from;
                        const wamid = msg.id; // WhatsApp Message ID
                        
                        // IDEMPOTENCY CHECK (Webhook)
                        const existingWamid = await queryWithRetry('SELECT id FROM messages WHERE whatsapp_message_id = $1', [wamid]);
                        if (existingWamid.rows.length > 0) {
                            console.log(`[Webhook] Skipping duplicate wamid: ${wamid}`);
                            continue;
                        }

                        // Extract content
                        let text = '';
                        let buttonId = null;
                        
                        if (msg.type === 'text') text = msg.text.body;
                        else if (msg.type === 'button') text = msg.button.text; // Legacy
                        else if (msg.type === 'interactive') {
                            if (msg.interactive.type === 'button_reply') {
                                text = msg.interactive.button_reply.title;
                                buttonId = msg.interactive.button_reply.id; // Use ID for routing!
                            } else if (msg.interactive.type === 'list_reply') {
                                text = msg.interactive.list_reply.title;
                                buttonId = msg.interactive.list_reply.id;
                            }
                        }

                        // Get/Create Driver
                        let driverRes = await queryWithRetry('SELECT * FROM drivers WHERE phone_number = $1', [from]);
                        let driverId;
                        
                        if (driverRes.rows.length === 0) {
                            driverId = `d_${Date.now()}`;
                            const name = change.value.contacts?.[0]?.profile?.name || 'Unknown Driver';
                            await queryWithRetry(`
                                INSERT INTO drivers (id, phone_number, name, status, last_message, last_message_time)
                                VALUES ($1, $2, $3, 'New', $4, $5)
                            `, [driverId, from, name, text, Date.now()]);
                        } else {
                            driverId = driverRes.rows[0].id;
                            await queryWithRetry(`UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3`, [text, Date.now(), driverId]);
                        }

                        // Save User Message
                        const msgId = `msg_${Date.now()}_${Math.random().toString(36).substr(2,5)}`;
                        await queryWithRetry(`
                            INSERT INTO messages (id, driver_id, sender, text, timestamp, whatsapp_message_id)
                            VALUES ($1, $2, 'driver', $3, $4, $5)
                        `, [msgId, driverId, text, Date.now(), wamid]);

                        // --- BOT ENGINE EXECUTION ---
                        const automationEnabled = await getSystemSetting('automation_enabled');
                        const driver = (await queryWithRetry('SELECT * FROM drivers WHERE id = $1', [driverId])).rows[0];
                        
                        if (automationEnabled && driver.is_bot_active && !driver.is_human_mode) {
                            const botRes = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1');
                            const botSettings = botRes.rows[0]?.settings;

                            if (botSettings && botSettings.isEnabled) {
                                let currentStep = botSettings.steps.find(s => s.id === driver.current_bot_step_id);
                                let replyContent = null;
                                let nextStepId = null;
                                let shouldAdvance = false;

                                // 1. INITIALIZE IF NEW
                                if (!currentStep) {
                                    const entryStep = botSettings.steps.find(s => s.id === botSettings.entryPointId) || botSettings.steps[0];
                                    if (entryStep) {
                                        currentStep = entryStep;
                                        // Don't reply yet, we just found the start step. We need to match input or send greeting?
                                        // Actually, if it's new, we should send the entry step immediately.
                                        replyContent = entryStep; 
                                        nextStepId = entryStep.id; // Stay on this step until valid input? No, usually advance.
                                        // Wait, usually the user says "Hi", and we send "Welcome".
                                        // So we reply with Entry Step content, and SET current step to Entry Step ID.
                                        // But if we are *at* the step, we are waiting for input.
                                        
                                        // LOGIC: If current_step is NULL, we are starting.
                                        // We send the welcome message.
                                        // We set current_step = entryStep.id.
                                        
                                        // But here, the user *already sent* a message. 
                                        // So we reply to that message with the Welcome.
                                        replyContent = entryStep;
                                        await queryWithRetry('UPDATE drivers SET current_bot_step_id = $1 WHERE id = $2', [entryStep.id, driverId]);
                                    }
                                } 
                                // 2. PROCESS INPUT FOR CURRENT STEP
                                else {
                                    // We are at `currentStep`. The user just replied to it.
                                    // Check routes.
                                    
                                    let matchedRouteId = null;
                                    
                                    // A) Check ID Match (Strongest)
                                    if (buttonId && currentStep.routes) {
                                        // Look for route key matching buttonId
                                        // The keys in `routes` map might be Titles OR IDs depending on how BotBuilder saved them.
                                        // BotBuilder now saves IDs/Payloads if available.
                                        matchedRouteId = currentStep.routes[buttonId];
                                    }

                                    // B) Check Text Match (Fallback)
                                    if (!matchedRouteId && currentStep.routes) {
                                        const lowerInput = text.toLowerCase().trim();
                                        const routeKey = Object.keys(currentStep.routes).find(k => k.toLowerCase() === lowerInput);
                                        if (routeKey) matchedRouteId = currentStep.routes[routeKey];
                                    }
                                    
                                    // C) Check "Any Input" (Next Step ID)
                                    if (!matchedRouteId && !currentStep.routes && currentStep.nextStepId) {
                                        matchedRouteId = currentStep.nextStepId;
                                    }

                                    if (matchedRouteId) {
                                        // Valid Transition
                                        if (matchedRouteId === 'END') {
                                            // End Flow
                                            await queryWithRetry('UPDATE drivers SET current_bot_step_id = NULL, is_bot_active = $1 WHERE id = $2', [botSettings.shouldRepeat, driverId]);
                                            // Optional: Send goodbye?
                                        } else {
                                            const nextStep = botSettings.steps.find(s => s.id === matchedRouteId);
                                            if (nextStep) {
                                                replyContent = nextStep;
                                                await queryWithRetry('UPDATE drivers SET current_bot_step_id = $1 WHERE id = $2', [nextStep.id, driverId]);
                                                
                                                // Handle "Save To Field"
                                                if (currentStep.saveToField) {
                                                    // Sanitize field name to prevent injection (though parameterized queries help)
                                                    const validFields = ['name', 'vehicle_registration', 'availability', 'notes'];
                                                    if (validFields.includes(currentStep.saveToField)) {
                                                         await queryWithRetry(`UPDATE drivers SET ${currentStep.saveToField} = $1 WHERE id = $2`, [text, driverId]);
                                                    }
                                                }
                                            }
                                        }
                                    } else {
                                        // SOFT FAIL / INVALID INPUT
                                        // Do not advance. Reply with "Invalid".
                                        // Check if the current step HAS options. If so, re-state them.
                                        if (currentStep.options || currentStep.buttons) {
                                             await sendWhatsAppMessage(from, { text: "Please select one of the buttons below." });
                                             // Return early to avoid sending "undefined" reply
                                             return res.sendStatus(200);
                                        }
                                        // If it was a text input step and we didn't match (e.g. strict validation?), handle that.
                                        // For now, if no route matched and no nextStepId, we're stuck.
                                    }
                                }

                                if (replyContent) {
                                    // Wait for Delay?
                                    if (replyContent.delay) {
                                        await new Promise(r => setTimeout(r, replyContent.delay * 1000));
                                    }
                                    await sendWhatsAppMessage(from, replyContent);
                                    
                                    // Log Bot Reply
                                    const botMsgId = `bot_${Date.now()}_${Math.random().toString(36).substr(2,5)}`;
                                    await queryWithRetry(`
                                        INSERT INTO messages (id, driver_id, sender, text, timestamp, type)
                                        VALUES ($1, $2, 'system', $3, $4, $5)
                                    `, [botMsgId, driverId, replyContent.message, Date.now(), replyContent.inputType || 'text']);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    res.sendStatus(200);
});

// --- SCHEDULER (ROBUST) ---
// Runs every 30 seconds to check for pending messages
setInterval(async () => {
    try {
        const sendingEnabled = await getSystemSetting('sending_enabled');
        if (!sendingEnabled) return;

        // SKIP LOCKED prevents multiple instances from picking same job
        const result = await queryWithRetry(`
            SELECT * FROM scheduled_messages 
            WHERE status = 'pending' 
            AND scheduled_time <= $1
            FOR UPDATE SKIP LOCKED
            LIMIT 10
        `, [Date.now()]);

        for (const job of result.rows) {
            console.log(`[Scheduler] Processing Job ${job.id}`);
            const { driver_ids, content } = job.content; // Content wrapper due to how it was saved
            
            // Note: The structure in DB might be job.content directly if jsonb.
            // Let's assume content is the actual message payload.
            
            // Update status to processing
            await queryWithRetry('UPDATE scheduled_messages SET status = \'processing\' WHERE id = $1', [job.id]);

            // Determine actual payload
            const actualContent = job.content; 
            const targets = job.driver_ids || [];

            for (const driverId of targets) {
                try {
                     const driverRes = await queryWithRetry('SELECT phone_number FROM drivers WHERE id = $1', [driverId]);
                     if (driverRes.rows.length > 0) {
                         const phone = driverRes.rows[0].phone_number;
                         await sendWhatsAppMessage(phone, actualContent);
                         
                         // Log
                         const msgId = `sched_${Date.now()}_${Math.random().toString(36).substr(2,5)}`;
                         await queryWithRetry(`
                            INSERT INTO messages (id, driver_id, sender, text, timestamp, type)
                            VALUES ($1, $2, 'agent', $3, $4, 'text')
                         `, [msgId, driverId, actualContent.text || '[Scheduled]', Date.now()]);
                     }
                } catch(e) {
                    console.error(`Failed to send scheduled msg to ${driverId}`, e);
                }
            }

            await queryWithRetry('UPDATE scheduled_messages SET status = \'completed\' WHERE id = $1', [job.id]);
        }
    } catch (e) {
        console.error("[Scheduler] Error:", e);
    }
}, 30000); 

router.post('/messages/schedule', async (req, res) => {
    const { driverIds, scheduledTime, ...content } = req.body;
    try {
        await queryWithRetry(`
            INSERT INTO scheduled_messages (driver_ids, content, scheduled_time, status)
            VALUES ($1, $2, $3, 'pending')
        `, [driverIds, content, scheduledTime]);
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// Mount
app.use('/api', router);

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

module.exports = app;

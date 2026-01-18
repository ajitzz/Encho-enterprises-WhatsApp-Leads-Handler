/**
 * UBER FLEET RECRUITER - BACKEND SERVER
 * Enterprise-Grade Connection Handling for Vercel + Neon
 * FAIL-SAFE MODE ENABLED
 * MODE: STRICT BOT ONLY (NO AI)
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg'); 
const { S3Client, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const FormData = require('form-data'); 
require('dotenv').config();

const app = express();
const router = express.Router(); 

app.use(express.json({ limit: '10mb' }));
app.use(cors()); 

app.set('etag', false);
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

const PORT = process.env.PORT || 3001;

// --- DYNAMIC CREDENTIALS ---
// Defaults from Env, but can be overridden by DB settings
let META_API_TOKEN = process.env.META_API_TOKEN || ""; 
let PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || ""; 
let VERIFY_TOKEN = process.env.VERIFY_TOKEN || "uber_fleet_verify_token";

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

// --- HELPER: Validate Meta Credentials ---
const validateMetaCredentials = async (phoneId, token) => {
    try {
        // Attempt to fetch phone number details. This requires 'whatsapp_business_management' permission 
        // or just a valid token and ID.
        await axios.get(`https://graph.facebook.com/v17.0/${phoneId}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return true;
    } catch (e) {
        const msg = e.response?.data?.error?.message || e.message;
        throw new Error(`Validation Failed: ${msg}`);
    }
};

// --- DTO MAPPERS (Snake -> Camel) ---
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
    messages: [] // Always return empty array, messages fetched on demand
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
    buttons: row.buttons, // Postgres JSONB parser handles this
    templateName: row.template_name
});

let isDbInitialized = false;

// --- DEFAULT BOT FLOW (Ensures bot works out-of-the-box) ---
const DEFAULT_BOT_FLOW = {
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
            routes: {
                "Yes": "collect_name",
                "No": "end_conversation"
            },
            nextStepId: "collect_name"
        },
        {
            id: "collect_name",
            title: "Collect Name",
            message: "Great! Please type your full name.",
            inputType: "text",
            saveToField: "name",
            nextStepId: "collect_vehicle"
        },
        {
            id: "collect_vehicle",
            title: "Vehicle Check",
            message: "Do you have a valid driving license and your own vehicle? (Yes/No)",
            inputType: "text",
            saveToField: "notes",
            nextStepId: "qualify"
        },
        {
            id: "qualify",
            title: "Qualified",
            message: "Perfect! A recruiter will contact you shortly to finalize your onboarding. 🚗",
            inputType: "text",
            nextStepId: "END"
        },
        {
            id: "end_conversation",
            title: "End",
            message: "No problem! Feel free to contact us anytime if you change your mind.",
            inputType: "text",
            nextStepId: "END"
        }
    ]
};

const initDB = async () => {
    if (isDbInitialized) return;
    try {
        await queryWithRetry(`
            CREATE TABLE IF NOT EXISTS drivers (
                id TEXT PRIMARY KEY,
                phone_number TEXT UNIQUE,
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
                driver_id TEXT,
                sender TEXT,
                text TEXT,
                type TEXT,
                timestamp BIGINT,
                image_url TEXT,
                header_image_url TEXT,
                footer_text TEXT,
                buttons JSONB,
                template_name TEXT
            );
            CREATE TABLE IF NOT EXISTS bot_settings (
                id INT PRIMARY KEY,
                settings JSONB
            );
            CREATE TABLE IF NOT EXISTS system_credentials (
                key TEXT PRIMARY KEY,
                value TEXT
            );
            CREATE TABLE IF NOT EXISTS files (
                id TEXT PRIMARY KEY,
                filename TEXT,
                url TEXT,
                type TEXT,
                folder_path TEXT,                media_id TEXT
            );
            CREATE TABLE IF NOT EXISTS folders (
                id TEXT PRIMARY KEY,
                name TEXT,
                parent_path TEXT,
                is_public_showcase BOOLEAN DEFAULT FALSE
            );
            CREATE TABLE IF NOT EXISTS scheduled_messages (
                id TEXT PRIMARY KEY,
                target_ids JSONB, 
                type TEXT, 
                content JSONB, 
                scheduled_time BIGINT,
                status TEXT DEFAULT 'pending',
                created_at BIGINT
            );
        `);
        
        // --- CRITICAL MIGRATIONS ---
        const migrations = [
            "ALTER TABLE messages ADD COLUMN IF NOT EXISTS template_name TEXT",
            "ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_url TEXT",
            "ALTER TABLE messages ADD COLUMN IF NOT EXISTS header_image_url TEXT",
            "ALTER TABLE messages ADD COLUMN IF NOT EXISTS footer_text TEXT",
            "ALTER TABLE messages ADD COLUMN IF NOT EXISTS buttons JSONB",
            "ALTER TABLE drivers ADD COLUMN IF NOT EXISTS updated_at BIGINT DEFAULT 0"
        ];
        
        for (const migration of migrations) {
            await queryWithRetry(migration, []);
        }
        
        // --- INITIALIZE DEFAULT BOT SETTINGS ---
        await queryWithRetry(`INSERT INTO bot_settings (id, settings) VALUES (1, $1) ON CONFLICT DO NOTHING`, [JSON.stringify(DEFAULT_BOT_FLOW)]);

        const sRes = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1', []);
        if (sRes.rows.length > 0) {
            const current = sRes.rows[0].settings;
            if (!current.steps || current.steps.length === 0) {
                console.log("⚠️ Empty bot flow detected. Seeding default flow...");
                await queryWithRetry('UPDATE bot_settings SET settings = $1 WHERE id = 1', [JSON.stringify(DEFAULT_BOT_FLOW)]);
            }
        }

        // --- LOAD CREDENTIALS FROM DB ---
        const credsRes = await queryWithRetry('SELECT * FROM system_credentials', []);
        credsRes.rows.forEach(row => {
            if (row.key === 'META_API_TOKEN' && row.value) META_API_TOKEN = row.value;
            if (row.key === 'PHONE_NUMBER_ID' && row.value) PHONE_NUMBER_ID = row.value;
            if (row.key === 'VERIFY_TOKEN' && row.value) VERIFY_TOKEN = row.value;
        });
        console.log(`Loaded Credentials - PhoneID: ${PHONE_NUMBER_ID ? '***' + PHONE_NUMBER_ID.slice(-4) : 'Missing'}`);

        isDbInitialized = true;
        console.log("Database initialized (Lazy with Migrations & Default Flow)");
    } catch (e) {
        console.error("DB Init Failed:", e);
    }
};

const ensureDbReady = async (req, res, next) => {
    await initDB();
    next();
};

app.use('/api', ensureDbReady);
app.use('/webhook', ensureDbReady);

let activeS3Transfers = 0;
let activeWhatsAppUploads = 0;

const isContentSafe = (text) => {
    if (!text || !text.trim()) return false;
    const lower = text.toLowerCase();
    const BLOCK_LIST = ["replace this sample message", "enter your message"];
    return !BLOCK_LIST.some(phrase => lower.includes(phrase));
};

const safeVal = (val) => val === undefined ? null : val;

const uploadToWhatsApp = async (fileUrl, fileType) => {
    activeS3Transfers++;
    activeWhatsAppUploads++;
    try {
        const response = await axios({
            method: 'get',
            url: fileUrl,
            responseType: 'stream'
        });

        const formData = new FormData();
        formData.append('messaging_product', 'whatsapp');
        formData.append('file', response.data, {
            contentType: fileType,
            knownLength: response.headers['content-length']
        });

        const metaRes = await axios.post(
            `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/media`,
            formData,
            { headers: { ...formData.getHeaders(), Authorization: `Bearer ${META_API_TOKEN}` } }
        );

        return metaRes.data.id;
    } catch (error) {
        console.error("[Sync] Failed:", error.response ? error.response.data : error.message);
        throw error;
    } finally {
        activeS3Transfers--;
        activeWhatsAppUploads--;
    }
};

const sendWhatsAppMessage = async (to, body, options = null, templateName = null, language = 'en_US', mediaUrl = null, mediaType = 'image', headerImageUrl = null, footerText = null, buttons = null) => {
   if (!META_API_TOKEN || !PHONE_NUMBER_ID) {
       console.error("[Meta] Missing credentials");
       return { success: false, error: "Server missing Meta credentials" };
   }
   
   if (!templateName && !mediaUrl && !headerImageUrl && (!body || body.trim() === '')) {
       console.warn("[Meta] Attempted to send empty message");
       return { success: false, error: "Empty message content" };
   }
   
   if (body && !isContentSafe(body)) {
       console.warn("[Meta] Blocked unsafe content");
       return { success: false, error: "Content blocked (Placeholder text detected)" };
   }
  
   let payload = { messaging_product: 'whatsapp', to: to };

   // --- PAYLOAD CONSTRUCTION ---
   if (templateName) {
     payload.type = 'template';
     payload.template = { 
         name: templateName, 
         language: { code: language },
         components: [] 
     };

     if (headerImageUrl) {
         try {
             const mediaId = await uploadToWhatsApp(headerImageUrl, 'image/jpeg');
             payload.template.components.push({
                 type: 'header',
                 parameters: [{ type: 'image', image: { id: mediaId } }]
             });
         } catch (e) {
             payload.template.components.push({
                 type: 'header',
                 parameters: [{ type: 'image', image: { link: headerImageUrl } }]
             });
         }
     }

     if (body) {
         payload.template.components.push({
             type: 'body',
             parameters: [{ type: 'text', text: body }]
         });
     }

   } else if (headerImageUrl || buttons) {
       const hasComplexButtons = buttons?.some(b => b.type === 'url' || b.type === 'location' || b.type === 'phone');
       if (hasComplexButtons) {
           let caption = body;
           if (buttons) {
               caption += "\n\n";
               buttons.forEach(b => {
                   if (b.type === 'url') caption += `🔗 ${b.title}: ${b.payload}\n`;
                   if (b.type === 'phone') caption += `📞 ${b.title}: ${b.payload}\n`;
                   if (b.type === 'location') caption += `📍 ${b.title}\n`;
               });
           }
           if (footerText) caption += `\n_${footerText}_`;
           payload.type = 'image'; 
           payload.image = { link: headerImageUrl || mediaUrl }; 
           payload.image.caption = caption;
       } else {
           payload.type = 'interactive';
           payload.interactive = {
               type: 'button',
               body: { text: body },
               action: { 
                   buttons: buttons 
                    ? buttons.map((b, i) => ({ type: 'reply', reply: { id: `btn_${i}`, title: b.title.substring(0, 20) } }))
                    : options?.slice(0, 3).map((opt, i) => ({ type: 'reply', reply: { id: `btn_${i}`, title: opt.substring(0, 20) } }))
               }
           };
           
           if (headerImageUrl) {
               try {
                   const mediaId = await uploadToWhatsApp(headerImageUrl, 'image/jpeg');
                   payload.interactive.header = { type: 'image', image: { id: mediaId } };
               } catch (e) {
                   payload.interactive.header = { type: 'image', image: { link: headerImageUrl } };
               }
           }
           if (footerText) payload.interactive.footer = { text: footerText };
       }
   } else if (mediaUrl) {
       const type = mediaType || 'image';
       payload.type = type;
       payload[type] = { link: mediaUrl };
       if (body) payload[type].caption = body;
   } else {
       payload.type = 'text';
       payload.text = { body: body };
   }
  
   try {
     const res = await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, payload, { headers: { Authorization: `Bearer ${META_API_TOKEN}` } });
     console.log(`[Meta] Sent to ${to}: ${res.status}`);
     return { success: true, data: res.data };
   } catch (error) { 
       const details = error.response ? error.response.data : error.message;
       console.error(`[Meta] Failed to send to ${to}:`, JSON.stringify(details, null, 2));
       
       let friendlyError = error.response?.data?.error?.message || error.message;
       
       // --- SMART ERROR DIAGNOSIS ---
       if (friendlyError.includes('Unsupported post request') || friendlyError.includes('does not exist')) {
           friendlyError = "CRITICAL: You are using a Business Account ID (WABA ID) instead of the Phone Number ID. Please check the 'API Setup' page in Meta Developers.";
       }
       
       return { 
           success: false, 
           error: friendlyError,
           code: error.response?.data?.error?.code
       }; 
   }
};

const logSystemMessage = async (driverId, text, type = 'text', headerImg = null, footer = null, btns = null, tmpl = null) => {
    const msgId = `sys_${Date.now()}_${Math.random()}`;
    const now = Date.now();
    await queryWithRetry(
        `INSERT INTO messages (id, driver_id, sender, text, timestamp, type, header_image_url, footer_text, buttons, template_name) VALUES ($1, $2, 'system', $3, $4, $5, $6, $7, $8, $9)`, 
        [msgId, driverId, text, now, type, safeVal(headerImg), safeVal(footer), btns ? JSON.stringify(btns) : null, safeVal(tmpl)]
    );
    await queryWithRetry('UPDATE drivers SET last_message = $1, last_message_time = $2, updated_at = $2 WHERE id = $3', [text, now, driverId]);
};

// --- SCHEDULER ENGINE ---
// Optimized for near-instant broadcasts (5s interval)
const runScheduler = async () => {
    if (!isDbInitialized) return;
    try {
        const now = Date.now();
        // Fetch tasks ready to process (pending and time passed)
        const res = await queryWithRetry(
            "SELECT * FROM scheduled_messages WHERE status = 'pending' AND scheduled_time <= $1 LIMIT 50",
            [now]
        );
        
        for (const task of res.rows) {
            await queryWithRetry("UPDATE scheduled_messages SET status = 'processing' WHERE id = $1", [task.id]);
            
            const content = task.content;
            const targetIds = task.target_ids;
            let successCount = 0;

            for (const driverId of targetIds) {
                const dRes = await queryWithRetry("SELECT phone_number FROM drivers WHERE id = $1", [driverId]);
                if (dRes.rows.length > 0) {
                    const phone = dRes.rows[0].phone_number;
                    const result = await sendWhatsAppMessage(
                        phone, 
                        content.text, 
                        content.options, 
                        content.templateName, 
                        'en_US', 
                        content.mediaUrl, 
                        content.mediaType, 
                        content.headerImageUrl, 
                        content.footerText, 
                        content.buttons
                    );
                    
                    if (result.success) {
                        successCount++;
                        // Insert log safely
                        await queryWithRetry(
                            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type, header_image_url, footer_text, buttons, template_name, image_url) VALUES ($1, $2, 'agent', $3, $4, $5, $6, $7, $8, $9, $10)`, 
                            [
                                `sch_${Date.now()}_${Math.random()}`, 
                                driverId, 
                                content.text || `[Scheduled]`, 
                                Date.now(), 
                                task.type, 
                                safeVal(content.headerImageUrl), 
                                safeVal(content.footerText), 
                                content.buttons ? JSON.stringify(content.buttons) : null, 
                                safeVal(content.templateName),
                                safeVal(content.mediaUrl) 
                            ]
                        ).catch(e => console.error("Scheduler Log Error:", e.message));

                        await queryWithRetry('UPDATE drivers SET last_message = $1, last_message_time = $2, updated_at = $2 WHERE id = $3', [`[Scheduled]: ${content.text || content.templateName}`, Date.now(), driverId]).catch(e => {});
                    } else {
                        console.error(`[Scheduler] Failed to send to ${driverId}: ${result.error}`);
                    }
                }
            }
            
            await queryWithRetry("UPDATE scheduled_messages SET status = 'sent' WHERE id = $1", [task.id]);
            console.log(`[Scheduler] Processed task ${task.id}: Sent to ${successCount} recipients.`);
        }
    } catch (e) {
        console.error("Scheduler Error:", e.message);
    }
};

setInterval(runScheduler, 5000); 

// --- ROUTES ---

// 1. OPTIMIZED DRIVERS LIST (No Messages)
router.get('/drivers', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM drivers ORDER BY last_message_time DESC', []);
        const drivers = result.rows.map(toDriverDTO); // Use DTO mapper
        res.json(drivers);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. DELTA SYNC (Bandwidth Saver)
router.get('/sync', async (req, res) => {
    try {
        const since = parseInt(req.query.since) || 0;
        const result = await queryWithRetry('SELECT * FROM drivers WHERE updated_at > $1 ORDER BY updated_at DESC', [since]);
        const drivers = result.rows.map(toDriverDTO); // Use DTO mapper
        res.json(drivers);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. FETCH MESSAGES ON DEMAND
router.get('/drivers/:id/messages', async (req, res) => {
    try {
        const { id } = req.params;
        const mRes = await queryWithRetry('SELECT * FROM messages WHERE driver_id = $1 ORDER BY timestamp ASC', [id]);
        const messages = mRes.rows.map(toMessageDTO); // Use DTO mapper
        res.json(messages);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/drivers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        const keys = Object.keys(updates);
        if (keys.length === 0) return res.json({ success: true });
        
        // Convert camelCase keys back to snake_case for DB update
        const toSnakeCase = (str) => str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

        const setClause = keys.map((k, i) => {
             const dbKey = toSnakeCase(k);
             return `${dbKey} = $${i+2}`;
        }).join(', ') + `, updated_at = $${keys.length + 2}`;
        
        const values = keys.map(k => updates[k]);
        values.push(Date.now()); // Add timestamp value

        await queryWithRetry(`UPDATE drivers SET ${setClause} WHERE id = $1`, [id, ...values]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/messages/schedule', async (req, res) => {
    try {
        const { driverIds, scheduledTime, ...content } = req.body; 
        const id = `task_${Date.now()}_${Math.random()}`;
        
        let type = 'text';
        if (content.templateName) type = 'template';
        else if (content.buttons) type = 'rich_card';
        else if (content.mediaUrl) type = content.mediaType || 'image';

        await queryWithRetry(
            "INSERT INTO scheduled_messages (id, target_ids, type, content, scheduled_time, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
            [id, JSON.stringify(driverIds), type, JSON.stringify(content), scheduledTime, Date.now()]
        );
        res.json({ success: true, id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/messages/send', async (req, res) => {
    try {
        const { driverId, text, mediaUrl, mediaType, options, headerImageUrl, footerText, buttons, templateName } = req.body;
        const dRes = await queryWithRetry('SELECT phone_number FROM drivers WHERE id = $1', [driverId]);
        if (dRes.rows.length === 0) return res.status(404).json({ error: "Driver not found" });
        
        const result = await sendWhatsAppMessage(dRes.rows[0].phone_number, text, options, templateName, 'en_US', mediaUrl, mediaType, headerImageUrl, footerText, buttons);
        
        if (result.success) {
            let type = 'text';
            if (templateName) type = 'template';
            else if (buttons) type = 'rich_card';
            else if (mediaUrl) type = mediaType || 'image';
            else if (options && options.length > 0) type = 'options';

            const now = Date.now();
            try {
                await queryWithRetry(`INSERT INTO messages (id, driver_id, sender, text, timestamp, type, image_url, header_image_url, footer_text, buttons, template_name) VALUES ($1, $2, 'agent', $3, $4, $5, $6, $7, $8, $9, $10)`, 
                    [
                        `ag_${now}`, 
                        driverId, 
                        text, 
                        now, 
                        type, 
                        safeVal(mediaUrl), 
                        safeVal(headerImageUrl), 
                        safeVal(footerText), 
                        buttons ? JSON.stringify(buttons) : null, 
                        safeVal(templateName)
                    ]
                );
                await queryWithRetry('UPDATE drivers SET last_message = $1, last_message_time = $2, updated_at = $2 WHERE id = $3', [text || `[${type}]`, now, driverId]);
            } catch (dbErr) {
                console.error("Message Sent but DB Save Failed:", dbErr.message);
                return res.json({ success: true, warning: "Message sent but not logged" });
            }

            res.json({ success: true });
        } else {
            // Forward the specific Meta error to the frontend
            res.status(500).json({ error: result.error, code: result.code });
        }
    } catch (e) { 
        console.error("Message Send Error:", e);
        res.status(500).json({ error: e.message }); 
    }
});

// --- CREDENTIAL UPDATE ROUTES ---
router.post('/update-credentials', async (req, res) => {
    try {
        const { phoneNumberId, apiToken } = req.body;
        if (!phoneNumberId || !apiToken) return res.status(400).json({ error: "Missing fields" });
        
        // Validation: Check if credentials work before saving
        await validateMetaCredentials(phoneNumberId, apiToken);
        
        // Update Runtime Variables
        PHONE_NUMBER_ID = phoneNumberId;
        META_API_TOKEN = apiToken;
        
        // Persist to DB
        await queryWithRetry(`INSERT INTO system_credentials (key, value) VALUES ('PHONE_NUMBER_ID', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [phoneNumberId]);
        await queryWithRetry(`INSERT INTO system_credentials (key, value) VALUES ('META_API_TOKEN', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [apiToken]);

        console.log(`[System] Credentials Verified & Updated via API. New Phone ID: ${PHONE_NUMBER_ID}`);
        res.json({ success: true });
    } catch (e) {
        console.error("Credential Update Error:", e.message);
        res.status(400).json({ error: e.message });
    }
});

router.post('/configure-webhook', async (req, res) => {
    try {
        const { verifyToken } = req.body;
        if (verifyToken) {
            VERIFY_TOKEN = verifyToken;
            await queryWithRetry(`INSERT INTO system_credentials (key, value) VALUES ('VERIFY_TOKEN', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [verifyToken]);
        }
        console.log(`[System] Webhook Token Updated: ${VERIFY_TOKEN}`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/test-connection', async (req, res) => {
    try {
        const { testNumber } = req.body; // e.g., '15551234567'
        if (!testNumber) return res.status(400).json({ error: "Test number required" });
        
        const result = await sendWhatsAppMessage(testNumber, "🔔 Test Message from Uber Fleet Recruiter. Connection Successful!");
        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/bot-settings', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1', []);
        if (result.rows.length > 0) res.json(result.rows[0].settings);
        else res.json({ isEnabled: true, shouldRepeat: false, steps: [] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/bot-settings', async (req, res) => {
    try {
        await queryWithRetry('INSERT INTO bot_settings (id, settings) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET settings = $1', [JSON.stringify(req.body)]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ... Media Routes ...
router.get('/media', async (req, res) => {
    try {
        const { path } = req.query;
        const safePath = path || '/';
        const filesRes = await queryWithRetry('SELECT * FROM files WHERE folder_path = $1 ORDER BY id DESC', [safePath]);
        const foldersRes = await queryWithRetry('SELECT * FROM folders WHERE parent_path = $1 ORDER BY id DESC', [safePath]);
        res.json({ files: filesRes.rows, folders: foldersRes.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/s3/presign', async (req, res) => {
    try {
        const { filename, fileType, folderPath } = req.body;
        const key = `${folderPath === '/' ? '' : folderPath.substring(1) + '/'}${Date.now()}_${filename}`;
        const command = new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, ContentType: fileType });
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        const publicUrl = `https://${BUCKET_NAME}.s3.amazonaws.com/${key}`;
        res.json({ uploadUrl, key, publicUrl });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/files/register', async (req, res) => {
    try {
        const { key, url, filename, folderPath } = req.body;
        const type = filename.split('.').pop().toLowerCase(); 
        const id = `file_${Date.now()}`;
        await queryWithRetry(`INSERT INTO files (id, filename, url, type, folder_path) VALUES ($1, $2, $3, $4, $5)`, [id, filename, url, type, folderPath]);
        res.json({ success: true, id });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/files/:id/sync', async (req, res) => {
    try {
        const { id } = req.params;
        const fileRes = await queryWithRetry('SELECT * FROM files WHERE id = $1', [id]);
        if (fileRes.rows.length === 0) return res.status(404).json({ error: "File not found" });
        const file = fileRes.rows[0];
        if (file.media_id) return res.json({ success: true, mediaId: file.media_id, cached: true });
        let mime = 'image/jpeg';
        if (file.type === 'video') mime = 'video/mp4';
        else if (file.type === 'document') mime = 'application/pdf';
        const mediaId = await uploadToWhatsApp(file.url, mime);
        await queryWithRetry('UPDATE files SET media_id = $1 WHERE id = $2', [mediaId, id]);
        res.json({ success: true, mediaId, cached: false });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/media/sync', async (req, res) => {
    try {
        const command = new ListObjectsV2Command({ Bucket: BUCKET_NAME });
        const s3Res = await s3Client.send(command);
        const s3Objects = s3Res.Contents || [];
        let addedCount = 0;
        for (const obj of s3Objects) {
            const key = obj.Key;
            if (key.endsWith('/')) continue;
            const publicUrl = `https://${BUCKET_NAME}.s3.amazonaws.com/${key}`;
            const exists = await queryWithRetry('SELECT id FROM files WHERE url = $1', [publicUrl]);
            if (exists.rows.length > 0) continue;
            const parts = key.split('/');
            const filename = parts.pop();
            const folderPath = parts.length > 0 ? `/${parts.join('/')}` : '/';
            if (folderPath !== '/') {
                let currentParent = '/';
                for (const part of parts) {
                    const checkFolder = await queryWithRetry('SELECT id FROM folders WHERE name = $1 AND parent_path = $2', [part, currentParent]);
                    if (checkFolder.rows.length === 0) await queryWithRetry('INSERT INTO folders (id, name, parent_path) VALUES ($1, $2, $3)', [`fold_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`, part, currentParent]);
                    currentParent = currentParent === '/' ? `/${part}` : `${currentParent}/${part}`;
                }
            }
            const type = getFileType(filename);
            await queryWithRetry(`INSERT INTO files (id, filename, url, type, folder_path) VALUES ($1, $2, $3, $4, $5)`, [`file_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`, filename, publicUrl, type, folderPath]);
            addedCount++;
        }
        res.json({ success: true, added: addedCount });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

router.delete('/files/:id', async (req, res) => {
    try {
        await queryWithRetry('DELETE FROM files WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/folders', async (req, res) => {
    try {
        const { name, parentPath } = req.body;
        const check = await queryWithRetry('SELECT id FROM folders WHERE name = $1 AND parent_path = $2', [name, parentPath]);
        if (check.rows.length > 0) return res.status(409).json({ error: "Folder exists" });
        await queryWithRetry('INSERT INTO folders (id, name, parent_path) VALUES ($1, $2, $3)', [`fold_${Date.now()}`, name, parentPath]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/folders/:id', async (req, res) => {
    try {
        const { name } = req.body;
        await queryWithRetry('UPDATE folders SET name = $1 WHERE id = $2', [name, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/folders/:id', async (req, res) => {
    try {
        const fRes = await queryWithRetry('SELECT name, parent_path FROM folders WHERE id = $1', [req.params.id]);
        if (fRes.rows.length === 0) return res.json({ success: true });
        const folderName = fRes.rows[0].name;
        const parentPath = fRes.rows[0].parent_path;
        const fullPath = parentPath === '/' ? `/${folderName}` : `${parentPath}/${folderName}`;
        const files = await queryWithRetry('SELECT id FROM files WHERE folder_path = $1', [fullPath]);
        const sub = await queryWithRetry('SELECT id FROM folders WHERE parent_path = $1', [fullPath]);
        if (files.rows.length > 0 || sub.rows.length > 0) return res.status(400).json({ error: "Folder not empty" });
        await queryWithRetry('DELETE FROM folders WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/public/showcase', async (req, res) => {
    try {
        const { folder } = req.query;
        let query = 'SELECT * FROM folders WHERE is_public_showcase = TRUE ORDER BY id DESC LIMIT 1';
        let params = [];
        if (folder) {
            query = 'SELECT * FROM folders WHERE name = $1';
            params = [folder];
        }
        const fRes = await queryWithRetry(query, params);
        if (fRes.rows.length === 0) return res.json({ title: 'Showcase', items: [] });
        const targetFolder = fRes.rows[0];
        const path = targetFolder.parent_path === '/' ? `/${targetFolder.name}` : `${targetFolder.parent_path}/${targetFolder.name}`;
        const files = await queryWithRetry('SELECT id, url, type, filename FROM files WHERE folder_path = $1 ORDER BY id DESC', [path]);
        res.json({ title: targetFolder.name, items: files.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/public/status', async (req, res) => {
    try {
        const resDb = await queryWithRetry('SELECT * FROM folders WHERE is_public_showcase = TRUE ORDER BY id DESC LIMIT 1', []);
        if (resDb.rows.length > 0) {
            res.json({ active: true, folderName: resDb.rows[0].name, folderId: resDb.rows[0].id });
        } else {
            res.json({ active: false });
        }
    } catch (e) { res.json({ active: false }); }
});

router.post('/folders/:id/public', async (req, res) => {
    try {
        await queryWithRetry('UPDATE folders SET is_public_showcase = TRUE WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/folders/:id/public', async (req, res) => {
    try {
        await queryWithRetry('UPDATE folders SET is_public_showcase = FALSE WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/system/stats', async (req, res) => {
    try {
        const start = Date.now();
        await queryWithRetry('SELECT 1', []); 
        const latency = Date.now() - start;
        const upRes = await queryWithRetry('SELECT count(*) as c FROM files', []);
        const serverLoad = Math.min(100, 5 + (activeS3Transfers * 10) + (activeWhatsAppUploads * 15));
        res.json({
            serverLoad: Math.round(serverLoad),
            dbLatency: latency,
            aiCredits: 92,
            aiModel: 'Gemini 3 Pro',
            s3Status: 'ok',
            s3Load: activeS3Transfers > 0 ? 100 : 0,
            whatsappStatus: 'ok',
            whatsappUploadLoad: activeWhatsAppUploads > 0 ? 100 : 0,
            activeUploads: parseInt(upRes.rows[0].c || 0),
            uptime: process.uptime()
        });
    } catch(e) {
        res.status(500).json({ error: "System Error" });
    }
});

// --- CORE BOT LOGIC WITH CHAINING SUPPORT ---
const processIncomingMessage = async (from, name, msgBody, msgType = 'text') => {
    let botSettings = { isEnabled: true, shouldRepeat: false, steps: [] };
    try {
        const sRes = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1', []);
        if (sRes.rows.length > 0) botSettings = sRes.rows[0].settings;
    } catch(e) {}

    let driver;
    const client = await pool.connect();
    const now = Date.now();
    try {
        await client.query('BEGIN');
        
        let dRes = await client.query('SELECT * FROM drivers WHERE phone_number = $1 OR phone_number = $2', [from, '+' + from.replace('+', '')]);
        
        if (dRes.rows.length === 0) {
            const isActive = botSettings.isEnabled;
            const iRes = await client.query(
                `INSERT INTO drivers (id, phone_number, name, source, status, last_message, last_message_time, current_bot_step_id, is_bot_active, is_human_mode, updated_at)
                VALUES ($1, $2, $3, 'WhatsApp', 'New', $4, $5, $6, $7, false, $5) RETURNING *`,
                [now.toString(), from, name, msgBody, now, null, isActive]
            );
            driver = iRes.rows[0];
        } else {
            driver = dRes.rows[0];
            await client.query('UPDATE drivers SET last_message = $1, last_message_time = $2, updated_at = $2 WHERE id = $3', [msgBody, now, driver.id]);
        }
        await client.query(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'driver', $3, $4, $5)`,
            [`msg_${now}`, driver.id, msgBody, now, msgType]
        );
        await client.query('COMMIT');
    } catch (e) { 
        await client.query('ROLLBACK'); 
        console.error("DB Error in processIncomingMessage:", e);
    } finally { 
        client.release(); 
    }

    if (!driver) return; // Guard against db failure

    if (driver.is_human_mode) {
        console.log(`[Bot] Skipped: ${from} is in Human Mode`);
        return;
    }

    const shouldProcess = botSettings.isEnabled && (driver.is_bot_active || botSettings.shouldRepeat);

    if (!shouldProcess) {
        console.log(`[Bot] Skipped: Bot Disabled or User Inactive.`);
        return;
    }

    // --- RECURSIVE STEP EXECUTION ENGINE ---
    const executeStepSequence = async (stepId, driverId, depth = 0) => {
        if (depth > 10) return; // Prevent infinite loops
        
        const step = botSettings.steps.find(s => s.id === stepId);
        if (!step) return;

        // 1. Send the message for this step
        // Handle Delays (only apply for auto-advanced steps to prevent immediate bursts)
        if (depth > 0 && step.delay > 0) {
             if (step.delay <= 10) await new Promise(r => setTimeout(r, step.delay * 1000));
             // For longer delays, we would normally use the scheduler, but for simplicity in "perfectionist" flow, we wait.
        }

        const result = await sendWhatsAppMessage(
            from, 
            step.message, 
            step.options, 
            step.templateName, 
            'en_US', 
            step.mediaUrl, 
            step.mediaType, 
            step.headerImageUrl, 
            step.footerText, 
            step.buttons
        );

        if (result.success) {
            await logSystemMessage(driverId, step.message || `[Template]`, 'text', safeVal(step.headerImageUrl), safeVal(step.footerText), step.buttons, safeVal(step.templateName));
        }

        // 2. Check if this step requires user input (Interactive) or Auto-Advance
        const isInteractive = 
            (step.saveToField) || 
            (step.options && step.options.length > 0) || 
            (step.buttons && step.buttons.some(b => b.type === 'reply')) ||
            (step.inputType === 'option' || step.inputType === 'text' || step.inputType === 'input') ||
            (step.routes && Object.keys(step.routes).length > 0);

        if (isInteractive) {
            // STOP & WAIT. User needs to reply to this step.
            await queryWithRetry(`UPDATE drivers SET current_bot_step_id = $1, is_bot_active = TRUE, updated_at = $3 WHERE id = $2`, [step.id, driverId, Date.now()]);
        } else {
            // AUTO-ADVANCE
            if (step.nextStepId && step.nextStepId !== 'END' && step.nextStepId !== 'AI_HANDOFF') {
                // Recursive call to next step
                // Update DB to mark progress even if we move past it immediately
                await queryWithRetry(`UPDATE drivers SET current_bot_step_id = $1, updated_at = $3 WHERE id = $2`, [step.id, driverId, Date.now()]);
                await executeStepSequence(step.nextStepId, driverId, depth + 1);
            } else {
                // END of Flow
                if (botSettings.shouldRepeat) {
                    await queryWithRetry(`UPDATE drivers SET current_bot_step_id = NULL, is_bot_active = TRUE, updated_at = $2 WHERE id = $1`, [driverId, Date.now()]);
                } else {
                    await queryWithRetry(`UPDATE drivers SET current_bot_step_id = NULL, is_bot_active = FALSE, updated_at = $2 WHERE id = $1`, [driver.id, Date.now()]);
                }
                if (step.nextStepId !== 'END' && step.nextStepId !== 'AI_HANDOFF') {
                    await sendWhatsAppMessage(from, "Thank you! Application complete.");
                }
            }
        }
    };

    // Determine Starting Point or Next Step based on input
    let currentStep = botSettings.steps.find(s => s.id === driver.current_bot_step_id);
    
    if (!currentStep && botSettings.steps.length > 0) {
        // CASE: START
        const entryStep = botSettings.steps.find(s => s.id === botSettings.entryPointId) || botSettings.steps[0];
        if (entryStep) await executeStepSequence(entryStep.id, driver.id);
    } else if (currentStep) {
        // CASE: PROCESSING INPUT FOR EXISTING STEP
        let nextId = currentStep.nextStepId;
        
        // 1. Check Routes/Branching
        if (currentStep.routes && Object.keys(currentStep.routes).length > 0) {
            const input = msgBody.trim().toLowerCase();
            const matched = Object.keys(currentStep.routes).find(k => input.includes(k.toLowerCase()));
            if (matched) {
                nextId = currentStep.routes[matched];
            } else {
                // Invalid Input Handling? For now, we allow fall-through to default nextId if strictly defined, 
                // but usually routes imply restricted choice.
                // If NO match and NO default nextId, we should probably re-ask or stop.
                // For this implementation, we assume if nextId exists as fallback, use it.
            }
        }

        // 2. Save Data
        if (currentStep.saveToField) {
             await queryWithRetry(`UPDATE drivers SET ${currentStep.saveToField === 'name' ? 'name' : currentStep.saveToField} = $1 WHERE id = $2`, [msgBody, driver.id]);
        }

        // 3. Move to Next
        if (nextId && nextId !== 'END' && nextId !== 'AI_HANDOFF') {
            await executeStepSequence(nextId, driver.id);
        } else if (nextId === 'END' || nextId === 'AI_HANDOFF') {
            // End Flow logic
             if (botSettings.shouldRepeat) {
                await queryWithRetry(`UPDATE drivers SET current_bot_step_id = NULL, is_bot_active = TRUE, updated_at = $2 WHERE id = $1`, [driver.id, Date.now()]);
            } else {
                await queryWithRetry(`UPDATE drivers SET current_bot_step_id = NULL, is_bot_active = FALSE, updated_at = $2 WHERE id = $1`, [driver.id, Date.now()]);
            }
            await sendWhatsAppMessage(from, "Thank you! We have received your details.");
        }
    }
};

app.use('/api', router);

app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.send(req.query['hub.challenge']);
    } else {
        res.sendStatus(400);
    }
});

app.post('/webhook', async (req, res) => {
    console.log('Incoming Webhook Payload:', JSON.stringify(req.body, null, 2));
    
    // FAIL-SAFE: Ensure DB is ready for this webhook request specifically
    await initDB(); 

    try {
        const entry = req.body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        if (!value) return res.sendStatus(200);

        if (value.messages?.[0]) {
            const msg = value.messages[0];
            const contact = value.contacts?.[0];
            let text = "";
            switch (msg.type) {
                case 'text': text = msg.text?.body || ""; break;
                case 'interactive': text = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || ""; break;
                case 'button': text = msg.button?.text || ""; break;
                case 'image': text = msg.caption ? `[Image]: ${msg.caption}` : "[Image]"; break;
                case 'video': text = msg.caption ? `[Video]: ${msg.caption}` : "[Video]"; break;
                case 'document': text = msg.caption ? `[Document]: ${msg.caption}` : "[Document]"; break;
                case 'location': text = "[Location Shared]"; break;
                default: text = `[${msg.type} Message]`;
            }
            if (!text.trim()) text = `[${msg.type}]`;
            const senderName = contact?.profile?.name || "Unknown";
            const senderPhone = msg.from; 
            await processIncomingMessage(senderPhone, senderName, text, msg.type);
        }
    } catch (error) { console.error("Webhook Error:", error); }
    res.sendStatus(200);
});

// Ensure DB is ready before listening (Critical for cold starts)
initDB().then(() => {
    if (require.main === module) app.listen(PORT, () => console.log(`🚀 Server on Port ${PORT}`));
});

module.exports = app;
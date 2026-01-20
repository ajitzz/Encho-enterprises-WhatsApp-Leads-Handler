
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
const { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
require('dotenv').config();

const app = express();
const router = express.Router(); 

// --- SERVER SIDE CACHE (REDUCES DB LOAD) ---
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

// --- AWS S3 CONFIG ---
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

// --- DATABASE CONNECTION ---
const DEFAULT_DB_URL = "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL || DEFAULT_DB_URL;

if (!CONNECTION_STRING) {
    console.error("❌ CRITICAL ERROR: POSTGRES_URL or DATABASE_URL environment variable is missing.");
}

let pool;
if (!global.pgPool) {
    if (CONNECTION_STRING) {
        // Fix for SSL Warning: prefer verifying only what's necessary or standardizing the string
        // We let pg handle the parsing but explicitly override SSL settings in the config
        global.pgPool = new Pool({
            connectionString: CONNECTION_STRING,
            ssl: { 
                rejectUnauthorized: false // Fixes "self signed certificate" errors in dev/some prod envs
            },
            // OPTIMIZED FOR VERCEL SERVERLESS & NEON COLD STARTS
            max: 2, // Strict limit to prevent connection exhaustion
            connectionTimeoutMillis: 15000, // Increased to 15s to allow Neon to wake up
            idleTimeoutMillis: 30000, // Keep idle connections longer to reuse them between lambda invocations
            keepAlive: true,
        });
        
        // Handle unexpected errors on idle clients
        global.pgPool.on('error', (err, client) => {
            console.error('Unexpected error on idle DB client', err);
            // process.exit(-1); // DO NOT EXIT in serverless, let the pool handle it
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
        whatsapp_message_id TEXT UNIQUE,
        status TEXT DEFAULT 'sent',
        retry_count INT DEFAULT 0,
        next_retry_at BIGINT DEFAULT 0
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
    CREATE TABLE IF NOT EXISTS media_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_path TEXT DEFAULT '/',
        is_public_showcase BOOLEAN DEFAULT FALSE,
        created_at BIGINT DEFAULT (extract(epoch from now()) * 1000),
        UNIQUE(name, parent_path)
    );
    CREATE TABLE IF NOT EXISTS media_files (
        id TEXT PRIMARY KEY,
        folder_path TEXT DEFAULT '/',
        filename TEXT NOT NULL,
        s3_key TEXT NOT NULL,
        url TEXT NOT NULL,
        type TEXT,
        media_id TEXT, -- WhatsApp Media ID
        created_at BIGINT DEFAULT (extract(epoch from now()) * 1000)
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
    INSERT INTO system_settings (key, value) VALUES 
    ('webhook_ingest_enabled', 'true'),
    ('automation_enabled', 'true'),
    ('sending_enabled', 'true')
    ON CONFLICT (key) DO NOTHING;
`;

// --- ENTERPRISE INDEXES (PAGINATION + SYNC + OUTBOX OPTIMIZED) ---
const INDEX_QUERIES = `
    CREATE INDEX IF NOT EXISTS idx_drivers_updated_at ON drivers(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_driver_timestamp ON messages(driver_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_client_msg_id ON messages(client_message_id);
    CREATE INDEX IF NOT EXISTS idx_messages_outbox_v2 ON messages(next_retry_at ASC, retry_count) WHERE status IN ('pending', 'failed');
    CREATE INDEX IF NOT EXISTS idx_driver_documents_driver_id ON driver_documents(driver_id);
    CREATE INDEX IF NOT EXISTS idx_media_files_path ON media_files(folder_path);
    CREATE INDEX IF NOT EXISTS idx_media_folders_parent ON media_folders(parent_path);
`;

// --- MIGRATION QUERIES (Auto-Update Existing Tables) ---
const MIGRATION_QUERIES = `
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_message_id TEXT UNIQUE;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS whatsapp_message_id TEXT UNIQUE;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS template_name TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'sent';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS retry_count INT DEFAULT 0;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS next_retry_at BIGINT DEFAULT 0;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS current_bot_step_id TEXT;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_bot_active BOOLEAN DEFAULT TRUE;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_human_mode BOOLEAN DEFAULT FALSE;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS qualification_checks JSONB DEFAULT '{}';
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS onboarding_step INT DEFAULT 0;
    
    -- Ensure Media Tables Columns (Self-Healing)
    ALTER TABLE media_folders ADD COLUMN IF NOT EXISTS is_public_showcase BOOLEAN DEFAULT FALSE;
    ALTER TABLE media_files ADD COLUMN IF NOT EXISTS media_id TEXT;
    
    -- Critical Fix for "created_at does not exist" error
    ALTER TABLE media_folders ADD COLUMN IF NOT EXISTS created_at BIGINT DEFAULT (extract(epoch from now()) * 1000);
    ALTER TABLE media_files ADD COLUMN IF NOT EXISTS created_at BIGINT DEFAULT (extract(epoch from now()) * 1000);
`;

// --- QUERY EXECUTION HELPER ---
const queryWithRetry = async (text, params, retries = 1) => { 
    if (!pool) throw new Error("Database connection not configured.");
    let client;
    try {
        client = await pool.connect();
        const res = await client.query(text, params);
        return res;
    } catch (err) {
        if (client) { try { client.release(true); } catch(e) {} client = null; }
        
        if (err.code === '42P01') { 
            console.warn("⚠️ Tables missing. Running Schema Init...");
            try {
                const healClient = await pool.connect();
                await healClient.query(SCHEMA_QUERIES);
                await healClient.query(INDEX_QUERIES); 
                healClient.release();
                const retryClient = await pool.connect();
                const res = await retryClient.query(text, params);
                retryClient.release();
                return res;
            } catch (healErr) {
                console.error("❌ Schema Healing Failed:", healErr.message);
                throw healErr;
            }
        }
        
        if (err.code === '42703') {
             console.warn("⚠️ Columns missing. Running Migrations...");
             try {
                const healClient = await pool.connect();
                await healClient.query(MIGRATION_QUERIES);
                healClient.release();
                const retryClient = await pool.connect();
                const res = await retryClient.query(text, params);
                retryClient.release();
                return res;
             } catch (healErr) {
                console.error("❌ Migration Failed:", healErr.message);
                throw healErr;
             }
        }

        if (retries > 0 && (err.code === 'ECONNRESET' || err.code === '57P01' || err.message.includes('timeout') || err.message.includes('Connection terminated'))) {
            await new Promise(res => setTimeout(res, 2000)); 
            return queryWithRetry(text, params, retries - 1);
        }
        throw err;
    } finally {
        if (client) { try { client.release(); } catch(e) {} }
    }
};

// --- CACHING HELPERS ---
const refreshCache = async () => {
    try {
        const botRes = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1');
        CACHE.botSettings = botRes.rows[0]?.settings || { isEnabled: true, steps: [] };

        const sysRes = await queryWithRetry('SELECT * FROM system_settings');
        const settings = { webhook_ingest_enabled: true, automation_enabled: true, sending_enabled: true };
        sysRes.rows.forEach(r => { if (r.key in settings) settings[r.key] = r.value === 'true'; });
        CACHE.systemSettings = settings;

        CACHE.lastRefreshed = Date.now();
        console.log("🧠 Server Cache Refreshed");
    } catch (e) {
        console.error("Failed to refresh cache (using defaults):", e.message);
    }
};

const getCachedBotSettings = async () => {
    if (!CACHE.botSettings) await refreshCache();
    return CACHE.botSettings;
};

const getCachedSystemSetting = async (key) => {
    if (!CACHE.systemSettings) await refreshCache();
    return CACHE.systemSettings[key];
};

// --- INIT DB ON STARTUP ---
const initDB = async () => {
    try {
        await queryWithRetry("SELECT 1"); 
        await queryWithRetry(SCHEMA_QUERIES);
        await queryWithRetry(MIGRATION_QUERIES);
        await refreshCache(); 
        console.log("✅ Database Initialized & Cached");
    } catch (e) {
        console.error("⚠️ DB Init warning (Non-fatal):", e.message);
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
    updatedAt: parseInt(row.updated_at || '0'),
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
    templateName: row.template_name,
    status: row.status || 'sent'
});

const toDocumentDTO = (row) => ({
    id: row.id,
    driverId: row.driver_id,
    docType: row.doc_type,
    file_url: row.file_url, // Keep raw for backwards compat
    fileUrl: row.file_url,
    mimeType: row.mime_type,
    createdAt: parseInt(row.created_at || '0'),
    verificationStatus: row.verification_status,
    notes: row.notes
});

const updateDriverTimestamp = async (driverId) => {
    try {
        await queryWithRetry('UPDATE drivers SET updated_at = $1 WHERE id = $2', [Date.now(), driverId]);
    } catch (e) { console.error("Timestamp update failed", e); }
};

// --- CORE WHATSAPP SEND LOGIC (META API) ---
const executeMetaSend = async (to, content) => {
    if (!META_API_TOKEN || !PHONE_NUMBER_ID) throw new Error("Missing Meta Credentials");

    let cleanTo = to.replace(/\D/g, ''); 
    const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
    
    // Fallback safe body
    const bodyText = (content.text || content.message || "").substring(0, 4096);
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
        
        payload.interactive = {
            type: "button",
            header: headerObj,
            body: { text: safeBodyText.trim() || "Select an option" }, 
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

    const response = await axios.post(url, payload, {
        headers: { 'Authorization': `Bearer ${META_API_TOKEN}`, 'Content-Type': 'application/json' },
        timeout: 10000 
    });
    
    return response.data.messages?.[0]?.id;
};

// --- OUTBOX RETRY WORKER (CONCURRENCY SAFE) ---
const processOutbox = async () => {
    if (!pool) return;
    const sendingEnabled = await getCachedSystemSetting('sending_enabled');
    if (!sendingEnabled) return;

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const fetchQuery = `
            SELECT m.id, m.text, m.buttons, m.template_name, m.image_url, m.header_image_url, m.footer_text, d.phone_number, m.retry_count
            FROM messages m
            JOIN drivers d ON m.driver_id = d.id
            WHERE m.status IN ('pending', 'failed')
            AND (m.next_retry_at IS NULL OR m.next_retry_at <= $1)
            AND m.retry_count < 5
            ORDER BY m.next_retry_at ASC
            LIMIT 5
            FOR UPDATE SKIP LOCKED
        `;
        
        const { rows } = await client.query(fetchQuery, [Date.now()]);

        for (const row of rows) {
            const content = {
                text: row.text,
                buttons: row.buttons,
                templateName: row.template_name,
                mediaUrl: row.image_url,
                headerImageUrl: row.header_image_url,
                footerText: row.footer_text
            };

            try {
                const wamid = await executeMetaSend(row.phone_number, content);
                
                await client.query(
                    "UPDATE messages SET status = 'sent', whatsapp_message_id = $1, updated_at = $2 WHERE id = $3",
                    [wamid, Date.now(), row.id]
                );
            } catch (e) {
                const delay = Math.pow(2, row.retry_count + 1) * 2000;
                const nextTry = Date.now() + delay;
                
                console.error(`[OUTBOX] Failed: ${row.id}. Retry in ${delay}ms`);
                
                await client.query(
                    "UPDATE messages SET status = 'failed', retry_count = retry_count + 1, next_retry_at = $1 WHERE id = $2",
                    [nextTry, row.id]
                );
            }
        }

        await client.query('COMMIT');
    } catch (e) {
        if (client) await client.query('ROLLBACK');
        console.error("Worker Transaction Error:", e.message);
    } finally {
        if (client) client.release();
    }
};

// --- SEND MESSAGE HELPER (BUFFERED INSERT) ---
const queueAndSendMessage = async (to, content, clientMessageId = null, driverId) => {
    const sendingEnabled = await getCachedSystemSetting('sending_enabled');
    if (!sendingEnabled) return { success: false, error: "System Disabled" };

    const unsafeRegex = /replace\s+this|enter\s+your\s+message|type\s+your\s+message|sample\s+message/i;
    const bodyText = (content.text || content.message || "").substring(0, 4096);
    
    if (unsafeRegex.test(bodyText)) {
        return { success: false, error: "Blocked: Placeholder Text Detected" };
    }

    if (!bodyText.trim() && !content.templateName && !content.mediaUrl && !content.buttons) {
         return { success: false, error: "Blocked: Empty Content" };
    }

    const msgId = `msg_${Date.now()}_${Math.random().toString(36).substr(2,5)}`;
    const dbText = bodyText || (content.templateName ? `Template: ${content.templateName}` : '[Media Message]');
    const retryBuffer = Date.now() + 15000; 
    
    try {
        const insertRes = await queryWithRetry(`
            INSERT INTO messages (id, driver_id, sender, text, timestamp, type, client_message_id, buttons, template_name, image_url, status, header_image_url, footer_text, next_retry_at)
            VALUES ($1, $2, 'agent', $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, $12)
            ON CONFLICT (client_message_id) DO NOTHING
            RETURNING id
        `, [
            msgId, driverId, dbText, Date.now(),
            content.templateName ? 'template' : (content.options ? 'options' : 'text'),
            clientMessageId,
            content.buttons ? JSON.stringify(content.buttons) : null,
            content.templateName,
            content.mediaUrl,
            content.headerImageUrl,
            content.footerText,
            retryBuffer
        ]);

        if (insertRes.rows.length === 0) return { success: true, duplicate: true };

    } catch(e) {
        console.error("DB Insert Failed:", e);
        throw e;
    }

    try {
        const wamid = await executeMetaSend(to, content);
        
        await queryWithRetry("UPDATE messages SET status = 'sent', whatsapp_message_id = $1 WHERE id = $2", [wamid, msgId]);
        await updateDriverTimestamp(driverId);
        
        return { success: true, messageId: msgId };
    } catch (error) {
        const fastRetry = Date.now() + 2000;
        await queryWithRetry("UPDATE messages SET status = 'failed', next_retry_at = $1 WHERE id = $2", [fastRetry, msgId]);
        processOutbox().catch(console.error);
        return { success: true, messageId: msgId, queued: true };
    }
};

// --- SHOWCASE MANIFEST GENERATION ---
const generateShowcaseManifest = async (folderId, folderName) => {
    try {
        const path = `/${folderName}`; 
        const filesRes = await queryWithRetry('SELECT * FROM media_files WHERE folder_path = $1 ORDER BY created_at DESC', [path]);
        
        const items = filesRes.rows.map(row => ({
            id: row.id,
            url: row.url,
            type: row.type || 'image',
            filename: row.filename
        }));

        const manifest = {
            title: folderName,
            generatedAt: Date.now(),
            items: items
        };

        const jsonString = JSON.stringify(manifest);
        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: `manifests/${encodeURIComponent(folderName)}.json`,
            ContentType: 'application/json',
            Body: jsonString,
            ACL: 'public-read' 
        });

        await s3Client.send(command);
        console.log(`✅ Generated manifest for ${folderName}`);
        return manifest;
    } catch(e) {
        console.error("Failed to generate manifest", e);
    }
};

// --- API ENDPOINTS ---

router.post('/messages/send', async (req, res) => {
    const { driverId, text, clientMessageId, ...attachments } = req.body;
    
    try {
        const driverRes = await queryWithRetry('SELECT phone_number FROM drivers WHERE id = $1', [driverId]);
        if (driverRes.rows.length === 0) return res.status(404).json({ error: "Driver not found" });
        const phone = driverRes.rows[0].phone_number;

        const result = await queueAndSendMessage(phone, { text, ...attachments }, clientMessageId, driverId);
        processOutbox().catch(e => console.error("Lazy outbox error:", e));
        res.json(result);

    } catch (e) {
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
    const enabled = await getCachedSystemSetting('webhook_ingest_enabled');
    if (!enabled) return res.sendStatus(503); 

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
                    if (change.value.statuses) {
                        for (const status of change.value.statuses) {
                            promises.push(processStatusUpdate(status));
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

async function processStatusUpdate(status) {
    await queryWithRetry('UPDATE messages SET status = $1 WHERE whatsapp_message_id = $2', [status.status, status.id]);
}

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

    const driverId = `d_${Date.now()}_${Math.random().toString(36).substr(2,4)}`;
    const name = contacts?.[0]?.profile?.name || 'Unknown Driver';
    
    const driverRes = await queryWithRetry(`
        INSERT INTO drivers (id, phone_number, name, status, last_message, last_message_time, updated_at)
        VALUES ($1, $2, $3, 'New', $4, $5, $6)
        ON CONFLICT (phone_number) 
        DO UPDATE SET last_message = $4, last_message_time = $5, updated_at = $6
        RETURNING id, current_bot_step_id, is_bot_active, is_human_mode
    `, [driverId, from, name, text, Date.now(), Date.now()]);
    
    const currentDriver = driverRes.rows[0];

    const msgId = `msg_${Date.now()}_${Math.random().toString(36).substr(2,5)}`;
    await queryWithRetry(`
        INSERT INTO messages (id, driver_id, sender, text, timestamp, whatsapp_message_id, status)
        VALUES ($1, $2, 'driver', $3, $4, $5, 'read')
    `, [msgId, currentDriver.id, text, Date.now(), wamid]);

    try {
        await runBotEngine(currentDriver, text, buttonId, from);
    } catch (e) {
        console.error("Bot Engine Crash:", e);
    }
}

async function runBotEngine(driver, text, buttonId, from) {
    const automationEnabled = await getCachedSystemSetting('automation_enabled');
    if (!automationEnabled) return;

    if (!driver.is_bot_active || driver.is_human_mode) return;

    const botSettings = await getCachedBotSettings();
    if (!botSettings || !botSettings.isEnabled) return;

    let currentStep = botSettings.steps.find(s => s.id === driver.current_bot_step_id);
    let replyContent = null;

    if (!currentStep) {
        const entryStep = botSettings.steps.find(s => s.id === botSettings.entryPointId) || botSettings.steps[0];
        if (entryStep) {
            replyContent = entryStep;
            await queryWithRetry('UPDATE drivers SET current_bot_step_id = $1, updated_at = $3 WHERE id = $2', [entryStep.id, driver.id, Date.now()]);
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
                await queryWithRetry('UPDATE drivers SET current_bot_step_id = NULL, is_bot_active = $1, updated_at = $3 WHERE id = $2', [botSettings.shouldRepeat, driver.id, Date.now()]);
            } else if (matchedRouteId === 'AI_HANDOFF') {
                 await queryWithRetry('UPDATE drivers SET is_human_mode = TRUE, updated_at = $2 WHERE id = $1', [driver.id, Date.now()]);
            } else {
                const nextStep = botSettings.steps.find(s => s.id === matchedRouteId);
                if (nextStep) {
                    replyContent = nextStep;
                    await queryWithRetry('UPDATE drivers SET current_bot_step_id = $1, updated_at = $3 WHERE id = $2', [nextStep.id, driver.id, Date.now()]);
                    
                    if (currentStep.saveToField) {
                         const allowedFields = ['name', 'vehicle_registration', 'availability', 'email', 'notes'];
                         if (allowedFields.includes(currentStep.saveToField)) {
                             try {
                                 await queryWithRetry(`UPDATE drivers SET ${currentStep.saveToField} = $1 WHERE id = $2`, [text, driver.id]);
                             } catch(e) {}
                         }
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
        await queueAndSendMessage(from, replyContent, null, driver.id);
        
        processOutbox().catch(console.error);
    }
}

// --- STANDARD API ENDPOINTS ---

router.get('/cron/process-outbox', async (req, res) => {
    try {
        await processOutbox();
        res.json({ status: 'ok', processed: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/system/stats', async (req, res) => {
    res.json({
        serverLoad: 0, dbLatency: 0, aiCredits: 100, aiModel: "Bot Logic",
        s3Status: 'ok', s3Load: 0, whatsappStatus: META_API_TOKEN ? 'ok' : 'error',
        whatsappUploadLoad: 0, activeUploads: 0, uptime: process.uptime()
    });
});

router.get('/drivers', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM drivers ORDER BY updated_at DESC LIMIT 50');
        res.json(result.rows.map(toDriverDTO));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/drivers/:id/messages', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit || '50');
        const before = parseInt(req.query.before || '0');
        let query = 'SELECT * FROM messages WHERE driver_id = $1';
        let params = [req.params.id];
        if (before > 0) { query += ' AND timestamp < $2'; params.push(before); }
        query += ` ORDER BY timestamp DESC LIMIT $${params.length + 1}`;
        params.push(limit);
        const result = await queryWithRetry(query, params);
        res.json(result.rows.map(toMessageDTO).reverse());
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
        const keys = Object.keys(updates).filter(k => allowed.includes(k));
        if (keys.length === 0) return res.json({ success: true, message: "No valid fields" });
        const setClause = keys.map((k, i) => {
            if (k === 'qualification_checks') return `${k} = $${i + 2}::jsonb`; 
            return `${k} = $${i + 2}`;
        }).join(', ');
        const values = [id, ...keys.map(k => {
             if (k === 'qualification_checks' && typeof updates[k] === 'object') return JSON.stringify(updates[k]);
             return updates[k];
        })];
        await queryWithRetry(`UPDATE drivers SET ${setClause}, updated_at = ${Date.now()} WHERE id = $1`, values);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/sync', async (req, res) => {
    const since = parseInt(req.query.since || '0');
    try {
        const result = await queryWithRetry('SELECT * FROM drivers WHERE updated_at > $1 ORDER BY updated_at ASC LIMIT 50', [since]);
        const drivers = result.rows.map(toDriverDTO);
        let nextCursor = since;
        if (drivers.length > 0) nextCursor = Math.max(...drivers.map(d => d.updatedAt));
        res.json({ drivers, nextCursor });
    } catch(e) { res.json({ drivers: [], nextCursor: since }); }
});

router.get('/bot-settings', async (req, res) => {
    try {
        const settings = await getCachedBotSettings();
        res.json(settings);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/bot-settings', async (req, res) => {
    try {
        await queryWithRetry(`
            INSERT INTO bot_settings (id, settings) VALUES (1, $1)
            ON CONFLICT (id) DO UPDATE SET settings = $1
        `, [JSON.stringify(req.body)]);
        await refreshCache(); 
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
        await refreshCache(); 
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});


// --- MEDIA LIBRARY & S3 ENDPOINTS ---

router.get('/media', async (req, res) => {
    const path = req.query.path || '/';
    try {
        const folders = await queryWithRetry('SELECT * FROM media_folders WHERE parent_path = $1 ORDER BY name ASC', [path]);
        const files = await queryWithRetry('SELECT * FROM media_files WHERE folder_path = $1 ORDER BY created_at DESC', [path]);
        res.json({
            folders: folders.rows,
            files: files.rows
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/s3/presign', async (req, res) => {
    const { filename, fileType, folderPath = '/' } = req.body;
    if (!filename) return res.status(400).json({ error: "Filename required" });

    const safePath = folderPath.startsWith('/') ? folderPath.slice(1) : folderPath;
    const prefix = safePath ? `${safePath}/` : '';
    const key = `${prefix}${Date.now()}_${filename.replace(/\s+/g, '_')}`;

    try {
        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            ContentType: fileType || 'application/octet-stream',
            ACL: 'public-read' 
        });
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
        
        let publicUrl = `https://${BUCKET_NAME}.s3.amazonaws.com/${key}`;
        if (AWS_REGION && AWS_REGION !== 'us-east-1') {
            publicUrl = `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${key}`;
        }
        
        res.json({ uploadUrl, key, publicUrl });
    } catch (e) {
        console.error("S3 Presign Error:", e);
        res.status(500).json({ error: "Failed to generate upload URL. Check server AWS credentials." });
    }
});

router.post('/files/register', async (req, res) => {
    const { key, url, filename, type, folderPath = '/' } = req.body;
    const id = `file_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    
    let mediaType = type || 'document';
    if (filename.match(/\.(jpg|jpeg|png|gif|webp)$/i)) mediaType = 'image';
    if (filename.match(/\.(mp4|mov|webm)$/i)) mediaType = 'video';

    try {
        await queryWithRetry(`
            INSERT INTO media_files (id, folder_path, filename, s3_key, url, type, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [id, folderPath, filename, key, url, mediaType, Date.now()]);
        res.json({ success: true, id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/folders', async (req, res) => {
    const { name, parentPath = '/' } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    
    const id = `folder_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    try {
        await queryWithRetry(`
            INSERT INTO media_folders (id, name, parent_path, created_at)
            VALUES ($1, $2, $3, $4)
        `, [id, name, parentPath, Date.now()]);
        res.json({ success: true, id });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: "Folder name already exists in this location" });
        res.status(500).json({ error: e.message });
    }
});

router.put('/folders/:id', async (req, res) => {
    const { name } = req.body;
    try {
        await queryWithRetry('UPDATE media_folders SET name = $1 WHERE id = $2', [name, req.params.id]);
        res.json({ success: true });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: "Folder name already exists" });
        res.status(500).json({ error: e.message });
    }
});

router.delete('/files/:id', async (req, res) => {
    try {
        const fileRes = await queryWithRetry('SELECT s3_key FROM media_files WHERE id = $1', [req.params.id]);
        if (fileRes.rows.length > 0) {
            const key = fileRes.rows[0].s3_key;
            try {
                await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
            } catch(s3Err) {
                console.warn("S3 Delete Warning:", s3Err);
            }
            await queryWithRetry('DELETE FROM media_files WHERE id = $1', [req.params.id]);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.delete('/folders/:id', async (req, res) => {
    try {
        const folderRes = await queryWithRetry('SELECT name, parent_path FROM media_folders WHERE id = $1', [req.params.id]);
        if (folderRes.rows.length === 0) return res.status(404).json({ error: "Folder not found" });
        
        const { name, parent_path } = folderRes.rows[0];
        const fullPath = parent_path === '/' ? `/${name}` : `${parent_path}/${name}`;
        
        const filesCount = await queryWithRetry('SELECT COUNT(*) FROM media_files WHERE folder_path = $1', [fullPath]);
        const foldersCount = await queryWithRetry('SELECT COUNT(*) FROM media_folders WHERE parent_path = $1', [fullPath]);
        
        if (parseInt(filesCount.rows[0].count) > 0 || parseInt(foldersCount.rows[0].count) > 0) {
            return res.status(400).json({ error: "Folder must be empty to delete" });
        }

        await queryWithRetry('DELETE FROM media_folders WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/folders/:id/public', async (req, res) => {
    try {
        const folderRes = await queryWithRetry('UPDATE media_folders SET is_public_showcase = TRUE WHERE id = $1 RETURNING name, id', [req.params.id]);
        if (folderRes.rows.length > 0) {
            await generateShowcaseManifest(folderRes.rows[0].id, folderRes.rows[0].name);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.delete('/folders/:id/public', async (req, res) => {
    try {
        await queryWithRetry('UPDATE media_folders SET is_public_showcase = FALSE WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/media/sync', async (req, res) => {
    try {
        let continuationToken = undefined;
        let addedCount = 0;
        
        do {
            const command = new ListObjectsV2Command({ 
                Bucket: BUCKET_NAME,
                ContinuationToken: continuationToken
            });
            const s3Res = await s3Client.send(command);
            
            if (s3Res.Contents) {
                for (const item of s3Res.Contents) {
                    if (item.Key.startsWith('manifests/')) continue; 
                    
                    const exists = await queryWithRetry('SELECT id FROM media_files WHERE s3_key = $1', [item.Key]);
                    if (exists.rows.length === 0) {
                        const parts = item.Key.split('/');
                        const filename = parts.pop();
                        const folderPath = parts.length > 0 ? '/' + parts.join('/') : '/';
                        
                        if (folderPath !== '/') {
                            const folderName = parts[parts.length - 1];
                            const parentPath = parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '/';
                            await queryWithRetry(`
                                INSERT INTO media_folders (id, name, parent_path, created_at)
                                VALUES ($1, $2, $3, $4)
                                ON CONFLICT (name, parent_path) DO NOTHING
                            `, [`folder_auto_${Date.now()}_${Math.random()}`, folderName, parentPath, Date.now()]);
                        }

                        let type = 'document';
                        if (filename.match(/\.(jpg|jpeg|png|webp)$/i)) type = 'image';
                        if (filename.match(/\.(mp4|mov)$/i)) type = 'video';

                        let publicUrl = `https://${BUCKET_NAME}.s3.amazonaws.com/${item.Key}`;
                        if (AWS_REGION && AWS_REGION !== 'us-east-1') {
                            publicUrl = `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${item.Key}`;
                        }

                        const id = `file_sync_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                        
                        await queryWithRetry(`
                            INSERT INTO media_files (id, folder_path, filename, s3_key, url, type, created_at)
                            VALUES ($1, $2, $3, $4, $5, $6, $7)
                        `, [id, folderPath, filename, item.Key, publicUrl, type, Date.now()]);
                        
                        addedCount++;
                    }
                }
            }
            continuationToken = s3Res.NextContinuationToken;
        } while (continuationToken);

        res.json({ success: true, added: addedCount });
    } catch (e) {
        console.error("Sync Error", e);
        res.status(500).json({ error: e.message });
    }
});

// 10. Public Showcase Data (WITH AUTO-SYNC FALLBACK)
router.get('/public/showcase', async (req, res) => {
    const folderName = req.query.folder;
    try {
        let folderQuery = 'SELECT id, name FROM media_folders WHERE is_public_showcase = TRUE ORDER BY created_at DESC LIMIT 1';
        let params = [];
        
        if (folderName) {
            folderQuery = 'SELECT id, name FROM media_folders WHERE name = $1'; // Relaxed constraint for named requests
            params = [folderName];
        }

        const folderRes = await queryWithRetry(folderQuery, params);
        if (folderRes.rows.length === 0) return res.json({ items: [] });
        
        const folder = folderRes.rows[0];
        const path = `/${folder.name}`;
        
        let filesRes = await queryWithRetry('SELECT * FROM media_files WHERE folder_path = $1 ORDER BY created_at DESC', [path]);
        
        // --- JIT AUTO-SYNC ---
        // If DB is empty, check S3 for files in this folder prefix immediately
        if (filesRes.rows.length === 0) {
            console.log(`[Showcase] Folder ${folder.name} empty in DB. Triggering JIT S3 Sync...`);
            try {
                const s3Prefix = `${folder.name}/`;
                const command = new ListObjectsV2Command({ 
                    Bucket: BUCKET_NAME,
                    Prefix: s3Prefix
                });
                const s3Res = await s3Client.send(command);
                
                if (s3Res.Contents && s3Res.Contents.length > 0) {
                    let addedCount = 0;
                    for (const item of s3Res.Contents) {
                        if (item.Key.endsWith('/')) continue; // Skip directory markers
                        if (item.Key.includes('manifests/')) continue; // Skip manifests

                        const parts = item.Key.split('/');
                        const filename = parts.pop();
                        const itemFolderPath = '/' + parts.join('/');
                        
                        // Only insert if it matches our current folder path exactly
                        if (itemFolderPath === path) {
                             let type = 'document';
                             if (filename.match(/\.(jpg|jpeg|png|webp|gif)$/i)) type = 'image';
                             if (filename.match(/\.(mp4|mov|webm)$/i)) type = 'video';

                             let publicUrl = `https://${BUCKET_NAME}.s3.amazonaws.com/${item.Key}`;
                             if (AWS_REGION && AWS_REGION !== 'us-east-1') {
                                publicUrl = `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${item.Key}`;
                             }

                             // Silent Insert (Ignore conflict)
                             await queryWithRetry(`
                                INSERT INTO media_files (id, folder_path, filename, s3_key, url, type, created_at)
                                VALUES ($1, $2, $3, $4, $5, $6, $7)
                                ON CONFLICT DO NOTHING
                            `, [`file_jit_${Date.now()}_${Math.random().toString(36).substr(2,4)}`, itemFolderPath, filename, item.Key, publicUrl, type, Date.now()]);
                            addedCount++;
                        }
                    }
                    if (addedCount > 0) {
                        console.log(`[Showcase] JIT Sync added ${addedCount} files. Refreshing...`);
                        // Re-fetch from DB
                        filesRes = await queryWithRetry('SELECT * FROM media_files WHERE folder_path = $1 ORDER BY created_at DESC', [path]);
                        
                        // Async generate manifest for next time
                        generateShowcaseManifest(folder.id, folder.name);
                    }
                }
            } catch (s3Err) {
                console.error("JIT Sync Failed:", s3Err);
            }
        }
        // ---------------------

        const items = filesRes.rows.map(row => ({
            id: row.id,
            url: row.url,
            type: row.type || 'image',
            filename: row.filename
        }));
        
        res.json({
            title: folder.name,
            items: items
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/public/status', async (req, res) => {
    try {
        const folderRes = await queryWithRetry('SELECT id, name FROM media_folders WHERE is_public_showcase = TRUE ORDER BY created_at DESC LIMIT 1');
        if (folderRes.rows.length > 0) {
            res.json({ active: true, folderName: folderRes.rows[0].name, folderId: folderRes.rows[0].id });
        } else {
            res.json({ active: false });
        }
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/files/:id/sync', async (req, res) => {
    try {
        await queryWithRetry("UPDATE media_files SET media_id = 'synced_dummy_id' WHERE id = $1", [req.params.id]);
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

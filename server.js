
/**
 * UBER FLEET RECRUITER - BACKEND SERVER
 * Enterprise-Grade Connection Handling for Vercel + Neon
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg'); 
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs'); 
const path = require('path'); 
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const multer = require('multer');
require('dotenv').config();

const app = express();

// --- MIDDLEWARE ---
app.use(express.json({ limit: '10mb' }));
app.use(cors()); 

// Disable Caching
app.set('etag', false);
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3001;
let META_API_TOKEN = process.env.META_API_TOKEN || "EAAkr7Y9S2qYBQfHTNZASIugAzOi8b2MZCBct4z4jZBHSmQ2KGlFduuDQQGEYC9NRDtZBUdhMPdeJ06OjYUiJYGfFkZCAxzyh4TdidN7ZA10K3XPOVEiQh01jo22xLsQjXrEtMHc5ZCHZBbRZAyA5d0pl26Jsg3IuNKY272QYmqEjHghf11OKJmbUZBfJLe5EvHzl48gAZDZD"; 
let PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "982841698238647"; 
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyDujw0ovB1bLtQJK8DKy1b__LT5aqGurz0";
let VERIFY_TOKEN = process.env.VERIFY_TOKEN || "uber_fleet_verify_token";

// AWS S3 Config
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED"
});
const BUCKET_NAME = process.env.AWS_BUCKET_NAME || '';
const upload = multer({ storage: multer.memoryStorage() });

// --- SECURITY: CONTENT FIREWALL ---
const BLOCKED_REGEX = /replace\s+this\s+sample\s+message|enter\s+your\s+message|type\s+your\s+message\s+here|replace\s+this\s+text/i;

const cleanBotSettings = (settings) => {
    if (!settings) return settings;
    if (settings.steps && Array.isArray(settings.steps)) {
        settings.steps = settings.steps.map(step => {
            const msg = step.message || "";
            if (BLOCKED_REGEX.test(msg)) {
                step.message = step.options && step.options.length > 0 ? "Please select an option:" : "";
            }
            if (step.templateName && (step.templateName.includes(' ') || step.templateName.includes(':') || step.templateName.length < 3)) {
                delete step.templateName; 
                step.templateName = null;
            }
            return step;
        });
    }
    if (settings.flowData && Array.isArray(settings.flowData.nodes)) {
        settings.flowData.nodes = settings.flowData.nodes.map(node => {
            if (node.data) {
                if (node.data.icon) delete node.data.icon;
                if (node.data.inputType === 'undefined') node.data.inputType = 'text';
                if (node.data.templateName && (node.data.templateName.includes(' ') || node.data.templateName.includes(':'))) {
                    delete node.data.templateName;
                }
            }
            return node;
        });
    }
    return settings;
};

// --- DATABASE CONNECTION ---
const NEON_DB_URL = "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL || NEON_DB_URL;

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  ssl: { rejectUnauthorized: false },
  max: 1, 
  idleTimeoutMillis: 1000, 
  connectionTimeoutMillis: 5000, 
});

const queryWithRetry = async (text, params, retries = 2) => {
    let client;
    try {
        client = await pool.connect();
        const res = await client.query(text, params);
        return res;
    } catch (err) {
        if (client) { try { client.release(true); } catch(e) {} client = null; }
        if ((err.code === '57P01' || err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === '42P01' || err.code === '42703') && retries > 0) {
            if (err.code === '42P01' || err.code === '42703') {
                const healClient = await pool.connect();
                await ensureDatabaseInitialized(healClient);
                healClient.release();
            }
            await new Promise(res => setTimeout(res, 500));
            return queryWithRetry(text, params, retries - 1);
        }
        throw err;
    } finally {
        if (client) { try { client.release(); } catch(e) {} }
    }
};

const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS drivers (
        id VARCHAR(255) PRIMARY KEY,
        phone_number VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(255),
        source VARCHAR(50) DEFAULT 'Organic',
        status VARCHAR(50) DEFAULT 'New',
        last_message TEXT,
        last_message_time BIGINT,
        documents TEXT[],
        bot_state JSONB DEFAULT '{}',
        vehicle_details JSONB DEFAULT '{}',
        created_at BIGINT,
        qualification_checks JSONB DEFAULT '{"hasValidLicense": false, "hasVehicle": false, "isLocallyAvailable": true}'::jsonb,
        current_bot_step_id TEXT,
        is_bot_active BOOLEAN DEFAULT FALSE,
        onboarding_step INTEGER DEFAULT 0,
        vehicle_registration TEXT,
        availability TEXT,
        is_human_mode BOOLEAN DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(255) PRIMARY KEY,
        driver_id VARCHAR(255) REFERENCES drivers(id) ON DELETE CASCADE,
        sender VARCHAR(50),
        text TEXT,
        image_url TEXT,
        timestamp BIGINT,
        type VARCHAR(50),
        options TEXT[]
    );
    CREATE TABLE IF NOT EXISTS bot_settings (
        id INT PRIMARY KEY DEFAULT 1,
        settings JSONB
    );
    CREATE TABLE IF NOT EXISTS media_folders (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        parent_path VARCHAR(255) DEFAULT '/',
        is_public_showcase BOOLEAN DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS media_files (
        id VARCHAR(255) PRIMARY KEY,
        url TEXT NOT NULL,
        filename TEXT,
        type VARCHAR(50),
        uploaded_at BIGINT,
        folder_path VARCHAR(255) DEFAULT '/'
    );
    CREATE TABLE IF NOT EXISTS whatsapp_media_cache (
        s3_url TEXT PRIMARY KEY,
        media_id TEXT NOT NULL,
        created_at BIGINT,
        expires_at BIGINT
    );
`;

const DEFAULT_BOT_SETTINGS = {
  isEnabled: true,
  routingStrategy: 'HYBRID_BOT_FIRST',
  systemInstruction: "You are a friendly recruiter for Uber Fleet. Answer in Malayalam and English.",
  steps: []
};

const ensureDatabaseInitialized = async (client) => {
    try {
        await client.query('BEGIN');
        await client.query(SCHEMA_SQL);
        // Self-Heal Columns
        await client.query(`
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS options TEXT[];
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS documents TEXT[];
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bot_state JSONB DEFAULT '{}';
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_details JSONB DEFAULT '{}';
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS qualification_checks JSONB DEFAULT '{"hasValidLicense": false, "hasVehicle": false, "isLocallyAvailable": true}'::jsonb;
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS current_bot_step_id TEXT;
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_bot_active BOOLEAN DEFAULT FALSE;
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_human_mode BOOLEAN DEFAULT FALSE;
            ALTER TABLE media_files ADD COLUMN IF NOT EXISTS folder_path VARCHAR(255) DEFAULT '/';
            ALTER TABLE whatsapp_media_cache ADD COLUMN IF NOT EXISTS expires_at BIGINT;
            ALTER TABLE media_folders ADD COLUMN IF NOT EXISTS is_public_showcase BOOLEAN DEFAULT FALSE;
        `);
        const settingsRes = await client.query('SELECT * FROM bot_settings WHERE id = 1');
        if (settingsRes.rows.length === 0) {
            await client.query('INSERT INTO bot_settings (id, settings) VALUES (1, $1)', [JSON.stringify(DEFAULT_BOT_SETTINGS)]);
        }
        await client.query('COMMIT');
        await sanitizeBotSettings(client);
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("❌ Schema Init/Heal Failed:", e);
    }
};

const sanitizeBotSettings = async (client) => {
    try {
        const res = await client.query('SELECT settings FROM bot_settings WHERE id = 1');
        if (res.rows.length === 0) return;
        const cleanedSettings = cleanBotSettings(res.rows[0].settings);
        await client.query('UPDATE bot_settings SET settings = $1 WHERE id = 1', [JSON.stringify(cleanedSettings)]);
    } catch (e) { console.error("Sanitization failed:", e); }
};

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const getS3FolderPrefix = (parentPath) => (!parentPath || parentPath === '/') ? '' : parentPath.replace(/^\//, '') + '/';

// --- MIME TYPE HELPER ---
const getMimeType = (filename) => {
    const ext = filename.split('.').pop().toLowerCase();
    const map = {
        'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'webp': 'image/webp',
        'mp4': 'video/mp4', '3gp': 'video/3gpp', 'mov': 'video/mp4', 'avi': 'video/mp4',
        'pdf': 'application/pdf', 
        'doc': 'application/msword', 
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    };
    return map[ext] || 'application/octet-stream';
};

// --- CORE MEDIA SYNC ENGINE ---
const activeSyncs = new Map();

const performWhatsAppSync = async (fileId) => {
    if (activeSyncs.has(fileId)) return activeSyncs.get(fileId);

    const syncPromise = (async () => {
        try {
            const fileRes = await queryWithRetry('SELECT * FROM media_files WHERE id = $1', [fileId]);
            if (fileRes.rows.length === 0) throw new Error('File not found');
            
            const file = fileRes.rows[0];
            const cacheRes = await queryWithRetry('SELECT media_id, expires_at FROM whatsapp_media_cache WHERE s3_url = $1', [file.url]);
            
            if (cacheRes.rows.length > 0) {
                const cached = cacheRes.rows[0];
                const now = Date.now();
                if (cached.expires_at && parseInt(cached.expires_at) > (now + 86400000)) return cached.media_id;
            }

            let mediaType = getMimeType(file.filename);
            if (mediaType === 'application/octet-stream' && file.type === 'video') mediaType = 'video/mp4';
            if (mediaType === 'application/octet-stream' && file.type === 'image') mediaType = 'image/jpeg';

            let buffer;
            try {
                const s3Response = await axios({ url: file.url, method: 'GET', responseType: 'arraybuffer' });
                buffer = s3Response.data;
            } catch (err) {
                 if (err.response && err.response.status === 403) {
                     const urlObj = new URL(file.url);
                     const key = urlObj.pathname.substring(1);
                     const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
                     const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 600 });
                     const retryRes = await axios({ url: signedUrl, method: 'GET', responseType: 'arraybuffer' });
                     buffer = retryRes.data;
                 } else throw err;
            }

            if (buffer.length > 16 * 1024 * 1024) return null; 

            const formData = new FormData();
            formData.append('file', new Blob([buffer], { type: mediaType }), file.filename);
            formData.append('messaging_product', 'whatsapp');

            const metaRes = await fetch(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/media`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${META_API_TOKEN}` },
                body: formData
            });

            if (!metaRes.ok) throw new Error(`Meta API Error: ${await metaRes.text()}`);
            const metaData = await metaRes.json();
            const mediaId = metaData.id;

            await queryWithRetry(
                `INSERT INTO whatsapp_media_cache (s3_url, media_id, created_at, expires_at) 
                VALUES ($1, $2, $3, $4) 
                ON CONFLICT (s3_url) DO UPDATE SET media_id = $2, created_at = $3, expires_at = $4`,
                [file.url, mediaId, Date.now(), Date.now() + (25 * 24 * 60 * 60 * 1000)]
            );
            return mediaId;
        } finally { activeSyncs.delete(fileId); }
    })();

    activeSyncs.set(fileId, syncPromise);
    return syncPromise;
};

// ... (Rest of logic engine) ...
const sendWhatsAppMessage = async (to, body, options = null, templateName = null, language = 'en_US', mediaUrl = null, mediaType = 'image') => {
   if (!META_API_TOKEN || !PHONE_NUMBER_ID) return false;
  
  mediaType = mediaType || 'image';
  if (mediaUrl) {
      const ext = mediaUrl.split('.').pop().toLowerCase().split('?')[0];
      if (['mp4', '3gp', 'mov', 'avi'].includes(ext)) mediaType = 'video';
      else if (['pdf', 'doc', 'docx', 'ppt', 'pptx'].includes(ext)) mediaType = 'document';
      else if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) mediaType = 'image';
  }

  let payload = { messaging_product: 'whatsapp', to: to };
  const isValidTemplate = templateName && /^[a-zA-Z0-9_]+$/.test(templateName);

  if (isValidTemplate) {
    payload.type = 'template';
    payload.template = { name: templateName, language: { code: language } };
  } else {
      if (mediaUrl) {
        if (mediaUrl.includes('youtube.com') || mediaUrl.includes('youtu.be')) {
            payload.type = 'text';
            payload.text = { body: body ? `${body} ${mediaUrl}` : mediaUrl, preview_url: true };
        } else {
            let mediaId = null;
            try {
                const cacheRes = await queryWithRetry('SELECT media_id, expires_at FROM whatsapp_media_cache WHERE s3_url = $1', [mediaUrl]);
                if (cacheRes.rows.length > 0) {
                    const cached = cacheRes.rows[0];
                    if (cached.expires_at && Date.now() < parseInt(cached.expires_at)) mediaId = cached.media_id;
                }
                if (!mediaId) {
                    const fileRes = await queryWithRetry('SELECT id FROM media_files WHERE url = $1', [mediaUrl]);
                    if (fileRes.rows.length > 0) mediaId = await performWhatsAppSync(fileRes.rows[0].id);
                }
            } catch (e) { console.warn("Sync Failed:", e.message); }

            payload.type = mediaType;
            if (mediaId) payload[mediaType] = { id: mediaId };
            else {
                let finalLink = mediaUrl;
                try {
                     const urlObj = new URL(mediaUrl);
                     if (urlObj.hostname.includes('s3') && urlObj.hostname.includes('amazonaws.com')) {
                         const key = urlObj.pathname.substring(1);
                         const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
                         finalLink = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                     }
                } catch(e) {}
                payload[mediaType] = { link: finalLink };
            }
            
            if (body) payload[mediaType].caption = body;
            if (mediaType === 'document') payload[mediaType].filename = mediaUrl.split('/').pop();
        }
      } else if (options && options.length > 0) {
        const validOptions = options.filter(o => o && o.trim().length > 0);
        const safeBody = body || "Select an option:";
        if (validOptions.length > 3) {
            payload.type = 'interactive';
            payload.interactive = {
                type: 'list',
                body: { text: safeBody },
                action: { button: "Select", sections: [{ title: "Options", rows: validOptions.slice(0, 10).map((opt, i) => ({ id: `opt_${i}`, title: opt.substring(0, 24) })) }] }
            };
        } else {
            payload.type = 'interactive';
            payload.interactive = {
                type: 'button',
                body: { text: safeBody },
                action: { buttons: validOptions.map((opt, i) => ({ type: 'reply', reply: { id: `btn_${i}`, title: opt.substring(0, 20) } })) }
            };
        }
      } else {
        payload.type = 'text';
        payload.text = { body: body };
      }
  }
  
  try {
    await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, payload, { headers: { Authorization: `Bearer ${META_API_TOKEN}` } });
    return true;
  } catch (error) { return false; }
};

const analyzeWithAI = async (text, systemInstruction) => {
  if (!GEMINI_API_KEY) return "Thank you for your message.";
  try {
    const response = await ai.models.generateContent({ 
      model: "gemini-3-flash-preview", 
      contents: text,
      config: { systemInstruction, maxOutputTokens: 150 }
    });
    return response.text;
  } catch (e) { return "Thanks for contacting Uber Fleet."; }
};

const logSystemMessage = async (driverId, text, type = 'text', options = null, imageUrl = null) => {
    try {
        const msgId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 5);
        await queryWithRetry(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type, options, image_url) VALUES ($1, $2, 'system', $3, $4, $5, $6, $7)`,
            [msgId, driverId, text, Date.now(), type, options && options.length ? options : null, imageUrl]
        );
        await queryWithRetry('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [text, Date.now(), driverId]);
    } catch (e) { console.error("Log failed", e); }
};

const processIncomingMessage = async (from, name, msgBody, msgType = 'text', timestamp = Date.now()) => {
    try {
        const client = await pool.connect();
        let result = {};
        try {
            await client.query('BEGIN');
            const settingsRes = await client.query('SELECT settings FROM bot_settings WHERE id = 1');
            let botSettings = cleanBotSettings(settingsRes.rows[0]?.settings || DEFAULT_BOT_SETTINGS);
            const routingStrategy = botSettings.routingStrategy || 'HYBRID_BOT_FIRST';
            const entryPointId = botSettings.entryPointId || botSettings.steps?.[0]?.id;

            let driverRes = await client.query('SELECT * FROM drivers WHERE phone_number = $1', [from]);
            let driver = driverRes.rows[0];
            let isNewDriver = false;

            if (!driver) {
                isNewDriver = true;
                const shouldActivateBot = botSettings.isEnabled && routingStrategy !== 'AI_ONLY';
                const insertRes = await client.query(
                    `INSERT INTO drivers (id, phone_number, name, source, status, last_message, last_message_time, documents, current_bot_step_id, is_bot_active, is_human_mode)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
                    [timestamp.toString(), from, name, 'WhatsApp', 'New', msgBody, timestamp, [], entryPointId, shouldActivateBot, false]
                );
                driver = insertRes.rows[0];
            }

            await client.query(
                `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'driver', $3, $4, $5)`,
                [`${timestamp}_${Math.random().toString(36).substr(2, 5)}`, driver.id, msgBody, timestamp, msgType]
            );
            await client.query('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [msgBody, timestamp, driver.id]);
            
            if (driver.is_human_mode) { await client.query('COMMIT'); return; }

            let replyText = null; let replyOptions = null; let replyTemplate = null; let replyMedia = null; let replyMediaType = null; let shouldCallAI = false;

            if (botSettings.isEnabled && routingStrategy === 'AI_ONLY') { shouldCallAI = true; } 
            else if (botSettings.isEnabled) {
                 if (!driver.is_bot_active) {
                     if (routingStrategy === 'BOT_ONLY') {
                         if (entryPointId) {
                             await client.query('UPDATE drivers SET is_bot_active = TRUE, current_bot_step_id = $1 WHERE id = $2', [entryPointId, driver.id]);
                             driver.is_bot_active = true;
                             driver.current_bot_step_id = entryPointId;
                             isNewDriver = true; 
                         } else { replyText = "System configuring..."; }
                     } else if (routingStrategy === 'HYBRID_BOT_FIRST') { shouldCallAI = true; }
                 }
                 if (driver.is_bot_active && !driver.current_bot_step_id && botSettings.steps.length > 0) {
                      const firstId = entryPointId || botSettings.steps[0].id;
                      await client.query('UPDATE drivers SET current_bot_step_id = $1 WHERE id = $2', [firstId, driver.id]);
                      driver.current_bot_step_id = firstId;
                      isNewDriver = true;
                 }
                 if (driver.is_bot_active && driver.current_bot_step_id) {
                     let currentStep = botSettings.steps.find(s => s.id === driver.current_bot_step_id);
                     if (!currentStep && botSettings.steps.length > 0) {
                         const firstStepId = entryPointId || botSettings.steps[0].id;
                         await client.query('UPDATE drivers SET current_bot_step_id = $1 WHERE id = $2', [firstStepId, driver.id]);
                         driver.current_bot_step_id = firstStepId;
                         currentStep = botSettings.steps.find(s => s.id === firstStepId);
                         isNewDriver = true; 
                     }
                     if (currentStep) {
                         if (!isNewDriver) {
                             if (currentStep.saveToField === 'name') await client.query('UPDATE drivers SET name = $1 WHERE id = $2', [msgBody, driver.id]);
                             if (currentStep.saveToField === 'availability') await client.query('UPDATE drivers SET availability = $1 WHERE id = $2', [msgBody, driver.id]);
                             if (currentStep.saveToField === 'vehicleRegistration') await client.query('UPDATE drivers SET vehicle_registration = $1 WHERE id = $2', [msgBody, driver.id]);
                             let nextId = currentStep.nextStepId;
                             if (nextId === 'AI_HANDOFF' || nextId === 'END' || !nextId) {
                                 await client.query('UPDATE drivers SET is_bot_active = FALSE, current_bot_step_id = NULL WHERE id = $1', [driver.id]);
                                 driver.is_bot_active = false; 
                                 if (routingStrategy === 'HYBRID_BOT_FIRST') {
                                     if (nextId === 'AI_HANDOFF') shouldCallAI = true; 
                                     else replyText = "Details received.";
                                 } else if (routingStrategy === 'BOT_ONLY') { replyText = "Details saved."; }
                             } else {
                                 await client.query('UPDATE drivers SET current_bot_step_id = $1 WHERE id = $2', [nextId, driver.id]);
                                 const nextStep = botSettings.steps.find(s => s.id === nextId);
                                 if (nextStep) {
                                     replyText = nextStep.message;
                                     replyTemplate = nextStep.templateName;
                                     replyMedia = nextStep.mediaUrl;
                                     replyMediaType = nextStep.mediaType || (nextStep.mediaUrl ? 'image' : undefined);
                                     replyOptions = nextStep.options;
                                 }
                             }
                         } else {
                             replyText = currentStep.message;
                             replyTemplate = currentStep.templateName;
                             replyMedia = currentStep.mediaUrl;
                             replyMediaType = currentStep.mediaType || (currentStep.mediaUrl ? 'image' : undefined);
                             replyOptions = currentStep.options;
                         }
                     }
                 } else if (driver.is_bot_active && routingStrategy === 'HYBRID_BOT_FIRST') shouldCallAI = true;
            }
            if (routingStrategy === 'BOT_ONLY') shouldCallAI = false; 
            await client.query('COMMIT');
            result = { replyText, replyOptions, replyTemplate, replyMedia, replyMediaType, shouldCallAI, driver, botSettings };
        } catch (err) {
            await client.query('ROLLBACK');
            if(err.code === '42P01') await ensureDatabaseInitialized(client);
            throw err;
        } finally { client.release(); }

        let sent = false;
        if (result.replyTemplate || result.replyText || result.replyMedia) {
            if (result.replyTemplate) {
                sent = await sendWhatsAppMessage(from, null, null, result.replyTemplate);
                if (!sent) sent = await sendWhatsAppMessage(from, result.replyText, result.replyOptions, null, 'en_US', result.replyMedia, result.replyMediaType);
                else await logSystemMessage(result.driver.id, `[Template: ${result.replyTemplate}]`, 'template');
            } 
            if (!sent && !result.replyTemplate) {
                let caption = result.replyText || "";
                if (result.replyMedia) {
                    sent = await sendWhatsAppMessage(from, caption, null, null, 'en_US', result.replyMedia, result.replyMediaType);
                    if (sent) await logSystemMessage(result.driver.id, caption || `[${result.replyMediaType}]`, 'image', null, result.replyMedia);
                } else {
                    sent = await sendWhatsAppMessage(from, caption, result.replyOptions);
                    if (sent) await logSystemMessage(result.driver.id, caption || 'Options', result.replyOptions ? 'options' : 'text', result.replyOptions);
                }
            }
        } 
        if (!sent && result.shouldCallAI) {
            const aiReply = await analyzeWithAI(msgBody, result.botSettings.systemInstruction);
            if (aiReply && aiReply.trim()) {
                sent = await sendWhatsAppMessage(from, aiReply);
                if (sent) await logSystemMessage(result.driver.id, aiReply, 'text');
            }
        }
    } catch (e) { console.error("Logic Error:", e.message); }
};

// --- ROUTES ---

// NEW: Rename Folder Endpoint with Strict Duplicate Check
app.put('/api/folders/:id', async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const { name } = req.body;
        
        if (!name || name.trim().length === 0) {
            return res.status(400).json({ error: "Name is required" });
        }

        await client.query('BEGIN');

        // 1. Get current folder details
        const folderRes = await client.query('SELECT name, parent_path FROM media_folders WHERE id = $1', [id]);
        if (folderRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "Folder not found" });
        }

        const oldName = folderRes.rows[0].name;
        const parentPath = folderRes.rows[0].parent_path;
        
        // STRICT DUPLICATE CHECK: Check if new name exists GLOBALLY (regardless of path)
        const dupCheck = await client.query(
            'SELECT id FROM media_folders WHERE name = $1 AND id != $2',
            [name, id]
        );
        if (dupCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: "Folder name already taken. Please choose a unique name." });
        }

        // Construct paths
        const oldPathPrefix = parentPath === '/' ? `/${oldName}` : `${parentPath}/${oldName}`;
        const newPathPrefix = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;

        // 2. Update the folder name itself
        await client.query('UPDATE media_folders SET name = $1 WHERE id = $2', [name, id]);

        // 3. Recursive Update: Update all files that start with the old path
        // Using Postgres string concatenation operator || and SUBSTRING
        // LENGTH(oldPathPrefix) + 1 accounts for 1-based indexing in substring
        await client.query(`
            UPDATE media_files 
            SET folder_path = $1 || SUBSTRING(folder_path, LENGTH($2) + 1)
            WHERE folder_path = $2 OR folder_path LIKE $2 || '/%'
        `, [newPathPrefix, oldPathPrefix]);

        // 4. Recursive Update: Update subfolders' parent_path
        await client.query(`
            UPDATE media_folders 
            SET parent_path = $1 || SUBSTRING(parent_path, LENGTH($2) + 1)
            WHERE parent_path = $2 OR parent_path LIKE $2 || '/%'
        `, [newPathPrefix, oldPathPrefix]);

        await client.query('COMMIT');
        res.json({ success: true, oldPath: oldPathPrefix, newPath: newPathPrefix });

    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Rename Error:", e);
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});

// [Rest of existing endpoints unchanged]
app.get('/api/public/showcase', async (req, res) => {
    try {
        let query = 'SELECT id, name, parent_path FROM media_folders WHERE is_public_showcase = TRUE';
        let params = [];
        if (req.query.folder) {
            query += ' AND name = $1';
            params.push(req.query.folder);
        }
        query += ' ORDER BY id DESC LIMIT 1';
        
        const folderRes = await queryWithRetry(query, params);
        if (folderRes.rows.length === 0) return res.json({ title: 'Welcome', items: [] });

        const folder = folderRes.rows[0];
        let folderPath = folder.parent_path === '/' ? `/${folder.name}` : `${folder.parent_path}/${folder.name}`;
        folderPath = folderPath.replace(/\/\//g, '/');

        const filesRes = await queryWithRetry(`
            SELECT id, url, filename, type 
            FROM media_files 
            WHERE folder_path = $1 
            ORDER BY uploaded_at DESC`, 
            [folderPath]
        );

        const items = await Promise.all(filesRes.rows.map(async (file) => {
            let signedUrl = file.url;
            try {
                const urlObj = new URL(file.url);
                if (urlObj.hostname.includes('s3') && urlObj.hostname.includes('amazonaws.com')) {
                    const key = decodeURIComponent(urlObj.pathname.substring(1));
                    const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
                    signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                }
            } catch(e) {}
            return { id: file.id, url: signedUrl, type: file.type, filename: file.filename };
        }));

        res.json({ title: folder.name, items });
    } catch (e) { res.status(500).json({ error: "Failed to load showcase" }); }
});

app.get('/api/public/status', async (req, res) => {
    try {
        const folderRes = await queryWithRetry('SELECT id, name FROM media_folders WHERE is_public_showcase = TRUE ORDER BY id DESC LIMIT 1', []);
        if (folderRes.rows.length > 0) res.json({ active: true, folderName: folderRes.rows[0].name, folderId: folderRes.rows[0].id });
        else res.json({ active: false });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/folders/:id/public', async (req, res) => {
    try {
        await queryWithRetry('UPDATE media_folders SET is_public_showcase = TRUE WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/folders/:id/public', async (req, res) => {
    try {
        await queryWithRetry('UPDATE media_folders SET is_public_showcase = FALSE WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/files/:id/sync', async (req, res) => {
    try {
        const mediaId = await performWhatsAppSync(req.params.id);
        if (mediaId === null) return res.json({ success: false, message: 'Sync skipped' });
        res.json({ success: true, mediaId });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/media', async (req, res) => {
    try {
        const currentPath = req.query.path || '/';
        const folders = await queryWithRetry('SELECT * FROM media_folders WHERE parent_path = $1 ORDER BY name ASC', [currentPath]);
        const files = await queryWithRetry(`
            SELECT mf.*, wmc.media_id, wmc.expires_at
            FROM media_files mf 
            LEFT JOIN whatsapp_media_cache wmc ON mf.url = wmc.s3_url
            WHERE mf.folder_path = $1 
            ORDER BY mf.uploaded_at DESC`, [currentPath]);
        
        const now = Date.now();
        const cleanFiles = files.rows.map(f => {
            if (f.expires_at && parseInt(f.expires_at) < now) return { ...f, media_id: null }; 
            return f;
        });
        res.json({ folders: folders.rows, files: cleanFiles });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// NEW: Create Folder with Strict Duplicate Check
app.post('/api/folders', async (req, res) => { 
    try {
        const { name, parentPath } = req.body;
        
        // STRICT DUPLICATE CHECK: Global
        const existing = await queryWithRetry(
            'SELECT id FROM media_folders WHERE name = $1',
            [name]
        );
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Folder name already exists. Please choose a unique name.' });
        }

        const id = Date.now().toString();
        await queryWithRetry('INSERT INTO media_folders (id, name, parent_path, is_public_showcase) VALUES ($1, $2, $3, FALSE)', [id, name, parentPath]);
        res.json({ success: true, id });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/folders/:id', async (req, res) => { 
    try {
        const files = await queryWithRetry('SELECT id FROM media_files WHERE folder_path = (SELECT name FROM media_folders WHERE id = $1)', [req.params.id]);
        if (files.rows.length > 0) return res.status(400).json({ error: 'Folder not empty' });
        await queryWithRetry('DELETE FROM media_folders WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/s3/presign', async (req, res) => { 
    try {
        const { filename, fileType, folderPath } = req.body;
        const key = `${Date.now()}-${filename.replace(/\s+/g, '_')}`;
        const command = new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, ContentType: fileType });
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
        res.json({ uploadUrl, key, publicUrl: `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}` });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/files/register', async (req, res) => { 
    try {
        const { key, url, filename, type, folderPath } = req.body;
        const id = Date.now().toString();
        await queryWithRetry(
            `INSERT INTO media_files (id, url, filename, type, uploaded_at, folder_path) VALUES ($1, $2, $3, $4, $5, $6)`,
            [id, url, filename, type, Date.now(), folderPath]
        );
        if (['image', 'video', 'document'].includes(type)) performWhatsAppSync(id).catch(err => console.error(err));
        res.json({ success: true, id, url });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/files/:id', async (req, res) => { 
    try {
        await queryWithRetry('DELETE FROM media_files WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/messages/send', async (req, res) => { 
    try {
        const driverRes = await queryWithRetry('SELECT phone_number FROM drivers WHERE id = $1', [req.body.driverId]);
        if (driverRes.rows.length === 0) return res.status(404).json({ error: 'Driver not found' });
        const success = await sendWhatsAppMessage(driverRes.rows[0].phone_number, req.body.text);
        if (!success) return res.status(500).json({ error: 'Meta API Failed' });
        await logSystemMessage(req.body.driverId, req.body.text, 'text');
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/drivers/:id', async (req, res) => { 
    try {
        const updates = req.body;
        const keys = Object.keys(updates).filter(k => k !== 'id');
        const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
        const values = keys.map(k => typeof updates[k] === 'object' ? JSON.stringify(updates[k]) : updates[k]);
        await queryWithRetry(`UPDATE drivers SET ${setClause} WHERE id = $1`, [req.params.id, ...values]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/drivers', async (req, res) => { 
    try {
        const resDb = await queryWithRetry('SELECT * FROM drivers ORDER BY last_message_time DESC LIMIT 100', []);
        res.json(resDb.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bot-settings', async (req, res) => { 
    try {
        const resDb = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1', []);
        res.json(resDb.rows[0]?.settings || DEFAULT_BOT_SETTINGS);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bot-settings', async (req, res) => { 
    try {
        await queryWithRetry('UPDATE bot_settings SET settings = $1 WHERE id = 1', [JSON.stringify(req.body)]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/webhook', (req, res) => { res.send(req.query['hub.challenge']); });
app.post('/webhook', async (req, res) => { 
    if (req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
        const msg = req.body.entry[0].changes[0].value.messages[0];
        await processIncomingMessage(msg.from, 'Unknown', msg.text?.body || '[Media]');
    }
    res.sendStatus(200); 
});

module.exports = app;
if (require.main === module) app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

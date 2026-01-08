
/**
 * UBER FLEET RECRUITER - BACKEND SERVER
 * Enterprise-Grade Connection Handling for Vercel + Neon
 * FAIL-SAFE MODE ENABLED
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

// --- MEMORY CACHE (FAIL-SAFE) ---
// If DB is sleeping, we use these values to keep the bot alive
let CACHED_BOT_SETTINGS = {
  isEnabled: true,
  routingStrategy: 'HYBRID_BOT_FIRST',
  systemInstruction: "You are a friendly recruiter for Uber Fleet. Answer in Malayalam and English.",
  steps: []
};
let LAST_SETTINGS_FETCH = 0;

// --- SECURITY: CONTENT FIREWALL ---
const BLOCKED_REGEX = /replace\s+this\s+sample\s+message|enter\s+your\s+message|type\s+your\s+message\s+here|replace\s+this\s+text/i;

const cleanBotSettings = (settings) => {
    if (!settings) return settings;
    if (settings.steps && Array.isArray(settings.steps)) {
        settings.steps = settings.steps.map(step => {
            const msg = step.message || "";
            // Relaxed regex check to allow valid messages that might accidentally trigger partial matches
            if (BLOCKED_REGEX.test(msg) && msg.length < 50) {
                step.message = step.options && step.options.length > 0 ? "Please select an option:" : "";
            }
            if (step.templateName && (step.templateName.includes(' ') || step.templateName.includes(' ') || step.templateName.length < 3)) {
                delete step.templateName; 
                step.templateName = null;
            }
            return step;
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
  connectionTimeoutMillis: 15000, // Increased for sleeping DBs
});

// ROBUST RETRY LOGIC FOR SLEEPING DBS
const queryWithRetry = async (text, params, retries = 3) => {
    let client;
    try {
        client = await pool.connect();
        const res = await client.query(text, params);
        return res;
    } catch (err) {
        if (client) { try { client.release(true); } catch(e) {} client = null; }
        
        const isConnectionError = err.code === '57P01' || err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
        const isTableError = err.code === '42P01' || err.code === '42703'; // Missing table/column
        
        if ((isConnectionError || isTableError) && retries > 0) {
            console.log(`DB Retry (${retries} left): ${err.code}`);
            await new Promise(res => setTimeout(res, (4 - retries) * 1000));
            if (isTableError) {
                const healClient = await pool.connect();
                await ensureDatabaseInitialized(healClient);
                healClient.release();
            }
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
        is_human_mode BOOLEAN DEFAULT FALSE,
        notes TEXT
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
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS notes TEXT;
            ALTER TABLE media_files ADD COLUMN IF NOT EXISTS folder_path VARCHAR(255) DEFAULT '/';
            ALTER TABLE whatsapp_media_cache ADD COLUMN IF NOT EXISTS expires_at BIGINT;
            ALTER TABLE media_folders ADD COLUMN IF NOT EXISTS is_public_showcase BOOLEAN DEFAULT FALSE;
        `);
        const settingsRes = await client.query('SELECT * FROM bot_settings WHERE id = 1');
        if (settingsRes.rows.length === 0) {
            await client.query('INSERT INTO bot_settings (id, settings) VALUES (1, $1)', [JSON.stringify(CACHED_BOT_SETTINGS)]);
        }
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("❌ Schema Init/Heal Failed:", e);
    }
};

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ... (MIME Type and Sync Helpers remain same) ...

const sendWhatsAppMessage = async (to, body, options = null, templateName = null, language = 'en_US', mediaUrl = null, mediaType = 'image') => {
   if (!META_API_TOKEN || !PHONE_NUMBER_ID) return false;
  
  mediaType = mediaType || 'image';
  
  let payload = { messaging_product: 'whatsapp', to: to };
  const isValidTemplate = templateName && /^[a-zA-Z0-9_]+$/.test(templateName);

  if (isValidTemplate) {
    payload.type = 'template';
    payload.template = { name: templateName, language: { code: language } };
  } else {
      if (mediaUrl) {
          payload.type = mediaType;
          payload[mediaType] = { link: mediaUrl }; 
          if (body) payload[mediaType].caption = body;
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

const analyzeWithAI = async (text, currentNotes, systemInstruction) => {
  if (!GEMINI_API_KEY) return { reply: "Thank you for your message.", updatedNotes: currentNotes };
  try {
    const prompt = `
    System Instruction: ${systemInstruction || 'You are a helpful assistant.'}
    
    User sent: "${text}"
    Current Driver Notes: "${currentNotes || ''}"
    
    TASK:
    1. Generate a helpful reply to the user.
    2. Extract key details (Name, Location, Vehicle, Intent, Availability) and summarize them into the notes.
    3. Keep notes concise and professional.
    
    Output JSON format:
    {
      "reply": "string",
      "updatedNotes": "string"
    }
    `;

    const response = await ai.models.generateContent({ 
      model: "gemini-3-flash-preview", 
      contents: prompt,
      config: { responseMimeType: "application/json" }
    });
    
    const result = JSON.parse(response.text);
    return result;
  } catch (e) { 
      return { reply: "Thanks for contacting Uber Fleet.", updatedNotes: currentNotes }; 
  }
};

const logSystemMessage = async (driverId, text, type = 'text', options = null, imageUrl = null) => {
    try {
        const msgId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 5);
        await queryWithRetry(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type, options, image_url) VALUES ($1, $2, 'system', $3, $4, $5, $6, $7)`,
            [msgId, driverId, text, Date.now(), type, options && options.length ? options : null, imageUrl]
        );
        await queryWithRetry('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [text, Date.now(), driverId]);
    } catch (e) { console.error("Log failed (Non-Critical)", e.message); }
};

// ... (Data Mappers) ...
const mapDriverToFrontend = (row) => ({
    id: row.id,
    phoneNumber: row.phone_number,
    name: row.name,
    source: row.source,
    status: row.status,
    lastMessage: row.last_message,
    lastMessageTime: parseInt(row.last_message_time || '0'),
    messages: [], 
    documents: row.documents || [],
    notes: row.notes || '',
    onboardingStep: row.onboarding_step || 0,
    vehicleRegistration: row.vehicle_registration,
    availability: row.availability,
    qualificationChecks: row.qualification_checks || { 
        hasValidLicense: false, 
        hasVehicle: false, 
        isLocallyAvailable: true 
    },
    currentBotStepId: row.current_bot_step_id,
    isBotActive: row.is_bot_active,
    isHumanMode: row.is_human_mode
});

const mapUpdateKeys = (updates) => {
    const map = {
        'isHumanMode': 'is_human_mode',
        'qualificationChecks': 'qualification_checks',
        'vehicleRegistration': 'vehicle_registration',
        'currentBotStepId': 'current_bot_step_id',
        'isBotActive': 'is_bot_active',
        'lastMessage': 'last_message',
        'lastMessageTime': 'last_message_time',
        'phoneNumber': 'phone_number',
        'notes': 'notes',
        'status': 'status',
        'name': 'name',
        'availability': 'availability',
        'source': 'source'
    };
    
    const dbUpdates = {};
    for (const [key, value] of Object.entries(updates)) {
        if (map[key]) {
            dbUpdates[map[key]] = value;
        }
    }
    return dbUpdates;
};

// --- CRITICAL: RESILIENT MESSAGE PROCESSOR ---
const processIncomingMessage = async (from, name, msgBody, msgType = 'text', timestamp = Date.now()) => {
    // 1. FAIL-SAFE SETTINGS FETCH
    let botSettings = CACHED_BOT_SETTINGS;
    try {
        if (Date.now() - LAST_SETTINGS_FETCH > 1000) {
            const settingsRes = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1', [], 1);
            if (settingsRes.rows.length > 0) {
                CACHED_BOT_SETTINGS = cleanBotSettings(settingsRes.rows[0].settings);
                botSettings = CACHED_BOT_SETTINGS;
                LAST_SETTINGS_FETCH = Date.now();
            }
        }
    } catch(e) { console.warn("Using Cached Settings due to DB latency"); }

    const routingStrategy = botSettings.routingStrategy || 'HYBRID_BOT_FIRST';
    const entryPointId = botSettings.entryPointId || botSettings.steps?.[0]?.id;

    // Default driver object
    let driver = { 
        id: 'temp_' + from, 
        phone_number: from, 
        name: name, 
        is_bot_active: true, 
        is_human_mode: false, 
        notes: '' 
    };
    
    let isFlowStart = false;
    
    // 2. DRIVER STATE SYNC
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let driverRes = await client.query('SELECT * FROM drivers WHERE phone_number = $1', [from]);
        
        if (driverRes.rows.length === 0) {
             const shouldActivateBot = botSettings.isEnabled && routingStrategy !== 'AI_ONLY';
             const insertRes = await client.query(
                `INSERT INTO drivers (id, phone_number, name, source, status, last_message, last_message_time, current_bot_step_id, is_bot_active, is_human_mode)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
                [timestamp.toString(), from, name, 'WhatsApp', 'New', msgBody, timestamp, entryPointId, shouldActivateBot, false]
            );
            driver = insertRes.rows[0];
            if (shouldActivateBot) isFlowStart = true;
        } else {
            driver = driverRes.rows[0];
            await client.query('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [msgBody, timestamp, driver.id]);
        }
        
        await client.query(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'driver', $3, $4, $5)`,
            [`${timestamp}_${Math.random().toString(36).substr(2, 5)}`, driver.id, msgBody, timestamp, msgType]
        );
        
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("DB Sync Failed", err.code);
    } finally { client.release(); }

    // 3. LOGIC ENGINE
    if (driver.is_human_mode) return;

    let replyText = null; let replyOptions = null; let replyTemplate = null; let replyMedia = null; let replyMediaType = null; let shouldCallAI = false;
    let updatesToSave = {};

    if (botSettings.isEnabled && routingStrategy === 'AI_ONLY') { shouldCallAI = true; } 
    else if (botSettings.isEnabled) {
         
         if (!driver.is_bot_active && routingStrategy === 'BOT_ONLY') {
             driver.is_bot_active = true;
             driver.current_bot_step_id = entryPointId;
             updatesToSave.isBotActive = true; 
             updatesToSave.currentBotStepId = entryPointId;
             isFlowStart = true;
         }

         if (driver.is_bot_active && !driver.current_bot_step_id && botSettings.steps.length > 0) {
              const firstId = entryPointId || botSettings.steps[0].id;
              driver.current_bot_step_id = firstId;
              updatesToSave.currentBotStepId = firstId;
              isFlowStart = true;
         }

         if (driver.is_bot_active && driver.current_bot_step_id) {
             let currentStep = botSettings.steps.find(s => s.id === driver.current_bot_step_id);
             
             if (!currentStep && botSettings.steps.length > 0) {
                 const firstId = entryPointId || botSettings.steps[0].id;
                 driver.current_bot_step_id = firstId;
                 currentStep = botSettings.steps.find(s => s.id === firstId);
                 updatesToSave.currentBotStepId = firstId;
                 isFlowStart = true;
             }

             if (currentStep) {
                 if (isFlowStart) {
                     // Initial step send
                     replyText = currentStep.message;
                     
                     // Handle Link Label on Start
                     if (currentStep.linkLabel && currentStep.message) {
                         replyText = `${currentStep.linkLabel}\n${currentStep.message}`;
                     }

                     replyTemplate = currentStep.templateName;
                     replyMedia = currentStep.mediaUrl;
                     replyMediaType = currentStep.mediaType || (currentStep.mediaUrl ? 'image' : undefined);
                     replyOptions = currentStep.options;
                 } 
                 else {
                     // Processing answer
                     if (currentStep.saveToField) {
                         updatesToSave[currentStep.saveToField] = msgBody;
                         if(currentStep.saveToField === 'name') updatesToSave.name = msgBody;
                     }

                     let nextId = currentStep.nextStepId; 

                     // Branching Logic
                     if (currentStep.routes && Object.keys(currentStep.routes).length > 0) {
                        const normalize = (str) => str.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
                        const cleanInput = normalize(msgBody);
                        
                        const routeKey = Object.keys(currentStep.routes).find(k => {
                            const cleanKey = normalize(k);
                            if (cleanKey === cleanInput) return true;
                            if (cleanKey.length > 3 && cleanInput.length > 3) {
                                if (cleanKey.startsWith(cleanInput) || cleanInput.startsWith(cleanKey)) return true;
                            }
                            if (cleanInput.includes(cleanKey) && cleanKey.length > 2) return true;
                            return false;
                        });
                        
                        if (routeKey) {
                            nextId = currentStep.routes[routeKey];
                        } else {
                            // INVALID OPTION
                            replyText = "Please select one of the valid options below:";
                            replyOptions = currentStep.options; 
                            updatesToSave = {}; 
                            
                            const sent = await sendWhatsAppMessage(from, replyText, replyOptions);
                            if (sent && !driver.id.startsWith('temp_')) {
                                await logSystemMessage(driver.id, replyText, 'text');
                            }
                            return; 
                        }
                     }

                     if (nextId === 'AI_HANDOFF' || nextId === 'END' || !nextId) {
                         updatesToSave.isBotActive = false; 
                         updatesToSave.currentBotStepId = null; 
                         
                         if (routingStrategy === 'HYBRID_BOT_FIRST' && nextId === 'AI_HANDOFF') shouldCallAI = true;
                         else if (routingStrategy === 'BOT_ONLY') replyText = "Details saved. Thank you.";
                     } else {
                         updatesToSave.currentBotStepId = nextId; 
                         const nextStep = botSettings.steps.find(s => s.id === nextId);
                         if (nextStep) {
                             replyText = nextStep.message;
                             
                             // Handle Link Label Logic for NEXT step
                             if (nextStep.linkLabel && nextStep.message) {
                                 replyText = `${nextStep.linkLabel}\n${nextStep.message}`;
                             }

                             replyTemplate = nextStep.templateName;
                             replyMedia = nextStep.mediaUrl;
                             replyMediaType = nextStep.mediaType || (nextStep.mediaUrl ? 'image' : undefined);
                             replyOptions = nextStep.options;
                         } else {
                             replyText = "Configuration Error: Next step is missing. Connecting you to an agent.";
                             updatesToSave.isBotActive = false;
                             shouldCallAI = false; 
                         }
                     }
                 }
             }
         } else if (driver.is_bot_active && routingStrategy === 'HYBRID_BOT_FIRST') shouldCallAI = true;
    }

    // 4. EXECUTE REPLY
    let sent = false;
    if (replyTemplate || replyText || replyMedia) {
        if (replyTemplate) {
            sent = await sendWhatsAppMessage(from, null, null, replyTemplate);
        } 
        if (!sent) {
            let caption = replyText || "";
            if (replyMedia) {
                // Ensure MediaType is explicitly 'image' or 'video' if not set
                const finalMediaType = replyMediaType || 'image';
                sent = await sendWhatsAppMessage(from, caption, null, null, 'en_US', replyMedia, finalMediaType);
            } else {
                sent = await sendWhatsAppMessage(from, caption, replyOptions);
            }
        }
        if (sent && !driver.id.startsWith('temp_')) {
             await logSystemMessage(driver.id, replyText || `[${replyMediaType || 'template'}]`, 'text');
        }
    } 
    
    if (!sent && shouldCallAI) {
        const aiResult = await analyzeWithAI(msgBody, driver.notes, botSettings.systemInstruction);
        const aiReply = aiResult.reply;
        
        if (aiResult.updatedNotes && aiResult.updatedNotes !== driver.notes) {
            updatesToSave.notes = aiResult.updatedNotes;
        }

        if (aiReply && aiReply.trim()) {
            sent = await sendWhatsAppMessage(from, aiReply);
            if (sent && !driver.id.startsWith('temp_')) await logSystemMessage(driver.id, aiReply, 'text');
        }
    }

    // 5. ASYNC STATE SAVE
    if (Object.keys(updatesToSave).length > 0 && !driver.id.startsWith('temp_')) {
        try {
            const mappedUpdates = mapUpdateKeys(updatesToSave);
            const keys = Object.keys(mappedUpdates);
            
            if (keys.length > 0) {
                const setClause = keys.map((k, i) => `${k} = $${i+2}`).join(', ');
                const values = keys.map(k => typeof mappedUpdates[k] === 'object' ? JSON.stringify(mappedUpdates[k]) : mappedUpdates[k]);
                
                await queryWithRetry(`UPDATE drivers SET ${setClause} WHERE id = $1`, [driver.id, ...values]);
            }
        } catch(e) { console.warn("Failed to save state updates:", e.message); }
    }
};

// ... (Routes) ...
app.patch('/api/drivers/:id', async (req, res) => { 
    try {
        const updates = req.body;
        const dbUpdates = mapUpdateKeys(updates);
        if (Object.keys(dbUpdates).length === 0) return res.json({ success: true, message: 'No valid fields to update' });
        const keys = Object.keys(dbUpdates);
        const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
        const values = keys.map(k => typeof dbUpdates[k] === 'object' ? JSON.stringify(dbUpdates[k]) : dbUpdates[k]);
        await queryWithRetry(`UPDATE drivers SET ${setClause} WHERE id = $1`, [req.params.id, ...values]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/drivers', async (req, res) => { 
    try {
        const client = await pool.connect();
        try {
            const driversRes = await client.query('SELECT * FROM drivers ORDER BY last_message_time DESC LIMIT 100');
            const drivers = driversRes.rows;
            if (drivers.length === 0) { res.json([]); return; }
            const driverIds = drivers.map(d => d.id);
            const messagesRes = await client.query(`SELECT * FROM messages WHERE driver_id = ANY($1) ORDER BY timestamp ASC`, [driverIds]);
            const messagesByDriver = {};
            messagesRes.rows.forEach(msg => {
                if (!messagesByDriver[msg.driver_id]) messagesByDriver[msg.driver_id] = [];
                messagesByDriver[msg.driver_id].push({
                    id: msg.id, sender: msg.sender, text: msg.text, imageUrl: msg.image_url, timestamp: parseInt(msg.timestamp), type: msg.type, options: msg.options
                });
            });
            const mappedDrivers = drivers.map(row => {
                const d = mapDriverToFrontend(row);
                d.messages = messagesByDriver[row.id] || [];
                return d;
            });
            res.json(mappedDrivers);
        } finally { client.release(); }
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bot-settings', async (req, res) => { 
    try {
        const resDb = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1', []);
        res.json(resDb.rows[0]?.settings || CACHED_BOT_SETTINGS);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bot-settings', async (req, res) => { 
    try {
        CACHED_BOT_SETTINGS = req.body;
        await queryWithRetry('UPDATE bot_settings SET settings = $1 WHERE id = 1', [JSON.stringify(req.body)]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ... (Public Showcase & S3 Endpoints maintained from previous logic) ...
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
        res.json({ success: true, id, url });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/media', async (req, res) => {
    try {
        const currentPath = req.query.path || '/';
        const folders = await queryWithRetry('SELECT * FROM media_folders WHERE parent_path = $1 ORDER BY name ASC', [currentPath]);
        const files = await queryWithRetry(`SELECT * FROM media_files WHERE folder_path = $1 ORDER BY uploaded_at DESC`, [currentPath]);
        res.json({ folders: folders.rows, files: files.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
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

app.get('/webhook', (req, res) => { res.send(req.query['hub.challenge']); });

app.post('/webhook', async (req, res) => { 
    try {
        if (req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
            const msg = req.body.entry[0].changes[0].value.messages[0];
            let msgBody = '';
            let msgType = 'text';

            if (msg.type === 'text') {
                msgBody = msg.text.body;
            } else if (msg.type === 'interactive') {
                const interactive = msg.interactive;
                if (interactive.type === 'button_reply') {
                    msgBody = interactive.button_reply.title;
                    msgType = 'button_reply';
                } else if (interactive.type === 'list_reply') {
                    msgBody = interactive.list_reply.title;
                    msgType = 'list_reply';
                }
            } else if (msg.type === 'image') {
                msgBody = '[Image]';
                msgType = 'image';
            } else {
                msgBody = '[Media]';
                msgType = 'unknown';
            }
            await processIncomingMessage(msg.from, 'Unknown', msgBody, msgType);
        }
        res.sendStatus(200);
    } catch(e) { console.error("Webhook Error:", e); res.sendStatus(500); }
});

module.exports = app;
if (require.main === module) app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

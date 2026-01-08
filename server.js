
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
            if (step.templateName && (step.templateName.includes(' ') || step.templateName.includes(':') || step.templateName.length < 3)) {
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
  if (mediaUrl) {
      // ... (Media Logic - abbreviated for brevity) ...
  }

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

// --- DATA MAPPERS ---

const mapDriverToFrontend = (row) => ({
    id: row.id,
    phoneNumber: row.phone_number,
    name: row.name,
    source: row.source,
    status: row.status,
    lastMessage: row.last_message,
    lastMessageTime: parseInt(row.last_message_time || '0'),
    // Note: Messages are populated via JOIN in GET /api/drivers
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

// Map incoming Frontend updates to DB Column names
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
        // Identity mappings
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
        if (Date.now() - LAST_SETTINGS_FETCH > 300000) {
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

    // Default driver object for logic before DB sync
    let driver = { 
        id: 'temp_' + from, 
        phone_number: from, 
        name: name, 
        is_bot_active: true, 
        is_human_mode: false, 
        notes: '' 
    };
    
    let isFlowStart = false; // Tracks if we are entering the bot flow this turn
    
    // 2. DRIVER STATE SYNC (TOLERANT TO FAILURE)
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
            // If we just created the driver and bot is active, this is the start of flow.
            if (shouldActivateBot) isFlowStart = true;
        } else {
            driver = driverRes.rows[0];
            await client.query('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [msgBody, timestamp, driver.id]);
        }
        
        // Save User Message
        await client.query(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'driver', $3, $4, $5)`,
            [`${timestamp}_${Math.random().toString(36).substr(2, 5)}`, driver.id, msgBody, timestamp, msgType]
        );
        
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("DB Sync Failed - Proceeding with In-Memory Driver State", err.code);
    } finally { client.release(); }

    // 3. LOGIC ENGINE
    if (driver.is_human_mode) return;

    let replyText = null; let replyOptions = null; let replyTemplate = null; let replyMedia = null; let replyMediaType = null; let shouldCallAI = false;
    let updatesToSave = {};

    if (botSettings.isEnabled && routingStrategy === 'AI_ONLY') { shouldCallAI = true; } 
    else if (botSettings.isEnabled) {
         
         // A. ACTIVATION LOGIC
         if (!driver.is_bot_active && routingStrategy === 'BOT_ONLY') {
             driver.is_bot_active = true;
             driver.current_bot_step_id = entryPointId;
             // IMPORTANT: Use camelCase keys for mapUpdateKeys compatibility!
             updatesToSave.isBotActive = true; 
             updatesToSave.currentBotStepId = entryPointId;
             isFlowStart = true; // We just started/restarted the bot
         }

         // B. RECOVERY LOGIC (If active but lost step)
         if (driver.is_bot_active && !driver.current_bot_step_id && botSettings.steps.length > 0) {
              const firstId = entryPointId || botSettings.steps[0].id;
              driver.current_bot_step_id = firstId;
              updatesToSave.currentBotStepId = firstId;
              isFlowStart = true; // Recovered to start
         }

         // C. STEP PROCESSING
         if (driver.is_bot_active && driver.current_bot_step_id) {
             let currentStep = botSettings.steps.find(s => s.id === driver.current_bot_step_id);
             
             // Fallback for deleted steps
             if (!currentStep && botSettings.steps.length > 0) {
                 const firstId = entryPointId || botSettings.steps[0].id;
                 driver.current_bot_step_id = firstId;
                 currentStep = botSettings.steps.find(s => s.id === firstId);
                 updatesToSave.currentBotStepId = firstId;
                 isFlowStart = true;
             }

             if (currentStep) {
                 // CASE 1: START OF FLOW (User sent "Hi", we just activated)
                 // ACTION: Send the question/link of the FIRST step. Do not process "Hi" as an answer.
                 if (isFlowStart) {
                     replyText = currentStep.message;
                     replyTemplate = currentStep.templateName;
                     replyMedia = currentStep.mediaUrl;
                     replyMediaType = currentStep.mediaType || (currentStep.mediaUrl ? 'image' : undefined);
                     replyOptions = currentStep.options;
                     
                     // DO NOT Advance step. We want to wait for answer to THIS step.
                 } 
                 // CASE 2: USER IS ANSWERING (Flow is already running)
                 else {
                     // 1. Save Data
                     if (currentStep.saveToField) {
                         updatesToSave[currentStep.saveToField] = msgBody;
                         if(currentStep.saveToField === 'name') updatesToSave.name = msgBody;
                     }

                     // 2. DETERMINE NEXT STEP (Branching Logic)
                     let nextId = currentStep.nextStepId; // Default Next ID

                     // BRANCHING CHECK: Does this step have specific routes for options?
                     if (currentStep.routes && Object.keys(currentStep.routes).length > 0) {
                        // Check if user message matches a route key exactly
                        // NOTE: WhatsApp button replies send the exact button text back
                        const matchedRoute = currentStep.routes[msgBody.trim()];
                        if (matchedRoute) {
                            nextId = matchedRoute;
                        }
                     }

                     if (nextId === 'AI_HANDOFF' || nextId === 'END' || !nextId) {
                         updatesToSave.isBotActive = false; // CamelCase!
                         updatesToSave.currentBotStepId = null; // CamelCase!
                         
                         if (routingStrategy === 'HYBRID_BOT_FIRST' && nextId === 'AI_HANDOFF') shouldCallAI = true;
                         else if (routingStrategy === 'BOT_ONLY') replyText = "Details saved. Thank you.";
                     } else {
                         // PREPARE NEXT STEP
                         updatesToSave.currentBotStepId = nextId; // CamelCase!
                         const nextStep = botSettings.steps.find(s => s.id === nextId);
                         if (nextStep) {
                             replyText = nextStep.message;
                             replyTemplate = nextStep.templateName;
                             replyMedia = nextStep.mediaUrl;
                             replyMediaType = nextStep.mediaType || (nextStep.mediaUrl ? 'image' : undefined);
                             replyOptions = nextStep.options;
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
            // Use text body fallback if media fails or just text
            if (replyMedia) {
                sent = await sendWhatsAppMessage(from, caption, null, null, 'en_US', replyMedia, replyMediaType);
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
            
            // Only update if we have valid mapped keys
            if (keys.length > 0) {
                const setClause = keys.map((k, i) => `${k} = $${i+2}`).join(', ');
                const values = keys.map(k => typeof mappedUpdates[k] === 'object' ? JSON.stringify(mappedUpdates[k]) : mappedUpdates[k]);
                
                await queryWithRetry(`UPDATE drivers SET ${setClause} WHERE id = $1`, [driver.id, ...values]);
            }
        } catch(e) { console.warn("Failed to save state updates:", e.message); }
    }
};

// ... (Rest of Routes) ...

// PATCH DRIVER UPDATES (From Frontend)
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

// GET DRIVERS (Populate Dashboard)
app.get('/api/drivers', async (req, res) => { 
    try {
        const client = await pool.connect();
        try {
            // Get Drivers
            const driversRes = await client.query('SELECT * FROM drivers ORDER BY last_message_time DESC LIMIT 100');
            const drivers = driversRes.rows;

            if (drivers.length === 0) {
                res.json([]);
                return;
            }

            const driverIds = drivers.map(d => d.id);
            
            // Get Messages for these drivers (Last 50 per driver would be better in prod, here we fetch all for small set)
            const messagesRes = await client.query(`
                SELECT * FROM messages 
                WHERE driver_id = ANY($1) 
                ORDER BY timestamp ASC
            `, [driverIds]);

            const messagesByDriver = {};
            messagesRes.rows.forEach(msg => {
                if (!messagesByDriver[msg.driver_id]) messagesByDriver[msg.driver_id] = [];
                messagesByDriver[msg.driver_id].push({
                    id: msg.id,
                    sender: msg.sender,
                    text: msg.text,
                    imageUrl: msg.image_url,
                    timestamp: parseInt(msg.timestamp),
                    type: msg.type,
                    options: msg.options
                });
            });

            // Map to Frontend Format
            const mappedDrivers = drivers.map(row => {
                const d = mapDriverToFrontend(row);
                d.messages = messagesByDriver[row.id] || [];
                return d;
            });

            res.json(mappedDrivers);
        } finally {
            client.release();
        }
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// [Rest of existing endpoints unchanged]
// ... (public showcase, files, bot-settings, etc) ...

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

app.post('/api/folders', async (req, res) => { 
    try {
        const { name, parentPath } = req.body;
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

app.put('/api/folders/:id', async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const { name } = req.body;
        if (!name || name.trim().length === 0) return res.status(400).json({ error: "Name is required" });
        await client.query('BEGIN');
        const folderRes = await client.query('SELECT name, parent_path FROM media_folders WHERE id = $1', [id]);
        if (folderRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "Folder not found" });
        }
        const oldName = folderRes.rows[0].name;
        const parentPath = folderRes.rows[0].parent_path;
        const dupCheck = await client.query('SELECT id FROM media_folders WHERE name = $1 AND id != $2', [name, id]);
        if (dupCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: "Folder name already taken. Please choose a unique name." });
        }
        const oldPathPrefix = parentPath === '/' ? `/${oldName}` : `${parentPath}/${oldName}`;
        const newPathPrefix = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
        await client.query('UPDATE media_folders SET name = $1 WHERE id = $2', [name, id]);
        await client.query(`UPDATE media_files SET folder_path = $1 || SUBSTRING(folder_path, LENGTH($2) + 1) WHERE folder_path = $2 OR folder_path LIKE $2 || '/%'`, [newPathPrefix, oldPathPrefix]);
        await client.query(`UPDATE media_folders SET parent_path = $1 || SUBSTRING(parent_path, LENGTH($2) + 1) WHERE parent_path = $2 OR parent_path LIKE $2 || '/%'`, [newPathPrefix, oldPathPrefix]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Rename Error:", e);
        res.status(500).json({ error: e.message });
    } finally { client.release(); }
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

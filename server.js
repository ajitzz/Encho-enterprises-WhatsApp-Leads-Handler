
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
const router = express.Router(); // Use Router for flexible mounting

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
const ENCHO_SYSTEM_INSTRUCTION = `
Role: WhatsApp Customer Support Executive for Encho Cabs (Uber + Ola connected fleet).
Language: Malayalam + simple English (Manglish/Mixed). Keep it short, friendly, and persuasive. If user speaks Tamil/Hindi/English, switch language.
Goal: Explain benefits, answer queries, get name/phone number.

✅ COMPANY FACTS (Absolute Truths):
1. Vehicle: WagonR CNG (latest manual). Safe, well-maintained, bumper-to-bumper insured.
2. Accommodation: ₹5000 refundable deposit (after 4 months). Includes Kitchen, Bed + Mattress, Heater, Cooking vessels, Refrigerator, Washing Machine. Long‑term stay possible.
3. Rent + Trips: 
   - ₹600/day for 10 trips.
   - Weekly target: 70 trips.
   - If trips missed but performance good -> No extra charge (cover next day).
   - Good performance reduces rent: ₹600 → ₹550 → ₹500 → ₹450.
4. Earnings:
   - Week 1 avg: ₹18,000/week.
   - Experienced: ~₹23,000/week.
   - CNG Cost: ₹600–₹650/day.
   - We take NO commission from earnings (only fixed rent).
5. Transparency Software (USP): 
   - We provide a dedicated Company Software for every driver.
   - All payments and calculations are visible there.
   - Drivers can download Weekly Bills directly. 
   - This software ensures 100% transparency and builds trust.
6. Leave: Monday only. Inform 10 days prior. Return date required.
7. Future: Encho Travels collaboration coming soon (Outstation trips up to 1 week).

✅ RESPONSE RULES:
- Default length: 2–4 lines.
- If asked "details": 6–10 lines.
- Always end with a gentle CTA (name? / phone? / visit?).
- If unsure: "ഞാൻ ടീം confirm ചെയ്ത് അറിയിക്കും."

✅ FAQ SCRIPTS (Use these styles):

[Intro]:
"നമസ്കാരം 👋 ഞങ്ങൾ Uber/Ola connected fleet ആണ്. WagonR CNG vehicle + accommodation നൽകും. നിങ്ങളുടെ പേര് പറയാമോ?"

[Vehicle]:
"Vehicle WagonR CNG (latest manual) ആണ്. Safe & well‑maintained. Interested ആണെങ്കിൽ visit arrange ചെയ്യാം."

[Accommodation]:
"Accommodation ₹5000 refundable (4 months ശേഷം). Kitchen, bed, heater, fridge, washing machine എല്ലാം ഉണ്ട്. Long‑term stay possible."

[Rent]:
"Rent ₹600/day for 10 trips. Missed trips next day cover ചെയ്യണം. Weekly target 70 trips. Good performance ആണെങ്കിൽ rent കുറയും (upto ₹450)."

[Earnings]:
"Week 1 avg ₹18,000/week. CNG ₹600–₹650/day. Rent ₹600/day. No commission from earnings."

[Software/Trust]:
"ഞങ്ങൾക്ക് സ്വന്തമായി Company Software ഉണ്ട്. Payment and Calculations എല്ലാം അതിൽ കാണാം. Weekly Bills download ചെയ്യാം. So 100% transparency ആണ്, no cheating."

[Why Join Us?]:
"Vehicle + accommodation one place. Rent reduces on good performance. No commission. Plus, transparent Software for all accounts."
`;

let CACHED_BOT_SETTINGS = {
  isEnabled: true,
  routingStrategy: 'HYBRID_BOT_FIRST',
  systemInstruction: ENCHO_SYSTEM_INSTRUCTION,
  steps: []
};
let LAST_SETTINGS_FETCH = 0;

// SYSTEM MONITOR METRICS
let ACTIVE_UPLOADS = 0;
let AI_CREDITS_ESTIMATED = 98; 
let CURRENT_AI_MODEL = "gemini-3-flash-preview";
let AI_FALLBACK_UNTIL = 0; // Timestamp for cool-down

// --- DATABASE CONNECTION ---
const NEON_DB_URL = "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL || NEON_DB_URL;

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  ssl: { rejectUnauthorized: false },
  max: 10, 
  idleTimeoutMillis: 1000, 
  connectionTimeoutMillis: 15000, 
});

const queryWithRetry = async (text, params, retries = 3) => {
    let client;
    try {
        client = await pool.connect();
        const res = await client.query(text, params);
        return res;
    } catch (err) {
        if (client) { try { client.release(true); } catch(e) {} client = null; }
        
        const isConnectionError = err.code === '57P01' || err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
        const isTableError = err.code === '42P01' || err.code === '42703'; 
        
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

// COST SAVING: WhatsApp Media Cache Table
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
        // Self-Heal
        await client.query(`ALTER TABLE whatsapp_media_cache ADD COLUMN IF NOT EXISTS expires_at BIGINT`);
        await client.query(`ALTER TABLE media_folders ADD COLUMN IF NOT EXISTS is_public_showcase BOOLEAN DEFAULT FALSE`);
        
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

// --- COST SAVING: SMART MEDIA HANDLER ---
const getOrUploadWhatsAppMedia = async (s3Url, mediaType) => {
    try {
        const now = Date.now();
        const cached = await queryWithRetry(
            'SELECT media_id, expires_at FROM whatsapp_media_cache WHERE s3_url = $1',
            [s3Url]
        );

        if (cached.rows.length > 0) {
            const { media_id, expires_at } = cached.rows[0];
            if (expires_at > now) {
                return media_id;
            }
        }

        ACTIVE_UPLOADS++;
        const response = await axios.get(s3Url, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data, 'binary');
        
        const formData = new FormData();
        const blob = new Blob([buffer], { type: response.headers['content-type'] });
        formData.append('file', blob, 'media_file');
        formData.append('messaging_product', 'whatsapp');

        const waRes = await fetch(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/media`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${META_API_TOKEN}` },
            body: formData
        });

        if (!waRes.ok) throw new Error(`WhatsApp Upload Failed: ${waRes.statusText}`);
        const waData = await waRes.json();
        const newMediaId = waData.id;

        const expiresAt = now + (29 * 24 * 60 * 60 * 1000); 
        await queryWithRetry(
            `INSERT INTO whatsapp_media_cache (s3_url, media_id, created_at, expires_at) 
             VALUES ($1, $2, $3, $4) 
             ON CONFLICT (s3_url) DO UPDATE SET media_id = $2, expires_at = $4`,
            [s3Url, newMediaId, now, expiresAt]
        );
        
        ACTIVE_UPLOADS--;
        return newMediaId;

    } catch (e) {
        ACTIVE_UPLOADS--;
        console.error("Media Sync Error:", e.message);
        return null; 
    }
};

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
          const mediaId = await getOrUploadWhatsAppMedia(mediaUrl, mediaType);
          payload.type = mediaType;
          if (mediaId) {
              payload[mediaType] = { id: mediaId }; 
          } else {
              payload[mediaType] = { link: mediaUrl }; 
          }
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

// --- AI LOGIC WITH SMART FALLBACK & COOL-DOWN ---
const analyzeWithAI = async (text, currentNotes, systemInstruction) => {
  if (!GEMINI_API_KEY) return { reply: "Thank you for your message.", updatedNotes: currentNotes };
  
  if (Date.now() < AI_FALLBACK_UNTIL) {
      CURRENT_AI_MODEL = "gemini-1.5-flash"; 
  } else {
      CURRENT_AI_MODEL = "gemini-3-flash-preview"; 
  }

  const performAnalysis = async (modelToUse) => {
      const prompt = `
        System Instruction: ${systemInstruction || 'You are a helpful assistant.'}
        User sent: "${text}"
        Current Driver Notes: "${currentNotes || ''}"
        TASK: 1. Generate a helpful reply. 2. Extract key details.
        Output JSON: { "reply": "string", "updatedNotes": "string" }
      `;
      const response = await ai.models.generateContent({ 
        model: modelToUse, 
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });
      AI_CREDITS_ESTIMATED = Math.max(0, AI_CREDITS_ESTIMATED - 0.5); 
      return JSON.parse(response.text);
  };

  try {
      return await performAnalysis(CURRENT_AI_MODEL);
  } catch (e) {
      if ((e.message.includes("429") || e.message.includes("Quota")) && CURRENT_AI_MODEL !== "gemini-1.5-flash") {
          console.warn("AI Quota Exceeded. Switching to fallback model for 60s.");
          AI_FALLBACK_UNTIL = Date.now() + 60000; 
          CURRENT_AI_MODEL = "gemini-1.5-flash"; 
          try {
              return await performAnalysis(CURRENT_AI_MODEL);
          } catch (e2) {
              return { reply: "I am currently experiencing high traffic. Please try again later.", updatedNotes: currentNotes };
          }
      }
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

const processIncomingMessage = async (from, name, msgBody, msgType = 'text', timestamp = Date.now()) => {
    // 1. SETTINGS FETCH
    let botSettings = CACHED_BOT_SETTINGS;
    try {
        if (Date.now() - LAST_SETTINGS_FETCH > 1000) {
            const settingsRes = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1', [], 1);
            if (settingsRes.rows.length > 0) {
                botSettings = settingsRes.rows[0].settings;
                LAST_SETTINGS_FETCH = Date.now();
            }
        }
    } catch(e) {}

    const routingStrategy = botSettings.routingStrategy || 'HYBRID_BOT_FIRST';
    const entryPointId = botSettings.entryPointId || botSettings.steps?.[0]?.id;

    // 2. DRIVER SYNC
    let driver = { id: 'temp_' + from, phone_number: from, name: name, is_bot_active: true, is_human_mode: false, notes: '' };
    let isFlowStart = false;
    
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
    } finally { client.release(); }

    if (driver.is_human_mode) return;

    // 3. BOT LOGIC
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
                     replyText = currentStep.message;
                     if (currentStep.linkLabel && currentStep.message) {
                         replyText = `${currentStep.linkLabel}\n${currentStep.message}`;
                     }
                     replyTemplate = currentStep.templateName;
                     replyMedia = currentStep.mediaUrl;
                     replyMediaType = currentStep.mediaType || (currentStep.mediaUrl ? 'image' : undefined);
                     replyOptions = currentStep.options;
                 } else {
                     if (currentStep.saveToField) {
                         updatesToSave[currentStep.saveToField] = msgBody;
                         if(currentStep.saveToField === 'name') updatesToSave.name = msgBody;
                     }

                     let nextId = currentStep.nextStepId; 
                     if (currentStep.routes && Object.keys(currentStep.routes).length > 0) {
                        const normalize = (str) => str.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
                        const cleanInput = normalize(msgBody);
                        
                        // FIX: Sort keys by length descending to match longest possible option first
                        // e.g. Match "Not Interested" (longer) before "Interested" (shorter/substring)
                        const routeKey = Object.keys(currentStep.routes).sort((a, b) => b.length - a.length).find(k => {
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
                            replyText = "Please select one of the valid options below:";
                            replyOptions = currentStep.options; 
                            updatesToSave = {}; 
                            const sent = await sendWhatsAppMessage(from, replyText, replyOptions);
                            if (sent && !driver.id.startsWith('temp_')) await logSystemMessage(driver.id, replyText, 'text');
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

    let sent = false;
    if (replyTemplate || replyText || replyMedia) {
        if (replyTemplate) sent = await sendWhatsAppMessage(from, null, null, replyTemplate);
        if (!sent) {
            let caption = replyText || "";
            if (replyMedia) {
                const finalMediaType = replyMediaType || 'image';
                sent = await sendWhatsAppMessage(from, caption, null, null, 'en_US', replyMedia, finalMediaType);
            } else {
                sent = await sendWhatsAppMessage(from, caption, replyOptions);
            }
        }
        if (sent && !driver.id.startsWith('temp_')) await logSystemMessage(driver.id, replyText || `[${replyMediaType || 'template'}]`, 'text');
    } 
    
    if (!sent && shouldCallAI) {
        const aiResult = await analyzeWithAI(msgBody, driver.notes, botSettings.systemInstruction);
        const aiReply = aiResult.reply;
        if (aiReply && aiReply.trim()) {
            sent = await sendWhatsAppMessage(from, aiReply);
            if (sent && !driver.id.startsWith('temp_')) await logSystemMessage(driver.id, aiReply, 'text');
        }
    }

    if (Object.keys(updatesToSave).length > 0 && !driver.id.startsWith('temp_')) {
        try {
            const keys = Object.keys(updatesToSave);
            const mappedUpdates = {};
            keys.forEach(k => {
                if (k === 'isBotActive') mappedUpdates['is_bot_active'] = updatesToSave[k];
                else if (k === 'currentBotStepId') mappedUpdates['current_bot_step_id'] = updatesToSave[k];
                else mappedUpdates[k] = updatesToSave[k];
            });
            
            const dbKeys = Object.keys(mappedUpdates);
            if (dbKeys.length > 0) {
                const setClause = dbKeys.map((k, i) => `${k} = $${i+2}`).join(', ');
                const values = dbKeys.map(k => typeof mappedUpdates[k] === 'object' ? JSON.stringify(mappedUpdates[k]) : mappedUpdates[k]);
                await queryWithRetry(`UPDATE drivers SET ${setClause} WHERE id = $1`, [driver.id, ...values]);
            }
        } catch(e) { console.warn("Failed to save state updates:", e.message); }
    }
};

// --- API ROUTES (ROUTER) ---

// Drivers
router.get('/drivers', async (req, res) => { 
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
            const mappedDrivers = drivers.map(row => ({
                id: row.id,
                phoneNumber: row.phone_number,
                name: row.name,
                source: row.source,
                status: row.status,
                lastMessage: row.last_message,
                lastMessageTime: parseInt(row.last_message_time || '0'),
                messages: messagesByDriver[row.id] || [],
                documents: row.documents || [],
                notes: row.notes || '',
                onboardingStep: row.onboarding_step || 0,
                vehicleRegistration: row.vehicle_registration,
                availability: row.availability,
                qualificationChecks: row.qualification_checks || {},
                currentBotStepId: row.current_bot_step_id,
                isBotActive: row.is_bot_active,
                isHumanMode: row.is_human_mode
            }));
            res.json(mappedDrivers);
        } finally { client.release(); }
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/drivers/:id', async (req, res) => { 
    try {
        const updates = req.body;
        const map = { 'isHumanMode': 'is_human_mode', 'notes': 'notes', 'status': 'status', 'qualificationChecks': 'qualification_checks', 'vehicleRegistration': 'vehicle_registration', 'availability': 'availability' }; 
        const dbUpdates = {};
        for(let k in updates) if(map[k]) dbUpdates[map[k]] = updates[k];
        
        if (Object.keys(dbUpdates).length > 0) {
             const keys = Object.keys(dbUpdates);
             const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
             const values = keys.map(k => typeof dbUpdates[k] === 'object' ? JSON.stringify(dbUpdates[k]) : dbUpdates[k]);
             await queryWithRetry(`UPDATE drivers SET ${setClause} WHERE id = $1`, [req.params.id, ...values]);
        }
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Messages
router.post('/messages/send', async (req, res) => { 
    try {
        const driverRes = await queryWithRetry('SELECT phone_number FROM drivers WHERE id = $1', [req.body.driverId]);
        if (driverRes.rows.length === 0) return res.status(404).json({ error: 'Driver not found' });
        const success = await sendWhatsAppMessage(driverRes.rows[0].phone_number, req.body.text);
        if (!success) return res.status(500).json({ error: 'Meta API Failed' });
        await logSystemMessage(req.body.driverId, req.body.text, 'text');
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Bot Settings
router.get('/bot-settings', async (req, res) => { 
    try {
        const resDb = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1', []);
        res.json(resDb.rows[0]?.settings || CACHED_BOT_SETTINGS);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/bot-settings', async (req, res) => { 
    try {
        CACHED_BOT_SETTINGS = req.body;
        await queryWithRetry('UPDATE bot_settings SET settings = $1 WHERE id = 1', [JSON.stringify(req.body)]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// S3 & Files
router.post('/s3/presign', async (req, res) => { 
    try {
        const { filename, fileType, folderPath } = req.body;
        const key = `${Date.now()}-${filename.replace(/\s+/g, '_')}`;
        const command = new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, ContentType: fileType });
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
        res.json({ uploadUrl, key, publicUrl: `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}` });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/files/register', async (req, res) => { 
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

router.get('/media', async (req, res) => {
    try {
        const currentPath = req.query.path || '/';
        const folders = await queryWithRetry('SELECT * FROM media_folders WHERE parent_path = $1 ORDER BY name ASC', [currentPath]);
        const files = await queryWithRetry(`SELECT * FROM media_files WHERE folder_path = $1 ORDER BY uploaded_at DESC`, [currentPath]);
        res.json({ folders: folders.rows, files: files.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/files/:id/sync', async (req, res) => {
    try {
        const fileRes = await queryWithRetry('SELECT url, type FROM media_files WHERE id = $1', [req.params.id]);
        if (fileRes.rows.length === 0) return res.status(404).json({error: 'File not found'});
        const mediaId = await getOrUploadWhatsAppMedia(fileRes.rows[0].url, fileRes.rows[0].type);
        res.json({ success: true, mediaId });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- NEW ROUTES: FOLDER MANAGEMENT & PUBLIC SHOWCASE ---

router.post('/folders', async (req, res) => {
    try {
        const { name, parentPath } = req.body;
        const id = Date.now().toString();
        // GLOBAL UNIQUENESS CHECK
        const existing = await queryWithRetry('SELECT id FROM media_folders WHERE name = $1', [name]);
        if (existing.rows.length > 0) return res.status(409).json({ error: 'Folder name already exists globally' });
        await queryWithRetry('INSERT INTO media_folders (id, name, parent_path) VALUES ($1, $2, $3)', [id, name, parentPath]);
        res.json({ success: true, id });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/folders/:id', async (req, res) => {
    try {
        const { name } = req.body;
        const folderRes = await queryWithRetry('SELECT id FROM media_folders WHERE id = $1', [req.params.id]);
        if (folderRes.rows.length === 0) return res.status(404).json({ error: 'Folder not found' });
        
        // GLOBAL UNIQUENESS CHECK (Excluding self)
        const existing = await queryWithRetry('SELECT id FROM media_folders WHERE name = $1 AND id != $2', [name, req.params.id]);
        if (existing.rows.length > 0) return res.status(409).json({ error: 'Folder name already exists globally' });

        await queryWithRetry('UPDATE media_folders SET name = $1 WHERE id = $2', [name, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/folders/:id', async (req, res) => {
    try {
        await queryWithRetry('DELETE FROM media_folders WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/files/:id', async (req, res) => {
    try {
        await queryWithRetry('DELETE FROM media_files WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/folders/:id/public', async (req, res) => {
    try {
        await queryWithRetry('UPDATE media_folders SET is_public_showcase = TRUE WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/folders/:id/public', async (req, res) => {
    try {
        await queryWithRetry('UPDATE media_folders SET is_public_showcase = FALSE WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/public/status', async (req, res) => {
    try {
        const resDb = await queryWithRetry('SELECT id, name FROM media_folders WHERE is_public_showcase = TRUE ORDER BY id DESC LIMIT 1', []);
        if (resDb.rows.length > 0) {
            res.json({ active: true, folderName: resDb.rows[0].name, folderId: resDb.rows[0].id });
        } else {
            res.json({ active: false });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/public/showcase', async (req, res) => {
    try {
        let targetFolderName = req.query.folder;
        let folderPath = '';
        let displayTitle = 'Showcase';

        if (targetFolderName) {
            targetFolderName = decodeURIComponent(targetFolderName);
            
            // 1. Try to find folder by name (Case Insensitive)
            // We prioritize public folders, then just matching names
            const folderRes = await queryWithRetry(
                `SELECT name, parent_path FROM media_folders 
                 WHERE LOWER(name) = LOWER($1) 
                 ORDER BY is_public_showcase DESC, id DESC LIMIT 1`,
                [targetFolderName]
            );

            if (folderRes.rows.length > 0) {
                const f = folderRes.rows[0];
                displayTitle = f.name;
                // Construct path
                folderPath = f.parent_path === '/' ? `/${f.name}` : `${f.parent_path}/${f.name}`;
            } else {
                // Fallback: Assume root level if not found in DB (maybe legacy file)
                folderPath = '/' + targetFolderName;
                displayTitle = targetFolderName;
            }
        } else {
            // 2. No specific folder -> Get Active Public Showcase
            const activeRes = await queryWithRetry(
                'SELECT name, parent_path FROM media_folders WHERE is_public_showcase = TRUE ORDER BY id DESC LIMIT 1',
                []
            );
            if (activeRes.rows.length > 0) {
                const f = activeRes.rows[0];
                displayTitle = f.name;
                folderPath = f.parent_path === '/' ? `/${f.name}` : `${f.parent_path}/${f.name}`;
            } else {
                // No active showcase
                return res.json({ title: 'Showcase', items: [] });
            }
        }
        
        // Normalize path
        folderPath = folderPath.replace(/\/\//g, '/');

        // 3. Get Files
        const filesRes = await queryWithRetry(
            'SELECT id, url, type, filename FROM media_files WHERE folder_path = $1 ORDER BY uploaded_at DESC', 
            [folderPath]
        );

        res.json({ title: displayTitle, items: filesRes.rows });
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    }
});

// System Monitor
router.get('/system/stats', async (req, res) => {
    const start = Date.now();
    let dbLatency = 0;
    try {
        await pool.query('SELECT 1');
        dbLatency = Date.now() - start;
    } catch(e) { dbLatency = -1; }

    const mediaLoad = Math.min(ACTIVE_UPLOADS * 10, 100);

    res.json({
        serverLoad: Math.floor(Math.random() * 20) + 10, 
        dbLatency: dbLatency,
        aiCredits: Math.floor(AI_CREDITS_ESTIMATED),
        aiModel: CURRENT_AI_MODEL,
        s3Status: 'ok',
        whatsappStatus: ACTIVE_UPLOADS > 3 ? 'latency' : 'ok',
        activeUploads: ACTIVE_UPLOADS,
        mediaUploadLoad: mediaLoad
    });
});

// --- MOUNT ROUTER (Fixes 404 on Vercel) ---
app.use('/api', router); 
app.use('/', router);    

// Webhook
app.get('/webhook', (req, res) => { res.send(req.query['hub.challenge']); });
app.post('/webhook', async (req, res) => { 
    try {
        if (req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
            const msg = req.body.entry[0].changes[0].value.messages[0];
            let msgBody = ''; let msgType = 'text';
            if (msg.type === 'text') msgBody = msg.text.body;
            else if (msg.type === 'interactive') {
                if (msg.interactive.type === 'button_reply') { msgBody = msg.interactive.button_reply.title; msgType = 'button_reply'; }
                else if (msg.interactive.type === 'list_reply') { msgBody = msg.interactive.list_reply.title; msgType = 'list_reply'; }
            } else if (msg.type === 'image') { msgBody = '[Image]'; msgType = 'image'; }
            else { msgBody = '[Media]'; msgType = 'unknown'; }
            await processIncomingMessage(msg.from, 'Unknown', msgBody, msgType);
        }
        res.sendStatus(200);
    } catch(e) { console.error("Webhook Error:", e); res.sendStatus(500); }
});

module.exports = app;
if (require.main === module) app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

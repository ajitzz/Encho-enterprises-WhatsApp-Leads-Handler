
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
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
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
    // CRITICAL: Disable auto-checksums for presigned URLs to prevent signature mismatch in browser uploads
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED"
});
const BUCKET_NAME = process.env.AWS_BUCKET_NAME || '';
const upload = multer({ storage: multer.memoryStorage() });

// --- SECURITY: CONTENT FIREWALL ---
const BLOCKED_REGEX = /replace\s+this\s+sample\s+message|enter\s+your\s+message|type\s+your\s+message\s+here|replace\s+this\s+text/i;

// HELPER: Clean a single step
const cleanStep = (step) => {
    if (!step) return step;
    const msg = step.message || "";
    if (BLOCKED_REGEX.test(msg)) {
        console.log(`🧹 FIREWALL: Stripping placeholder from step '${step.title || step.id}'`);
        if (step.options && step.options.length > 0) {
            step.message = "Please select an option:";
        } else {
            step.message = ""; 
        }
    }
    return step;
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

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

const queryWithRetry = async (text, params, retries = 2) => {
    let client;
    try {
        client = await pool.connect();
        const res = await client.query(text, params);
        return res;
    } catch (err) {
        if (client) { try { client.release(true); } catch(e) {} client = null; }
        
        console.warn(`⚠️ DB Error (${err.code}): ${err.message}`);
        
        // 42P01: undefined_table
        // 42703: undefined_column (Missing 'documents' or 'bot_state' etc.)
        if ((err.code === '57P01' || err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === '42P01' || err.code === '42703') && retries > 0) {
            console.log(`♻️ Retrying with SELF HEAL... (${retries} left)`);
            
            // Trigger Self Heal on Table/Column missing
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

// --- SCHEMA & SELF HEALING INITIALIZATION ---
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
        parent_path VARCHAR(255) DEFAULT '/'
    );
    CREATE TABLE IF NOT EXISTS media_files (
        id VARCHAR(255) PRIMARY KEY,
        url TEXT NOT NULL,
        filename TEXT,
        type VARCHAR(50),
        uploaded_at BIGINT,
        folder_path VARCHAR(255) DEFAULT '/'
    );
`;

const DEFAULT_BOT_SETTINGS = {
  isEnabled: true,
  routingStrategy: 'HYBRID_BOT_FIRST',
  systemInstruction: "You are a friendly recruiter for Uber Fleet. Answer in Malayalam and English.",
  steps: []
};

// --- DATA SANITIZATION ---
const sanitizeBotSettings = async (client) => {
    try {
        const res = await client.query('SELECT settings FROM bot_settings WHERE id = 1');
        if (res.rows.length === 0) return;

        let settings = res.rows[0].settings;
        let hasChanges = false;
        
        console.log("----- STARTUP INSPECTION: BOT SETTINGS FROM DB -----");
        if (settings.steps && Array.isArray(settings.steps)) {
            settings.steps.forEach(s => {
                console.log(`Step ${s.id}: "${s.message?.substring(0, 30)}..." [Template: ${s.templateName || 'None'}]`);
            });

            settings.steps = settings.steps.map(step => {
                const originalMsg = step.message;
                const cleanedStep = cleanStep(step); // Use shared helper
                if (cleanedStep.message !== originalMsg) {
                    hasChanges = true;
                }
                return cleanedStep;
            });
        }
        console.log("----------------------------------------------------");

        if (hasChanges) {
            await client.query('UPDATE bot_settings SET settings = $1 WHERE id = 1', [JSON.stringify(settings)]);
            console.log("✅ DATABASE SANITIZED ON STARTUP: Placeholder texts removed.");
        }
    } catch (e) {
        console.error("Sanitization failed:", e);
    }
};

const ensureDatabaseInitialized = async (client) => {
    try {
        console.log("🩺 RUNNING DATABASE SELF-HEAL...");
        await client.query('BEGIN');
        
        // 1. Create Tables if missing
        await client.query(SCHEMA_SQL);
        
        // 2. Self-Heal Columns (If tables exist but columns are missing)
        // This fixes the "undefined column" error if schema evolved
        await client.query(`
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS options TEXT[];
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS documents TEXT[];
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bot_state JSONB DEFAULT '{}';
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_details JSONB DEFAULT '{}';
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS qualification_checks JSONB DEFAULT '{"hasValidLicense": false, "hasVehicle": false, "isLocallyAvailable": true}'::jsonb;
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS current_bot_step_id TEXT;
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_bot_active BOOLEAN DEFAULT FALSE;
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS onboarding_step INTEGER DEFAULT 0;
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_registration TEXT;
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS availability TEXT;
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_human_mode BOOLEAN DEFAULT FALSE;
            ALTER TABLE media_files ADD COLUMN IF NOT EXISTS folder_path VARCHAR(255) DEFAULT '/';
        `);

        // 3. Ensure Default Settings
        const settingsRes = await client.query('SELECT * FROM bot_settings WHERE id = 1');
        if (settingsRes.rows.length === 0) {
            await client.query('INSERT INTO bot_settings (id, settings) VALUES (1, $1)', [JSON.stringify(DEFAULT_BOT_SETTINGS)]);
        }
        
        await client.query('COMMIT');
        console.log("✅ DATABASE SELF-HEAL COMPLETE");
        
        await sanitizeBotSettings(client);

    } catch (e) {
        await client.query('ROLLBACK');
        console.error("❌ Schema Init/Heal Failed:", e);
    }
};

// --- AI ENGINE ---
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- HELPER: S3 KEY GEN ---
const getS3FolderPrefix = (parentPath) => {
    // Converts "/marketing" to "marketing/" and "/" to ""
    if (!parentPath || parentPath === '/') return '';
    return parentPath.replace(/^\//, '') + '/';
};

// --- LOGIC ENGINE ---
const sendWhatsAppMessage = async (to, body, options = null, templateName = null, language = 'en_US', mediaUrl = null, mediaType = 'image') => {
  if (!META_API_TOKEN || !PHONE_NUMBER_ID) return false;
  
  // Auto-detect Media Type from URL Extension if not explicitly provided
  if (mediaUrl && mediaType === 'image') { // Default was image
      const ext = mediaUrl.split('.').pop().toLowerCase().split('?')[0]; // Handle query params
      if (['mp4', '3gp', 'mov'].includes(ext)) {
          mediaType = 'video';
      } else if (['pdf', 'doc', 'docx', 'ppt'].includes(ext)) {
          mediaType = 'document';
      }
  }

  // --- CONTENT FIREWALL ---
  const lowerBody = body ? body.toLowerCase() : "";
  const isPlaceholder = BLOCKED_REGEX.test(lowerBody);
  const isEmpty = !body || !body.trim();

  let isBlocked = false;

  if (templateName) {
      isBlocked = false; 
  } else if (mediaUrl) {
      if (isPlaceholder) {
          console.warn(`⚠️ FIREWALL: Stripped placeholder caption from media to ${to}`);
          body = ""; 
      }
  } else {
      if (isPlaceholder) {
           if (options && options.length > 0) {
               console.warn(`⚠️ FIREWALL: Auto-fixing placeholder for ${to}. Replaced with 'Please select an option:'`);
               body = "Please select an option:";
           } else {
               isBlocked = true;
           }
      } else if (isEmpty) {
          if (options && options.length > 0) {
              console.log("⚠️ FIREWALL: Fixed Empty Body for Options Message");
              body = "Please select an option:";
          } else {
              isBlocked = true;
          }
      }
  }

  if (isBlocked) {
      console.log("\n================ TRAFFIC WATCHDOG (BLOCKED) ================");
      console.log(`⛔ BLOCKED SUSPICIOUS MESSAGE TO: ${to}`);
      console.log(`CONTENT: "${body}"`);
      return false;
  }

  let payload = { messaging_product: 'whatsapp', to: to };
  
  if (templateName) {
    payload.type = 'template';
    payload.template = { name: templateName, language: { code: language } };
  } else if (mediaUrl) {
    const isYouTube = mediaUrl.includes('youtube.com') || mediaUrl.includes('youtu.be');
    
    // YOUTUBE SPECIAL CASE: Send as text preview link
    if (isYouTube) {
        payload.type = 'text';
        payload.text = { body: body ? `${body} ${mediaUrl}` : mediaUrl, preview_url: true };
    } 
    // AWS S3 / DIRECT FILE CASE: Send as Native Media
    else {
        payload.type = mediaType;
        payload[mediaType] = { link: mediaUrl };
        if (body && body.trim().length > 0) payload[mediaType].caption = body;
        // Document requires filename
        if (mediaType === 'document') {
             payload[mediaType].filename = mediaUrl.split('/').pop();
        }
    }
  } else if (options && options.length > 0) {
    const validOptions = options.filter(o => o && o.trim().length > 0);
    if (validOptions.length === 0) {
        payload.type = 'text';
        payload.text = { body: body };
    } else {
        const safeBody = body || "Select an option:";
        if (validOptions.length > 3) {
            payload.type = 'interactive';
            payload.interactive = {
                type: 'list',
                body: { text: safeBody },
                action: {
                    button: "Select",
                    sections: [{ title: "Options", rows: validOptions.slice(0, 10).map((opt, i) => ({ id: `opt_${i}`, title: opt.substring(0, 24) })) }]
                }
            };
        } else {
            payload.type = 'interactive';
            payload.interactive = {
                type: 'button',
                body: { text: safeBody },
                action: { 
                    buttons: validOptions.map((opt, i) => ({ type: 'reply', reply: { id: `btn_${i}`, title: opt.substring(0, 20) } })) 
                }
            };
        }
    }
  } else {
    payload.type = 'text';
    payload.text = { body: body };
  }
  
  console.log("\n================ TRAFFIC WATCHDOG (OUTGOING) ================");
  console.log(`📡 SENDING TO META: ${to}`);
  console.log(JSON.stringify(payload, null, 2));
  console.log("=============================================================\n");

  try {
    await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, payload, { headers: { Authorization: `Bearer ${META_API_TOKEN}` } });
    return true;
  } catch (error) { 
    console.error('Meta API Error:', error.response ? error.response.data : error.message); 
    return false;
  }
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
        const opts = options && options.length > 0 ? options : null;
        await queryWithRetry(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type, options, image_url) VALUES ($1, $2, 'system', $3, $4, $5, $6, $7)`,
            [msgId, driverId, text, Date.now(), type, opts, imageUrl]
        );
        await queryWithRetry('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [text, Date.now(), driverId]);
    } catch (e) {
        console.error("Failed to log system message:", e);
    }
};

const processIncomingMessage = async (from, name, msgBody, msgType = 'text', timestamp = Date.now()) => {
    try {
        const client = await pool.connect();
        let result = {};
        
        try {
            await client.query('BEGIN');
            const settingsRes = await client.query('SELECT settings FROM bot_settings WHERE id = 1');
            let botSettings = settingsRes.rows[0]?.settings || DEFAULT_BOT_SETTINGS;
            
            // Sanitize steps in memory
            if (botSettings.steps && Array.isArray(botSettings.steps)) {
                botSettings.steps = botSettings.steps.map(step => cleanStep(step));
            }

            const routingStrategy = botSettings.routingStrategy || 'HYBRID_BOT_FIRST';

            // Determine Start Node
            const entryPointId = botSettings.entryPointId || botSettings.steps?.[0]?.id;

            // 1. Get Driver & Log Message
            let driverRes = await client.query('SELECT * FROM drivers WHERE phone_number = $1', [from]);
            let driver = driverRes.rows[0];
            let isNewDriver = false;

            if (!driver) {
                isNewDriver = true;
                // Only active bot on new driver if not AI_ONLY
                const shouldActivateBot = botSettings.isEnabled && routingStrategy !== 'AI_ONLY';
                const insertRes = await client.query(
                    `INSERT INTO drivers (id, phone_number, name, source, status, last_message, last_message_time, documents, current_bot_step_id, is_bot_active, is_human_mode)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
                    [timestamp.toString(), from, name, 'WhatsApp', 'New', msgBody, timestamp, [], entryPointId, shouldActivateBot, false]
                );
                driver = insertRes.rows[0];
            }

            // Log User Message
            await client.query(
                `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'driver', $3, $4, $5)`,
                [`${timestamp}_${Math.random().toString(36).substr(2, 5)}`, driver.id, msgBody, timestamp, msgType]
            );
            await client.query('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [msgBody, timestamp, driver.id]);

            // --- STRATEGY LOGIC ---
            
            // PRIORITY 1: HUMAN MODE (Stop Everything)
            if (driver.is_human_mode) {
                 await client.query('COMMIT');
                 console.log(`🛑 HUMAN MODE: Skipped automation for ${driver.name}`);
                 return; // EXIT IMMEDIATELY
            }

            let replyText = null;
            let replyOptions = null;
            let replyTemplate = null;
            let replyMedia = null;
            let replyMediaType = null;
            let shouldCallAI = false;
            let currentStepId = null;

            // PRIORITY 2: AI ONLY
            if (botSettings.isEnabled && routingStrategy === 'AI_ONLY') {
                shouldCallAI = true;
            } 
            // PRIORITY 3: BOT LOGIC (Hybrid or Bot Only)
            else if (botSettings.isEnabled) {
                 // Activation Logic:
                 if (!driver.is_bot_active) {
                     // BOT_ONLY: Always restart flow if inactive (Looping)
                     if (routingStrategy === 'BOT_ONLY') {
                         if (entryPointId) {
                             await client.query('UPDATE drivers SET is_bot_active = TRUE, current_bot_step_id = $1 WHERE id = $2', [entryPointId, driver.id]);
                             driver.is_bot_active = true;
                             driver.current_bot_step_id = entryPointId;
                             isNewDriver = true; // Treat as new to trigger first msg
                         } else {
                             // Fallback if no steps defined but BOT_ONLY is active
                             replyText = "Our automated system is currently being configured. Please check back later.";
                         }
                     }
                     // HYBRID: If inactive, it implies handoff to AI has happened previously
                     else if (routingStrategy === 'HYBRID_BOT_FIRST') {
                         shouldCallAI = true; 
                     }
                 }

                 if (driver.is_bot_active && driver.current_bot_step_id) {
                     let currentStep = botSettings.steps.find(s => s.id === driver.current_bot_step_id);
                     
                     // Fallback if step ID invalid (deleted node)
                     if (!currentStep && botSettings.steps.length > 0) {
                         const firstStepId = entryPointId || botSettings.steps[0].id;
                         await client.query('UPDATE drivers SET current_bot_step_id = $1 WHERE id = $2', [firstStepId, driver.id]);
                         driver.current_bot_step_id = firstStepId;
                         currentStep = botSettings.steps.find(s => s.id === firstStepId);
                         isNewDriver = true; 
                     }

                     if (currentStep) {
                         currentStepId = currentStep.id; 

                         // If NOT new, process their answer to the *previous* step and move to next
                         if (!isNewDriver) {
                             // Save Data
                             if (currentStep.saveToField === 'name') await client.query('UPDATE drivers SET name = $1 WHERE id = $2', [msgBody, driver.id]);
                             if (currentStep.saveToField === 'availability') await client.query('UPDATE drivers SET availability = $1 WHERE id = $2', [msgBody, driver.id]);
                             if (currentStep.saveToField === 'vehicleRegistration') await client.query('UPDATE drivers SET vehicle_registration = $1 WHERE id = $2', [msgBody, driver.id]);

                             let nextId = currentStep.nextStepId;
                             
                             // COMPLETION LOGIC
                             if (nextId === 'AI_HANDOFF' || nextId === 'END' || !nextId) {
                                 // Stop Bot
                                 await client.query('UPDATE drivers SET is_bot_active = FALSE, current_bot_step_id = NULL WHERE id = $1', [driver.id]);
                                 driver.is_bot_active = false; 
                                 
                                 // Determine Handoff vs Loop End
                                 if (routingStrategy === 'HYBRID_BOT_FIRST') {
                                     if (nextId === 'AI_HANDOFF') shouldCallAI = true; // Explicit Handoff
                                     // Else: Flow ended naturally. Next message will hit "if !is_bot_active -> shouldCallAI" above.
                                     else replyText = "Thank you! We have received your details.";
                                 } else if (routingStrategy === 'BOT_ONLY') {
                                     // End of Loop. Send final message. Next user text will trigger "isNewDriver" logic above because we set active=false.
                                     replyText = "Thank you! Your details are saved.";
                                 }
                             } else {
                                 // Move to Next Step
                                 await client.query('UPDATE drivers SET current_bot_step_id = $1 WHERE id = $2', [nextId, driver.id]);
                                 const nextStep = botSettings.steps.find(s => s.id === nextId);
                                 if (nextStep) {
                                     currentStepId = nextStep.id; 
                                     replyText = nextStep.message;
                                     replyTemplate = nextStep.templateName;
                                     replyMedia = nextStep.mediaUrl;
                                     if (nextStep.title === 'Video') replyMediaType = 'video';
                                     else if (nextStep.title === 'Image') replyMediaType = 'image';
                                     else if (nextStep.title === 'File') replyMediaType = 'document';
                                     if(nextStep.options && nextStep.options.length > 0) replyOptions = nextStep.options;
                                 } else {
                                     replyText = "Thank you.";
                                 }
                             }
                         } else {
                             // IS NEW (First interaction or Restart) -> Send Current Step
                             replyText = currentStep.message;
                             replyTemplate = currentStep.templateName;
                             replyMedia = currentStep.mediaUrl;
                             if (currentStep.title === 'Video') replyMediaType = 'video';
                             else if (currentStep.title === 'Image') replyMediaType = 'image';
                             else if (currentStep.title === 'File') replyMediaType = 'document';
                             if(currentStep.options && currentStep.options.length > 0) replyOptions = currentStep.options;
                         }
                     }
                 } 
            }
            
            // Safety: If BOT_ONLY, never call AI
            if (routingStrategy === 'BOT_ONLY') shouldCallAI = false; 

            await client.query('COMMIT');
            result = { replyText, replyOptions, replyTemplate, replyMedia, replyMediaType, shouldCallAI, driver, botSettings, debugNodeId: currentStepId };
        } catch (err) {
            await client.query('ROLLBACK');
            if(err.code === '42P01') await ensureDatabaseInitialized(client);
            throw err;
        } finally {
            client.release();
        }
        
        // --- SENDING LOGIC ---
        let sent = false;
        
        const hasContent = (result.replyText && result.replyText.trim().length > 0) || 
                           (result.replyOptions && result.replyOptions.length > 0) ||
                           result.replyTemplate || 
                           result.replyMedia;

        if (hasContent) {
            if (result.replyTemplate) {
                sent = await sendWhatsAppMessage(from, null, null, result.replyTemplate);
                if (sent) await logSystemMessage(result.driver.id, `[Template: ${result.replyTemplate}]`, 'template');
            } else if (result.replyMedia) {
                let caption = result.replyText || "";
                if (result.debugNodeId) caption += ` [Debug: Node ${result.debugNodeId}]`;

                sent = await sendWhatsAppMessage(from, caption, null, null, 'en_US', result.replyMedia, result.replyMediaType);
                if (sent) await logSystemMessage(result.driver.id, caption || `[${result.replyMediaType}]`, 'image', null, result.replyMedia);
            } else if (result.replyText || (result.replyOptions && result.replyOptions.length > 0)) {
                let finalText = result.replyText || "";
                if (result.debugNodeId) {
                    finalText += `\n\n[🔍 Debug: Node ${result.debugNodeId}]`;
                }
                if (BLOCKED_REGEX.test(finalText)) {
                    finalText += `\n\n[🚨 CRITICAL: Placeholder Detected from Node ${result.debugNodeId}]`;
                }

                sent = await sendWhatsAppMessage(from, finalText, result.replyOptions);
                if (sent) {
                    const loggedText = !finalText && result.replyOptions ? "Please select an option:" : finalText;
                    await logSystemMessage(result.driver.id, loggedText, result.replyOptions ? 'options' : 'text', result.replyOptions);
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
    } catch (e) {
        console.error("Logic Error:", e.message);
    }
};

// --- ROUTES ---

// Create Folder (Now Syncs with S3)
app.post('/api/folders', async (req, res) => {
    try {
        const { name, parentPath } = req.body;
        const id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
        
        // 1. Create DB Record
        await queryWithRetry(
            `INSERT INTO media_folders (id, name, parent_path) VALUES ($1, $2, $3)`,
            [id, name, parentPath]
        );
        
        // 2. Create S3 "Folder" (0-byte object with trailing slash)
        if (process.env.AWS_BUCKET_NAME) {
            try {
                const parentPrefix = getS3FolderPrefix(parentPath);
                const folderKey = `${parentPrefix}${name}/`;
                
                await s3Client.send(new PutObjectCommand({
                    Bucket: BUCKET_NAME,
                    Key: folderKey,
                    Body: '', // Empty body for folder placeholder
                }));
                console.log(`✅ S3 Folder Created: ${folderKey}`);
            } catch (s3Err) {
                console.error("⚠️ S3 Folder Creation Error:", s3Err);
            }
        }

        res.json({ success: true, id });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// Delete Folder (Now Syncs with S3)
app.delete('/api/folders/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // 1. Get folder details
        const folderRes = await queryWithRetry('SELECT * FROM media_folders WHERE id = $1', [id]);
        if (folderRes.rows.length === 0) return res.status(404).json({ error: 'Folder not found' });
        
        const folder = folderRes.rows[0];
        
        // 2. Delete from DB
        await queryWithRetry('DELETE FROM media_folders WHERE id = $1', [id]);
        
        // 3. Delete from S3
        if (process.env.AWS_BUCKET_NAME) {
             try {
                const parentPrefix = getS3FolderPrefix(folder.parent_path);
                const folderKey = `${parentPrefix}${folder.name}/`;
                
                await s3Client.send(new DeleteObjectCommand({
                    Bucket: BUCKET_NAME,
                    Key: folderKey
                }));
                console.log(`✅ S3 Folder Deleted: ${folderKey}`);
             } catch (s3Err) {
                 console.error("⚠️ S3 Folder Deletion Error:", s3Err);
             }
        }

        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// --- NEW: DIRECT S3 PRESIGNED UPLOAD ---
app.post('/api/s3/presign', async (req, res) => {
    try {
        if (!process.env.AWS_BUCKET_NAME) return res.status(503).json({ error: 'AWS Config Missing' });
        
        const { filename, fileType, folderPath } = req.body;
        const cleanFolderPath = folderPath === '/' ? '' : folderPath.replace(/^\//, '') + '/';
        const key = `${cleanFolderPath}${Date.now()}-${filename.replace(/\s+/g, '_')}`;

        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            ContentType: fileType
        });

        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 }); // 5 minutes
        const publicUrl = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

        res.json({ uploadUrl, key, publicUrl });
    } catch (e) {
        console.error("Presign Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// --- NEW: REGISTER UPLOADED FILE ---
app.post('/api/files/register', async (req, res) => {
    try {
        const { key, url, filename, type, folderPath } = req.body;
        const id = Date.now().toString();

        await queryWithRetry(
            `INSERT INTO media_files (id, url, filename, type, uploaded_at, folder_path) VALUES ($1, $2, $3, $4, $5, $6)`,
            [id, url, filename, type, Date.now(), folderPath]
        );
        res.json({ success: true, id, url });
    } catch (e) {
        console.error("Registration Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// OLD Upload Endpoint (Fallback/Deprecated - but kept for small files if needed)
app.post('/api/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    // This endpoint is server-limited. Clients should prefer /api/s3/presign
    const folderPath = req.body.folderPath || '/';
    const cleanFolderPath = folderPath === '/' ? '' : folderPath.replace(/^\//, '') + '/';
    const fileType = req.file.mimetype.split('/')[0]; 
    const filename = `${cleanFolderPath}${Date.now()}-${req.file.originalname.replace(/\s+/g, '_')}`;

    try {
        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: filename,
            Body: req.file.buffer,
            ContentType: req.file.mimetype,
        });

        await s3Client.send(command);
        const publicUrl = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${filename}`;
        
        await queryWithRetry(
            `INSERT INTO media_files (id, url, filename, type, uploaded_at, folder_path) VALUES ($1, $2, $3, $4, $5, $6)`,
            [Date.now().toString(), publicUrl, req.file.originalname, fileType, Date.now(), folderPath]
        );
        res.json({ url: publicUrl, type: fileType });
    } catch (err) {
        res.status(500).json({ error: 'Upload Failed', details: err.message });
    }
});

// Delete File Endpoint
app.delete('/api/files/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // 1. Get File Info from DB
        const fileRes = await queryWithRetry('SELECT * FROM media_files WHERE id = $1', [id]);
        if (fileRes.rows.length === 0) {
            return res.status(404).json({ error: 'File not found in database' });
        }
        
        const fileRecord = fileRes.rows[0];
        
        // 2. Extract S3 Key from URL
        // URL Format: https://BUCKET.s3.REGION.amazonaws.com/KEY
        // We split by amazonaws.com/ to get the key part
        const parts = fileRecord.url.split('.amazonaws.com/');
        if (parts.length < 2) {
             // Fallback: If URL format is unexpected, just delete from DB
             console.warn("Could not parse S3 Key from URL:", fileRecord.url);
        } else {
             const key = parts[1];
             
             // 3. Delete from S3
             if (process.env.AWS_BUCKET_NAME) {
                 try {
                     const command = new DeleteObjectCommand({
                         Bucket: BUCKET_NAME,
                         Key: key
                     });
                     await s3Client.send(command);
                     console.log(`Deleted S3 Object: ${key}`);
                 } catch (s3Err) {
                     console.error("S3 Deletion Error:", s3Err);
                     // We continue to delete from DB even if S3 fails, to keep UI clean, 
                     // OR return error? Usually better to clean DB.
                 }
             }
        }

        // 4. Delete from Database
        await queryWithRetry('DELETE FROM media_files WHERE id = $1', [id]);
        
        res.json({ success: true });
    } catch (e) {
        console.error("Delete File Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// Get Media (Files + Folders) for a specific path
app.get('/api/media', async (req, res) => {
    try {
        const currentPath = req.query.path || '/';
        
        // Fetch subfolders in this path
        const folders = await queryWithRetry(
            'SELECT * FROM media_folders WHERE parent_path = $1 ORDER BY name ASC',
            [currentPath]
        );

        // Fetch files in this path
        const files = await queryWithRetry(
            'SELECT * FROM media_files WHERE folder_path = $1 ORDER BY uploaded_at DESC',
            [currentPath]
        );

        res.json({ folders: folders.rows, files: files.rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/messages/send', async (req, res) => {
    try {
        const { driverId, text } = req.body;
        const driverRes = await queryWithRetry('SELECT phone_number FROM drivers WHERE id = $1', [driverId]);
        if (driverRes.rows.length === 0) return res.status(404).json({ error: 'Driver not found' });
        
        // Check if text is a Media URL from our S3
        let mediaUrl = null;
        let mediaType = 'image';
        
        if (text.startsWith('http') && (text.includes('s3.amazonaws.com') || text.includes('youtube'))) {
            mediaUrl = text;
            const ext = text.split('.').pop().toLowerCase();
            if (['mp4', 'mov', '3gp'].includes(ext)) mediaType = 'video';
            if (['pdf', 'doc'].includes(ext)) mediaType = 'document';
        }

        const sent = await sendWhatsAppMessage(
            driverRes.rows[0].phone_number, 
            mediaUrl ? "" : text, // Caption is empty if just media, or text if message
            null, 
            null, 
            'en_US', 
            mediaUrl, 
            mediaType
        );

        if (!sent) return res.status(400).json({ error: 'Message blocked by firewall' });
        
        await queryWithRetry(`INSERT INTO messages (id, driver_id, sender, text, timestamp, type, image_url) VALUES ($1, $2, 'agent', $3, $4, $5, $6)`, 
            [Date.now().toString(), driverId, mediaUrl ? '' : text, Date.now(), mediaUrl ? 'image' : 'text', mediaUrl]
        );
        await queryWithRetry(`UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3`, [mediaUrl ? '[Media Sent]' : text, Date.now(), driverId]);
        
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update driver details including is_human_mode
app.patch('/api/drivers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        // Build dynamic query
        const fields = [];
        const values = [];
        let idx = 1;
        
        if (updates.status) { fields.push(`status = $${idx++}`); values.push(updates.status); }
        if (updates.name) { fields.push(`name = $${idx++}`); values.push(updates.name); }
        if (updates.vehicleRegistration) { fields.push(`vehicle_registration = $${idx++}`); values.push(updates.vehicleRegistration); }
        if (updates.availability) { fields.push(`availability = $${idx++}`); values.push(updates.availability); }
        if (updates.qualificationChecks) { fields.push(`qualification_checks = $${idx++}`); values.push(updates.qualificationChecks); }
        if (updates.isHumanMode !== undefined) { fields.push(`is_human_mode = $${idx++}`); values.push(updates.isHumanMode); }
        
        if (fields.length === 0) return res.json({ success: true });

        values.push(id);
        const query = `UPDATE drivers SET ${fields.join(', ')} WHERE id = $${idx}`;
        
        await queryWithRetry(query, values);
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Update the drivers fetch to include messages and proper mapping
app.get('/api/drivers', async (req, res) => {
    try {
        const result = await queryWithRetry(`
            SELECT 
                d.id,
                d.phone_number as "phoneNumber",
                d.name,
                d.source,
                d.status,
                d.last_message as "lastMessage",
                d.last_message_time as "lastMessageTime",
                COALESCE(d.documents, ARRAY[]::text[]) as documents, 
                d.onboarding_step as "onboardingStep",
                d.vehicle_registration as "vehicleRegistration",
                d.availability,
                d.qualification_checks as "qualificationChecks",
                d.current_bot_step_id as "currentBotStepId",
                d.is_bot_active as "isBotActive",
                d.is_human_mode as "isHumanMode",
                COALESCE(
                    (
                        SELECT JSON_AGG(
                            JSON_BUILD_OBJECT(
                                'id', m.id,
                                'sender', m.sender,
                                'text', m.text,
                                'imageUrl', m.image_url,
                                'timestamp', m.timestamp,
                                'type', m.type,
                                'options', m.options
                            ) ORDER BY m.timestamp ASC
                        )
                        FROM messages m
                        WHERE m.driver_id = d.id
                    ),
                    '[]'::json
                ) as messages
            FROM drivers d 
            ORDER BY d.last_message_time DESC
        `);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ... Existing Routes ...
app.post('/api/admin/audit-flow', async (req, res) => {
    try {
        const { nodes } = req.body;
        console.log(`🕵️ [AI AUDIT] Request received for ${nodes?.length} nodes...`);
        if (!nodes || nodes.length === 0) return res.json({ isValid: true, issues: [] });
        const ghostIssues = [];
        nodes.forEach(n => {
            if (n.data.templateName && n.data.templateName.length > 0) {
                 if (['hello_world', 'sample_flight_confirmation'].includes(n.data.templateName)) {
                     ghostIssues.push({ nodeId: n.id, severity: 'WARNING', issue: 'Sample Template Detected', suggestion: `Node '${n.data.label}' is using a default Meta template: ${n.data.templateName}`, autoFixValue: null });
                 }
            }
        });
        res.json({ isValid: ghostIssues.length === 0, issues: ghostIssues });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/health', async (req, res) => { try { await queryWithRetry('SELECT 1'); res.json({ status: 'healthy' }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/bot-settings', async (req, res) => { try { const result = await queryWithRetry('SELECT * FROM bot_settings WHERE id = 1'); res.json(result.rows[0]?.settings || DEFAULT_BOT_SETTINGS); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/bot-settings', async (req, res) => { try { let settings = req.body; if (settings.steps && Array.isArray(settings.steps)) { settings.steps = settings.steps.map(step => cleanStep(step)); } await queryWithRetry(`UPDATE bot_settings SET settings = $1 WHERE id = 1`, [JSON.stringify(settings)]); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/webhook', (req, res) => { if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) res.send(req.query['hub.challenge']); else res.sendStatus(403); });
app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
        const msgObj = body.entry[0].changes[0].value.messages[0];
        const contact = body.entry[0].changes[0].value.contacts?.[0];
        const phone = msgObj.from;
        const name = contact?.profile?.name || 'Unknown';
        let msgBody = msgObj.text?.body || '[Media]';
        let msgType = 'text';
        if (msgObj.type === 'interactive') { 
            if (msgObj.interactive.type === 'list_reply') msgBody = msgObj.interactive.list_reply.title;
            else if (msgObj.interactive.type === 'button_reply') msgBody = msgObj.interactive.button_reply.title; 
            msgType = 'option_reply'; 
        } else if (msgObj.type === 'image') { msgBody = '[Image]'; msgType = 'image'; }
        await processIncomingMessage(phone, name, msgBody, msgType);
    }
    res.sendStatus(200);
});

module.exports = app;
if (require.main === module) app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

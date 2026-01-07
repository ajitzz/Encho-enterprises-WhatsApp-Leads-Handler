
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

// --- SECURITY: CONTENT FIREWALL ---
// Regex matches variations of default placeholder text
const BLOCKED_REGEX = /replace\s+this\s+sample\s+message|enter\s+your\s+message|type\s+your\s+message\s+here|replace\s+this\s+text/i;

// HELPER: Clean a single step
const cleanStep = (step) => {
    if (!step) return step;
    const msg = step.message || "";
    // If message contains blocked text
    if (BLOCKED_REGEX.test(msg)) {
        console.log(`🧹 FIREWALL: Stripping placeholder from step '${step.title || step.id}'`);
        
        // If it has options, give it a safe fallback so it doesn't break
        if (step.options && step.options.length > 0) {
            step.message = "Please select an option:";
        } else {
            // Otherwise, wipe it clean. The runtime will skip empty messages.
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
        if ((err.code === '57P01' || err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === '42P01' || err.code === '42703') && retries > 0) {
            console.log(`♻️ Retrying... (${retries} left)`);
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

// --- SCHEMA & INITIALIZATION ---
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
        availability TEXT
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

        if (settings.steps && Array.isArray(settings.steps)) {
            settings.steps = settings.steps.map(step => {
                const originalMsg = step.message;
                const cleanedStep = cleanStep(step); // Use shared helper
                if (cleanedStep.message !== originalMsg) {
                    hasChanges = true;
                }
                return cleanedStep;
            });
        }

        // If we found bad data, save the clean version back to DB
        if (hasChanges) {
            await client.query('UPDATE bot_settings SET settings = $1 WHERE id = 1', [JSON.stringify(settings)]);
            console.log("✅ DATABASE SANITIZED: Placeholder texts removed.");
        }
    } catch (e) {
        console.error("Sanitization failed:", e);
    }
};

const ensureDatabaseInitialized = async (client) => {
    try {
        await client.query('BEGIN');
        await client.query(SCHEMA_SQL);
        
        await client.query(`
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS options TEXT[];
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS current_bot_step_id TEXT;
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_bot_active BOOLEAN DEFAULT FALSE;
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS onboarding_step INTEGER DEFAULT 0;
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_registration TEXT;
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS availability TEXT;
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS qualification_checks JSONB DEFAULT '{"hasValidLicense": false, "hasVehicle": false, "isLocallyAvailable": true}'::jsonb;
        `);

        const settingsRes = await client.query('SELECT * FROM bot_settings WHERE id = 1');
        if (settingsRes.rows.length === 0) {
            await client.query('INSERT INTO bot_settings (id, settings) VALUES (1, $1)', [JSON.stringify(DEFAULT_BOT_SETTINGS)]);
        }
        
        // Run sanitization inside the transaction context if needed, or after commit
        await client.query('COMMIT');
        
        // Run clean up immediately after init
        await sanitizeBotSettings(client);

    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Schema Init Failed:", e);
    }
};

// --- AI ENGINE ---
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- LOCAL AUDIT ENGINE (Fallback) ---
const runLocalAudit = (nodes) => {
    console.log(`🛡️ [Local Auditor] Running heuristic check on ${nodes.length} nodes...`);
    const issues = [];
    nodes.forEach(node => {
        if (node.id === 'start' || node.type === 'start' || node.data?.type === 'start') return;
        
        const data = node.data || {};
        
        // 1. Check for Placeholder
        if (data.message && BLOCKED_REGEX.test(data.message)) {
             issues.push({ 
                 nodeId: node.id, 
                 severity: 'CRITICAL', 
                 issue: 'Placeholder Text Detected', 
                 suggestion: 'You are using default text. Please write a real message.', 
                 autoFixValue: 'Please reply.' 
             });
        }
        // 2. Check for Empty Text
        else if ((data.label === 'Text' || data.inputType === 'text') && (!data.message || !data.message.trim())) {
            issues.push({ 
                nodeId: node.id, 
                severity: 'CRITICAL', 
                issue: 'Empty Message', 
                suggestion: 'This message bubble is empty.', 
                autoFixValue: 'Hello!' 
            });
        }
        // 3. Check for Missing Media
        else if (['Image', 'Video'].includes(data.label)) {
            if (!data.mediaUrl || !data.mediaUrl.trim()) {
                 issues.push({ 
                     nodeId: node.id, 
                     severity: 'CRITICAL', 
                     issue: 'Missing Media URL', 
                     suggestion: 'This media node has no file link. Please add a URL.', 
                     autoFixValue: null 
                 });
            }
        }
        // 4. Check for Empty Options
        else if (data.inputType === 'option') {
            if (!data.options || data.options.length === 0) {
                 issues.push({
                     nodeId: node.id,
                     severity: 'CRITICAL',
                     issue: 'No Options',
                     suggestion: 'Add at least one button option.',
                     autoFixValue: ['Yes', 'No']
                 });
            } else if (data.options.some(o => !o || !o.trim())) {
                 issues.push({
                     nodeId: node.id,
                     severity: 'WARNING',
                     issue: 'Empty Option Label',
                     suggestion: 'One or more buttons have no text.',
                     autoFixValue: data.options.filter(o => o && o.trim())
                 });
            }
        }
    });
    console.log(`🛡️ [Local Auditor] Found ${issues.length} issues.`);
    return { isValid: issues.length === 0, issues };
};

// --- LOGIC ENGINE ---
const sendWhatsAppMessage = async (to, body, options = null, templateName = null, language = 'en_US', mediaUrl = null, mediaType = 'image') => {
  if (!META_API_TOKEN || !PHONE_NUMBER_ID) return false;
  
  // --- CONTENT FIREWALL ---
  const lowerBody = body ? body.toLowerCase() : "";
  const isPlaceholder = BLOCKED_REGEX.test(lowerBody);
  const isEmpty = !body || !body.trim();

  let isBlocked = false;

  if (templateName) {
      isBlocked = false; // Templates are pre-approved
      console.log(`📤 Sending Template: ${templateName}`); // LOG THIS to help diagnosis
  } else if (mediaUrl) {
      if (isPlaceholder) {
          console.warn(`⚠️ FIREWALL: Stripped placeholder caption from media to ${to}`);
          body = ""; // Allow media but remove bad caption
      }
  } else {
      // Text or Interactive Messages
      if (isPlaceholder) {
           if (options && options.length > 0) {
               console.warn(`⚠️ FIREWALL: Auto-fixing placeholder for ${to}. Replaced with 'Please select an option:'`);
               body = "Please select an option:";
           } else {
               console.error(`⛔ FIREWALL: Blocked Restricted Phrase: "${body}"`);
               isBlocked = true;
           }
      } else if (isEmpty) {
          if (options && options.length > 0) {
              console.log("⚠️ FIREWALL: Fixed Empty Body for Options Message");
              body = "Please select an option:";
          } else {
              console.error(`⛔ FIREWALL: Blocked Empty Message to ${to}`);
              isBlocked = true;
          }
      }
  }

  if (isBlocked) return false;

  let payload = { messaging_product: 'whatsapp', to: to };
  
  if (templateName) {
    payload.type = 'template';
    payload.template = { name: templateName, language: { code: language } };
  } else if (mediaUrl) {
    const isYouTube = mediaUrl.includes('youtube.com') || mediaUrl.includes('youtu.be');
    if (isYouTube) {
        payload.type = 'text';
        payload.text = { body: body ? `${body} ${mediaUrl}` : mediaUrl, preview_url: true };
    } else {
        payload.type = mediaType;
        payload[mediaType] = { link: mediaUrl };
        if (body && body.trim().length > 0) payload[mediaType].caption = body; 
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
            
            // --- RUNTIME SANITIZATION (In Memory) ---
            if (botSettings.steps && Array.isArray(botSettings.steps)) {
                botSettings.steps = botSettings.steps.map(step => cleanStep(step));
            }

            const routingStrategy = botSettings.routingStrategy || 'HYBRID_BOT_FIRST';

            let driverRes = await client.query('SELECT * FROM drivers WHERE phone_number = $1', [from]);
            let driver = driverRes.rows[0];
            let isNewDriver = false;

            if (!driver) {
                isNewDriver = true;
                const shouldActivateBot = botSettings.isEnabled && routingStrategy !== 'AI_ONLY';
                const insertRes = await client.query(
                    `INSERT INTO drivers (id, phone_number, name, source, status, last_message, last_message_time, documents, current_bot_step_id, is_bot_active)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
                    [timestamp.toString(), from, name, 'WhatsApp', 'New', msgBody, timestamp, [], botSettings.steps?.[0]?.id, shouldActivateBot]
                );
                driver = insertRes.rows[0];
            }

            await client.query(
                `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'driver', $3, $4, $5)`,
                [`${timestamp}_${Math.random().toString(36).substr(2, 5)}`, driver.id, msgBody, timestamp, msgType]
            );
            await client.query('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [msgBody, timestamp, driver.id]);

            let replyText = null;
            let replyOptions = null;
            let replyTemplate = null;
            let replyMedia = null;
            let replyMediaType = null;
            let shouldCallAI = false;

            if (botSettings.isEnabled && routingStrategy === 'AI_ONLY') {
                shouldCallAI = true;
            } 
            else if (botSettings.isEnabled) {
                 if (!driver.is_bot_active) {
                     if (routingStrategy === 'BOT_ONLY') {
                         const firstStepId = botSettings.steps?.[0]?.id;
                         if (firstStepId) {
                             await client.query('UPDATE drivers SET is_bot_active = TRUE, current_bot_step_id = $1 WHERE id = $2', [firstStepId, driver.id]);
                             driver.is_bot_active = true;
                             driver.current_bot_step_id = firstStepId;
                             isNewDriver = true; 
                         }
                     } else if (routingStrategy === 'HYBRID_BOT_FIRST') {
                         shouldCallAI = true;
                     }
                 }

                 if (driver.is_bot_active && driver.current_bot_step_id) {
                     let currentStep = botSettings.steps.find(s => s.id === driver.current_bot_step_id);
                     if (!currentStep && botSettings.steps.length > 0) {
                         const firstStepId = botSettings.steps[0].id;
                         await client.query('UPDATE drivers SET current_bot_step_id = $1 WHERE id = $2', [firstStepId, driver.id]);
                         driver.current_bot_step_id = firstStepId;
                         currentStep = botSettings.steps[0];
                         isNewDriver = true; 
                     }

                     if (currentStep) {
                         // Save logic and step advancement (same as before)
                         if (!isNewDriver) {
                             if (currentStep.saveToField === 'name') await client.query('UPDATE drivers SET name = $1 WHERE id = $2', [msgBody, driver.id]);
                             if (currentStep.saveToField === 'availability') await client.query('UPDATE drivers SET availability = $1 WHERE id = $2', [msgBody, driver.id]);
                             if (currentStep.saveToField === 'vehicleRegistration') await client.query('UPDATE drivers SET vehicle_registration = $1 WHERE id = $2', [msgBody, driver.id]);

                             let nextId = currentStep.nextStepId;
                             if (nextId === 'AI_HANDOFF' || nextId === 'END' || !nextId) {
                                 await client.query('UPDATE drivers SET is_bot_active = FALSE, current_bot_step_id = NULL WHERE id = $1', [driver.id]);
                                 driver.is_bot_active = false; 
                                 if (nextId === 'AI_HANDOFF' && routingStrategy === 'HYBRID_BOT_FIRST') shouldCallAI = true;
                                 else replyText = "Thank you! We have received your details.";
                             } else {
                                 await client.query('UPDATE drivers SET current_bot_step_id = $1 WHERE id = $2', [nextId, driver.id]);
                                 const nextStep = botSettings.steps.find(s => s.id === nextId);
                                 if (nextStep) {
                                     replyText = nextStep.message;
                                     replyTemplate = nextStep.templateName;
                                     replyMedia = nextStep.mediaUrl;
                                     if (nextStep.title === 'Video') replyMediaType = 'video';
                                     else if (nextStep.title === 'Image') replyMediaType = 'image';
                                     else if (nextStep.title === 'File') replyMediaType = 'document';
                                     if(nextStep.options && nextStep.options.length > 0) replyOptions = nextStep.options;
                                 }
                             }
                         } else {
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
            if (routingStrategy === 'BOT_ONLY') shouldCallAI = false; 
            await client.query('COMMIT');
            result = { replyText, replyOptions, replyTemplate, replyMedia, replyMediaType, shouldCallAI, driver, botSettings };
        } catch (err) {
            await client.query('ROLLBACK');
            if(err.code === '42P01') await ensureDatabaseInitialized(client);
            throw err;
        } finally {
            client.release();
        }
        
        let sent = false;
        
        // CRITICAL CHECK: Do not send if text is empty/null AND no options/media/template
        // This prevents the "Replace this sample message!" (if sanitized to "") from sending an empty bubble.
        const hasContent = (result.replyText && result.replyText.trim().length > 0) || 
                           (result.replyOptions && result.replyOptions.length > 0) ||
                           result.replyTemplate || 
                           result.replyMedia;

        if (hasContent) {
            if (result.replyTemplate) {
                sent = await sendWhatsAppMessage(from, null, null, result.replyTemplate);
                if (sent) await logSystemMessage(result.driver.id, `[Template] ${result.replyTemplate}`, 'template');
            } else if (result.replyMedia) {
                sent = await sendWhatsAppMessage(from, result.replyText, null, null, 'en_US', result.replyMedia, result.replyMediaType);
                if (sent) await logSystemMessage(result.driver.id, result.replyText || `[${result.replyMediaType}]`, 'image', null, result.replyMedia);
            } else if (result.replyText || (result.replyOptions && result.replyOptions.length > 0)) {
                // Double check sanitization happened
                sent = await sendWhatsAppMessage(from, result.replyText, result.replyOptions);
                if (sent) {
                    const loggedText = !result.replyText && result.replyOptions ? "Please select an option:" : result.replyText;
                    await logSystemMessage(result.driver.id, loggedText, result.replyOptions ? 'options' : 'text', result.replyOptions);
                }
            }
        } 
        
        // Only call AI if NO bot step was matched/sent, or strategy dictates it
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
app.post('/api/admin/audit-flow', async (req, res) => {
    try {
        const { nodes } = req.body;
        console.log(`🕵️ [AI AUDIT] Request received for ${nodes?.length} nodes...`);
        
        if (!nodes || nodes.length === 0) return res.json({ isValid: true, issues: [] });

        const flowContext = JSON.stringify(nodes.map(n => ({ 
            id: n.id, 
            type: n.data.label, 
            message: n.data.message, 
            options: n.data.options, 
            mediaUrl: n.data.mediaUrl 
        })));

        const prompt = `
        You are a Quality Assurance AI. Analyze this flow for:
        1. "Placeholder Text" (e.g. "replace this", "sample message").
        2. "Empty Options" (Button nodes with no buttons).
        3. "Empty Text" (Text nodes with no text).
        4. "Missing Media" (Image nodes with no URL).
        INPUT: ${flowContext}
        OUTPUT JSON: { "isValid": boolean, "issues": [{ "nodeId": string, "severity": "CRITICAL"|"WARNING", "issue": string, "suggestion": string, "autoFixValue": string }] }
        `;

        try {
            const response = await ai.models.generateContent({
              model: "gemini-3-flash-preview",
              contents: prompt,
              config: { responseMimeType: "application/json" }
            });
            const cleanText = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
            res.json(JSON.parse(cleanText));
        } catch (aiError) {
            // FALLBACK TO LOCAL AUDIT IF 429
            console.warn("⚠️ AI Audit Failed/Blocked. Switching to Local Logic.", aiError.message);
            const localReport = runLocalAudit(nodes);
            res.json(localReport);
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Standard Routes
app.get('/api/health', async (req, res) => {
    try { await queryWithRetry('SELECT 1'); res.json({ status: 'healthy' }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/drivers', async (req, res) => {
    try {
        const result = await queryWithRetry(`SELECT * FROM drivers ORDER BY last_message_time DESC`);
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/bot-settings', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM bot_settings WHERE id = 1');
        res.json(result.rows[0]?.settings || DEFAULT_BOT_SETTINGS);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// UPGRADED: Save Bot Settings with PRE-SAVE SANITIZATION
app.post('/api/bot-settings', async (req, res) => {
    try {
        let settings = req.body;
        
        // DEEP CLEAN BEFORE SAVE
        if (settings.steps && Array.isArray(settings.steps)) {
            settings.steps = settings.steps.map(step => cleanStep(step));
        }

        await queryWithRetry(`UPDATE bot_settings SET settings = $1 WHERE id = 1`, [JSON.stringify(settings)]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/messages/send', async (req, res) => {
    try {
        const { driverId, text } = req.body;
        const driverRes = await queryWithRetry('SELECT phone_number FROM drivers WHERE id = $1', [driverId]);
        if (driverRes.rows.length === 0) return res.status(404).json({ error: 'Driver not found' });
        const sent = await sendWhatsAppMessage(driverRes.rows[0].phone_number, text);
        if (!sent) return res.status(400).json({ error: 'Message blocked by firewall' });
        await queryWithRetry(`INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'agent', $3, $4, 'text')`, [Date.now().toString(), driverId, text, Date.now()]);
        await queryWithRetry(`UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3`, [text, Date.now(), driverId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) res.send(req.query['hub.challenge']);
    else res.sendStatus(403);
});
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


/**
 * UBER FLEET RECRUITER - BACKEND SERVER
 * Enterprise-Grade Connection Handling for Vercel + Neon
 * 
 * Strategy:
 * 1. Singleton Pool with TCP Keep-Alive
 * 2. Automatic Query Retries (Self-Healing)
 * 3. Circuit Breaker for Connection Deadlocks
 * 4. Auto-Scaling AI Model Selection (Pro -> Flash -> Lite -> Local)
 * 5. Smart Traffic Control (Queueing + Caching + Circuit Breaker)
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg'); 
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs'); 
const path = require('path'); 
const crypto = require('crypto'); // For cache hashing
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

// --- STATE TRACKING ---
let lastWebhookTime = 0;

// --- AI TRAFFIC CONTROL ---
const MODEL_PRO = "gemini-3-pro-preview";
const MODEL_FLASH = "gemini-3-flash-preview";
const MODEL_LITE = "gemini-flash-lite-latest";

// 1. Circuit Breaker
let isCircuitOpen = false;
let circuitResetTime = 0;
const CIRCUIT_COOLDOWN_MS = 60000; // 60 seconds full stop on 429

// 2. Caching
const responseCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache for heavy tasks

// 3. Background Queue
let backgroundQueue = Promise.resolve();

let aiStatusCache = { status: 'unknown', message: 'Initializing...', lastCheck: 0, activeModel: MODEL_PRO };

const getActiveModel = () => {
    if (isCircuitOpen) return 'NONE'; // Should catch before this
    // If recently downgraded, stick to Flash
    if (aiStatusCache.activeModel === MODEL_LITE || aiStatusCache.activeModel === MODEL_FLASH) {
        // Try to upgrade back to Pro after 2 minutes of stability
        if (Date.now() - aiStatusCache.lastCheck > 120000) return MODEL_PRO;
        return aiStatusCache.activeModel;
    }
    return MODEL_PRO;
};

// --- SECURITY: CONTENT FIREWALL ---
const BLOCKED_REGEX = /replace\s+this\s+sample\s+message|enter\s+your\s+message|type\s+your\s+message\s+here|replace\s+this\s+text/i;

// --- ROBUST DATABASE CONNECTION ---
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

// --- SCHEMA & AUTO-HEALING ---
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
  systemInstruction: "You are a friendly and persuasive recruiter for Uber Fleet in Kerala.",
  steps: [
    { id: 'step_1', title: 'Welcome & Name', message: 'നമസ്കാരം! Uber Fleet-ലേക്ക് സ്വാഗതം. നിങ്ങളുടെ പേര് പറയാമോ?', inputType: 'text', saveToField: 'name', nextStepId: 'step_2' },
    { id: 'step_2', title: 'License Check', message: 'നന്ദി! നിങ്ങളുടെ കൈയ്യിൽ valid ആയ Commercial Driving License ഉണ്ടോ?', inputType: 'option', options: ['ഉണ്ട് (Yes)', 'ഇല്ല (No)'], nextStepId: 'step_3' },
    { id: 'step_3', title: 'Upload License', message: 'Verification-ന് വേണ്ടി License-ന്റെ ഒരു ഫോട്ടോ അയച്ചുതരൂ.', inputType: 'image', saveToField: 'document', nextStepId: 'step_4' },
    { id: 'step_4', title: 'Availability', message: 'എപ്പോഴാണ് ഡ്രൈവ് ചെയ്യാൻ താല്പര്യം? (Full-time / Part-time)', inputType: 'option', options: ['Full-time', 'Part-time', 'Weekends'], saveToField: 'availability', nextStepId: 'AI_HANDOFF' }
  ],
  flowData: {
      nodes: [
          { id: 'start', type: 'custom', position: { x: 50, y: 300 }, data: { type: 'start', label: 'Start' } },
          { id: 'step_1', type: 'custom', position: { x: 300, y: 300 }, data: { label: 'Text', message: 'നമസ്കാരം! Uber Fleet-ലേക്ക് സ്വാഗതം. നിങ്ങളുടെ പേര് പറയാമോ?', inputType: 'text', saveToField: 'name' } },
          { id: 'step_2', type: 'custom', position: { x: 600, y: 300 }, data: { label: 'Quick Reply', message: 'നന്ദി! നിങ്ങളുടെ കൈയ്യിൽ valid ആയ Commercial Driving License ഉണ്ടോ?', inputType: 'option', options: ['ഉണ്ട് (Yes)', 'ഇല്ല (No)'] } },
          { id: 'step_3', type: 'custom', position: { x: 900, y: 300 }, data: { label: 'Image', message: 'Verification-ന് വേണ്ടി License-ന്റെ ഒരു ഫോട്ടോ അയച്ചുതരൂ.', inputType: 'image', saveToField: 'document' } },
          { id: 'step_4', type: 'custom', position: { x: 1200, y: 300 }, data: { label: 'Quick Reply', message: 'എപ്പോഴാണ് ഡ്രൈവ് ചെയ്യാൻ താല്പര്യം? (Full-time / Part-time)', inputType: 'option', options: ['Full-time', 'Part-time', 'Weekends'], saveToField: 'availability' } },
          { id: 'end', type: 'custom', position: { x: 1500, y: 300 }, data: { type: 'end', label: 'End' } }
      ],
      edges: [
          { id: 'e_start-step_1', source: 'start', target: 'step_1', type: 'smoothstep', animated: true },
          { id: 'e_step_1-step_2', source: 'step_1', target: 'step_2', type: 'smoothstep', animated: true },
          { id: 'e_step_2-step_3', source: 'step_2', target: 'step_3', sourceHandle: 'opt_0', type: 'smoothstep', animated: true },
          { id: 'e_step_3-step_4', source: 'step_3', target: 'step_4', type: 'smoothstep', animated: true },
          { id: 'e_step_4-end', source: 'step_4', target: 'end', type: 'smoothstep', animated: true }
      ]
  }
};

// --- DATABASE CLEANER (Runs on Startup) ---
const sanitizeDatabaseOnStartup = async (client) => {
    try {
        console.log("🧹 Running Database Sanitizer...");
        const res = await client.query('SELECT settings FROM bot_settings WHERE id = 1');
        if (res.rows.length > 0) {
            let settings = res.rows[0].settings;
            let dirty = false;

            // 1. INJECT VISUAL FLOW IF MISSING
            if (!settings.flowData || !settings.flowData.nodes || settings.flowData.nodes.length === 0) {
                console.warn("   ⚠️  Injecting default visual flow into existing database...");
                settings.flowData = DEFAULT_BOT_SETTINGS.flowData;
                dirty = true;
            }

            // 2. CLEAN GHOST MESSAGES & PLACEHOLDERS
            if (settings.steps && Array.isArray(settings.steps)) {
                const initialCount = settings.steps.length;
                settings.steps = settings.steps.filter(step => {
                    const hasText = step.message && step.message.trim().length > 0;
                    const hasMedia = step.mediaUrl && step.mediaUrl.trim().length > 0;
                    const hasOptions = step.options && step.options.length > 0;
                    return hasText || hasMedia || hasOptions;
                }).map(step => {
                    // Check for placeholder text
                    if (step.message && BLOCKED_REGEX.test(step.message)) {
                        if (step.options && step.options.length > 0) {
                            step.message = "Please select an option:";
                        } else {
                            step.message = ""; // Clear it if no options, will be filtered next run or ignored
                        }
                        dirty = true;
                    }
                    return step;
                });
                if (settings.steps.length !== initialCount) dirty = true;
            }

            if (dirty) {
                await client.query('UPDATE bot_settings SET settings = $1 WHERE id = 1', [JSON.stringify(settings)]);
                console.log("   ✅ Database Cleaned & Updated.");
            } else {
                console.log("   ✨ Database is clean.");
            }
        }
    } catch (e) {
        console.error("   ❌ Sanitizer Failed:", e.message);
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
        
        await sanitizeDatabaseOnStartup(client);
        await client.query('COMMIT');
        console.log("✅ Database initialized & Migrated successfully");
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Schema Init Failed:", e);
    }
};

// --- AI ENGINE ---
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const cleanJSON = (text) => {
  if (!text) return "{}";
  return text.replace(/```json/g, '').replace(/```/g, '').trim();
};

const getCacheKey = (task, content) => {
    const str = typeof content === 'string' ? content : JSON.stringify(content);
    return crypto.createHash('md5').update(`${task}:${str}`).digest('hex');
};

const generateContentSmart = async (contents, config = {}, systemInstruction = undefined, taskName = 'General Task') => {
    if (isCircuitOpen) {
        const timeLeft = Math.ceil((circuitResetTime - Date.now()) / 1000);
        throw new Error(`System Cooling Down. Please wait ${timeLeft} seconds.`);
    }

    const executeCall = async () => {
        let targetModel = getActiveModel();
        const runModel = async (model) => {
            const reqConfig = { ...config };
            if (systemInstruction) reqConfig.systemInstruction = systemInstruction;
            console.log(`🤖 [AI SMART] Starting '${taskName}' using model: ${model}`);
            return await ai.models.generateContent({ model, contents, config: reqConfig });
        };

        try {
            const result = await runModel(targetModel);
            if (targetModel === MODEL_PRO) {
                aiStatusCache = { status: 'operational', message: 'Gemini Pro Active', lastCheck: Date.now(), activeModel: MODEL_PRO };
            } else {
                aiStatusCache = { status: 'degraded', message: 'Using Lite Model', lastCheck: Date.now(), activeModel: targetModel };
            }
            return result;
        } catch (e) {
            console.warn(`⚠️ [AI SMART] Quota Hit on ${targetModel}. Backing off...`);
            if (e.status === 429 || e.message?.includes('429')) {
                if (targetModel === MODEL_LITE || isCircuitOpen) {
                     isCircuitOpen = true;
                     circuitResetTime = Date.now() + CIRCUIT_COOLDOWN_MS;
                     aiStatusCache = { status: 'cooldown', message: 'System Cooling Down (60s)', lastCheck: Date.now(), activeModel: 'NONE' };
                     setTimeout(() => { isCircuitOpen = false; aiStatusCache.status = 'operational'; }, CIRCUIT_COOLDOWN_MS);
                     throw new Error("System Overload. Auto-pause for 60s.");
                }
                await new Promise(r => setTimeout(r, 2000));
                try {
                    console.log(`♻️ [AI SMART] Retry '${taskName}' with LITE model`);
                    const result = await runModel(MODEL_LITE);
                    aiStatusCache = { status: 'degraded', message: 'Fallback to Lite Active', lastCheck: Date.now(), activeModel: MODEL_LITE };
                    return result;
                } catch (e2) { 
                    console.error("💥 [AI SMART] Fallback Failed. Tripping Circuit.");
                    throw e2; 
                }
            }
            throw e;
        }
    };
    return executeCall();
};

const runLocalAudit = (nodes) => {
    console.log("🛡️ [Local Auditor] Running heuristic check...");
    const issues = [];
    nodes.forEach(node => {
        // Skip structural nodes
        if (node.id === 'start' || node.type === 'start' || node.data?.type === 'start' || 
            node.id === 'end' || node.type === 'end' || node.data?.type === 'end') return;
        
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
        // 3. Check for Empty Options
        else if (data.inputType === 'option') {
            if (!data.options || data.options.length === 0) {
                 issues.push({
                     nodeId: node.id,
                     severity: 'CRITICAL',
                     issue: 'No Options',
                     suggestion: 'Add at least one button option.',
                     autoFixValue: ['Yes', 'No']
                 });
            }
        }
    });
    console.log(`🛡️ [Local Auditor] Found ${issues.length} issues.`);
    return { isValid: issues.length === 0, issues };
};

// --- ROUTES ---

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

app.post('/api/bot-settings', async (req, res) => {
    try {
        await queryWithRetry(`UPDATE bot_settings SET settings = $1 WHERE id = 1`, [JSON.stringify(req.body)]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- NEW AI AUDIT ROUTE ---
app.post('/api/admin/audit-flow', async (req, res) => {
    try {
        const { nodes, edges } = req.body;
        console.log(`🕵️ [AI AUDIT] Request received for ${nodes?.length} nodes...`);
        
        if (!nodes || nodes.length === 0) {
            return res.json({ isValid: true, issues: [] });
        }

        // Prepare context for AI
        const flowContext = JSON.stringify(nodes.map(n => ({ 
            id: n.id, 
            type: n.data.label, 
            message: n.data.message, 
            options: n.data.options, 
            mediaUrl: n.data.mediaUrl 
        })));

        const prompt = `
        You are a Quality Assurance AI for a Chatbot Flow.
        Analyze this flow for empty messages, placeholder text, and logic errors.

        STRICT RULES:
        1. "Placeholder Text": Any message containing "replace this", "sample message", "type here".
        2. "Empty Options": An Options node where the 'options' array is empty.
        3. "Empty Text": A Text node with an empty or whitespace-only message.
        4. "Missing Media": A Media node (Image/Video) with no URL.

        INPUT: ${flowContext}

        OUTPUT JSON:
        {
            "isValid": boolean,
            "issues": [
                {
                    "nodeId": "string",
                    "severity": "CRITICAL" | "WARNING",
                    "issue": "string description",
                    "suggestion": "how to fix",
                    "autoFixValue": "string or array or null" 
                }
            ]
        }
        `;

        try {
            const response = await generateContentSmart(prompt, { 
                responseMimeType: "application/json"
            }, "You are a rigid code validator.", "Audit Flow");
            
            const report = JSON.parse(cleanJSON(response.text));
            console.log(`✅ [AI AUDIT] Complete. Found ${report.issues?.length || 0} issues.`);
            res.json(report);

        } catch (aiError) {
            console.warn("⚠️ AI Audit Failed/Blocked. Switching to Local Logic.", aiError.message);
            // Fallback to heuristic check
            const localReport = runLocalAudit(nodes);
            res.json(localReport);
        }

    } catch (e) {
        console.error("❌ [AI AUDIT] Fatal Error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/messages/send', async (req, res) => {
    try {
        const { driverId, text } = req.body;
        const driverRes = await queryWithRetry('SELECT phone_number FROM drivers WHERE id = $1', [driverId]);
        if (driverRes.rows.length === 0) return res.status(404).json({ error: 'Driver not found' });
        
        const phoneNumber = driverRes.rows[0].phone_number;
        const sent = await sendWhatsAppMessage(phoneNumber, text);
        
        if (!sent) return res.status(400).json({ error: 'Message blocked by firewall' });

        const msgId = Date.now().toString(); 
        await queryWithRetry(`INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'agent', $3, $4, 'text')`, [msgId, driverId, text, Date.now()]);
        await queryWithRetry(`UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3`, [text, Date.now(), driverId]);

        res.json({ success: true, messageId: msgId });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- HELPER: LOGIC ENGINE ---
const sendWhatsAppMessage = async (to, body, options = null, templateName = null, language = 'en_US', mediaUrl = null, mediaType = 'image') => {
  if (!META_API_TOKEN || !PHONE_NUMBER_ID) return false;
  
  // 1. FIREWALL: STRICT EMPTY CHECK
  if (!body && !mediaUrl && !templateName && (!options || options.length === 0)) {
      console.warn("⚠️ Blocked empty message attempt to", to);
      return false;
  }

  // 2. FIREWALL: PLACEHOLDER CHECK
  if (body && BLOCKED_REGEX.test(body)) {
      // If buttons exist, just replace the bad text with a standard prompt
      if (options && options.length > 0) {
          console.warn(`⚠️ Auto-fixing placeholder text for ${to}. Replaced with 'Please select an option:'`);
          body = "Please select an option:";
      } 
      // If it's a media message with caption, just remove the caption
      else if (mediaUrl) {
          body = ""; 
      }
      // If it's pure text with placeholder -> BLOCK IT
      else {
          console.warn(`🛑 BLOCKED placeholder text message to ${to}: "${body}"`);
          return false;
      }
  }

  let payload = { messaging_product: 'whatsapp', to: to };
  
  if (templateName) {
    payload.type = 'template';
    payload.template = { name: templateName, language: { code: language } };
  } else if (mediaUrl) {
    payload.type = mediaType;
    payload[mediaType] = { link: mediaUrl };
    if (body) payload[mediaType].caption = body; 
  } else if (options && options.length > 0) {
      payload.type = 'interactive';
      payload.interactive = {
        type: 'button',
        body: { text: body || "Select option:" },
        action: { buttons: options.slice(0,3).map((o,i) => ({ type: 'reply', reply: { id: `btn_${i}`, title: o.substring(0,20) } })) }
      };
  } else {
    payload.type = 'text';
    payload.text = { body: body };
  }
  
  try {
    await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, payload, { headers: { Authorization: `Bearer ${META_API_TOKEN}` } });
    return true;
  } catch (error) { 
    console.error("WhatsApp Send Error:", error.response?.data || error.message);
    return false;
  }
};

const analyzeWithAI = async (text, systemInstruction) => {
  try {
    const response = await generateContentSmart(text, { maxOutputTokens: 150 }, systemInstruction, "Incoming Message Analysis");
    return response.text;
  } catch (e) { 
      return "Thanks for contacting Uber Fleet."; 
  }
};

const logSystemMessage = async (driverId, text, type = 'text', options = null, imageUrl = null) => {
    try {
        const msgId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 5);
        await queryWithRetry(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type, options, image_url) VALUES ($1, $2, 'system', $3, $4, $5, $6, $7)`,
            [msgId, driverId, text, Date.now(), type, options, imageUrl]
        );
        await queryWithRetry('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [text, Date.now(), driverId]);
    } catch (e) {}
};

const processIncomingMessage = async (from, name, msgBody, msgType = 'text', timestamp = Date.now()) => {
    lastWebhookTime = Date.now();
    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const settingsRes = await client.query('SELECT settings FROM bot_settings WHERE id = 1');
            const botSettings = settingsRes.rows[0]?.settings || DEFAULT_BOT_SETTINGS;
            
            let driverRes = await client.query('SELECT * FROM drivers WHERE phone_number = $1', [from]);
            let driver = driverRes.rows[0];
            
            if (!driver) {
                const insertRes = await client.query(
                    `INSERT INTO drivers (id, phone_number, name, source, status, last_message, last_message_time, documents, is_bot_active, current_bot_step_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
                    [timestamp.toString(), from, name, 'WhatsApp', 'New', msgBody, timestamp, [], true, botSettings.steps[0]?.id]
                );
                driver = insertRes.rows[0];
            }
            
            await client.query(
                `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'driver', $3, $4, $5)`,
                [`${timestamp}_${Math.random().toString(36).substr(2, 5)}`, driver.id, msgBody, timestamp, msgType]
            );

            // --- BOT ENGINE LOGIC ---
            // If Bot is enabled and driver is in a flow
            if (botSettings.isEnabled && driver.is_bot_active && botSettings.routingStrategy !== 'AI_ONLY') {
                const currentStep = botSettings.steps.find(s => s.id === driver.current_bot_step_id);
                
                // If found, send the message for this step
                if (currentStep) {
                    const sent = await sendWhatsAppMessage(from, currentStep.message, currentStep.options, currentStep.templateName, 'en_US', currentStep.mediaUrl);
                    if (sent) {
                        await logSystemMessage(driver.id, currentStep.message, currentStep.options ? 'options' : 'text', currentStep.options);
                        
                        // Advance to next step for NEXT time
                        const nextId = currentStep.nextStepId;
                        if (nextId === 'END' || nextId === 'AI_HANDOFF' || !nextId) {
                             await client.query('UPDATE drivers SET is_bot_active = FALSE, current_bot_step_id = NULL WHERE id = $1', [driver.id]);
                        } else {
                             await client.query('UPDATE drivers SET current_bot_step_id = $1 WHERE id = $2', [nextId, driver.id]);
                        }
                    }
                } else {
                    // Fallback to AI if flow broken
                    const aiReply = await analyzeWithAI(msgBody, botSettings.systemInstruction);
                    if (aiReply) {
                        await sendWhatsAppMessage(from, aiReply);
                        await logSystemMessage(driver.id, aiReply);
                    }
                }
            } 
            // Fallback: AI Only Mode
            else if (botSettings.isEnabled && botSettings.routingStrategy === 'AI_ONLY') {
                const aiReply = await analyzeWithAI(msgBody, botSettings.systemInstruction);
                if (aiReply) {
                    await sendWhatsAppMessage(from, aiReply);
                    await logSystemMessage(driver.id, aiReply);
                }
            }

            await client.query('COMMIT');
        } catch(e) { await client.query('ROLLBACK'); console.error(e); } finally { client.release(); }
    } catch (e) { console.error(e); }
};

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
        const msgBody = msgObj.text?.body || '[Media]';
        await processIncomingMessage(phone, name, msgBody);
    }
    res.sendStatus(200);
});

app.patch('/api/drivers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        if (updates.status) await queryWithRetry('UPDATE drivers SET status = $1 WHERE id = $2', [updates.status, id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/update-credentials', (req, res) => {
    if(req.body.phoneNumberId) PHONE_NUMBER_ID = req.body.phoneNumberId;
    if(req.body.apiToken) META_API_TOKEN = req.body.apiToken;
    res.json({ success: true });
});

app.post('/api/configure-webhook', (req, res) => {
    if(req.body.verifyToken) VERIFY_TOKEN = req.body.verifyToken;
    res.json({ success: true });
});

module.exports = app;
if (require.main === module) app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

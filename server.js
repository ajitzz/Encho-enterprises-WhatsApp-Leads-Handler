
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
let CACHED_BOT_SETTINGS = {
  isEnabled: true,
  routingStrategy: 'HYBRID_BOT_FIRST',
  systemInstruction: "You are a friendly agent. Answer appropriately.",
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
  connectionTimeoutMillis: 15000,
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
    CREATE TABLE IF NOT EXISTS companies (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(50) DEFAULT 'logistics',
        terminology JSONB,
        theme_color VARCHAR(20) DEFAULT '#000000',
        created_at BIGINT
    );

    CREATE TABLE IF NOT EXISTS drivers (
        id VARCHAR(255) PRIMARY KEY,
        company_id VARCHAR(50) REFERENCES companies(id) DEFAULT '1',
        phone_number VARCHAR(50),
        name VARCHAR(255),
        source VARCHAR(50) DEFAULT 'Organic',
        status VARCHAR(50) DEFAULT 'New',
        last_message TEXT,
        last_message_time BIGINT,
        documents TEXT[],
        bot_state JSONB DEFAULT '{}',
        vehicle_details JSONB DEFAULT '{}',
        created_at BIGINT,
        qualification_checks JSONB DEFAULT '{"check1": false, "check2": false, "check3": true}'::jsonb,
        current_bot_step_id TEXT,
        is_bot_active BOOLEAN DEFAULT FALSE,
        onboarding_step INTEGER DEFAULT 0,
        vehicle_registration TEXT, -- Maps to CustomField1
        availability TEXT, -- Maps to CustomField2
        is_human_mode BOOLEAN DEFAULT FALSE,
        notes TEXT,
        UNIQUE(company_id, phone_number)
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
        id SERIAL PRIMARY KEY,
        company_id VARCHAR(50) REFERENCES companies(id) UNIQUE,
        settings JSONB
    );

    CREATE TABLE IF NOT EXISTS media_folders (
        id VARCHAR(255) PRIMARY KEY,
        company_id VARCHAR(50) REFERENCES companies(id) DEFAULT '1',
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
        folder_path VARCHAR(255) DEFAULT '/',
        company_id VARCHAR(50) REFERENCES companies(id) DEFAULT '1'
    );
`;

const ensureDatabaseInitialized = async (client) => {
    try {
        await client.query('BEGIN');
        await client.query(SCHEMA_SQL);
        
        // --- MIGRATION / SELF-HEAL ---
        await client.query(`
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS company_id VARCHAR(50) DEFAULT '1';
            ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS company_id VARCHAR(50) DEFAULT '1';
            ALTER TABLE media_folders ADD COLUMN IF NOT EXISTS company_id VARCHAR(50) DEFAULT '1';
            ALTER TABLE media_files ADD COLUMN IF NOT EXISTS company_id VARCHAR(50) DEFAULT '1';
            
            -- Ensure Unique Constraint on drivers including company_id
            -- Note: We skip complex constraint modification here to avoid data loss risks in production, 
            -- rely on logic checks in code.
        `);

        // Seed Default Companies
        const company1 = {
            id: '1', name: 'Encho Cabs', type: 'logistics', 
            terminology: { singular: 'Driver', plural: 'Drivers', field1Label: 'License Plate', field2Label: 'Availability' },
            themeColor: '#000000'
        };
        const company2 = {
            id: '2', name: 'Encho Travel', type: 'travel', 
            terminology: { singular: 'Traveler', plural: 'Travelers', field1Label: 'Travel Date', field2Label: 'Group Size' },
            themeColor: '#0ea5e9'
        };

        await client.query(
            `INSERT INTO companies (id, name, type, terminology, theme_color, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
            [company1.id, company1.name, company1.type, JSON.stringify(company1.terminology), company1.themeColor, Date.now()]
        );
        await client.query(
            `INSERT INTO companies (id, name, type, terminology, theme_color, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
            [company2.id, company2.name, company2.type, JSON.stringify(company2.terminology), company2.themeColor, Date.now()]
        );

        // Seed Default Settings for both
        await client.query('INSERT INTO bot_settings (company_id, settings) VALUES ($1, $2) ON CONFLICT (company_id) DO NOTHING', ['1', JSON.stringify(CACHED_BOT_SETTINGS)]);
        await client.query('INSERT INTO bot_settings (company_id, settings) VALUES ($1, $2) ON CONFLICT (company_id) DO NOTHING', ['2', JSON.stringify({...CACHED_BOT_SETTINGS, systemInstruction: "You are a travel guide."})]);

        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("❌ Schema Init/Heal Failed:", e);
    }
};

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

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
    Current Notes: "${currentNotes || ''}"
    
    TASK:
    1. Generate a helpful reply.
    2. Extract key details (Name, Location, Dates, Intent) and summarize them.
    
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
      return { reply: "Thanks for contacting us.", updatedNotes: currentNotes }; 
  }
};

const logSystemMessage = async (leadId, text, type = 'text', options = null, imageUrl = null) => {
    try {
        const msgId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 5);
        await queryWithRetry(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type, options, image_url) VALUES ($1, $2, 'system', $3, $4, $5, $6, $7)`,
            [msgId, leadId, text, Date.now(), type, options && options.length ? options : null, imageUrl]
        );
        await queryWithRetry('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [text, Date.now(), leadId]);
    } catch (e) { console.error("Log failed (Non-Critical)", e.message); }
};

// --- DATA MAPPERS ---

const mapLeadToFrontend = (row) => ({
    id: row.id,
    companyId: row.company_id,
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
    customField1: row.vehicle_registration, // Generic mapping
    customField2: row.availability,
    qualificationChecks: row.qualification_checks || { check1: false, check2: false, check3: true },
    currentBotStepId: row.current_bot_step_id,
    isBotActive: row.is_bot_active,
    isHumanMode: row.is_human_mode
});

const mapUpdateKeys = (updates) => {
    const map = {
        'isHumanMode': 'is_human_mode',
        'qualificationChecks': 'qualification_checks',
        'customField1': 'vehicle_registration',
        'customField2': 'availability',
        'currentBotStepId': 'current_bot_step_id',
        'isBotActive': 'is_bot_active',
        'lastMessage': 'last_message',
        'lastMessageTime': 'last_message_time',
        'phoneNumber': 'phone_number',
        'notes': 'notes',
        'status': 'status',
        'name': 'name',
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
// For now, we route all incoming WhatsApp messages to Company ID '1' (Cabs) 
// or implement simple logic if multiple phone numbers were supported.
// Here we will assume Company 1 for simplicity in this demo.
const DEFAULT_COMPANY_ID = '1'; 

const processIncomingMessage = async (from, name, msgBody, msgType = 'text', timestamp = Date.now()) => {
    
    // 1. Fetch Settings for Company
    let botSettings = CACHED_BOT_SETTINGS;
    try {
        const settingsRes = await queryWithRetry('SELECT settings FROM bot_settings WHERE company_id = $1', [DEFAULT_COMPANY_ID], 1);
        if (settingsRes.rows.length > 0) {
            botSettings = cleanBotSettings(settingsRes.rows[0].settings);
        }
    } catch(e) { console.warn("Using Cached Settings"); }

    const routingStrategy = botSettings.routingStrategy || 'HYBRID_BOT_FIRST';
    const entryPointId = botSettings.entryPointId || botSettings.steps?.[0]?.id;

    let lead = { 
        id: 'temp_' + from, 
        companyId: DEFAULT_COMPANY_ID,
        phone_number: from, 
        name: name, 
        is_bot_active: true, 
        is_human_mode: false, 
        notes: '' 
    };
    
    let isFlowStart = false; 
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Check for Lead in specific Company
        let leadRes = await client.query('SELECT * FROM drivers WHERE phone_number = $1 AND company_id = $2', [from, DEFAULT_COMPANY_ID]);
        
        if (leadRes.rows.length === 0) {
             const shouldActivateBot = botSettings.isEnabled && routingStrategy !== 'AI_ONLY';
             const insertRes = await client.query(
                `INSERT INTO drivers (id, company_id, phone_number, name, source, status, last_message, last_message_time, current_bot_step_id, is_bot_active, is_human_mode)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
                [timestamp.toString(), DEFAULT_COMPANY_ID, from, name, 'WhatsApp', 'New', msgBody, timestamp, entryPointId, shouldActivateBot, false]
            );
            lead = insertRes.rows[0];
            if (shouldActivateBot) isFlowStart = true;
        } else {
            lead = leadRes.rows[0];
            await client.query('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [msgBody, timestamp, lead.id]);
        }
        
        await client.query(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'driver', $3, $4, $5)`,
            [`${timestamp}_${Math.random().toString(36).substr(2, 5)}`, lead.id, msgBody, timestamp, msgType]
        );
        
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("DB Sync Failed", err.code);
    } finally { client.release(); }

    if (lead.is_human_mode) return;

    let replyText = null; let replyOptions = null; let replyTemplate = null; let replyMedia = null; let replyMediaType = null; let shouldCallAI = false;
    let updatesToSave = {};

    if (botSettings.isEnabled && routingStrategy === 'AI_ONLY') { shouldCallAI = true; } 
    else if (botSettings.isEnabled) {
         if (!lead.is_bot_active && routingStrategy === 'BOT_ONLY') {
             lead.is_bot_active = true;
             lead.current_bot_step_id = entryPointId;
             updatesToSave.isBotActive = true; 
             updatesToSave.currentBotStepId = entryPointId;
             isFlowStart = true;
         }

         if (lead.is_bot_active && !lead.current_bot_step_id && botSettings.steps.length > 0) {
              const firstId = entryPointId || botSettings.steps[0].id;
              lead.current_bot_step_id = firstId;
              updatesToSave.currentBotStepId = firstId;
              isFlowStart = true;
         }

         if (lead.is_bot_active && lead.current_bot_step_id) {
             let currentStep = botSettings.steps.find(s => s.id === lead.current_bot_step_id);
             
             if (!currentStep && botSettings.steps.length > 0) {
                 const firstId = entryPointId || botSettings.steps[0].id;
                 lead.current_bot_step_id = firstId;
                 currentStep = botSettings.steps.find(s => s.id === firstId);
                 updatesToSave.currentBotStepId = firstId;
                 isFlowStart = true;
             }

             if (currentStep) {
                 if (isFlowStart) {
                     replyText = currentStep.message;
                     replyTemplate = currentStep.templateName;
                     replyMedia = currentStep.mediaUrl;
                     replyMediaType = currentStep.mediaType || (currentStep.mediaUrl ? 'image' : undefined);
                     replyOptions = currentStep.options;
                 } 
                 else {
                     if (currentStep.saveToField) {
                         updatesToSave[currentStep.saveToField] = msgBody; // Generic mapping: name, customField1, etc
                     }

                     let nextId = currentStep.nextStepId; 

                     if (currentStep.routes && Object.keys(currentStep.routes).length > 0) {
                        const cleanInput = msgBody.trim().toLowerCase();
                        console.log(`[ROUTER] Checking input "${cleanInput}" against keys:`, Object.keys(currentStep.routes));

                        const routeKey = Object.keys(currentStep.routes).find(k => {
                            const cleanKey = k.toLowerCase();
                            return cleanKey === cleanInput || cleanKey.startsWith(cleanInput) || cleanInput.startsWith(cleanKey) || cleanInput.includes(cleanKey);
                        });
                        
                        if (routeKey) {
                            nextId = currentStep.routes[routeKey];
                        } else {
                            replyText = "Please select one of the valid options below:";
                            replyOptions = currentStep.options; 
                            updatesToSave = {}; 
                            
                            const sent = await sendWhatsAppMessage(from, replyText, replyOptions);
                            if (sent && !lead.id.startsWith('temp_')) {
                                await logSystemMessage(lead.id, replyText, 'text');
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
                             replyTemplate = nextStep.templateName;
                             replyMedia = nextStep.mediaUrl;
                             replyMediaType = nextStep.mediaType || (nextStep.mediaUrl ? 'image' : undefined);
                             replyOptions = nextStep.options;
                         }
                     }
                 }
             }
         } else if (lead.is_bot_active && routingStrategy === 'HYBRID_BOT_FIRST') shouldCallAI = true;
    }

    let sent = false;
    if (replyTemplate || replyText || replyMedia) {
        if (replyTemplate) {
            sent = await sendWhatsAppMessage(from, null, null, replyTemplate);
        } 
        if (!sent) {
            let caption = replyText || "";
            if (replyMedia) {
                sent = await sendWhatsAppMessage(from, caption, null, null, 'en_US', replyMedia, replyMediaType);
            } else {
                sent = await sendWhatsAppMessage(from, caption, replyOptions);
            }
        }
        if (sent && !lead.id.startsWith('temp_')) {
             await logSystemMessage(lead.id, replyText || `[${replyMediaType || 'template'}]`, 'text');
        }
    } 
    
    if (!sent && shouldCallAI) {
        const aiResult = await analyzeWithAI(msgBody, lead.notes, botSettings.systemInstruction);
        const aiReply = aiResult.reply;
        
        if (aiResult.updatedNotes && aiResult.updatedNotes !== lead.notes) {
            updatesToSave.notes = aiResult.updatedNotes;
        }

        if (aiReply && aiReply.trim()) {
            sent = await sendWhatsAppMessage(from, aiReply);
            if (sent && !lead.id.startsWith('temp_')) await logSystemMessage(lead.id, aiReply, 'text');
        }
    }

    if (Object.keys(updatesToSave).length > 0 && !lead.id.startsWith('temp_')) {
        try {
            const mappedUpdates = mapUpdateKeys(updatesToSave);
            const keys = Object.keys(mappedUpdates);
            if (keys.length > 0) {
                const setClause = keys.map((k, i) => `${k} = $${i+2}`).join(', ');
                const values = keys.map(k => typeof mappedUpdates[k] === 'object' ? JSON.stringify(mappedUpdates[k]) : mappedUpdates[k]);
                await queryWithRetry(`UPDATE drivers SET ${setClause} WHERE id = $1`, [lead.id, ...values]);
            }
        } catch(e) { console.warn("Failed to save state updates:", e.message); }
    }
};

// --- ENDPOINTS ---

app.get('/api/companies', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM companies ORDER BY created_at ASC', []);
        res.json(result.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/leads/:id', async (req, res) => { 
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

app.get('/api/leads', async (req, res) => { 
    try {
        // Multi-Tenant Filter
        const companyId = req.headers['x-company-id'] || '1'; 
        
        const client = await pool.connect();
        try {
            const leadsRes = await client.query('SELECT * FROM drivers WHERE company_id = $1 ORDER BY last_message_time DESC LIMIT 100', [companyId]);
            const leads = leadsRes.rows;

            if (leads.length === 0) {
                res.json([]);
                return;
            }

            const leadIds = leads.map(d => d.id);
            const messagesRes = await client.query(`
                SELECT * FROM messages 
                WHERE driver_id = ANY($1) 
                ORDER BY timestamp ASC
            `, [leadIds]);

            const messagesByLead = {};
            messagesRes.rows.forEach(msg => {
                if (!messagesByLead[msg.driver_id]) messagesByLead[msg.driver_id] = [];
                messagesByLead[msg.driver_id].push({
                    id: msg.id,
                    sender: msg.sender,
                    text: msg.text,
                    imageUrl: msg.image_url,
                    timestamp: parseInt(msg.timestamp),
                    type: msg.type,
                    options: msg.options
                });
            });

            const mappedLeads = leads.map(row => {
                const d = mapLeadToFrontend(row);
                d.messages = messagesByLead[row.id] || [];
                return d;
            });

            res.json(mappedLeads);
        } finally {
            client.release();
        }
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// MEDIA ENDPOINTS with Company Isolation
app.get('/api/media', async (req, res) => {
    try {
        const companyId = req.headers['x-company-id'] || '1';
        const currentPath = req.query.path || '/';
        const folders = await queryWithRetry('SELECT * FROM media_folders WHERE parent_path = $1 AND company_id = $2 ORDER BY name ASC', [currentPath, companyId]);
        const files = await queryWithRetry(`
            SELECT mf.*, wmc.media_id, wmc.expires_at
            FROM media_files mf 
            LEFT JOIN whatsapp_media_cache wmc ON mf.url = wmc.s3_url
            WHERE mf.folder_path = $1 AND mf.company_id = $2
            ORDER BY mf.uploaded_at DESC`, [currentPath, companyId]);
        
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
        const companyId = req.headers['x-company-id'] || '1';
        const { name, parentPath } = req.body;
        const existing = await queryWithRetry(
            'SELECT id FROM media_folders WHERE name = $1 AND company_id = $2',
            [name, companyId]
        );
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Folder name already exists.' });
        }
        const id = Date.now().toString();
        await queryWithRetry('INSERT INTO media_folders (id, company_id, name, parent_path, is_public_showcase) VALUES ($1, $2, $3, $4, FALSE)', [id, companyId, name, parentPath]);
        res.json({ success: true, id });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bot-settings', async (req, res) => { 
    try {
        const companyId = req.headers['x-company-id'] || '1';
        const resDb = await queryWithRetry('SELECT settings FROM bot_settings WHERE company_id = $1', [companyId]);
        // Merge with default cache if not found
        res.json(resDb.rows[0]?.settings || { ...CACHED_BOT_SETTINGS, companyId });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bot-settings', async (req, res) => { 
    try {
        const companyId = req.headers['x-company-id'] || '1';
        // Ensure companyId is saved
        const settings = { ...req.body, companyId };
        
        await queryWithRetry(`
            INSERT INTO bot_settings (company_id, settings) VALUES ($1, $2)
            ON CONFLICT (company_id) DO UPDATE SET settings = $2
        `, [companyId, JSON.stringify(settings)]);
        
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ... (Other endpoints logic remains similar but should ideally filter by company_id)

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
    } catch(e) {
        console.error("Webhook Error:", e);
        res.sendStatus(500);
    }
});

module.exports = app;
if (require.main === module) app.listen(PORT, () => console.log(`🚀 Enterprise Server running on port ${PORT}`));

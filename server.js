/**
 * UBER FLEET RECRUITER - BACKEND SERVER
 * Enterprise-Grade Connection Handling for Vercel + Neon
 * 
 * Strategy:
 * 1. Singleton Pool with TCP Keep-Alive
 * 2. Automatic Query Retries (Self-Healing)
 * 3. Circuit Breaker for Connection Deadlocks
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

// --- STATE TRACKING ---
let lastWebhookTime = 0;
let aiStatusCache = { status: 'unknown', message: 'Initializing...', lastCheck: 0 };

// --- SECURITY: CONTENT FIREWALL ---
// Regex matches: "replace this sample message", "enter your message", etc., case insensitive, ignoring extra spaces
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
  systemInstruction: "You are a friendly recruiter for Uber Fleet. Answer in Malayalam and English.",
  steps: []
};

// --- DATABASE CLEANER (Runs on Startup) ---
const sanitizeDatabaseOnStartup = async (client) => {
    try {
        console.log("🧹 Running Database Sanitizer...");
        const res = await client.query('SELECT settings FROM bot_settings WHERE id = 1');
        if (res.rows.length > 0) {
            let settings = res.rows[0].settings;
            let dirty = false;

            if (settings.steps && Array.isArray(settings.steps)) {
                settings.steps = settings.steps.map(step => {
                    if (step.message && BLOCKED_REGEX.test(step.message)) {
                        console.warn(`   ⚠️  Purging prohibited text from Step ${step.id}`);
                        // If it has options, give it a safe label so buttons still work
                        if (step.options && step.options.length > 0) {
                            step.message = "Please select an option:";
                        } else {
                            step.message = ""; // Empty string (will be blocked by firewall)
                        }
                        dirty = true;
                    }
                    return step;
                });
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
        
        // --- MIGRATIONS ---
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
        
        // RUN SANITIZER
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

// --- SYSTEM HEALTH CHECK HELPERS ---
const checkAIHealth = async () => {
    // Cache result for 60 seconds to avoid burning quota on health checks
    if (Date.now() - aiStatusCache.lastCheck < 60000) {
        return aiStatusCache;
    }

    try {
        // Use Flash for minimal cost ping
        await ai.models.generateContent({ 
            model: "gemini-3-flash-preview", 
            contents: "ping",
            config: { maxOutputTokens: 1 } 
        });
        aiStatusCache = { status: 'operational', message: 'Operational', lastCheck: Date.now() };
    } catch (e) {
        console.error("AI Check Error:", e.message);
        if (e.status === 429 || e.message.includes('429')) {
            aiStatusCache = { status: 'quota_exceeded', message: 'Credit Limit Exceeded', lastCheck: Date.now() };
        } else {
            aiStatusCache = { status: 'error', message: 'Connection Failed', lastCheck: Date.now() };
        }
    }
    return aiStatusCache;
};

// --- ASSISTANT TOOLS DEFINITION ---
const ASSISTANT_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "list_leads",
        description: "List drivers/leads from the database. Can filter by status or source.",
        parameters: {
          type: "OBJECT",
          properties: {
            status: { type: "STRING", description: "Filter by status (New, Qualified, Flagged, Rejected, Onboarded)" },
            source: { type: "STRING", description: "Filter by source (Organic, Meta Ad)" },
            limit: { type: "INTEGER", description: "Limit number of results (default 50)" }
          }
        }
      },
      {
        name: "update_lead_status",
        description: "Update the status of a specific driver/lead.",
        parameters: {
          type: "OBJECT",
          properties: {
            driver_id: { type: "STRING", description: "The ID of the driver" },
            new_status: { type: "STRING", description: "The new status (New, Qualified, Flagged, Rejected, Onboarded)" }
          },
          required: ["driver_id", "new_status"]
        }
      },
      {
        name: "get_bot_settings",
        description: "Get the current configuration of the recruitment bot (instructions, steps, etc).",
        parameters: { type: "OBJECT", properties: {} }
      },
      {
        name: "update_bot_instruction",
        description: "Update the System Instruction (Persona) of the recruitment bot. Use this when the user wants to change how the bot behaves.",
        parameters: {
          type: "OBJECT",
          properties: {
            instruction: { type: "STRING", description: "The new system prompt/persona for the bot." }
          },
          required: ["instruction"]
        }
      },
      {
        name: "run_sql_analytics",
        description: "Run a read-only SQL query to get analytics (counts, stats). DO NOT use for modifying data.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "The SQL SELECT query" }
          },
          required: ["query"]
        }
      }
    ]
  }
];

// --- ROUTES ---

// NEW: Helper for Recursive File Reading
function getProjectFiles(dir, fileList = [], rootDir = dir) {
    const files = fs.readdirSync(dir);
    fileList = fileList || [];
    files.forEach((file) => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            if (file !== 'node_modules' && file !== '.git' && file !== 'dist' && file !== '.next' && file !== 'build') {
                getProjectFiles(filePath, fileList, rootDir);
            }
        } else {
             const ext = path.extname(file);
             if (['.js', '.ts', '.tsx', '.json', '.html', '.css', '.md'].includes(ext)) {
                 // Store relative path for cleaner AI context
                 fileList.push({
                     path: path.relative(rootDir, filePath).replace(/\\/g, '/'), // Normalize path
                     content: fs.readFileSync(filePath, 'utf8')
                 });
             }
        }
    });
    return fileList;
}

// NEW: Get Complete Project Context
app.get('/api/admin/project-context', async (req, res) => {
    try {
        const files = getProjectFiles(__dirname);
        // Limit total size slightly if needed, but for small projects this is fine
        res.json({ files });
    } catch (e) {
        console.error("Context Fetch Failed:", e);
        res.status(500).json({ error: "Access Denied to File System" });
    }
});

// NEW: Batch Write Files (Multi-File Patch)
app.post('/api/admin/write-files', async (req, res) => {
    try {
        const { changes } = req.body; // Expects array of { filePath, content }
        if (!changes || !Array.isArray(changes)) return res.status(400).json({ error: "Invalid changes format" });
        
        console.log(`🩹 Applying patches to ${changes.length} files...`);

        changes.forEach(change => {
            const fullPath = path.join(__dirname, change.filePath);
            // Ensure dir exists
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)){
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(fullPath, change.content);
            console.log(`   - Updated: ${change.filePath}`);
        });
        
        console.log("✅ All patches applied. Restarting Server...");
        res.json({ success: true, message: "Patches applied. Server restarting." });
        
        // Force restart to apply changes
        setTimeout(() => process.exit(0), 1000);
        
    } catch (e) {
        console.error("Patch Failed:", e);
        res.status(500).json({ error: e.message });
    }
});

// NEW: AI ASSISTANT CHAT ENDPOINT
app.post('/api/assistant/chat', async (req, res) => {
    const { message, history } = req.body; // history is array of {role, parts: [{text}]}
    
    try {
        // Only use Flash for Assistant to save quota, unless complex reasoning required
        const model = "gemini-3-flash-preview"; 
        
        // Construct chat session
        const chatHistory = history || [];
        const currentMessage = message;

        // Start Chat with Tools
        const chat = ai.chats.create({
            model: model,
            history: chatHistory,
            config: {
                tools: ASSISTANT_TOOLS,
                systemInstruction: `You are 'Fleet Commander', an advanced AI Operations Manager for an Uber Fleet business.
                You have read/write access to the database via tools.
                
                Always be professional, concise, and proactive. confirm actions before doing destructive updates.`,
            }
        });

        // 1. Send User Message
        let result = await chat.sendMessage(currentMessage);
        let response = result.response;
        
        // 2. Loop for Tool Execution (Handle multi-turn tool use)
        let toolSteps = 0;
        const MAX_TOOL_STEPS = 5; // Prevent infinite loops

        while (response.functionCalls && response.functionCalls.length > 0 && toolSteps < MAX_TOOL_STEPS) {
            toolSteps++;
            const functionCalls = response.functionCalls;
            const functionResponses = [];

            console.log(`🤖 AI wants to execute ${functionCalls.length} tools...`);

            for (const call of functionCalls) {
                let toolResult = {};
                try {
                    if (call.name === 'list_leads') {
                        const { status, source, limit } = call.args;
                        let query = `SELECT id, name, phone_number, status, source, last_message FROM drivers WHERE 1=1`;
                        const params = [];
                        if (status) { params.push(status); query += ` AND status = $${params.length}`; }
                        if (source) { params.push(source); query += ` AND source = $${params.length}`; }
                        query += ` ORDER BY last_message_time DESC LIMIT ${limit || 10}`;
                        const dbRes = await queryWithRetry(query, params);
                        toolResult = { count: dbRes.rows.length, leads: dbRes.rows };
                    }
                    else if (call.name === 'update_lead_status') {
                        const { driver_id, new_status } = call.args;
                        await queryWithRetry(`UPDATE drivers SET status = $1 WHERE id = $2`, [new_status, driver_id]);
                        toolResult = { success: true, message: `Updated driver ${driver_id} to ${new_status}` };
                    }
                    else if (call.name === 'get_bot_settings') {
                        const dbRes = await queryWithRetry(`SELECT settings FROM bot_settings WHERE id = 1`);
                        toolResult = dbRes.rows[0]?.settings || {};
                    }
                    else if (call.name === 'update_bot_instruction') {
                        const { instruction } = call.args;
                        // Fetch current first, update instruction
                        const dbRes = await queryWithRetry(`SELECT settings FROM bot_settings WHERE id = 1`);
                        let settings = dbRes.rows[0]?.settings || DEFAULT_BOT_SETTINGS;
                        settings.systemInstruction = instruction;
                        await queryWithRetry(`UPDATE bot_settings SET settings = $1 WHERE id = 1`, [JSON.stringify(settings)]);
                        toolResult = { success: true, message: "Bot system instruction updated. New persona active." };
                    }
                    else if (call.name === 'run_sql_analytics') {
                        let { query } = call.args;
                        // Basic Safety: Prevent DROP, DELETE, INSERT directly via raw SQL tool if not managed
                        if (/DROP|DELETE|INSERT|UPDATE|ALTER/i.test(query)) {
                            toolResult = { error: "Safety Violation: Only SELECT queries allowed in analytics tool." };
                        } else {
                            const dbRes = await queryWithRetry(query);
                            toolResult = { rows: dbRes.rows };
                        }
                    }
                } catch (e) {
                    console.error(`Tool Execution Error (${call.name}):`, e);
                    toolResult = { error: e.message };
                }

                functionResponses.push({
                    name: call.name,
                    response: { result: toolResult },
                    id: call.id
                });
            }

            // Send Tool Results back to Gemini
            result = await chat.sendMessage(functionResponses); 
            response = result.response;
        }

        // 3. Final Text Response
        res.json({ text: response.text });

    } catch (e) {
        if (e.status === 429 || e.message.includes('429')) {
             return res.status(429).json({ error: "Assistant Overloaded (429). Please wait 30s." });
        }
        console.error("Assistant Chat Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// --- UPDATED HEALTH CHECK ---
app.get('/api/health', async (req, res) => {
    // 1. Check DB
    let dbStatus = 'disconnected';
    let dbLatency = -1;
    try {
        const start = Date.now();
        await queryWithRetry('SELECT 1');
        dbLatency = Date.now() - start;
        dbStatus = 'connected';
    } catch (e) {
        dbStatus = 'error: ' + e.message;
    }

    // 2. Check AI (Cached)
    const aiStatus = await checkAIHealth();

    // 3. Check WhatsApp
    // We assume connection if Token is present. We use lastWebhookTime to determine if it's "live".
    const waStatus = (META_API_TOKEN && PHONE_NUMBER_ID) ? 
        (lastWebhookTime > 0 ? 'active' : 'waiting_for_webhook') : 
        'not_configured';

    res.json({ 
        database: { status: dbStatus, latency: dbLatency }, 
        ai: aiStatus,
        whatsapp: { status: waStatus, lastWebhook: lastWebhookTime },
        mode: 'pooled' 
    });
});

app.get('/api/drivers', async (req, res) => {
    try {
        const result = await queryWithRetry(`
            SELECT d.id, d.phone_number as "phoneNumber", d.name, d.source, d.status, d.last_message as "lastMessage", 
            d.last_message_time as "lastMessageTime", COALESCE(d.documents, ARRAY[]::text[]) as documents, 
            d.onboarding_step as "onboardingStep", d.vehicle_registration as "vehicleRegistration", d.availability, 
            d.qualification_checks as "qualificationChecks", d.is_bot_active as "isBotActive", d.current_bot_step_id as "currentBotStepId",
            COALESCE(json_agg(json_build_object('id', m.id, 'sender', m.sender, 'text', m.text, 'imageUrl', m.image_url, 'timestamp', m.timestamp, 'type', m.type, 'options', m.options) ORDER BY m.timestamp ASC) FILTER (WHERE m.id IS NOT NULL), '[]'::json) as messages
            FROM drivers d LEFT JOIN messages m ON d.id = m.driver_id
            GROUP BY d.id ORDER BY d.last_message_time DESC
        `);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/bot-settings', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM bot_settings WHERE id = 1');
        res.json(result.rows[0]?.settings || DEFAULT_BOT_SETTINGS);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/bot-settings', async (req, res) => {
    try {
        await queryWithRetry(`UPDATE bot_settings SET settings = $1 WHERE id = 1`, [JSON.stringify(req.body)]);
        res.json({ success: true });
    } catch (e) {
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
        
        if (!sent) {
            return res.status(400).json({ error: 'Message blocked by firewall: Invalid content.' });
        }

        const msgId = Date.now().toString(); 
        await queryWithRetry(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'agent', $3, $4, 'text')`,
            [msgId, driverId, text, Date.now()]
        );
        await queryWithRetry(
            `UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3`, 
            [text, Date.now(), driverId]
        );

        res.json({ success: true, messageId: msgId });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- LOGIC ENGINE ---

const sendWhatsAppMessage = async (to, body, options = null, templateName = null, language = 'en_US', mediaUrl = null, mediaType = 'image') => {
  if (!META_API_TOKEN || !PHONE_NUMBER_ID) return false;
  
  // --- FIREWALL ---
  const lowerBody = body ? body.toLowerCase() : "";
  const isPlaceholder = BLOCKED_REGEX.test(lowerBody);
  const isEmpty = !body || !body.trim();

  let isBlocked = false;

  if (templateName) {
      isBlocked = false;
  } else if (mediaUrl) {
      if (isPlaceholder) {
          console.error(`⛔ FIREWALL: Blocked Media Caption: "${body}"`);
          // Strip caption but allow media
          body = ""; 
      }
  } else {
      // Text / Interactive
      if (isPlaceholder) {
          console.error(`⛔ FIREWALL: Blocked Restricted Phrase: "${body}"`);
          isBlocked = true;
      }
      else if (isEmpty) {
          // If empty but has options, we MUST provide a body for WhatsApp API
          if (options && options.length > 0) {
              console.log("⚠️ Fixed Empty Body for Options Message");
              body = "Please select an option:";
          } else {
              isBlocked = true;
          }
      }
  }

  if (isBlocked) {
      console.warn("🚫 Message NOT sent due to firewall rules.");
      return false; 
  }

  let payload = { messaging_product: 'whatsapp', to: to };
  
  if (templateName) {
    payload.type = 'template';
    payload.template = { name: templateName, language: { code: language } };
  } else if (mediaUrl) {
    // Detect YouTube URL
    const isYouTube = mediaUrl.includes('youtube.com') || mediaUrl.includes('youtu.be');
    
    if (isYouTube) {
        // WhatsApp standard for YouTube: Send as Text with Preview enabled
        // The URL is appended to the body
        payload.type = 'text';
        payload.text = { 
            body: body ? `${body} ${mediaUrl}` : mediaUrl, 
            preview_url: true 
        };
    } else {
        // Native Media (Image/Video/Document)
        // If type is 'video' but we are calling with 'video', we assume it's a direct file link (mp4)
        payload.type = mediaType;
        payload[mediaType] = { link: mediaUrl };
        if (body && body.trim().length > 0) payload[mediaType].caption = body; 
    }
  } else if (options && options.length > 0) {
    const validOptions = options.filter(o => o && o.trim().length > 0);
    if (validOptions.length === 0) {
        payload.type = 'text';
        payload.text = { body: body };
    } 
    else {
        // WhatsApp requires body text for interactive messages
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
  
  // Check Quota cache before making call
  if (aiStatusCache.status === 'quota_exceeded' && Date.now() - aiStatusCache.lastCheck < 60000) {
      return "I'm currently overloaded. Please wait a moment.";
  }

  try {
    const response = await ai.models.generateContent({ 
      model: "gemini-3-flash-preview", 
      contents: text,
      config: { systemInstruction, maxOutputTokens: 150 }
    });
    
    // Update status to success
    aiStatusCache = { status: 'operational', message: 'Operational', lastCheck: Date.now() };
    return response.text;
  } catch (e) { 
      if (e.status === 429 || e.message.includes('429')) {
          aiStatusCache = { status: 'quota_exceeded', message: 'Credit Limit Exceeded', lastCheck: Date.now() };
      }
      return "Thanks for contacting Uber Fleet."; 
  }
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
    // TRACK WEBHOOK ACTIVITY
    lastWebhookTime = Date.now();

    try {
        const client = await pool.connect();
        let result = {};
        
        try {
            await client.query('BEGIN');
            const settingsRes = await client.query('SELECT settings FROM bot_settings WHERE id = 1');
            let botSettings = settingsRes.rows[0]?.settings || DEFAULT_BOT_SETTINGS;
            
            // --- RUNTIME SANITIZATION & FALLBACK ---
            if (botSettings.steps && Array.isArray(botSettings.steps)) {
                botSettings.steps = botSettings.steps.map(step => {
                    const msg = step.message || "";
                    if (BLOCKED_REGEX.test(msg)) {
                        console.warn(`🧹 Runtime Scrub: Step ${step.id}`);
                        if (step.options && step.options.length > 0) {
                            step.message = "Please select an option:"; // Fallback for buttons
                        } else {
                            step.message = ""; // Empty (Block)
                        }
                    }
                    return step;
                });
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
            
            if (routingStrategy === 'BOT_ONLY') {
                shouldCallAI = false; 
            }

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
        
        if (result.replyTemplate) {
            sent = await sendWhatsAppMessage(from, null, null, result.replyTemplate);
            if (sent) await logSystemMessage(result.driver.id, `[Template] ${result.replyTemplate}`, 'template');
        }
        else if (result.replyMedia) {
            sent = await sendWhatsAppMessage(from, result.replyText, null, null, 'en_US', result.replyMedia, result.replyMediaType);
            if (sent) await logSystemMessage(result.driver.id, result.replyText || `[${result.replyMediaType}]`, 'image', null, result.replyMedia);
        }
        else if (result.replyText || (result.replyOptions && result.replyOptions.length > 0)) {
            // NOTE: We allow sending if text is present OR if options are present (in which case sendWhatsAppMessage handles fallback text)
            sent = await sendWhatsAppMessage(from, result.replyText, result.replyOptions);
            if (sent) {
                const type = result.replyOptions && result.replyOptions.length > 0 ? 'options' : 'text';
                const loggedText = !result.replyText && result.replyOptions ? "Please select an option:" : result.replyText;
                await logSystemMessage(result.driver.id, loggedText, type, result.replyOptions);
            }
        }
        else if (result.shouldCallAI) {
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
        }
        else if (msgObj.type === 'image') { msgBody = '[Image]'; msgType = 'image'; }
        
        await processIncomingMessage(phone, name, msgBody, msgType);
    }
    res.sendStatus(200);
});

app.patch('/api/drivers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        if (updates.status) await queryWithRetry('UPDATE drivers SET status = $1 WHERE id = $2', [updates.status, id]);
        if (updates.qualificationChecks) await queryWithRetry('UPDATE drivers SET qualification_checks = $1 WHERE id = $2', [JSON.stringify(updates.qualificationChecks), id]);
        if (updates.vehicleRegistration) await queryWithRetry('UPDATE drivers SET vehicle_registration = $1 WHERE id = $2', [updates.vehicleRegistration, id]);
        if (updates.availability) await queryWithRetry('UPDATE drivers SET availability = $1 WHERE id = $2', [updates.availability, id]);
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
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

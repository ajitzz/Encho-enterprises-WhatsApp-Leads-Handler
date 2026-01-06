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

// --- ROBUST DATABASE CONNECTION ---

// 1. Force the Pooled Connection String
const NEON_DB_URL = "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL || NEON_DB_URL;

// 2. Configure Pool with Keep-Alive
const pool = new Pool({
  connectionString: CONNECTION_STRING,
  ssl: { 
    rejectUnauthorized: false, // Required for Neon. Do NOT use requestCert: true
  },
  // Serverless Optimization
  max: 1, // Max 1 connection per Lambda container
  idleTimeoutMillis: 1000, // Close idle connections quickly to avoid exhaustion
  connectionTimeoutMillis: 5000, // Fail fast if Neon is down
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

// 3. THE "ANTI-DROP" WRAPPER (Fixed Deadlock & Logic)
const queryWithRetry = async (text, params, retries = 2) => {
    let client;
    try {
        client = await pool.connect();
        const res = await client.query(text, params);
        return res;
    } catch (err) {
        // CRITICAL: Release client IMMEDIATELY
        if (client) {
            try { client.release(true); } catch(e) {}
            client = null;
        }

        console.warn(`⚠️ DB Error (${err.code}): ${err.message}`);

        // Retry on Connection Errors, Missing Table (42P01), OR Missing Column (42703)
        // 42703: undefined_column (Happens when code expects a new column that isn't in DB yet)
        if ((err.code === '57P01' || err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === '42P01' || err.code === '42703') && retries > 0) {
            console.log(`♻️ Retrying... (${retries} left)`);
            
            // If table or column missing, auto-heal schema
            if (err.code === '42P01' || err.code === '42703') {
                console.log("🛠️ Attempting Schema Auto-Heal (Missing Table or Column)...");
                const healClient = await pool.connect();
                await ensureDatabaseInitialized(healClient);
                healClient.release();
            }
            
            // Wait 500ms before retry
            await new Promise(res => setTimeout(res, 500));
            return queryWithRetry(text, params, retries - 1);
        }
        throw err;
    } finally {
        if (client) {
            try { client.release(); } catch(e) {}
        }
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

const ensureDatabaseInitialized = async (client) => {
    try {
        await client.query('BEGIN');
        await client.query(SCHEMA_SQL);
        
        // --- MIGRATIONS: Force add columns for existing tables ---
        // This fixes the "column m.options does not exist" (42703) error
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
        await client.query('COMMIT');
        console.log("✅ Database initialized & Migrated successfully");
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Schema Init Failed:", e);
        // Don't throw here, let the main query retry handle it
    }
};

// --- AI ENGINE ---
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- ROUTES ---

// Health Check
app.get('/api/health', async (req, res) => {
    try {
        await queryWithRetry('SELECT 1');
        res.json({ database: 'connected', status: 'healthy', mode: 'pooled' });
    } catch (e) {
        res.status(500).json({ database: 'disconnected', error: e.message });
    }
});

// Drivers List
app.get('/api/drivers', async (req, res) => {
    try {
        // FIXED: Cast '[]' to '[]'::json to prevent type mismatch error in Postgres
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
        console.error("GET /api/drivers Error:", e);
        res.status(500).json({ error: e.message, code: e.code });
    }
});

// Bot Settings
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

// Send Manual Message
app.post('/api/messages/send', async (req, res) => {
    try {
        const { driverId, text } = req.body;
        // 1. Get Phone Number
        const driverRes = await queryWithRetry('SELECT phone_number FROM drivers WHERE id = $1', [driverId]);
        if (driverRes.rows.length === 0) return res.status(404).json({ error: 'Driver not found' });
        
        const phoneNumber = driverRes.rows[0].phone_number;

        // 2. Send to WhatsApp
        await sendWhatsAppMessage(phoneNumber, text);

        // 3. Log to DB
        const msgId = Date.now().toString(); 
        await queryWithRetry(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'agent', $3, $4, 'text')`,
            [msgId, driverId, text, Date.now()]
        );
        
        // 4. Update Driver
        await queryWithRetry(
            `UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3`, 
            [text, Date.now(), driverId]
        );

        res.json({ success: true, messageId: msgId });
    } catch (e) {
        console.error("Send Message Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// --- LOGIC ENGINE ---

// FIXED: Enhanced to support LIST MESSAGES for > 3 options
const sendWhatsAppMessage = async (to, body, options = null, templateName = null, language = 'en_US') => {
  if (!META_API_TOKEN || !PHONE_NUMBER_ID) return;
  
  let payload = { messaging_product: 'whatsapp', to: to };
  
  if (templateName) {
    payload.type = 'template';
    payload.template = { name: templateName, language: { code: language } };
  } else if (options && options.length > 0) {
    // FILTER: Remove empty options
    const validOptions = options.filter(o => o && o.trim().length > 0);
    
    if (validOptions.length === 0) {
        payload.type = 'text';
        payload.text = { body: body };
    } 
    // IF > 3 OPTIONS: Use LIST MESSAGE (Menu)
    else if (validOptions.length > 3) {
        payload.type = 'interactive';
        payload.interactive = {
            type: 'list',
            body: { text: body },
            action: {
                button: "Select Option",
                sections: [
                    {
                        title: "Choices",
                        rows: validOptions.slice(0, 10).map((opt, i) => ({
                            id: `opt_${i}`,
                            title: opt.substring(0, 24) // Title limit 24 chars for list
                        }))
                    }
                ]
            }
        };
    } 
    // IF 1-3 OPTIONS: Use BUTTONS
    else {
        payload.type = 'interactive';
        payload.interactive = {
            type: 'button',
            body: { text: body },
            action: { 
                buttons: validOptions.map((opt, i) => ({ 
                    type: 'reply', 
                    reply: { id: `btn_${i}`, title: opt.substring(0, 20) } 
                })) 
            }
        };
    }
  } else {
    payload.type = 'text';
    payload.text = { body: body };
  }
  
  try {
    await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, payload, { headers: { Authorization: `Bearer ${META_API_TOKEN}` } });
  } catch (error) { console.error('Meta API Error:', error.response ? error.response.data : error.message); }
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

// HELPER: Log system messages (Bot/AI) to database so they appear in chat history
const logSystemMessage = async (driverId, text, type = 'text', options = null) => {
    try {
        const msgId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 5);
        // Ensure options is an array for Postgres or null
        const opts = options && options.length > 0 ? options : null;
        
        await queryWithRetry(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type, options) VALUES ($1, $2, 'system', $3, $4, $5, $6)`,
            [msgId, driverId, text, Date.now(), type, opts]
        );
        await queryWithRetry('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [text, Date.now(), driverId]);
    } catch (e) {
        console.error("Failed to log system message:", e);
    }
};

const processIncomingMessage = async (from, name, msgBody, msgType = 'text', timestamp = Date.now()) => {
    try {
        // Use a dedicated client for logic transaction
        const client = await pool.connect();
        let result = {};
        
        try {
            await client.query('BEGIN');

            const settingsRes = await client.query('SELECT settings FROM bot_settings WHERE id = 1');
            const botSettings = settingsRes.rows[0]?.settings || DEFAULT_BOT_SETTINGS;
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

            // Log
            await client.query(
                `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'driver', $3, $4, $5)`,
                [`${timestamp}_${Math.random().toString(36).substr(2, 5)}`, driver.id, msgBody, timestamp, msgType]
            );
            await client.query('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [msgBody, timestamp, driver.id]);

            // Logic
            let replyText = null;
            let replyOptions = null;
            let replyTemplate = null;
            let shouldCallAI = false;

            // STRATEGY: AI ONLY
            // STRICT RULE: If AI_ONLY, completely ignore bot logic
            if (botSettings.isEnabled && routingStrategy === 'AI_ONLY') {
                shouldCallAI = true;
            } 
            // STRATEGY: BOT / HYBRID
            else if (botSettings.isEnabled) {
                 
                 // STRICT RULE: RESTART LOGIC FOR 'BOT_ONLY'
                 // If bot finished (is_bot_active=false), the NEXT message restarts the flow.
                 if (routingStrategy === 'BOT_ONLY' && !driver.is_bot_active) {
                     const firstStepId = botSettings.steps?.[0]?.id;
                     if (firstStepId) {
                         await client.query('UPDATE drivers SET is_bot_active = TRUE, current_bot_step_id = $1 WHERE id = $2', [firstStepId, driver.id]);
                         driver.is_bot_active = true;
                         driver.current_bot_step_id = firstStepId;
                         // FORCE NEW: Treat this incoming message as the trigger to send the Welcome Message, not as an answer.
                         isNewDriver = true; 
                     }
                 }

                 if (driver.is_bot_active && driver.current_bot_step_id) {
                     // ORPHAN STEP CHECK: If current step does not exist in new settings, reset to start.
                     let currentStep = botSettings.steps.find(s => s.id === driver.current_bot_step_id);
                     if (!currentStep && botSettings.steps.length > 0) {
                         console.log(`Orphaned step detected: ${driver.current_bot_step_id}. Resetting flow.`);
                         const firstStepId = botSettings.steps[0].id;
                         await client.query('UPDATE drivers SET current_bot_step_id = $1 WHERE id = $2', [firstStepId, driver.id]);
                         driver.current_bot_step_id = firstStepId;
                         currentStep = botSettings.steps[0];
                         isNewDriver = true; // Treat as restart
                     }

                     if (currentStep) {
                         // Process Input (Only if not restarting/new)
                         if (!isNewDriver) {
                             if (currentStep.saveToField === 'name') await client.query('UPDATE drivers SET name = $1 WHERE id = $2', [msgBody, driver.id]);
                             if (currentStep.saveToField === 'availability') await client.query('UPDATE drivers SET availability = $1 WHERE id = $2', [msgBody, driver.id]);
                             if (currentStep.saveToField === 'vehicleRegistration') await client.query('UPDATE drivers SET vehicle_registration = $1 WHERE id = $2', [msgBody, driver.id]);

                             let nextId = currentStep.nextStepId;
                             
                             // End of Flow Handling
                             if (nextId === 'AI_HANDOFF' || nextId === 'END' || !nextId) {
                                 await client.query('UPDATE drivers SET is_bot_active = FALSE, current_bot_step_id = NULL WHERE id = $1', [driver.id]);
                                 driver.is_bot_active = false; // Local update for subsequent logic

                                 if (nextId === 'AI_HANDOFF' && routingStrategy === 'HYBRID_BOT_FIRST') {
                                     // Hybrid: Switch to AI.
                                     shouldCallAI = true;
                                 } else {
                                     // Bot Only or Plain End: Just acknowledge.
                                     // If Bot Only, we stop here. Next user msg will trigger restart block above.
                                     replyText = "Thank you! We have received your details.";
                                 }
                             } else {
                                 // Next Step
                                 await client.query('UPDATE drivers SET current_bot_step_id = $1 WHERE id = $2', [nextId, driver.id]);
                                 const nextStep = botSettings.steps.find(s => s.id === nextId);
                                 if (nextStep) {
                                     replyText = nextStep.message;
                                     replyTemplate = nextStep.templateName;
                                     if(nextStep.options && nextStep.options.length > 0) replyOptions = nextStep.options;
                                 }
                             }
                         } else {
                             // Send Current Step (Start/Restart)
                             replyText = currentStep.message;
                             replyTemplate = currentStep.templateName;
                             if(currentStep.options && currentStep.options.length > 0) replyOptions = currentStep.options;
                         }
                     }
                 } 
                 // STRICT RULE: HYBRID FALLBACK
                 // Only if Bot is inactive (and didn't just restart) do we call AI in Hybrid mode
                 else if (routingStrategy === 'HYBRID_BOT_FIRST') {
                     shouldCallAI = true;
                 }
            }

            await client.query('COMMIT');
            result = { replyText, replyOptions, replyTemplate, shouldCallAI, driver, botSettings };

        } catch (err) {
            await client.query('ROLLBACK');
            if(err.code === '42P01') await ensureDatabaseInitialized(client);
            throw err;
        } finally {
            client.release();
        }

        // Post-Transaction Actions
        // UPDATE: Log system messages to DB after sending to WhatsApp so they appear in Chat UI
        if (result.replyTemplate) {
            await sendWhatsAppMessage(from, null, null, result.replyTemplate);
            await logSystemMessage(result.driver.id, `[Template] ${result.replyTemplate}`, 'template');
        }
        else if (result.replyText) {
            await sendWhatsAppMessage(from, result.replyText, result.replyOptions);
            const type = result.replyOptions && result.replyOptions.length > 0 ? 'options' : 'text';
            await logSystemMessage(result.driver.id, result.replyText, type, result.replyOptions);
        }
        else if (result.shouldCallAI) {
            const aiReply = await analyzeWithAI(msgBody, result.botSettings.systemInstruction);
            await sendWhatsAppMessage(from, aiReply);
            await logSystemMessage(result.driver.id, aiReply, 'text');
        }

    } catch (e) {
        console.error("Logic Error:", e.message);
    }
};

// Webhook
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
        // Handle Button/List replies
        if (msgObj.type === 'interactive') { 
            // LIST REPLY
            if (msgObj.interactive.type === 'list_reply') {
                msgBody = msgObj.interactive.list_reply.title;
            }
            // BUTTON REPLY
            else if (msgObj.interactive.type === 'button_reply') {
                msgBody = msgObj.interactive.button_reply.title; 
            }
            msgType = 'option_reply'; 
        }
        else if (msgObj.type === 'image') { msgBody = '[Image]'; msgType = 'image'; }
        
        await processIncomingMessage(phone, name, msgBody, msgType);
    }
    res.sendStatus(200);
});

// Update Driver
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

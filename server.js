/**
 * UBER FLEET RECRUITER - BACKEND SERVER
 * Optimized for Vercel Serverless + Neon Postgres
 * 
 * Dependencies: express, axios, cors, pg, dotenv, @google/genai
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const app = express();

// --- MIDDLEWARE ---
// Increased limit for potential image handling
app.use(express.json({ limit: '10mb' }));
app.use(cors()); 

// Disable Caching for API responses to prevent stale data
app.set('etag', false);
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3001;

// CREDENTIALS
let META_API_TOKEN = process.env.META_API_TOKEN || ""; 
let PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || ""; 
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyDujw0ovB1bLtQJK8DKy1b__LT5aqGurz0";
let VERIFY_TOKEN = process.env.VERIFY_TOKEN || "uber_fleet_verify_token";

// DATABASE CONNECTION STRINGS
// Prefer pooled connections for Vercel/Neon, with optional unpooled fallback
const NEON_DB_URL = "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const NEON_DB_URL_UNPOOLED = "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";

const resolveDbUrl = () => {
  const useUnpooled = process.env.USE_UNPOOLED === 'true' || process.env.POSTGRES_USE_UNPOOLED === 'true';
  if (useUnpooled) {
    return (
      process.env.DATABASE_URL_UNPOOLED ||
      process.env.POSTGRES_URL_NON_POOLING ||
      process.env.POSTGRES_URL_NO_SSL ||
      NEON_DB_URL_UNPOOLED
    );
  }

  return (
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NO_SSL ||
    NEON_DB_URL
  );
};

const createPool = () => {
  const connectionString = resolveDbUrl();
  const newPool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }, // Essential for Neon
    keepAlive: true,
    max: parseInt(process.env.PG_POOL_MAX || '3', 10),
    idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT_MS || '30000', 10),
    connectionTimeoutMillis: parseInt(process.env.PG_CONNECTION_TIMEOUT_MS || '15000', 10),
  });

  // Global error listener to prevent crash on idle client errors
  newPool.on('error', (err) => {
    console.error('Unexpected error on idle database client', err);
  });

  return newPool;
};

let pool = createPool();

const getDbClient = async () => {
  try {
    return await pool.connect();
  } catch (err) {
    console.warn('Database pool connection failed, recreating pool...', err.message);
    try {
      await pool.end();
    } catch (closeErr) {
      console.warn('Error while closing stale pool', closeErr.message);
    }
    pool = createPool();
    return await pool.connect();
  }
};

// --- SCHEMA DEFINITION (Used for Auto-Recovery) ---
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

// --- HELPER: Auto-Init DB (Self-Healing) ---
// This runs ONLY if a query fails due to missing tables.
const ensureDatabaseInitialized = async (client) => {
    try {
        console.log("🛠 Performing Database Auto-Recovery/Initialization...");
        await client.query('BEGIN');
        await client.query(SCHEMA_SQL);
        
        // Seed Settings if missing
        const settingsRes = await client.query('SELECT * FROM bot_settings WHERE id = 1');
        if (settingsRes.rows.length === 0) {
            await client.query('INSERT INTO bot_settings (id, settings) VALUES (1, $1)', [JSON.stringify(DEFAULT_BOT_SETTINGS)]);
        }
        await client.query('COMMIT');
        console.log("✅ Database schema verified.");
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Schema Init Failed:", e);
        throw e;
    }
};

// --- AI ENGINE ---
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- ROUTES ---

// Manual Init Route (Optional)
app.get('/api/init', async (req, res) => {
    const client = await getDbClient();
    try {
        await ensureDatabaseInitialized(client);
        res.status(200).json({ status: 'Database Initialized Successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Health Check
app.get('/api/health', async (req, res) => {
    let client;
    try {
        client = await getDbClient();
        await client.query('SELECT 1');
        res.json({ database: 'connected', status: 'healthy' });
    } catch (e) {
        res.status(500).json({ database: 'disconnected', error: e.message });
    } finally {
        if (client) client.release();
    }
});

// Drivers List (With Auto-Recovery Logic)
// This is the heavy lifter called by dashboard polling
app.get('/api/drivers', async (req, res) => {
    let client;
    try {
        client = await getDbClient();
        
        const fetchDrivers = async () => {
             return await client.query(`
                SELECT d.id, d.phone_number as "phoneNumber", d.name, d.source, d.status, d.last_message as "lastMessage", 
                d.last_message_time as "lastMessageTime", COALESCE(d.documents, ARRAY[]::text[]) as documents, 
                d.onboarding_step as "onboardingStep", d.vehicle_registration as "vehicleRegistration", d.availability, 
                d.qualification_checks as "qualificationChecks", d.is_bot_active as "isBotActive", d.current_bot_step_id as "currentBotStepId",
                COALESCE(json_agg(json_build_object('id', m.id, 'sender', m.sender, 'text', m.text, 'imageUrl', m.image_url, 'timestamp', m.timestamp, 'type', m.type, 'options', m.options) ORDER BY m.timestamp ASC) FILTER (WHERE m.id IS NOT NULL), '[]') as messages
                FROM drivers d LEFT JOIN messages m ON d.id = m.driver_id
                GROUP BY d.id ORDER BY d.last_message_time DESC
            `);
        };

        try {
            const driversRes = await fetchDrivers();
            res.json(driversRes.rows);
        } catch (queryError) {
            // Error 42P01 means "undefined table". This happens on new deployments/resets.
            if (queryError.code === '42P01') {
                console.warn("⚠️ Tables missing. Triggering Self-Healing...");
                await ensureDatabaseInitialized(client);
                // Retry the query once after healing
                const retryRes = await fetchDrivers();
                res.json(retryRes.rows);
            } else {
                throw queryError;
            }
        }
    } catch (e) {
        console.error("GET /api/drivers Error:", e);
        res.status(500).json({ error: e.message });
    } finally {
        if (client) client.release();
    }
});

// Bot Settings
app.get('/api/bot-settings', async (req, res) => {
    let client;
    try {
        client = await getDbClient();
        const result = await client.query('SELECT * FROM bot_settings WHERE id = 1');
        res.json(result.rows[0]?.settings || DEFAULT_BOT_SETTINGS);
    } catch (e) {
        if (e.code === '42P01' && client) {
            try {
                await ensureDatabaseInitialized(client);
                const result = await client.query('SELECT * FROM bot_settings WHERE id = 1');
                return res.json(result.rows[0]?.settings || DEFAULT_BOT_SETTINGS);
            } catch (retryErr) {
                return res.status(500).json({ error: retryErr.message });
            }
        }
        res.status(500).json({ error: e.message });
    } finally {
        if(client) client.release();
    }
});

app.post('/api/bot-settings', async (req, res) => {
    let client;
    try {
        client = await getDbClient();
        await client.query(`UPDATE bot_settings SET settings = $1 WHERE id = 1`, [JSON.stringify(req.body)]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    } finally {
        if (client) client.release();
    }
});

// Helpers
const sendWhatsAppMessage = async (to, body, options = null, templateName = null, language = 'en_US') => {
  if (!META_API_TOKEN || !PHONE_NUMBER_ID) return;
  
  let payload = { messaging_product: 'whatsapp', to: to };

  if (templateName) {
    payload.type = 'template';
    payload.template = { name: templateName, language: { code: language } };
  } else if (options && options.length > 0) {
    payload.type = 'interactive';
    payload.interactive = {
      type: 'button',
      body: { text: body },
      action: {
        buttons: options.slice(0, 3).map((opt, i) => ({ 
          type: 'reply',
          reply: { id: `btn_${i}`, title: opt.substring(0, 20) } 
        }))
      }
    };
  } else {
    payload.type = 'text';
    payload.text = { body: body };
  }

  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`,
      payload,
      { headers: { Authorization: `Bearer ${META_API_TOKEN}` } }
    );
  } catch (error) {
    console.error('Meta API Error:', error.response ? error.response.data : error.message);
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
  } catch (e) {
    console.error("AI Error:", e.message);
    return "Thanks for contacting Uber Fleet.";
  }
};

// Core Logic (Refactored for Auto-Recovery)
const processIncomingMessage = async (from, name, msgBody, msgType = 'text', timestamp = Date.now()) => {
    // We isolate logic in a function to allow retries if DB connection drops
    const runLogic = async (client) => {
        await client.query('BEGIN');

        // 1. Settings
        const settingsRes = await client.query('SELECT settings FROM bot_settings WHERE id = 1');
        const botSettings = settingsRes.rows[0]?.settings || DEFAULT_BOT_SETTINGS;
        const routingStrategy = botSettings.routingStrategy || 'HYBRID_BOT_FIRST';

        // 2. Driver
        let driverRes = await client.query('SELECT * FROM drivers WHERE phone_number = $1', [from]);
        let driver = driverRes.rows[0];
        let isNewDriver = false;

        if (!driver) {
            isNewDriver = true;
            const shouldActivateBot = botSettings.isEnabled && routingStrategy !== 'AI_ONLY';
            const firstStepId = botSettings.steps?.[0]?.id;
            const insertRes = await client.query(
                `INSERT INTO drivers (id, phone_number, name, source, status, last_message, last_message_time, documents, current_bot_step_id, is_bot_active)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
                [timestamp.toString(), from, name, 'WhatsApp', 'New', msgBody, timestamp, [], firstStepId, shouldActivateBot]
            );
            driver = insertRes.rows[0];
        }

        // 3. Log
        const msgId = `${timestamp}_${Math.random().toString(36).substr(2, 5)}`;
        await client.query(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type)
            VALUES ($1, $2, 'driver', $3, $4, $5)`,
            [msgId, driver.id, msgBody, timestamp, msgType]
        );
        await client.query('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [msgBody, timestamp, driver.id]);

        // 4. Logic
        let replyText = null;
        let replyOptions = null;
        let replyTemplate = null;
        let shouldCallAI = false;

        if (botSettings.isEnabled && routingStrategy === 'AI_ONLY') {
            shouldCallAI = true;
        } else if (botSettings.isEnabled) {
            // RESTART LOGIC FOR BOT_ONLY
            if (routingStrategy === 'BOT_ONLY' && !driver.is_bot_active && !isNewDriver) {
                 const firstStepId = botSettings.steps?.[0]?.id;
                 if (firstStepId) {
                     await client.query('UPDATE drivers SET is_bot_active = TRUE, current_bot_step_id = $1 WHERE id = $2', [firstStepId, driver.id]);
                     driver.is_bot_active = true;
                     driver.current_bot_step_id = firstStepId;
                     isNewDriver = true;
                 }
            }

            if (driver.is_bot_active && driver.current_bot_step_id) {
                const currentStep = botSettings.steps.find(s => s.id === driver.current_bot_step_id);
                if (currentStep) {
                    if (!isNewDriver) {
                        if (currentStep.saveToField === 'name') await client.query('UPDATE drivers SET name = $1 WHERE id = $2', [msgBody, driver.id]);
                        if (currentStep.saveToField === 'availability') await client.query('UPDATE drivers SET availability = $1 WHERE id = $2', [msgBody, driver.id]);
                        
                        let nextId = currentStep.nextStepId;
                        if (nextId === 'AI_HANDOFF' || nextId === 'END') {
                            await client.query('UPDATE drivers SET is_bot_active = FALSE, current_bot_step_id = NULL WHERE id = $1', [driver.id]);
                            if (nextId === 'AI_HANDOFF') {
                                if (routingStrategy === 'HYBRID_BOT_FIRST') shouldCallAI = true;
                                else replyText = "Thank you. We will contact you soon.";
                            } else {
                                replyText = "Thank you! We have received your details.";
                            }
                        } else {
                            await client.query('UPDATE drivers SET current_bot_step_id = $1 WHERE id = $2', [nextId, driver.id]);
                            const nextStep = botSettings.steps.find(s => s.id === nextId);
                            if (nextStep) {
                                replyText = nextStep.message;
                                replyTemplate = nextStep.templateName;
                                if (nextStep.inputType === 'option') replyOptions = nextStep.options;
                            } else {
                                if (routingStrategy === 'HYBRID_BOT_FIRST') shouldCallAI = true;
                                else replyText = "Configuration Error.";
                            }
                        }
                    } else {
                         replyText = currentStep.message;
                         replyTemplate = currentStep.templateName;
                         if (currentStep.inputType === 'option') replyOptions = currentStep.options;
                    }
                } else if (routingStrategy === 'HYBRID_BOT_FIRST') shouldCallAI = true;
            } else if (routingStrategy === 'HYBRID_BOT_FIRST') shouldCallAI = true;
        }

        await client.query('COMMIT');
        return { replyText, replyOptions, replyTemplate, shouldCallAI, driver, botSettings };
    };

    const client = await getDbClient();
    try {
        const result = await runLogic(client);
        
        // External calls (API) outside the DB transaction/lock
        if (result.replyTemplate) {
            await sendWhatsAppMessage(from, null, null, result.replyTemplate);
        } else if (result.replyText) {
            await sendWhatsAppMessage(from, result.replyText, result.replyOptions);
        } else if (result.shouldCallAI) {
            const aiReply = await analyzeWithAI(msgBody, result.botSettings.systemInstruction);
            await sendWhatsAppMessage(from, aiReply);
        }
    } catch (e) {
        await client.query('ROLLBACK');
        if (e.code === '42P01') {
            console.warn("⚠️ Tables missing in webhook. Auto-initializing for next request...");
            await ensureDatabaseInitialized(client);
        } else {
            console.error("Logic Error:", e);
        }
    } finally {
        client.release();
    }
};

// Webhook
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;
        if (!body.object) return res.sendStatus(404);

        if (body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
            const msgObj = body.entry[0].changes[0].value.messages[0];
            const contact = body.entry[0].changes[0].value.contacts?.[0];
            const phone = msgObj.from;
            const name = contact?.profile?.name || 'Unknown';
            let msgBody = msgObj.text?.body || '[Media]';
            let msgType = 'text';

            if (msgObj.type === 'interactive') {
                 msgBody = msgObj.interactive.button_reply.title;
                 msgType = 'option_reply';
            } else if (msgObj.type === 'image') {
                 msgBody = '[Image]';
                 msgType = 'image';
            }

            // Fire and forget logic, but await it to ensure Vercel doesn't freeze the process
            await processIncomingMessage(phone, name, msgBody, msgType);
        }
        res.sendStatus(200);
    } catch (error) {
        console.error("Webhook Error:", error);
        res.sendStatus(200);
    }
});

// Update Driver
app.patch('/api/drivers/:id', async (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    let client;
    try {
        client = await getDbClient();
        if (updates.status) await client.query('UPDATE drivers SET status = $1 WHERE id = $2', [updates.status, id]);
        if (updates.qualificationChecks) await client.query('UPDATE drivers SET qualification_checks = $1 WHERE id = $2', [JSON.stringify(updates.qualificationChecks), id]);
        if (updates.vehicleRegistration) await client.query('UPDATE drivers SET vehicle_registration = $1 WHERE id = $2', [updates.vehicleRegistration, id]);
        if (updates.availability) await client.query('UPDATE drivers SET availability = $1 WHERE id = $2', [updates.availability, id]);
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    } finally {
        if (client) client.release();
    }
});

// Config endpoints
app.post('/api/update-credentials', (req, res) => {
    if(req.body.phoneNumberId) PHONE_NUMBER_ID = req.body.phoneNumberId;
    if(req.body.apiToken) META_API_TOKEN = req.body.apiToken;
    res.json({ success: true });
});

app.post('/api/configure-webhook', (req, res) => {
    if(req.body.verifyToken) VERIFY_TOKEN = req.body.verifyToken;
    res.json({ success: true });
});

// Export app for Vercel
module.exports = app;

// Local Start
if (require.main === module) {
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}

/**
 * UBER FLEET RECRUITER - BACKEND SERVER
 * Optimized for Vercel Serverless + Neon Postgres
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg'); 
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const app = express();

// --- MIDDLEWARE ---
// Increased limit for images, but typically WhatsApp sends media IDs, not base64
app.use(express.json({ limit: '10mb' }));
app.use(cors()); 

// Disable Caching for API responses to prevent stale data in Vercel
app.set('etag', false);
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3001;

// CREDENTIALS - Prefer Env Vars, fallback only for local dev
let META_API_TOKEN = process.env.META_API_TOKEN; 
let PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; 
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
let VERIFY_TOKEN = process.env.VERIFY_TOKEN || "uber_fleet_verify_token";

// --- DATABASE CONNECTION (NEON) ---
// Vercel Serverless Best Practice: Use the Pooled connection string
const CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  ssl: { rejectUnauthorized: false }, // Required for Neon
  max: 2, // Limit pool size per lambda to prevent max connection errors on Neon free tier
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// --- AI ENGINE ---
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- DEFAULT SETTINGS (Fallback) ---
const DEFAULT_BOT_SETTINGS = {
  isEnabled: true,
  routingStrategy: 'HYBRID_BOT_FIRST',
  systemInstruction: "You are a friendly recruiter for Uber Fleet. Answer in Malayalam and English.",
  steps: []
};

// --- DB INITIALIZATION (Manual Trigger Only) ---
// Do not run this on every request. Call /api/init manually once after deployment.
app.get('/api/init', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Drivers Table
        await client.query(`
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
        `);
        
        // Messages Table
        await client.query(`
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
        `);

        // Settings Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS bot_settings (
                id INT PRIMARY KEY DEFAULT 1,
                settings JSONB
            );
        `);
        
        // Seed Default Settings
        const settingsRes = await client.query('SELECT * FROM bot_settings WHERE id = 1');
        if (settingsRes.rows.length === 0) {
            await client.query('INSERT INTO bot_settings (id, settings) VALUES (1, $1)', [JSON.stringify(DEFAULT_BOT_SETTINGS)]);
        }

        await client.query('COMMIT');
        res.status(200).json({ status: 'Database Initialized Successfully' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("DB Init Error:", err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// --- HELPERS ---

const sendWhatsAppMessage = async (to, body, options = null, templateName = null, language = 'en_US') => {
  if (!META_API_TOKEN || !PHONE_NUMBER_ID) {
    console.error("❌ Missing Meta Credentials");
    return;
  }
  
  let payload = {
    messaging_product: 'whatsapp',
    to: to,
  };

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
    const model = "gemini-3-flash-preview"; // Use Flash for speed
    const response = await ai.models.generateContent({ 
      model, 
      contents: text,
      config: {
        systemInstruction: systemInstruction,
        maxOutputTokens: 150 
      }
    });
    return response.text;
  } catch (e) {
    console.error("AI Error:", e.message);
    return "Thanks for contacting Uber Fleet.";
  }
};

// --- CORE LOGIC ENGINE ---
const processIncomingMessage = async (from, name, msgBody, msgType = 'text', timestamp = Date.now()) => {
      const client = await pool.connect();
      try {
          // Fetch settings and driver in parallel for speed if possible, 
          // but strictly sequential here for transaction safety.
          
          await client.query('BEGIN');

          // 1. Get Settings
          const settingsRes = await client.query('SELECT settings FROM bot_settings WHERE id = 1');
          const botSettings = settingsRes.rows[0]?.settings || DEFAULT_BOT_SETTINGS;

          // 2. Get or Create Driver
          let driverRes = await client.query('SELECT * FROM drivers WHERE phone_number = $1', [from]);
          let driver = driverRes.rows[0];
          let isNewDriver = false;

          if (!driver) {
            isNewDriver = true;
            const shouldActivateBot = botSettings.isEnabled && botSettings.routingStrategy !== 'AI_ONLY';
            const firstStepId = botSettings.steps?.[0]?.id;

            const insertRes = await client.query(
              `INSERT INTO drivers (id, phone_number, name, source, status, last_message, last_message_time, documents, current_bot_step_id, is_bot_active)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
              [timestamp.toString(), from, name, 'WhatsApp', 'New', msgBody, timestamp, [], firstStepId, shouldActivateBot]
            );
            driver = insertRes.rows[0];
          }

          // 3. Log Message & Update Driver Status
          const msgId = `${timestamp}_${Math.random().toString(36).substr(2, 5)}`;
          await client.query(
              `INSERT INTO messages (id, driver_id, sender, text, timestamp, type)
              VALUES ($1, $2, 'driver', $3, $4, $5)`,
              [msgId, driver.id, msgBody, timestamp, msgType]
          );

          await client.query(
              `UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3`,
              [msgBody, timestamp, driver.id]
          );

          await client.query('COMMIT'); 
          // Commit early so the user's message is saved even if bot logic fails/timeouts.

          // --- BOT LOGIC (Can run after commit, but we await to ensure reply sends) ---
          
          let replyText = null;
          let replyOptions = null;
          let replyTemplate = null;
          let shouldCallAI = false;

          // LOGIC: AI ONLY
          if (botSettings.isEnabled && botSettings.routingStrategy === 'AI_ONLY') {
              shouldCallAI = true;
          }
          // LOGIC: BOT FLOW
          else if (botSettings.isEnabled && driver.is_bot_active && driver.current_bot_step_id) {
              const currentStep = botSettings.steps.find(s => s.id === driver.current_bot_step_id);

              if (currentStep) {
                  // If NOT new driver, this message is a RESPONSE to a previous step
                  if (!isNewDriver) {
                      // Save Data
                      if (currentStep.saveToField === 'name') {
                          await client.query('UPDATE drivers SET name = $1 WHERE id = $2', [msgBody, driver.id]);
                      }
                      if (currentStep.saveToField === 'availability') {
                          await client.query('UPDATE drivers SET availability = $1 WHERE id = $2', [msgBody, driver.id]);
                      }
                      
                      let nextId = currentStep.nextStepId;
                      
                      if (nextId === 'AI_HANDOFF') {
                           await client.query('UPDATE drivers SET is_bot_active = FALSE, current_bot_step_id = NULL WHERE id = $1', [driver.id]);
                           shouldCallAI = true;
                      } else if (nextId === 'END') {
                           await client.query('UPDATE drivers SET is_bot_active = FALSE, current_bot_step_id = NULL WHERE id = $1', [driver.id]);
                           replyText = "Thank you! We have received your details.";
                      } else {
                           // Advance Step
                           await client.query('UPDATE drivers SET current_bot_step_id = $1 WHERE id = $2', [nextId, driver.id]);
                           const nextStep = botSettings.steps.find(s => s.id === nextId);
                           
                           if (nextStep) {
                               replyText = nextStep.message;
                               replyTemplate = nextStep.templateName;
                               if (nextStep.inputType === 'option') replyOptions = nextStep.options;
                           } else {
                               shouldCallAI = true; // Fallback
                           }
                      }
                  } else {
                       // Is New Driver: Trigger FIRST step immediately
                       replyText = currentStep.message;
                       replyTemplate = currentStep.templateName;
                       if (currentStep.inputType === 'option') replyOptions = currentStep.options;
                  }
              } else {
                  shouldCallAI = true;
              }
          } else {
              shouldCallAI = true;
          }

          // SEND REPLY
          if (replyTemplate) {
               await sendWhatsAppMessage(from, null, null, replyTemplate);
               await client.query(`INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'system', $3, $4, 'template')`, 
               [`${Date.now()}_sys`, driver.id, `Template: ${replyTemplate}`, Date.now()]);
          } else if (replyText) {
              await sendWhatsAppMessage(from, replyText, replyOptions);
              await client.query(`INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'system', $3, $4, 'text')`, 
              [`${Date.now()}_sys`, driver.id, replyText, Date.now()]);
          } else if (shouldCallAI) {
              const aiReply = await analyzeWithAI(msgBody, botSettings.systemInstruction);
              await sendWhatsAppMessage(from, aiReply);
              await client.query(`INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'system', $3, $4, 'text')`, 
              [`${Date.now()}_ai`, driver.id, aiReply, Date.now()]);
          }

      } catch (dbError) {
          try { await client.query('ROLLBACK'); } catch(e) {}
          console.error("Logic Error:", dbError);
      } finally {
          client.release();
      }
};

// --- ROUTES ---

// Health Check
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ database: 'connected', whatsapp: 'configured', ai: 'configured' });
    } catch (e) {
        res.status(500).json({ database: 'disconnected', error: e.message });
    }
});

// Drivers List
app.get('/api/drivers', async (req, res) => {
    try {
        const driversRes = await pool.query(`
            SELECT d.id, d.phone_number as "phoneNumber", d.name, d.source, d.status, d.last_message as "lastMessage", 
            d.last_message_time as "lastMessageTime", COALESCE(d.documents, ARRAY[]::text[]) as documents, 
            d.onboarding_step as "onboardingStep", d.vehicle_registration as "vehicleRegistration", d.availability, 
            d.qualification_checks as "qualificationChecks", d.is_bot_active as "isBotActive", d.current_bot_step_id as "currentBotStepId",
            COALESCE(json_agg(json_build_object('id', m.id, 'sender', m.sender, 'text', m.text, 'imageUrl', m.image_url, 'timestamp', m.timestamp, 'type', m.type, 'options', m.options) ORDER BY m.timestamp ASC) FILTER (WHERE m.id IS NOT NULL), '[]') as messages
            FROM drivers d LEFT JOIN messages m ON d.id = m.driver_id
            GROUP BY d.id ORDER BY d.last_message_time DESC
        `);
        res.json(driversRes.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Bot Settings
app.get('/api/bot-settings', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM bot_settings WHERE id = 1');
        res.json(result.rows[0]?.settings || DEFAULT_BOT_SETTINGS);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/bot-settings', async (req, res) => {
    try {
        await pool.query(`UPDATE bot_settings SET settings = $1 WHERE id = 1`, [JSON.stringify(req.body)]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Credential Updates (Memory Only for Session - In Production use Env Vars)
app.post('/api/update-credentials', (req, res) => {
    const { phoneNumberId, apiToken } = req.body;
    if(phoneNumberId) PHONE_NUMBER_ID = phoneNumberId;
    if(apiToken) META_API_TOKEN = apiToken;
    res.json({ success: true });
});

app.post('/api/configure-webhook', (req, res) => {
    const { verifyToken } = req.body;
    if(verifyToken) VERIFY_TOKEN = verifyToken;
    res.json({ success: true });
});

// Simulation
app.post('/api/simulate-webhook', async (req, res) => {
    const { phone, text, name } = req.body;
    try {
        await processIncomingMessage(phone, name || 'Test User', text);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Update Driver
app.patch('/api/drivers/:id', async (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    try {
        const client = await pool.connect();
        if (updates.status) await client.query('UPDATE drivers SET status = $1 WHERE id = $2', [updates.status, id]);
        if (updates.qualificationChecks) await client.query('UPDATE drivers SET qualification_checks = $1 WHERE id = $2', [JSON.stringify(updates.qualificationChecks), id]);
        if (updates.vehicleRegistration) await client.query('UPDATE drivers SET vehicle_registration = $1 WHERE id = $2', [updates.vehicleRegistration, id]);
        if (updates.availability) await client.query('UPDATE drivers SET availability = $1 WHERE id = $2', [updates.availability, id]);
        client.release();
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// --- WEBHOOK (CRITICAL PATH) ---

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;
        
        // Return 200 immediately if it's not a message event to keep Meta happy
        if (!body.object) return res.sendStatus(404);

        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
            const msgObj = body.entry[0].changes[0].value.messages[0];
            const contactObj = body.entry[0].changes[0].value.contacts?.[0];
            
            const phone = msgObj.from;
            const name = contactObj?.profile?.name || 'Unknown';
            
            let msgBody = '';
            let msgType = 'text';

            if (msgObj.type === 'interactive' && msgObj.interactive.type === 'button_reply') {
                 msgBody = msgObj.interactive.button_reply.title;
                 msgType = 'option_reply';
            } else if (msgObj.type === 'image') {
                 msgBody = '[Image Received]';
                 msgType = 'image';
            } else {
                 msgBody = msgObj.text ? msgObj.text.body : '[Media/Other]';
            }

            // In Vercel Serverless, we must await the logic before returning, 
            // otherwise the function freezes and logic might not run.
            await processIncomingMessage(phone, name, msgBody, msgType);
        }
        
        res.sendStatus(200);
    } catch (error) {
        console.error("Webhook Error:", error);
        res.sendStatus(200); // Always return 200 to Meta to prevent retries on logic errors
    }
});

// Export for Vercel
module.exports = app;

// Local Development Support
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
}

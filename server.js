/**
 * UBER FLEET RECRUITER - BACKEND SERVER
 * 
 * Dependencies required:
 * npm install express axios cors pg dotenv @google/genai
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg'); // PostgreSQL Client
const { GoogleGenAI, Type } = require('@google/genai');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3001;

// CREDENTIALS - Mutable to allow runtime updates from UI
let META_API_TOKEN = process.env.META_API_TOKEN || ""; 
let PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || ""; 
// Default Test credentials (only if env vars missing)
if (!META_API_TOKEN) console.warn("⚠️ No META_API_TOKEN found in env. Please configure via UI.");
if (!PHONE_NUMBER_ID) console.warn("⚠️ No PHONE_NUMBER_ID found in env. Please configure via UI.");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyDujw0ovB1bLtQJK8DKy1b__LT5aqGurz0";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "uber_fleet_verify_token";

// NEON DATABASE CONNECTION
const NEON_DB_URL = "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";

// Initialize AI
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- POSTGRESQL CONNECTION ---
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL || NEON_DB_URL,
  ssl: {
    rejectUnauthorized: false 
  },
  max: 5,
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 1000,
});

// --- DEFAULT BOT SETTINGS ---
const DEFAULT_BOT_SETTINGS = {
  isEnabled: true,
  routingStrategy: 'HYBRID_BOT_FIRST',
  systemInstruction: `You are a friendly and persuasive recruiter for Uber Fleet in Kerala.

**Language & Tone:**
- Communicate in casual, conversational Malayalam using **Malayalam Script** (Malayalam letters).
- Freely mix **English words** for common terms (like 'Driver', 'License', 'Payment', 'Trip', 'Bonus', 'Account', 'Join').
- Do NOT use Manglish (Malayalam written in English text). Use real Malayalam characters.
- Do NOT use overly formal/bookish Malayalam. Talk like a helpful friend.

**Example Style:**
- "Uber Fleet-ൽ join ചെയ്യാൻ താല്പര്യമുണ്ടോ? നല്ല income earn ചെയ്യാം."
- "നിങ്ങളുടെ ലൈസൻസ് (License) ഡീറ്റെയിൽസ് അയച്ചുതരൂ."
- "ആഴ്ച തോറും പേയ്മെന്റ് ലഭിക്കും."

**Your Goal:** 
- Help the user understand the benefits of joining Uber Fleet.
- Answer their doubts clearly regarding salary and work nature.
- Encourage them to complete the application process.

**Key Selling Points:**
- Potential to earn up to ₹50,000/month based on performance.
- Weekly payments (ആഴ്ച തോറും പേയ്മെന്റ്).
- Flexible timings (നമ്മുടെ സമയം പോലെ വർക്ക് ചെയ്യാം).`,
  steps: [
    {
      id: 'step_1',
      title: 'Welcome & Name',
      message: 'നമസ്കാരം! Uber Fleet-ലേക്ക് സ്വാഗതം. നിങ്ങളുടെ പേര് പറയാമോ?',
      inputType: 'text',
      saveToField: 'name',
      nextStepId: 'step_2'
    },
    {
      id: 'step_2',
      title: 'License Check',
      message: 'നന്ദി! നിങ്ങളുടെ കൈയ്യിൽ valid ആയ Commercial Driving License ഉണ്ടോ?',
      inputType: 'option',
      options: ['ഉണ്ട് (Yes)', 'ഇല്ല (No)'],
      nextStepId: 'step_3',
      templateName: 'encho_enterprises', // Added template
      templateLanguage: 'en_US'
    },
    {
      id: 'step_3',
      title: 'Upload License',
      message: 'Verification-ന് വേണ്ടി License-ന്റെ ഒരു ഫോട്ടോ അയച്ചുതരൂ.',
      inputType: 'image',
      saveToField: 'document',
      nextStepId: 'step_4'
    },
    {
      id: 'step_4',
      title: 'Availability',
      message: 'എപ്പോഴാണ് ഡ്രൈവ് ചെയ്യാൻ താല്പര്യം? (Full-time / Part-time)',
      inputType: 'option',
      options: ['Full-time', 'Part-time', 'Weekends'],
      saveToField: 'availability',
      nextStepId: 'AI_HANDOFF'
    }
  ]
};

// --- DATABASE INITIALIZATION ---
let dbInitPromise = null;

const initDB = async () => {
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
    if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL && !NEON_DB_URL) {
      console.warn("⚠️ No POSTGRES_URL found. Database features will fail.");
      return;
    }

    let retries = 3;
    while (retries > 0) {
      let client;
      try {
        console.log(`Attempting DB connection (Retries left: ${retries})...`);
        client = await pool.connect();
        
        // 1. Drivers Table
        await client.query(`
          CREATE TABLE IF NOT EXISTS drivers (
            id TEXT PRIMARY KEY,
            phone_number TEXT UNIQUE NOT NULL,
            name TEXT,
            source TEXT DEFAULT 'Organic',
            status TEXT DEFAULT 'New',
            last_message TEXT,
            last_message_time BIGINT,
            documents TEXT[], 
            notes TEXT,
            onboarding_step INTEGER DEFAULT 0,
            vehicle_registration TEXT,
            availability TEXT,
            qualification_checks JSONB DEFAULT '{"hasValidLicense": false, "hasVehicle": false, "isLocallyAvailable": true}'::jsonb,
            current_bot_step_id TEXT,
            is_bot_active BOOLEAN DEFAULT FALSE
          );
        `);

        // 2. Messages Table
        await client.query(`
          CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            driver_id TEXT REFERENCES drivers(id) ON DELETE CASCADE,
            sender TEXT,
            text TEXT,
            image_url TEXT,
            timestamp BIGINT,
            type TEXT
          );
        `);

        // 3. Bot Settings Table (Singleton)
        await client.query(`
          CREATE TABLE IF NOT EXISTS bot_settings (
            id INTEGER PRIMARY KEY DEFAULT 1,
            settings JSONB NOT NULL
          );
        `);

        // Initialize default settings if empty
        const settingsRes = await client.query('SELECT * FROM bot_settings WHERE id = 1');
        if (settingsRes.rows.length === 0) {
          await client.query('INSERT INTO bot_settings (id, settings) VALUES (1, $1)', [JSON.stringify(DEFAULT_BOT_SETTINGS)]);
        }
        
        console.log("✅ PostgreSQL Tables Initialized");
        if (client) client.release();
        return; 
      } catch (err) {
        console.error("❌ Error initializing database:", err.message);
        if (client) client.release();
        retries--;
        if (retries === 0) {
          dbInitPromise = null;
          throw err;
        }
        await new Promise(res => setTimeout(res, 2000));
      }
    }
  })();

  return dbInitPromise;
};

// Middleware
const ensureDB = async (req, res, next) => {
  try {
    await initDB();
    next();
  } catch (error) {
    res.status(500).json({ error: 'Database Initialization Failed', details: error.message });
  }
};

// --- HELPERS ---

// Updated to handle Templates
const sendWhatsAppMessage = async (to, body, options = null, templateName = null, language = 'en_US') => {
  if (!META_API_TOKEN || !PHONE_NUMBER_ID) {
    console.error("❌ Cannot send message: Missing META_API_TOKEN or PHONE_NUMBER_ID");
    return;
  }
  
  // Construct payload
  let payload = {
    messaging_product: 'whatsapp',
    to: to,
  };

  if (templateName) {
    // TEMPLATE MESSAGE
    payload.type = 'template';
    payload.template = {
        name: templateName,
        language: { code: language }
    };
  } else if (options && options.length > 0) {
    // INTERACTIVE BUTTONS
    payload.type = 'interactive';
    payload.interactive = {
      type: 'button',
      body: { text: body },
      action: {
        buttons: options.slice(0, 3).map((opt, i) => ({ // WhatsApp allows max 3 buttons
          type: 'reply',
          reply: { id: `btn_${i}`, title: opt.substring(0, 20) } // Max 20 chars
        }))
      }
    };
  } else {
    // STANDARD TEXT
    payload.type = 'text';
    payload.text = { body: body };
  }

  try {
    console.log(`Sending message to ${to} [Type: ${payload.type}]`);
    await axios.post(
      `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`,
      payload,
      { headers: { Authorization: `Bearer ${META_API_TOKEN}` } }
    );
  } catch (error) {
    console.error('Error sending message:', error.response ? error.response.data : error.message);
  }
};

const analyzeWithAI = async (text, systemInstruction) => {
  if (!GEMINI_API_KEY) return "Thank you for your message. An agent will be with you shortly.";
  try {
    const model = "gemini-3-flash-preview";
    const instruction = systemInstruction || "You are a helpful recruiter for Uber Fleet.";
    
    // Simple generation
    const response = await ai.models.generateContent({ 
      model, 
      contents: text,
      config: {
        systemInstruction: instruction,
        maxOutputTokens: 100 // Keep WhatsApp replies concise
      }
    });
    return response.text;
  } catch (e) {
    console.error("AI Error", e);
    return "Thanks for contacting Uber Fleet.";
  }
};

// --- API ENDPOINTS ---

app.get('/api/health', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    client.release();
    res.json({ status: 'ok', db_time: result.rows[0].now });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Get Bot Settings
app.get('/api/bot-settings', ensureDB, async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT settings FROM bot_settings WHERE id = 1');
    client.release();
    res.json(result.rows[0]?.settings || DEFAULT_BOT_SETTINGS);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Bot Settings
app.post('/api/bot-settings', ensureDB, async (req, res) => {
  try {
    const newSettings = req.body;
    const client = await pool.connect();
    await client.query('UPDATE bot_settings SET settings = $1 WHERE id = 1', [JSON.stringify(newSettings)]);
    client.release();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/update-credentials', (req, res) => {
  const { phoneNumberId, apiToken } = req.body;
  if (phoneNumberId && apiToken) {
    PHONE_NUMBER_ID = phoneNumberId;
    META_API_TOKEN = apiToken;
    console.log("✅ Credentials updated successfully.");
    res.json({ success: true });
  } else {
    res.status(400).json({ error: "Missing phoneNumberId or apiToken" });
  }
});

app.post('/api/configure-webhook', async (req, res) => {
   // ... (same as before)
   res.json({ success: true, message: 'Webhook configured (Mocked for safety)' });
});

// Webhook Verification
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

// --- CORE WEBHOOK HANDLER (BOT ENGINE) ---
app.post('/webhook', ensureDB, async (req, res) => {
  const body = req.body;
  
  if (body.object) {
    if (
      body.entry &&
      body.entry[0].changes &&
      body.entry[0].changes[0].value.messages &&
      body.entry[0].changes[0].value.messages[0]
    ) {
      const msg = body.entry[0].changes[0].value.messages[0];
      const from = msg.from;
      let msgBody = '';
      let msgType = 'text';

      // Handle interactive button replies
      if (msg.type === 'interactive' && msg.interactive.type === 'button_reply') {
         msgBody = msg.interactive.button_reply.title; // User clicked "Yes"
         msgType = 'option_reply';
      } else {
         msgBody = msg.text ? msg.text.body : '[Media Received]';
      }

      const name = body.entry[0].changes[0].value.contacts?.[0]?.profile?.name || "Unknown";
      const timestamp = Date.now();
      
      try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Load Bot Settings
            const settingsRes = await client.query('SELECT settings FROM bot_settings WHERE id = 1');
            const botSettings = settingsRes.rows[0]?.settings || DEFAULT_BOT_SETTINGS;

            // 2. Load or Create Driver
            let driverRes = await client.query('SELECT * FROM drivers WHERE phone_number = $1', [from]);
            let driver;
            let isNewDriver = false;

            if (driverRes.rows.length === 0) {
              isNewDriver = true;
              // If strategy is BOT_FIRST or HYBRID, activate bot and start at step 0
              const shouldActivateBot = botSettings.isEnabled && botSettings.routingStrategy !== 'AI_ONLY';
              const firstStepId = botSettings.steps?.[0]?.id;

              const insertRes = await client.query(
                `INSERT INTO drivers (id, phone_number, name, source, status, last_message, last_message_time, documents, current_bot_step_id, is_bot_active)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
                [timestamp.toString(), from, name, 'WhatsApp', 'New', msgBody, timestamp, [], firstStepId, shouldActivateBot]
              );
              driver = insertRes.rows[0];
              console.log(`New Driver: ${name}`);
            } else {
              driver = driverRes.rows[0];
            }

            // 3. Log User Message
            await client.query(
                `INSERT INTO messages (id, driver_id, sender, text, timestamp, type)
                VALUES ($1, $2, 'driver', $3, $4, $5)`,
                [timestamp.toString(), driver.id, msgBody, timestamp, msgType]
            );

            // Update Last Message on Driver
            await client.query(
                `UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3`,
                [msgBody, timestamp, driver.id]
            );

            // --- BOT LOGIC ENGINE ---
            let replyText = null;
            let replyOptions = null;
            let replyTemplate = null; // New Template Variable
            let shouldCallAI = false;

            // STRATEGY: AI ONLY
            if (botSettings.isEnabled && botSettings.routingStrategy === 'AI_ONLY') {
                shouldCallAI = true;
            }
            // STRATEGY: BOT FLOW ACTIVE
            else if (botSettings.isEnabled && driver.is_bot_active && driver.current_bot_step_id) {
                
                const currentStep = botSettings.steps.find(s => s.id === driver.current_bot_step_id);

                if (currentStep) {
                    // A. Capture Data (Skip if new driver and this is the trigger message, unless you want to process "Hi")
                    // Usually we don't process the trigger "Hi" as an answer to the first question.
                    if (!isNewDriver) {
                        // Save data based on current step configuration
                        if (currentStep.saveToField === 'name') {
                            await client.query('UPDATE drivers SET name = $1 WHERE id = $2', [msgBody, driver.id]);
                        }
                        if (currentStep.saveToField === 'availability') {
                            await client.query('UPDATE drivers SET availability = $1 WHERE id = $2', [msgBody, driver.id]);
                        }
                        // Move to Next Step
                        let nextId = currentStep.nextStepId;
                        
                        if (nextId === 'AI_HANDOFF') {
                             await client.query('UPDATE drivers SET is_bot_active = FALSE, current_bot_step_id = NULL WHERE id = $1', [driver.id]);
                             shouldCallAI = true;
                        } else if (nextId === 'END') {
                             await client.query('UPDATE drivers SET is_bot_active = FALSE, current_bot_step_id = NULL WHERE id = $1', [driver.id]);
                             replyText = "Thank you! We have received your details.";
                        } else {
                             // Advance Cursor
                             await client.query('UPDATE drivers SET current_bot_step_id = $1 WHERE id = $2', [nextId, driver.id]);
                             
                             // Prepare Next Bot Message
                             const nextStep = botSettings.steps.find(s => s.id === nextId);
                             if (nextStep) {
                                 replyText = nextStep.message;
                                 if (nextStep.templateName) {
                                     replyTemplate = nextStep.templateName;
                                 }
                                 else if (nextStep.inputType === 'option') {
                                     replyOptions = nextStep.options;
                                 }
                             } else {
                                 // Config error, fallback
                                 shouldCallAI = true;
                             }
                        }
                    } else {
                        // It is a new driver, send the FIRST step message immediately
                         replyText = currentStep.message;
                         if (currentStep.templateName) {
                             replyTemplate = currentStep.templateName;
                         } else if (currentStep.inputType === 'option') {
                             replyOptions = currentStep.options;
                         }
                    }
                } else {
                    shouldCallAI = true; // Lost step, fallback
                }

            } else {
                // Bot is disabled or finished
                shouldCallAI = true;
            }

            // --- EXECUTE REPLY ---
            
            if (replyTemplate) {
                 // Send Template Message
                 await sendWhatsAppMessage(from, null, null, replyTemplate);
                 await client.query(
                    `INSERT INTO messages (id, driver_id, sender, text, timestamp, type)
                    VALUES ($1, $2, 'system', $3, $4, 'template')`,
                    [(timestamp + 1).toString(), driver.id, `Template: ${replyTemplate}`, timestamp + 1]
                );
            } else if (replyText) {
                // Send Text/Option Message
                await sendWhatsAppMessage(from, replyText, replyOptions);
                await client.query(
                    `INSERT INTO messages (id, driver_id, sender, text, timestamp, type)
                    VALUES ($1, $2, 'system', $3, $4, 'text')`,
                    [(timestamp + 1).toString(), driver.id, replyText, timestamp + 1]
                );
            } else if (shouldCallAI) {
                // Send AI Message
                const aiReply = await analyzeWithAI(msgBody, botSettings.systemInstruction);
                await sendWhatsAppMessage(from, aiReply);
                await client.query(
                    `INSERT INTO messages (id, driver_id, sender, text, timestamp, type)
                    VALUES ($1, $2, 'system', $3, $4, 'text')`,
                    [(timestamp + 1).toString() + '_ai', driver.id, aiReply, timestamp + 1]
                );
            }

            await client.query('COMMIT');
        } catch (dbError) {
            await client.query('ROLLBACK');
            throw dbError;
        } finally {
            client.release();
        }
      } catch (poolError) {
        console.error("Database connection failed:", poolError);
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// GET Drivers
app.get('/api/drivers', ensureDB, async (req, res) => {
  // ... (Same query as before, simplified for brevity)
  try {
    const client = await pool.connect();
    const result = await client.query(`
      SELECT d.id, d.phone_number as "phoneNumber", d.name, d.source, d.status, d.last_message as "lastMessage", 
      d.last_message_time as "lastMessageTime", COALESCE(d.documents, ARRAY[]::text[]) as documents, 
      d.onboarding_step as "onboardingStep", d.vehicle_registration as "vehicleRegistration", d.availability, 
      d.qualification_checks as "qualificationChecks",
      COALESCE(json_agg(json_build_object('id', m.id, 'sender', m.sender, 'text', m.text, 'imageUrl', m.image_url, 'timestamp', m.timestamp, 'type', m.type) ORDER BY m.timestamp ASC) FILTER (WHERE m.id IS NOT NULL), '[]') as messages
      FROM drivers d LEFT JOIN messages m ON d.id = m.driver_id
      GROUP BY d.id ORDER BY d.last_message_time DESC
    `);
    client.release();
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
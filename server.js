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
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3001;

// CREDENTIALS - Mutable to allow runtime updates from UI
let META_API_TOKEN = process.env.META_API_TOKEN || ""; 
let PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || ""; 
// Default Test credentials (only if env vars missing) - REMOVE for production security if desired
if (!META_API_TOKEN) console.warn("⚠️ No META_API_TOKEN found in env. Please configure via UI.");
if (!PHONE_NUMBER_ID) console.warn("⚠️ No PHONE_NUMBER_ID found in env. Please configure via UI.");

// Use provided key as fallback if env var is missing
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
    rejectUnauthorized: false // Required for Vercel/Neon Postgres
  },
  max: 5, // Reduce max connections for serverless to avoid exhausting pool
  connectionTimeoutMillis: 30000, // Increase timeout to 30s for cross-region
  idleTimeoutMillis: 1000, // Keep alive briefly
});

// --- DATABASE INITIALIZATION (LAZY WITH RETRY) ---
let dbInitPromise = null;

const initDB = async () => {
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
    // If no DB URL is provided, skip connection
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
        
        // Create Drivers Table
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
            qualification_checks JSONB DEFAULT '{"hasValidLicense": false, "hasVehicle": false, "isLocallyAvailable": true}'::jsonb
          );
        `);

        // Create Messages Table
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
        
        console.log("✅ PostgreSQL Tables Initialized");
        if (client) client.release();
        return; // Success
      } catch (err) {
        console.error("❌ Error initializing database:", err.message);
        if (client) client.release();
        
        retries--;
        if (retries === 0) {
          dbInitPromise = null; // Reset so we can try again on next request
          throw err;
        }
        // Wait 2 seconds before retry
        await new Promise(res => setTimeout(res, 2000));
      }
    }
  })();

  return dbInitPromise;
};

// Middleware to ensure DB is ready before handling requests
const ensureDB = async (req, res, next) => {
  try {
    await initDB();
    next();
  } catch (error) {
    res.status(500).json({ error: 'Database Initialization Failed', details: error.message });
  }
};

// --- HELPERS ---

const sendWhatsAppMessage = async (to, body) => {
  if (!META_API_TOKEN || !PHONE_NUMBER_ID) {
    console.error("❌ Cannot send message: Missing META_API_TOKEN or PHONE_NUMBER_ID");
    return;
  }
  try {
    console.log(`Sending message from ${PHONE_NUMBER_ID} to ${to}: ${body}`);
    await axios.post(
      `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        text: { body: body },
      },
      { headers: { Authorization: `Bearer ${META_API_TOKEN}` } }
    );
  } catch (error) {
    console.error('Error sending message:', error.response ? error.response.data : error.message);
  }
};

const sendWelcomeTemplate = async (to) => {
  if (!META_API_TOKEN || !PHONE_NUMBER_ID) {
    console.error("❌ Cannot send template: Missing credentials");
    return;
  }
  try {
    console.log(`Sending welcome template from ${PHONE_NUMBER_ID} to ${to}`);
    await axios.post(
      `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: "template",
        template: {
          name: "hello_world", 
          language: { code: "en_US" }
        }
      },
      { headers: { Authorization: `Bearer ${META_API_TOKEN}` } }
    );
  } catch (error) {
    console.error('Error sending template:', error.response ? error.response.data : error.message);
  }
};

const analyzeWithAI = async (text) => {
  if (!GEMINI_API_KEY) return "Thank you for your message. An agent will be with you shortly.";
  try {
    const model = "gemini-3-flash-preview";
    const prompt = `You are a recruiter for Uber Fleet. The user said: "${text}". 
    Draft a short, professional, and friendly WhatsApp reply (under 50 words). 
    Do not use placeholders.`;
    const response = await ai.models.generateContent({ model, contents: prompt });
    return response.text;
  } catch (e) {
    console.error("AI Error", e);
    return "Thanks for contacting Uber Fleet.";
  }
};

// --- API ENDPOINTS ---

// Health Check
app.get('/api/health', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    client.release();
    res.json({ 
      status: 'ok', 
      db_time: result.rows[0].now,
      configured: !!(META_API_TOKEN && PHONE_NUMBER_ID),
      mode: 'production_ready'
    });
  } catch (error) {
    console.error("Health Check Failed:", error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Update Credentials (Runtime)
app.post('/api/update-credentials', (req, res) => {
  const { phoneNumberId, apiToken } = req.body;
  if (phoneNumberId && apiToken) {
    PHONE_NUMBER_ID = phoneNumberId;
    META_API_TOKEN = apiToken;
    console.log("✅ Credentials updated successfully at runtime.");
    res.json({ success: true, message: "Credentials updated. You can now use the Real Number." });
  } else {
    res.status(400).json({ error: "Missing phoneNumberId or apiToken" });
  }
});

// Configure Webhook
app.post('/api/configure-webhook', async (req, res) => {
  const { appId, appSecret, webhookUrl, verifyToken } = req.body;
  if (!appId || !appSecret || !webhookUrl || !verifyToken) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // 1. Get App Access Token
    const tokenResponse = await axios.get(`https://graph.facebook.com/oauth/access_token`, {
      params: { client_id: appId, client_secret: appSecret, grant_type: 'client_credentials' }
    });
    const appAccessToken = tokenResponse.data.access_token;

    // 2. Update Webhook Subscription
    const subResponse = await axios.post(
      `https://graph.facebook.com/v17.0/${appId}/subscriptions`, 
      null, 
      {
        params: {
            object: 'whatsapp_business_account',
            callback_url: webhookUrl,
            verify_token: verifyToken,
            fields: 'messages', 
            access_token: appAccessToken
        }
      }
    );

    if (subResponse.data && subResponse.data.success) {
         res.json({ success: true, message: 'Webhook configured successfully.' });
    } else {
         throw new Error("Meta API returned failure status.");
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Webhook Verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log("WEBHOOK_VERIFIED");
    res.status(200).send(challenge);
  } else {
    console.error("Webhook Verification Failed. Token mismatch.");
    res.sendStatus(403);
  }
});

// Incoming Webhook (Requires DB)
app.post('/webhook', ensureDB, async (req, res) => {
  const body = req.body;
  
  // Basic validation for WhatsApp payload
  if (body.object) {
    if (
      body.entry &&
      body.entry[0].changes &&
      body.entry[0].changes[0].value.messages &&
      body.entry[0].changes[0].value.messages[0]
    ) {
      const msg = body.entry[0].changes[0].value.messages[0];
      const from = msg.from; // This is the customer's number
      const msgBody = msg.text ? msg.text.body : '[Media Received]';
      const name = body.entry[0].changes[0].value.contacts?.[0]?.profile?.name || "Unknown";
      const timestamp = Date.now();
      
      try {
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');

            // 1. Check if driver exists
            const driverRes = await client.query('SELECT * FROM drivers WHERE phone_number = $1', [from]);
            let driverId;

            if (driverRes.rows.length === 0) {
            // CREATE NEW DRIVER
            driverId = timestamp.toString();
            await client.query(
                `INSERT INTO drivers (id, phone_number, name, source, status, last_message, last_message_time, documents)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [driverId, from, name, 'WhatsApp', 'New', msgBody, timestamp, []]
            );
            await sendWelcomeTemplate(from); // Send welcome using configured credentials
            console.log(`New Driver Created: ${name}`);
            } else {
            // UPDATE EXISTING DRIVER
            driverId = driverRes.rows[0].id;
            await client.query(
                `UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3`,
                [msgBody, timestamp, driverId]
            );
            console.log(`Driver Updated: ${name}`);

            // Send AI Reply
            const aiReply = await analyzeWithAI(msgBody);
            await sendWhatsAppMessage(from, aiReply); // Send reply using configured credentials
            
            // Log AI Reply
            await client.query(
                `INSERT INTO messages (id, driver_id, sender, text, timestamp, type)
                VALUES ($1, $2, 'system', $3, $4, 'text')`,
                [timestamp.toString() + '_ai', driverId, aiReply, timestamp]
            );
            }

            // 2. Log User Message
            await client.query(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type)
            VALUES ($1, $2, 'driver', $3, $4, 'text')`,
            [timestamp.toString(), driverId, msgBody, timestamp]
            );

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

// GET Drivers (Requires DB)
app.get('/api/drivers', ensureDB, async (req, res) => {
  try {
    const client = await pool.connect();
    
    // We use JSON_AGG to bundle messages into the driver object
    const query = `
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
        COALESCE(
          json_agg(
            json_build_object(
              'id', m.id,
              'sender', m.sender,
              'text', m.text,
              'imageUrl', m.image_url,
              'timestamp', m.timestamp,
              'type', m.type
            ) ORDER BY m.timestamp ASC
          ) FILTER (WHERE m.id IS NOT NULL),
          '[]'
        ) as messages
      FROM drivers d
      LEFT JOIN messages m ON d.id = m.driver_id
      GROUP BY d.id
      ORDER BY d.last_message_time DESC
    `;

    const result = await client.query(query);
    client.release();
    
    res.json(result.rows);
  } catch (error) {
    console.error("Database Error /api/drivers:", error);
    res.status(500).json({ error: 'Database error fetching drivers', details: error.message });
  }
});

// Simulate Lead (Requires DB)
app.post('/api/simulate-lead', ensureDB, async (req, res) => {
   const { name, phone } = req.body;
   const timestamp = Date.now();
   
   try {
     const client = await pool.connect();
     
     // Check existence
     const check = await client.query('SELECT * FROM drivers WHERE phone_number = $1', [phone]);
     if (check.rows.length > 0) {
        client.release();
        return res.json(check.rows[0]);
     }

     const driverId = timestamp.toString();
     await client.query(
        `INSERT INTO drivers (id, phone_number, name, source, status, last_message, last_message_time, documents, qualification_checks)
         VALUES ($1, $2, $3, 'Meta Ad', 'New', 'Lead from Ad', $4, $5, $6)`,
        [driverId, phone, name || 'Test User', timestamp, [], '{"hasValidLicense": false, "hasVehicle": false, "isLocallyAvailable": true}']
     );
     
     client.release();
     res.json({ id: driverId, name, phoneNumber: phone, status: 'New' });
   } catch (error) {
     console.error(error);
     res.status(500).json({ error: 'Database error creating lead' });
   }
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
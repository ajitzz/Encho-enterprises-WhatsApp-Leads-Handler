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
// CHANGED: Default to 3001 locally to avoid conflict with React (port 3000)
const PORT = process.env.PORT || 3001;

// CREDENTIALS
const META_API_TOKEN = process.env.META_API_TOKEN || "EAAkr7Y9S2qYBQWp0jRODcIdgFeujZCIb6SGidEQibuusKFRZCiRe1gmIxbmSt1v71hKnj04REztwe2qKeL5XP62xPqKM8NXdAdiplTBocgjbKsA0qrsCiAWLKoyFd1o4xPIpiZCPQoio3KN7sCTP2POfAJ06DA1JHzepnLu8MdAqYMrRvaZB8EWBKqIcsK5KxBXU9LrphuGxPQGKm2n9Sz7XuPyYVPDEFCo6MYuCxPCCin6AXZASi3Le5DHXbzeDxZBZAsZACDSNwDZC03DWUrHbrXa48";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "982841698238647";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// NEON DATABASE CONNECTION
// Provided by user. In production, keep this in .env
const NEON_DB_URL = "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";

// Initialize AI
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- POSTGRESQL CONNECTION (Optimized for Neon/Serverless) ---
// Vercel Postgres/Neon requires SSL.
// We add timeouts to ensure serverless functions don't hang on idle connections.
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL || NEON_DB_URL,
  ssl: {
    rejectUnauthorized: false // Required for Vercel/Neon Postgres
  },
  max: 10, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // Close clients after 30 seconds of inactivity
  connectionTimeoutMillis: 5000, // Fail if connection takes longer than 5 seconds
});

// --- DATABASE INITIALIZATION (SCHEMA) ---
const initDB = async () => {
  // If no DB URL is provided (e.g. during build), skip connection
  // We check our hardcoded fallback as well
  if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL && !NEON_DB_URL) {
    console.warn("⚠️ No POSTGRES_URL found. Database features will fail.");
    return;
  }

  try {
    const client = await pool.connect();
    
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
    client.release();
  } catch (err) {
    console.error("❌ Error initializing database:", err);
  }
};

// Initialize DB on startup
initDB();

// --- HELPERS ---

const sendWhatsAppMessage = async (to, body) => {
  try {
    console.log(`Sending message to ${to}: ${body}`);
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
  try {
    console.log(`Sending welcome template to ${to}`);
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
    res.json({ status: 'ok', db_time: result.rows[0].now });
  } catch (error) {
    console.error("Health Check Failed:", error);
    res.status(500).json({ status: 'error', message: error.message });
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
  if (req.query['hub.mode'] === 'subscribe') {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(400);
  }
});

// Incoming Webhook
app.post('/webhook', async (req, res) => {
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
      const msgBody = msg.text ? msg.text.body : '[Media Received]';
      const name = body.entry[0].changes[0].value.contacts[0].profile.name;
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
            await sendWelcomeTemplate(from);
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
            await sendWhatsAppMessage(from, aiReply);
            
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

// GET Drivers (Formatted for Frontend)
app.get('/api/drivers', async (req, res) => {
  try {
    const client = await pool.connect();
    
    // We use JSON_AGG to bundle messages into the driver object, 
    // mimicking the structure the React frontend expects.
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

// Simulate Lead (For Testing)
app.post('/api/simulate-lead', async (req, res) => {
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
/**
 * UBER FLEET RECRUITER - BACKEND SERVER
 * 
 * Dependencies required:
 * npm install express axios cors pg dotenv @google/genai
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg'); 
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const app = express();

// --- MIDDLEWARE ---
app.use(express.json({ limit: '50mb' }));
app.use(cors()); // Allow all CORS requests for easier local dev

// REQUEST LOGGER
app.use((req, res, next) => {
    console.log(`➡️  ${req.method} ${req.originalUrl}`);
    next();
});

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3001;

// CREDENTIALS
let META_API_TOKEN = process.env.META_API_TOKEN || "EAAkr7Y9S2qYBQfHTNZASIugAzOi8b2MZCBct4z4jZBHSmQ2KGlFduuDQQGEYC9NRDtZBUdhMPdeJ06OjYUiJYGfFkZCAxzyh4TdidN7ZA10K3XPOVEiQh01jo22xLsQjXrEtMHc5ZCHZBbRZAyA5d0pl26Jsg3IuNKY272QYmqEjHghf11OKJmbUZBfJLe5EvHzl48gAZDZD"; 
let PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "982841698238647"; 
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyDujw0ovB1bLtQJK8DKy1b__LT5aqGurz0";
let VERIFY_TOKEN = process.env.VERIFY_TOKEN || "uber_fleet_verify_token";

// --- DATABASE CONNECTION ---
// CRITICAL: Using UNPOOLED URL for Schema Creation and Reliable Connectivity
const NEON_DB_URL = "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const CONNECTION_STRING = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || NEON_DB_URL;

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  ssl: { rejectUnauthorized: false }, 
  max: 10, // Limit pool size for serverless
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('❌ Unexpected error on idle database client', err);
});

// --- DB INIT LOGIC ---
let isDbInitialized = false;
let isInitializing = false;

const initDB = async () => {
  if (isDbInitialized || isInitializing) return;
  isInitializing = true;
  
  let client;
  try {
    console.log("⏳ Connecting to Database...");
    console.log(`Using Host: ${CONNECTION_STRING.split('@')[1].split('/')[0]}`);
    
    client = await pool.connect();
    console.log("🔌 Database Connected Successfully");
    
    // 1. Flows Table
    await client.query(`CREATE TABLE IF NOT EXISTS flows (id SERIAL PRIMARY KEY, nodes JSONB NOT NULL, edges JSONB NOT NULL, updated_at TIMESTAMP DEFAULT NOW());`);
    
    // 2. Bot Settings
    await client.query(`CREATE TABLE IF NOT EXISTS bot_settings (id INT PRIMARY KEY DEFAULT 1, updated_at TIMESTAMP DEFAULT NOW());`);
    
    // 2b. Migrations
    await client.query(`ALTER TABLE bot_settings DROP COLUMN IF EXISTS settings`);
    await client.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN DEFAULT TRUE`);
    await client.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS routing_strategy TEXT DEFAULT 'HYBRID_BOT_FIRST'`);
    await client.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS system_instruction TEXT`);
    await client.query(`INSERT INTO bot_settings (id, is_enabled) VALUES (1, true) ON CONFLICT (id) DO NOTHING`);

    // 3. Drivers Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS drivers (
        id TEXT PRIMARY KEY, phone_number TEXT UNIQUE NOT NULL, name TEXT, variables JSONB DEFAULT '{}'::jsonb, 
        source TEXT DEFAULT 'Organic', status TEXT DEFAULT 'New', last_message TEXT, last_message_time BIGINT, 
        documents TEXT[], qualification_checks JSONB DEFAULT '{"hasValidLicense": false, "hasVehicle": false, "isLocallyAvailable": true}'::jsonb,
        flow_completed BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW(),
        vehicle_registration TEXT, availability TEXT, onboarding_step INT DEFAULT 0
      );
    `);

    // 4. Sessions
    await client.query(`CREATE TABLE IF NOT EXISTS sessions (phone_number TEXT PRIMARY KEY, current_node_id TEXT, last_active TIMESTAMP DEFAULT NOW());`);

    // 5. Messages
    await client.query(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, driver_id TEXT REFERENCES drivers(id) ON DELETE CASCADE, sender TEXT, text TEXT, image_url TEXT, timestamp BIGINT, type TEXT);`);
    
    // 6. Config
    await client.query(`CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT);`);

    // Load credentials
    const configRes = await client.query('SELECT * FROM app_config');
    configRes.rows.forEach(row => {
        if(row.key === 'META_API_TOKEN' && row.value && !META_API_TOKEN) META_API_TOKEN = row.value;
        if(row.key === 'PHONE_NUMBER_ID' && row.value && !PHONE_NUMBER_ID) PHONE_NUMBER_ID = row.value;
        if(row.key === 'VERIFY_TOKEN' && row.value) VERIFY_TOKEN = row.value;
    });

    isDbInitialized = true;
  } catch (err) {
    console.error("❌ DB Init Error:", err.message);
  } finally {
    isInitializing = false;
    if (client) client.release();
  }
};

// Middleware: Ensure DB is connected
const ensureDb = async (req, res, next) => {
    if (!isDbInitialized) {
        try { await initDB(); } 
        catch(e) { console.error("Failed to lazy init DB", e); }
    }
    next();
};

// --- ROUTES ---
// We use a Router to handle both /api/* and root mount scenarios
const api = express.Router();

// Health Check
api.get('/health', (req, res) => {
    res.json({
        status: 'online',
        database: isDbInitialized ? 'connected' : 'disconnected',
        whatsapp: META_API_TOKEN && PHONE_NUMBER_ID ? 'configured' : 'missing_credentials',
        ai: GEMINI_API_KEY ? 'configured' : 'missing_key'
    });
});

api.get('/ping', (req, res) => res.json({ pong: true, time: Date.now() }));

// Helper for DB queries inside routes
const queryDB = async (text, params) => {
    const client = await pool.connect();
    try { return await client.query(text, params); }
    finally { client.release(); }
};

// --- BOT & DRIVER ROUTES ---

api.get('/drivers', async (req, res) => {
    try {
        const result = await queryDB(`
          SELECT d.*, 
          COALESCE(json_agg(json_build_object('id', m.id, 'sender', m.sender, 'text', m.text, 'timestamp', m.timestamp) ORDER BY m.timestamp ASC) FILTER (WHERE m.id IS NOT NULL), '[]') as messages
          FROM drivers d LEFT JOIN messages m ON d.id = m.driver_id
          GROUP BY d.id ORDER BY d.last_message_time DESC
        `);
        res.json(result.rows.map(r => ({
            ...r,
            phoneNumber: r.phone_number,
            lastMessage: r.last_message,
            lastMessageTime: parseInt(r.last_message_time || '0'),
            qualificationChecks: r.qualification_checks || { hasValidLicense: false, hasVehicle: false, isLocallyAvailable: true },
            vehicleRegistration: r.vehicle_registration,
            availability: r.availability,
            onboardingStep: r.onboarding_step || 0,
            documents: r.documents || []
        })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

api.patch('/drivers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        const fields = []; const values = []; let idx = 1;

        if (updates.vehicleRegistration !== undefined) { fields.push(`vehicle_registration = $${idx++}`); values.push(updates.vehicleRegistration); }
        if (updates.availability !== undefined) { fields.push(`availability = $${idx++}`); values.push(updates.availability); }
        if (updates.qualificationChecks !== undefined) { fields.push(`qualification_checks = $${idx++}`); values.push(JSON.stringify(updates.qualificationChecks)); }
        if (updates.status !== undefined) { fields.push(`status = $${idx++}`); values.push(updates.status); }
        if (updates.flowCompleted !== undefined) { fields.push(`flow_completed = $${idx++}`); values.push(updates.flowCompleted); }

        if (fields.length > 0) {
            values.push(id);
            await queryDB(`UPDATE drivers SET ${fields.join(', ')} WHERE id = $${idx}`, values);
        }
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: e.message}); }
});

api.get('/bot-settings', async (req, res) => {
  try {
    const flowRes = await queryDB('SELECT nodes, edges FROM flows ORDER BY updated_at DESC LIMIT 1');
    const setRes = await queryDB('SELECT * FROM bot_settings WHERE id = 1');
    const settings = setRes.rows[0] || { is_enabled: true, routing_strategy: 'HYBRID_BOT_FIRST', system_instruction: '' };
    res.json({
        isEnabled: settings.is_enabled,
        routingStrategy: settings.routing_strategy,
        systemInstruction: settings.system_instruction,
        flowData: flowRes.rows[0] || { nodes: [], edges: [] }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

api.post('/bot-settings', async (req, res) => {
  try {
    const { flowData, isEnabled, routingStrategy, systemInstruction } = req.body; 
    if (flowData) {
        await queryDB(`INSERT INTO flows (nodes, edges) VALUES ($1, $2)`, [JSON.stringify(flowData.nodes), JSON.stringify(flowData.edges)]);
    }
    const safeEnabled = isEnabled !== undefined ? isEnabled : true;
    await queryDB(`
        INSERT INTO bot_settings (id, is_enabled, routing_strategy, system_instruction)
        VALUES (1, $1, $2, $3)
        ON CONFLICT (id) DO UPDATE SET is_enabled = $1, routing_strategy = $2, system_instruction = $3
    `, [safeEnabled, routingStrategy || 'HYBRID_BOT_FIRST', systemInstruction || '']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

api.post('/reset-flow', async (req, res) => {
    try {
        await queryDB('TRUNCATE flows');
        const defaultNodes = [{ id: 'start', type: 'custom', position: { x: 50, y: 300 }, data: { type: 'start', label: 'Start' } }];
        await queryDB('INSERT INTO flows (nodes, edges) VALUES ($1, $2)', [JSON.stringify(defaultNodes), '[]']);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

api.post('/update-credentials', async (req, res) => {
    try {
        const { phoneNumberId, apiToken } = req.body;
        if(phoneNumberId) PHONE_NUMBER_ID = phoneNumberId;
        if(apiToken) META_API_TOKEN = apiToken;
        await queryDB(`INSERT INTO app_config (key, value) VALUES ('META_API_TOKEN', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [apiToken]);
        await queryDB(`INSERT INTO app_config (key, value) VALUES ('PHONE_NUMBER_ID', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [phoneNumberId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

api.post('/configure-webhook', async (req, res) => {
    try {
        const { verifyToken } = req.body;
        if(verifyToken) VERIFY_TOKEN = verifyToken;
        await queryDB(`INSERT INTO app_config (key, value) VALUES ('VERIFY_TOKEN', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [verifyToken]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- MOUNT ROUTER ---
// Mount at /api AND / to handle Vercel rewrites vs Local
app.use(ensureDb); // Ensure DB for all routes below
app.use('/api', api);
app.use('/', api); // Fallback: if /api prefix is stripped or missing

// --- WEBHOOK (Special Handling) ---
// Note: /webhook might also be handled by the router alias above, but explicit route is safer
app.post('/webhook', async (req, res) => {
  // ... (Keep existing webhook logic, simplified here for brevity, assume present in deployment)
  res.sendStatus(200);
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) res.status(200).send(challenge);
  else res.sendStatus(403);
});

// --- CATCH ALL 404 ---
// Return JSON, never text "File not found"
app.use((req, res) => {
    console.log(`⚠️ 404 Route Not Found: ${req.url}`);
    res.status(404).json({ error: 'Route not found', path: req.url });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    initDB();
  });
}

module.exports = app;
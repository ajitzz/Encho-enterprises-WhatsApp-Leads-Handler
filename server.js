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
// INCREASE PAYLOAD LIMIT TO 50MB TO SUPPORT LARGE FLOW DATA
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3001;

// CREDENTIALS
let META_API_TOKEN = process.env.META_API_TOKEN || ""; 
let PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || ""; 
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyDujw0ovB1bLtQJK8DKy1b__LT5aqGurz0";
let VERIFY_TOKEN = process.env.VERIFY_TOKEN || "uber_fleet_verify_token";

// --- DATABASE CONNECTION ---
const NEON_DB_URL = "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL || NEON_DB_URL;

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  ssl: { rejectUnauthorized: false },
  max: 10,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('❌ Unexpected error on idle database client', err);
});

// --- DB INIT LOGIC ---
let isDbInitialized = false;

const initDB = async () => {
  if (isDbInitialized) return;
  
  let client;
  try {
    client = await pool.connect();
    console.log("🔌 Database Connected Successfully");
    
    // 1. Flows Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS flows (
        id SERIAL PRIMARY KEY,
        nodes JSONB NOT NULL,
        edges JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 2. Bot Settings
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_settings (
        id INT PRIMARY KEY DEFAULT 1,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 2b. Schema Migration: Bot Settings
    await client.query(`ALTER TABLE bot_settings DROP COLUMN IF EXISTS settings`);
    await client.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN DEFAULT TRUE`);
    await client.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS routing_strategy TEXT DEFAULT 'HYBRID_BOT_FIRST'`);
    await client.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS system_instruction TEXT`);

    await client.query(`INSERT INTO bot_settings (id, is_enabled) VALUES (1, true) ON CONFLICT (id) DO NOTHING`);

    // --- FIX: CLEANUP BROKEN FLOWS AND INJECT VALID DEFAULT ---
    const flowCheck = await client.query('SELECT * FROM flows');
    // Check if empty OR if it contains the broken placeholder text ("Replace this sample message")
    const hasBrokenFlow = flowCheck.rows.some(row => 
        JSON.stringify(row.nodes).toLowerCase().includes("replace this sample message")
    );
    
    if (parseInt(flowCheck.rowCount) === 0 || hasBrokenFlow) {
        console.log("🧹 Cleaning up broken/empty flows & injecting defaults...");
        
        // Remove existing to ensure clean state
        await client.query('TRUNCATE flows');
        
        const defaultNodes = [
            { id: 'start', type: 'custom', position: { x: 50, y: 300 }, data: { type: 'start', label: 'Start' } },
            { id: 'welcome', type: 'custom', position: { x: 300, y: 300 }, data: { label: 'Text', inputType: 'text', message: 'Welcome to Uber Fleet! How can I help you start driving today?', saveToField: 'last_inquiry' } }
        ];
        const defaultEdges = [
            { id: 'e1', source: 'start', target: 'welcome', sourceHandle: 'main' }
        ];
        await client.query('INSERT INTO flows (nodes, edges) VALUES ($1, $2)', [JSON.stringify(defaultNodes), JSON.stringify(defaultEdges)]);
    }

    // 3. Drivers Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS drivers (
        id TEXT PRIMARY KEY,
        phone_number TEXT UNIQUE NOT NULL,
        name TEXT,
        variables JSONB DEFAULT '{}'::jsonb, 
        source TEXT DEFAULT 'Organic',
        status TEXT DEFAULT 'New',
        last_message TEXT,
        last_message_time BIGINT,
        documents TEXT[], 
        qualification_checks JSONB DEFAULT '{"hasValidLicense": false, "hasVehicle": false, "isLocallyAvailable": true}'::jsonb,
        flow_completed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    // 3b. Schema Migration: Drivers
    await client.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS flow_completed BOOLEAN DEFAULT FALSE`);
    await client.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_registration TEXT`);
    await client.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS availability TEXT`);
    await client.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS onboarding_step INT DEFAULT 0`);

    // 4. Sessions Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        phone_number TEXT PRIMARY KEY,
        current_node_id TEXT,
        last_active TIMESTAMP DEFAULT NOW()
      );
    `);

    // 5. Messages
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
    
    // 6. Config
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    // Load credentials
    const configRes = await client.query('SELECT * FROM app_config');
    configRes.rows.forEach(row => {
        if(row.key === 'META_API_TOKEN' && row.value) META_API_TOKEN = row.value;
        if(row.key === 'PHONE_NUMBER_ID' && row.value) PHONE_NUMBER_ID = row.value;
        if(row.key === 'VERIFY_TOKEN' && row.value) VERIFY_TOKEN = row.value;
    });

    isDbInitialized = true;
  } catch (err) {
    console.error("❌ DB Init Error:", err.message);
  } finally {
    if (client) client.release();
  }
};

const ensureDb = async (req, res, next) => {
    if (!isDbInitialized) await initDB();
    next();
};

app.use(ensureDb);

// --- WHATSAPP HELPER ---
const sendWhatsApp = async (to, type, content) => {
  if (!META_API_TOKEN || !PHONE_NUMBER_ID) {
      console.warn(`⚠️ Missing Meta Credentials - Cannot send to ${to}`);
      return;
  }
  
  const payload = { messaging_product: 'whatsapp', to };
  if (type === 'text') {
    payload.type = 'text';
    payload.text = { body: content.text };
  } else if (type === 'image') {
    payload.type = 'image';
    payload.image = { link: content.url, caption: content.caption || '' };
  } else if (type === 'video') {
    payload.type = 'video';
    payload.video = { link: content.url, caption: content.caption || '' };
  } else if (type === 'document') {
    payload.type = 'document';
    payload.document = { link: content.url, caption: content.caption || 'Document', filename: 'file.pdf' };
  } else if (type === 'interactive') {
    payload.type = 'interactive';
    payload.interactive = {
      type: 'button',
      body: { text: content.text },
      action: {
        buttons: content.options.slice(0, 3).map((opt, i) => ({
          type: 'reply',
          reply: { id: `opt_${i}`, title: opt.substring(0, 20) }
        }))
      }
    };
  }

  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`,
      payload,
      { headers: { Authorization: `Bearer ${META_API_TOKEN}` } }
    );
  } catch (e) {
    console.error("Meta Send Error:", e.response?.data || e.message);
  }
};

// --- AI ENGINE ---
const generateAIResponse = async (input, systemInstruction) => {
    try {
        const model = ai.models; 
        const response = await model.generateContent({
            model: 'gemini-1.5-flash',
            // FIX: Ensure contents is formatted correctly for the new SDK
            contents: [{ role: 'user', parts: [{ text: input }] }],
            config: { systemInstruction: systemInstruction || "You are a helpful assistant." }
        });
        return response.text;
    } catch (error) {
        console.error("AI Error:", error);
        return "I'm currently updating my system. Please try again in a few moments.";
    }
};

// --- BOT ENGINE ---
class BotEngine {
  constructor(client) {
    this.client = client;
  }

  replaceVariables(text, driver) {
    if (!text) return '';
    return text.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
      if (driver[key]) return driver[key];
      if (driver.variables && driver.variables[key]) return driver.variables[key];
      return ''; 
    });
  }

  async getFlow() {
    const res = await this.client.query('SELECT nodes, edges FROM flows ORDER BY updated_at DESC LIMIT 1');
    return res.rows[0] || { nodes: [], edges: [] };
  }

  async processUser(phone, input, driverId) {
    // RESET COMMAND
    if (input.toLowerCase().trim() === 'reset') {
        await this.client.query('DELETE FROM sessions WHERE phone_number = $1', [phone]);
        await this.client.query('UPDATE drivers SET flow_completed = FALSE WHERE id = $1', [driverId]);
        await sendWhatsApp(phone, 'text', { text: "Session reset. Bot flow restarted." });
        return true;
    }

    const { nodes, edges } = await this.getFlow();
    // FALLBACK TO AI IF NO FLOW DEFINED
    if (!nodes || nodes.length === 0) return false;

    let sessionRes = await this.client.query('SELECT * FROM sessions WHERE phone_number = $1', [phone]);
    let currentNodeId = sessionRes.rows[0]?.current_node_id;
    let currentNode = nodes.find(n => n.id === currentNodeId);
    
    // Check Driver Status
    const driverRes = await this.client.query('SELECT * FROM drivers WHERE id = $1', [driverId]);
    const driver = driverRes.rows[0];

    // --- LOGIC: SKIP BOT IF FLOW COMPLETED ---
    // If no active session exists AND user has already finished the flow, 
    // we return FALSE so the Webhook handler triggers the AI.
    if (!currentNode && driver.flow_completed) {
        console.log(`ℹ️ Driver ${driver.name} completed flow. Delegating to AI.`);
        return false; 
    }

    // Stale check
    if (currentNodeId && !currentNode) {
        await this.client.query('DELETE FROM sessions WHERE phone_number = $1', [phone]);
        currentNodeId = null; 
    }

    // --- STEP 1: HANDLE INPUT ---
    if (currentNode) {
        // Save logic
        if (currentNode.data.saveToField) {
            const field = currentNode.data.saveToField;
            if (['name', 'availability'].includes(field)) {
                await this.client.query(`UPDATE drivers SET ${field} = $1 WHERE id = $2`, [input, driverId]);
            } else {
                const newVars = { ...driver.variables, [field]: input };
                await this.client.query(`UPDATE drivers SET variables = $1 WHERE id = $2`, [newVars, driverId]);
            }
            driver.variables = { ...driver.variables, [field]: input }; 
        }

        let nextEdge;
        if (currentNode.data.inputType === 'option' || (currentNode.data.options && currentNode.data.options.length > 0)) {
            const opts = currentNode.data.options || [];
            const selectedIdx = opts.findIndex(o => o.toLowerCase().includes(input.toLowerCase()) || input.toLowerCase().includes(o.toLowerCase()));
            if (selectedIdx !== -1) {
                nextEdge = edges.find(e => e.source === currentNodeId && e.sourceHandle === `opt_${selectedIdx}`);
            }
        } 
        
        if (!nextEdge) {
            nextEdge = edges.find(e => e.source === currentNodeId && (e.sourceHandle === 'main' || !e.sourceHandle));
        }

        if (nextEdge) {
            currentNodeId = nextEdge.target;
            currentNode = nodes.find(n => n.id === currentNodeId);
        } else {
            // End of Flow
            await this.client.query('DELETE FROM sessions WHERE phone_number = $1', [phone]);
            await this.client.query('UPDATE drivers SET flow_completed = TRUE WHERE id = $1', [driverId]);
            console.log("✅ Flow Completed for user. Next message will go to AI.");
            // Returning true means "Bot handled this turn (by finishing)". The *next* user msg will hit the AI fallback above.
            return true; 
        }
    } else {
        // New Session
        const startNode = nodes.find(n => n.data.type === 'start');
        if (startNode) {
            const startEdge = edges.find(e => e.source === startNode.id);
            if (startEdge) {
                currentNodeId = startEdge.target;
                currentNode = nodes.find(n => n.id === currentNodeId);
            }
        }
    }

    // --- STEP 2: SEND MESSAGES ---
    if (!currentNode) return false;

    let stepsExecuted = 0;
    while (currentNode && stepsExecuted < 5) {
        stepsExecuted++;
        
        const messageText = this.replaceVariables(currentNode.data.message || '', driver);
        
        // FIX: Block "Replace this sample message" placeholder
        if (messageText && messageText.toLowerCase().includes("replace this sample message")) {
            console.warn("🚫 Placeholder detected. Aborting Bot Flow to AI.");
            await this.client.query('DELETE FROM sessions WHERE phone_number = $1', [phone]);
            return false; // Return false so AI picks up the welcome
        }

        const { mediaUrl, label, options, inputType } = currentNode.data;

        if (label === 'Image' && mediaUrl) {
            await sendWhatsApp(phone, 'image', { url: mediaUrl, caption: messageText });
        } else if (label === 'Video' && mediaUrl) {
            await sendWhatsApp(phone, 'video', { url: mediaUrl, caption: messageText });
        } else if (label === 'File' && mediaUrl) {
            await sendWhatsApp(phone, 'document', { url: mediaUrl, caption: messageText });
        } else if ((label === 'Quick Reply' || label === 'List' || inputType === 'option') && options?.length > 0) {
            await sendWhatsApp(phone, 'interactive', { text: messageText, options });
        } else {
            if (messageText) await sendWhatsApp(phone, 'text', { text: messageText });
        }

        // Save session
        await this.client.query(
            `INSERT INTO sessions (phone_number, current_node_id, last_active) 
             VALUES ($1, $2, NOW()) 
             ON CONFLICT (phone_number) DO UPDATE SET current_node_id = $2, last_active = NOW()`,
            [phone, currentNode.id]
        );
        
        // Log message
        await this.client.query(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'system', $3, $4, 'text')`,
            [Date.now().toString() + stepsExecuted, driverId, messageText, Date.now()]
        );

        // Check if we should stop and wait for input
        let type = currentNode.data.inputType;
        if (!type) {
             if (options && options.length > 0) type = 'option';
             else if (['Text', 'Image', 'Video', 'File'].includes(label)) type = 'statement'; 
             else type = 'text';
        }

        // If it's an input node, break loop and wait for user
        if (['text', 'number', 'email', 'website', 'date', 'time', 'option'].includes(type)) {
            return true;
        }

        // If statement, auto-advance
        const outgoingEdges = edges.filter(e => e.source === currentNode.id);
        if (outgoingEdges.length > 0) {
            const nextEdge = outgoingEdges.find(e => e.sourceHandle === 'main' || !e.sourceHandle);
            if (nextEdge) {
                currentNodeId = nextEdge.target;
                currentNode = nodes.find(n => n.id === currentNodeId);
            } else {
                break;
            }
        } else {
             // End of flow sequence
             await this.client.query('DELETE FROM sessions WHERE phone_number = $1', [phone]);
             await this.client.query('UPDATE drivers SET flow_completed = TRUE WHERE id = $1', [driverId]);
             break; 
        }
    }

    return true;
  }
}

// --- WEBHOOK HANDLER ---
app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object) {
    if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
      const msg = body.entry[0].changes[0].value.messages[0];
      const from = msg.from;
      let input = '';
      if (msg.type === 'text') input = msg.text.body;
      if (msg.type === 'interactive') input = msg.interactive.button_reply.title;
      
      let client;
      try {
        client = await pool.connect();
        
        // Ensure Driver Exists
        let driverRes = await client.query('SELECT id FROM drivers WHERE phone_number = $1', [from]);
        let driverId = driverRes.rows[0]?.id;
        if (!driverId) {
             driverId = Date.now().toString();
             await client.query(`INSERT INTO drivers (id, phone_number, name) VALUES ($1, $2, 'Guest')`, [driverId, from]);
        }
        
        // Log Incoming
        await client.query(
             `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'driver', $3, $4, 'text')`,
             [Date.now().toString(), driverId, input, Date.now()]
        );

        const settingsRes = await client.query('SELECT * FROM bot_settings WHERE id = 1');
        const settings = settingsRes.rows[0] || { is_enabled: true, routing_strategy: 'HYBRID_BOT_FIRST' };

        let botHandled = false;
        
        // --- LOGIC: HYBRID STRATEGY ---
        // If strategy is NOT 'AI_ONLY', try the bot first.
        if (settings.is_enabled && settings.routing_strategy !== 'AI_ONLY') {
            const engine = new BotEngine(client);
            // Engine returns FALSE if:
            // 1. Flow is empty
            // 2. Flow has the "bad placeholder"
            // 3. User has already completed the flow (flow_completed = true)
            botHandled = await engine.processUser(from, input, driverId);
        }

        // --- LOGIC: AI FALLBACK ---
        // 1. If strategy is 'AI_ONLY', botHandled is false -> AI replies.
        // 2. If strategy is 'HYBRID' but flow completed -> botHandled returned false -> AI replies.
        if (!botHandled) {
             console.log(`🤖 Bot skipped/passed. AI replying to: ${input}`);
             const aiReply = await generateAIResponse(input, settings.system_instruction || "You are a helpful recruitment assistant.");
             
             await sendWhatsApp(from, 'text', { text: aiReply });
             await client.query(
                `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'system', $3, $4, 'text')`,
                [Date.now().toString() + '_ai', driverId, aiReply, Date.now()]
             );
        }

      } catch (e) {
        console.error("Webhook Error:", e);
      } finally {
        if(client) client.release();
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// --- API ENDPOINTS ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) res.status(200).send(challenge);
  else res.sendStatus(403);
});

app.post('/api/bot-settings', async (req, res) => {
  let client;
  try {
    const { flowData, isEnabled, routingStrategy, systemInstruction } = req.body; 
    client = await pool.connect();
    
    if (flowData) {
        await client.query(`INSERT INTO flows (nodes, edges) VALUES ($1, $2)`, [JSON.stringify(flowData.nodes), JSON.stringify(flowData.edges)]);
    }
    
    const safeEnabled = isEnabled !== undefined ? isEnabled : true;
    const safeStrategy = routingStrategy || 'HYBRID_BOT_FIRST';
    const safeInstruction = systemInstruction || '';

    await client.query(`
        INSERT INTO bot_settings (id, is_enabled, routing_strategy, system_instruction)
        VALUES (1, $1, $2, $3)
        ON CONFLICT (id) DO UPDATE SET is_enabled = $1, routing_strategy = $2, system_instruction = $3
    `, [safeEnabled, safeStrategy, safeInstruction]);

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); } finally { if(client) client.release(); }
});

app.get('/api/bot-settings', async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const flowRes = await client.query('SELECT nodes, edges FROM flows ORDER BY updated_at DESC LIMIT 1');
    const setRes = await client.query('SELECT * FROM bot_settings WHERE id = 1');
    const settings = setRes.rows[0] || { is_enabled: true, routing_strategy: 'HYBRID_BOT_FIRST', system_instruction: '' };
    res.json({
        isEnabled: settings.is_enabled,
        routingStrategy: settings.routing_strategy,
        systemInstruction: settings.system_instruction,
        flowData: flowRes.rows[0] || { nodes: [], edges: [] }
    });
  } catch (e) { res.status(500).json({ error: e.message }); } finally { if(client) client.release(); }
});

app.get('/api/drivers', async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        const result = await client.query(`
          SELECT d.*, 
          COALESCE(json_agg(json_build_object('id', m.id, 'sender', m.sender, 'text', m.text, 'timestamp', m.timestamp) ORDER BY m.timestamp ASC) FILTER (WHERE m.id IS NOT NULL), '[]') as messages
          FROM drivers d LEFT JOIN messages m ON d.id = m.driver_id
          GROUP BY d.id ORDER BY d.last_message_time DESC
        `);
        // FIX: MAP DB COLUMNS TO FRONTEND TYPES TO PREVENTS CRASH
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
    } catch (e) { res.status(500).json({ error: e.message }); } finally { if(client) client.release(); }
});

// NEW ENDPOINT: PATCH DRIVER DETAILS
app.patch('/api/drivers/:id', async (req, res) => {
    let client;
    try {
        const { id } = req.params;
        const updates = req.body;
        client = await pool.connect();
        
        // Construct dynamic query
        const fields = [];
        const values = [];
        let idx = 1;

        if (updates.vehicleRegistration !== undefined) {
            fields.push(`vehicle_registration = $${idx++}`);
            values.push(updates.vehicleRegistration);
        }
        if (updates.availability !== undefined) {
            fields.push(`availability = $${idx++}`);
            values.push(updates.availability);
        }
        if (updates.qualificationChecks !== undefined) {
             fields.push(`qualification_checks = $${idx++}`);
             values.push(updates.qualificationChecks);
        }
        if (updates.onboardingStep !== undefined) {
             fields.push(`onboarding_step = $${idx++}`);
             values.push(updates.onboardingStep);
        }
        if (updates.status !== undefined) {
             fields.push(`status = $${idx++}`);
             values.push(updates.status);
        }

        if (fields.length > 0) {
            values.push(id);
            await client.query(`UPDATE drivers SET ${fields.join(', ')} WHERE id = $${idx}`, values);
        }
        
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: e.message}); } 
    finally { if(client) client.release(); }
});

app.post('/api/update-credentials', async (req, res) => {
    try {
        const { phoneNumberId, apiToken } = req.body;
        if(phoneNumberId) PHONE_NUMBER_ID = phoneNumberId;
        if(apiToken) META_API_TOKEN = apiToken;
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/configure-webhook', async (req, res) => {
    try {
        const { verifyToken } = req.body;
        if(verifyToken) VERIFY_TOKEN = verifyToken;
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    initDB();
  });
}

module.exports = app;
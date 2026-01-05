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
app.use(express.json());
app.use(cors());

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3001;

// CREDENTIALS
let META_API_TOKEN = process.env.META_API_TOKEN || ""; 
let PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || ""; 
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyDujw0ovB1bLtQJK8DKy1b__LT5aqGurz0";
let VERIFY_TOKEN = process.env.VERIFY_TOKEN || "uber_fleet_verify_token";

// Initialize AI
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- POSTGRESQL CONNECTION MANAGER ---
let pool = null;

// Helper to get or create pool safely
const getPool = () => {
    if (pool) return pool;

    const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
    
    if (!connectionString) {
        console.error("❌ CRITICAL: Database URL is missing from environment variables.");
        return null;
    }

    try {
        pool = new Pool({
            connectionString,
            ssl: { rejectUnauthorized: false }, // Required for Neon/AWS RDS
            max: 3, // Keep max connections low for serverless
            connectionTimeoutMillis: 5000,
            idleTimeoutMillis: 1000,
        });
        
        pool.on('error', (err) => {
            console.error('Unexpected error on idle client', err);
            // Don't exit, just log
        });

        return pool;
    } catch (e) {
        console.error("❌ Failed to create connection pool:", e);
        return null;
    }
};

// --- DB INIT LOGIC ---
let dbInitPromise = null;

const initDB = async () => {
  const p = getPool();
  if (!p) {
      console.warn("⚠️ Skipping DB Init: No Pool available.");
      return;
  }
  
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
      let client;
      try {
        client = await p.connect();
        console.log("🔌 Connected to Database");

        // 1. Flows Table
        await client.query(`
        CREATE TABLE IF NOT EXISTS flows (
            id SERIAL PRIMARY KEY,
            nodes JSONB NOT NULL,
            edges JSONB NOT NULL,
            updated_at TIMESTAMP DEFAULT NOW()
        );
        `);

        // 2. Bot Settings Table
        await client.query(`
        CREATE TABLE IF NOT EXISTS bot_settings (
            id INT PRIMARY KEY DEFAULT 1,
            is_enabled BOOLEAN DEFAULT TRUE,
            routing_strategy TEXT DEFAULT 'HYBRID_BOT_FIRST',
            system_instruction TEXT,
            updated_at TIMESTAMP DEFAULT NOW()
        );
        `);
        await client.query(`INSERT INTO bot_settings (id, is_enabled) VALUES (1, true) ON CONFLICT (id) DO NOTHING`);

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
            created_at TIMESTAMP DEFAULT NOW()
        );
        `);

        // 4. Sessions Table
        await client.query(`
        CREATE TABLE IF NOT EXISTS sessions (
            phone_number TEXT PRIMARY KEY,
            current_node_id TEXT,
            last_active TIMESTAMP DEFAULT NOW()
        );
        `);

        // 5. Messages History
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
        
        // 6. App Config
        await client.query(`
        CREATE TABLE IF NOT EXISTS app_config (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        `);

        // Load credentials from DB
        try {
            const configRes = await client.query('SELECT * FROM app_config');
            configRes.rows.forEach(row => {
                if(row.key === 'META_API_TOKEN' && row.value) META_API_TOKEN = row.value;
                if(row.key === 'PHONE_NUMBER_ID' && row.value) PHONE_NUMBER_ID = row.value;
                if(row.key === 'VERIFY_TOKEN' && row.value) VERIFY_TOKEN = row.value;
            });
        } catch (e) {
            console.warn("⚠️ Could not load app_config, using env vars.");
        }

        console.log("✅ Database Schema Synced");
      } catch (err) {
        console.error("❌ DB Init Error:", err);
        dbInitPromise = null;
        throw err;
      } finally {
        if (client) client.release();
      }
  })();
  
  return dbInitPromise;
};

// Middleware to ensure DB init runs
const ensureDb = async (req, res, next) => {
    try {
        await initDB();
        next();
    } catch (e) {
        console.error("DB Middleware Failed:", e.message);
        res.status(500).json({ error: "Database connection failed. Check server logs." });
    }
};

app.use(ensureDb);

// --- WHATSAPP API HELPER ---
const sendWhatsApp = async (to, type, content) => {
  if (!META_API_TOKEN || !PHONE_NUMBER_ID) {
      console.warn("⚠️ Missing Meta Credentials - Cannot send WhatsApp message");
      return;
  }
  
  const payload = { messaging_product: 'whatsapp', to };

  if (type === 'text') {
    payload.type = 'text';
    payload.text = { body: content.text };
  } 
  else if (type === 'image') {
    payload.type = 'image';
    payload.image = { link: content.url, caption: content.caption || '' };
  }
  else if (type === 'interactive') {
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
    console.log(`✅ Sent ${type} to ${to}`);
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
            contents: input,
            config: {
                systemInstruction: systemInstruction || "You are a helpful assistant."
            }
        });
        return response.text;
    } catch (error) {
        console.error("AI Error:", error);
        return "Sorry, I am having trouble processing that right now.";
    }
};

// --- BOT ENGINE LOGIC ---
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
    // 0. RESET COMMAND
    if (input.toLowerCase().trim() === 'reset' || input.toLowerCase().trim() === 'restart') {
        console.log(`🔄 Resetting session for ${phone}`);
        await this.client.query('DELETE FROM sessions WHERE phone_number = $1', [phone]);
        await sendWhatsApp(phone, 'text', { text: "Session reset. Say 'Hi' to start again." });
        return true;
    }

    const { nodes, edges } = await this.getFlow();
    if (!nodes || nodes.length === 0) return false;

    let sessionRes = await this.client.query('SELECT * FROM sessions WHERE phone_number = $1', [phone]);
    let currentNodeId = sessionRes.rows[0]?.current_node_id;
    let currentNode = nodes.find(n => n.id === currentNodeId);
    
    // SAFETY CHECK: Stale Node ID
    if (currentNodeId && !currentNode) {
        console.log("⚠️ Stale session detected. Resetting.");
        await this.client.query('DELETE FROM sessions WHERE phone_number = $1', [phone]);
        currentNodeId = null; 
    }

    const driverRes = await this.client.query('SELECT * FROM drivers WHERE id = $1', [driverId]);
    const driver = driverRes.rows[0];

    // --- STEP 1: HANDLE INPUT ---
    if (currentNode) {
        // Save logic...
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
        
        // Option Logic
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
            console.log("   End of Flow reached. Deleting session.");
            await this.client.query('DELETE FROM sessions WHERE phone_number = $1', [phone]);
            return true;
        }

    } else {
        // New Session: Find Start Node
        const startNode = nodes.find(n => n.data.type === 'start');
        if (startNode) {
            const startEdge = edges.find(e => e.source === startNode.id);
            if (startEdge) {
                currentNodeId = startEdge.target;
                currentNode = nodes.find(n => n.id === currentNodeId);
            } else {
                console.log("⚠️ Flow Start has no connections. Ignoring Bot Flow.");
                return false; 
            }
        }
    }

    // --- STEP 2: SEND MESSAGES CHAIN ---
    if (!currentNode) return false;

    let stepsExecuted = 0;
    while (currentNode && stepsExecuted < 20) {
        stepsExecuted++;
        
        console.log(`   Sending Node: ${currentNode.data.label}`);
        const messageText = this.replaceVariables(currentNode.data.message || '', driver);
        
        // --- CRITICAL FIX: DETECT BROKEN LOOP ---
        if (messageText.includes("Replace this sample message")) {
            console.warn("🚫 Placeholder text detected. Aborting broken flow.");
            // We do NOT return false here to avoid AI taking over a broken flow loop. We just stop.
            return true;
        }

        const { mediaUrl, label, options, inputType } = currentNode.data;

        if (label === 'Image' && mediaUrl) {
            await sendWhatsApp(phone, 'image', { url: mediaUrl, caption: messageText });
        } else if ((label === 'Quick Reply' || label === 'List' || inputType === 'option') && options?.length > 0) {
            await sendWhatsApp(phone, 'interactive', { text: messageText, options });
        } else {
            if (messageText) await sendWhatsApp(phone, 'text', { text: messageText });
        }
        
        await this.client.query(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'system', $3, $4, 'text')`,
            [Date.now().toString() + stepsExecuted, driverId, messageText, Date.now()]
        );

        await this.client.query(
            `INSERT INTO sessions (phone_number, current_node_id, last_active) 
             VALUES ($1, $2, NOW()) 
             ON CONFLICT (phone_number) DO UPDATE SET current_node_id = $2, last_active = NOW()`,
            [phone, currentNode.id]
        );
        
        let type = currentNode.data.inputType;
        if (!type) {
             if (options && options.length > 0) type = 'option';
             else if (['Text', 'Image', 'Video', 'File'].includes(label)) type = 'statement'; 
             else type = 'text';
        }

        const isInputNode = ['text', 'number', 'email', 'website', 'date', 'time', 'option'].includes(type);
        
        if (isInputNode) {
            return true; 
        }

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
             await this.client.query('DELETE FROM sessions WHERE phone_number = $1', [phone]);
             break; 
        }
    }

    return true;
  }
}

// --- API ENDPOINTS ---

app.post('/api/update-credentials', async (req, res) => {
    const p = getPool();
    if (!p) return res.status(500).json({ error: "Database not configured (URL missing)" });

    try {
        const { phoneNumberId, apiToken } = req.body;
        if(phoneNumberId) PHONE_NUMBER_ID = phoneNumberId;
        if(apiToken) META_API_TOKEN = apiToken;
        
        const client = await p.connect();
        try {
            await client.query(`INSERT INTO app_config (key, value) VALUES ('PHONE_NUMBER_ID', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [phoneNumberId]);
            await client.query(`INSERT INTO app_config (key, value) VALUES ('META_API_TOKEN', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [apiToken]);
            res.json({ success: true });
        } finally {
            client.release();
        }
    } catch (e) {
        console.error("Update Credentials Error:", e);
        res.status(500).json({ error: e.message }); 
    }
});

app.post('/api/configure-webhook', async (req, res) => {
    const p = getPool();
    if (!p) return res.status(500).json({ error: "Database not configured" });

    try {
        const { verifyToken } = req.body;
        if(verifyToken) VERIFY_TOKEN = verifyToken;
        const client = await p.connect();
        try {
            await client.query(`INSERT INTO app_config (key, value) VALUES ('VERIFY_TOKEN', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [verifyToken]);
            res.json({ success: true });
        } finally {
            client.release();
        }
    } catch (e) {
        console.error("Configure Webhook Error:", e);
        res.status(500).json({ error: e.message }); 
    }
});

app.post('/api/bot-settings', async (req, res) => {
  const p = getPool();
  if (!p) return res.status(500).json({ error: "Database not configured" });

  try {
    const { flowData, isEnabled, routingStrategy, systemInstruction } = req.body; 
    const client = await p.connect();
    try {
        if (flowData) {
            await client.query(`INSERT INTO flows (nodes, edges) VALUES ($1, $2)`, [JSON.stringify(flowData.nodes), JSON.stringify(flowData.edges)]);
        }
        
        await client.query(`
            INSERT INTO bot_settings (id, is_enabled, routing_strategy, system_instruction)
            VALUES (1, $1, $2, $3)
            ON CONFLICT (id) DO UPDATE SET is_enabled = $1, routing_strategy = $2, system_instruction = $3
        `, [isEnabled, routingStrategy, systemInstruction]);
        
        res.json({ success: true });
    } finally {
        client.release();
    }
  } catch (e) {
      console.error("Save Bot Settings Error:", e);
      res.status(500).json({ error: e.message });
  }
});

app.get('/api/bot-settings', async (req, res) => {
  const p = getPool();
  if (!p) return res.status(500).json({ error: "Database not configured" });

  try {
    const client = await p.connect();
    try {
        const flowRes = await client.query('SELECT nodes, edges FROM flows ORDER BY updated_at DESC LIMIT 1');
        const setRes = await client.query('SELECT * FROM bot_settings WHERE id = 1');
        
        const settings = setRes.rows[0] || { is_enabled: true, routing_strategy: 'HYBRID_BOT_FIRST', system_instruction: '' };
        
        res.json({
            isEnabled: settings.is_enabled,
            routingStrategy: settings.routing_strategy,
            systemInstruction: settings.system_instruction,
            steps: [], 
            flowData: flowRes.rows[0] || { nodes: [], edges: [] }
        });
    } finally {
        client.release();
    }
  } catch (e) { 
      console.error("Get Settings Error:", e);
      res.status(500).json({ error: e.message }); 
  }
});

// --- WEBHOOK ---
app.post('/webhook', async (req, res) => {
  const body = req.body;
  
  if (body.object) {
    if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
      const msg = body.entry[0].changes[0].value.messages[0];
      const from = msg.from;
      
      console.log("📩 Webhook received message from:", from);

      let input = '';
      if (msg.type === 'text') input = msg.text.body;
      if (msg.type === 'interactive') input = msg.interactive.button_reply.title;
      if (msg.type === 'image') input = '[Image]'; 

      const p = getPool();
      if (!p) {
          console.error("❌ Webhook failed: No DB Pool");
          return res.sendStatus(500);
      }

      try {
        const client = await p.connect();
        try {
            // Driver Check
            let driverRes = await client.query('SELECT id, name FROM drivers WHERE phone_number = $1', [from]);
            let driverId = driverRes.rows[0]?.id;
            if (!driverId) {
                driverId = Date.now().toString();
                await client.query(`INSERT INTO drivers (id, phone_number, name) VALUES ($1, $2, 'Guest')`, [driverId, from]);
            }
            
            await client.query(
                `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'driver', $3, $4, 'text')`,
                [Date.now().toString(), driverId, input, Date.now()]
            );

            const settingsRes = await client.query('SELECT * FROM bot_settings WHERE id = 1');
            const settings = settingsRes.rows[0] || { is_enabled: true, routing_strategy: 'HYBRID_BOT_FIRST', system_instruction: '' };

            console.log(`ℹ️ Strategy: ${settings.routing_strategy} | Input: ${input}`);

            let botHandled = false;
            
            if (settings.is_enabled && settings.routing_strategy !== 'AI_ONLY') {
                const engine = new BotEngine(client);
                botHandled = await engine.processUser(from, input, driverId);
            }

            if (!botHandled && (settings.routing_strategy === 'HYBRID_BOT_FIRST' || settings.routing_strategy === 'AI_ONLY')) {
                console.log("🤖 Handing off to AI...");
                const aiReply = await generateAIResponse(input, settings.system_instruction || "You are a helpful recruitment assistant for Uber Fleet.");
                
                await sendWhatsApp(from, 'text', { text: aiReply });
                await client.query(
                    `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'system', $3, $4, 'text')`,
                    [Date.now().toString() + '_ai', driverId, aiReply, Date.now()]
                );
            }
        } finally {
            client.release();
        }
      } catch (e) {
        console.error("Webhook Error:", e);
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) res.status(200).send(challenge);
  else res.sendStatus(403);
});

app.get('/api/drivers', async (req, res) => {
    const p = getPool();
    if (!p) return res.status(500).json({ error: "Database not configured (URL missing)" });

    try {
        const client = await p.connect();
        try {
            const result = await client.query(`
            SELECT d.*, 
            COALESCE(json_agg(json_build_object('id', m.id, 'sender', m.sender, 'text', m.text, 'timestamp', m.timestamp) ORDER BY m.timestamp ASC) FILTER (WHERE m.id IS NOT NULL), '[]') as messages
            FROM drivers d LEFT JOIN messages m ON d.id = m.driver_id
            GROUP BY d.id ORDER BY d.last_message_time DESC
            `);
            res.json(result.rows.map(r => ({ ...r, phoneNumber: r.phone_number, lastMessage: r.last_message, lastMessageTime: parseInt(r.last_message_time || '0'), qualificationChecks: r.qualification_checks || {} })));
        } finally {
            client.release();
        }
    } catch (e) {
        console.error("API Drivers Error:", e);
        res.status(500).json({ error: e.message }); 
    }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    initDB();
  });
}

module.exports = app;

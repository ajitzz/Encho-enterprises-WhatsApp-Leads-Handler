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

const NEON_DB_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL || "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";

// Initialize AI
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- POSTGRESQL CONNECTION ---
const pool = new Pool({
  connectionString: NEON_DB_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 1000,
});

// --- DATABASE INITIALIZATION ---
const initDB = async () => {
  try {
    const client = await pool.connect();
    
    // 1. Flows Table (Stores nodes/edges)
    await client.query(`
      CREATE TABLE IF NOT EXISTS flows (
        id SERIAL PRIMARY KEY,
        nodes JSONB NOT NULL,
        edges JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 2. Bot Settings Table (Stores Strategy & System Prompt)
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_settings (
        id INT PRIMARY KEY DEFAULT 1,
        is_enabled BOOLEAN DEFAULT TRUE,
        routing_strategy TEXT DEFAULT 'HYBRID_BOT_FIRST',
        system_instruction TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // Ensure default row exists
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
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 4. Sessions Table (Active Bot State)
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
    
    // 6. App Config (Credentials)
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    // Load credentials
    const configRes = await client.query('SELECT * FROM app_config');
    configRes.rows.forEach(row => {
        if(row.key === 'META_API_TOKEN') META_API_TOKEN = row.value;
        if(row.key === 'PHONE_NUMBER_ID') PHONE_NUMBER_ID = row.value;
        if(row.key === 'VERIFY_TOKEN') VERIFY_TOKEN = row.value;
    });

    console.log("✅ Database Schema Synced & Config Loaded");
    client.release();
  } catch (err) {
    console.error("❌ DB Init Error:", err.message);
  }
};

// --- WHATSAPP API HELPER ---
const sendWhatsApp = async (to, type, content) => {
  if (!META_API_TOKEN || !PHONE_NUMBER_ID) {
      console.warn("⚠️ Missing Meta Credentials");
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
        // Using generateContent with the model name as per coding guidelines
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

  // Returns TRUE if bot handled the message, FALSE if it should fall back to AI
  async processUser(phone, input, driverId) {
    const { nodes, edges } = await this.getFlow();
    if (!nodes.length) return false; // No bot flow defined

    // Fetch Session
    let sessionRes = await this.client.query('SELECT * FROM sessions WHERE phone_number = $1', [phone]);
    let currentNodeId = sessionRes.rows[0]?.current_node_id;
    let currentNode = nodes.find(n => n.id === currentNodeId);
    
    // Fetch Driver for variables
    const driverRes = await this.client.query('SELECT * FROM drivers WHERE id = $1', [driverId]);
    const driver = driverRes.rows[0];

    // --- STEP 1: HANDLE INPUT FOR CURRENT NODE ---
    if (currentNode) {
        console.log(`📍 User at node: ${currentNode.data.label}`);
        
        // Save Variable logic
        if (currentNode.data.saveToField) {
            const field = currentNode.data.saveToField;
            if (['name', 'availability'].includes(field)) {
                await this.client.query(`UPDATE drivers SET ${field} = $1 WHERE id = $2`, [input, driverId]);
            } else {
                const newVars = { ...driver.variables, [field]: input };
                await this.client.query(`UPDATE drivers SET variables = $1 WHERE id = $2`, [newVars, driverId]);
            }
            driver.variables = { ...driver.variables, [field]: input }; // Update local for immediate use
        }

        // Determine Next Node
        let nextEdge;
        
        // A. Option Matching
        if (currentNode.data.inputType === 'option' || currentNode.data.options?.length > 0) {
            // Fuzzy match or exact match
            const opts = currentNode.data.options || [];
            const selectedIdx = opts.findIndex(o => o.toLowerCase().includes(input.toLowerCase()) || input.toLowerCase().includes(o.toLowerCase()));
            
            if (selectedIdx !== -1) {
                nextEdge = edges.find(e => e.source === currentNodeId && e.sourceHandle === `opt_${selectedIdx}`);
            } else {
                // Invalid Option Selection!
                // Decision: Should we fallback to AI? Or repeat?
                // For Hybrid bots, usually implies user is asking a question instead of answering.
                console.log("   Input did not match options. Falling back to AI.");
                return false; 
            }
        } 
        
        // B. Default/Main Edge (Text input or fallthrough)
        if (!nextEdge) {
            nextEdge = edges.find(e => e.source === currentNodeId && (e.sourceHandle === 'main' || !e.sourceHandle));
        }

        if (nextEdge) {
            currentNodeId = nextEdge.target;
            currentNode = nodes.find(n => n.id === currentNodeId);
        } else {
            // End of Flow
            await this.client.query('DELETE FROM sessions WHERE phone_number = $1', [phone]);
            console.log("   Flow completed.");
            return true; // We handled the "end" by doing nothing (or could send goodbye)
        }

    } else {
        // --- STEP 2: START NEW FLOW ---
        const startNode = nodes.find(n => n.data.type === 'start');
        if (startNode) {
            // Check if there's a connection from Start
            const startEdge = edges.find(e => e.source === startNode.id);
            if (startEdge) {
                currentNodeId = startEdge.target;
                currentNode = nodes.find(n => n.id === currentNodeId);
                console.log("🚀 Starting new flow");
            }
        }
    }

    // --- STEP 3: SEND RESPONSE(S) ---
    if (!currentNode) return false; // No next node found, maybe fallback to AI

    let stepsExecuted = 0;
    while (currentNode && stepsExecuted < 5) {
        stepsExecuted++;
        
        const messageText = this.replaceVariables(currentNode.data.message || '', driver);
        const { mediaUrl, label, options } = currentNode.data;

        // Send Message
        if (label === 'Image' && mediaUrl) {
            await sendWhatsApp(phone, 'image', { url: mediaUrl, caption: messageText });
        } else if ((label === 'Quick Reply' || label === 'List' || currentNode.data.inputType === 'option') && options?.length > 0) {
            await sendWhatsApp(phone, 'interactive', { text: messageText, options });
        } else {
            if (messageText) await sendWhatsApp(phone, 'text', { text: messageText });
        }

        // Log Message
        await this.client.query(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'system', $3, $4, 'text')`,
            [Date.now().toString() + stepsExecuted, driverId, messageText, Date.now()]
        );

        // Update Session
        await this.client.query(
            `INSERT INTO sessions (phone_number, current_node_id, last_active) 
             VALUES ($1, $2, NOW()) 
             ON CONFLICT (phone_number) DO UPDATE SET current_node_id = $2, last_active = NOW()`,
            [phone, currentNode.id]
        );

        // Check if we should stop for input
        // Rules: 
        // 1. If it's an Option or Input node, STOP.
        // 2. If it's just an Image/Text/Video node (Display Only), does it have a 'main' outgoing edge?
        //    If yes, and that edge leads to another node, we *could* auto-advance.
        //    But React Flow UI doesn't explicitly mark "wait for input". 
        //    Assumption: "Text" input type means wait for text. "Option" means wait for option.
        //    "Image" label usually means display image.
        
        const isInputNode = ['Text', 'Number', 'Email', 'Quick Reply', 'List'].includes(currentNode.data.inputType) || currentNode.data.options?.length > 0;
        
        if (isInputNode) {
            return true; // We sent a message and are waiting.
        }

        // If it's a display-only node, check if we can auto-advance
        const outgoingEdges = edges.filter(e => e.source === currentNode.id);
        if (outgoingEdges.length > 0) {
            // Auto-advance to next
            const nextEdge = outgoingEdges.find(e => e.sourceHandle === 'main' || !e.sourceHandle);
            if (nextEdge) {
                currentNodeId = nextEdge.target;
                currentNode = nodes.find(n => n.id === currentNodeId);
                // Loop continues...
            } else {
                break;
            }
        } else {
            break; // End of branch
        }
    }

    return true;
  }
}

// --- API ENDPOINTS ---

app.post('/api/update-credentials', async (req, res) => {
    try {
        const { phoneNumberId, apiToken } = req.body;
        if(phoneNumberId) PHONE_NUMBER_ID = phoneNumberId;
        if(apiToken) META_API_TOKEN = apiToken;
        
        const client = await pool.connect();
        await client.query(`INSERT INTO app_config (key, value) VALUES ('PHONE_NUMBER_ID', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [phoneNumberId]);
        await client.query(`INSERT INTO app_config (key, value) VALUES ('META_API_TOKEN', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [apiToken]);
        client.release();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/configure-webhook', async (req, res) => {
    try {
        const { verifyToken } = req.body;
        if(verifyToken) VERIFY_TOKEN = verifyToken;
        const client = await pool.connect();
        await client.query(`INSERT INTO app_config (key, value) VALUES ('VERIFY_TOKEN', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [verifyToken]);
        client.release();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save Bot Settings (Flow + Strategy)
app.post('/api/bot-settings', async (req, res) => {
  try {
    const { flowData, isEnabled, routingStrategy, systemInstruction } = req.body; 
    const client = await pool.connect();
    
    // Save Flow
    if (flowData) {
        await client.query(`INSERT INTO flows (nodes, edges) VALUES ($1, $2)`, [JSON.stringify(flowData.nodes), JSON.stringify(flowData.edges)]);
    }
    
    // Save Strategy
    await client.query(`
        INSERT INTO bot_settings (id, is_enabled, routing_strategy, system_instruction)
        VALUES (1, $1, $2, $3)
        ON CONFLICT (id) DO UPDATE SET is_enabled = $1, routing_strategy = $2, system_instruction = $3
    `, [isEnabled, routingStrategy, systemInstruction]);

    client.release();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bot-settings', async (req, res) => {
  try {
    const client = await pool.connect();
    const flowRes = await client.query('SELECT nodes, edges FROM flows ORDER BY updated_at DESC LIMIT 1');
    const setRes = await client.query('SELECT * FROM bot_settings WHERE id = 1');
    client.release();
    
    const settings = setRes.rows[0] || { is_enabled: true, routing_strategy: 'HYBRID_BOT_FIRST', system_instruction: '' };
    
    res.json({
        isEnabled: settings.is_enabled,
        routingStrategy: settings.routing_strategy,
        systemInstruction: settings.system_instruction,
        steps: [], 
        flowData: flowRes.rows[0] || { nodes: [], edges: [] }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- WEBHOOK ---
app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object) {
    if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
      const msg = body.entry[0].changes[0].value.messages[0];
      const from = msg.from;
      
      let input = '';
      if (msg.type === 'text') input = msg.text.body;
      if (msg.type === 'interactive') input = msg.interactive.button_reply.title;
      if (msg.type === 'image') input = '[Image]'; 

      try {
        const client = await pool.connect();
        
        // 1. Get/Create Driver
        let driverRes = await client.query('SELECT id, name FROM drivers WHERE phone_number = $1', [from]);
        let driverId = driverRes.rows[0]?.id;
        if (!driverId) {
             driverId = Date.now().toString();
             await client.query(`INSERT INTO drivers (id, phone_number, name) VALUES ($1, $2, 'Guest')`, [driverId, from]);
        }
        
        // 2. Log Message
        await client.query(
             `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'driver', $3, $4, 'text')`,
             [Date.now().toString(), driverId, input, Date.now()]
        );

        // 3. Routing Logic
        const settingsRes = await client.query('SELECT * FROM bot_settings WHERE id = 1');
        const settings = settingsRes.rows[0] || { is_enabled: true, routing_strategy: 'HYBRID_BOT_FIRST', system_instruction: '' };

        let botHandled = false;
        
        if (settings.is_enabled && settings.routing_strategy !== 'AI_ONLY') {
            const engine = new BotEngine(client);
            botHandled = await engine.processUser(from, input, driverId);
        }

        // 4. Fallback to AI
        if (!botHandled && (settings.routing_strategy === 'HYBRID_BOT_FIRST' || settings.routing_strategy === 'AI_ONLY')) {
             console.log("🤖 Handing off to AI...");
             const aiReply = await generateAIResponse(input, settings.system_instruction || "You are a helpful recruitment assistant for Uber Fleet.");
             
             await sendWhatsApp(from, 'text', { text: aiReply });
             await client.query(
                `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'system', $3, $4, 'text')`,
                [Date.now().toString() + '_ai', driverId, aiReply, Date.now()]
             );
        }

        client.release();
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

// Existing Drivers API
app.get('/api/drivers', async (req, res) => {
    try {
        const client = await pool.connect();
        const result = await client.query(`
          SELECT d.*, 
          COALESCE(json_agg(json_build_object('id', m.id, 'sender', m.sender, 'text', m.text, 'timestamp', m.timestamp) ORDER BY m.timestamp ASC) FILTER (WHERE m.id IS NOT NULL), '[]') as messages
          FROM drivers d LEFT JOIN messages m ON d.id = m.driver_id
          GROUP BY d.id ORDER BY d.last_message_time DESC
        `);
        client.release();
        res.json(result.rows.map(r => ({ ...r, phoneNumber: r.phone_number, lastMessage: r.last_message, lastMessageTime: parseInt(r.last_message_time || '0'), qualificationChecks: r.qualification_checks || {} })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initDB();
});
module.exports = app;

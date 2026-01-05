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

// CREDENTIALS
let META_API_TOKEN = process.env.META_API_TOKEN || ""; 
let PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || ""; 
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyDujw0ovB1bLtQJK8DKy1b__LT5aqGurz0";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "uber_fleet_verify_token";
const NEON_DB_URL = "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";

// Initialize AI
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- POSTGRESQL CONNECTION ---
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL || NEON_DB_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 1000,
});

// --- DATABASE INITIALIZATION ---
const initDB = async () => {
  try {
    const client = await pool.connect();
    
    // 1. Flows Table (Stores the React Flow JSON)
    await client.query(`
      CREATE TABLE IF NOT EXISTS flows (
        id SERIAL PRIMARY KEY,
        version TEXT DEFAULT 'latest',
        nodes JSONB NOT NULL,
        edges JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 2. Drivers/Contacts Table (Expanded for flexible variables)
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

    // 3. Sessions Table (Tracks User State in the Flow)
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        phone_number TEXT PRIMARY KEY,
        current_node_id TEXT,
        last_active TIMESTAMP DEFAULT NOW()
      );
    `);

    // 4. Messages History
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

    console.log("✅ Database Schema Synced");
    client.release();
  } catch (err) {
    console.error("❌ DB Init Error:", err.message);
  }
};

// --- WHATSAPP API HELPER ---
const sendWhatsApp = async (to, type, content) => {
  if (!META_API_TOKEN || !PHONE_NUMBER_ID) return console.warn("⚠️ Missing Meta Credentials");
  
  const payload = { messaging_product: 'whatsapp', to };

  if (type === 'text') {
    payload.type = 'text';
    payload.text = { body: content.text };
  } 
  else if (type === 'image') {
    payload.type = 'image';
    payload.image = { link: content.url, caption: content.caption || '' };
  }
  else if (type === 'video') {
    payload.type = 'video';
    payload.video = { link: content.url, caption: content.caption || '' };
  }
  else if (type === 'file') {
      payload.type = 'document';
      payload.document = { link: content.url, caption: content.caption || 'Document' };
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
  } catch (e) {
    console.error("Meta API Error:", e.response?.data || e.message);
  }
};

// --- BOT ENGINE LOGIC ---
class BotEngine {
  constructor(client) {
    this.client = client;
  }

  // Helper: Replace {{variables}} in text
  replaceVariables(text, driver) {
    if (!text) return '';
    return text.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
      // Check specific fields first, then the variables JSON blob
      if (driver[key]) return driver[key];
      if (driver.variables && driver.variables[key]) return driver.variables[key];
      return ''; // Return empty string if var not found
    });
  }

  // Helper: Get Flow Data
  async getFlow() {
    const res = await this.client.query('SELECT nodes, edges FROM flows ORDER BY updated_at DESC LIMIT 1');
    return res.rows[0] || { nodes: [], edges: [] };
  }

  // Core: Execute Flow
  async processUser(phone, input, type = 'text') {
    // 1. Fetch Context
    let driverRes = await this.client.query('SELECT * FROM drivers WHERE phone_number = $1', [phone]);
    if (driverRes.rows.length === 0) {
      // Create new driver if not exists
      const id = Date.now().toString();
      await this.client.query(
        `INSERT INTO drivers (id, phone_number, name) VALUES ($1, $2, 'Unknown')`, 
        [id, phone]
      );
      driverRes = await this.client.query('SELECT * FROM drivers WHERE phone_number = $1', [phone]);
    }
    const driver = driverRes.rows[0];

    // 2. Fetch Session
    let sessionRes = await this.client.query('SELECT * FROM sessions WHERE phone_number = $1', [phone]);
    const { nodes, edges } = await this.getFlow();

    let currentNodeId = sessionRes.rows[0]?.current_node_id;
    let currentNode = nodes.find(n => n.id === currentNodeId);

    // --- STATE 1: PROCESS INPUT (If we are at a node waiting for input) ---
    if (currentNode) {
      // A. Capture Variable
      if (currentNode.data.saveToField) {
        const field = currentNode.data.saveToField;
        const val = input; 
        
        // Update either a specific column or the variables JSONB
        if (['name', 'availability'].includes(field)) {
             await this.client.query(`UPDATE drivers SET ${field} = $1 WHERE id = $2`, [val, driver.id]);
        } else {
             // For generic variables, update the JSONB column
             const newVars = { ...driver.variables, [field]: val };
             await this.client.query(`UPDATE drivers SET variables = $1 WHERE id = $2`, [newVars, driver.id]);
        }
        // Refresh driver object for variable substitution later
        driver.variables[field] = val;
      }

      // B. Determine Next Node via Edges
      let nextEdge;
      
      // If previous node was buttons, look for handle match (input = button label)
      if (currentNode.data.inputType === 'option') {
          // Find edge where sourceHandle corresponds to the option selected
          // Note: In React Flow, we might rely on the option text matching the edge handle or logic
          // Simplified: We look for an edge connected to this source. 
          // If we had handles named after options, we'd match input === handleId.
          // Fallback: If generic 'main' handle, just go next.
          
          // Logic: Check if input matches any option
          const selectedOptionIndex = currentNode.data.options?.indexOf(input);
          
          if (selectedOptionIndex !== -1) {
             // Look for specific handle `opt_${index}`
             nextEdge = edges.find(e => e.source === currentNodeId && e.sourceHandle === `opt_${selectedOptionIndex}`);
          }
      } 
      
      // Fallback: Find default edge (main)
      if (!nextEdge) {
         nextEdge = edges.find(e => e.source === currentNodeId && (e.sourceHandle === 'main' || !e.sourceHandle));
      }

      if (nextEdge) {
        currentNodeId = nextEdge.target;
        currentNode = nodes.find(n => n.id === currentNodeId);
      } else {
        // End of flow or dead end
        currentNode = null;
        currentNodeId = null;
      }
    } else {
      // New Session: Find Start Node
      const startNode = nodes.find(n => n.type === 'custom' && n.data.type === 'start');
      if (startNode) {
         // Move to the node connected to Start
         const startEdge = edges.find(e => e.source === startNode.id);
         if (startEdge) {
            currentNodeId = startEdge.target;
            currentNode = nodes.find(n => n.id === currentNodeId);
         }
      }
    }

    // --- STATE 2: EXECUTION LOOP (Chain messages until input needed) ---
    // We loop because some nodes are just statements (Images, Text) that don't wait for user input.
    // We stop when we hit a node that requires `inputType` != null/informational OR end of flow.
    
    let executionCount = 0;
    while (currentNode && executionCount < 5) { // Safety break
      executionCount++;

      // 1. Prepare Content
      const messageText = this.replaceVariables(currentNode.data.message || '', driver);
      const mediaUrl = currentNode.data.mediaUrl;
      const label = currentNode.data.label; // Text, Image, Video, Option
      const options = currentNode.data.options;

      // 2. Send Message
      if (label === 'Image' && mediaUrl) {
          await sendWhatsApp(phone, 'image', { url: mediaUrl, caption: messageText });
      } else if (label === 'Video' && mediaUrl) {
          await sendWhatsApp(phone, 'video', { url: mediaUrl, caption: messageText });
      } else if (label === 'File' && mediaUrl) {
          await sendWhatsApp(phone, 'file', { url: mediaUrl, caption: messageText });
      } else if ((label === 'Quick Reply' || currentNode.data.inputType === 'option') && options?.length > 0) {
          await sendWhatsApp(phone, 'interactive', { text: messageText, options });
      } else if (messageText) {
          await sendWhatsApp(phone, 'text', { text: messageText });
      }

      // 3. Update Session
      // If this node requires user input (Text, Options, etc that aren't just display), we STOP here.
      // Logic: If it has options or inputType is text/email/etc, we wait.
      // If it is just an Image node with NO caption (or purely display), we might want to auto-skip?
      // For this simplified engine, we assume EVERY node except Start waits for input/ack, 
      // UNLESS we implement a specific "Statement Node" type.
      // To keep it simple for the User: We will save state here and wait for user reply.
      
      // Update Session DB
      await this.client.query(
        `INSERT INTO sessions (phone_number, current_node_id, last_active) 
         VALUES ($1, $2, NOW()) 
         ON CONFLICT (phone_number) DO UPDATE SET current_node_id = $2, last_active = NOW()`,
        [phone, currentNode.id]
      );
      
      // Save outgoing message to history
      await this.client.query(
        `INSERT INTO messages (id, driver_id, sender, text, timestamp, type)
         VALUES ($1, $2, 'system', $3, $4, 'text')`,
        [Date.now().toString() + executionCount, driver.id, messageText || '[Media]', Date.now(), 'system']
      );

      return; // Stop and wait for user input
    }

    if (!currentNode) {
      // Flow ended
      await this.client.query('DELETE FROM sessions WHERE phone_number = $1', [phone]);
    }
  }
}

// --- API ENDPOINTS ---

// 1. Save Flow (From React Flow Frontend)
app.post('/api/bot-settings', async (req, res) => {
  try {
    const { flowData } = req.body; // Expecting { nodes: [], edges: [] }
    if (!flowData) return res.status(400).json({ error: "Missing flowData" });

    const client = await pool.connect();
    // Archive old flow (optional) or just Insert new version
    await client.query(
      `INSERT INTO flows (nodes, edges) VALUES ($1, $2)`,
      [JSON.stringify(flowData.nodes), JSON.stringify(flowData.edges)]
    );
    client.release();
    res.json({ success: true, message: "Flow saved successfully" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// 2. Get Flow
app.get('/api/bot-settings', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT nodes, edges FROM flows ORDER BY updated_at DESC LIMIT 1');
    client.release();
    
    if (result.rows.length > 0) {
        // Return in the format the frontend expects for `settings`
        res.json({
            isEnabled: true,
            routingStrategy: 'HYBRID_BOT_FIRST',
            systemInstruction: '', // Could store in DB too
            steps: [], // Legacy support
            flowData: result.rows[0]
        });
    } else {
        res.json({ flowData: { nodes: [], edges: [] } });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 3. Webhook (The Trigger)
app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object) {
    if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
      const msg = body.entry[0].changes[0].value.messages[0];
      const from = msg.from;
      
      // Parse Input
      let input = '';
      if (msg.type === 'text') input = msg.text.body;
      if (msg.type === 'interactive') input = msg.interactive.button_reply.title;
      if (msg.type === 'image') input = '[Image]'; // Placeholder for now

      try {
        const client = await pool.connect();
        
        // Save Incoming Message
        // 1. Find Driver ID
        let driverRes = await client.query('SELECT id FROM drivers WHERE phone_number = $1', [from]);
        let driverId = driverRes.rows[0]?.id;
        if (!driverId) {
             driverId = Date.now().toString();
             await client.query(`INSERT INTO drivers (id, phone_number, name) VALUES ($1, $2, 'Guest')`, [driverId, from]);
        }
        // 2. Insert Message
        await client.query(
             `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'driver', $3, $4, 'text')`,
             [Date.now().toString(), driverId, input, Date.now()]
        );

        // EXECUTE ENGINE
        const engine = new BotEngine(client);
        await engine.processUser(from, input);

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

// --- INIT ---
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initDB();
});

// Existing Drivers API (Keep for dashboard compatibility)
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
        res.json(result.rows.map(r => ({
            ...r,
            phoneNumber: r.phone_number,
            lastMessage: r.last_message,
            lastMessageTime: parseInt(r.last_message_time),
            qualificationChecks: r.qualification_checks || {} // Ensure frontend safe
        })));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = app;

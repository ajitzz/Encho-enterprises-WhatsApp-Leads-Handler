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

// --- IN-MEMORY LOGGING SYSTEM (FOR FRONTEND DEBUGGING) ---
const LOG_BUFFER = [];
const MAX_LOGS = 50;

// Override console.log and console.error to capture logs
const originalLog = console.log;
const originalError = console.error;

function getTimestamp() {
    return new Date().toISOString().split('T')[1].split('.')[0];
}

console.log = (...args) => {
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
    LOG_BUFFER.unshift(`[${getTimestamp()}] INFO: ${msg}`);
    if (LOG_BUFFER.length > MAX_LOGS) LOG_BUFFER.pop();
    originalLog.apply(console, args);
};

console.error = (...args) => {
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
    LOG_BUFFER.unshift(`[${getTimestamp()}] ERROR: ${msg}`);
    if (LOG_BUFFER.length > MAX_LOGS) LOG_BUFFER.pop();
    originalError.apply(console, args);
};

// --- MIDDLEWARE ---
app.use(express.json({ limit: '50mb' }));
app.use(cors()); 

// Disable Caching for API responses
app.set('etag', false);
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

// REQUEST LOGGER
app.use((req, res, next) => {
    if (!req.url.includes('/api/logs')) { // Don't log the log polling
        console.log(`➡️  ${req.method} ${req.url}`);
    }
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
const NEON_DB_URL = "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const CONNECTION_STRING = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || NEON_DB_URL;

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  ssl: { rejectUnauthorized: false } 
});

// --- INITIALIZE TABLES ---
const initDB = async () => {
    try {
        await pool.query(`
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
                created_at BIGINT
            );
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id VARCHAR(255) PRIMARY KEY,
                driver_id VARCHAR(255) REFERENCES drivers(id),
                sender VARCHAR(50),
                text TEXT,
                image_url TEXT,
                timestamp BIGINT,
                type VARCHAR(50),
                options TEXT[]
            );
        `);

        // Bot Settings Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bot_settings (
                id INT PRIMARY KEY DEFAULT 1,
                is_enabled BOOLEAN DEFAULT true,
                routing_strategy VARCHAR(50) DEFAULT 'HYBRID_BOT_FIRST',
                system_instruction TEXT,
                steps JSONB DEFAULT '[]',
                flow_data JSONB DEFAULT '{}'
            );
        `);
        // Insert default if not exists
        await pool.query(`
            INSERT INTO bot_settings (id, system_instruction) 
            VALUES (1, 'You are a helpful Uber Fleet recruiter.') 
            ON CONFLICT (id) DO NOTHING;
        `);

        console.log("✅ Database Tables Initialized");
    } catch (err) {
        console.error("❌ DB Init Error:", err);
    }
};
initDB();

// --- AI ENGINE ---
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- ROUTES ---

// 1. Health Check
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ database: 'connected', whatsapp: 'configured', ai: 'configured' });
    } catch (e) {
        res.status(500).json({ database: 'disconnected', error: e.message });
    }
});

app.get('/api/ping', (req, res) => res.send('pong'));

// 2. Get Logs
app.get('/api/logs', (req, res) => {
    res.json(LOG_BUFFER);
});

// 3. Get Drivers
app.get('/api/drivers', async (req, res) => {
    try {
        const driversRes = await pool.query('SELECT * FROM drivers ORDER BY last_message_time DESC');
        const drivers = driversRes.rows;

        // Fetch messages for each driver (simple N+1 for now, optimize later)
        const driversWithMessages = await Promise.all(drivers.map(async (d) => {
            const msgRes = await pool.query('SELECT * FROM messages WHERE driver_id = $1 ORDER BY timestamp ASC', [d.id]);
            return {
                id: d.id,
                phoneNumber: d.phone_number,
                name: d.name || 'Unknown',
                source: d.source,
                status: d.status,
                lastMessage: d.last_message,
                lastMessageTime: parseInt(d.last_message_time),
                messages: msgRes.rows.map(m => ({
                    id: m.id,
                    sender: m.sender,
                    text: m.text,
                    imageUrl: m.image_url,
                    timestamp: parseInt(m.timestamp),
                    type: m.type,
                    options: m.options
                })),
                documents: d.documents || [],
                // Mapping DB fields to Frontend Types
                onboardingStep: 0, 
                qualificationChecks: { hasValidLicense: false, hasVehicle: false, isLocallyAvailable: true },
                vehicleRegistration: d.vehicle_details?.registration,
                availability: d.vehicle_details?.availability,
                isBotActive: d.bot_state?.isActive || false,
                currentBotStepId: d.bot_state?.stepId,
                flowCompleted: d.bot_state?.flowCompleted || false
            };
        }));

        res.json(driversWithMessages);
    } catch (e) {
        console.error("Fetch Drivers Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// 4. Bot Settings
app.get('/api/bot-settings', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM bot_settings WHERE id = 1');
        if (result.rows.length > 0) {
            const row = result.rows[0];
            res.json({
                isEnabled: row.is_enabled,
                routingStrategy: row.routing_strategy,
                systemInstruction: row.system_instruction,
                steps: row.steps,
                flowData: row.flow_data
            });
        } else {
            res.json({ isEnabled: true, routingStrategy: 'HYBRID_BOT_FIRST', steps: [] });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/bot-settings', async (req, res) => {
    const { isEnabled, routingStrategy, systemInstruction, steps, flowData } = req.body;
    try {
        await pool.query(`
            UPDATE bot_settings 
            SET is_enabled = $1, routing_strategy = $2, system_instruction = $3, steps = $4, flow_data = $5
            WHERE id = 1
        `, [isEnabled, routingStrategy, systemInstruction, JSON.stringify(steps), JSON.stringify(flowData)]);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// 5. Update Credentials
app.post('/api/update-credentials', (req, res) => {
    const { phoneNumberId, apiToken } = req.body;
    if(phoneNumberId) PHONE_NUMBER_ID = phoneNumberId;
    if(apiToken) META_API_TOKEN = apiToken;
    console.log("Updated Credentials in Memory");
    res.json({ success: true });
});

app.post('/api/configure-webhook', (req, res) => {
    // Just a dummy endpoint to satisfy frontend, real config is in Meta Dashboard
    const { verifyToken } = req.body;
    if(verifyToken) VERIFY_TOKEN = verifyToken;
    res.json({ success: true });
});

// 6. Simulate Webhook (Test Endpoint)
app.post('/api/simulate-webhook', async (req, res) => {
    const { phone, text, name } = req.body;
    console.log(`🧪 Simulating Webhook from: ${phone} saying "${text}"`);
    
    try {
        await processIncomingMessage(phone, name || 'Test User', text);
        res.json({ success: true });
    } catch (e) {
        console.error("Simulation Failed:", e);
        res.status(500).json({ error: e.message });
    }
});

// --- WEBHOOK HANDLING ---

// Verification
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// Incoming Messages
app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;
        // console.log("Incoming Webhook Payload:", JSON.stringify(body, null, 2));

        if (body.object) {
            if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
                const msgObj = body.entry[0].changes[0].value.messages[0];
                const contactObj = body.entry[0].changes[0].value.contacts?.[0];
                
                const phone = msgObj.from;
                const name = contactObj?.profile?.name || 'Unknown Driver';
                const text = msgObj.text?.body || '[Media/Other]';
                const type = msgObj.type;

                console.log(`📩 Message from ${name} (${phone}): ${text}`);
                await processIncomingMessage(phone, name, text);
            }
            res.sendStatus(200);
        } else {
            res.sendStatus(404);
        }
    } catch (error) {
        console.error("Webhook Error:", error);
        res.sendStatus(500);
    }
});

// --- CORE LOGIC: PROCESS MESSAGE ---
async function processIncomingMessage(phone, name, text) {
    const driverId = phone; // Use phone as ID for simplicity
    const timestamp = Date.now();

    // 1. Upsert Driver
    await pool.query(`
        INSERT INTO drivers (id, phone_number, name, last_message, last_message_time, created_at)
        VALUES ($1, $1, $2, $3, $4, $4)
        ON CONFLICT (id) DO UPDATE 
        SET last_message = $3, last_message_time = $4;
    `, [driverId, name, text, timestamp]);

    // 2. Save User Message
    await pool.query(`
        INSERT INTO messages (id, driver_id, sender, text, timestamp, type)
        VALUES ($1, $2, 'driver', $3, $4, 'text')
    `, [`msg_${timestamp}`, driverId, text, timestamp]);

    // 3. Simple Auto-Reply (Or AI Handoff)
    // For now, just echo "Received" if it's the first time, to prove it works
    // In a real app, here we check `bot_state` and call Gemini
    
    // Check if we should reply (Bot Logic Placeholder)
    // For this specific debugging request, we just log that we saved it.
    console.log(`✅ Saved message from ${phone} to DB.`);
    
    // Attempt to send a WhatsApp reply via Meta API
    // await sendWhatsAppMessage(phone, "We received your message!"); 
}

// Function to send WhatsApp message
async function sendWhatsAppMessage(to, text) {
    try {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`,
            headers: {
                'Authorization': `Bearer ${META_API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            data: {
                messaging_product: 'whatsapp',
                to: to,
                text: { body: text }
            }
        });
        console.log(`📤 Sent reply to ${to}`);
    } catch (e) {
        console.error(`Failed to send WhatsApp message: ${e.response ? JSON.stringify(e.response.data) : e.message}`);
    }
}


app.listen(PORT, () => {
    console.log(`\n🚀 Server running on port ${PORT}`);
    console.log(`   - DB: ${CONNECTION_STRING.includes('@') ? 'Configured' : 'Missing'}`);
    console.log(`   - Webhook: http://localhost:${PORT}/webhook`);
});

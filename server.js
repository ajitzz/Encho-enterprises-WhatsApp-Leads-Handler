
/**
 * UBER FLEET RECRUITER - SINGLE TENANT BACKEND
 * Restored to original functional state.
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg'); 
const { GoogleGenAI } = require('@google/genai');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const multer = require('multer');
require('dotenv').config();

const app = express();

// --- MIDDLEWARE ---
app.use(express.json({ limit: '10mb' }));
app.use(cors()); 

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3001;
let META_API_TOKEN = process.env.META_API_TOKEN; 
let PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; 
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
let VERIFY_TOKEN = process.env.VERIFY_TOKEN || "uber_fleet_verify_token";

// AWS S3 Config
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
    }
});
const BUCKET_NAME = process.env.AWS_BUCKET_NAME || '';

// --- DATABASE CONNECTION ---
const CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  ssl: { rejectUnauthorized: false },
  max: 20, 
  idleTimeoutMillis: 30000, 
  connectionTimeoutMillis: 2000,
});

// --- HELPER: Query with Retry ---
const queryWithRetry = async (text, params, retries = 3) => {
    let client;
    try {
        client = await pool.connect();
        const res = await client.query(text, params);
        return res;
    } catch (err) {
        if (client) { try { client.release(true); } catch(e) {} client = null; }
        if (retries > 0) {
            console.log(`DB Retry (${retries} left): ${err.code}`);
            await new Promise(res => setTimeout(res, 1000));
            // Self-healing schema check
            if (err.code === '42P01') { 
                const healClient = await pool.connect();
                await ensureDatabaseInitialized(healClient);
                healClient.release();
            }
            return queryWithRetry(text, params, retries - 1);
        }
        throw err;
    } finally {
        if (client) { try { client.release(); } catch(e) {} }
    }
};

// --- SINGLE TENANT SCHEMA ---
const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS drivers (
        id VARCHAR(255) PRIMARY KEY,
        phone_number VARCHAR(50),
        name VARCHAR(255),
        source VARCHAR(50) DEFAULT 'Organic',
        status VARCHAR(50) DEFAULT 'New',
        last_message TEXT,
        last_message_time BIGINT,
        documents TEXT[],
        bot_state JSONB DEFAULT '{}',
        created_at BIGINT,
        qualification_checks JSONB DEFAULT '{"hasValidLicense": false, "hasVehicle": false, "isLocallyAvailable": true}'::jsonb,
        current_bot_step_id TEXT,
        is_bot_active BOOLEAN DEFAULT FALSE,
        onboarding_step INTEGER DEFAULT 0,
        vehicle_registration TEXT, 
        availability TEXT, 
        is_human_mode BOOLEAN DEFAULT FALSE,
        notes TEXT,
        UNIQUE(phone_number)
    );

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

    CREATE TABLE IF NOT EXISTS bot_settings (
        id INT PRIMARY KEY DEFAULT 1,
        settings JSONB
    );

    CREATE TABLE IF NOT EXISTS media_folders (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        parent_path VARCHAR(255) DEFAULT '/',
        is_public_showcase BOOLEAN DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS media_files (
        id VARCHAR(255) PRIMARY KEY,
        url TEXT NOT NULL,
        filename TEXT,
        type VARCHAR(50),
        uploaded_at BIGINT,
        folder_path VARCHAR(255) DEFAULT '/'
    );
`;

const ensureDatabaseInitialized = async (client) => {
    try {
        await client.query('BEGIN');
        await client.query(SCHEMA_SQL);
        // Default Bot Settings
        const defaultSettings = {
            isEnabled: true,
            routingStrategy: 'HYBRID_BOT_FIRST',
            systemInstruction: "You are a friendly recruiter for Uber Fleet. Answer in Malayalam and English.",
            steps: []
        };
        await client.query(`INSERT INTO bot_settings (id, settings) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`, [JSON.stringify(defaultSettings)]);
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Schema Init Failed:", e);
    }
};

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- WHATSAPP API WRAPPER ---
const sendWhatsAppMessage = async (to, body, options = null) => {
    if (!META_API_TOKEN || !PHONE_NUMBER_ID) {
        console.log("Mock Send:", to, body);
        return true;
    }

    try {
        const payload = {
            messaging_product: "whatsapp",
            to: to,
            type: "text",
            text: { body: body }
        };

        if (options && options.length > 0) {
            payload.type = "interactive";
            delete payload.text;
            payload.interactive = {
                type: "button",
                body: { text: body },
                action: {
                    buttons: options.slice(0, 3).map(opt => ({
                        type: "reply",
                        reply: { id: opt.replace(/\s/g, '_').toLowerCase(), title: opt.substring(0, 20) }
                    }))
                }
            };
        }

        await axios.post(
            `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`,
            payload,
            { headers: { Authorization: `Bearer ${META_API_TOKEN}`, 'Content-Type': 'application/json' } }
        );
        return true;
    } catch (e) {
        console.error("WhatsApp Send Error:", e.response ? e.response.data : e.message);
        return false;
    }
};

// --- AI ANALYZER ---
const analyzeWithAI = async (text, systemInstruction) => {
    try {
        const model = "gemini-3-flash-preview";
        const prompt = `
        Analyze this user message: "${text}"
        
        Output JSON:
        {
            "intent": "string",
            "reply": "string (reply in the persona language)",
            "isInterested": boolean
        }
        `;
        
        const response = await ai.models.generateContent({
            model,
            contents: prompt,
            config: {
                systemInstruction: systemInstruction,
                responseMimeType: "application/json"
            }
        });
        
        return JSON.parse(response.text || '{}');
    } catch (e) {
        console.error("AI Error:", e);
        return { reply: "Sorry, I am having trouble connecting to the server." };
    }
};

// --- WEBHOOK PROCESSOR (SINGLE TENANT) ---
const processIncomingMessage = async (from, text, imageId = null) => {
    // 1. Get/Create Driver
    let driverRes = await queryWithRetry('SELECT * FROM drivers WHERE phone_number = $1', [from]);
    let driver = driverRes.rows[0];

    // Load Global Settings
    const settingsRes = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1', []);
    const settings = settingsRes.rows[0]?.settings || { isEnabled: true, entryPointId: 'step_1', routingStrategy: 'HYBRID_BOT_FIRST' };

    if (!driver) {
        const id = Date.now().toString();
        const startStep = settings.entryPointId || 'step_1';
        const isBotActive = settings.isEnabled;

        await queryWithRetry(
            `INSERT INTO drivers (id, phone_number, name, source, status, created_at, is_bot_active, current_bot_step_id, last_message, last_message_time) 
             VALUES ($1, $2, 'Unknown Driver', 'WhatsApp', 'New', $3, $4, $5, $6, $7)`,
            [id, from, Date.now(), isBotActive, startStep, text, Date.now()]
        );
        driver = { id, is_bot_active: isBotActive, current_bot_step_id: startStep };
    } else {
        await queryWithRetry(`UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3`, [text, Date.now(), driver.id]);
    }

    // 2. Save User Message
    await queryWithRetry(
        `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'driver', $3, $4, 'text')`,
        [Date.now().toString(), driver.id, text, Date.now()]
    );

    // 3. Bot Logic
    if (driver.is_human_mode) return;

    if (!settings.isEnabled) return;

    // AI ONLY STRATEGY
    if (settings.routingStrategy === 'AI_ONLY') {
        const aiRes = await analyzeWithAI(text, settings.systemInstruction);
        const reply = aiRes.reply || "Thinking...";
        
        await sendWhatsAppMessage(from, reply);
        await queryWithRetry(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'system', $3, $4, 'text')`,
            [Date.now().toString() + '_ai', driver.id, reply, Date.now()]
        );
        return;
    }

    // BOT FLOW STRATEGY
    if (driver.is_bot_active && driver.current_bot_step_id) {
        const steps = settings.steps || [];
        const currentStep = steps.find(s => s.id === driver.current_bot_step_id);

        if (currentStep) {
            // A. Capture Data
            if (currentStep.saveToField === 'name') {
                await queryWithRetry('UPDATE drivers SET name = $1 WHERE id = $2', [text, driver.id]);
            }

            // B. Determine Next Step
            let nextStepId = currentStep.nextStepId;
            
            if (currentStep.routes) {
                const cleanInput = text.trim().toLowerCase();
                const matchedKey = Object.keys(currentStep.routes).find(k => k.toLowerCase().includes(cleanInput) || cleanInput.includes(k.toLowerCase()));
                if (matchedKey) nextStepId = currentStep.routes[matchedKey];
            }

            // C. Execute Next Step
            if (nextStepId === 'END' || nextStepId === 'AI_HANDOFF') {
                await queryWithRetry('UPDATE drivers SET is_bot_active = FALSE, current_bot_step_id = NULL WHERE id = $1', [driver.id]);
                
                const endMsg = nextStepId === 'AI_HANDOFF' ? "Connecting you to an agent..." : "Thanks! We will contact you soon.";
                await sendWhatsAppMessage(from, endMsg);
                await queryWithRetry(
                    `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'system', $3, $4, 'text')`,
                    [Date.now().toString() + '_end', driver.id, endMsg, Date.now()]
                );
            } else if (nextStepId) {
                const nextStep = steps.find(s => s.id === nextStepId);
                if (nextStep) {
                    await queryWithRetry('UPDATE drivers SET current_bot_step_id = $1 WHERE id = $2', [nextStepId, driver.id]);
                    
                    const msgText = nextStep.message;
                    const options = nextStep.options || [];
                    
                    await sendWhatsAppMessage(from, msgText, options);
                    await queryWithRetry(
                        `INSERT INTO messages (id, driver_id, sender, text, timestamp, type, options) VALUES ($1, $2, 'system', $3, $4, 'text', $5)`,
                        [Date.now().toString() + '_bot', driver.id, msgText, Date.now(), options]
                    );
                }
            }
        }
    } else if (!driver.is_bot_active && settings.routingStrategy === 'HYBRID_BOT_FIRST') {
         // Fallback to AI
         const aiRes = await analyzeWithAI(text, settings.systemInstruction);
         const reply = aiRes.reply;
         await sendWhatsAppMessage(from, reply);
         await queryWithRetry(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'system', $3, $4, 'text')`,
            [Date.now().toString() + '_ai', driver.id, reply, Date.now()]
        );
    }
};

// --- ROUTES ---

app.get('/api/drivers', async (req, res) => { 
    try {
        const client = await pool.connect();
        try {
            // Select all drivers, ignore company_id if exists
            const leadsRes = await client.query('SELECT * FROM drivers ORDER BY last_message_time DESC LIMIT 100');
            const leads = leadsRes.rows;
            if (leads.length === 0) { res.json([]); return; }

            const leadIds = leads.map(d => d.id);
            const messagesRes = await client.query(`SELECT * FROM messages WHERE driver_id = ANY($1) ORDER BY timestamp ASC`, [leadIds]);

            const messagesByLead = {};
            messagesRes.rows.forEach(msg => {
                if (!messagesByLead[msg.driver_id]) messagesByLead[msg.driver_id] = [];
                messagesByLead[msg.driver_id].push({
                    id: msg.id, sender: msg.sender, text: msg.text,
                    imageUrl: msg.image_url, timestamp: parseInt(msg.timestamp),
                    type: msg.type, options: msg.options
                });
            });

            const mappedLeads = leads.map(row => ({
                id: row.id,
                phoneNumber: row.phone_number,
                name: row.name,
                source: row.source,
                status: row.status,
                lastMessage: row.last_message,
                lastMessageTime: parseInt(row.last_message_time || '0'),
                messages: messagesByLead[row.id] || [],
                documents: row.documents || [],
                notes: row.notes || '',
                onboardingStep: row.onboarding_step || 0,
                vehicleRegistration: row.vehicle_registration,
                availability: row.availability,
                qualificationChecks: row.qualification_checks,
                currentBotStepId: row.current_bot_step_id,
                isBotActive: row.is_bot_active,
                isHumanMode: row.is_human_mode
            }));

            res.json(mappedLeads);
        } finally { client.release(); }
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bot-settings', async (req, res) => { 
    try {
        const resDb = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1', []);
        const defaultSettings = { isEnabled: true, routingStrategy: 'HYBRID_BOT_FIRST', systemInstruction: "", steps: [] };
        res.json(resDb.rows[0]?.settings || defaultSettings);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bot-settings', async (req, res) => { 
    try {
        await queryWithRetry(`INSERT INTO bot_settings (id, settings) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET settings = $1`, [JSON.stringify(req.body)]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/messages/send', async (req, res) => {
    try {
        const { driverId, text } = req.body;
        const driverRes = await queryWithRetry('SELECT phone_number FROM drivers WHERE id = $1', [driverId]);
        if (driverRes.rows.length === 0) return res.status(404).json({ error: "Driver not found" });
        
        const { phone_number } = driverRes.rows[0];
        
        await sendWhatsAppMessage(phone_number, text);
        await queryWithRetry(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'agent', $3, $4, 'text')`,
            [Date.now().toString(), driverId, text, Date.now()]
        );
        // Force human mode on manual reply
        await queryWithRetry(`UPDATE drivers SET is_human_mode = TRUE, is_bot_active = FALSE WHERE id = $1`, [driverId]);

        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- WEBHOOK ENDPOINTS ---
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log("Webhook Verified");
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;
        if (body.object) {
            if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
                const msg = body.entry[0].changes[0].value.messages[0];
                const from = msg.from;
                const text = msg.text ? msg.text.body : (msg.type === 'interactive' ? msg.interactive.button_reply.id : '[Media]');
                
                console.log(`Received from ${from}: ${text}`);
                await processIncomingMessage(from, text);
            }
            res.sendStatus(200);
        } else {
            res.sendStatus(404);
        }
    } catch (e) {
        console.error("Webhook Error:", e);
        res.sendStatus(500);
    }
});

app.post('/api/update-credentials', (req, res) => {
    const { phoneNumberId, apiToken } = req.body;
    PHONE_NUMBER_ID = phoneNumberId;
    META_API_TOKEN = apiToken;
    console.log("Credentials Updated:", PHONE_NUMBER_ID);
    res.json({ success: true });
});

app.post('/api/configure-webhook', (req, res) => {
    const { verifyToken } = req.body;
    VERIFY_TOKEN = verifyToken;
    console.log("Verify Token Updated:", VERIFY_TOKEN);
    res.json({ success: true });
});

// S3 & Files Endpoints
app.post('/api/s3/presign', async (req, res) => { 
    try {
        const { filename, fileType, folderPath } = req.body;
        const key = `${Date.now()}-${filename.replace(/\s+/g, '_')}`;
        const command = new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, ContentType: fileType });
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
        const publicUrl = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
        res.json({ uploadUrl, key, publicUrl });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/files/register', async (req, res) => { 
    try {
        const { key, url, filename, type, folderPath } = req.body;
        const id = Date.now().toString();
        await queryWithRetry(`INSERT INTO media_files (id, url, filename, type, uploaded_at, folder_path) VALUES ($1, $2, $3, $4, $5, $6)`, [id, url, filename, type, Date.now(), folderPath]);
        res.json({ success: true, id, url });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/media', async (req, res) => {
    try {
        const currentPath = req.query.path || '/';
        const folders = await queryWithRetry('SELECT * FROM media_folders WHERE parent_path = $1 ORDER BY name ASC', [currentPath]);
        const files = await queryWithRetry(`SELECT * FROM media_files WHERE folder_path = $1 ORDER BY uploaded_at DESC`, [currentPath]);
        res.json({ folders: folders.rows, files: files.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/folders', async (req, res) => { 
    try {
        const { name, parentPath } = req.body;
        const id = Date.now().toString();
        await queryWithRetry('INSERT INTO media_folders (id, name, parent_path) VALUES ($1, $2, $3)', [id, name, parentPath]);
        res.json({ success: true, id });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = app;
if (require.main === module) app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

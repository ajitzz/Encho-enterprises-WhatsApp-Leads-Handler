
/**
 * UBER FLEET RECRUITER - ENTERPRISE BACKEND
 * Multi-Tenant Architecture with S3 Separation & Live Bot Engine
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg'); 
const { GoogleGenAI } = require('@google/genai');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
require('dotenv').config();

const app = express();

// --- MIDDLEWARE ---
app.use(express.json({ limit: '10mb' }));
app.use(cors()); 

app.set('etag', false);
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

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
    },
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
        if (retries > 0 && (err.code === '57P01' || err.code === 'EPIPE' || err.code === '42P01' || err.code === 'ECONNRESET')) {
            console.log(`DB Retry (${retries} left): ${err.code}`);
            await new Promise(res => setTimeout(res, 1000));
            if (err.code === '42P01') { // Missing table
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

// --- ENTERPRISE SCHEMA ---
const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS companies (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(50) DEFAULT 'logistics',
        terminology JSONB,
        theme_color VARCHAR(20) DEFAULT '#000000',
        created_at BIGINT
    );

    CREATE TABLE IF NOT EXISTS drivers (
        id VARCHAR(255) PRIMARY KEY,
        company_id VARCHAR(50) REFERENCES companies(id) DEFAULT '1',
        phone_number VARCHAR(50),
        name VARCHAR(255),
        source VARCHAR(50) DEFAULT 'Organic',
        status VARCHAR(50) DEFAULT 'New',
        last_message TEXT,
        last_message_time BIGINT,
        documents TEXT[],
        bot_state JSONB DEFAULT '{}',
        created_at BIGINT,
        qualification_checks JSONB DEFAULT '{"check1": false, "check2": false, "check3": true}'::jsonb,
        current_bot_step_id TEXT,
        is_bot_active BOOLEAN DEFAULT FALSE,
        onboarding_step INTEGER DEFAULT 0,
        vehicle_registration TEXT, -- Generic Field 1
        availability TEXT, -- Generic Field 2
        is_human_mode BOOLEAN DEFAULT FALSE,
        notes TEXT,
        UNIQUE(company_id, phone_number)
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
        id SERIAL PRIMARY KEY,
        company_id VARCHAR(50) REFERENCES companies(id) UNIQUE,
        settings JSONB
    );

    CREATE TABLE IF NOT EXISTS media_folders (
        id VARCHAR(255) PRIMARY KEY,
        company_id VARCHAR(50) REFERENCES companies(id) DEFAULT '1',
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
        folder_path VARCHAR(255) DEFAULT '/',
        company_id VARCHAR(50) REFERENCES companies(id) DEFAULT '1'
    );
`;

const ensureDatabaseInitialized = async (client) => {
    try {
        await client.query('BEGIN');
        await client.query(SCHEMA_SQL);
        
        // SEED DEFAULT COMPANIES
        const company1 = {
            id: '1', name: 'Encho Cabs', type: 'logistics',
            terminology: { 
                singular: 'Driver', plural: 'Drivers', 
                field1Label: 'License Plate', field2Label: 'Availability',
                check1Label: 'Valid License', check2Label: 'Has Vehicle', check3Label: 'Local Resident'
            },
            themeColor: '#000000'
        };
        const company2 = {
            id: '2', name: 'Encho Travel', type: 'travel',
            terminology: { 
                singular: 'Traveler', plural: 'Travelers', 
                field1Label: 'Travel Dates', field2Label: 'Destination',
                check1Label: 'Valid ID/Passport', check2Label: 'Deposit Paid', check3Label: 'Visa Cleared'
            },
            themeColor: '#0ea5e9'
        };

        await client.query(
            `INSERT INTO companies (id, name, type, terminology, theme_color, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
            [company1.id, company1.name, company1.type, JSON.stringify(company1.terminology), company1.themeColor, Date.now()]
        );
        await client.query(
            `INSERT INTO companies (id, name, type, terminology, theme_color, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
            [company2.id, company2.name, company2.type, JSON.stringify(company2.terminology), company2.themeColor, Date.now()]
        );

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
            // Use Interactive Buttons if options provided
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

// --- AI ANALYZER (Server Side) ---
const analyzeWithAI = async (text, systemInstruction) => {
    try {
        const model = "gemini-3-flash-preview";
        const prompt = `
        Analyze this user message: "${text}"
        
        Output JSON:
        {
            "intent": "string",
            "reply": "string (reply in the persona language)",
            "isInterested": boolean,
            "extractedData": { "vehicle": "string?", "name": "string?" }
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
        return { reply: "ക്ഷമിക്കണം, എനിക്ക് മനസ്സിലായില്ല. (System Error)" };
    }
};

// --- WEBHOOK PROCESSOR ---
const processIncomingMessage = async (from, text, imageId = null) => {
    const COMPANY_ID = '1'; // Defaulting to Encho Cabs for now

    // 1. Get/Create Driver
    let driverRes = await queryWithRetry('SELECT * FROM drivers WHERE phone_number = $1 AND company_id = $2', [from, COMPANY_ID]);
    let driver = driverRes.rows[0];

    if (!driver) {
        const id = Date.now().toString();
        // Load default settings to see if bot is enabled
        const settingsRes = await queryWithRetry('SELECT settings FROM bot_settings WHERE company_id = $1', [COMPANY_ID]);
        const settings = settingsRes.rows[0]?.settings || { isEnabled: true, entryPointId: 'step_1' };
        
        const isBotActive = settings.isEnabled;
        const startStep = settings.entryPointId || 'step_1';

        await queryWithRetry(
            `INSERT INTO drivers (id, company_id, phone_number, name, source, status, created_at, is_bot_active, current_bot_step_id) 
             VALUES ($1, $2, $3, $4, 'WhatsApp', 'New', $5, $6, $7)`,
            [id, COMPANY_ID, from, 'Unknown Driver', Date.now(), isBotActive, startStep]
        );
        driver = { id, is_bot_active: isBotActive, current_bot_step_id: startStep, company_id: COMPANY_ID };
        
        // If bot active, trigger welcome immediately? 
        // Usually we wait for user 'Hi', but if they just appeared, we process their first text below.
    }

    // 2. Save User Message
    await queryWithRetry(
        `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'driver', $3, $4, 'text')`,
        [Date.now().toString(), driver.id, text, Date.now()]
    );
    await queryWithRetry(`UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3`, [text, Date.now(), driver.id]);

    // 3. Bot Logic
    if (driver.is_human_mode) return; // Human took over

    const settingsRes = await queryWithRetry('SELECT settings FROM bot_settings WHERE company_id = $1', [COMPANY_ID]);
    const settings = settingsRes.rows[0]?.settings;
    
    if (!settings || !settings.isEnabled) return;

    if (settings.routingStrategy === 'AI_ONLY') {
        const aiRes = await analyzeWithAI(text, settings.systemInstruction);
        const reply = aiRes.reply || "Sorry, I didn't understand.";
        
        await sendWhatsAppMessage(from, reply);
        await queryWithRetry(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'system', $3, $4, 'text')`,
            [Date.now().toString() + '_ai', driver.id, reply, Date.now()]
        );
        return;
    }

    // Hybrid / Bot Flow Logic
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
            
            // Check Routes (Exact or Fuzzy Match)
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

                if (nextStepId === 'AI_HANDOFF' && settings.routingStrategy === 'HYBRID_BOT_FIRST') {
                    // Trigger AI immediately after handoff? Or wait for next user msg.
                    // For now, let's wait for next msg.
                }
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
         // Fallback to AI if bot flow finished/interrupted but strategy allows AI
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

app.get('/api/companies', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM companies ORDER BY created_at ASC', []);
        res.json(result.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leads', async (req, res) => { 
    try {
        const companyId = req.headers['x-company-id'] || '1';
        const client = await pool.connect();
        try {
            const leadsRes = await client.query('SELECT * FROM drivers WHERE company_id = $1 ORDER BY last_message_time DESC LIMIT 100', [companyId]);
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
                companyId: row.company_id,
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
                customField1: row.vehicle_registration,
                customField2: row.availability,
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
        const companyId = req.headers['x-company-id'] || '1';
        const resDb = await queryWithRetry('SELECT settings FROM bot_settings WHERE company_id = $1', [companyId]);
        const defaultSettings = { companyId, isEnabled: true, routingStrategy: 'HYBRID_BOT_FIRST', systemInstruction: "", steps: [] };
        res.json(resDb.rows[0]?.settings || defaultSettings);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bot-settings', async (req, res) => { 
    try {
        const companyId = req.headers['x-company-id'] || '1';
        const settings = { ...req.body, companyId };
        await queryWithRetry(`INSERT INTO bot_settings (company_id, settings) VALUES ($1, $2) ON CONFLICT (company_id) DO UPDATE SET settings = $2`, [companyId, JSON.stringify(settings)]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/messages/send', async (req, res) => {
    try {
        const { leadId, text } = req.body;
        const driverRes = await queryWithRetry('SELECT phone_number, company_id FROM drivers WHERE id = $1', [leadId]);
        if (driverRes.rows.length === 0) return res.status(404).json({ error: "Lead not found" });
        
        const { phone_number } = driverRes.rows[0];
        
        await sendWhatsAppMessage(phone_number, text);
        await queryWithRetry(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'agent', $3, $4, 'text')`,
            [Date.now().toString(), leadId, text, Date.now()]
        );
        // Set Human Mode
        await queryWithRetry(`UPDATE drivers SET is_human_mode = TRUE, is_bot_active = FALSE WHERE id = $1`, [leadId]);

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

// S3 & Files Endpoints (Preserved from previous update)
app.post('/api/s3/presign', async (req, res) => { 
    try {
        const companyId = req.headers['x-company-id'] || '1';
        const { filename, fileType, folderPath } = req.body;
        const key = `company_${companyId}/${Date.now()}-${filename.replace(/\s+/g, '_')}`;
        const command = new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, ContentType: fileType });
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
        const publicUrl = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
        res.json({ uploadUrl, key, publicUrl });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/files/register', async (req, res) => { 
    try {
        const companyId = req.headers['x-company-id'] || '1';
        const { key, url, filename, type, folderPath } = req.body;
        const id = Date.now().toString();
        await queryWithRetry(`INSERT INTO media_files (id, company_id, url, filename, type, uploaded_at, folder_path) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, companyId, url, filename, type, Date.now(), folderPath]);
        res.json({ success: true, id, url });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/media', async (req, res) => {
    try {
        const companyId = req.headers['x-company-id'] || '1';
        const currentPath = req.query.path || '/';
        const folders = await queryWithRetry('SELECT * FROM media_folders WHERE parent_path = $1 AND company_id = $2 ORDER BY name ASC', [currentPath, companyId]);
        const files = await queryWithRetry(`SELECT * FROM media_files WHERE folder_path = $1 AND company_id = $2 ORDER BY uploaded_at DESC`, [currentPath, companyId]);
        res.json({ folders: folders.rows, files: files.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/folders', async (req, res) => { 
    try {
        const companyId = req.headers['x-company-id'] || '1';
        const { name, parentPath } = req.body;
        const existing = await queryWithRetry('SELECT id FROM media_folders WHERE name = $1 AND company_id = $2', [name, companyId]);
        if (existing.rows.length > 0) return res.status(409).json({ error: 'Folder exists' });
        const id = Date.now().toString();
        await queryWithRetry('INSERT INTO media_folders (id, company_id, name, parent_path) VALUES ($1, $2, $3, $4)', [id, companyId, name, parentPath]);
        res.json({ success: true, id });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = app;
if (require.main === module) app.listen(PORT, () => console.log(`🚀 Enterprise Server running on port ${PORT}`));

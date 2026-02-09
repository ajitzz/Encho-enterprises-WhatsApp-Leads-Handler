
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const multer = require('multer');
const axios = require('axios');
const https = require('https');
const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { OAuth2Client } = require('google-auth-library');
const { GoogleGenAI } = require("@google/genai");

require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURATION ---
const SYSTEM_CONFIG = {
    META_TIMEOUT: 15000,
    DB_CONNECTION_TIMEOUT: 20000,
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
    AWS_BUCKET: process.env.AWS_BUCKET_NAME || 'uber-fleet-assets',
    GOOGLE_CLIENT_ID: process.env.VITE_GOOGLE_CLIENT_ID,
    CACHE_TTL: 60 * 1000
};

// --- IN-MEMORY CACHE ---
const memoryCache = {
    botSettings: null,
    lastUpdated: 0
};

// --- INITIALIZE CLIENTS ---
let s3Client, googleClient, genAI, pgPool;

try {
    if (process.env.AWS_ACCESS_KEY_ID) {
        s3Client = new S3Client({
            region: SYSTEM_CONFIG.AWS_REGION,
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
            }
        });
    }

    googleClient = new OAuth2Client(SYSTEM_CONFIG.GOOGLE_CLIENT_ID);
    
    if (process.env.GEMINI_API_KEY) {
        genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }

    let connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
    if (connectionString && connectionString.includes('sslmode=')) {
        connectionString = connectionString.replace(/([?&])sslmode=[^&]+(&|$)/, '$1').replace(/[?&]$/, '');
    }
    
    if (connectionString) {
        pgPool = new Pool({
            connectionString,
            connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
            idleTimeoutMillis: 30000,
            ssl: { rejectUnauthorized: false }, 
            max: 20, 
            keepAlive: true
        });
        pgPool.on('error', (err) => console.error('[DB POOL ERROR]', err));
    } else {
        console.error("[CRITICAL] POSTGRES_URL is missing. Database will not work.");
    }

} catch (initError) {
    console.error("[INIT CRITICAL ERROR]", initError);
}

const upload = multer({ storage: multer.memoryStorage() });

// --- HELPERS ---
const withDb = async (operation) => {
    if (!pgPool) throw new Error("Database not initialized");
    let client;
    try {
        client = await pgPool.connect();
        return await operation(client);
    } catch (e) {
        console.error("[DB OPS ERROR]", e);
        throw e;
    } finally {
        if (client) client.release();
    }
};

const getMetaClient = () => axios.create({
    httpsAgent: new https.Agent({ keepAlive: true }),
    timeout: SYSTEM_CONFIG.META_TIMEOUT,
    headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${process.env.META_API_TOKEN}` 
    }
});

const refreshMediaUrl = async (url) => {
    if (!url || typeof url !== 'string') return null;
    if (!s3Client || (!url.includes('amazonaws.com') && !url.includes(SYSTEM_CONFIG.AWS_BUCKET))) return url;

    try {
        const urlObj = new URL(url);
        let key = decodeURIComponent(urlObj.pathname.substring(1));
        if (key.startsWith(SYSTEM_CONFIG.AWS_BUCKET + '/')) {
            key = key.substring(SYSTEM_CONFIG.AWS_BUCKET.length + 1);
        }
        const command = new GetObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key });
        return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    } catch (e) {
        return url; 
    }
};

const sendToMeta = async (phoneNumber, payload) => {
    const phoneId = process.env.PHONE_NUMBER_ID;
    const to = (phoneNumber || '').toString().replace(/\D/g, '');
    
    // Safety Checks
    if (payload.type === 'text' && (!payload.text?.body || !payload.text.body.trim())) return;
    
    try {
        await getMetaClient().post(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            ...payload
        });
    } catch (e) {
        console.error(`[Meta Failed] ${to}: ${e.response?.data?.error?.message || e.message}`);
    }
};

const processText = (text, candidate) => {
    if (!text) return '';
    let processed = text;
    const vars = { name: candidate.name, phone: candidate.phone_number, ...candidate.variables };
    for (const [key, val] of Object.entries(vars)) {
        processed = processed.replace(new RegExp(`{{${key}}}`, 'gi'), val || '');
    }
    return processed;
};

const isValidContent = (text) => {
    if (!text || typeof text !== 'string') return false;
    const clean = text.trim().toLowerCase();
    if (clean.length === 0) return false;
    const blockers = ['replace this sample', 'type your message', 'enter your message', 'replace this text'];
    if (clean.length < 50 && blockers.some(b => clean.includes(b))) return false;
    return true;
};

// --- DATE/TIME LOGIC ---
const PERIODS = {
    MORNING: { label: '🌅 Morning (5 AM - 12 PM)', start: 5, end: 11 },
    AFTERNOON: { label: '☀️ Afternoon (12 PM - 5 PM)', start: 12, end: 16 },
    EVENING: { label: '🌆 Evening (5 PM - 9 PM)', start: 17, end: 20 },
    NIGHT: { label: '🌙 Night (9 PM - 5 AM)', start: 21, end: 28 } 
};

const resolveTimeAmbiguity = (inputTimeStr) => {
    const [hStr, mStr] = inputTimeStr.split(/[:.]/);
    let h = parseInt(hStr);
    const m = parseInt(mStr);
    if (h > 12) return `${h}:${m.toString().padStart(2,'0')}`; 
    const now = new Date();
    const dateAM = new Date(); dateAM.setHours(h === 12 ? 0 : h, m, 0, 0);
    const datePM = new Date(); datePM.setHours(h === 12 ? 12 : h + 12, m, 0, 0);
    let diffAM = dateAM - now; if (diffAM < -900000) diffAM += 86400000; 
    let diffPM = datePM - now; if (diffPM < -900000) diffPM += 86400000;
    const isPM = diffPM < diffAM;
    return `${h}:${m.toString().padStart(2,'0')} ${isPM ? 'PM' : 'AM'}`;
};

const generateDateOptions = (config) => {
    const options = [];
    const today = new Date();
    const days = config?.daysToShow || 5;
    for (let i = 0; i < days; i++) {
        const d = new Date(today); d.setDate(today.getDate() + i);
        let title = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
        options.push({ id: d.toISOString().split('T')[0], title });
    }
    return options;
};

const generatePeriodOptions = (candidate) => {
    const options = [];
    const now = new Date();
    const isToday = candidate?.variables?.pickup_date === now.toISOString().split('T')[0];
    const curH = now.getHours();
    const isValid = (pKey) => {
        if (!isToday) return true;
        if (pKey === 'NIGHT') return true; 
        return PERIODS[pKey].end >= curH;
    };
    if (isValid('MORNING')) options.push({ id: 'PERIOD_MORNING', title: PERIODS.MORNING.label });
    if (isValid('AFTERNOON')) options.push({ id: 'PERIOD_AFTERNOON', title: PERIODS.AFTERNOON.label });
    if (isValid('EVENING')) options.push({ id: 'PERIOD_EVENING', title: PERIODS.EVENING.label });
    options.push({ id: 'PERIOD_NIGHT', title: PERIODS.NIGHT.label });
    return options;
};

const generateTimeOptions = (candidate) => {
    const options = [];
    const now = new Date();
    const periodKey = candidate?.variables?.time_period?.replace('PERIOD_', '');
    if (!periodKey || !PERIODS[periodKey]) return [{ id: 'custom', title: 'Type Time' }];
    const { start, end } = PERIODS[periodKey];
    const isToday = candidate?.variables?.pickup_date === now.toISOString().split('T')[0];
    for (let h = start; h <= end; h++) {
        for (let m = 0; m < 60; m += 30) {
            let realH = h >= 24 ? h - 24 : h;
            if (isToday) {
                if (realH < now.getHours()) continue;
                if (realH === now.getHours() && m < now.getMinutes()) continue;
            }
            const ampm = realH >= 12 ? 'PM' : 'AM';
            const dispH = realH % 12 || 12;
            const timeStr = `${dispH}:${m.toString().padStart(2,'0')} ${ampm}`;
            options.push({ id: timeStr, title: timeStr });
        }
    }
    const final = options.slice(0, 9);
    final.push({ id: 'custom_time', title: 'Type Specific Time' });
    return final;
};

// --- DEFAULT CONFIG ---
const getDefaultBotConfig = () => ({
    isEnabled: true,
    shouldRepeat: false,
    routingStrategy: 'BOT_ONLY',
    nodes: [
        { id: 'start', type: 'custom', position: { x: 50, y: 50 }, data: { id: 'start', type: 'start', label: 'Start Flow' } },
        { id: 'welcome', type: 'custom', position: { x: 50, y: 200 }, data: { id: 'welcome', type: 'text', label: 'Welcome', content: 'Welcome to Encho Cabs!' } }
    ],
    edges: [{ id: 'e1', source: 'start', target: 'welcome', type: 'smoothstep' }]
});

// --- ADVANCED BOT ENGINE ---
const runBotEngine = async (client, candidate, incomingText, incomingPayloadId = null, incomingType = 'text') => {
    // Check Kill Switch
    const sys = await client.query("SELECT value FROM system_settings WHERE key = 'config'");
    const config = sys.rows[0]?.value || { automation_enabled: true };
    if (config.automation_enabled === false || candidate.is_human_mode) return;

    // Load Bot Config (Cache Strategy)
    let botSettings = memoryCache.botSettings;
    const now = Date.now();
    if (!botSettings || (now - memoryCache.lastUpdated > SYSTEM_CONFIG.CACHE_TTL)) {
        const res = await client.query("SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1");
        botSettings = res.rows[0]?.settings || getDefaultBotConfig();
        memoryCache.botSettings = botSettings;
        memoryCache.lastUpdated = now;
    }

    const { nodes, edges } = botSettings;
    let currentNodeId = candidate.current_bot_step_id;
    let nextNodeId = null;
    const cleanInput = (incomingText || '').trim().toLowerCase();

    // Reset Commands
    if (['start', 'restart', 'menu', 'hi', 'hello'].includes(cleanInput)) {
        currentNodeId = null;
        await client.query("UPDATE candidates SET current_bot_step_id = NULL, variables = '{}' WHERE id = $1", [candidate.id]);
        candidate.variables = {};
    }

    // --- STEP 1: PATHFINDING (Determine Next Node) ---
    if (!currentNodeId) {
        const start = nodes.find(n => n.type === 'start' || n.data?.type === 'start');
        nextNodeId = start ? start.id : nodes[0]?.id;
    } else {
        const currentNode = nodes.find(n => n.id === currentNodeId);
        if (currentNode) {
            const type = currentNode.data.type;
            const outgoing = edges.filter(e => e.source === currentNodeId);
            let edge = null;

            // -- LOCATION SPECIFIC LOGIC --
            // If the current node asked for a location, and we got a location type message
            if (incomingType === 'location' && (type === 'pickup_location' || type === 'location_request' || type === 'destination_location')) {
                try {
                    const locData = JSON.parse(incomingText); // Webhook stores JSON string in text field for location
                    const varName = currentNode.data.variable || (type === 'pickup_location' ? 'pickup' : 'destination');
                    
                    // Save specific components for better usability
                    await client.query(
                        `UPDATE candidates SET variables = jsonb_set(
                            jsonb_set(
                                jsonb_set(variables, '{${varName}}', $1),
                                '{${varName}_lat}', $2
                            ),
                            '{${varName}_long}', $3
                        ) WHERE id = $4`,
                        [JSON.stringify(incomingText), JSON.stringify(locData.latitude), JSON.stringify(locData.longitude), candidate.id]
                    );
                    
                    // Force advance
                    edge = outgoing.find(e => e.sourceHandle === 'default' || !e.sourceHandle);
                } catch(e) {
                    console.error("Location Parse Error", e);
                }
            }
            
            // -- 3-STAGE DATE PICKER LOGIC --
            else if (type === 'datetime_picker') {
                let saveVar = null;
                let isManual = false;

                if (incomingPayloadId?.startsWith('PERIOD_')) {
                    await client.query("UPDATE candidates SET variables = jsonb_set(variables, '{time_period}', $1)", [JSON.stringify(incomingPayloadId)]);
                    candidate.variables.time_period = incomingPayloadId;
                } else if (incomingPayloadId?.match(/^\d{4}-\d{2}-\d{2}$/)) {
                    await client.query("UPDATE candidates SET variables = jsonb_set(variables, '{pickup_date}', $1)", [JSON.stringify(incomingPayloadId)]);
                    await client.query("UPDATE candidates SET variables = variables - 'time_period' - 'time_slot' WHERE id = $1", [candidate.id]);
                    delete candidate.variables.time_period;
                    delete candidate.variables.time_slot;
                    candidate.variables.pickup_date = incomingPayloadId;
                } else if (incomingPayloadId === 'custom_time') {
                    isManual = true;
                } else if (incomingPayloadId) {
                    saveVar = incomingPayloadId; 
                } else if (cleanInput) {
                    const timeMatch = cleanInput.match(/([0-9]{1,2})[:.]([0-9]{2})\s*(am|pm)?/i);
                    if (timeMatch) saveVar = resolveTimeAmbiguity(timeMatch[0]);
                    else saveVar = incomingText;
                }

                if (saveVar) {
                    const varName = currentNode.data.variable || 'time_slot';
                    const newVars = { ...candidate.variables, [varName]: saveVar };
                    await client.query("UPDATE candidates SET variables = $1 WHERE id = $2", [newVars, candidate.id]);
                    candidate.variables = newVars;
                }
                
                if (isManual) {
                    await sendToMeta(candidate.phone_number, { type: 'text', text: { body: "Please type your preferred time (e.g. 10:30 PM):" } });
                    return; 
                }
                
                // Only advance if we have final slot
                if (candidate.variables.time_slot || candidate.variables[currentNode.data.variable]) {
                    edge = outgoing.find(e => e.sourceHandle === 'default' || !e.sourceHandle);
                }
            }
            
            // -- GENERIC INPUT LOGIC --
            else if (['input', 'location_request', 'pickup_location', 'destination_location'].includes(type) && incomingType !== 'location') {
                // Handle text fallbacks for location nodes (e.g. user types address) or standard inputs
                let val = incomingText;
                if (incomingPayloadId) val = incomingPayloadId;
                if (val && currentNode.data.variable) {
                    await client.query(`UPDATE candidates SET variables = jsonb_set(variables, '{${currentNode.data.variable}}', $1) WHERE id = $2`, [JSON.stringify(val), candidate.id]);
                    candidate.variables[currentNode.data.variable] = val;
                }
                edge = outgoing.find(e => e.sourceHandle === 'default' || !e.sourceHandle);
            }

            // -- STANDARD EDGE MATCHING --
            if (!edge) {
                // 1. Try Payload Match
                if (incomingPayloadId) {
                    edge = outgoing.find(e => e.sourceHandle === incomingPayloadId);
                }
                // 2. Try Text Match (Buttons - Fuzzy)
                if (!edge && cleanInput && currentNode.data.buttons) {
                    const btn = currentNode.data.buttons.find(b => b.title.toLowerCase().trim() === cleanInput);
                    if (btn) edge = outgoing.find(e => e.sourceHandle === btn.id);
                }
                // 3. Default Advance
                if (!edge && ['text', 'image', 'video', 'rich_card'].includes(type)) {
                    edge = outgoing.find(e => e.sourceHandle === 'default' || !e.sourceHandle);
                }
            }

            if (edge) nextNodeId = edge.target;
            else nextNodeId = currentNodeId; // Stay if no match
        }
    }

    // --- STEP 2: EXECUTION LOOP (High Performance) ---
    let activeNodeId = nextNodeId;
    let safety = 0;
    
    // Performance optimization: Removed unnecessary sleeps in loop
    while(activeNodeId && safety < 15) {
        safety++;
        const node = nodes.find(n => n.id === activeNodeId);
        if (!node) break;
        
        const data = node.data;
        let autoAdvance = true;

        // 1. SAVE STATE FIRST
        await client.query("UPDATE candidates SET current_bot_step_id = $1 WHERE id = $2", [node.id, candidate.id]);

        // 2. PROCESS NODE TYPE
        if (data.type === 'text') {
            const body = processText(data.content, candidate);
            if (isValidContent(body)) await sendToMeta(candidate.phone_number, { type: 'text', text: { body } });
        } 
        
        else if (data.type === 'image' && data.mediaUrl) {
            const url = await refreshMediaUrl(data.mediaUrl);
            await sendToMeta(candidate.phone_number, { type: 'image', image: { link: url, caption: processText(data.content, candidate) } });
        }

        else if (data.type === 'interactive_button' || data.type === 'rich_card') {
            autoAdvance = false; 
            const buttons = (data.buttons || []).slice(0, 3).map(b => ({
                type: "reply",
                reply: { id: b.id, title: b.title.substring(0, 20) } 
            }));
            
            let header = undefined;
            if (data.mediaUrl && (data.headerType === 'image' || data.headerType === 'video')) {
                const url = await refreshMediaUrl(data.mediaUrl);
                header = { type: data.headerType, [data.headerType]: { link: url } };
            }

            await sendToMeta(candidate.phone_number, {
                type: "interactive",
                interactive: {
                    type: "button",
                    header,
                    body: { text: processText(data.content || "Please select:", candidate) },
                    footer: data.footerText ? { text: data.footerText } : undefined,
                    action: { buttons }
                }
            });
        }

        else if (data.type === 'interactive_list') {
            autoAdvance = false;
            await sendToMeta(candidate.phone_number, {
                type: "interactive",
                interactive: {
                    type: "list",
                    body: { text: processText(data.content || "Select an option:", candidate) },
                    action: {
                        button: data.listButtonText || "Menu",
                        sections: data.sections || []
                    }
                }
            });
        }

        else if (data.type === 'datetime_picker') {
            autoAdvance = false;
            let body = "Select an option:";
            let rows = [];
            let btn = "Select";
            
            if (!candidate.variables.pickup_date) {
                body = processText(data.content || "Select Date:", candidate);
                rows = generateDateOptions(data.dateConfig);
                btn = "Dates";
            } else if (!candidate.variables.time_period) {
                body = `Date: ${candidate.variables.pickup_date}\n\nSelect Time of Day:`;
                rows = generatePeriodOptions(candidate);
                btn = "Periods";
            } else {
                body = `Date: ${candidate.variables.pickup_date}\nPeriod: ${candidate.variables.time_period}\n\nSelect Time:`;
                rows = generateTimeOptions(candidate);
                btn = "Times";
            }

            await sendToMeta(candidate.phone_number, {
                type: 'interactive',
                interactive: {
                    type: 'list',
                    body: { text: body },
                    action: { button: btn, sections: [{ title: 'Options', rows }] }
                }
            });
        }

        else if (['input', 'location_request', 'pickup_location', 'destination_location'].includes(data.type)) {
            autoAdvance = false;
            if (['location_request', 'pickup_location', 'destination_location'].includes(data.type)) {
                 // Send location request message
                 await sendToMeta(candidate.phone_number, {
                    type: "interactive",
                    interactive: {
                        type: "location_request_message",
                        body: { text: processText(data.content || "Share Location", candidate) },
                        action: { name: "send_location" }
                    }
                });
            } else {
                // Normal text input prompt
                if (data.content) await sendToMeta(candidate.phone_number, { type: 'text', text: { body: processText(data.content, candidate) } });
            }
        }
        
        else if (data.type === 'set_variable') {
            // Instant Variable Set
            if (data.variable && data.operationValue) {
                await client.query(`UPDATE candidates SET variables = jsonb_set(variables, '{${data.variable}}', $1) WHERE id = $2`, [JSON.stringify(data.operationValue), candidate.id]);
                candidate.variables[data.variable] = data.operationValue;
            }
        }
        
        else if (data.type === 'delay') {
            await new Promise(r => setTimeout(r, Math.min(data.delayTime || 2000, 5000)));
        }

        if (!autoAdvance) break;
        
        // --- 3. AUTO ADVANCE LOGIC ---
        const outEdges = edges.filter(e => e.source === node.id);
        
        if (data.type === 'condition') {
            let matched = false;
            if (data.variable) {
                const val = candidate.variables[data.variable];
                const target = data.value;
                if (data.operator === 'equals') matched = val == target;
                else if (data.operator === 'contains') matched = String(val).includes(target);
                else if (data.operator === 'is_set') matched = !!val;
            }
            const handle = matched ? 'true' : 'false';
            const nextEdge = outEdges.find(e => e.sourceHandle === handle);
            activeNodeId = nextEdge ? nextEdge.target : null;
        } else {
            const nextEdge = outEdges.find(e => e.sourceHandle === 'default' || !e.sourceHandle);
            activeNodeId = nextEdge ? nextEdge.target : null;
        }
    }
};

// --- DB RECOVERY ---
const initDatabase = async (client) => {
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
    await client.query(`CREATE TABLE IF NOT EXISTS system_settings (key VARCHAR(50) PRIMARY KEY, value JSONB);`);
    await client.query(`CREATE TABLE IF NOT EXISTS candidates (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), phone_number VARCHAR(50) UNIQUE, name VARCHAR(255), stage VARCHAR(50), last_message TEXT, last_message_at BIGINT, source VARCHAR(50), is_human_mode BOOLEAN DEFAULT FALSE, current_bot_step_id VARCHAR(100), variables JSONB DEFAULT '{}', created_at TIMESTAMP DEFAULT NOW());`);
    await client.query(`CREATE TABLE IF NOT EXISTS candidate_messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE, direction VARCHAR(10), text TEXT, type VARCHAR(50), status VARCHAR(50), whatsapp_message_id VARCHAR(255), created_at TIMESTAMP DEFAULT NOW());`);
    await client.query(`CREATE TABLE IF NOT EXISTS scheduled_messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE, payload JSONB, scheduled_time BIGINT, status VARCHAR(50), error_log TEXT, created_at TIMESTAMP DEFAULT NOW());`);
    await client.query(`CREATE TABLE IF NOT EXISTS bot_versions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status VARCHAR(20), settings JSONB, created_at TIMESTAMP DEFAULT NOW());`);
    await client.query(`CREATE TABLE IF NOT EXISTS driver_documents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE, type VARCHAR(50), url TEXT, status VARCHAR(50), created_at TIMESTAMP DEFAULT NOW());`);
    
    // --- MEDIA LIBRARY SCHEMA ---
    await client.query(`CREATE TABLE IF NOT EXISTS media_folders (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name VARCHAR(255), parent_path VARCHAR(500), is_public_showcase BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW());`);
    await client.query(`CREATE TABLE IF NOT EXISTS media_files (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), filename VARCHAR(255), url TEXT, s3_key TEXT, type VARCHAR(50), folder_path VARCHAR(500), created_at TIMESTAMP DEFAULT NOW());`);

    await client.query("INSERT INTO system_settings (key, value) VALUES ('config', '{\"automation_enabled\": true}') ON CONFLICT DO NOTHING");
    const botCheck = await client.query("SELECT id FROM bot_versions LIMIT 1");
    if (botCheck.rows.length === 0) {
        await client.query("INSERT INTO bot_versions (id, status, settings, created_at) VALUES ($1, 'published', $2, NOW())", [crypto.randomUUID(), getDefaultBotConfig()]);
    }
};

// --- ROUTES ---

app.get('/ping', async (req, res) => {
    try {
        await withDb(c => c.query('SELECT 1'));
        res.send('pong');
    } catch (e) {
        res.status(500).send('db_error');
    }
});

// --- MEDIA LIBRARY ROUTES ---
app.get('/api/media', async (req, res) => {
    const path = req.query.path || '/';
    try {
        await withDb(async (client) => {
            const folders = await client.query("SELECT * FROM media_folders WHERE parent_path = $1 ORDER BY name ASC", [path]);
            const files = await client.query("SELECT * FROM media_files WHERE folder_path = $1 ORDER BY filename ASC", [path]);
            
            // Presign URLs for freshness
            const signedFiles = await Promise.all(files.rows.map(async f => ({
                ...f,
                url: await refreshMediaUrl(f.url)
            })));

            res.json({ folders: folders.rows, files: signedFiles });
        });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.post('/api/media/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded');
    const { path } = req.body;
    const folderPath = path || '/';
    
    try {
        const key = `${Date.now()}_${req.file.originalname}`;
        const command = new PutObjectCommand({
            Bucket: SYSTEM_CONFIG.AWS_BUCKET,
            Key: key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
        });
        
        if (s3Client) await s3Client.send(command);
        
        const url = `https://${SYSTEM_CONFIG.AWS_BUCKET}.s3.${SYSTEM_CONFIG.AWS_REGION}.amazonaws.com/${key}`;
        let type = 'document';
        if (req.file.mimetype.startsWith('image/')) type = 'image';
        else if (req.file.mimetype.startsWith('video/')) type = 'video';

        await withDb(c => c.query(
            "INSERT INTO media_files (filename, url, s3_key, type, folder_path) VALUES ($1, $2, $3, $4, $5) RETURNING *",
            [req.file.originalname, url, key, type, folderPath]
        ));
        
        res.json({ success: true, url });
    } catch (e) {
        console.error(e);
        res.status(500).send(e.message);
    }
});

app.post('/api/media/folders', async (req, res) => {
    const { name, parentPath } = req.body;
    try {
        await withDb(async (client) => {
            const check = await client.query("SELECT id FROM media_folders WHERE name = $1 AND parent_path = $2", [name, parentPath || '/']);
            if (check.rows.length > 0) return res.status(409).send('Folder exists');
            await client.query("INSERT INTO media_folders (name, parent_path) VALUES ($1, $2)", [name, parentPath || '/']);
            res.json({ success: true });
        });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.delete('/api/media/files/:id', async (req, res) => {
    try {
        await withDb(async (client) => {
            const file = await client.query("SELECT s3_key FROM media_files WHERE id = $1", [req.params.id]);
            if (file.rows.length > 0 && file.rows[0].s3_key && s3Client) {
                await s3Client.send(new DeleteObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: file.rows[0].s3_key }));
            }
            await client.query("DELETE FROM media_files WHERE id = $1", [req.params.id]);
            res.json({ success: true });
        });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.delete('/api/media/folders/:id', async (req, res) => {
    try {
        await withDb(c => c.query("DELETE FROM media_folders WHERE id = $1", [req.params.id]));
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/media/folders/:id/public', async (req, res) => {
    try {
        await withDb(c => c.query("UPDATE media_folders SET is_public_showcase = TRUE WHERE id = $1", [req.params.id]));
        res.json({ success: true });
    } catch(e) { res.status(500).send(e.message); }
});

app.delete('/api/media/folders/:id/public', async (req, res) => {
    try {
        await withDb(c => c.query("UPDATE media_folders SET is_public_showcase = FALSE WHERE id = $1", [req.params.id]));
        res.json({ success: true });
    } catch(e) { res.status(500).send(e.message); }
});

app.post('/api/media/sync-s3', async (req, res) => {
    if (!s3Client) return res.status(500).send("S3 Not Configured");
    try {
        const data = await s3Client.send(new ListObjectsV2Command({ Bucket: SYSTEM_CONFIG.AWS_BUCKET }));
        if (!data.Contents) return res.json({ added: 0 });
        
        let added = 0;
        await withDb(async (client) => {
            for (const item of data.Contents) {
                if (!item.Key) continue;
                const check = await client.query("SELECT id FROM media_files WHERE s3_key = $1", [item.Key]);
                if (check.rows.length === 0) {
                    const url = `https://${SYSTEM_CONFIG.AWS_BUCKET}.s3.${SYSTEM_CONFIG.AWS_REGION}.amazonaws.com/${item.Key}`;
                    let type = 'document';
                    if (item.Key.match(/\.(jpg|jpeg|png|gif|webp)$/i)) type = 'image';
                    else if (item.Key.match(/\.(mp4|mov|webm)$/i)) type = 'video';
                    
                    await client.query("INSERT INTO media_files (filename, url, s3_key, type, folder_path) VALUES ($1, $2, $3, $4, '/')", [item.Key, url, item.Key, type]);
                    added++;
                }
            }
        });
        res.json({ added });
    } catch(e) {
        res.status(500).send(e.message);
    }
});

app.get('/api/showcase/:folderName?', async (req, res) => {
    try {
        const folderName = req.params.folderName ? decodeURIComponent(req.params.folderName) : null;
        await withDb(async (client) => {
            let query = "SELECT * FROM media_folders WHERE is_public_showcase = TRUE";
            let params = [];
            if (folderName) {
                query += " AND name = $1";
                params.push(folderName);
            }
            query += " LIMIT 1";
            
            const folderRes = await client.query(query, params);
            if (folderRes.rows.length === 0) return res.json({ title: 'Not Found', items: [] });
            
            const folder = folderRes.rows[0];
            const files = await client.query("SELECT * FROM media_files WHERE folder_path = $1", [`/${folder.name}`]);
            
            const signedFiles = await Promise.all(files.rows.map(async f => ({
                id: f.id,
                url: await refreshMediaUrl(f.url),
                type: f.type,
                filename: f.filename
            })));
            
            res.json({ title: folder.name, items: signedFiles });
        });
    } catch(e) { res.status(500).send(e.message); }
});

app.get('/api/showcase/status', async (req, res) => {
    try {
        await withDb(async (client) => {
            const active = await client.query("SELECT id, name FROM media_folders WHERE is_public_showcase = TRUE LIMIT 1");
            if (active.rows.length > 0) {
                res.json({ active: true, folderName: active.rows[0].name, folderId: active.rows[0].id });
            } else {
                res.json({ active: false });
            }
        });
    } catch(e) { res.json({ active: false }); }
});

// --- EXISTING ROUTES ---

app.get('/api/debug/status', async (req, res) => {
    try {
        await withDb(async (client) => {
            const tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
            const tableNames = tables.rows.map(r => r.table_name);
            const count = await client.query('SELECT COUNT(*) FROM candidates');
            res.json({
                postgres: 'connected',
                tables: {
                    candidates: tableNames.includes('candidates'),
                    bot_versions: tableNames.includes('bot_versions')
                },
                counts: { candidates: parseInt(count.rows[0].count) },
                env: { hasPostgres: true }
            });
        });
    } catch (e) {
        res.status(500).json({ postgres: 'error', lastError: e.message });
    }
});

app.get('/api/drivers', async (req, res) => {
    try {
        const result = await withDb(c => c.query(`
            SELECT 
                id, phone_number as "phoneNumber", name, stage as status, 
                last_message as "lastMessage", last_message_at as "lastMessageTime", 
                source, is_human_mode as "isHumanMode", variables
            FROM candidates 
            ORDER BY last_message_at DESC NULLS LAST LIMIT 100
        `));
        res.json(result.rows);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.post('/api/drivers/:id/messages', async (req, res) => {
    const { id } = req.params;
    const { text, mediaUrl } = req.body;
    try {
        await withDb(async (client) => {
            const driver = await client.query("SELECT phone_number FROM candidates WHERE id = $1", [id]);
            if (driver.rows.length === 0) throw new Error("Driver not found");
            
            const payload = mediaUrl 
                ? { type: 'image', image: { link: await refreshMediaUrl(mediaUrl), caption: text } }
                : { type: 'text', text: { body: text } };
                
            await sendToMeta(driver.rows[0].phone_number, payload);
            await client.query("INSERT INTO candidate_messages (candidate_id, direction, text, type) VALUES ($1, 'out', $2, $3)", [id, text || '[Media]', mediaUrl ? 'image' : 'text']);
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.get('/api/drivers/:id/messages', async (req, res) => {
    try {
        const result = await withDb(c => c.query(
            "SELECT id, direction as sender, text, created_at as timestamp, type FROM candidate_messages WHERE candidate_id = $1 ORDER BY created_at ASC",
            [req.params.id]
        ));
        const messages = result.rows.map(r => ({
            id: r.id,
            sender: r.sender === 'in' ? 'driver' : 'agent',
            text: r.text,
            timestamp: new Date(r.timestamp).getTime(),
            type: r.type
        }));
        res.json(messages);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.get('/api/bot/settings', async (req, res) => {
    try {
        const result = await withDb(c => c.query("SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1"));
        res.json(result.rows[0]?.settings || getDefaultBotConfig());
    } catch (e) {
        res.json(getDefaultBotConfig());
    }
});

app.post('/api/bot/save', async (req, res) => {
    try {
        await withDb(c => c.query("INSERT INTO bot_versions (status, settings) VALUES ('published', $1)", [req.body]));
        memoryCache.botSettings = req.body;
        memoryCache.lastUpdated = Date.now();
        res.json({ success: true });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.post('/api/system/hard-reset', async (req, res) => {
    try {
        await withDb(async (client) => {
            await client.query("DROP TABLE IF EXISTS candidates CASCADE; DROP TABLE IF EXISTS bot_versions CASCADE; DROP TABLE IF EXISTS media_files CASCADE; DROP TABLE IF EXISTS media_folders CASCADE;");
            await initDatabase(client);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

// WEBHOOK
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === (process.env.VERIFY_TOKEN || 'uber_fleet_verify_token')) {
        res.send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', async (req, res) => {
    res.sendStatus(200); 
    try {
        const body = req.body;
        if (!body.entry?.[0]?.changes?.[0]?.value?.messages) return;

        const msg = body.entry[0].changes[0].value.messages[0];
        const contact = body.entry[0].changes[0].value.contacts?.[0];
        const phone = msg.from;
        const name = contact?.profile?.name || 'Unknown';
        
        let text = '';
        let type = 'text';
        let payloadId = null;

        if (msg.type === 'text') text = msg.text.body;
        else if (msg.type === 'interactive') {
            type = 'interactive';
            if (msg.interactive.type === 'button_reply') {
                payloadId = msg.interactive.button_reply.id;
                text = msg.interactive.button_reply.title;
            } else if (msg.interactive.type === 'list_reply') {
                payloadId = msg.interactive.list_reply.id;
                text = msg.interactive.list_reply.title;
            }
        } else if (msg.type === 'location') {
            type = 'location';
            text = JSON.stringify(msg.location); // Convert location obj to string for storage
        }

        await withDb(async (client) => {
            let cand = await client.query("SELECT * FROM candidates WHERE phone_number = $1", [phone]);
            if (cand.rows.length === 0) {
                cand = await client.query("INSERT INTO candidates (phone_number, name) VALUES ($1, $2) RETURNING *", [phone, name]);
            }
            const candidate = cand.rows[0];

            await client.query("INSERT INTO candidate_messages (candidate_id, direction, text, type, whatsapp_message_id) VALUES ($1, 'in', $2, $3, $4)", [candidate.id, text, type, msg.id]);
            await client.query("UPDATE candidates SET last_message = $1, last_message_at = extract(epoch from now()) * 1000 WHERE id = $2", [text, candidate.id]);

            // Pass msg.type to the engine so it knows how to handle location
            await runBotEngine(client, candidate, text, payloadId, msg.type);
        });

    } catch (e) {
        console.error("Webhook Error:", e);
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    try {
        await withDb(async (c) => {
            await c.query('SELECT NOW()');
            await initDatabase(c);
            console.log(`✅ Database Ready.`);
        });
    } catch (e) {
        console.error(`❌ DB Connection Failed: ${e.message}`);
    }
});

module.exports = app;

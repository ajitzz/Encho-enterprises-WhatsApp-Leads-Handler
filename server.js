
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const multer = require('multer');
const axios = require('axios');
const https = require('https');
const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
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
    CACHE_TTL: 60 * 1000 // 60 Seconds Cache for Bot Settings
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

    // NEON CONNECTION STRATEGY (Sanitize SSL Mode)
    let connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
    if (connectionString && connectionString.includes('sslmode=')) {
        connectionString = connectionString.replace(/([?&])sslmode=[^&]+(&|$)/, '$1').replace(/[?&]$/, '');
    }
    
    if (connectionString) {
        pgPool = new Pool({
            connectionString,
            connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
            idleTimeoutMillis: 30000,
            ssl: { rejectUnauthorized: false }, // Critical for Neon
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

// --- DB HELPERS ---
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

// --- MEDIA & TEXT HELPERS ---
const refreshMediaUrl = async (url) => {
    if (!url || typeof url !== 'string') return null;
    if (!s3Client || (!url.includes('amazonaws.com') && !url.includes(SYSTEM_CONFIG.AWS_BUCKET))) return url;

    try {
        const urlObj = new URL(url);
        let key = decodeURIComponent(urlObj.pathname.substring(1));
        // Remove bucket name if present in path
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
    const blockers = ['replace this sample', 'type your message', 'enter your message'];
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
    if (h > 12) return `${h}:${m.toString().padStart(2,'0')}`; // Already 24h
    // Heuristic: If it's 8:00, is it AM or PM?
    // We assume Next Occurrence.
    const now = new Date();
    const dateAM = new Date(); dateAM.setHours(h === 12 ? 0 : h, m, 0, 0);
    const datePM = new Date(); datePM.setHours(h === 12 ? 12 : h + 12, m, 0, 0);
    
    let diffAM = dateAM - now; if (diffAM < -900000) diffAM += 86400000; // Allow 15m past
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
    
    await client.query("INSERT INTO system_settings (key, value) VALUES ('config', '{\"automation_enabled\": true}') ON CONFLICT DO NOTHING");
    const botCheck = await client.query("SELECT id FROM bot_versions LIMIT 1");
    if (botCheck.rows.length === 0) {
        await client.query("INSERT INTO bot_versions (id, status, settings, created_at) VALUES ($1, 'published', $2, NOW())", [crypto.randomUUID(), getDefaultBotConfig()]);
    }
};

const executeWithRetry = async (client, operation) => {
    try {
        return await operation();
    } catch (err) {
        if (err.code === '42P01') { // Undefined Table
            console.warn("[Auto-Heal] Tables missing. Re-initializing database...");
            await initDatabase(client);
            return await operation(); 
        }
        throw err;
    }
};

// --- BOT ENGINE (3-STAGE BOOKING SUPPORT) ---
const runBotEngine = async (client, candidate, incomingText, incomingPayloadId = null) => {
    // Check Kill Switch
    const sys = await client.query("SELECT value FROM system_settings WHERE key = 'config'");
    const config = sys.rows[0]?.value || { automation_enabled: true };
    if (config.automation_enabled === false || candidate.is_human_mode) return;

    // Load Bot Config
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
    if (['start', 'restart', 'menu'].includes(cleanInput)) {
        currentNodeId = null;
        await client.query("UPDATE candidates SET current_bot_step_id = NULL, variables = '{}' WHERE id = $1", [candidate.id]);
        candidate.variables = {};
    }

    // Determine Next Step
    if (!currentNodeId) {
        const start = nodes.find(n => n.type === 'start' || n.data?.type === 'start');
        nextNodeId = start ? start.id : nodes[0]?.id;
    } else {
        const currentNode = nodes.find(n => n.id === currentNodeId);
        if (currentNode) {
            // Handle Logic based on type
            const type = currentNode.data.type;
            
            // --- 3-STAGE DATE PICKER LOGIC ---
            if (type === 'datetime_picker') {
                let saveVar = null;
                let isManual = false;

                if (incomingPayloadId?.startsWith('PERIOD_')) {
                    // Stage 2: Period Selected -> Save -> Loop
                    await client.query("UPDATE candidates SET variables = jsonb_set(variables, '{time_period}', $1)", [JSON.stringify(incomingPayloadId)]);
                    candidate.variables.time_period = incomingPayloadId;
                } else if (incomingPayloadId?.match(/^\d{4}-\d{2}-\d{2}$/)) {
                    // Stage 1: Date Selected -> Save -> Reset Period -> Loop
                    await client.query("UPDATE candidates SET variables = jsonb_set(variables, '{pickup_date}', $1)", [JSON.stringify(incomingPayloadId)]);
                    // Reset period/time
                    await client.query("UPDATE candidates SET variables = variables - 'time_period' - 'time_slot' WHERE id = $1", [candidate.id]);
                    delete candidate.variables.time_period;
                    delete candidate.variables.time_slot;
                    candidate.variables.pickup_date = incomingPayloadId;
                } else if (incomingPayloadId === 'custom_time') {
                    isManual = true;
                } else if (incomingPayloadId) {
                    saveVar = incomingPayloadId; // Final Time
                } else if (cleanInput) {
                    // Regex Time Match
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
                    return; // Stop and wait for input
                }
            }
            // --- GENERIC INPUT LOGIC ---
            else if (['input', 'location_request', 'pickup_location'].includes(type)) {
                let val = incomingText;
                if (incomingPayloadId) val = incomingPayloadId; // For presets
                // Save variable logic...
                if (val && currentNode.data.variable) {
                    await client.query(`UPDATE candidates SET variables = jsonb_set(variables, '{${currentNode.data.variable}}', $1) WHERE id = $2`, [JSON.stringify(val), candidate.id]);
                    candidate.variables[currentNode.data.variable] = val;
                }
            }

            // Find Edge
            const outgoing = edges.filter(e => e.source === currentNodeId);
            let edge = null;
            
            // Advance logic
            if (type === 'datetime_picker') {
                // Only advance if we have the final time slot
                if (candidate.variables.time_slot || candidate.variables[currentNode.data.variable]) {
                    edge = outgoing.find(e => e.sourceHandle === 'default' || !e.sourceHandle);
                }
                // Else loop (nextNodeId = currentNodeId implicit)
            } else {
                // Default advance
                edge = outgoing.find(e => e.sourceHandle === 'default' || !e.sourceHandle);
            }

            if (edge) nextNodeId = edge.target;
            else nextNodeId = currentNodeId; // Loop if no edge found
        }
    }

    // Execute Nodes
    let activeNodeId = nextNodeId;
    let safety = 0;
    while(activeNodeId && safety < 15) {
        safety++;
        const node = nodes.find(n => n.id === activeNodeId);
        if (!node) break;
        
        const data = node.data;
        let autoAdvance = true;

        if (data.type === 'text') {
            const body = processText(data.content, candidate);
            if (isValidContent(body)) await sendToMeta(candidate.phone_number, { type: 'text', text: { body } });
        } 
        else if (data.type === 'datetime_picker') {
            autoAdvance = false;
            // Determine Phase
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
        else if (['input', 'location_request'].includes(data.type)) {
            autoAdvance = false; // Wait for user
            // Send prompt...
            if (data.content) await sendToMeta(candidate.phone_number, { type: 'text', text: { body: processText(data.content, candidate) } });
        }

        await client.query("UPDATE candidates SET current_bot_step_id = $1 WHERE id = $2", [node.id, candidate.id]);
        
        if (!autoAdvance) break;
        
        // Find next edge for auto-advance nodes (like text)
        const edge = edges.find(e => e.source === node.id);
        if (edge) {
            activeNodeId = edge.target;
            await new Promise(r => setTimeout(r, 500)); // Delay for natural feel
        } else {
            activeNodeId = null;
        }
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
            await client.query("DROP TABLE IF EXISTS candidates CASCADE; DROP TABLE IF EXISTS bot_versions CASCADE;");
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
    res.sendStatus(200); // Ack immediately
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
            text = JSON.stringify(msg.location);
        }

        await withDb(async (client) => {
            // Upsert Candidate
            let cand = await client.query("SELECT * FROM candidates WHERE phone_number = $1", [phone]);
            if (cand.rows.length === 0) {
                cand = await client.query("INSERT INTO candidates (phone_number, name) VALUES ($1, $2) RETURNING *", [phone, name]);
            }
            const candidate = cand.rows[0];

            // Log Message
            await client.query("INSERT INTO candidate_messages (candidate_id, direction, text, type, whatsapp_message_id) VALUES ($1, 'in', $2, $3, $4)", [candidate.id, text, type, msg.id]);
            await client.query("UPDATE candidates SET last_message = $1, last_message_at = extract(epoch from now()) * 1000 WHERE id = $2", [text, candidate.id]);

            // Run Bot
            await runBotEngine(client, candidate, text, payloadId);
        });

    } catch (e) {
        console.error("Webhook Error:", e);
    }
});

// STARTUP DIAGNOSTICS
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔌 Testing Database Connection...`);
    try {
        await withDb(async (c) => {
            const res = await c.query('SELECT NOW()');
            console.log(`✅ DB Connected! Server Time: ${res.rows[0].now}`);
            await initDatabase(c);
            console.log(`✅ Schema Verified.`);
        });
    } catch (e) {
        console.error(`❌ DB Connection FAILED: ${e.message}`);
        console.error(`   Ensure POSTGRES_URL is correct in .env`);
    }
});

module.exports = app;

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const { Client: QStashClient, Receiver } = require('@upstash/qstash');
const { Pool } = require('pg');
const multer = require('multer');
const { OAuth2Client } = require('google-auth-library');
const axios = require('axios');
const https = require('https');
require('dotenv').config();

// --- OBSERVABILITY ---
const logger = {
    info: (msg, meta = {}) => console.log(JSON.stringify({ level: 'INFO', msg, timestamp: new Date().toISOString(), ...meta })),
    error: (msg, meta = {}) => console.error(JSON.stringify({ level: 'ERROR', msg, timestamp: new Date().toISOString(), ...meta })),
    warn: (msg, meta = {}) => console.warn(JSON.stringify({ level: 'WARN', msg, timestamp: new Date().toISOString(), ...meta })),
};

// --- CONFIGURATION ---
const SYSTEM_CONFIG = {
    META_TIMEOUT: 15000,
    DB_CONNECTION_TIMEOUT: 10000,
    CACHE_TTL_SETTINGS: 600
};

// --- SERVICES INITIALIZATION ---

let pgPool = null;

const resolveDbUrl = () =>
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    "";

const getDb = () => {
    if (!pgPool) {
        const dbUrl = resolveDbUrl();
        if (!dbUrl) throw new Error("No Postgres connection string found. Set POSTGRES_URL or DATABASE_URL.");

        pgPool = new Pool({
            connectionString: dbUrl,
            ssl: { rejectUnauthorized: false },
            connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
            max: 10,
            idleTimeoutMillis: 1000,
            allowExitOnIdle: true
        });

        pgPool.on('error', (err) => logger.error('DB Pool Error', { error: err.message }));
    }
    return pgPool;
};

// Robust DB Wrapper with Retry Logic for Serverless
const withDb = async (operation) => {
    let client;
    try {
        client = await getDb().connect();
        return await operation(client);
    } catch (e) {
        logger.error("DB Operation Failed", { error: e.message });
        throw e;
    } finally {
        if (client) {
            try { client.release(); } catch (e) { console.error("Failed to release client", e); }
        }
    }
};

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL || 'https://mock.upstash.io',
    token: process.env.UPSTASH_REDIS_REST_TOKEN || 'mock'
});

const authClient = new OAuth2Client(process.env.VITE_GOOGLE_CLIENT_ID);

// --- META API CLIENT (AXIOS) ---
const getMetaClient = () => {
    return axios.create({
        httpsAgent: new https.Agent({ keepAlive: true }),
        timeout: SYSTEM_CONFIG.META_TIMEOUT,
        headers: { 
            'Content-Type': 'application/json', 
            'Authorization': `Bearer ${process.env.META_API_TOKEN}` 
        }
    });
};

// --- OUTBOUND MESSAGING CORE ---
const sendToMeta = async (phoneNumber, payload) => {
    // 1. SAFETY CHECK: Block Placeholder Messages
    if (payload.type === 'text' && payload.text && payload.text.body) {
        const body = payload.text.body.toLowerCase();
        const forbidden = ['replace this', 'sample message', 'type your message', 'insert text'];
        if (forbidden.some(f => body.includes(f))) {
            logger.warn("🛑 BLOCKED: Placeholder message detected.", { to: phoneNumber });
            throw new Error("Message blocked: Contains placeholder text.");
        }
    }

    const phoneId = process.env.PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!phoneId) throw new Error("PHONE_NUMBER_ID missing in env");
    
    // Clean Phone Number
    const to = (phoneNumber || '').toString().replace(/\D/g, '');
    if (!to) throw new Error("Invalid phone number");

    const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`;
    
    try {
        const fullPayload = {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            ...payload
        };
        await getMetaClient().post(url, fullPayload);
    } catch (e) {
        logger.error("Meta Send Error", { error: e.response?.data || e.message, to });
        throw e;
    }
};

// --- EXPRESS APP ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- BOT ENGINE ---

const getBotSettings = async () => {
    // Try Redis
    try {
        const cached = await redis.get(`bot:settings:${process.env.PHONE_NUMBER_ID}`);
        if (cached) return cached;
    } catch (_) {}

    // Fallback DB
    return await withDb(async (client) => {
        const res = await client.query(`SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1`);
        if (res.rows.length > 0) {
            // Cache for 10 mins
            try { await redis.set(`bot:settings:${process.env.PHONE_NUMBER_ID}`, res.rows[0].settings, { ex: 600 }); } catch (_) {}
            return res.rows[0].settings;
        }
        return null;
    });
};

const processMessageInternal = async (message, contact, phoneId) => {
    if (!message || !phoneId) return;

    const from = message.from; // Phone number
    const name = contact?.profile?.name || "Unknown";
    
    // Extract text content safely
    let textBody = '';
    if (message.type === 'text') textBody = message.text?.body;
    else if (message.type === 'interactive') {
        textBody = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '[Interactive]';
    } else {
        textBody = `[${message.type}]`;
    }

    await withDb(async (client) => {
        // 1. Upsert Candidate (Driver)
        // We set 'is_human_mode' default to false only on INSERT. If it exists, we keep current state.
        const upsertQuery = `
            INSERT INTO candidates (id, phone_number, name, stage, last_message_at, last_message, created_at) 
            VALUES ($1, $2, $3, 'New', $4, $5, NOW()) 
            ON CONFLICT (phone_number) 
            DO UPDATE SET name = EXCLUDED.name, last_message_at = $4, last_message = $5 
            RETURNING id, current_node_id, is_human_mode, human_mode_ends_at
        `;
        const resDb = await client.query(upsertQuery, [crypto.randomUUID(), from, name, Date.now(), textBody]);
        const candidate = resDb.rows[0];

        // 2. Save Incoming Message (Deduplicate by whatsapp_message_id)
        const insertMsgQuery = `
            INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, whatsapp_message_id, created_at) 
            VALUES ($1, $2, 'in', $3, $4, 'received', $5, NOW()) 
            ON CONFLICT (whatsapp_message_id) DO NOTHING
        `;
        await client.query(insertMsgQuery, [crypto.randomUUID(), candidate.id, textBody, message.type, message.id]);

        // 3. BOT LOGIC
        // IF User is in Human Mode, STOP here.
        if (candidate.is_human_mode) {
            // Check if human mode expired
            if (candidate.human_mode_ends_at && Date.now() > Number(candidate.human_mode_ends_at)) {
                await client.query(`UPDATE candidates SET is_human_mode = FALSE WHERE id = $1`, [candidate.id]);
                // Proceed to bot logic
            } else {
                logger.info(`Skipping bot for ${from} (Human Mode Active)`);
                return;
            }
        }

        // Load Bot Settings
        const settings = await getBotSettings();
        if (!settings || !settings.nodes || settings.nodes.length === 0) return;

        let nextNode = null;

        // A. Start of conversation (No current node)
        if (!candidate.current_node_id) {
            nextNode = settings.nodes.find(n => n.type === 'start') || settings.nodes[0];
            // If start node is just a marker, move to its target
            if (nextNode) {
                const edge = settings.edges?.find(e => e.source === nextNode.id);
                if (edge) nextNode = settings.nodes.find(n => n.id === edge.target);
            }
        } 
        // B. Continue conversation
        else {
            // Find edge from current node
            // Simple logic: Find edge where source == current_node_id
            // Advanced logic: If button clicked, find specific handle
            const edges = settings.edges?.filter(e => e.source === candidate.current_node_id) || [];
            
            if (edges.length === 1) {
                // Direct path
                nextNode = settings.nodes.find(n => n.id === edges[0].target);
            } else if (edges.length > 1) {
                // Branching (Buttons/Logic)
                // If message is interactive button reply, match the button ID/Title
                if (message.type === 'interactive') {
                    const btnId = message.interactive?.button_reply?.id || message.interactive?.button_reply?.title;
                    const matchingEdge = edges.find(e => e.sourceHandle === btnId); // We assume edge sourceHandle matches button ID
                    if (matchingEdge) {
                        nextNode = settings.nodes.find(n => n.id === matchingEdge.target);
                    }
                }
                
                // Fallback: If no match found, maybe just take the 'default' path if exists, or re-send current question
                if (!nextNode) {
                    // Logic to handle invalid input: stay on current node or send error
                    return; 
                }
            }
        }

        // C. Execute Next Node
        if (nextNode && nextNode.data) {
            // 1. Send Message
            if (nextNode.data.content) {
                const payload = { type: 'text', text: { body: nextNode.data.content } };
                
                // Handle Buttons
                if (nextNode.data.type === 'buttons' && nextNode.data.buttons) {
                    payload.type = 'interactive';
                    payload.interactive = {
                        type: "button",
                        body: { text: nextNode.data.content },
                        action: {
                            buttons: nextNode.data.buttons.map(b => ({
                                type: "reply",
                                reply: { id: b.id || b.title, title: b.title.substring(0, 20) } // WhatsApp limit 20 chars
                            }))
                        }
                    };
                }

                await sendToMeta(from, payload);
                
                // 2. Log Outbound Message
                await client.query(
                    `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`, 
                    [crypto.randomUUID(), candidate.id, nextNode.data.content]
                );

                // 3. Update Candidate State
                await client.query(`UPDATE candidates SET current_node_id = $1, last_message_at = $2 WHERE id = $3`, [nextNode.id, Date.now(), candidate.id]);
            }
        }
    });
};


// --- WEBHOOK HANDLER ---
const apiRouter = express.Router();

apiRouter.get('/webhook', (req, res) => {
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN || process.env.META_WEBHOOK_VERIFY_TOKEN;
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

apiRouter.post('/webhook', async (req, res) => {
    res.sendStatus(200); // Always ack immediately
    try {
        const body = req.body;
        // Check if it's a WhatsApp status update or message
        if (body.object === 'whatsapp_business_account') {
            const entry = body.entry?.[0];
            const changes = entry?.changes?.[0];
            const value = changes?.value;

            if (value?.messages) {
                const phoneId = value.metadata?.phone_number_id;
                const contacts = value.contacts || [];
                
                for (const message of value.messages) {
                    const contact = contacts.find(c => c.wa_id === message.from) || {};
                    // Async processing
                    processMessageInternal(message, contact, phoneId).catch(err => 
                        logger.error("Msg Process Error", { err: err.message })
                    );
                }
            }
        }
    } catch (e) {
        logger.error("Webhook Parse Error", { error: e.message });
    }
});

// --- AI ROUTE (AXIOS) ---
apiRouter.post('/ai/generate', async (req, res) => {
    const { contents, config, model } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({error: "Missing GEMINI_API_KEY"});

    // Map 'gemini-3-pro' etc to valid API names if needed, or pass through
    const targetModel = model || 'gemini-1.5-flash'; 
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;

    // Construct Payload compatible with REST API
    const payload = {
        contents: typeof contents === 'string' ? [{ parts: [{ text: contents }] }] : contents,
        generationConfig: {}
    };

    if (config) {
        if (config.systemInstruction) payload.systemInstruction = { parts: [{ text: config.systemInstruction }] };
        if (config.responseMimeType) payload.generationConfig.responseMimeType = config.responseMimeType;
        if (config.responseSchema) payload.generationConfig.responseSchema = config.responseSchema;
    }

    try {
        const response = await axios.post(url, payload);
        const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        res.json({ text });
    } catch (e) {
        logger.error("AI Error", { msg: e.message, data: e.response?.data });
        res.status(500).json({ error: e.message });
    }
});

// --- STANDARD API ROUTES (Drivers, Messages, Etc) ---
apiRouter.get('/drivers', async (req, res, next) => {
    try {
        await withDb(async (client) => {
            const resDb = await client.query('SELECT * FROM candidates ORDER BY last_message_at DESC NULLS LAST LIMIT 50');
            res.json(resDb.rows.map(row => ({
                id: row.id,
                phoneNumber: row.phone_number,
                name: row.name,
                status: row.stage,
                lastMessage: row.last_message,
                lastMessageTime: parseInt(row.last_message_at || '0'),
                source: row.source,
                isHumanMode: row.is_human_mode
            })));
        });
    } catch (e) { next(e); }
});

apiRouter.post('/drivers/:id/messages', async (req, res, next) => {
    const { text, mediaUrl, mediaType } = req.body;
    try {
        await withDb(async (client) => {
            // 1. Get Phone
            const dRes = await client.query('SELECT phone_number FROM candidates WHERE id = $1', [req.params.id]);
            if (dRes.rows.length === 0) return res.status(404).json({error: "Driver not found"});
            const phone = dRes.rows[0].phone_number;

            // 2. Prepare Payload
            const payload = mediaUrl 
                ? { type: mediaType || 'image', [mediaType || 'image']: { link: mediaUrl, caption: text } }
                : { type: 'text', text: { body: text } };

            // 3. Send
            await sendToMeta(phone, payload);

            // 4. Save to DB
            await client.query(
                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`,
                [crypto.randomUUID(), req.params.id, text || '[Media]']
            );
            
            // 5. Update Last Message & Enable Human Mode automatically on manual reply
            await client.query(
                `UPDATE candidates SET last_message = $1, last_message_at = $2, is_human_mode = TRUE WHERE id = $3`,
                [text || '[Media]', Date.now(), req.params.id]
            );
        });
        res.json({ success: true });
    } catch (e) { next(e); }
});

// --- SERVER STARTUP ---
app.use('/api', apiRouter);
app.use('/', apiRouter); // Handle root requests too

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        logger.info(`🚀 Server running on port ${PORT}`);
    });
}

module.exports = app;

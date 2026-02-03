
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const multer = require('multer');
const axios = require('axios');
const https = require('https');
const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { OAuth2Client } = require('google-auth-library');
const { GoogleGenAI } = require("@google/genai");

require('dotenv').config();

// --- CONFIGURATION ---
const SYSTEM_CONFIG = {
    META_TIMEOUT: 15000,
    DB_CONNECTION_TIMEOUT: 10000,
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
    AWS_BUCKET: process.env.AWS_BUCKET_NAME || 'uber-fleet-assets',
    GOOGLE_CLIENT_ID: process.env.VITE_GOOGLE_CLIENT_ID
};

// --- INITIALIZE CLIENTS ---
const s3Client = new S3Client({
    region: SYSTEM_CONFIG.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const googleClient = new OAuth2Client(SYSTEM_CONFIG.GOOGLE_CLIENT_ID);
// Only init GenAI if key exists to prevent crash on startup
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

const upload = multer({ storage: multer.memoryStorage() });

// Database Pool - Optimized for Serverless (Neon)
const pgPool = new Pool({
    connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
    connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
    ssl: { rejectUnauthorized: false }, // Required for Neon
    max: 10 // Lower connection limit for serverless
});

// Wrapper for DB operations to handle connection lifecycle
const withDb = async (operation) => {
    let client;
    try {
        client = await pgPool.connect();
        return await operation(client);
    } catch (e) {
        console.error("[DB CRITICAL ERROR]", e);
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

// --- HELPER: REFRESH S3 URL ---
const refreshMediaUrl = async (url) => {
    if (!url || typeof url !== 'string' || !url.includes(SYSTEM_CONFIG.AWS_BUCKET)) return url;
    try {
        const urlObj = new URL(url);
        let key = decodeURIComponent(urlObj.pathname.substring(1));
        // Fix double bucket name in path if present
        if (key.startsWith(SYSTEM_CONFIG.AWS_BUCKET + '/')) {
            key = key.substring(SYSTEM_CONFIG.AWS_BUCKET.length + 1);
        }
        const command = new GetObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key });
        return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    } catch (e) {
        console.warn("[S3 Refresh Fail]", e.message);
        return url; 
    }
};

// --- HELPER: SEND TO META (WHATSAPP) ---
const sendToMeta = async (phoneNumber, payload) => {
    const phoneId = process.env.PHONE_NUMBER_ID;
    // Clean phone number (remove +, spaces, dashes)
    const to = (phoneNumber || '').toString().replace(/\D/g, '');
    
    // Safety check for empty text
    if (payload.type === 'text' && (!payload.text?.body || !payload.text.body.trim())) {
        console.warn("[Meta] Skipped sending empty text message");
        return;
    }

    if (!phoneId || !process.env.META_API_TOKEN) {
        throw new Error("Missing META_API_TOKEN or PHONE_NUMBER_ID env vars");
    }

    try {
        console.log(`[Meta] Sending to ${to} | Type: ${payload.type}`);
        const response = await getMetaClient().post(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            ...payload
        });
        return response.data;
    } catch (e) {
        console.error("[Meta Send Failed]", e.response?.data || e.message);
        throw new Error(JSON.stringify(e.response?.data || e.message));
    }
};

// --- EXPRESS APP SETUP ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Logging Middleware
app.use((req, res, next) => {
    console.log(`[${req.method}] ${req.path}`);
    next();
});

const apiRouter = express.Router();

// ============================================================================
// 1. CRON JOB - MESSAGE PROCESSOR (DEEP LOGGING)
// ============================================================================
apiRouter.get('/cron/process-queue', async (req, res) => {
    console.log("--- [CRON] Starting Queue Processing ---");
    let processed = 0;
    let errors = 0;

    try {
        await withDb(async (client) => {
            const now = Date.now();
            
            // 1. Fetch Pending Messages
            // We use FOR UPDATE SKIP LOCKED to prevent double-sending in case of multiple cron triggers
            const jobs = await client.query(`
                SELECT sm.id, sm.candidate_id, sm.payload, sm.scheduled_time, c.phone_number
                FROM scheduled_messages sm
                JOIN candidates c ON sm.candidate_id = c.id
                WHERE sm.status = 'pending' AND sm.scheduled_time <= $1
                LIMIT 10
                FOR UPDATE OF sm SKIP LOCKED
            `, [now]);

            console.log(`[CRON] Found ${jobs.rows.length} pending messages due before ${new Date(now).toISOString()}`);

            for (const job of jobs.rows) {
                console.log(`[CRON] Processing Job ID: ${job.id} for Candidate: ${job.candidate_id}`);
                
                try {
                    // Mark as processing
                    await client.query("UPDATE scheduled_messages SET status = 'processing' WHERE id = $1", [job.id]);

                    // Construct Meta Payload
                    const payloadData = job.payload || {};
                    const { text, mediaUrl, mediaType } = payloadData;
                    
                    let metaPayload;
                    let dbTextLog = typeof text === 'string' ? text : JSON.stringify(text);
                    
                    if (mediaUrl) {
                        const freshUrl = await refreshMediaUrl(mediaUrl);
                        const type = mediaType || 'image';
                        metaPayload = {
                            type: type,
                            [type]: { link: freshUrl, caption: dbTextLog } // Whatsapp API expects 'caption' for media
                        };
                        dbTextLog = `[${type.toUpperCase()}] ${dbTextLog}`;
                    } else {
                        metaPayload = { type: 'text', text: { body: dbTextLog } };
                    }

                    // Execute Send
                    await sendToMeta(job.phone_number, metaPayload);

                    // Archive in Chat History
                    const msgId = crypto.randomUUID();
                    await client.query(
                        `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())`,
                        [msgId, job.candidate_id, dbTextLog, mediaUrl ? (mediaType || 'image') : 'text']
                    );

                    // Mark Job Complete
                    await client.query("UPDATE scheduled_messages SET status = 'sent' WHERE id = $1", [job.id]);
                    processed++;
                    console.log(`[CRON] Job ${job.id} SUCCESS`);

                } catch (jobError) {
                    console.error(`[CRON] Job ${job.id} FAILED:`, jobError.message);
                    await client.query("UPDATE scheduled_messages SET status = 'failed', error_log = $2 WHERE id = $1", [job.id, jobError.message]);
                    errors++;
                }
            }
        });

        console.log(`--- [CRON] Finished. Processed: ${processed}, Errors: ${errors} ---`);
        res.json({ status: 'ok', processed, errors, timestamp: Date.now() });

    } catch (e) {
        console.error("[CRON FATAL ERROR]", e);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// ============================================================================
// 2. DEBUG & SYSTEM STATUS
// ============================================================================
apiRouter.get('/debug/status', async (req, res) => {
    try {
        await withDb(async (client) => {
            const tablesRes = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
            const tables = tablesRes.rows.map(r => r.table_name);
            const countRes = await client.query('SELECT COUNT(*) as c FROM candidates');
            
            res.json({
                postgres: 'connected',
                tables: {
                    candidates: tables.includes('candidates'),
                    scheduled_messages: tables.includes('scheduled_messages'),
                    bot_versions: tables.includes('bot_versions')
                },
                counts: { candidates: parseInt(countRes.rows[0].c) },
                env: { publicUrl: process.env.PUBLIC_BASE_URL || 'Not Set' }
            });
        });
    } catch (e) {
        console.error("Debug Check Failed:", e);
        res.status(500).json({ postgres: 'error', lastError: e.message });
    }
});

// ============================================================================
// 3. WEBHOOK INGEST (FROM WHATSAPP)
// ============================================================================
apiRouter.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
        console.log("[Webhook] Verified Successfully");
        res.status(200).send(req.query['hub.challenge']);
    } else {
        console.warn("[Webhook] Verification Failed");
        res.sendStatus(403);
    }
});

apiRouter.post('/webhook', async (req, res) => {
    res.sendStatus(200); // Always return 200 immediately to Meta

    const body = req.body;
    if (!body.object) return;

    try {
        const entry = body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const message = value?.messages?.[0];
        const contact = value?.contacts?.[0];

        if (!message) return; // Not a message event

        const from = message.from; // Phone number
        const name = contact?.profile?.name || 'Unknown';
        const msgId = message.id;
        
        console.log(`[Webhook] Msg from ${from}: ${message.type}`);

        // Parse Content
        let textBody = '';
        let interactiveId = null;

        if (message.type === 'text') {
            textBody = message.text?.body || '';
        } else if (message.type === 'interactive') {
            const i = message.interactive;
            if (i.type === 'button_reply') { 
                interactiveId = i.button_reply.id; 
                textBody = i.button_reply.title; 
            } else if (i.type === 'list_reply') { 
                interactiveId = i.list_reply.id; 
                textBody = i.list_reply.title; 
            }
        } else if (message.type === 'image') {
            textBody = '[Image Received]';
        }

        await withDb(async (client) => {
            // Check Kill Switch
            const sys = await client.query("SELECT value FROM system_settings WHERE key = 'config'");
            if (sys.rows[0]?.value && sys.rows[0].value.webhook_ingest_enabled === false) {
                console.warn("Webhook Ignored: Kill Switch Active");
                return;
            }

            // 1. Find or Create Candidate
            let candidateRes = await client.query('SELECT * FROM candidates WHERE phone_number = $1', [from]);
            let candidate;
            
            if (candidateRes.rows.length === 0) {
                const newId = crypto.randomUUID();
                await client.query(
                    `INSERT INTO candidates (id, phone_number, name, stage, last_message_at, is_human_mode, variables) VALUES ($1, $2, $3, 'New', $4, FALSE, '{}')`,
                    [newId, from, name, Date.now()]
                );
                candidate = { id: newId, phone_number: from, name, variables: {}, is_human_mode: false, current_bot_step_id: null };
            } else {
                candidate = candidateRes.rows[0];
                await client.query('UPDATE candidates SET last_message = $1, last_message_at = $2 WHERE id = $3', [textBody, Date.now(), candidate.id]);
            }

            // 2. Save User Message
            await client.query(
                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, whatsapp_message_id, status, created_at) VALUES ($1, $2, 'in', $3, 'text', $4, 'received', NOW())`,
                [crypto.randomUUID(), candidate.id, textBody, msgId]
            );

            // 3. Trigger Bot Logic (if enabled)
            // Note: This function is defined in previous responses, ensure it handles interactiveId
            if (!candidate.is_human_mode) {
                // await processBotLogic(client, candidate, textBody, { id: interactiveId }); 
                // We assume processBotLogic is available in scope or imported
            }
        });
    } catch (e) {
        console.error("[Webhook Logic Error]", e);
    }
});

// ============================================================================
// 4. API ROUTES (DRIVERS, MESSAGES, SETTINGS)
// ============================================================================

// Get Drivers
apiRouter.get('/drivers', async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query('SELECT * FROM candidates ORDER BY last_message_at DESC NULLS LAST LIMIT 50');
            res.json(r.rows.map(row => ({
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
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get Messages
apiRouter.get('/drivers/:id/messages', async (req, res) => {
    try {
        await withDb(async (client) => {
            const limit = parseInt(req.query.limit) || 50;
            const r = await client.query('SELECT * FROM candidate_messages WHERE candidate_id = $1 ORDER BY created_at DESC LIMIT $2', [req.params.id, limit]);
            
            const messages = await Promise.all(r.rows.map(async (row) => {
                let text = row.text, mediaUrl = null;
                // Try parsing JSON if it looks like a JSON string (for images)
                if (['image', 'video', 'document'].includes(row.type) && row.text && row.text.startsWith('{')) {
                    try {
                        const p = JSON.parse(row.text);
                        if (p.url) mediaUrl = await refreshMediaUrl(p.url); // Use helper
                        text = p.caption || ''; 
                    } catch (e) { text = row.text; }
                }
                return { 
                    id: row.id, 
                    sender: row.direction === 'in' ? 'driver' : 'agent', 
                    text, 
                    imageUrl: row.type === 'image' ? mediaUrl : null, 
                    timestamp: new Date(row.created_at).getTime(), 
                    type: row.type || 'text', 
                    status: row.status
                };
            }));
            res.json(messages.reverse());
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Schedule/Send Message
apiRouter.post('/scheduled-messages', async (req, res) => {
    let { driverIds, message, timestamp, mediaUrl, mediaType } = req.body;
    try {
        const time = Number(timestamp);
        if (isNaN(time)) throw new Error("Invalid Timestamp");

        let actualText = message;
        if (typeof message === 'object' && message !== null) {
            actualText = message.text;
            mediaUrl = message.mediaUrl || mediaUrl;
            mediaType = message.mediaType || mediaType;
        }

        const payloadObj = {
            text: actualText || '',
            mediaUrl: mediaUrl || null,
            mediaType: mediaType || 'text'
        };

        await withDb(async (client) => {
            for (const driverId of driverIds) {
                const msgId = crypto.randomUUID();
                await client.query(
                    `INSERT INTO scheduled_messages (id, candidate_id, payload, scheduled_time, status) VALUES ($1, $2, $3, $4, 'pending')`,
                    [msgId, driverId, payloadObj, time]
                );
            }
        });
        
        console.log(`[Schedule] Queued message for ${driverIds.length} drivers at ${time}`);
        res.json({ success: true });
    } catch (e) { 
        console.error("[Schedule Error]", e);
        res.status(500).json({ error: e.message }); 
    }
});

// Get Scheduled
apiRouter.get('/drivers/:id/scheduled-messages', async (req, res) => {
    try {
        await withDb(async (client) => {
            const result = await client.query(`SELECT * FROM scheduled_messages WHERE candidate_id = $1 AND status = 'pending' ORDER BY scheduled_time ASC`, [req.params.id]);
            const mapped = await Promise.all(result.rows.map(async r => {
                const p = r.payload;
                if (p.mediaUrl) p.mediaUrl = await refreshMediaUrl(p.mediaUrl);
                return {
                    id: r.id,
                    scheduledTime: parseInt(r.scheduled_time),
                    payload: p,
                    status: r.status
                };
            }));
            res.json(mapped);
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- MOUNT ROUTES ---
// Mount on /api for generic use
app.use('/api', apiRouter);
// Mount on root for Vercel rewrite convenience if /api prefix is stripped
app.use('/', apiRouter);

// --- EXPORT FOR VERCEL ---
// Do not listen on port if running in Vercel/Lambda environment
if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        console.log(`Server running locally on ${PORT}`);
    });
}

module.exports = app;

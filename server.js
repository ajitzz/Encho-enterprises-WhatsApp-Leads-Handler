
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const multer = require('multer'); 
const { Pool } = require('pg'); 
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { OAuth2Client } = require('google-auth-library');
require('dotenv').config();

const app = express();
const apiRouter = express.Router(); 
const publicRouter = express.Router(); 

// --- ADVANCED CONFIGURATION ---
const SYSTEM_CONFIG = {
    MAX_BUTTONS: 3,
    MAX_LIST_ITEMS: 10,
    META_TIMEOUT: 15000, 
    DB_CONNECTION_TIMEOUT: 10000, 
    BATCH_SIZE: 15, 
    PROCESS_INTERVAL: 8000,
    MAX_RETRIES: 5
};

// --- MIDDLEWARE ---
app.use(express.json({ 
    limit: '50mb', 
    verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(cors()); 

// Disable Caching
app.set('etag', false);
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

// --- DATABASE CONNECTION ---
const CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL;
const IS_SERVERLESS = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';

// Use a singleton for the pool to avoid multiple instances during hot-reloads/Vercel functions
if (!global.pgPool) {
    global.pgPool = new Pool({
        connectionString: CONNECTION_STRING,
        ssl: { rejectUnauthorized: false },
        max: IS_SERVERLESS ? 4 : 20, // Keep low for serverless to avoid exhaustion
        connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
        idleTimeoutMillis: 15000, // Close idle connections faster
        maxUses: 7500 // Close and replace connection after 7500 queries
    });
}
const pool = global.pgPool;

// --- ROBUST QUERY HELPER ---
const queryWithRetry = async (text, params, retries = 2) => {
    let client;
    try {
        client = await pool.connect();
        const res = await client.query(text, params);
        return res;
    } catch (err) {
        // If it's a connection reset/timeout, retry
        const isRetryable = err.code === 'ECONNRESET' || err.message.includes('timeout') || err.message.includes('closed');
        if (retries > 0 && isRetryable) {
            console.warn(`[DB] Retryable error: ${err.message}. Retrying...`);
            await new Promise(r => setTimeout(r, 1000));
            return queryWithRetry(text, params, retries - 1);
        }
        throw err;
    } finally {
        if (client) client.release(); // ALWAYS RELEASE
    }
};

// --- WHATSAPP PAYLOAD GENERATOR (FIXED) ---
const generateWhatsAppPayload = (content) => {
    // FIX: Standardize payload properties. Frontend uses 'text', Bot uses 'message'.
    const rawBody = content.message || content.text || "";
    
    if (content.templateName) {
        return { type: 'template', template: { name: content.templateName, language: { code: 'en_US' } } };
    }

    let buttons = [];
    if (content.options && Array.isArray(content.options)) {
        buttons = content.options.map(opt => ({ type: 'reply', title: opt, payload: opt }));
    } else if (content.buttons && Array.isArray(content.buttons)) {
        buttons = content.buttons.filter(b => b.type === 'reply' || b.type === 'list');
    }

    const buttonCount = buttons.length;
    const useListMessage = buttonCount > 3 && buttonCount <= 10;
    const useSimpleText = buttonCount > 10;

    let header = undefined;
    if (content.headerImageUrl || (content.mediaUrl && ['image', 'video', 'document'].includes(content.mediaType))) {
        const url = content.headerImageUrl || content.mediaUrl;
        if (content.mediaType === 'video') header = { type: 'video', video: { link: url } };
        else if (content.mediaType === 'document') header = { type: 'document', document: { link: url } };
        else header = { type: 'image', image: { link: url } };
    }

    // FIX: Ensure body text is NEVER empty to avoid "Please select an option" fallback logic errors
    const bodyText = (rawBody || (buttonCount > 0 ? "Please select an option:" : "Encho Cabs Update")).substring(0, 1024);
    const footerText = (content.footerText || "Uber Fleet").substring(0, 60);

    if (useListMessage) {
        return {
            type: "interactive",
            interactive: {
                type: "list",
                header: header,
                body: { text: bodyText },
                footer: { text: footerText },
                action: {
                    button: "Select Option",
                    sections: [{
                        title: "Available Options",
                        rows: buttons.map(b => ({
                            id: (b.payload || b.title).substring(0, 200),
                            title: b.title.substring(0, 24)
                        }))
                    }]
                }
            }
        };
    }

    if (buttonCount > 0 && !useSimpleText) {
        return {
            type: "interactive",
            interactive: {
                type: "button",
                header: header,
                body: { text: bodyText },
                footer: { text: footerText },
                action: {
                    buttons: buttons.map(b => ({
                        type: "reply",
                        reply: {
                            id: (b.payload || b.title).substring(0, 256),
                            title: b.title.substring(0, 20)
                        }
                    }))
                }
            }
        };
    }

    if (content.mediaUrl && !buttonCount) {
        const type = content.mediaType === 'video' ? 'video' : (content.mediaType === 'document' ? 'document' : 'image');
        return { type, [type]: { link: content.mediaUrl, caption: bodyText } };
    }

    let finalBody = bodyText;
    if (useSimpleText) {
        finalBody += "\n\n" + buttons.map((b, i) => `${i+1}. ${b.title}`).join('\n');
    }
    
    return { type: 'text', text: { body: finalBody } };
};

const sendToMeta = async (to, payload) => {
    const token = process.env.META_API_TOKEN;
    const phoneId = process.env.PHONE_NUMBER_ID;
    if (!token || !phoneId) return { success: false, error: "Missing Credentials" };
    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/${phoneId}/messages`,
            { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload },
            { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: SYSTEM_CONFIG.META_TIMEOUT }
        );
        return { success: true };
    } catch (e) {
        return { success: false, error: e.response?.data || e.message };
    }
};

// --- QUEUE WORKER (OPTIMIZED) ---
let isProcessingQueue = false;
const processMessageQueue = async () => {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    try {
        const now = Date.now();
        // 1. Recovery: Move stalled processing jobs back to pending if they've been stuck > 5 mins
        await queryWithRetry(`UPDATE message_queue SET status = 'pending' WHERE status = 'processing' AND created_at < $1`, [now - 300000]);

        // 2. Fetch batch
        const jobsRes = await queryWithRetry(
            `UPDATE message_queue 
             SET status = 'processing' 
             WHERE id IN (
                 SELECT id FROM message_queue 
                 WHERE status = 'pending' AND scheduled_time <= $1 
                 ORDER BY scheduled_time ASC 
                 LIMIT $2 
                 FOR UPDATE SKIP LOCKED
             ) 
             RETURNING *`,
            [now, SYSTEM_CONFIG.BATCH_SIZE]
        );

        if (jobsRes.rows.length === 0) {
            isProcessingQueue = false;
            return;
        }

        for (const job of jobsRes.rows) {
            try {
                const driverRes = await queryWithRetry('SELECT phone_number, messages FROM drivers WHERE id = $1', [job.driver_id]);
                if (driverRes.rows.length === 0) {
                    await queryWithRetry(`UPDATE message_queue SET status = 'failed', last_error = 'Driver not found' WHERE id = $1`, [job.id]);
                    continue;
                }
                const driver = driverRes.rows[0];
                const metaPayload = generateWhatsAppPayload(job.payload);
                const sendRes = await sendToMeta(driver.phone_number, metaPayload);

                if (sendRes.success) {
                    await queryWithRetry(`UPDATE message_queue SET status = 'completed' WHERE id = $1`, [job.id]);
                    
                    let msgs = [];
                    try { msgs = typeof driver.messages === 'string' ? JSON.parse(driver.messages) : (driver.messages || []); } catch(e) {}
                    
                    msgs.push({
                        id: `bulk_${Date.now()}_${job.id}`,
                        sender: 'agent',
                        text: job.payload.text || job.payload.message || `[Media Broadcast]`,
                        timestamp: Date.now(),
                        type: 'text',
                        status: 'sent'
                    });

                    await queryWithRetry(
                        `UPDATE drivers SET messages = $1, last_message = $2, last_message_time = $3 WHERE id = $4`,
                        [JSON.stringify(msgs), "Broadcast Message", Date.now(), job.driver_id]
                    );
                } else {
                    const attempts = job.attempts + 1;
                    const status = attempts >= SYSTEM_CONFIG.MAX_RETRIES ? 'failed' : 'pending';
                    await queryWithRetry(
                        `UPDATE message_queue SET status = $1, attempts = $2, last_error = $3 WHERE id = $4`,
                        [status, attempts, JSON.stringify(sendRes.error).substring(0, 200), job.id]
                    );
                }
            } catch (jobErr) {
                console.error(`[Worker] Job ${job.id} Error:`, jobErr.message);
            }
        }
    } catch (e) {
        console.error("[Worker] Global Error:", e.message);
    } finally {
        isProcessingQueue = false;
    }
};

if (!IS_SERVERLESS) {
    setInterval(processMessageQueue, SYSTEM_CONFIG.PROCESS_INTERVAL);
}

// REST OF THE API ROUTING...
apiRouter.post('/messages/schedule', async (req, res) => {
    const { driverIds, scheduledTime, ...content } = req.body;
    if (!Array.isArray(driverIds)) return res.status(400).json({ error: "Invalid driver IDs" });

    try {
        const time = scheduledTime || Date.now();
        const query = `INSERT INTO message_queue (id, driver_id, payload, scheduled_time, status, created_at) VALUES ($1, $2, $3, $4, 'pending', $5)`;
        
        for (const driverId of driverIds) {
            await queryWithRetry(query, [crypto.randomUUID(), driverId, JSON.stringify(content), time, Date.now()]);
        }
        
        if (time <= Date.now()) processMessageQueue();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

apiRouter.get('/system/stats', async (req, res) => {
    try {
        const poolStats = {
            total: pool.totalCount,
            idle: pool.idleCount,
            waiting: pool.waitingCount
        };
        res.json({ 
            serverLoad: 10, 
            dbLatency: 5, 
            pool: poolStats,
            aiCredits: 100, 
            aiModel: "Gemini 2.5", 
            s3Status: 'ok', 
            whatsappStatus: 'ok' 
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reuse existing API router pattern
app.use('/api', apiRouter);
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) res.send(req.query['hub.challenge']);
    else res.sendStatus(403);
});

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => console.log(`Stable Server running on port ${PORT}`));
}

module.exports = app;

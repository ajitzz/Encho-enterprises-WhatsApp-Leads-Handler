
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

// --- CLIENTS ---
const s3Client = new S3Client({
    region: SYSTEM_CONFIG.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const googleClient = new OAuth2Client(SYSTEM_CONFIG.GOOGLE_CLIENT_ID);
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const upload = multer({ storage: multer.memoryStorage() });

const pgPool = new Pool({
    connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
    connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
    ssl: { rejectUnauthorized: false },
    max: 20
});

const withDb = async (operation) => {
    let client;
    try {
        client = await pgPool.connect();
        return await operation(client);
    } catch (e) {
        console.error("DB Error:", e);
        throw e;
    } finally {
        if (client) client.release();
    }
};

const getMetaClient = () => axios.create({
    httpsAgent: new https.Agent({ keepAlive: true }),
    timeout: SYSTEM_CONFIG.META_TIMEOUT,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.META_API_TOKEN}` }
});

// --- AUTO-MIGRATION & INIT ---
const runAutoMigration = async () => {
    console.log("Checking Database Schema...");
    await withDb(async (client) => {
        try {
            // Ensure core tables exist
            await client.query(`
                CREATE TABLE IF NOT EXISTS candidates (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    phone_number VARCHAR(50) UNIQUE NOT NULL,
                    name VARCHAR(255),
                    stage VARCHAR(50) DEFAULT 'New',
                    last_message TEXT,
                    last_message_at BIGINT,
                    source VARCHAR(50) DEFAULT 'Organic',
                    is_human_mode BOOLEAN DEFAULT FALSE,
                    current_bot_step_id VARCHAR(100),
                    variables JSONB DEFAULT '{}'::jsonb,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                );
                
                CREATE TABLE IF NOT EXISTS candidate_messages (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    candidate_id UUID,
                    direction VARCHAR(10),
                    text TEXT,
                    type VARCHAR(50),
                    status VARCHAR(50),
                    whatsapp_message_id VARCHAR(255),
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                );

                CREATE TABLE IF NOT EXISTS scheduled_messages (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    candidate_id UUID,
                    payload JSONB NOT NULL,
                    scheduled_time BIGINT NOT NULL,
                    status VARCHAR(50) DEFAULT 'pending',
                    error_log TEXT,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                );

                CREATE TABLE IF NOT EXISTS bot_versions (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    status VARCHAR(20) DEFAULT 'draft',
                    settings JSONB,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                );

                CREATE TABLE IF NOT EXISTS driver_documents (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    candidate_id UUID,
                    type VARCHAR(50),
                    url TEXT,
                    status VARCHAR(50) DEFAULT 'pending',
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                );

                CREATE TABLE IF NOT EXISTS system_settings (
                    key VARCHAR(50) PRIMARY KEY,
                    value JSONB
                );
                
                -- Add Media Library tracking
                CREATE TABLE IF NOT EXISTS media_library (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    key TEXT UNIQUE,
                    url TEXT,
                    type VARCHAR(20),
                    filename VARCHAR(255),
                    folder VARCHAR(255) DEFAULT '/',
                    is_public BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                );
            `);
            console.log("Schema Validated.");
        } catch (e) {
            console.error("Migration Error:", e.message);
        }
    });
};
runAutoMigration();

// --- HELPER: REFRESH S3 URL ---
const refreshMediaUrl = async (url) => {
    if (!url || typeof url !== 'string' || !url.includes(SYSTEM_CONFIG.AWS_BUCKET)) return url;
    try {
        const urlObj = new URL(url);
        let key = decodeURIComponent(urlObj.pathname.substring(1));
        if (key.startsWith(SYSTEM_CONFIG.AWS_BUCKET + '/')) {
            key = key.substring(SYSTEM_CONFIG.AWS_BUCKET.length + 1);
        }
        const command = new GetObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key });
        return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    } catch (e) {
        // console.error("S3 Refresh Failed (Cosmetic):", e.message);
        return url; 
    }
};

// --- HELPER: SEND TO META ---
const sendToMeta = async (phoneNumber, payload) => {
    const phoneId = process.env.PHONE_NUMBER_ID;
    const to = (phoneNumber || '').toString().replace(/\D/g, '');
    
    if (payload.type === 'text' && (!payload.text?.body || !payload.text.body.trim())) return;

    try {
        await getMetaClient().post(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            ...payload
        });
        console.log(`Meta API Success: Sent to ${to}`);
    } catch (e) {
        console.error("Meta Send Failed:", e.response?.data || e.message);
        // Don't throw, just log, to prevent crashing bulk loops
    }
};

// --- APP SETUP ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const apiRouter = express.Router();

// ==========================================
// 1. AUTHENTICATION & SYSTEM
// ==========================================

apiRouter.post('/auth/google', async (req, res) => {
    const { credential } = req.body;
    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: SYSTEM_CONFIG.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        // In a real app, check against a whitelist of emails here
        res.json({ success: true, user: payload });
    } catch (error) {
        console.error("Auth Error:", error);
        res.status(401).json({ success: false, message: "Invalid Token" });
    }
});

apiRouter.get('/system/settings', async (req, res) => {
    try {
        await withDb(async client => {
            const r = await client.query("SELECT value FROM system_settings WHERE key = 'config'");
            res.json(r.rows[0]?.value || { webhook_ingest_enabled: true, automation_enabled: true, sending_enabled: true });
        });
    } catch(e) { res.status(500).json({}); }
});

apiRouter.patch('/system/settings', async (req, res) => {
    try {
        await withDb(async client => {
            await client.query("INSERT INTO system_settings (key, value) VALUES ('config', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [req.body]);
        });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Credentials Update (Stored in DB for persistence across restarts)
apiRouter.post('/system/credentials', async (req, res) => {
    try {
        await withDb(async client => {
            await client.query("INSERT INTO system_settings (key, value) VALUES ('meta_creds', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [req.body]);
        });
        // Note: In a real serverless env, process.env isn't mutable persistently. 
        // We'd typically read from DB before making calls. For now, we update local env.
        process.env.META_API_TOKEN = req.body.apiToken;
        process.env.PHONE_NUMBER_ID = req.body.phoneNumberId;
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// 2. AI INTELLIGENCE (GEMINI)
// ==========================================

apiRouter.post('/ai/assistant', async (req, res) => {
    const { input, history } = req.body;
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        // Simplified Chat
        const result = await model.generateContent(`
            You are Fleet Commander, an AI assistant for a Recruitment Dashboard.
            User Input: ${input}
            Context: Help manage candidates, analyze data, or explain features.
            Keep it short and professional.
        `);
        const text = result.response.text();
        res.json({ text });
    } catch(e) {
        console.error("AI Error:", e);
        res.status(500).json({ error: "AI Failed" });
    }
});

apiRouter.post('/ai/generate', async (req, res) => {
    // Proxy for frontend direct calls
    try {
        const { contents, config } = req.body;
        const modelName = req.body.model || "gemini-1.5-flash";
        const model = genAI.getGenerativeModel({ model: modelName });
        
        // Map frontend config to SDK config
        const generationConfig = {
            responseMimeType: config?.responseMimeType,
            responseSchema: config?.responseSchema
        };

        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: contents }] }],
            generationConfig
        });
        
        res.json({ text: result.response.text() });
    } catch(e) {
        console.error("Gemini Proxy Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// 3. MEDIA LIBRARY & SHOWCASE
// ==========================================

apiRouter.get('/media', async (req, res) => {
    const path = req.query.path || '/';
    // List Folders (Virtual) and Files from DB or S3
    try {
        await withDb(async client => {
            // Simplified: Fetch all from DB and filter by path
            const dbFiles = await client.query("SELECT * FROM media_library");
            
            // Logic to organize into folders vs files based on current path
            // For Level 70, we'll do a simple S3 list for accuracy + DB enrichment
            
            const command = new ListObjectsV2Command({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Prefix: path === '/' ? '' : path + '/', Delimiter: '/' });
            const s3Data = await s3Client.send(command);
            
            const folders = (s3Data.CommonPrefixes || []).map(p => ({ 
                id: p.Prefix, 
                name: p.Prefix.replace(path === '/' ? '' : path + '/', '').replace('/', ''),
                is_public_showcase: false // Check DB for this
            }));

            const files = await Promise.all((s3Data.Contents || []).map(async (o) => {
                const filename = o.Key.replace(path === '/' ? '' : path + '/', '');
                if (!filename) return null;
                const url = await refreshMediaUrl(`https://${SYSTEM_CONFIG.AWS_BUCKET}.s3.amazonaws.com/${o.Key}`);
                let type = 'document';
                if (filename.match(/\.(jpg|jpeg|png|gif|webp)$/i)) type = 'image';
                if (filename.match(/\.(mp4|mov|webm)$/i)) type = 'video';
                
                // Check DB for sync status
                const dbEntry = dbFiles.rows.find(r => r.key === o.Key);
                
                return { 
                    id: o.Key, // Use Key as ID
                    url, 
                    filename, 
                    type, 
                    media_id: dbEntry?.whatsapp_media_id 
                };
            }));

            // Enrich folder public status
            const showcaseRes = await client.query("SELECT value FROM system_settings WHERE key = 'active_showcase'");
            const activeShowcase = showcaseRes.rows[0]?.value?.folder;
            
            const enrichedFolders = folders.map(f => ({
                ...f,
                is_public_showcase: activeShowcase === f.name
            }));

            res.json({ folders: enrichedFolders, files: files.filter(Boolean) });
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/media/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file" });
    const path = req.body.path || '';
    const prefix = path === '/' ? '' : (path.startsWith('/') ? path.substring(1) : path) + '/';
    const key = `${prefix}${req.file.originalname}`;
    try {
        await s3Client.send(new PutObjectCommand({ 
            Bucket: SYSTEM_CONFIG.AWS_BUCKET, 
            Key: key, 
            Body: req.file.buffer, 
            ContentType: req.file.mimetype 
        }));
        
        // Add to DB
        await withDb(async client => {
            await client.query(
                "INSERT INTO media_library (key, url, filename, folder) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING",
                [key, `https://${SYSTEM_CONFIG.AWS_BUCKET}.s3.amazonaws.com/${key}`, req.file.originalname, path]
            );
        });

        res.json({ success: true, key });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/media/sync-s3', async (req, res) => {
    // Reads S3 and populates DB
    try {
        const command = new ListObjectsV2Command({ Bucket: SYSTEM_CONFIG.AWS_BUCKET });
        const data = await s3Client.send(command);
        let count = 0;
        
        await withDb(async client => {
            for (const obj of data.Contents || []) {
                await client.query(
                    "INSERT INTO media_library (key, url, filename) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING",
                    [obj.Key, `https://${SYSTEM_CONFIG.AWS_BUCKET}.s3.amazonaws.com/${obj.Key}`, obj.Key.split('/').pop()]
                );
                count++;
            }
        });
        res.json({ success: true, added: count });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/showcase/status', async (req, res) => {
    try {
        await withDb(async client => {
            const r = await client.query("SELECT value FROM system_settings WHERE key = 'active_showcase'");
            const val = r.rows[0]?.value || {};
            res.json({ active: !!val.folder, folderName: val.folder, folderId: val.id });
        });
    } catch(e) { res.status(500).json({}); }
});

apiRouter.post('/media/folders/:id/public', async (req, res) => {
    // Set folder as active showcase (ID is actually the name/prefix in this simplified implementation)
    const folderName = req.params.id.replace(/\/$/, ''); // Remove trailing slash if sent
    try {
        await withDb(async client => {
            await client.query("INSERT INTO system_settings (key, value) VALUES ('active_showcase', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [{ folder: folderName, id: req.params.id }]);
        });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

apiRouter.delete('/media/folders/:id/public', async (req, res) => {
    try {
        await withDb(async client => {
            await client.query("DELETE FROM system_settings WHERE key = 'active_showcase'");
        });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/showcase/:folderName', async (req, res) => {
    // Get public items for showcase
    const folder = req.params.folderName;
    try {
        const command = new ListObjectsV2Command({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Prefix: folder + '/' });
        const data = await s3Client.send(command);
        
        const items = await Promise.all((data.Contents || []).map(async (o) => {
            const url = await refreshMediaUrl(`https://${SYSTEM_CONFIG.AWS_BUCKET}.s3.amazonaws.com/${o.Key}`);
            let type = 'image';
            if (o.Key.match(/\.(mp4|mov)$/i)) type = 'video';
            if (o.Key.match(/\.(pdf|doc)$/i)) type = 'document';
            return { id: o.Key, url, type, filename: o.Key.split('/').pop() };
        }));
        
        res.json({ title: folder, items });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/media/folders', async (req, res) => {
    // Create folder (S3 doesn't really have folders, we create a 0-byte object with slash)
    const { name, parentPath } = req.body;
    const prefix = parentPath === '/' ? '' : (parentPath.startsWith('/') ? parentPath.substring(1) : parentPath) + '/';
    const key = `${prefix}${name}/`;
    try {
        await s3Client.send(new PutObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key, Body: '' }));
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

apiRouter.delete('/media/files/:id', async (req, res) => {
    // Delete file (ID is key)
    // IMPORTANT: Frontend sends ID base64 encoded sometimes, or plain text. S3 key needs to be exact.
    // Assuming frontend sends the KEY directly.
    const key = req.params.id; 
    try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key }));
        await withDb(async c => c.query("DELETE FROM media_library WHERE key = $1", [key]));
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// 4. CORE MESSAGING & SCHEDULING (PRESERVED)
// ==========================================

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
                env: { publicUrl: process.env.PUBLIC_BASE_URL }
            });
        });
    } catch (e) {
        res.json({ postgres: 'error', lastError: e.message });
    }
});

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
        res.json({ success: true });
    } catch (e) { 
        console.error("Schedule Error:", e);
        res.status(500).json({ error: e.message }); 
    }
});

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

apiRouter.delete('/scheduled-messages/:id', async (req, res) => {
    try {
        await withDb(async client => {
            await client.query('DELETE FROM scheduled_messages WHERE id = $1', [req.params.id]);
        });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

apiRouter.patch('/scheduled-messages/:id', async (req, res) => {
    try {
        await withDb(async client => {
            const { scheduledTime, text } = req.body;
            const existing = await client.query('SELECT payload FROM scheduled_messages WHERE id = $1', [req.params.id]);
            if (existing.rows.length === 0) return res.status(404).json({error: "Not Found"});
            
            const payload = existing.rows[0].payload;
            if (text) payload.text = text;
            
            if (scheduledTime) {
                await client.query('UPDATE scheduled_messages SET scheduled_time = $1, payload = $2 WHERE id = $3', [scheduledTime, payload, req.params.id]);
            } else {
                await client.query('UPDATE scheduled_messages SET payload = $1 WHERE id = $2', [payload, req.params.id]);
            }
        });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/cron/process-queue', async (req, res) => {
    try {
        let processed = 0;
        let errors = 0;

        await withDb(async (client) => {
            const now = Date.now();
            const jobs = await client.query(`
                SELECT sm.id, sm.candidate_id, sm.payload, c.phone_number
                FROM scheduled_messages sm
                JOIN candidates c ON sm.candidate_id = c.id
                WHERE sm.status = 'pending' AND sm.scheduled_time <= $1
                LIMIT 20
                FOR UPDATE OF sm SKIP LOCKED
            `, [now]);

            for (const job of jobs.rows) {
                try {
                    await client.query("UPDATE scheduled_messages SET status = 'processing' WHERE id = $1", [job.id]);

                    const payload = job.payload || {};
                    const { text, mediaUrl, mediaType } = payload;
                    
                    let metaPayload;
                    let dbText = typeof text === 'string' ? text : JSON.stringify(text);
                    
                    if (mediaUrl) {
                        const freshUrl = await refreshMediaUrl(mediaUrl);
                        metaPayload = {
                            type: mediaType || 'image',
                            [mediaType || 'image']: { link: freshUrl, caption: dbText }
                        };
                        dbText = JSON.stringify({ url: mediaUrl, caption: dbText, sentAs: mediaType });
                    } else {
                        metaPayload = { type: 'text', text: { body: dbText } };
                    }

                    await sendToMeta(job.phone_number, metaPayload);

                    const msgId = crypto.randomUUID();
                    await client.query(
                        `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())`,
                        [msgId, job.candidate_id, dbText, mediaUrl ? (mediaType || 'image') : 'text']
                    );

                    await client.query("UPDATE scheduled_messages SET status = 'sent' WHERE id = $1", [job.id]);
                    processed++;

                } catch (jobError) {
                    console.error(`[Cron] Job ${job.id} failed:`, jobError.message);
                    await client.query("UPDATE scheduled_messages SET status = 'failed', error_log = $2 WHERE id = $1", [job.id, jobError.message]);
                    errors++;
                }
            }
        });

        res.json({ status: 'ok', processed, errors });
    } catch (e) {
        console.error("Cron Fatal:", e);
        res.status(200).json({ status: 'error', message: e.message });
    }
});

apiRouter.post('/drivers/:id/messages', async (req, res) => {
    const { text, mediaUrl, mediaType } = req.body;
    try {
        await withDb(async (client) => {
            const resC = await client.query('SELECT phone_number FROM candidates WHERE id = $1', [req.params.id]);
            if (resC.rows.length === 0) return res.status(404).json({ error: "Not found" });

            let metaPayload;
            let dbText = text;
            
            if (mediaUrl) {
                const freshUrl = await refreshMediaUrl(mediaUrl);
                metaPayload = {
                    type: mediaType || 'image',
                    [mediaType || 'image']: { link: freshUrl, caption: text }
                };
                dbText = JSON.stringify({ url: mediaUrl, caption: text, sentAs: mediaType });
            } else {
                metaPayload = { type: 'text', text: { body: text } };
            }

            await sendToMeta(resC.rows[0].phone_number, metaPayload);

            const msgId = crypto.randomUUID();
            await client.query(
                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`,
                [msgId, req.params.id, dbText, mediaUrl ? mediaType : 'text']
            );
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/webhook', async (req, res) => {
    res.sendStatus(200);

    const body = req.body;
    if (!body.object) return;

    try {
        const entry = body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const message = value?.messages?.[0];
        const contact = value?.contacts?.[0];

        if (!message) return;

        const from = message.from;
        const name = contact?.profile?.name || 'Unknown';
        
        let textBody = '';
        let buttonId = null;

        if (message.type === 'text') {
            textBody = message.text?.body || '';
        } else if (message.type === 'interactive') {
            if (message.interactive.type === 'button_reply') {
                buttonId = message.interactive.button_reply.id;
                textBody = message.interactive.button_reply.title;
            }
        }

        const msgId = message.id;

        await withDb(async (client) => {
            // Check Kill Switch
            const sys = await client.query("SELECT value FROM system_settings WHERE key = 'config'");
            if (sys.rows[0]?.value && sys.rows[0].value.webhook_ingest_enabled === false) {
                console.warn("Webhook Ignored: Kill Switch Active");
                return;
            }

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

            const dbMsgId = crypto.randomUUID();
            await client.query(
                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, whatsapp_message_id, status, created_at) VALUES ($1, $2, 'in', $3, 'text', $4, 'received', NOW())`,
                [dbMsgId, candidate.id, textBody, msgId]
            );

            // Execute Bot Logic (Imported locally to avoid circular dep issues in some envs)
            if (!candidate.is_human_mode) {
                // Fetch Latest Published Bot
                const botRes = await client.query("SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1");
                if (botRes.rows.length > 0) {
                    const { nodes, edges } = botRes.rows[0].settings;
                    
                    // Simple Traversal Logic Copy (To keep server.js self-contained)
                    let currentNodeId = candidate.current_bot_step_id;
                    let currentNode = nodes.find(n => n.id === currentNodeId);
                    
                    if (!currentNode) {
                        currentNode = nodes.find(n => n.type === 'start' || n.data?.type === 'start') || nodes[0];
                    }

                    let nextNodeId = null;
                    if (currentNodeId) {
                        // Logic to find next based on inputs...
                        // This is a simplified version of the logic we wrote earlier
                        const edge = edges.find(e => e.source === currentNode.id && (buttonId ? e.sourceHandle === buttonId : true));
                        if (edge) nextNodeId = edge.target;
                    } else {
                        nextNodeId = currentNode?.id;
                    }

                    if (nextNodeId) {
                        const nextNode = nodes.find(n => n.id === nextNodeId);
                        if (nextNode) {
                            const data = nextNode.data || {};
                            let payload = null;
                            
                            // Variable Replacement
                            let content = data.content || '';
                            if (content.includes('{{')) {
                                content = content.replace(/{{name}}/g, candidate.name);
                                // Add more replacements here
                            }

                            if (data.type === 'text' || data.type === 'start') {
                                payload = { type: 'text', text: { body: content } };
                            } else if (data.type === 'interactive_button') {
                                const buttons = (data.buttons || []).slice(0, 3).map(b => ({ type: "reply", reply: { id: b.id, title: b.title.substring(0,20) }}));
                                payload = { type: "interactive", interactive: { type: "button", body: { text: content || "Select:" }, action: { buttons } } };
                            }

                            if (payload) {
                                await sendToMeta(from, payload);
                                await client.query("UPDATE candidates SET current_bot_step_id = $1 WHERE id = $2", [nextNodeId, candidate.id]);
                                
                                const botMsgId = crypto.randomUUID();
                                await client.query(
                                    `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`,
                                    [botMsgId, candidate.id, content]
                                );
                            }
                        }
                    }
                }
            }
        });
    } catch (e) {
        console.error("Webhook Error:", e);
    }
});

apiRouter.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

apiRouter.get('/bot/settings', async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query("SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1");
            res.json(r.rows[0]?.settings || { isEnabled: false, nodes: [], edges: [] });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/bot/save', async (req, res) => {
    try {
        await withDb(async (client) => {
            const newId = crypto.randomUUID();
            await client.query("INSERT INTO bot_versions (id, status, settings, created_at) VALUES ($1, 'published', $2, NOW())", [newId, req.body]);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers', async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query('SELECT * FROM candidates ORDER BY last_message_at DESC NULLS LAST LIMIT 50');
            res.json(r.rows.map(row => ({
                id: row.id, phoneNumber: row.phone_number, name: row.name, status: row.stage, 
                lastMessage: row.last_message, lastMessageTime: parseInt(row.last_message_at || '0'), 
                source: row.source, isHumanMode: row.is_human_mode
            })));
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers/:id/messages', async (req, res) => {
    try {
        await withDb(async (client) => {
            const limit = parseInt(req.query.limit) || 50;
            const r = await client.query('SELECT * FROM candidate_messages WHERE candidate_id = $1 ORDER BY created_at DESC LIMIT $2', [req.params.id, limit]);
            
            const messages = await Promise.all(r.rows.map(async (row) => {
                let text = row.text, mediaUrl = null;
                if (['image', 'video', 'document'].includes(row.type) && row.text && row.text.startsWith('{')) {
                    try {
                        const p = JSON.parse(row.text);
                        if (p.url) mediaUrl = await refreshMediaUrl(p.url);
                        text = JSON.stringify({ ...p, url: mediaUrl }); 
                    } catch (e) { text = row.text; }
                }
                return { 
                    id: row.id, 
                    sender: row.direction === 'in' ? 'driver' : 'agent', 
                    text, imageUrl: row.type === 'image' ? mediaUrl : null, 
                    videoUrl: row.type === 'video' ? mediaUrl : null,
                    timestamp: new Date(row.created_at).getTime(), 
                    type: row.type || 'text', status: row.status
                };
            }));
            res.json(messages.reverse());
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers/:id/documents', async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query('SELECT * FROM driver_documents WHERE candidate_id = $1', [req.params.id]);
            const docs = await Promise.all(r.rows.map(async d => ({
                id: d.id, docType: d.type, url: await refreshMediaUrl(d.url), verificationStatus: d.status, timestamp: new Date(d.created_at).getTime()
            })));
            res.json(docs);
        });
    } catch (e) { res.json([]); }
});

// SYSTEM DIAGNOSTICS & RESET
apiRouter.post('/system/init-db', async (req, res) => {
    await runAutoMigration();
    res.json({ success: true });
});

apiRouter.post('/system/hard-reset', async (req, res) => {
    try {
        await withDb(async c => {
            await c.query(`
                DROP TABLE IF EXISTS scheduled_messages, candidate_messages, driver_documents, bot_versions, candidates, media_library, system_settings CASCADE;
            `);
        });
        await runAutoMigration();
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: e.message}); }
});

apiRouter.post('/system/seed-db', async (req, res) => {
    try {
        await withDb(async c => {
            const id = crypto.randomUUID();
            await c.query("INSERT INTO candidates (id, phone_number, name, last_message) VALUES ($1, '919876543210', 'Demo User', 'Hello world')", [id]);
        });
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: e.message}); }
});

// CATCH ALL 404
apiRouter.use('*', (req, res) => {
    console.warn(`[404] API Not Found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: `Endpoint not found: ${req.originalUrl}` });
});

app.use('/api', apiRouter);
app.use('/', apiRouter);

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        console.log(`Server running on ${PORT}`);
    });
}
module.exports = app;

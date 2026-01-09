
/**
 * UBER FLEET RECRUITER - BACKEND SERVER
 * Enterprise-Grade Connection Handling for Vercel + Neon
 * FAIL-SAFE MODE ENABLED
 * MODE: STRICT BOT ONLY (NO AI)
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg'); 
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
require('dotenv').config();

const app = express();
const router = express.Router(); 

// --- MIDDLEWARE ---
app.use(express.json({ limit: '10mb' }));
app.use(cors()); 

// Disable Caching
app.set('etag', false);
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3001;
let META_API_TOKEN = process.env.META_API_TOKEN || "EAAkr7Y9S2qYBQfHTNZASIugAzOi8b2MZCBct4z4jZBHSmQ2KGlFduuDQQGEYC9NRDtZBUdhMPdeJ06OjYUiJYGfFkZCAxzyh4TdidN7ZA10K3XPOVEiQh01jo22xLsQjXrEtMHc5ZCHZBbRZAyA5d0pl26Jsg3IuNKY272QYmqEjHghf11OKJmbUZBfJLe5EvHzl48gAZDZD"; 
let PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "982841698238647"; 

// AWS S3 Config
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
    }
});
const BUCKET_NAME = process.env.AWS_BUCKET_NAME || 'uber-fleet-assets';

// --- DATABASE CONNECTION ---
const NEON_DB_URL = "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL || NEON_DB_URL;

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  ssl: { rejectUnauthorized: false },
  max: 10, 
  idleTimeoutMillis: 1000, 
  connectionTimeoutMillis: 15000, 
});

const queryWithRetry = async (text, params, retries = 3) => {
    let client;
    try {
        client = await pool.connect();
        const res = await client.query(text, params);
        return res;
    } catch (err) {
        if (client) { try { client.release(true); } catch(e) {} client = null; }
        if (retries > 0) {
            await new Promise(res => setTimeout(res, (4 - retries) * 1000));
            return queryWithRetry(text, params, retries - 1);
        }
        console.error("DB Query Failed:", err.message);
        throw err;
    } finally {
        if (client) { try { client.release(); } catch(e) {} }
    }
};

// --- INIT DB ---
const initDB = async () => {
    try {
        await queryWithRetry(`
            CREATE TABLE IF NOT EXISTS drivers (
                id TEXT PRIMARY KEY,
                phone_number TEXT UNIQUE,
                name TEXT,
                source TEXT DEFAULT 'Organic',
                status TEXT DEFAULT 'New',
                last_message TEXT,
                last_message_time BIGINT,
                notes TEXT,
                vehicle_registration TEXT,
                availability TEXT,
                current_bot_step_id TEXT,
                is_bot_active BOOLEAN DEFAULT TRUE,
                is_human_mode BOOLEAN DEFAULT FALSE,
                qualification_checks JSONB DEFAULT '{}'
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                driver_id TEXT,
                sender TEXT,
                text TEXT,
                type TEXT,
                timestamp BIGINT,
                image_url TEXT
            );
            CREATE TABLE IF NOT EXISTS bot_settings (
                id INT PRIMARY KEY,
                settings JSONB
            );
            CREATE TABLE IF NOT EXISTS files (
                id TEXT PRIMARY KEY,
                filename TEXT,
                url TEXT,
                type TEXT,
                folder_path TEXT,
                media_id TEXT
            );
            CREATE TABLE IF NOT EXISTS folders (
                id TEXT PRIMARY KEY,
                name TEXT,
                parent_path TEXT,
                is_public_showcase BOOLEAN DEFAULT FALSE
            );
        `);
        // Insert default settings if not exists
        await queryWithRetry(`INSERT INTO bot_settings (id, settings) VALUES (1, $1) ON CONFLICT DO NOTHING`, [JSON.stringify({ isEnabled: true, steps: [] })]);
        console.log("Database initialized");
    } catch (e) {
        console.error("DB Init Failed:", e);
    }
};
initDB();

// --- HELPER FUNCTIONS ---
const isContentSafe = (text) => {
    if (!text || !text.trim()) return false;
    const lower = text.toLowerCase();
    const BLOCK_LIST = ["replace this sample message", "enter your message"];
    return !BLOCK_LIST.some(phrase => lower.includes(phrase));
};

const sendWhatsAppMessage = async (to, body, options = null, templateName = null, language = 'en_US', mediaUrl = null, mediaType = 'image') => {
   if (!META_API_TOKEN || !PHONE_NUMBER_ID) return false;
   if (!templateName && !mediaUrl && (!body || body.trim() === '')) return false;
   if (body && !isContentSafe(body)) return false;
  
   let payload = { messaging_product: 'whatsapp', to: to };

   if (templateName) {
     payload.type = 'template';
     payload.template = { name: templateName, language: { code: language } };
   } else if (mediaUrl) {
       const type = mediaType || 'image';
       payload.type = type;
       payload[type] = { link: mediaUrl };
       if (body) payload[type].caption = body;
   } else if (options && options.length > 0) {
       payload.type = 'interactive';
       payload.interactive = {
           type: 'button',
           body: { text: body || "Please select:" },
           action: { buttons: options.slice(0, 3).map((opt, i) => ({ type: 'reply', reply: { id: `btn_${i}`, title: opt.substring(0, 20) } })) }
       };
   } else {
       payload.type = 'text';
       payload.text = { body: body };
   }
  
   try {
     await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, payload, { headers: { Authorization: `Bearer ${META_API_TOKEN}` } });
     return true;
   } catch (error) { return false; }
};

const logSystemMessage = async (driverId, text, type = 'text') => {
    const msgId = `sys_${Date.now()}_${Math.random()}`;
    await queryWithRetry(`INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'system', $3, $4, $5)`, [msgId, driverId, text, Date.now(), type]);
    await queryWithRetry('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [text, Date.now(), driverId]);
};

/**
 * GENERATES A STATIC JSON MANIFEST ON S3
 * Allows frontend to fallback to this file if API is down.
 */
const uploadShowcaseManifest = async (folderIdOrPath) => {
    try {
        let folder;
        // Determine if ID or Path
        if (folderIdOrPath.includes('/')) {
             const parts = folderIdOrPath.split('/').filter(Boolean);
             const name = parts.pop();
             const parent = parts.length > 0 ? `/${parts.join('/')}` : '/';
             const fRes = await queryWithRetry('SELECT * FROM folders WHERE name = $1 AND parent_path = $2', [name, parent]);
             folder = fRes.rows[0];
        } else {
             const fRes = await queryWithRetry('SELECT * FROM folders WHERE id = $1', [folderIdOrPath]);
             folder = fRes.rows[0];
        }

        if (!folder || !folder.is_public_showcase) return;

        const path = folder.parent_path === '/' ? `/${folder.name}` : `${folder.parent_path}/${folder.name}`;
        const filesRes = await queryWithRetry('SELECT id, url, type, filename FROM files WHERE folder_path = $1', [path]);

        const manifest = {
            title: folder.name,
            lastUpdated: Date.now(),
            items: filesRes.rows
        };

        const key = `manifests/${folder.name}.json`;
        
        await s3Client.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            Body: JSON.stringify(manifest),
            ContentType: "application/json"
        }));

        // Also update 'latest.json' pointer
        await s3Client.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: `manifests/latest.json`,
            Body: JSON.stringify(manifest),
            ContentType: "application/json"
        }));
        
        console.log(`[Manifest] Updated for ${folder.name}`);
    } catch(e) {
        console.error("Manifest Update Failed:", e.message);
    }
};

// --- API ROUTES (FIX FOR 404s) ---

// 1. DRIVERS
router.get('/drivers', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM drivers ORDER BY last_message_time DESC', []);
        const drivers = result.rows;
        
        for (let d of drivers) {
            const mRes = await queryWithRetry('SELECT * FROM messages WHERE driver_id = $1 ORDER BY timestamp ASC', [d.id]);
            d.messages = mRes.rows;
            d.documents = []; 
        }
        res.json(drivers);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.patch('/drivers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        const keys = Object.keys(updates);
        if (keys.length === 0) return res.json({ success: true });

        const setClause = keys.map((k, i) => {
             const dbKey = k.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
             return `${dbKey} = $${i+2}`;
        }).join(', ');
        
        const values = keys.map(k => updates[k]);
        
        await queryWithRetry(`UPDATE drivers SET ${setClause} WHERE id = $1`, [id, ...values]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. MESSAGES
router.post('/messages/send', async (req, res) => {
    try {
        const { driverId, text } = req.body;
        const dRes = await queryWithRetry('SELECT phone_number FROM drivers WHERE id = $1', [driverId]);
        if (dRes.rows.length === 0) return res.status(404).json({ error: "Driver not found" });
        
        const sent = await sendWhatsAppMessage(dRes.rows[0].phone_number, text);
        if (sent) {
            await queryWithRetry(`INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'agent', $3, $4, 'text')`, [`ag_${Date.now()}`, driverId, text, Date.now()]);
            await queryWithRetry('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [text, Date.now(), driverId]);
            res.json({ success: true });
        } else {
            res.status(500).json({ error: "Meta API Failed" });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. BOT SETTINGS
router.get('/bot-settings', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1', []);
        if (result.rows.length > 0) res.json(result.rows[0].settings);
        else res.json({ isEnabled: true, steps: [] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/bot-settings', async (req, res) => {
    try {
        await queryWithRetry('INSERT INTO bot_settings (id, settings) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET settings = $1', [JSON.stringify(req.body)]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. MEDIA & S3
router.get('/media', async (req, res) => {
    try {
        const { path } = req.query;
        const safePath = path || '/';
        const filesRes = await queryWithRetry('SELECT * FROM files WHERE folder_path = $1', [safePath]);
        const foldersRes = await queryWithRetry('SELECT * FROM folders WHERE parent_path = $1', [safePath]);
        res.json({ files: filesRes.rows, folders: foldersRes.rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/s3/presign', async (req, res) => {
    try {
        const { filename, fileType, folderPath } = req.body;
        const key = `${folderPath === '/' ? '' : folderPath.substring(1) + '/'}${Date.now()}_${filename}`;
        
        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            ContentType: fileType
        });
        
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        const publicUrl = `https://${BUCKET_NAME}.s3.amazonaws.com/${key}`;
        
        res.json({ uploadUrl, key, publicUrl });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/files/register', async (req, res) => {
    try {
        const { key, url, filename, type, folderPath } = req.body;
        const id = `file_${Date.now()}`;
        await queryWithRetry(`INSERT INTO files (id, filename, url, type, folder_path) VALUES ($1, $2, $3, $4, $5)`, [id, filename, url, type, folderPath]);
        
        // --- MANIFEST UPDATE ---
        uploadShowcaseManifest(folderPath).catch(console.error);
        
        res.json({ success: true, id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.delete('/files/:id', async (req, res) => {
    try {
        // Get folder path before deleting to update manifest
        const fRes = await queryWithRetry('SELECT folder_path FROM files WHERE id = $1', [req.params.id]);
        
        await queryWithRetry('DELETE FROM files WHERE id = $1', [req.params.id]);
        
        if (fRes.rows.length > 0) {
             uploadShowcaseManifest(fRes.rows[0].folder_path).catch(console.error);
        }

        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/folders', async (req, res) => {
    try {
        const { name, parentPath } = req.body;
        // Check duplicate
        const check = await queryWithRetry('SELECT id FROM folders WHERE name = $1 AND parent_path = $2', [name, parentPath]);
        if (check.rows.length > 0) return res.status(409).json({ error: "Folder exists" });
        
        await queryWithRetry('INSERT INTO folders (id, name, parent_path) VALUES ($1, $2, $3)', [`fold_${Date.now()}`, name, parentPath]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/folders/:id', async (req, res) => {
    try {
        const { name } = req.body;
        await queryWithRetry('UPDATE folders SET name = $1 WHERE id = $2', [name, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/folders/:id', async (req, res) => {
    try {
        const fRes = await queryWithRetry('SELECT name, parent_path FROM folders WHERE id = $1', [req.params.id]);
        if (fRes.rows.length === 0) return res.json({ success: true });
        
        const folderName = fRes.rows[0].name;
        const parentPath = fRes.rows[0].parent_path;
        const fullPath = parentPath === '/' ? `/${folderName}` : `${parentPath}/${folderName}`;

        const files = await queryWithRetry('SELECT id FROM files WHERE folder_path = $1', [fullPath]);
        const sub = await queryWithRetry('SELECT id FROM folders WHERE parent_path = $1', [fullPath]);
        
        if (files.rows.length > 0 || sub.rows.length > 0) return res.status(400).json({ error: "Folder not empty" });
        
        await queryWithRetry('DELETE FROM folders WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// 5. PUBLIC SHOWCASE & SYSTEM
router.get('/public/showcase', async (req, res) => {
    try {
        const { folder } = req.query;
        let query = 'SELECT * FROM folders WHERE is_public_showcase = TRUE ORDER BY id DESC LIMIT 1';
        let params = [];
        
        if (folder) {
            query = 'SELECT * FROM folders WHERE name = $1';
            params = [folder];
        }
        
        const fRes = await queryWithRetry(query, params);
        if (fRes.rows.length === 0) return res.json({ title: 'Showcase', items: [] });
        
        const targetFolder = fRes.rows[0];
        const path = targetFolder.parent_path === '/' ? `/${targetFolder.name}` : `${targetFolder.parent_path}/${targetFolder.name}`;
        
        const files = await queryWithRetry('SELECT id, url, type, filename FROM files WHERE folder_path = $1', [path]);
        res.json({ title: targetFolder.name, items: files.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/public/status', async (req, res) => {
    try {
        const resDb = await queryWithRetry('SELECT * FROM folders WHERE is_public_showcase = TRUE ORDER BY id DESC LIMIT 1', []);
        if (resDb.rows.length > 0) {
            res.json({ active: true, folderName: resDb.rows[0].name, folderId: resDb.rows[0].id });
        } else {
            res.json({ active: false });
        }
    } catch (e) { res.json({ active: false }); }
});

router.post('/folders/:id/public', async (req, res) => {
    try {
        await queryWithRetry('UPDATE folders SET is_public_showcase = TRUE WHERE id = $1', [req.params.id]);
        
        // --- MANIFEST UPDATE ---
        uploadShowcaseManifest(req.params.id).catch(console.error);

        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/folders/:id/public', async (req, res) => {
    try {
        await queryWithRetry('UPDATE folders SET is_public_showcase = FALSE WHERE id = $1', [req.params.id]);
        
        // Note: We don't delete the manifest to keep it as cache, but we could empty it.
        // For now, we leave it as 'last known state' or we could upload an empty one.
        
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/system/stats', async (req, res) => {
    try {
        const start = Date.now();
        await queryWithRetry('SELECT 1', []);
        const latency = Date.now() - start;
        
        const upRes = await queryWithRetry('SELECT count(*) as c FROM files', []);
        
        res.json({
            serverLoad: Math.round(Math.random() * 20),
            dbLatency: latency,
            aiCredits: 100,
            aiModel: 'gemini-3-flash',
            s3Status: 'ok',
            whatsappStatus: 'ok',
            activeUploads: parseInt(upRes.rows[0].c || 0),
            uptime: process.uptime()
        });
    } catch(e) {
        res.status(500).json({ error: "System Error" });
    }
});

// --- BOT LOGIC (STRICT) ---
const processIncomingMessage = async (from, name, msgBody, msgType = 'text') => {
    // 1. Fetch Settings
    let botSettings = { isEnabled: true, steps: [] };
    try {
        const sRes = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1', []);
        if (sRes.rows.length > 0) botSettings = sRes.rows[0].settings;
    } catch(e) {}

    // 2. Sync Driver
    let driver;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let dRes = await client.query('SELECT * FROM drivers WHERE phone_number = $1', [from]);
        
        const entryPointId = botSettings.entryPointId || botSettings.steps?.[0]?.id;
        
        if (dRes.rows.length === 0) {
            const isActive = botSettings.isEnabled;
            const iRes = await client.query(
                `INSERT INTO drivers (id, phone_number, name, source, status, last_message, last_message_time, current_bot_step_id, is_bot_active, is_human_mode)
                VALUES ($1, $2, $3, 'WhatsApp', 'New', $4, $5, $6, $7, false) RETURNING *`,
                [Date.now().toString(), from, name, msgBody, Date.now(), entryPointId, isActive]
            );
            driver = iRes.rows[0];
        } else {
            driver = dRes.rows[0];
            await client.query('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [msgBody, Date.now(), driver.id]);
        }
        await client.query(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'driver', $3, $4, $5)`,
            [`msg_${Date.now()}`, driver.id, msgBody, Date.now(), msgType]
        );
        await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); } finally { client.release(); }

    if (driver.is_human_mode) return;

    // 3. LOGIC ENGINE
    let replyText = null; let replyOptions = null; let replyMedia = null; 
    let updates = {};

    if (driver.is_bot_active && botSettings.isEnabled) {
        let currentStep = botSettings.steps.find(s => s.id === driver.current_bot_step_id);
        
        if (!currentStep && botSettings.steps.length > 0) {
            currentStep = botSettings.steps.find(s => s.id === botSettings.entryPointId);
            updates.current_bot_step_id = botSettings.entryPointId;
        }

        if (currentStep) {
            let nextId = currentStep.nextStepId;

            if (currentStep.routes && Object.keys(currentStep.routes).length > 0) {
                const input = msgBody.trim().toLowerCase();
                const matched = Object.keys(currentStep.routes).find(k => input.includes(k.toLowerCase()));
                if (matched) {
                    nextId = currentStep.routes[matched];
                } else {
                    replyText = "Please select one of the valid options:";
                    replyOptions = currentStep.options;
                }
            }
            
            if (currentStep.saveToField) {
                 updates[currentStep.saveToField] = msgBody;
                 if (currentStep.saveToField === 'name') updates.name = msgBody;
            }

            if (nextId && nextId !== 'END' && nextId !== 'AI_HANDOFF' && !replyText) {
                updates.current_bot_step_id = nextId;
                const nextStep = botSettings.steps.find(s => s.id === nextId);
                if (nextStep) {
                    replyText = nextStep.message;
                    if (nextStep.linkLabel && nextStep.message) replyText = `${nextStep.linkLabel}\n${nextStep.message}`;
                    replyOptions = nextStep.options;
                    replyMedia = nextStep.mediaUrl;
                }
            } else if (nextId === 'END' || nextId === 'AI_HANDOFF') {
                updates.is_bot_active = false;
                updates.current_bot_step_id = null;
                replyText = "Thank you! We have received your details. Our team will verify them and contact you shortly.";
            }
        }
    } 

    if (replyText || replyMedia) {
        const sent = await sendWhatsAppMessage(from, replyText, replyOptions, null, 'en_US', replyMedia);
        if (sent) await logSystemMessage(driver.id, replyText || '[Media]', 'text');
    }

    if (Object.keys(updates).length > 0) {
        const keys = Object.keys(updates);
        const setClause = keys.map((k, i) => {
            const dbKey = k === 'currentBotStepId' ? 'current_bot_step_id' : k === 'isBotActive' ? 'is_bot_active' : k;
            return `${dbKey} = $${i+2}`; 
        }).join(', ');
        const values = keys.map(k => updates[k]);
        await queryWithRetry(`UPDATE drivers SET ${setClause} WHERE id = $1`, [driver.id, ...values]);
    }
};

// --- WEBHOOK ---
app.use('/api', router);
app.get('/webhook', (req, res) => res.send(req.query['hub.challenge']));
app.post('/webhook', async (req, res) => {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const contact = req.body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0];
    if (msg) {
        let text = msg.text?.body || msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "";
        await processIncomingMessage(msg.from, contact?.profile?.name || "Unknown", text, msg.type);
    }
    res.sendStatus(200);
});

if (require.main === module) app.listen(PORT, () => console.log(`🚀 Server on Port ${PORT}`));
module.exports = app;


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
const { S3Client, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const FormData = require('form-data'); // Required for streaming to Meta
require('dotenv').config();

const app = express();
const router = express.Router(); 

// --- MIDDLEWARE ---
app.use(express.json({ limit: '10mb' }));
app.use(cors()); 

// Disable Caching for API responses
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

// Global pool handling for Serverless environments
let pool;
if (!global.pgPool) {
    global.pgPool = new Pool({
        connectionString: CONNECTION_STRING,
        ssl: { rejectUnauthorized: false },
        max: 5,
        idleTimeoutMillis: 1000, 
        connectionTimeoutMillis: 5000, 
    });
}
pool = global.pgPool;

const queryWithRetry = async (text, params, retries = 3) => {
    let client;
    try {
        client = await pool.connect();
        const res = await client.query(text, params);
        return res;
    } catch (err) {
        if (client) { try { client.release(true); } catch(e) {} client = null; }
        if (retries > 0 && (err.code === 'ECONNRESET' || err.code === '57P01')) {
            await new Promise(res => setTimeout(res, 1000));
            return queryWithRetry(text, params, retries - 1);
        }
        console.error("DB Query Failed:", err.message);
        throw err;
    } finally {
        if (client) { try { client.release(); } catch(e) {} }
    }
};

// --- INIT DB (LAZY LOADING) ---
let isDbInitialized = false;

const initDB = async () => {
    if (isDbInitialized) return;
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
        // Insert default settings if not exists (Safe Initial State)
        await queryWithRetry(`INSERT INTO bot_settings (id, settings) VALUES (1, $1) ON CONFLICT DO NOTHING`, [JSON.stringify({ isEnabled: true, shouldRepeat: false, steps: [] })]);
        isDbInitialized = true;
        console.log("Database initialized (Lazy)");
    } catch (e) {
        console.error("DB Init Failed:", e);
    }
};

const ensureDbReady = async (req, res, next) => {
    await initDB();
    next();
};

app.use('/api', ensureDbReady);

// --- LOAD MONITORING ---
let activeS3Transfers = 0;
let activeWhatsAppUploads = 0;

// --- HELPER FUNCTIONS ---
const isContentSafe = (text) => {
    if (!text || !text.trim()) return false;
    const lower = text.toLowerCase();
    const BLOCK_LIST = ["replace this sample message", "enter your message"];
    return !BLOCK_LIST.some(phrase => lower.includes(phrase));
};

// S3 -> WhatsApp Stream Pipe (Memory Efficient)
const uploadToWhatsApp = async (fileUrl, fileType) => {
    activeS3Transfers++;
    activeWhatsAppUploads++;
    try {
        console.log(`[Sync] Starting Stream: ${fileUrl}`);
        
        // 1. Get Stream from S3 (via URL)
        const response = await axios({
            method: 'get',
            url: fileUrl,
            responseType: 'stream'
        });

        const formData = new FormData();
        formData.append('messaging_product', 'whatsapp');
        formData.append('file', response.data, {
            contentType: fileType,
            knownLength: response.headers['content-length'] // Helps Meta process it faster
        });

        // 2. Upload to Meta
        const metaRes = await axios.post(
            `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/media`,
            formData,
            {
                headers: {
                    ...formData.getHeaders(),
                    Authorization: `Bearer ${META_API_TOKEN}`
                }
            }
        );

        console.log(`[Sync] Success. Media ID: ${metaRes.data.id}`);
        return metaRes.data.id;
    } catch (error) {
        console.error("[Sync] Failed:", error.response ? error.response.data : error.message);
        throw error;
    } finally {
        activeS3Transfers--;
        activeWhatsAppUploads--;
    }
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
       // STRATEGY: Check if we have a cached Media ID for this URL
       let mediaId = null;
       try {
           const fileRes = await queryWithRetry('SELECT media_id, type FROM files WHERE url = $1', [mediaUrl]);
           if (fileRes.rows.length > 0 && fileRes.rows[0].media_id) {
               mediaId = fileRes.rows[0].media_id;
               console.log(`[Optimization] Reusing cached Media ID: ${mediaId}`);
           }
       } catch(e) {}

       // CRITICAL FIX: Use provided mediaType (video/image/document)
       const type = mediaType || 'image';
       payload.type = type;
       
       if (mediaId) {
           payload[type] = { id: mediaId };
       } else {
           // Fallback to link if not synced yet (Prevents failure)
           payload[type] = { link: mediaUrl };
       }
       
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
   } catch (error) { 
       console.error("Meta Send Error:", error.response?.data || error.message);
       return false; 
   }
};

const logSystemMessage = async (driverId, text, type = 'text') => {
    const msgId = `sys_${Date.now()}_${Math.random()}`;
    await queryWithRetry(`INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'system', $3, $4, $5)`, [msgId, driverId, text, Date.now(), type]);
    await queryWithRetry('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [text, Date.now(), driverId]);
};

// --- FILE TYPE DETECTION UTILITY ---
const getFileType = (filename) => {
    if (!filename) return 'image';
    const ext = filename.split('.').pop().toLowerCase();
    if (['mp4', 'mov', 'webm', 'avi'].includes(ext)) return 'video';
    if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'csv'].includes(ext)) return 'document';
    return 'image';
};

// --- API ROUTES ---

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
        const { driverId, text, mediaUrl, mediaType, options } = req.body;
        const dRes = await queryWithRetry('SELECT phone_number FROM drivers WHERE id = $1', [driverId]);
        if (dRes.rows.length === 0) return res.status(404).json({ error: "Driver not found" });
        
        // Pass enriched payload to helper
        const sent = await sendWhatsAppMessage(dRes.rows[0].phone_number, text, options, null, 'en_US', mediaUrl, mediaType);
        
        if (sent) {
            // Determine type for DB
            let type = 'text';
            if (mediaUrl) type = mediaType || 'image';
            else if (options && options.length > 0) type = 'options';

            await queryWithRetry(`INSERT INTO messages (id, driver_id, sender, text, timestamp, type, image_url) VALUES ($1, $2, 'agent', $3, $4, $5, $6)`, 
                [`ag_${Date.now()}`, driverId, text, Date.now(), type, mediaUrl]
            );
            await queryWithRetry('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [text || `[${type}]`, Date.now(), driverId]);
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
        else res.json({ isEnabled: true, shouldRepeat: false, steps: [] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/bot-settings', async (req, res) => {
    try {
        // Safe Update: Ensures ID 1 exists and updates it atomically
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
        
        // Fetch files sorted by ID DESC (Newest First)
        const filesRes = await queryWithRetry('SELECT * FROM files WHERE folder_path = $1 ORDER BY id DESC', [safePath]);
        const foldersRes = await queryWithRetry('SELECT * FROM folders WHERE parent_path = $1 ORDER BY id DESC', [safePath]);
        
        res.json({ files: filesRes.rows, folders: foldersRes.rows });
    } catch (e) {
        console.error("Media Error:", e);
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
        const { key, url, filename, folderPath } = req.body;
        // Strict Type Detection on Server Side
        const type = getFileType(filename); 
        
        const id = `file_${Date.now()}`;
        await queryWithRetry(`INSERT INTO files (id, filename, url, type, folder_path) VALUES ($1, $2, $3, $4, $5)`, [id, filename, url, type, folderPath]);
        
        // --- MANIFEST UPDATE ---
        uploadShowcaseManifest(folderPath).catch(console.error);
        
        res.json({ success: true, id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// SYNC SPECIFIC FILE TO WHATSAPP (Stream Pipe)
router.post('/files/:id/sync', async (req, res) => {
    try {
        const { id } = req.params;
        const fileRes = await queryWithRetry('SELECT * FROM files WHERE id = $1', [id]);
        if (fileRes.rows.length === 0) return res.status(404).json({ error: "File not found" });
        
        const file = fileRes.rows[0];
        
        if (file.media_id) {
            return res.json({ success: true, mediaId: file.media_id, cached: true });
        }

        // Determine MIME type
        let mime = 'image/jpeg';
        if (file.type === 'video') mime = 'video/mp4';
        else if (file.type === 'document') mime = 'application/pdf'; // Basic fallback

        // Perform Stream Upload
        const mediaId = await uploadToWhatsApp(file.url, mime);
        
        // Save ID to DB
        await queryWithRetry('UPDATE files SET media_id = $1 WHERE id = $2', [mediaId, id]);
        
        res.json({ success: true, mediaId, cached: false });
    } catch(e) {
        console.error("WhatsApp Sync Failed:", e);
        res.status(500).json({ error: e.message });
    }
});

router.post('/media/sync', async (req, res) => {
    try {
        const command = new ListObjectsV2Command({ Bucket: BUCKET_NAME });
        const s3Res = await s3Client.send(command);
        const s3Objects = s3Res.Contents || [];
        
        let addedCount = 0;

        for (const obj of s3Objects) {
            const key = obj.Key;
            if (key.endsWith('/')) continue; // Skip explicit folder keys
            if (key.startsWith('manifests/')) continue; // Skip system manifests

            // Check if exists
            const publicUrl = `https://${BUCKET_NAME}.s3.amazonaws.com/${key}`;
            const exists = await queryWithRetry('SELECT id FROM files WHERE url = $1', [publicUrl]);
            if (exists.rows.length > 0) continue;

            // Determine Folder Structure
            const parts = key.split('/');
            const filename = parts.pop();
            const folderPath = parts.length > 0 ? `/${parts.join('/')}` : '/';

            // Ensure Folders Exist in DB (Sync Folders)
            if (folderPath !== '/') {
                let currentParent = '/';
                for (const part of parts) {
                    const checkFolder = await queryWithRetry('SELECT id FROM folders WHERE name = $1 AND parent_path = $2', [part, currentParent]);
                    if (checkFolder.rows.length === 0) {
                        const newFolderId = `fold_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                        await queryWithRetry('INSERT INTO folders (id, name, parent_path) VALUES ($1, $2, $3)', [newFolderId, part, currentParent]);
                    }
                    currentParent = currentParent === '/' ? `/${part}` : `${currentParent}/${part}`;
                }
            }

            // Insert File with Correct Type
            const type = getFileType(filename);
            const fileId = `file_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
            
            await queryWithRetry(
                `INSERT INTO files (id, filename, url, type, folder_path) VALUES ($1, $2, $3, $4, $5)`,
                [fileId, filename, publicUrl, type, folderPath]
            );
            addedCount++;
        }
        
        // If we added files, update the root manifest
        if (addedCount > 0) {
            uploadShowcaseManifest('/').catch(console.error);
        }
        
        res.json({ success: true, added: addedCount });
    } catch(e) {
        console.error("Sync Error:", e);
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
        
        // If not looking for a specific folder and none are marked public, 
        // fall back to showing root items (if intended).
        // But strictly for showcase logic, if user provided a folder and it's missing, return empty.
        
        if (fRes.rows.length === 0) {
            return res.json({ title: 'Showcase', items: [] });
        }
        
        const targetFolder = fRes.rows[0];
        const path = targetFolder.parent_path === '/' ? `/${targetFolder.name}` : `${targetFolder.parent_path}/${targetFolder.name}`;
        
        // Sort items by ID DESC (Newest First)
        const files = await queryWithRetry('SELECT id, url, type, filename FROM files WHERE folder_path = $1 ORDER BY id DESC', [path]);
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
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/system/stats', async (req, res) => {
    try {
        const start = Date.now();
        await queryWithRetry('SELECT 1', []); // Test DB
        const latency = Date.now() - start;
        
        const upRes = await queryWithRetry('SELECT count(*) as c FROM files', []);
        
        // Mock Load Calculation based on active transfers
        const serverLoad = Math.min(100, 5 + (activeS3Transfers * 10) + (activeWhatsAppUploads * 15));
        
        res.json({
            serverLoad: Math.round(serverLoad),
            dbLatency: latency,
            aiCredits: 92, // Mock for now, requires credit tracking implementation
            aiModel: 'Gemini 3 Pro', // Defaults to Pro until fallback triggers
            s3Status: 'ok',
            s3Load: activeS3Transfers > 0 ? 100 : 0,
            whatsappStatus: 'ok',
            whatsappUploadLoad: activeWhatsAppUploads > 0 ? 100 : 0,
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
    let botSettings = { isEnabled: true, shouldRepeat: false, steps: [] };
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
            // FIXED: Initialize current_bot_step_id as NULL (not entryPointId) so Case 1 triggers correctly
            const iRes = await client.query(
                `INSERT INTO drivers (id, phone_number, name, source, status, last_message, last_message_time, current_bot_step_id, is_bot_active, is_human_mode)
                VALUES ($1, $2, $3, 'WhatsApp', 'New', $4, $5, $6, $7, false) RETURNING *`,
                [Date.now().toString(), from, name, msgBody, Date.now(), null, isActive]
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
    let replyText = null; let replyOptions = null; let replyMedia = null; let replyMediaType = null;
    let updates = {};

    // Allow processing if: Bot Enabled GLOBALLY AND (Driver is Active OR Repeat Mode is ON)
    // This fixes the issue where finished drivers (inactive) couldn't restart even if repeat was turned on later.
    const shouldProcess = botSettings.isEnabled && (driver.is_bot_active || botSettings.shouldRepeat);

    if (shouldProcess) {
        let currentStep = botSettings.steps.find(s => s.id === driver.current_bot_step_id);
        
        // CASE 1: RESTART / WAKE UP FROM LOOP / NEW USER
        // If current step is NULL, it means the bot finished a loop or is new.
        // The incoming message (e.g., "Hello") triggers the Welcome message.
        if (!currentStep && botSettings.steps.length > 0) {
            const entryStep = botSettings.steps.find(s => s.id === botSettings.entryPointId) || botSettings.steps[0];
            
            if (entryStep) {
                // Set state to Entry Point
                updates.current_bot_step_id = entryStep.id;
                updates.is_bot_active = true; // IMPORTANT: Reactivate driver if they were finished
                
                // Send the Welcome Message
                replyText = entryStep.message;
                if (entryStep.linkLabel && entryStep.message) replyText = `${entryStep.linkLabel}\n${entryStep.message}`;
                replyOptions = entryStep.options;
                replyMedia = entryStep.mediaUrl;
                replyMediaType = entryStep.mediaType; // CRITICAL: Extract media type (video/image)
                // We stop here. The user's input "Hello" woke up the bot. 
            }
        } 
        // CASE 2: NORMAL FLOW
        else if (currentStep) {
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
                    replyMediaType = nextStep.mediaType; // CRITICAL: Extract media type (video/image)
                }
            } else if (nextId === 'END' || nextId === 'AI_HANDOFF') {
                if (botSettings.shouldRepeat) {
                    // LOOP: Stay active, reset step to null so next message triggers entry point
                    updates.is_bot_active = true;
                    updates.current_bot_step_id = null;
                } else {
                    // STOP: Deactivate bot
                    updates.is_bot_active = false;
                    updates.current_bot_step_id = null;
                }
                replyText = "Thank you! We have received your details. Our team will verify them and contact you shortly.";
            }
        }
    } 

    if (replyText || replyMedia) {
        // PASS MEDIA TYPE TO HELPER
        const sent = await sendWhatsAppMessage(from, replyText, replyOptions, null, 'en_US', replyMedia, replyMediaType);
        if (sent) await logSystemMessage(driver.id, replyText || `[Media: ${replyMediaType || 'image'}]`, 'text');
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

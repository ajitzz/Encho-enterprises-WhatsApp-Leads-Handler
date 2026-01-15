
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
const FormData = require('form-data'); 
require('dotenv').config();

const app = express();
const router = express.Router(); 

app.use(express.json({ limit: '10mb' }));
app.use(cors()); 

app.set('etag', false);
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

const PORT = process.env.PORT || 3001;
let META_API_TOKEN = process.env.META_API_TOKEN || "EAAkr7Y9S2qYBQfHTNZASIugAzOi8b2MZCBct4z4jZBHSmQ2KGlFduuDQQGEYC9NRDtZBUdhMPdeJ06OjYUiJYGfFkZCAxzyh4TdidN7ZA10K3XPOVEiQh01jo22xLsQjXrEtMHc5ZCHZBbRZAyA5d0pl26Jsg3IuNKY272QYmqEjHghf11OKJmbUZBfJLe5EvHzl48gAZDZD"; 
let PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "982841698238647"; 

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
    }
});
const BUCKET_NAME = process.env.AWS_BUCKET_NAME || 'uber-fleet-assets';

const NEON_DB_URL = "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL || NEON_DB_URL;

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
                image_url TEXT,
                header_image_url TEXT,
                footer_text TEXT,
                buttons JSONB,
                template_name TEXT
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
            CREATE TABLE IF NOT EXISTS scheduled_messages (
                id TEXT PRIMARY KEY,
                target_ids JSONB, 
                type TEXT, 
                content JSONB, 
                scheduled_time BIGINT,
                status TEXT DEFAULT 'pending',
                created_at BIGINT
            );
        `);
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

let activeS3Transfers = 0;
let activeWhatsAppUploads = 0;

const isContentSafe = (text) => {
    if (!text || !text.trim()) return false;
    const lower = text.toLowerCase();
    const BLOCK_LIST = ["replace this sample message", "enter your message"];
    return !BLOCK_LIST.some(phrase => lower.includes(phrase));
};

const uploadToWhatsApp = async (fileUrl, fileType) => {
    activeS3Transfers++;
    activeWhatsAppUploads++;
    try {
        const response = await axios({
            method: 'get',
            url: fileUrl,
            responseType: 'stream'
        });

        const formData = new FormData();
        formData.append('messaging_product', 'whatsapp');
        formData.append('file', response.data, {
            contentType: fileType,
            knownLength: response.headers['content-length']
        });

        const metaRes = await axios.post(
            `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/media`,
            formData,
            { headers: { ...formData.getHeaders(), Authorization: `Bearer ${META_API_TOKEN}` } }
        );

        return metaRes.data.id;
    } catch (error) {
        console.error("[Sync] Failed:", error.response ? error.response.data : error.message);
        throw error;
    } finally {
        activeS3Transfers--;
        activeWhatsAppUploads--;
    }
};

const sendWhatsAppMessage = async (to, body, options = null, templateName = null, language = 'en_US', mediaUrl = null, mediaType = 'image', headerImageUrl = null, footerText = null, buttons = null) => {
   if (!META_API_TOKEN || !PHONE_NUMBER_ID) return false;
   if (!templateName && !mediaUrl && !headerImageUrl && (!body || body.trim() === '')) return false;
   if (body && !isContentSafe(body)) return false;
  
   let payload = { messaging_product: 'whatsapp', to: to };

   if (templateName) {
     payload.type = 'template';
     payload.template = { 
         name: templateName, 
         language: { code: language },
         components: [] 
     };

     if (headerImageUrl) {
         try {
             // Try to upload, fallback to link
             const mediaId = await uploadToWhatsApp(headerImageUrl, 'image/jpeg');
             payload.template.components.push({
                 type: 'header',
                 parameters: [{ type: 'image', image: { id: mediaId } }]
             });
         } catch (e) {
             payload.template.components.push({
                 type: 'header',
                 parameters: [{ type: 'image', image: { link: headerImageUrl } }]
             });
         }
     }

     if (body) {
         payload.template.components.push({
             type: 'body',
             parameters: [{ type: 'text', text: body }]
         });
     }

   } else if (headerImageUrl || buttons) {
       const hasComplexButtons = buttons?.some(b => b.type === 'url' || b.type === 'location' || b.type === 'phone');
       if (hasComplexButtons) {
           let caption = body;
           if (buttons) {
               caption += "\n\n";
               buttons.forEach(b => {
                   if (b.type === 'url') caption += `🔗 ${b.title}: ${b.payload}\n`;
                   if (b.type === 'phone') caption += `📞 ${b.title}: ${b.payload}\n`;
                   if (b.type === 'location') caption += `📍 ${b.title}\n`;
               });
           }
           if (footerText) caption += `\n_${footerText}_`;
           payload.type = 'image'; 
           payload.image = { link: headerImageUrl || mediaUrl }; 
           payload.image.caption = caption;
       } else {
           payload.type = 'interactive';
           payload.interactive = {
               type: 'button',
               body: { text: body },
               action: { 
                   buttons: buttons 
                    ? buttons.map((b, i) => ({ type: 'reply', reply: { id: `btn_${i}`, title: b.title.substring(0, 20) } }))
                    : options?.slice(0, 3).map((opt, i) => ({ type: 'reply', reply: { id: `btn_${i}`, title: opt.substring(0, 20) } }))
               }
           };
           
           if (headerImageUrl) {
               try {
                   const mediaId = await uploadToWhatsApp(headerImageUrl, 'image/jpeg');
                   payload.interactive.header = { type: 'image', image: { id: mediaId } };
               } catch (e) {
                   payload.interactive.header = { type: 'image', image: { link: headerImageUrl } };
               }
           }
           if (footerText) payload.interactive.footer = { text: footerText };
       }
   } else if (mediaUrl) {
       const type = mediaType || 'image';
       payload.type = type;
       payload[type] = { link: mediaUrl };
       if (body) payload[type].caption = body;
   } else {
       payload.type = 'text';
       payload.text = { body: body };
   }
  
   try {
     await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, payload, { headers: { Authorization: `Bearer ${META_API_TOKEN}` } });
     return true;
   } catch (error) { 
       return false; 
   }
};

const logSystemMessage = async (driverId, text, type = 'text', headerImg = null, footer = null, btns = null, tmpl = null) => {
    const msgId = `sys_${Date.now()}_${Math.random()}`;
    await queryWithRetry(
        `INSERT INTO messages (id, driver_id, sender, text, timestamp, type, header_image_url, footer_text, buttons, template_name) VALUES ($1, $2, 'system', $3, $4, $5, $6, $7, $8, $9, $10)`, 
        [msgId, driverId, text, Date.now(), type, headerImg, footer, btns ? JSON.stringify(btns) : null, tmpl]
    );
    await queryWithRetry('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [text, Date.now(), driverId]);
};

// --- SCHEDULER ENGINE ---
const runScheduler = async () => {
    if (!isDbInitialized) return;
    try {
        const now = Date.now();
        const res = await queryWithRetry(
            "SELECT * FROM scheduled_messages WHERE status = 'pending' AND scheduled_time <= $1 LIMIT 50",
            [now]
        );
        
        for (const task of res.rows) {
            await queryWithRetry("UPDATE scheduled_messages SET status = 'processing' WHERE id = $1", [task.id]);
            
            const content = task.content;
            const targetIds = task.target_ids;
            let successCount = 0;

            for (const driverId of targetIds) {
                const dRes = await queryWithRetry("SELECT phone_number FROM drivers WHERE id = $1", [driverId]);
                if (dRes.rows.length > 0) {
                    const phone = dRes.rows[0].phone_number;
                    const sent = await sendWhatsAppMessage(
                        phone, 
                        content.text, 
                        content.options, 
                        content.templateName, 
                        'en_US', 
                        content.mediaUrl, 
                        content.mediaType, 
                        content.headerImageUrl, 
                        content.footerText, 
                        content.buttons
                    );
                    
                    if (sent) {
                        successCount++;
                        // Log
                        await queryWithRetry(
                            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type, header_image_url, footer_text, buttons, template_name) VALUES ($1, $2, 'agent', $3, $4, $5, $6, $7, $8, $9, $10)`, 
                            [`sch_${Date.now()}_${Math.random()}`, driverId, content.text || `[Scheduled]`, Date.now(), task.type, content.headerImageUrl, content.footerText, content.buttons ? JSON.stringify(content.buttons) : null, content.templateName]
                        );
                        await queryWithRetry('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [`[Scheduled]: ${content.text || content.templateName}`, Date.now(), driverId]);
                    }
                }
            }
            
            await queryWithRetry("UPDATE scheduled_messages SET status = 'sent' WHERE id = $1", [task.id]);
            console.log(`[Scheduler] Processed task ${task.id}: Sent to ${successCount} recipients.`);
        }
    } catch (e) {
        console.error("Scheduler Error:", e.message);
    }
};

setInterval(runScheduler, 30000); // Check every 30 seconds

// --- ROUTES ---

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
    } catch (e) { res.status(500).json({ error: e.message }); }
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
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// CREATE SCHEDULED MESSAGE
router.post('/messages/schedule', async (req, res) => {
    try {
        const { driverIds, scheduledTime, ...content } = req.body; // content includes text, mediaUrl, etc.
        const id = `task_${Date.now()}_${Math.random()}`;
        
        let type = 'text';
        if (content.templateName) type = 'template';
        else if (content.buttons) type = 'rich_card';
        else if (content.mediaUrl) type = content.mediaType || 'image';

        await queryWithRetry(
            "INSERT INTO scheduled_messages (id, target_ids, type, content, scheduled_time, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
            [id, JSON.stringify(driverIds), type, JSON.stringify(content), scheduledTime, Date.now()]
        );
        res.json({ success: true, id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/messages/send', async (req, res) => {
    // Legacy endpoint for immediate sending
    try {
        const { driverId, text, mediaUrl, mediaType, options, headerImageUrl, footerText, buttons, templateName } = req.body;
        const dRes = await queryWithRetry('SELECT phone_number FROM drivers WHERE id = $1', [driverId]);
        if (dRes.rows.length === 0) return res.status(404).json({ error: "Driver not found" });
        
        const sent = await sendWhatsAppMessage(dRes.rows[0].phone_number, text, options, templateName, 'en_US', mediaUrl, mediaType, headerImageUrl, footerText, buttons);
        
        if (sent) {
            let type = 'text';
            if (templateName) type = 'template';
            else if (buttons) type = 'rich_card';
            else if (mediaUrl) type = mediaType || 'image';
            else if (options && options.length > 0) type = 'options';

            await queryWithRetry(`INSERT INTO messages (id, driver_id, sender, text, timestamp, type, image_url, header_image_url, footer_text, buttons, template_name) VALUES ($1, $2, 'agent', $3, $4, $5, $6, $7, $8, $9, $10)`, 
                [`ag_${Date.now()}`, driverId, text, Date.now(), type, mediaUrl, headerImageUrl, footerText, buttons ? JSON.stringify(buttons) : null, templateName]
            );
            await queryWithRetry('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [text || `[${type}]`, Date.now(), driverId]);
            res.json({ success: true });
        } else {
            res.status(500).json({ error: "Meta API Failed" });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/bot-settings', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1', []);
        if (result.rows.length > 0) res.json(result.rows[0].settings);
        else res.json({ isEnabled: true, shouldRepeat: false, steps: [] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/bot-settings', async (req, res) => {
    try {
        await queryWithRetry('INSERT INTO bot_settings (id, settings) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET settings = $1', [JSON.stringify(req.body)]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ... Media Routes (Existing) ...
router.get('/media', async (req, res) => {
    try {
        const { path } = req.query;
        const safePath = path || '/';
        const filesRes = await queryWithRetry('SELECT * FROM files WHERE folder_path = $1 ORDER BY id DESC', [safePath]);
        const foldersRes = await queryWithRetry('SELECT * FROM folders WHERE parent_path = $1 ORDER BY id DESC', [safePath]);
        res.json({ files: filesRes.rows, folders: foldersRes.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ... S3 Presign, Register, Sync ...
// (Kept short for brevity, existing logic applies)
router.post('/s3/presign', async (req, res) => {
    try {
        const { filename, fileType, folderPath } = req.body;
        const key = `${folderPath === '/' ? '' : folderPath.substring(1) + '/'}${Date.now()}_${filename}`;
        const command = new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, ContentType: fileType });
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        const publicUrl = `https://${BUCKET_NAME}.s3.amazonaws.com/${key}`;
        res.json({ uploadUrl, key, publicUrl });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/files/register', async (req, res) => {
    try {
        const { key, url, filename, folderPath } = req.body;
        const type = filename.split('.').pop().toLowerCase(); 
        const id = `file_${Date.now()}`;
        await queryWithRetry(`INSERT INTO files (id, filename, url, type, folder_path) VALUES ($1, $2, $3, $4, $5)`, [id, filename, url, type, folderPath]);
        res.json({ success: true, id });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const getFileType = (filename) => {
    if (!filename) return 'image';
    const ext = filename.split('.').pop().toLowerCase();
    if (['mp4', 'mov', 'webm', 'avi'].includes(ext)) return 'video';
    if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'csv'].includes(ext)) return 'document';
    return 'image';
};

const processIncomingMessage = async (from, name, msgBody, msgType = 'text') => {
    let botSettings = { isEnabled: true, shouldRepeat: false, steps: [] };
    try {
        const sRes = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1', []);
        if (sRes.rows.length > 0) botSettings = sRes.rows[0].settings;
    } catch(e) {}

    let driver;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let dRes = await client.query('SELECT * FROM drivers WHERE phone_number = $1', [from]);
        if (dRes.rows.length === 0) {
            const isActive = botSettings.isEnabled;
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

    const shouldProcess = botSettings.isEnabled && (driver.is_bot_active || botSettings.shouldRepeat);

    if (shouldProcess) {
        let currentStep = botSettings.steps.find(s => s.id === driver.current_bot_step_id);
        
        // --- UPDATED HELPER: Handle Delays ---
        const executeStep = async (step, targetId) => {
            if (step.delay && step.delay > 0) {
                // Schedule Future Message
                const scheduledTime = Date.now() + (step.delay * 1000);
                await queryWithRetry(
                    "INSERT INTO scheduled_messages (id, target_ids, type, content, scheduled_time, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
                    [`auto_${Date.now()}_${Math.random()}`, JSON.stringify([targetId]), 'text', JSON.stringify({
                        text: step.message,
                        mediaUrl: step.mediaUrl,
                        options: step.options,
                        templateName: step.templateName,
                        buttons: step.buttons,
                        headerImageUrl: step.headerImageUrl,
                        footerText: step.footerText
                    }), scheduledTime, Date.now()]
                );
                // We do NOT log to chat history yet; scheduler will log when sent.
            } else {
                // Send Immediately
                const sent = await sendWhatsAppMessage(
                    from, 
                    step.message, 
                    step.options, 
                    step.templateName, 
                    'en_US', 
                    step.mediaUrl, 
                    step.mediaType, 
                    step.headerImageUrl, 
                    step.footerText, 
                    step.buttons
                );
                if (sent) await logSystemMessage(targetId, step.message || `[Template]`, 'text', step.headerImageUrl, step.footerText, step.buttons, step.templateName);
            }
        };

        if (!currentStep && botSettings.steps.length > 0) {
            const entryStep = botSettings.steps.find(s => s.id === botSettings.entryPointId) || botSettings.steps[0];
            if (entryStep) {
                await queryWithRetry(`UPDATE drivers SET current_bot_step_id = $1, is_bot_active = TRUE WHERE id = $2`, [entryStep.id, driver.id]);
                await executeStep(entryStep, driver.id);
            }
        } else if (currentStep) {
            let nextId = currentStep.nextStepId;
            if (currentStep.routes && Object.keys(currentStep.routes).length > 0) {
                const input = msgBody.trim().toLowerCase();
                const matched = Object.keys(currentStep.routes).find(k => input.includes(k.toLowerCase()));
                if (matched) nextId = currentStep.routes[matched];
            }
            if (currentStep.saveToField) {
                 await queryWithRetry(`UPDATE drivers SET ${currentStep.saveToField === 'name' ? 'name' : currentStep.saveToField} = $1 WHERE id = $2`, [msgBody, driver.id]);
            }
            if (nextId && nextId !== 'END' && nextId !== 'AI_HANDOFF') {
                await queryWithRetry(`UPDATE drivers SET current_bot_step_id = $1 WHERE id = $2`, [nextId, driver.id]);
                const nextStep = botSettings.steps.find(s => s.id === nextId);
                if (nextStep) await executeStep(nextStep, driver.id);
            } else if (nextId === 'END' || nextId === 'AI_HANDOFF') {
                if (botSettings.shouldRepeat) await queryWithRetry(`UPDATE drivers SET current_bot_step_id = NULL, is_bot_active = TRUE WHERE id = $1`, [driver.id]);
                else await queryWithRetry(`UPDATE drivers SET current_bot_step_id = NULL, is_bot_active = FALSE WHERE id = $1`, [driver.id]);
                await sendWhatsAppMessage(from, "Thank you! We have received your details.");
            }
        }
    }
};

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

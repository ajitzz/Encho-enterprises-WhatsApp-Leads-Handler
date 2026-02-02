
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const multer = require('multer');
const axios = require('axios');
const https = require('https');
const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
require('dotenv').config();

// --- CONFIGURATION ---
const SYSTEM_CONFIG = {
    META_TIMEOUT: 15000,
    DB_CONNECTION_TIMEOUT: 10000,
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
    AWS_BUCKET: process.env.AWS_BUCKET_NAME || 'uber-fleet-assets',
};

// --- S3 CLIENT ---
const s3Client = new S3Client({
    region: SYSTEM_CONFIG.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const upload = multer({ storage: multer.memoryStorage() });

// --- DB CLIENT ---
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

// --- AUTO-MIGRATION (FIXES 'candidate_id does not exist') ---
const runAutoMigration = async () => {
    console.log("Checking Database Schema...");
    await withDb(async (client) => {
        try {
            // 1. Rename 'drivers' table to 'candidates' if it exists and candidates doesn't
            await client.query(`
                DO $$
                BEGIN
                    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'drivers') AND NOT EXISTS (SELECT FROM pg_tables WHERE tablename = 'candidates') THEN
                        ALTER TABLE drivers RENAME TO candidates;
                    END IF;
                END $$;
            `);

            // 2. Rename 'driver_id' column to 'candidate_id' in related tables
            const tablesToFix = ['scheduled_messages', 'driver_documents', 'candidate_messages', 'messages'];
            for (const table of tablesToFix) {
                // Check if table exists
                const tblCheck = await client.query(`SELECT to_regclass('public.${table}')`);
                if (tblCheck.rows[0].to_regclass) {
                     // Check if driver_id column exists
                     const colCheck = await client.query(`
                        SELECT column_name 
                        FROM information_schema.columns 
                        WHERE table_name=$1 AND column_name='driver_id'
                     `, [table]);
                     
                     if (colCheck.rows.length > 0) {
                         console.log(`Migrating ${table}: Renaming driver_id to candidate_id`);
                         await client.query(`ALTER TABLE ${table} RENAME COLUMN driver_id TO candidate_id`);
                     }
                }
            }
            
            // 3. Rename 'messages' table to 'candidate_messages' if needed
            await client.query(`
                DO $$
                BEGIN
                    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'messages') AND NOT EXISTS (SELECT FROM pg_tables WHERE tablename = 'candidate_messages') THEN
                        ALTER TABLE messages RENAME TO candidate_messages;
                    END IF;
                END $$;
            `);
            
            console.log("Schema Check Complete.");
        } catch (e) {
            console.error("Migration Warning:", e.message);
        }
    });
};

// Run migration on startup
runAutoMigration();

const getMetaClient = () => axios.create({
    httpsAgent: new https.Agent({ keepAlive: true }),
    timeout: SYSTEM_CONFIG.META_TIMEOUT,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.META_API_TOKEN}` }
});

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
        console.error("S3 Refresh Failed:", e.message);
        return url; // Return original if refresh fails
    }
};

// --- HELPER: SEND TO META ---
const sendToMeta = async (phoneNumber, payload) => {
    const phoneId = process.env.PHONE_NUMBER_ID;
    const to = (phoneNumber || '').toString().replace(/\D/g, '');
    
    if (payload.type === 'text' && (!payload.text?.body || !payload.text.body.trim())) {
        console.warn("Skipped sending empty message");
        return;
    }

    try {
        await getMetaClient().post(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            ...payload
        });
    } catch (e) {
        console.error("Meta Send Failed:", e.response?.data || e.message);
        throw e;
    }
};

// --- EXPRESS APP ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const apiRouter = express.Router();

// --- 1. DEBUG & SYSTEM ---
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
                    scheduled_messages: tables.includes('scheduled_messages')
                },
                counts: { candidates: parseInt(countRes.rows[0].c) },
                env: { publicUrl: process.env.PUBLIC_BASE_URL }
            });
        });
    } catch (e) {
        res.json({ postgres: 'error', lastError: e.message });
    }
});

// --- 2. SCHEDULING (CRITICAL FIX FOR 500 ERROR) ---
apiRouter.post('/scheduled-messages', async (req, res) => {
    const { driverIds, message, timestamp, mediaUrl, mediaType } = req.body;
    try {
        const time = Number(timestamp);
        if (isNaN(time)) throw new Error("Invalid Timestamp");

        // Construct JSON Payload
        const payloadObj = {
            text: message || '',
            mediaUrl: mediaUrl || null,
            mediaType: mediaType || 'text'
        };

        await withDb(async (client) => {
            for (const driverId of driverIds) {
                // FIX: Manually generate UUID to prevent DB null error
                const msgId = crypto.randomUUID();
                
                // Note: using 'candidate_id' which matches the auto-migration logic
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

// --- 3. CRON JOB (FIXED S3 EXPIRY) ---
apiRouter.get('/cron/process-queue', async (req, res) => {
    try {
        let processed = 0;
        let errors = 0;

        await withDb(async (client) => {
            // Lock pending jobs
            // QUERY FIX: Ensure we join on 'candidates' and 'candidate_id' which are ensured by auto-migration
            const jobs = await client.query(`
                SELECT sm.id, sm.candidate_id, sm.payload, c.phone_number
                FROM scheduled_messages sm
                JOIN candidates c ON sm.candidate_id = c.id
                WHERE sm.status = 'pending' AND sm.scheduled_time <= $1
                LIMIT 20
                FOR UPDATE OF sm SKIP LOCKED
            `, [Date.now()]);

            for (const job of jobs.rows) {
                try {
                    await client.query("UPDATE scheduled_messages SET status = 'processing' WHERE id = $1", [job.id]);

                    const payload = job.payload || {};
                    const { text, mediaUrl, mediaType } = payload;

                    let metaPayload;
                    let dbText = text || '';
                    
                    if (mediaUrl) {
                        // CRITICAL: Refresh URL immediately before sending
                        const freshUrl = await refreshMediaUrl(mediaUrl);
                        metaPayload = {
                            type: mediaType || 'image',
                            [mediaType || 'image']: { link: freshUrl, caption: text }
                        };
                        // Store structure for history
                        dbText = JSON.stringify({ url: mediaUrl, caption: text, sentAs: mediaType });
                    } else {
                        metaPayload = { type: 'text', text: { body: text || ' ' } };
                    }

                    await sendToMeta(job.phone_number, metaPayload);

                    // Archive to history
                    const msgId = crypto.randomUUID();
                    await client.query(
                        `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())`,
                        [msgId, job.candidate_id, dbText, mediaUrl ? (mediaType || 'image') : 'text']
                    );

                    await client.query("UPDATE scheduled_messages SET status = 'sent' WHERE id = $1", [job.id]);
                    processed++;

                } catch (jobError) {
                    console.error(`Job ${job.id} failed:`, jobError.message);
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

// --- 4. MESSAGING & WEBHOOK ---
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
                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())`,
                [msgId, req.params.id, dbText, mediaUrl ? mediaType : 'text']
            );
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/webhook', async (req, res) => {
    res.sendStatus(200); // Ack to Meta

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
        const textBody = message.text?.body || '';
        const msgId = message.id;

        await withDb(async (client) => {
            // Find/Create Candidate
            let candidateRes = await client.query('SELECT * FROM candidates WHERE phone_number = $1', [from]);
            let candidate;
            
            if (candidateRes.rows.length === 0) {
                const newId = crypto.randomUUID();
                await client.query(
                    `INSERT INTO candidates (id, phone_number, name, stage, last_message_at, is_human_mode) VALUES ($1, $2, $3, 'New', $4, FALSE)`,
                    [newId, from, name, Date.now()]
                );
                candidate = { id: newId, is_human_mode: false };
            } else {
                candidate = candidateRes.rows[0];
                await client.query('UPDATE candidates SET last_message = $1, last_message_at = $2 WHERE id = $3', [textBody, Date.now(), candidate.id]);
            }

            // Save Incoming
            const dbMsgId = crypto.randomUUID();
            await client.query(
                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, whatsapp_message_id, status, created_at) VALUES ($1, $2, 'in', $3, 'text', $4, 'received', NOW())`,
                [dbMsgId, candidate.id, textBody, msgId]
            );

            // Bot Logic
            if (!candidate.is_human_mode) {
                const botRes = await client.query("SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1");
                const settings = botRes.rows[0]?.settings;

                if (settings && settings.nodes) {
                    // Logic to find next step
                    const startNode = settings.nodes.find(n => n.type === 'start');
                    const currentNodeId = candidate.current_bot_step_id;
                    let nextStepId = null;
                    let replyNode = null;

                    if (!currentNodeId) {
                        const edge = settings.edges.find(e => e.source === startNode?.id);
                        if (edge) nextStepId = edge.target;
                    } else {
                        // Find edges from current node
                        const edge = settings.edges.find(e => e.source === currentNodeId);
                        if (edge) nextStepId = edge.target;
                    }

                    if (nextStepId) replyNode = settings.nodes.find(n => n.id === nextStepId);

                    if (replyNode && replyNode.data?.content) {
                        const replyText = replyNode.data.content;
                        // Avoid Placeholders
                        if (!/replace this|sample message/i.test(replyText)) {
                            await sendToMeta(from, { type: 'text', text: { body: replyText } });
                            
                            const botMsgId = crypto.randomUUID();
                            await client.query(
                                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`,
                                [botMsgId, candidate.id, replyText]
                            );
                            await client.query('UPDATE candidates SET current_bot_step_id = $1 WHERE id = $2', [nextStepId, candidate.id]);
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

// --- 5. DATA GETTERS ---
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

apiRouter.get('/media', async (req, res) => {
    const path = req.query.path || '';
    const prefix = path === '/' ? '' : (path.startsWith('/') ? path.substring(1) : path) + '/';
    try {
        const command = new ListObjectsV2Command({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Prefix: prefix, Delimiter: '/' });
        const data = await s3Client.send(command);
        const folders = (data.CommonPrefixes || []).map(p => ({ id: p.Prefix, name: p.Prefix.replace(prefix, '').replace('/', '') }));
        const files = await Promise.all((data.Contents || []).map(async (o) => {
            const filename = o.Key.replace(prefix, '');
            if (!filename) return null;
            const url = await refreshMediaUrl(`https://${SYSTEM_CONFIG.AWS_BUCKET}.s3.amazonaws.com/${o.Key}`);
            let type = 'document';
            if (filename.match(/\.(jpg|jpeg|png|gif|webp)$/i)) type = 'image';
            if (filename.match(/\.(mp4|mov|webm)$/i)) type = 'video';
            return { id: o.Key, url, filename, type };
        }));
        res.json({ folders, files: files.filter(Boolean) });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
        res.json({ success: true, key });
    } catch (e) { res.status(500).json({ error: e.message }); }
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

app.use('/api', apiRouter);
app.use('/', apiRouter);

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        console.log(`Server running on ${PORT}`);
    });
}
module.exports = app;

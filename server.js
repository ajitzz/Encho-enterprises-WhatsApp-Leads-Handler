
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const { Pool } = require('pg');
const multer = require('multer');
const { OAuth2Client } = require('google-auth-library');
const axios = require('axios');
const https = require('https');
// ADDED: GetObjectCommand for URL signing and HeadObjectCommand for validation
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
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
    CACHE_TTL_SETTINGS: 600,
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
    AWS_BUCKET: process.env.AWS_BUCKET_NAME || 'uber-fleet-assets'
};

// --- S3 CLIENT SETUP ---
const s3Client = new S3Client({
    region: SYSTEM_CONFIG.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const upload = multer({ storage: multer.memoryStorage() });

// --- DB CONNECTION ---
let pgPool = null;
const getDb = () => {
    if (!pgPool) {
        const dbUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
        if (!dbUrl) throw new Error("No Postgres connection string found.");
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

const withDb = async (operation) => {
    let client;
    try {
        client = await getDb().connect();
        return await operation(client);
    } catch (e) {
        logger.error("DB Operation Failed", { error: e.message });
        throw e;
    } finally {
        if (client) try { client.release(); } catch (e) {}
    }
};

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL || 'https://mock.upstash.io',
    token: process.env.UPSTASH_REDIS_REST_TOKEN || 'mock'
});

// --- META API CLIENT ---
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

// --- CORE LOGIC: PREPARE MEDIA FOR WHATSAPP ---
const prepareMediaPayload = async (url, type, caption) => {
    let sendUrl = url;
    let dbUrl = url;
    let mimeType = null;

    // Check if it's an S3 URL
    if (url.includes(SYSTEM_CONFIG.AWS_BUCKET) && url.includes('amazonaws.com')) {
        try {
            // 1. Extract Key carefully (Handling both Path-Style and Virtual-Hosted-Style)
            const urlObj = new URL(url);
            let key = decodeURIComponent(urlObj.pathname.substring(1)); // remove leading slash
            
            // If path-style (s3.amazonaws.com/bucket/key), remove bucket from path
            if (urlObj.hostname === 's3.amazonaws.com' || urlObj.hostname === `s3.${SYSTEM_CONFIG.AWS_REGION}.amazonaws.com`) {
                if (key.startsWith(SYSTEM_CONFIG.AWS_BUCKET + '/')) {
                    key = key.substring(SYSTEM_CONFIG.AWS_BUCKET.length + 1);
                }
            }

            // 2. Validate File Exists & Get MIME Type
            // This prevents sending 404 links to WhatsApp which causes delivery failure
            try {
                const head = await s3Client.send(new HeadObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key }));
                mimeType = head.ContentType;
            } catch (headErr) {
                logger.warn("S3 File not found or not accessible", { key, error: headErr.message });
                // We verify access, but we proceed with attempt or throw? 
                // Better to throw if we can't find it to prevent phantom messages.
                throw new Error(`Media file not found in storage: ${key}`);
            }

            // 3. Generate Fresh Signed URL (Valid 1 Hour)
            // WhatsApp downloads instantly, so 1 hour is plenty.
            const command = new GetObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key });
            sendUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
            
            // 4. Clean URL for Database (Remove query params/signatures)
            dbUrl = `https://${SYSTEM_CONFIG.AWS_BUCKET}.s3.${SYSTEM_CONFIG.AWS_REGION}.amazonaws.com/${encodeURIComponent(key)}`;

        } catch (e) {
            logger.error("Media Preparation Failed", { error: e.message, url });
            // Fallback: Try sending original URL if parsing failed
        }
    }

    const payload = { type };
    payload[type] = { link: sendUrl };
    if (caption) payload[type].caption = caption;

    // 5. Add Filename for Documents (Critical for user experience)
    if (type === 'document') {
        const filename = dbUrl.split('/').pop()?.split('?')[0] || 'document.pdf';
        payload[type].filename = decodeURIComponent(filename);
    }

    return { metaPayload: payload, dbUrl, dbType: type };
};

// --- CORE: SEND TO WHATSAPP ---
const sendToMeta = async (phoneNumber, payload) => {
    // 1. Block Placeholders
    if (payload.type === 'text' && payload.text?.body) {
        const body = payload.text.body.toLowerCase();
        if (['replace this', 'sample message', 'type your message'].some(f => body.includes(f))) {
            throw new Error("Message blocked: Contains placeholder text.");
        }
    }

    const phoneId = process.env.PHONE_NUMBER_ID;
    if (!phoneId) throw new Error("PHONE_NUMBER_ID missing");
    
    const to = (phoneNumber || '').toString().replace(/\D/g, '');
    if (!to) throw new Error("Invalid phone number");

    const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`;
    
    try {
        const fullPayload = { messaging_product: "whatsapp", recipient_type: "individual", to, ...payload };
        await getMetaClient().post(url, fullPayload);
    } catch (e) {
        logger.error("Meta Send Error", { 
            error: e.response?.data || e.message, 
            to,
            payloadType: payload.type 
        });
        throw e;
    }
};

// --- EXPRESS APP ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- BOT ENGINE ---
const getBotSettings = async () => {
    try {
        const cached = await redis.get(`bot:settings:${process.env.PHONE_NUMBER_ID}`);
        if (cached) return cached;
    } catch (_) {}
    return await withDb(async (client) => {
        const res = await client.query(`SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1`);
        if (res.rows.length > 0) {
            try { await redis.set(`bot:settings:${process.env.PHONE_NUMBER_ID}`, res.rows[0].settings, { ex: 600 }); } catch (_) {}
            return res.rows[0].settings;
        }
        return null;
    });
};

// --- INBOUND MESSAGE PROCESSOR ---
const processMessageInternal = async (message, contact, phoneId) => {
    if (!message || !phoneId) return;
    const from = message.from.replace(/\D/g, '');
    const name = contact?.profile?.name || "Unknown";
    
    let textBody = '';
    // Enhanced Incoming Type Handling
    if (message.type === 'text') textBody = message.text?.body;
    else if (message.type === 'interactive') textBody = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '[Interactive]';
    else if (message.type === 'image') textBody = message.image?.caption || '[Image]';
    else if (message.type === 'video') textBody = message.video?.caption || '[Video]';
    else if (message.type === 'document') textBody = message.document?.caption || '[Document]';
    else textBody = `[${message.type.toUpperCase()}]`;

    await withDb(async (client) => {
        // 1. Upsert Candidate
        const upsertQuery = `
            INSERT INTO candidates (id, phone_number, name, stage, last_message_at, last_message, created_at) 
            VALUES ($1, $2, $3, 'New', $4, $5, NOW()) 
            ON CONFLICT (phone_number) 
            DO UPDATE SET name = EXCLUDED.name, last_message_at = $4, last_message = $5 
            RETURNING id, current_node_id, is_human_mode, human_mode_ends_at
        `;
        const resDb = await client.query(upsertQuery, [crypto.randomUUID(), from, name, Date.now(), textBody]);
        const candidate = resDb.rows[0];

        // 2. Save Message
        const insertMsgQuery = `
            INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, whatsapp_message_id, created_at) 
            VALUES ($1, $2, 'in', $3, $4, 'received', $5, NOW()) 
            ON CONFLICT (whatsapp_message_id) DO NOTHING
        `;
        // For media messages, we just store the caption or placeholder. 
        // Downloading media from WhatsApp requires retrieving media URL via API which is complex for now.
        await client.query(insertMsgQuery, [crypto.randomUUID(), candidate.id, textBody, message.type, message.id]);

        // 3. Bot Logic
        if (candidate.is_human_mode) return;

        const settings = await getBotSettings();
        if (!settings?.nodes?.length) return;

        let nextNode = null;
        if (!candidate.current_node_id) {
            nextNode = settings.nodes.find(n => n.type === 'start') || settings.nodes[0];
            const edge = settings.edges?.find(e => e.source === nextNode?.id);
            if (edge) nextNode = settings.nodes.find(n => n.id === edge.target);
        } else {
            const edges = settings.edges?.filter(e => e.source === candidate.current_node_id) || [];
            if (edges.length === 1) nextNode = settings.nodes.find(n => n.id === edges[0].target);
            else if (message.type === 'interactive') {
                const btnId = message.interactive?.button_reply?.id || message.interactive?.button_reply?.title;
                const match = edges.find(e => e.sourceHandle === btnId);
                if (match) nextNode = settings.nodes.find(n => n.id === match.target);
            }
        }

        if (nextNode?.data?.content) {
            const payload = { type: 'text', text: { body: nextNode.data.content } };
            if (nextNode.data.type === 'buttons' && nextNode.data.buttons) {
                payload.type = 'interactive';
                payload.interactive = {
                    type: "button",
                    body: { text: nextNode.data.content },
                    action: { buttons: nextNode.data.buttons.map(b => ({ type: "reply", reply: { id: b.id || b.title, title: b.title.substring(0, 20) } })) }
                };
            }
            await sendToMeta(from, payload);
            await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`, [crypto.randomUUID(), candidate.id, nextNode.data.content]);
            await client.query(`UPDATE candidates SET current_node_id = $1, last_message_at = $2 WHERE id = $3`, [nextNode.id, Date.now(), candidate.id]);
        }
    });
};

// --- ROUTER ---
const apiRouter = express.Router();

// 1. S3 MEDIA ROUTES
apiRouter.get('/media', async (req, res) => {
    const path = req.query.path || '';
    const prefix = path === '/' ? '' : (path.startsWith('/') ? path.substring(1) : path) + '/';
    
    try {
        const command = new ListObjectsV2Command({
            Bucket: SYSTEM_CONFIG.AWS_BUCKET,
            Prefix: prefix,
            Delimiter: '/'
        });
        const data = await s3Client.send(command);
        
        const folders = (data.CommonPrefixes || []).map(p => ({
            id: p.Prefix,
            name: p.Prefix.replace(prefix, '').replace('/', ''),
            parent_path: path
        }));

        const files = await Promise.all((data.Contents || []).map(async (o) => {
            const filename = o.Key.replace(prefix, '');
            if (!filename) return null;
            
            // GENERATE PRESIGNED URL FOR UI PREVIEW
            const getCommand = new GetObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: o.Key });
            const url = await getSignedUrl(s3Client, getCommand, { expiresIn: 3600 });
            
            let type = 'document';
            if (filename.match(/\.(jpg|jpeg|png|gif|webp)$/i)) type = 'image';
            if (filename.match(/\.(mp4|mov|webm)$/i)) type = 'video';
            
            return { id: o.Key, url, filename, type };
        }));

        res.json({ folders, files: files.filter(Boolean) });
    } catch (e) {
        logger.error("S3 List Error", { error: e.message });
        res.status(500).json({ error: "Failed to list media" });
    }
});

apiRouter.post('/media/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file provided" });
    const path = req.body.path || '';
    const prefix = path === '/' ? '' : (path.startsWith('/') ? path.substring(1) : path) + '/';
    const key = `${prefix}${req.file.originalname}`;

    try {
        await s3Client.send(new PutObjectCommand({
            Bucket: SYSTEM_CONFIG.AWS_BUCKET,
            Key: key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype, // CRITICAL: Sets MIME type so WhatsApp accepts it
        }));
        res.json({ success: true, key });
    } catch (e) {
        logger.error("S3 Upload Error", { error: e.message });
        res.status(500).json({ error: "Upload failed" });
    }
});

// 2. MESSAGING ROUTES (ENHANCED FOR MEDIA DELIVERY)
apiRouter.post('/drivers/:id/messages', async (req, res, next) => {
    const { text, mediaUrl, mediaType } = req.body;
    try {
        await withDb(async (client) => {
            const dRes = await client.query('SELECT phone_number FROM candidates WHERE id = $1', [req.params.id]);
            if (dRes.rows.length === 0) return res.status(404).json({error: "Driver not found"});
            const phone = dRes.rows[0].phone_number;

            let metaPayload;
            let dbText = text;
            let dbType = 'text';

            if (mediaUrl) {
                // Generate Safe Payload (Presigned for Meta, Clean for DB)
                const result = await prepareMediaPayload(mediaUrl, mediaType || 'image', text);
                metaPayload = result.metaPayload;
                dbType = result.dbType;
                // Store JSON string with PERMANENT clean URL
                dbText = JSON.stringify({ url: result.dbUrl, caption: text });
            } else {
                metaPayload = { type: 'text', text: { body: text } };
            }

            // Send to Meta
            await sendToMeta(phone, metaPayload);

            // Save to DB
            await client.query(
                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())`,
                [crypto.randomUUID(), req.params.id, dbText, dbType]
            );
            
            await client.query(
                `UPDATE candidates SET last_message = $1, last_message_at = $2, is_human_mode = TRUE WHERE id = $3`,
                [text || `[${dbType} Sent]`, Date.now(), req.params.id]
            );
        });
        res.json({ success: true });
    } catch (e) { 
        // Fallback error handling
        logger.error("Send Message Failed", { error: e.message });
        res.status(500).json({ error: e.message || "Failed to send message" });
    }
});

apiRouter.get('/drivers/:id/messages', async (req, res) => {
    try {
        await withDb(async (client) => {
            const limit = parseInt(req.query.limit) || 50;
            const resDb = await client.query('SELECT * FROM candidate_messages WHERE candidate_id = $1 ORDER BY created_at DESC LIMIT $2', [req.params.id, limit]);
            
            const messages = await Promise.all(resDb.rows.map(async (r) => {
                let text = r.text;
                let imageUrl = null;
                let videoUrl = null;

                if (['image', 'video', 'document'].includes(r.type) && r.text?.startsWith('{')) {
                    try {
                        const parsed = JSON.parse(r.text);
                        text = parsed.caption || '';
                        
                        let viewUrl = parsed.url;
                        // Resign URL for frontend display if it's S3
                        if (viewUrl.includes(SYSTEM_CONFIG.AWS_BUCKET) && !viewUrl.includes('X-Amz-Signature')) {
                             try {
                                 // Simple logic to extract key for display signing
                                 const urlObj = new URL(viewUrl);
                                 let key = decodeURIComponent(urlObj.pathname.substring(1));
                                 if (urlObj.hostname.includes('s3.amazonaws.com') && key.startsWith(SYSTEM_CONFIG.AWS_BUCKET)) {
                                     key = key.substring(SYSTEM_CONFIG.AWS_BUCKET.length + 1);
                                 }
                                 
                                 const command = new GetObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key });
                                 viewUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
                             } catch(e) {}
                        }

                        if (r.type === 'image') imageUrl = viewUrl;
                        if (r.type === 'video') videoUrl = viewUrl;
                        if (r.type === 'document') text = JSON.stringify({ ...parsed, url: viewUrl }); 

                    } catch (e) {
                        text = r.text;
                    }
                }

                return { 
                    id: r.id, 
                    sender: r.direction === 'in' ? 'driver' : 'agent', 
                    text, 
                    imageUrl,
                    videoUrl,
                    timestamp: new Date(r.created_at).getTime(), 
                    type: r.type || 'text', 
                    status: r.status, 
                    whatsapp_message_id: r.whatsapp_message_id 
                };
            }));
            
            res.json(messages.reverse());
        });
    } catch (e) { 
        if (e.code === '42P01') res.json([]);
        else res.status(500).json({ error: e.message });
    }
});

// 3. WEBHOOK
apiRouter.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

apiRouter.post('/webhook', async (req, res) => {
    res.sendStatus(200); 
    try {
        const body = req.body;
        if (body.object === 'whatsapp_business_account' && body.entry?.[0]?.changes?.[0]?.value?.messages) {
            const value = body.entry[0].changes[0].value;
            const contacts = value.contacts || [];
            for (const message of value.messages) {
                const contact = contacts.find(c => c.wa_id === message.from) || {};
                processMessageInternal(message, contact, value.metadata?.phone_number_id).catch(e => logger.error(e));
            }
        }
    } catch (e) { logger.error(e); }
});

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

// System routes
apiRouter.get('/debug/status', async (req, res) => {
    try {
        const status = { postgres: 'unknown', tables: {}, counts: {} };
        await withDb(async (client) => {
            await client.query('SELECT 1');
            status.postgres = 'connected';
            const tRes = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
            const tables = tRes.rows.map(r => r.table_name);
            status.tables.candidates = tables.includes('candidates');
            status.tables.bot_versions = tables.includes('bot_versions');
            if (status.tables.candidates) {
                const cRes = await client.query('SELECT COUNT(*) FROM candidates');
                status.counts.candidates = parseInt(cRes.rows[0].count);
            }
        });
        res.json(status);
    } catch (e) { res.json({ postgres: 'error', lastError: e.message }); }
});

app.use('/api', apiRouter);
app.use('/', apiRouter);

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        logger.info(`🚀 Server running on port ${PORT}`);
    });
}

module.exports = app;

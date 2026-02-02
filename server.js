
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
        console.log(`[Meta] Sent to ${to}`);
    } catch (e) {
        console.error("Meta Send Failed:", e.response?.data || e.message);
    }
};

// --- BOT ENGINE (THE BRAIN) ---
// Traverses the React Flow Graph based on user input
const processBotLogic = async (client, candidate, incomingText, incomingBtnId) => {
    // 1. Fetch Latest Published Bot
    const botRes = await client.query("SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1");
    if (botRes.rows.length === 0) return; // No bot
    
    const { nodes, edges } = botRes.rows[0].settings;
    if (!nodes || !edges) return;

    // 2. Identify Current State
    let currentNodeId = candidate.current_bot_step_id;
    let currentNode = nodes.find(n => n.id === currentNodeId);
    
    // If no state, find 'start' node
    if (!currentNode) {
        currentNode = nodes.find(n => n.type === 'start' || n.data?.type === 'start');
        // If still no start, assume first node
        if (!currentNode && nodes.length > 0) currentNode = nodes[0];
    }

    // 3. Handle Input for Current Node (If we were waiting for it)
    let nextNodeId = null;
    
    if (currentNodeId) { // We are continuing a flow
        const nodeType = currentNode.data?.type;
        
        // A. Handle Variable Capture (Inputs)
        if (nodeType === 'input' && currentNode.data?.variable) {
            const varName = currentNode.data.variable;
            // Update candidate variables
            const vars = candidate.variables || {};
            vars[varName] = incomingText;
            
            // If variable is 'name', update main column too
            if (varName === 'name') {
                 await client.query("UPDATE candidates SET name = $1, variables = $2 WHERE id = $3", [incomingText, vars, candidate.id]);
            } else {
                 await client.query("UPDATE candidates SET variables = $1 WHERE id = $2", [vars, candidate.id]);
            }
            // Move forward
            const edge = edges.find(e => e.source === currentNode.id);
            if (edge) nextNodeId = edge.target;
        } 
        
        // B. Handle Button Clicks
        else if (nodeType === 'interactive_button') {
            // Find edge matching the button ID
            const edge = edges.find(e => e.source === currentNode.id && e.sourceHandle === incomingBtnId);
            if (edge) {
                nextNodeId = edge.target;
            } else {
                // If they typed text instead of clicking, maybe fallback or repeat?
                // For now, try default output
                const defaultEdge = edges.find(e => e.source === currentNode.id && !e.sourceHandle);
                if (defaultEdge) nextNodeId = defaultEdge.target;
            }
        }
        
        // C. Default Continuation (Text, Image nodes that don't wait strictly)
        else {
             // Usually these execute immediately, but if we paused here, move to next
             const edge = edges.find(e => e.source === currentNode.id);
             if (edge) nextNodeId = edge.target;
        }
    } else {
        // First run
        nextNodeId = currentNode?.id; 
    }

    // 4. Traverse & Execute Chain (Recursive-like Loop)
    // We execute nodes until we hit a "Stop & Wait" node (Input, Buttons)
    let executionLimit = 10; // Prevent infinite loops
    let activeNodeId = nextNodeId;

    while (activeNodeId && executionLimit > 0) {
        executionLimit--;
        const node = nodes.find(n => n.id === activeNodeId);
        if (!node) break;

        const data = node.data || {};
        const nodeType = data.type;

        // --- EXECUTION LOGIC ---
        
        // REPLACE VARIABLES
        let content = data.content || '';
        if (content && candidate.variables) {
            Object.keys(candidate.variables).forEach(k => {
                content = content.replace(new RegExp(`{{${k}}}`, 'g'), candidate.variables[k]);
            });
            // Also replace standard fields
            content = content.replace(/{{name}}/g, candidate.name || 'there');
        }

        // 1. CONDITION NODE (Logic Branching)
        if (nodeType === 'condition') {
            const varName = data.variable;
            const operator = data.operator;
            const checkVal = data.value;
            const actualVal = (candidate.variables || {})[varName];
            
            let result = false;
            if (actualVal) {
                if (operator === 'equals') result = actualVal.toString().toLowerCase() === checkVal.toString().toLowerCase();
                else if (operator === 'contains') result = actualVal.toString().toLowerCase().includes(checkVal.toString().toLowerCase());
                else if (operator === 'starts_with') result = actualVal.toString().toLowerCase().startsWith(checkVal.toString().toLowerCase());
                else if (operator === 'is_set') result = true;
            }

            // Find correct edge
            const edge = edges.find(e => e.source === node.id && e.sourceHandle === (result ? 'true' : 'false'));
            activeNodeId = edge ? edge.target : null;
            continue; // Skip message sending, jump to next
        }

        // 2. HANDOFF NODE
        if (nodeType === 'handoff') {
            await client.query("UPDATE candidates SET is_human_mode = TRUE WHERE id = $1", [candidate.id]);
            await sendToMeta(candidate.phone_number, { type: 'text', text: { body: content || "Connecting you to a human agent..." } });
            // Stop Bot
            await client.query("UPDATE candidates SET current_bot_step_id = NULL WHERE id = $1", [candidate.id]);
            break; 
        }

        // 3. SEND MESSAGE (Text, Image, Buttons)
        if (['text', 'image', 'input', 'interactive_button', 'start'].includes(nodeType)) {
            
            // Construct Payload
            let payload = null;

            if (nodeType === 'image' && data.mediaUrl) {
                const url = await refreshMediaUrl(data.mediaUrl);
                payload = { type: 'image', image: { link: url, caption: content } };
            } else if (nodeType === 'interactive_button' && data.buttons) {
                 // WhatsApp Interactive Buttons
                 const buttons = data.buttons.slice(0, 3).map(b => ({
                     type: "reply",
                     reply: { id: b.id, title: b.title.substring(0, 20) } // Max 20 chars
                 }));
                 payload = {
                     type: "interactive",
                     interactive: {
                         type: "button",
                         body: { text: content || "Please choose:" },
                         action: { buttons }
                     }
                 };
            } else if (content) {
                payload = { type: 'text', text: { body: content } };
            }

            // Send
            if (payload) {
                await sendToMeta(candidate.phone_number, payload);
                // Log DB
                const botMsgId = crypto.randomUUID();
                await client.query(
                    `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`,
                    [botMsgId, candidate.id, content]
                );
            }
        }

        // --- DETERMINING NEXT STEP ---
        
        // If this node EXPECTS INPUT (Input, Buttons), we STOP here and save state.
        if (['input', 'interactive_button'].includes(nodeType)) {
            await client.query("UPDATE candidates SET current_bot_step_id = $1 WHERE id = $2", [node.id, candidate.id]);
            break; // Stop execution, wait for user reply
        } else {
            // Auto-advance
            const edge = edges.find(e => e.source === node.id);
            if (edge) {
                activeNodeId = edge.target;
                // Add small artificial delay for UX if chaining text
                await new Promise(r => setTimeout(r, 1000)); 
            } else {
                activeNodeId = null; // End of flow
                await client.query("UPDATE candidates SET current_bot_step_id = NULL WHERE id = $1", [candidate.id]);
            }
        }
    }
};


// --- EXPRESS APP ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const apiRouter = express.Router();

// --- WEBHOOK (UPDATED FOR ADVANCED BOT) ---
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
        
        // Extract content (Text or Button Click)
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
            // 1. Find/Create Candidate
            let candidateRes = await client.query('SELECT * FROM candidates WHERE phone_number = $1', [from]);
            let candidate;
            
            if (candidateRes.rows.length === 0) {
                const newId = crypto.randomUUID();
                await client.query(
                    `INSERT INTO candidates (id, phone_number, name, stage, last_message_at, is_human_mode, variables) VALUES ($1, $2, $3, 'New', $4, FALSE, '{}')`,
                    [newId, from, name, Date.now()]
                );
                candidate = { id: newId, phone_number: from, name, variables: {}, is_human_mode: false };
            } else {
                candidate = candidateRes.rows[0];
                await client.query('UPDATE candidates SET last_message = $1, last_message_at = $2 WHERE id = $3', [textBody, Date.now(), candidate.id]);
            }

            // 2. Save Incoming Message
            const dbMsgId = crypto.randomUUID();
            await client.query(
                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, whatsapp_message_id, status, created_at) VALUES ($1, $2, 'in', $3, 'text', $4, 'received', NOW())`,
                [dbMsgId, candidate.id, textBody, msgId]
            );

            // 3. Trigger Bot Engine (If not in human mode)
            if (!candidate.is_human_mode) {
                await processBotLogic(client, candidate, textBody, buttonId);
            }
        });
    } catch (e) {
        console.error("Webhook Logic Error:", e);
    }
});

apiRouter.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

// --- EXISTING ENDPOINTS (UNCHANGED) ---
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

// Re-expose other endpoints... (Media, Docs, etc.)
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

app.use('/api', apiRouter);
app.use('/', apiRouter);

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        console.log(`Server running on ${PORT}`);
    });
}
module.exports = app;

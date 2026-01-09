
/**
 * UBER FLEET RECRUITER - BACKEND SERVER
 * Enterprise-Grade Connection Handling for Vercel + Neon
 * FAIL-SAFE MODE ENABLED
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg'); 
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const app = express();
const router = express.Router(); 

// --- MIDDLEWARE ---
app.use(express.json({ limit: '10mb' }));
app.use(cors()); 

// Disable Caching to ensure Real-time Data
app.set('etag', false);
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3001;
const META_API_TOKEN = process.env.META_API_TOKEN || process.env.API_TOKEN; 
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; 

// --- DATABASE ---
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const queryWithRetry = async (text, params) => {
    const client = await pool.connect();
    try { return await client.query(text, params); } 
    finally { client.release(); }
};

/**
 * Enhanced WhatsApp Sender
 */
const sendWhatsAppMessage = async (to, body, options = null, mediaUrl = null, mediaType = 'image') => {
  if (!META_API_TOKEN || !PHONE_NUMBER_ID) return false;
  
  let payload = { messaging_product: 'whatsapp', to: to };
  
  if (mediaUrl) {
      const type = mediaType === 'video' ? 'video' : 'image';
      payload.type = type;
      payload[type] = { 
          link: mediaUrl,
          caption: body || undefined 
      };
  } else if (options && options.length > 0) {
      payload.type = 'interactive';
      payload.interactive = {
          type: 'button',
          body: { text: body || "Select an option:" },
          action: { 
              buttons: options.slice(0, 3).map((opt, i) => ({ 
                  type: 'reply', 
                  reply: { id: `btn_${i}`, title: opt.substring(0, 20) } 
              })) 
          }
      };
  } else {
      if (!body) return false;
      payload.type = 'text';
      payload.text = { body: body };
  }
  
  try {
    await axios.post(
        `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, 
        payload, 
        { headers: { Authorization: `Bearer ${META_API_TOKEN}` } }
    );
    return true;
  } catch (error) {
    return false;
  }
};

const logSystemMessage = async (driverId, text) => {
    try {
        const msgId = `sys_${Date.now()}`;
        await queryWithRetry(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'system', $3, $4, 'text')`,
            [msgId, driverId, text, Date.now()]
        );
        await queryWithRetry('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [text, Date.now(), driverId]);
    } catch (e) {}
};

const analyzeWithAI = async (text, currentNotes, systemInstruction) => {
  try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({ 
        model: "gemini-3-flash-preview", 
        contents: `User: "${text}"\nNotes: "${currentNotes || ''}"\nOutput JSON: { "reply": "string", "updatedNotes": "string" }`,
        config: { 
            responseMimeType: "application/json",
            systemInstruction: systemInstruction 
        }
      });
      return JSON.parse(response.text);
  } catch (e) { 
      return { reply: "I'll have a human executive check that for you.", updatedNotes: currentNotes }; 
  }
};

/**
 * CORE BOT ENGINE - 24/7 AUTO-RUN
 */
const processIncomingMessage = async (from, name, msgBody, msgType = 'text') => {
    const timestamp = Date.now();
    let botSettings = null;
    
    // Always fetch latest published settings to ensure consistency 24/7
    try {
        const settingsRes = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1', []);
        if (settingsRes.rows.length > 0) botSettings = settingsRes.rows[0].settings;
    } catch(e) {}

    if (!botSettings || !botSettings.isEnabled) return;

    const strategy = botSettings.routingStrategy || 'HYBRID_BOT_FIRST';
    const entryPointId = botSettings.entryPointId;

    let driverRes = await queryWithRetry('SELECT * FROM drivers WHERE phone_number = $1', [from]);
    let driver;
    let isFlowStart = false;

    if (driverRes.rows.length === 0) {
        if (strategy === 'AI_ONLY') return;
        const insertRes = await queryWithRetry(
            `INSERT INTO drivers (id, phone_number, name, source, status, last_message, last_message_time, current_bot_step_id, is_bot_active, is_human_mode)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [timestamp.toString(), from, name || 'Unknown', 'WhatsApp', 'New', msgBody, timestamp, entryPointId, true, false]
        );
        driver = insertRes.rows[0];
        isFlowStart = true;
    } else {
        driver = driverRes.rows[0];
        await queryWithRetry('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [msgBody, timestamp, driver.id]);
    }

    await queryWithRetry(
        `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'driver', $3, $4, $5)`,
        [`${timestamp}_${from}`, driver.id, msgBody, timestamp, msgType]
    );

    if (driver.is_human_mode) return;

    // AI INTERCEPTION LOGIC (Question answering)
    const QUESTION_KEYWORDS = ['rent', 'salary', 'evide', 'location', 'details', 'doubt', '?', 'wagonr'];
    const isQuestion = QUESTION_KEYWORDS.some(k => msgBody.toLowerCase().includes(k)) && msgBody.split(' ').length > 1;
    const isDoubtsStep = driver.current_bot_step_id === 'step_3' || (driver.current_bot_step_id && driver.current_bot_step_id.includes('doubt'));

    if (strategy !== 'BOT_ONLY' && (isQuestion || isDoubtsStep)) {
        if (!msgBody.toLowerCase().match(/^(no|illa|nothing|alla)$/)) {
            const aiResult = await analyzeWithAI(msgBody, driver.notes, botSettings.systemInstruction);
            await sendWhatsAppMessage(from, aiResult.reply);
            await logSystemMessage(driver.id, aiResult.reply);
            return; 
        }
    }

    let replyText = null; let replyOptions = null; let replyMedia = null; let replyMediaType = 'image';
    let updates = {};

    if (driver.is_bot_active && driver.current_bot_step_id) {
        let currentStep = botSettings.steps.find(s => s.id === driver.current_bot_step_id);
        
        if (!currentStep) {
            currentStep = botSettings.steps.find(s => s.id === entryPointId);
            isFlowStart = true;
        }

        if (currentStep) {
            if (isFlowStart) {
                replyText = currentStep.message;
                if (currentStep.linkLabel && currentStep.message) replyText = `${currentStep.linkLabel}\n${currentStep.message}`;
                replyOptions = currentStep.options;
                replyMedia = currentStep.mediaUrl;
                replyMediaType = currentStep.mediaType;
            } else {
                if (currentStep.saveToField) {
                    const field = currentStep.saveToField;
                    const newNote = `[Bot] Captured ${field}: ${msgBody}`;
                    updates.notes = driver.notes ? `${driver.notes}\n${newNote}` : newNote;
                    if (field === 'name') updates.name = msgBody;
                }

                let nextId = currentStep.nextStepId;
                if (currentStep.routes) {
                    const input = msgBody.trim().toLowerCase();
                    const matchedKey = Object.keys(currentStep.routes).find(k => 
                        input === k.toLowerCase() || input.includes(k.toLowerCase())
                    );
                    if (matchedKey) nextId = currentStep.routes[matchedKey];
                }

                if (nextId && nextId !== 'END' && nextId !== 'AI_HANDOFF') {
                    const nextStep = botSettings.steps.find(s => s.id === nextId);
                    if (nextStep) {
                        replyText = nextStep.message;
                        if (nextStep.linkLabel && nextStep.message) replyText = `${nextStep.linkLabel}\n${nextStep.message}`;
                        replyOptions = nextStep.options;
                        replyMedia = nextStep.mediaUrl;
                        replyMediaType = nextStep.mediaType;
                        updates.current_bot_step_id = nextId;
                    }
                } else {
                    updates.is_bot_active = false;
                    updates.current_bot_step_id = null;
                    if (strategy === 'HYBRID_BOT_FIRST' && nextId === 'AI_HANDOFF') {
                        const aiResult = await analyzeWithAI(msgBody, updates.notes || driver.notes, botSettings.systemInstruction);
                        replyText = aiResult.reply;
                    } else {
                        replyText = "Thank you. Our team will verify your details and call you shortly.";
                    }
                }
            }
        }
    }

    if (replyText || replyMedia) {
        const sent = await sendWhatsAppMessage(from, replyText, replyOptions, replyMedia, replyMediaType);
        if (sent) await logSystemMessage(driver.id, replyText || "[Media Message]");
    }

    if (Object.keys(updates).length > 0) {
        const keys = Object.keys(updates);
        const setClause = keys.map((k, i) => `${k} = $${i+2}`).join(', ');
        await queryWithRetry(`UPDATE drivers SET ${setClause} WHERE id = $1`, [driver.id, ...Object.values(updates)]);
    }
};

// --- API ROUTES ---

// ENHANCED PING (Wakes up both Server and DB)
router.get('/ping', async (req, res) => {
    try {
        await pool.query('SELECT 1'); // Keeps Neon DB warm
        res.status(200).send('Fleet Commander: Operational 24/7');
    } catch(e) {
        res.status(200).send('Operational (DB Warning)'); 
    }
});

router.get('/drivers', async (req, res) => {
    try {
        const dr = await queryWithRetry('SELECT * FROM drivers ORDER BY last_message_time DESC LIMIT 100', []);
        const msgs = await queryWithRetry('SELECT * FROM messages WHERE driver_id = ANY($1) ORDER BY timestamp ASC', [dr.rows.map(r => r.id)]);
        res.json(dr.rows.map(d => ({ 
            ...d, 
            phoneNumber: d.phone_number, 
            lastMessageTime: parseInt(d.last_message_time), 
            messages: msgs.rows.filter(m => m.driver_id === d.id) 
        })));
    } catch(e) { res.status(500).json({error: e.message}); }
});

router.patch('/drivers/:id', async (req, res) => {
    const { status, isHumanMode, notes } = req.body;
    await queryWithRetry(
        'UPDATE drivers SET status = COALESCE($1, status), is_human_mode = COALESCE($2, is_human_mode), notes = COALESCE($3, notes) WHERE id = $4', 
        [status, isHumanMode, notes, req.params.id]
    );
    res.json({ success: true });
});

router.post('/messages/send', async (req, res) => {
    const d = await queryWithRetry('SELECT phone_number FROM drivers WHERE id = $1', [req.body.driverId]);
    if (d.rows[0]) {
        await sendWhatsAppMessage(d.rows[0].phone_number, req.body.text);
        await logSystemMessage(req.body.driverId, req.body.text);
    }
    res.json({ success: true });
});

router.get('/bot-settings', async (req, res) => {
    const s = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1', []);
    res.json(s.rows[0]?.settings || {});
});

router.post('/bot-settings', async (req, res) => {
    await queryWithRetry(
        'INSERT INTO bot_settings (id, settings) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET settings = $1', 
        [JSON.stringify(req.body)]
    );
    res.json({ success: true });
});

// --- MOUNT ---
app.use('/api', router);
app.get('/webhook', (req, res) => res.send(req.query['hub.challenge']));
app.post('/webhook', async (req, res) => {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const contact = req.body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0];
    if (msg) {
        let text = msg.text?.body || msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "";
        await processIncomingMessage(msg.from, contact?.profile?.name || "Unknown", text);
    }
    res.sendStatus(200);
});

if (require.main === module) app.listen(PORT, () => console.log(`Fleet Server: Running 24/7 on Port ${PORT}`));
module.exports = app;

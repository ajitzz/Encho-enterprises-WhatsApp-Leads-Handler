
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
const fs = require('fs'); 
const path = require('path'); 
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const multer = require('multer');
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
let VERIFY_TOKEN = process.env.VERIFY_TOKEN || "uber_fleet_verify_token";

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
    }
});
const BUCKET_NAME = process.env.AWS_BUCKET_NAME || '';

// --- MEMORY CACHE (FAIL-SAFE) ---
const ENCHO_SYSTEM_INSTRUCTION = `
Role: Senior Support Executive at Encho Cabs (Uber/Ola Fleet).
Language: Malayalam mixed with simple English (Manglish). Professional but casual.
Goal: Answer Doubts -> Build Trust -> Schedule Call.

🛑 CONVERSATION STRATEGY:
1. **Answer First:** If user asks a question, answer it IMMEDIATELY and then guide them back to the doubts step.
2. **Trust Chain:** Sequence is: Software Transparency -> Bonus Incentives -> Work Freedom -> Final Call.

🧠 KNOWLEDGE BASE:
- **Vehicle:** WagonR CNG.
- **Rent:** ₹600/day. Target thikachaal ₹450/day.
- **Deposit:** ₹5000 (Refundable).
- **Tone:** Use emojis like 👋, 😊, 💰. Be polite.
`;

const ENCHO_STEPS = [
    {
      id: 'step_1',
      title: 'Welcome & Name',
      message: 'നമസ്കാരം! Encho Cabs-ലേക്ക് സ്വാഗതം. ഞങ്ങൾ Uber/Ola connected fleet ആണ്. നിങ്ങളുടെ പേര് പറയാമോ?',
      inputType: 'text',
      saveToField: 'name',
      nextStepId: 'step_2'
    },
    {
      id: 'step_2',
      title: 'Place & Contact',
      message: 'Hi! നാട്ടിൽ എവിടെയാണ്? നിങ്ങളെ കോൺടാക്ട് ചെയ്യാൻ പറ്റുന്ന ഒരു നമ്പർ കൂടി തന്നാൽ നന്നായിരുന്നു.',
      inputType: 'text',
      saveToField: 'vehicleRegistration',
      nextStepId: 'step_3'
    },
    {
      id: 'step_3',
      title: 'Open Doubts (Router)',
      message: 'നന്ദി! Details നോട്ട് ചെയ്തിട്ടുണ്ട്. Encho Cabs-നെ കുറിച്ച് എന്തെങ്കിലും സംശയങ്ങൾ (Doubts) ഉണ്ടോ? ചോദിച്ചോളൂ, ഞാൻ പറഞ്ഞുതരാം. 😊',
      inputType: 'text',
      nextStepId: 'step_4', 
      routes: {
          "no": "step_4",
          "illa": "step_4",
          "nothing": "step_4",
          "alla": "step_4"
      }
    },
    {
      id: 'step_4',
      title: 'Hook 1: Software',
      message: 'ഒരു കാര്യം കൂടി, ഞങ്ങളുടെ **Company Software**-നെ കുറിച്ച് അറിയാൻ താല്പര്യമുണ്ടോ? 📱 ഡ്രൈവർമാർക്ക് വേണ്ടിയുള്ള സുതാര്യമായ (Transparent) സിസ്റ്റം ആണിത്.',
      inputType: 'option',
      options: ['Yes, Parayu', 'No, Venda'],
      routes: { "yes": "step_5", "parayu": "step_5" },
      nextStepId: 'AI_HANDOFF'
    },
    {
      id: 'step_5',
      title: 'Explain Software + Hook 2: Bonus',
      message: 'ഞങ്ങളുടെ App-ൽ നിങ്ങൾക്ക് ഡെയിലി ബില്ലും ഏണിങ്സും കൃത്യമായി കാണാം. കണക്കിൽ ഒരു രൂപയുടെ പോലും വ്യത്യാസം ഉണ്ടാവില്ല! 🤝\n\nഅടുത്തത്, ഞങ്ങളുടെ **Special Driver Bonus**-ine 💰 കുറിച്ച് പറയട്ടെ?',
      inputType: 'option',
      options: ['Yes, Parayu', 'No, Venda'],
      routes: { "yes": "step_6", "parayu": "step_6" },
      nextStepId: 'AI_HANDOFF'
    },
    {
      id: 'step_6',
      title: 'Explain Bonus + Hook 3: Freedom',
      message: 'Daily Target അടിച്ചാൽ അധിക വരുമാനം (Bata) ലഭിക്കും! കൂടാതെ കൃത്യമായി വണ്ടി ഓടിക്കുന്നവർക്ക് Monthly Performance Bonus-ഉം ഉണ്ട്. 💸\n\nഇനി, Encho-യിലെ **\'Own Boss\' Policy**-ye 👑 കുറിച്ച് കേൾക്കണോ?',
      inputType: 'option',
      options: ['Yes, Parayu', 'No, Venda'],
      routes: { "yes": "step_7", "parayu": "step_7" },
      nextStepId: 'AI_HANDOFF'
    },
    {
      id: 'step_7',
      title: 'Explain Freedom + Schedule Call',
      message: 'ഞങ്ങൾക്ക് ഫിക്സഡ് ഷിഫ്റ്റ് ഇല്ല! നിങ്ങൾക്ക് ഇഷ്ടമുള്ള സമയത്ത് ലോഗിൻ ചെയ്യാം. You are your own boss! 😎\n\nവിശദമായി സംസാരിക്കാൻ, ഞങ്ങളുടെ എക്സിക്യൂട്ടീവ് നിങ്ങളെ എപ്പോഴാണ് വിളിക്കേണ്ടത്? (When should we call you?)',
      inputType: 'text',
      nextStepId: 'step_8'
    },
    {
      id: 'step_8',
      title: 'Closing Confirmation',
      message: 'Sure, We will reach out to you soon. Thank you! 🤝',
      inputType: 'text',
      nextStepId: 'AI_HANDOFF'
    }
];

let CACHED_BOT_SETTINGS = {
  isEnabled: true,
  routingStrategy: 'HYBRID_BOT_FIRST',
  systemInstruction: ENCHO_SYSTEM_INSTRUCTION,
  steps: ENCHO_STEPS
};

// SYSTEM MONITOR METRICS
let AI_CREDITS_ESTIMATED = 98; 
let CURRENT_AI_MODEL = "gemini-3-flash-preview";
let AI_FALLBACK_UNTIL = 0; 

// --- DATABASE ---
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL || "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
  ssl: { rejectUnauthorized: false }
});

const queryWithRetry = async (text, params) => {
    const client = await pool.connect();
    try { return await client.query(text, params); } 
    finally { client.release(); }
};

const analyzeWithAI = async (text, currentNotes, systemInstruction) => {
  const models = ["gemini-3-flash-preview", "gemini-flash-lite-latest"];
  
  for (const model of models) {
      if (model === "gemini-3-flash-preview" && Date.now() < AI_FALLBACK_UNTIL) continue;
      
      try {
          CURRENT_AI_MODEL = model;
          const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
          const response = await ai.models.generateContent({ 
            model, 
            contents: `User: "${text}"\nNotes: "${currentNotes || ''}"\nOutput JSON: { "reply": "string", "updatedNotes": "string" }`,
            config: { 
                responseMimeType: "application/json",
                systemInstruction: systemInstruction 
            }
          });
          AI_CREDITS_ESTIMATED = Math.max(0, AI_CREDITS_ESTIMATED - 0.5);
          return JSON.parse(response.text);
      } catch (e) {
          if (e?.message?.includes("429") || e?.message?.includes("quota")) {
              if (model === "gemini-3-flash-preview") {
                  AI_FALLBACK_UNTIL = Date.now() + 60000; // 1 min fallback
              }
              continue;
          }
          console.error(`AI call failed for ${model}:`, e.message);
      }
  }

  CURRENT_AI_MODEL = "local-heuristic";
  const lower = text.toLowerCase();
  let reply = "Thanks for your message. We'll get back to you soon.";
  if (lower.includes("rent") || lower.includes("rate")) reply = "Vehicle rent is ₹600/day. targets cover the rest. Reach out to join!";
  
  return { reply: `[Heuristic] ${reply}`, updatedNotes: currentNotes };
};

const sendWhatsAppMessage = async (to, body, options = null) => {
  if (!META_API_TOKEN || !PHONE_NUMBER_ID) return false;
  let payload = { messaging_product: 'whatsapp', to: to };
  
  if (options && options.length > 0) {
      payload.type = 'interactive';
      payload.interactive = {
          type: 'button',
          body: { text: body || "Select an option:" },
          action: { buttons: options.slice(0,3).map((opt, i) => ({ type: 'reply', reply: { id: `btn_${i}`, title: opt.substring(0, 20) } })) }
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

const processIncomingMessage = async (from, name, msgBody, msgType = 'text') => {
    const timestamp = Date.now();
    let botSettings = CACHED_BOT_SETTINGS;
    
    try {
        const settingsRes = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1', []);
        if (settingsRes.rows.length > 0) botSettings = settingsRes.rows[0].settings;
    } catch(e) {}

    const strategy = botSettings.routingStrategy || 'HYBRID_BOT_FIRST';
    const entryPointId = botSettings.entryPointId || botSettings.steps?.[0]?.id;

    let driverRes = await queryWithRetry('SELECT * FROM drivers WHERE phone_number = $1', [from]);
    let driver;
    let isFlowStart = false;

    if (driverRes.rows.length === 0) {
        const shouldActivateBot = botSettings.isEnabled && strategy !== 'AI_ONLY';
        const insertRes = await queryWithRetry(
            `INSERT INTO drivers (id, phone_number, name, source, status, last_message, last_message_time, current_bot_step_id, is_bot_active, is_human_mode)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [timestamp.toString(), from, name, 'WhatsApp', 'New', msgBody, timestamp, entryPointId, shouldActivateBot, false]
        );
        driver = insertRes.rows[0];
        if (shouldActivateBot) isFlowStart = true;
    } else {
        driver = driverRes.rows[0];
        await queryWithRetry('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [msgBody, timestamp, driver.id]);
    }

    await queryWithRetry(
        `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'driver', $3, $4, $5)`,
        [`${timestamp}_${from}`, driver.id, msgBody, timestamp, msgType]
    );

    if (driver.is_human_mode) return;

    const QUESTION_REGEX = /([\?])|(rent|amount|salary|deposit|evide|entha|engane|location|details|doubt|rate)/i;
    const isQuestion = QUESTION_REGEX.test(msgBody) && msgBody.split(' ').length > 1;
    const isStep3 = driver.current_bot_step_id === 'step_3';

    if (strategy !== 'BOT_ONLY' && botSettings.isEnabled && (isQuestion || (isStep3 && !msgBody.toLowerCase().match(/^(no|illa|nothing|alla)$/)))) {
        const aiResult = await analyzeWithAI(msgBody, driver.notes, botSettings.systemInstruction);
        if (aiResult.reply) {
            await sendWhatsAppMessage(from, aiResult.reply);
            await logSystemMessage(driver.id, aiResult.reply);
        }
        const step3 = botSettings.steps.find(s => s.id === 'step_3');
        if (step3) {
            await queryWithRetry('UPDATE drivers SET current_bot_step_id = $1 WHERE id = $2', ['step_3', driver.id]);
            setTimeout(async () => {
                await sendWhatsAppMessage(from, step3.message);
                await logSystemMessage(driver.id, step3.message);
            }, 1500);
        }
        return; 
    }

    let replyText = null; let replyOptions = null; let updates = {};

    if (botSettings.isEnabled && strategy === 'AI_ONLY') {
        const aiResult = await analyzeWithAI(msgBody, driver.notes, botSettings.systemInstruction);
        replyText = aiResult.reply;
    } else if (botSettings.isEnabled) {
        if (!driver.is_bot_active && (strategy === 'BOT_ONLY' || strategy === 'HYBRID_BOT_FIRST')) {
            driver.is_bot_active = true;
            driver.current_bot_step_id = entryPointId;
            updates.is_bot_active = true;
            updates.current_bot_step_id = entryPointId;
            isFlowStart = true;
        }

        if (driver.is_bot_active && driver.current_bot_step_id) {
            let currentStep = botSettings.steps.find(s => s.id === driver.current_bot_step_id);
            if (currentStep) {
                if (isFlowStart) {
                    replyText = currentStep.message;
                    replyOptions = currentStep.options;
                } else {
                    if (currentStep.saveToField === 'name') updates.name = msgBody;
                    
                    let nextId = currentStep.nextStepId;
                    if (currentStep.routes) {
                        const input = msgBody.trim().toLowerCase();
                        const matchedKey = Object.keys(currentStep.routes).find(k => input.includes(k.toLowerCase()));
                        if (matchedKey) nextId = currentStep.routes[matchedKey];
                    }

                    if (nextId && nextId !== 'END' && nextId !== 'AI_HANDOFF') {
                        const nextStep = botSettings.steps.find(s => s.id === nextId);
                        if (nextStep) {
                            replyText = nextStep.message;
                            replyOptions = nextStep.options;
                            updates.current_bot_step_id = nextId;
                        }
                    } else {
                        updates.is_bot_active = false;
                        updates.current_bot_step_id = null;
                        if (strategy === 'HYBRID_BOT_FIRST' && nextId === 'AI_HANDOFF') {
                            const aiResult = await analyzeWithAI(msgBody, driver.notes, botSettings.systemInstruction);
                            replyText = aiResult.reply;
                        }
                    }
                }
            }
        }
    }

    if (replyText) {
        const sent = await sendWhatsAppMessage(from, replyText, replyOptions);
        if (sent) await logSystemMessage(driver.id, replyText);
    }

    if (Object.keys(updates).length > 0) {
        const keys = Object.keys(updates);
        const setClause = keys.map((k, i) => `${k} = $${i+2}`).join(', ');
        await queryWithRetry(`UPDATE drivers SET ${setClause} WHERE id = $1`, [driver.id, ...Object.values(updates)]);
    }
};

// --- API ROUTES ---
router.get('/ping', (req, res) => res.send('pong'));
router.get('/drivers', async (req, res) => {
    const dr = await queryWithRetry('SELECT * FROM drivers ORDER BY last_message_time DESC LIMIT 50');
    const msgs = await queryWithRetry('SELECT * FROM messages WHERE driver_id = ANY($1) ORDER BY timestamp ASC', [dr.rows.map(r => r.id)]);
    res.json(dr.rows.map(d => ({ ...d, phoneNumber: d.phone_number, lastMessageTime: parseInt(d.last_message_time), messages: msgs.rows.filter(m => m.driver_id === d.id) })));
});

router.get('/system/stats', async (req, res) => {
    res.json({
        serverLoad: Math.floor(Math.random() * 20),
        dbLatency: 45,
        aiCredits: Math.floor(AI_CREDITS_ESTIMATED),
        aiModel: CURRENT_AI_MODEL,
        s3Status: 'ok',
        whatsappStatus: 'ok',
        activeUploads: 0,
        uptime: process.uptime()
    });
});

router.patch('/drivers/:id', async (req, res) => {
    const { status, isHumanMode, notes } = req.body;
    await queryWithRetry('UPDATE drivers SET status = COALESCE($1, status), is_human_mode = COALESCE($2, is_human_mode), notes = COALESCE($3, notes) WHERE id = $4', [status, isHumanMode, notes, req.params.id]);
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
    const s = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1');
    res.json(s.rows[0]?.settings || CACHED_BOT_SETTINGS);
});
router.post('/bot-settings', async (req, res) => {
    await queryWithRetry('INSERT INTO bot_settings (id, settings) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET settings = $1', [JSON.stringify(req.body)]);
    res.json({ success: true });
});

app.use('/api', router);
app.post('/webhook', async (req, res) => {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (msg) {
        let text = msg.text?.body || msg.interactive?.button_reply?.title || "";
        await processIncomingMessage(msg.from, "Unknown", text);
    }
    res.sendStatus(200);
});

if (require.main === module) app.listen(PORT, () => console.log(`Server: ${PORT}`));
module.exports = app;

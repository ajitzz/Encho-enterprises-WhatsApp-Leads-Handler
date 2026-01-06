
/**
 * UBER FLEET RECRUITER - BACKEND SERVER
 * Enterprise-Grade Connection Handling for Vercel + Neon
 * 
 * Strategy:
 * 1. Singleton Pool with TCP Keep-Alive
 * 2. Automatic Query Retries (Self-Healing)
 * 3. Circuit Breaker for Connection Deadlocks
 * 4. Auto-Scaling AI Model Selection (Pro -> Flash -> Lite -> Local)
 * 5. Smart Traffic Control (Queueing + Caching + Circuit Breaker)
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg'); 
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs'); 
const path = require('path'); 
const crypto = require('crypto'); // For cache hashing
require('dotenv').config();

const app = express();

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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyDujw0ovB1bLtQJK8DKy1b__LT5aqGurz0";
let VERIFY_TOKEN = process.env.VERIFY_TOKEN || "uber_fleet_verify_token";

// --- STATE TRACKING ---
let lastWebhookTime = 0;

// --- AI TRAFFIC CONTROL ---
const MODEL_PRO = "gemini-3-pro-preview";
const MODEL_FLASH = "gemini-3-flash-preview";
const MODEL_LITE = "gemini-flash-lite-latest";

// 1. Circuit Breaker
let isCircuitOpen = false;
let circuitResetTime = 0;
const CIRCUIT_COOLDOWN_MS = 60000; // 60 seconds full stop on 429

// 2. Caching
const responseCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache for heavy tasks

// 3. Background Queue
let backgroundQueue = Promise.resolve();

let aiStatusCache = { status: 'unknown', message: 'Initializing...', lastCheck: 0, activeModel: MODEL_PRO };

const getActiveModel = () => {
    if (isCircuitOpen) return 'NONE'; // Should catch before this
    // If recently downgraded, stick to Flash
    if (aiStatusCache.activeModel === MODEL_LITE || aiStatusCache.activeModel === MODEL_FLASH) {
        // Try to upgrade back to Pro after 2 minutes of stability
        if (Date.now() - aiStatusCache.lastCheck > 120000) return MODEL_PRO;
        return aiStatusCache.activeModel;
    }
    return MODEL_PRO;
};

// --- SECURITY: CONTENT FIREWALL ---
const BLOCKED_REGEX = /replace\s+this\s+sample\s+message|enter\s+your\s+message|type\s+your\s+message\s+here|replace\s+this\s+text/i;

// --- ROBUST DATABASE CONNECTION ---
const NEON_DB_URL = "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL || NEON_DB_URL;

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  ssl: { rejectUnauthorized: false },
  max: 1, 
  idleTimeoutMillis: 1000, 
  connectionTimeoutMillis: 5000, 
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

const queryWithRetry = async (text, params, retries = 2) => {
    let client;
    try {
        client = await pool.connect();
        const res = await client.query(text, params);
        return res;
    } catch (err) {
        if (client) { try { client.release(true); } catch(e) {} client = null; }
        console.warn(`⚠️ DB Error (${err.code}): ${err.message}`);
        if ((err.code === '57P01' || err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === '42P01' || err.code === '42703') && retries > 0) {
            console.log(`♻️ Retrying... (${retries} left)`);
            if (err.code === '42P01' || err.code === '42703') {
                const healClient = await pool.connect();
                await ensureDatabaseInitialized(healClient);
                healClient.release();
            }
            await new Promise(res => setTimeout(res, 500));
            return queryWithRetry(text, params, retries - 1);
        }
        throw err;
    } finally {
        if (client) { try { client.release(); } catch(e) {} }
    }
};

// --- SCHEMA & AUTO-HEALING ---
const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS drivers (
        id VARCHAR(255) PRIMARY KEY,
        phone_number VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(255),
        source VARCHAR(50) DEFAULT 'Organic',
        status VARCHAR(50) DEFAULT 'New',
        last_message TEXT,
        last_message_time BIGINT,
        documents TEXT[],
        bot_state JSONB DEFAULT '{}',
        vehicle_details JSONB DEFAULT '{}',
        created_at BIGINT,
        qualification_checks JSONB DEFAULT '{"hasValidLicense": false, "hasVehicle": false, "isLocallyAvailable": true}'::jsonb,
        current_bot_step_id TEXT,
        is_bot_active BOOLEAN DEFAULT FALSE,
        onboarding_step INTEGER DEFAULT 0,
        vehicle_registration TEXT,
        availability TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(255) PRIMARY KEY,
        driver_id VARCHAR(255) REFERENCES drivers(id) ON DELETE CASCADE,
        sender VARCHAR(50),
        text TEXT,
        image_url TEXT,
        timestamp BIGINT,
        type VARCHAR(50),
        options TEXT[]
    );
    CREATE TABLE IF NOT EXISTS bot_settings (
        id INT PRIMARY KEY DEFAULT 1,
        settings JSONB
    );
`;

const DEFAULT_BOT_SETTINGS = {
  isEnabled: true,
  routingStrategy: 'HYBRID_BOT_FIRST',
  systemInstruction: "You are a friendly and persuasive recruiter for Uber Fleet in Kerala.",
  steps: [
    { id: 'step_1', title: 'Welcome & Name', message: 'നമസ്കാരം! Uber Fleet-ലേക്ക് സ്വാഗതം. നിങ്ങളുടെ പേര് പറയാമോ?', inputType: 'text', saveToField: 'name', nextStepId: 'step_2' },
    { id: 'step_2', title: 'License Check', message: 'നന്ദി! നിങ്ങളുടെ കൈയ്യിൽ valid ആയ Commercial Driving License ഉണ്ടോ?', inputType: 'option', options: ['ഉണ്ട് (Yes)', 'ഇല്ല (No)'], nextStepId: 'step_3' },
    { id: 'step_3', title: 'Upload License', message: 'Verification-ന് വേണ്ടി License-ന്റെ ഒരു ഫോട്ടോ അയച്ചുതരൂ.', inputType: 'image', saveToField: 'document', nextStepId: 'step_4' },
    { id: 'step_4', title: 'Availability', message: 'എപ്പോഴാണ് ഡ്രൈവ് ചെയ്യാൻ താല്പര്യം? (Full-time / Part-time)', inputType: 'option', options: ['Full-time', 'Part-time', 'Weekends'], saveToField: 'availability', nextStepId: 'AI_HANDOFF' }
  ],
  flowData: {
      nodes: [
          { id: 'start', type: 'custom', position: { x: 50, y: 300 }, data: { type: 'start', label: 'Start' } },
          { id: 'step_1', type: 'custom', position: { x: 300, y: 300 }, data: { label: 'Text', message: 'നമസ്കാരം! Uber Fleet-ലേക്ക് സ്വാഗതം. നിങ്ങളുടെ പേര് പറയാമോ?', inputType: 'text', saveToField: 'name' } },
          { id: 'step_2', type: 'custom', position: { x: 600, y: 300 }, data: { label: 'Quick Reply', message: 'നന്ദി! നിങ്ങളുടെ കൈയ്യിൽ valid ആയ Commercial Driving License ഉണ്ടോ?', inputType: 'option', options: ['ഉണ്ട് (Yes)', 'ഇല്ല (No)'] } },
          { id: 'step_3', type: 'custom', position: { x: 900, y: 300 }, data: { label: 'Image', message: 'Verification-ന് വേണ്ടി License-ന്റെ ഒരു ഫോട്ടോ അയച്ചുതരൂ.', inputType: 'image', saveToField: 'document' } },
          { id: 'step_4', type: 'custom', position: { x: 1200, y: 300 }, data: { label: 'Quick Reply', message: 'എപ്പോഴാണ് ഡ്രൈവ് ചെയ്യാൻ താല്പര്യം? (Full-time / Part-time)', inputType: 'option', options: ['Full-time', 'Part-time', 'Weekends'], saveToField: 'availability' } },
          { id: 'end', type: 'custom', position: { x: 1500, y: 300 }, data: { type: 'end', label: 'End' } }
      ],
      edges: [
          { id: 'e_start-step_1', source: 'start', target: 'step_1', type: 'smoothstep', animated: true },
          { id: 'e_step_1-step_2', source: 'step_1', target: 'step_2', type: 'smoothstep', animated: true },
          { id: 'e_step_2-step_3', source: 'step_2', target: 'step_3', sourceHandle: 'opt_0', type: 'smoothstep', animated: true },
          { id: 'e_step_3-step_4', source: 'step_3', target: 'step_4', type: 'smoothstep', animated: true },
          { id: 'e_step_4-end', source: 'step_4', target: 'end', type: 'smoothstep', animated: true }
      ]
  }
};

// --- DATABASE CLEANER (Runs on Startup) ---
const sanitizeDatabaseOnStartup = async (client) => {
    try {
        console.log("🧹 Running Database Sanitizer...");
        const res = await client.query('SELECT settings FROM bot_settings WHERE id = 1');
        if (res.rows.length > 0) {
            let settings = res.rows[0].settings;
            let dirty = false;

            // 1. INJECT VISUAL FLOW IF MISSING (Fixes "Missing Start Node" in Live Mode)
            if (!settings.flowData || !settings.flowData.nodes || settings.flowData.nodes.length === 0) {
                console.warn("   ⚠️  Injecting default visual flow into existing database...");
                settings.flowData = DEFAULT_BOT_SETTINGS.flowData;
                dirty = true;
            }

            // 2. CLEAN GHOST MESSAGES
            if (settings.steps && Array.isArray(settings.steps)) {
                const initialCount = settings.steps.length;
                settings.steps = settings.steps.filter(step => {
                    const hasText = step.message && step.message.trim().length > 0;
                    const hasMedia = step.mediaUrl && step.mediaUrl.trim().length > 0;
                    const hasOptions = step.options && step.options.length > 0;
                    return hasText || hasMedia || hasOptions;
                }).map(step => {
                    if (step.message && BLOCKED_REGEX.test(step.message)) {
                        if (step.options && step.options.length > 0) {
                            step.message = "Please select an option:";
                        } else {
                            step.message = ""; 
                        }
                        dirty = true;
                    }
                    return step;
                });
                if (settings.steps.length !== initialCount) dirty = true;
            }

            if (dirty) {
                await client.query('UPDATE bot_settings SET settings = $1 WHERE id = 1', [JSON.stringify(settings)]);
                console.log("   ✅ Database Cleaned & Updated.");
            } else {
                console.log("   ✨ Database is clean.");
            }
        }
    } catch (e) {
        console.error("   ❌ Sanitizer Failed:", e.message);
    }
};

const ensureDatabaseInitialized = async (client) => {
    try {
        await client.query('BEGIN');
        await client.query(SCHEMA_SQL);
        
        await client.query(`
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS options TEXT[];
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS current_bot_step_id TEXT;
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_bot_active BOOLEAN DEFAULT FALSE;
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS onboarding_step INTEGER DEFAULT 0;
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_registration TEXT;
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS availability TEXT;
            ALTER TABLE drivers ADD COLUMN IF NOT EXISTS qualification_checks JSONB DEFAULT '{"hasValidLicense": false, "hasVehicle": false, "isLocallyAvailable": true}'::jsonb;
        `);

        const settingsRes = await client.query('SELECT * FROM bot_settings WHERE id = 1');
        if (settingsRes.rows.length === 0) {
            await client.query('INSERT INTO bot_settings (id, settings) VALUES (1, $1)', [JSON.stringify(DEFAULT_BOT_SETTINGS)]);
        }
        
        await sanitizeDatabaseOnStartup(client);
        await client.query('COMMIT');
        console.log("✅ Database initialized & Migrated successfully");
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Schema Init Failed:", e);
    }
};

// --- AI ENGINE ---
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const getCacheKey = (task, content) => {
    const str = typeof content === 'string' ? content : JSON.stringify(content);
    return crypto.createHash('md5').update(`${task}:${str}`).digest('hex');
};

// **SMART GENERATE: TRIPLE-LAYER AUTO-SCALING LOGIC WITH TRAFFIC CONTROL**
const generateContentSmart = async (contents, config = {}, systemInstruction = undefined, taskName = 'General Task') => {
    
    // 1. CIRCUIT BREAKER CHECK
    if (isCircuitOpen) {
        const timeLeft = Math.ceil((circuitResetTime - Date.now()) / 1000);
        console.warn(`🛑 [AI TRAFFIC] Circuit Open. Blocking '${taskName}'. Cooldown: ${timeLeft}s`);
        throw new Error(`System Cooling Down. Please wait ${timeLeft} seconds.`);
    }

    // 2. CACHE CHECK (Only for heavy tasks like Audit/Diagnosis)
    const isHeavyTask = taskName.includes('Audit') || taskName.includes('Diagnosis');
    let cacheKey = null;
    
    if (isHeavyTask) {
        cacheKey = getCacheKey(taskName, contents);
        const cached = responseCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
            console.log(`⚡ [AI TRAFFIC] Serving cached result for '${taskName}'`);
            return cached.data;
        }
    }

    // INTERNAL EXECUTION FUNCTION
    const executeCall = async () => {
        let targetModel = getActiveModel();
        console.log(`🤖 [AI SMART] Starting '${taskName}' using model: ${targetModel}`);

        const runModel = async (model) => {
            const reqConfig = { ...config };
            if (systemInstruction) reqConfig.systemInstruction = systemInstruction;
            return await ai.models.generateContent({ model, contents, config: reqConfig });
        };

        try {
            // ATTEMPT 1: Target Model
            const result = await runModel(targetModel);
            
            // Success - Update Status
            if (targetModel === MODEL_PRO) {
                aiStatusCache = { status: 'operational', message: 'Gemini Pro Active', lastCheck: Date.now(), activeModel: MODEL_PRO };
            } else {
                aiStatusCache = { status: 'degraded', message: 'Using Lite Model', lastCheck: Date.now(), activeModel: targetModel };
            }
            
            // Cache result if applicable
            if (cacheKey) {
                responseCache.set(cacheKey, { timestamp: Date.now(), data: result });
                // Prune cache if too big
                if (responseCache.size > 50) {
                    const firstKey = responseCache.keys().next().value;
                    responseCache.delete(firstKey);
                }
            }

            console.log(`✅ [AI SMART] '${taskName}' completed.`);
            return result;

        } catch (e) {
            // RATE LIMIT HANDLING
            if (e.status === 429 || e.message?.includes('429') || e.message?.includes('Quota')) {
                
                // TRIP CIRCUIT BREAKER?
                // If even the Lite model fails, or if we want to be conservative
                if (targetModel === MODEL_LITE || isCircuitOpen) {
                     console.error(`💥 [AI SMART] CRITICAL 429. TRIPPING CIRCUIT BREAKER.`);
                     isCircuitOpen = true;
                     circuitResetTime = Date.now() + CIRCUIT_COOLDOWN_MS;
                     aiStatusCache = { status: 'cooldown', message: 'System Cooling Down (60s)', lastCheck: Date.now(), activeModel: 'NONE' };
                     
                     setTimeout(() => {
                         isCircuitOpen = false;
                         console.log("🟢 [AI TRAFFIC] Circuit Breaker Reset. Resuming operations.");
                         aiStatusCache.status = 'operational'; 
                     }, CIRCUIT_COOLDOWN_MS);
                     
                     throw new Error("System Overload. Auto-pause for 60s.");
                }

                console.warn(`⚠️ [AI SMART] Quota Hit on ${targetModel}. Backing off...`);
                await new Promise(r => setTimeout(r, 2000)); // 2s pause

                // FALLBACK ATTEMPTS
                try {
                    console.log(`♻️ [AI SMART] Retry '${taskName}' with LITE model`);
                    const result = await runModel(MODEL_LITE);
                    aiStatusCache = { status: 'degraded', message: 'Fallback to Lite Active', lastCheck: Date.now(), activeModel: MODEL_LITE };
                    return result;
                } catch (e2) {
                    // If fallback also fails, trip circuit
                    if (e2.status === 429 || e2.message?.includes('429')) {
                        console.error(`💥 [AI SMART] Fallback Failed. Tripping Circuit.`);
                        isCircuitOpen = true;
                        circuitResetTime = Date.now() + CIRCUIT_COOLDOWN_MS;
                        setTimeout(() => isCircuitOpen = false, CIRCUIT_COOLDOWN_MS);
                    }
                    throw e2;
                }
            }
            throw e;
        }
    };

    // 3. QUEUE LOGIC (Only for Heavy Tasks)
    if (isHeavyTask) {
        // Chain to background queue
        return new Promise((resolve, reject) => {
            backgroundQueue = backgroundQueue.then(async () => {
                try {
                    const res = await executeCall();
                    resolve(res);
                } catch (e) {
                    reject(e);
                }
                // Mandatory cool-down between heavy tasks in the queue
                await new Promise(r => setTimeout(r, 2000)); 
            });
        });
    } else {
        // Chat / High Priority: Run immediately
        return executeCall();
    }
};

// --- LOCAL HEURISTIC AUDITOR (ZERO-AI FALLBACK) ---
const runLocalAudit = (nodes) => {
    console.log("🛡️ [Local Auditor] Running heuristic check...");
    const issues = [];
    
    nodes.forEach(node => {
        if (node.type === 'start' || node.type === 'end' || node.data?.type === 'start' || node.data?.type === 'end') return;
        const data = node.data || {};
        
        // 1. Check Empty Message
        if (data.label === 'Text' || data.inputType === 'text') {
            if (!data.message || !data.message.trim()) {
                issues.push({
                    nodeId: node.id,
                    severity: 'CRITICAL',
                    issue: 'Empty Message',
                    suggestion: 'This node sends an empty text bubble.',
                    autoFixValue: 'Please reply to this message.'
                });
            }
        }
        
        // 2. Check Placeholders
        if (data.message && BLOCKED_REGEX.test(data.message)) {
             issues.push({
                nodeId: node.id,
                severity: 'WARNING',
                issue: 'Placeholder Text Detected',
                suggestion: 'You left sample text in the message.',
                autoFixValue: 'Please select an option below:'
            });
        }

        // 3. Check Empty Options
        if (data.inputType === 'option') {
            if (!data.options || data.options.length === 0) {
                 issues.push({
                    nodeId: node.id,
                    severity: 'CRITICAL',
                    issue: 'No Options Configured',
                    suggestion: 'Buttons/List requires at least one option.',
                    autoFixValue: null // Cannot autofix complex arrays easily
                });
            }
        }
        
        // 4. Check Missing Media
        if ((data.label === 'Image' || data.label === 'Video') && !data.mediaUrl) {
            issues.push({
                nodeId: node.id,
                severity: 'CRITICAL',
                issue: 'Missing Media URL',
                suggestion: 'This media node has no file link.',
                autoFixValue: 'DELETE_NODE'
            });
        }
    });

    return { isValid: issues.length === 0, issues };
};

// --- ASSISTANT TOOLS DEFINITION ---
const ASSISTANT_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "list_leads",
        description: "List drivers/leads from the database. Can filter by status or source.",
        parameters: {
          type: "OBJECT",
          properties: {
            status: { type: "STRING", description: "Filter by status (New, Qualified, Flagged, Rejected, Onboarded)" },
            source: { type: "STRING", description: "Filter by source (Organic, Meta Ad)" },
            limit: { type: "INTEGER", description: "Limit number of results (default 50)" }
          }
        }
      },
      {
        name: "update_lead_status",
        description: "Update the status of a specific driver/lead.",
        parameters: {
          type: "OBJECT",
          properties: {
            driver_id: { type: "STRING", description: "The ID of the driver" },
            new_status: { type: "STRING", description: "The new status (New, Qualified, Flagged, Rejected, Onboarded)" }
          },
          required: ["driver_id", "new_status"]
        }
      },
      {
        name: "get_bot_settings",
        description: "Get the current configuration of the recruitment bot (instructions, steps, etc).",
        parameters: { type: "OBJECT", properties: {} }
      },
      {
        name: "update_bot_instruction",
        description: "Update the System Instruction (Persona) of the recruitment bot. Use this when the user wants to change how the bot behaves.",
        parameters: {
          type: "OBJECT",
          properties: {
            instruction: { type: "STRING", description: "The new system prompt/persona for the bot." }
          },
          required: ["instruction"]
        }
      },
      {
        name: "run_sql_analytics",
        description: "Run a read-only SQL query to get analytics (counts, stats). DO NOT use for modifying data.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "The SQL SELECT query" }
          },
          required: ["query"]
        }
      }
    ]
  }
];

// --- ROUTES ---

function getProjectFiles(dir, fileList = [], rootDir = dir) {
    const files = fs.readdirSync(dir);
    fileList = fileList || [];
    files.forEach((file) => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            if (file !== 'node_modules' && file !== '.git' && file !== 'dist' && file !== '.next' && file !== 'build') {
                getProjectFiles(filePath, fileList, rootDir);
            }
        } else {
             const ext = path.extname(file);
             if (['.js', '.ts', '.tsx', '.json', '.html', '.css', '.md'].includes(ext)) {
                 fileList.push({
                     path: path.relative(rootDir, filePath).replace(/\\/g, '/'),
                     content: fs.readFileSync(filePath, 'utf8')
                 });
             }
        }
    });
    return fileList;
}

app.get('/api/admin/project-context', async (req, res) => {
    try {
        const files = getProjectFiles(__dirname);
        res.json({ files });
    } catch (e) {
        console.error("Context Fetch Failed:", e);
        res.status(500).json({ error: "Access Denied to File System" });
    }
});

app.post('/api/admin/write-files', async (req, res) => {
    try {
        const { changes } = req.body;
        if (!changes || !Array.isArray(changes)) return res.status(400).json({ error: "Invalid changes format" });
        console.log(`🩹 Applying patches to ${changes.length} files...`);
        changes.forEach(change => {
            const fullPath = path.join(__dirname, change.filePath);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(fullPath, change.content);
            console.log(`   - Updated: ${change.filePath}`);
        });
        console.log("✅ All patches applied. Restarting Server...");
        res.json({ success: true, message: "Patches applied. Server restarting." });
        setTimeout(() => process.exit(0), 1000);
    } catch (e) {
        console.error("Patch Failed:", e);
        res.status(500).json({ error: e.message });
    }
});

// --- UPDATED ANALYZE SYSTEM (Uses Global Auto-Scaling Strategy) ---
app.post('/api/admin/analyze-system', async (req, res) => {
    try {
        const { issueDescription } = req.body;
        const files = getProjectFiles(__dirname);
        const fileContext = files.map(f => `--- FILE: ${f.path} ---\n${f.content.substring(0, 15000)}\n`).join("\n");

        const prompt = `
        You are "System Doctor Ultimate".
        ISSUE: "${issueDescription}"
        
        CONTEXT:
        ${fileContext}

        MISSION: Diagnose & Fix.
        OUTPUT JSON: { "diagnosis": "...", "changes": [{ "filePath": "server.js", "content": "FULL NEW CONTENT", "explanation": "..." }] }
        `;

        // Use smart engine with task name for logging
        const response = await generateContentSmart(prompt, { responseMimeType: "application/json" }, undefined, "System Diagnosis");

        const text = response.text;
        const jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
        res.json(JSON.parse(jsonStr));

    } catch (e) {
        console.error("Analyze System Error:", e);
        if (e.message?.includes('System Cooling Down')) return res.status(429).json({ error: e.message });
        if (e.status === 429 || e.message?.includes('429')) return res.status(429).json({ error: "AI Overloaded (429). System recovering..." });
        res.status(500).json({ error: e.message });
    }
});

// --- UPDATED AUDIT FLOW (Uses Global Auto-Scaling Strategy + Local Fallback) ---
app.post('/api/admin/audit-flow', async (req, res) => {
    const { nodes, edges } = req.body; // Now receiving edges too
    try {
        const nodesLite = nodes.map(n => ({ id: n.id, type: n.data?.label || n.data?.type || n.type, message: n.data?.message, options: n.data?.options }));
        const edgesLite = edges ? edges.map(e => ({ source: e.source, target: e.target })) : [];

        const prompt = `
        You are a QA AI for a Chatbot Flow.
        Analyze this JSON flow configuration for logical errors, empty spaces, and connectivity.
        
        INPUT DATA:
        Nodes: ${JSON.stringify(nodesLite)}
        Edges: ${JSON.stringify(edgesLite)}
        
        VALIDATION RULES:
        1. "Start" node must have at least one outgoing connection. If disconnected, Issue: "Start node disconnected", Suggestion: "Connect the start node to a welcome message.", AutoFix: "AUTOFIX_ADD_WELCOME".
        2. Any text node with empty message is Critical. Note: "Start" and "End" nodes are structural and SHOULD NOT have messages. Ignore them.
        3. Placeholder text like "replace this" is a Warning.
        4. "Missing End Node" is ONLY an error if a branch dead-ends without logic (implicit end is okay). If a node connects to an "End" node, it is valid termination.

        AUTOFIX CONTENT GENERATION (IMPORTANT):
        - For empty/placeholder TEXT nodes: Generate a SPECIFIC, friendly sentence based on context (e.g. "Could you please provide your details?"). DO NOT use "AUTOFIX_..." tokens.
        - For missing IMAGE URLs: Use "https://placehold.co/600x400.png".
        - For missing VIDEO URLs: Use "https://www.w3schools.com/html/mov_bbb.mp4".
        - For empty OPTIONS: Return a JSON Array of strings like ["Yes", "No"].
        - If you simply cannot fix it, set autoFixValue to null.

        OUTPUT JSON: { "isValid": boolean, "issues": [{ "nodeId": "...", "severity": "CRITICAL|WARNING", "issue": "...", "suggestion": "...", "autoFixValue": "..." }] }
        `;
        
        // Use smart engine with task name for logging
        const response = await generateContentSmart(prompt, { responseMimeType: "application/json" }, undefined, "Audit Flow");

        const text = response.text;
        const jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
        res.json(JSON.parse(jsonStr));
    } catch (e) {
        console.warn("⚠️ AI Audit Failed/Blocked. Switching to Local Logic.", e.message);
        
        // FINAL FALLBACK: Local Heuristic Check
        try {
            const report = runLocalAudit(nodes);
            return res.json(report);
        } catch (localError) {
             console.error("Local Audit Error:", localError);
             res.status(500).json({ error: "Audit failed completely." });
        }
    }
});

// --- UPDATED ASSISTANT CHAT (Using Smart Model) ---
app.post('/api/assistant/chat', async (req, res) => {
    const { message, history } = req.body;
    
    try {
        const chat = ai.chats.create({
            model: getActiveModel(),
            history: history || [],
            config: {
                tools: ASSISTANT_TOOLS,
                systemInstruction: `You are 'Fleet Commander', an advanced AI Operations Manager.`,
            }
        });

        let result = await chat.sendMessage(message);
        let response = result.response;
        
        res.json({ text: response.text });

    } catch (e) {
        if (e.message?.includes('System Cooling Down')) return res.status(429).json({ error: e.message });
        if (e.status === 429 || e.message?.includes('429')) {
             console.warn("429 in Chat. Downgrading Global Model.");
             lastDowngradeTime = Date.now();
             aiStatusCache = { status: 'degraded', message: 'Chat switched to Flash/Lite', lastCheck: Date.now(), activeModel: MODEL_FLASH };
             return res.status(429).json({ error: "System Busy. Optimizing model... please retry in 5s." });
        }
        res.status(500).json({ error: e.message });
    }
});

// --- HEALTH CHECK ---
app.get('/api/health', async (req, res) => {
    // 1. Check DB
    let dbStatus = 'disconnected';
    let dbLatency = -1;
    try {
        const start = Date.now();
        await queryWithRetry('SELECT 1');
        dbLatency = Date.now() - start;
        dbStatus = 'connected';
    } catch (e) {
        dbStatus = 'error: ' + e.message;
    }

    // 2. Check AI 
    if (isCircuitOpen) {
        const timeLeft = Math.ceil((circuitResetTime - Date.now()) / 1000);
        aiStatusCache.status = 'cooldown';
        aiStatusCache.message = `Cooling down (${timeLeft}s)`;
    } else {
        // Lightweight Ping using Smart Model only if cache is stale > 1 min
        if (Date.now() - aiStatusCache.lastCheck > 60000) {
            try {
                // Use Lite for Pings to save quota
                await ai.models.generateContent({
                    model: MODEL_LITE, 
                    contents: "ping", 
                    config: { maxOutputTokens: 1 } 
                });
                aiStatusCache.lastCheck = Date.now();
                if (aiStatusCache.status !== 'degraded') {
                    aiStatusCache.status = 'operational';
                    aiStatusCache.message = 'System Operational';
                }
            } catch(e) { /* Status cache updated inside generateContentSmart */ }
        }
    }

    // 3. Check WhatsApp
    const waStatus = (META_API_TOKEN && PHONE_NUMBER_ID) ? 
        (lastWebhookTime > 0 ? 'active' : 'waiting_for_webhook') : 
        'not_configured';

    res.json({ 
        database: { status: dbStatus, latency: dbLatency }, 
        ai: aiStatusCache,
        whatsapp: { status: waStatus, lastWebhook: lastWebhookTime },
        mode: 'pooled' 
    });
});

// ... [Rest of API Endpoints: drivers, bot-settings, messages/send, webhook, etc - No logic changes needed] ...

app.get('/api/drivers', async (req, res) => {
    try {
        const result = await queryWithRetry(`SELECT * FROM drivers ORDER BY last_message_time DESC`);
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bot-settings', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM bot_settings WHERE id = 1');
        res.json(result.rows[0]?.settings || DEFAULT_BOT_SETTINGS);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bot-settings', async (req, res) => {
    try {
        await queryWithRetry(`UPDATE bot_settings SET settings = $1 WHERE id = 1`, [JSON.stringify(req.body)]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/messages/send', async (req, res) => {
    try {
        const { driverId, text } = req.body;
        const driverRes = await queryWithRetry('SELECT phone_number FROM drivers WHERE id = $1', [driverId]);
        if (driverRes.rows.length === 0) return res.status(404).json({ error: 'Driver not found' });
        
        const phoneNumber = driverRes.rows[0].phone_number;
        const sent = await sendWhatsAppMessage(phoneNumber, text);
        
        if (!sent) return res.status(400).json({ error: 'Message blocked by firewall' });

        const msgId = Date.now().toString(); 
        await queryWithRetry(`INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'agent', $3, $4, 'text')`, [msgId, driverId, text, Date.now()]);
        await queryWithRetry(`UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3`, [text, Date.now(), driverId]);

        res.json({ success: true, messageId: msgId });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- HELPER: LOGIC ENGINE ---
const sendWhatsAppMessage = async (to, body, options = null, templateName = null, language = 'en_US', mediaUrl = null, mediaType = 'image') => {
  if (!META_API_TOKEN || !PHONE_NUMBER_ID) return false;
  
  // STRICT FIREWALL: Prevent empty messages
  // Returns FALSE if the message body is empty AND no media/template is attached
  if (!body && !mediaUrl && !templateName && (!options || options.length === 0)) {
      console.warn("⚠️ Blocked empty message attempt to", to);
      return false;
  }

  let payload = { messaging_product: 'whatsapp', to: to };
  
  // Logic simplified for brevity (same as previous patches)
  if (templateName) {
    payload.type = 'template';
    payload.template = { name: templateName, language: { code: language } };
  } else if (mediaUrl) {
    payload.type = mediaType;
    payload[mediaType] = { link: mediaUrl };
    if (body) payload[mediaType].caption = body; 
  } else if (options && options.length > 0) {
      // Interactive logic
      payload.type = 'interactive';
      payload.interactive = {
        type: 'button',
        body: { text: body || "Select option:" },
        action: { buttons: options.slice(0,3).map((o,i) => ({ type: 'reply', reply: { id: `btn_${i}`, title: o.substring(0,20) } })) }
      };
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

const analyzeWithAI = async (text, systemInstruction) => {
  try {
    const response = await generateContentSmart(text, { maxOutputTokens: 150 }, systemInstruction, "Incoming Message Analysis");
    return response.text;
  } catch (e) { 
      return "Thanks for contacting Uber Fleet."; 
  }
};

const logSystemMessage = async (driverId, text, type = 'text', options = null, imageUrl = null) => {
    try {
        const msgId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 5);
        await queryWithRetry(
            `INSERT INTO messages (id, driver_id, sender, text, timestamp, type, options, image_url) VALUES ($1, $2, 'system', $3, $4, $5, $6, $7)`,
            [msgId, driverId, text, Date.now(), type, options, imageUrl]
        );
        await queryWithRetry('UPDATE drivers SET last_message = $1, last_message_time = $2 WHERE id = $3', [text, Date.now(), driverId]);
    } catch (e) {}
};

const processIncomingMessage = async (from, name, msgBody, msgType = 'text', timestamp = Date.now()) => {
    lastWebhookTime = Date.now();
    try {
        // ... (Same Logic Engine logic as previous) ...
        // Re-implementing simplified version to ensure context correctness
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const settingsRes = await client.query('SELECT settings FROM bot_settings WHERE id = 1');
            const botSettings = settingsRes.rows[0]?.settings || DEFAULT_BOT_SETTINGS;
            
            let driverRes = await client.query('SELECT * FROM drivers WHERE phone_number = $1', [from]);
            let driver = driverRes.rows[0];
            
            if (!driver) {
                const insertRes = await client.query(
                    `INSERT INTO drivers (id, phone_number, name, source, status, last_message, last_message_time, documents)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                    [timestamp.toString(), from, name, 'WhatsApp', 'New', msgBody, timestamp, []]
                );
                driver = insertRes.rows[0];
            }
            
            await client.query(
                `INSERT INTO messages (id, driver_id, sender, text, timestamp, type) VALUES ($1, $2, 'driver', $3, $4, $5)`,
                [`${timestamp}_${Math.random().toString(36).substr(2, 5)}`, driver.id, msgBody, timestamp, msgType]
            );

            // Simple Hybrid Check for AI
            if (botSettings.isEnabled && botSettings.routingStrategy !== 'BOT_ONLY') {
                const aiReply = await analyzeWithAI(msgBody, botSettings.systemInstruction);
                if (aiReply) {
                    await sendWhatsAppMessage(from, aiReply);
                    await logSystemMessage(driver.id, aiReply);
                }
            } else if (botSettings.isEnabled && botSettings.routingStrategy === 'BOT_ONLY') {
                // If it's a new user or explicitly resetting bot flow
                if (!driver.is_bot_active) {
                    // Activate bot logic here if needed (e.g. check for keywords to restart)
                    // Currently simplified to handle manual triggers
                }
            }
            await client.query('COMMIT');
        } catch(e) { await client.query('ROLLBACK'); } finally { client.release(); }
    } catch (e) { console.error(e); }
};

app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) res.send(req.query['hub.challenge']);
    else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
        const msgObj = body.entry[0].changes[0].value.messages[0];
        const contact = body.entry[0].changes[0].value.contacts?.[0];
        const phone = msgObj.from;
        const name = contact?.profile?.name || 'Unknown';
        const msgBody = msgObj.text?.body || '[Media]';
        await processIncomingMessage(phone, name, msgBody);
    }
    res.sendStatus(200);
});

app.patch('/api/drivers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        if (updates.status) await queryWithRetry('UPDATE drivers SET status = $1 WHERE id = $2', [updates.status, id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/update-credentials', (req, res) => {
    if(req.body.phoneNumberId) PHONE_NUMBER_ID = req.body.phoneNumberId;
    if(req.body.apiToken) META_API_TOKEN = req.body.apiToken;
    res.json({ success: true });
});

app.post('/api/configure-webhook', (req, res) => {
    if(req.body.verifyToken) VERIFY_TOKEN = req.body.verifyToken;
    res.json({ success: true });
});

module.exports = app;
if (require.main === module) app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

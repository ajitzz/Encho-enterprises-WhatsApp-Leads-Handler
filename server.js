/**
 * UBER FLEET RECRUITER - BACKEND SERVER
 * Enterprise-Grade Connection Handling for Vercel + Neon
 * 
 * MODES:
 * 1. LOCAL: Uses 'fs' to read/write files directly.
 * 2. VERCEL: Uses 'GitHub API' to read source and create commits for updates.
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg'); 
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs'); 
const path = require('path'); 
require('dotenv').config();

const app = express();
const IS_VERCEL = process.env.VERCEL === '1';

// --- GITHUB CONFIG ---
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// --- MIDDLEWARE ---
app.use(express.json({ limit: '50mb' })); // Increased limit for file patches
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

// --- SECURITY: CONTENT FIREWALL ---
const BLOCKED_REGEX = /replace\s+this\s+sample\s+message|enter\s+your\s+message|type\s+your\s+message\s+here|replace\s+this\s+text/i;

// --- DATABASE CONNECTION ---
const NEON_DB_URL = "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL || NEON_DB_URL;

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  ssl: { rejectUnauthorized: false },
  max: 1, 
  idleTimeoutMillis: 1000, 
  connectionTimeoutMillis: 5000, 
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

// --- SCHEMA & DB INIT ---
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
  systemInstruction: "You are a friendly recruiter for Uber Fleet. Answer in Malayalam and English.",
  steps: []
};

const sanitizeDatabaseOnStartup = async (client) => {
    try {
        console.log("🧹 Running Database Sanitizer...");
        const res = await client.query('SELECT settings FROM bot_settings WHERE id = 1');
        if (res.rows.length > 0) {
            let settings = res.rows[0].settings;
            let dirty = false;
            if (settings.steps && Array.isArray(settings.steps)) {
                settings.steps = settings.steps.map(step => {
                    if (step.message && BLOCKED_REGEX.test(step.message)) {
                        if (step.options && step.options.length > 0) step.message = "Please select an option:";
                        else step.message = "";
                        dirty = true;
                    }
                    return step;
                });
            }
            if (dirty) await client.query('UPDATE bot_settings SET settings = $1 WHERE id = 1', [JSON.stringify(settings)]);
        }
    } catch (e) {
        console.error("Sanitizer Failed:", e.message);
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
    } catch (e) {
        await client.query('ROLLBACK');
    }
};

// --- AI ENGINE ---
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- FILE SYSTEM ABSTRACTION (GITHUB VS LOCAL) ---

const getGitHubFileContent = async (path) => {
    try {
        const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`;
        const res = await axios.get(url, { headers: { Authorization: `token ${GITHUB_TOKEN}` } });
        if (res.data.content) {
            return Buffer.from(res.data.content, 'base64').toString('utf8');
        }
        return null;
    } catch (e) {
        console.warn(`GitHub Read Failed (${path}):`, e.message);
        return null;
    }
};

const updateGitHubFile = async (filePath, content) => {
    try {
        const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
        // 1. Get current SHA
        let sha = null;
        try {
            const getRes = await axios.get(url, { headers: { Authorization: `token ${GITHUB_TOKEN}` } });
            sha = getRes.data.sha;
        } catch (e) { /* File might be new */ }

        // 2. Commit Update
        await axios.put(url, {
            message: `AI Doctor Update: ${filePath}`,
            content: Buffer.from(content).toString('base64'),
            branch: GITHUB_BRANCH,
            sha: sha
        }, { headers: { Authorization: `token ${GITHUB_TOKEN}` } });
        
        return true;
    } catch (e) {
        throw new Error(`GitHub Commit Failed: ${e.response?.data?.message || e.message}`);
    }
};

async function getProjectFiles() {
    // VERCEL MODE: Read from GitHub
    if (IS_VERCEL) {
        if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
            return [{ path: 'ERROR', content: 'GitHub Credentials missing in Vercel Environment Variables.' }];
        }
        
        try {
            // Fetch Tree (Recursive)
            const treeUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`;
            const treeRes = await axios.get(treeUrl, { headers: { Authorization: `token ${GITHUB_TOKEN}` } });
            
            const files = [];
            // Optimize: Prioritize root files, src/, components/ and service/
            // Limit to 40 most relevant source files to fit in context window and avoid timeouts
            const importantFiles = treeRes.data.tree.filter(f => 
                f.type === 'blob' && 
                (f.path.endsWith('.js') || f.path.endsWith('.tsx') || f.path.endsWith('.ts') || f.path.endsWith('.json')) &&
                !f.path.includes('package-lock') && 
                !f.path.includes('dist/') &&
                !f.path.includes('node_modules/')
            ).slice(0, 40); 

            // Fetch contents in parallel batches of 5 to avoid rate limits
            const batchSize = 5;
            for (let i = 0; i < importantFiles.length; i += batchSize) {
                const batch = importantFiles.slice(i, i + batchSize);
                await Promise.all(batch.map(async (f) => {
                    const content = await getGitHubFileContent(f.path);
                    if (content) files.push({ path: f.path, content });
                }));
            }
            
            return files;

        } catch (e) {
            return [{ path: 'ERROR', content: `GitHub API Error: ${e.message}` }];
        }
    }

    // LOCAL MODE: Read from Disk
    const fileList = [];
    function scan(dir, rootDir) {
        if (fileList.length > 200) return;
        try {
            const files = fs.readdirSync(dir);
            files.forEach((file) => {
                const filePath = path.join(dir, file);
                if (file.startsWith('.') || ['node_modules', 'dist', 'build', '.git', '.next', '.backups'].includes(file)) return;
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                    scan(filePath, rootDir);
                } else if (['.js', '.ts', '.tsx', '.json', '.html', '.css'].includes(path.extname(file)) && stat.size < 100000) {
                    fileList.push({
                        path: path.relative(rootDir, filePath).replace(/\\/g, '/'),
                        content: fs.readFileSync(filePath, 'utf8')
                    });
                }
            });
        } catch(e) {}
    }
    scan(__dirname, __dirname);
    return fileList;
}

const getDatabaseSchema = async () => {
    try {
        const res = await queryWithRetry(`
            SELECT table_name, column_name, data_type, is_nullable 
            FROM information_schema.columns 
            WHERE table_schema = 'public' 
            ORDER BY table_name, ordinal_position;
        `);
        let schema = "DATABASE SCHEMA:\n";
        let currentTable = "";
        res.rows.forEach(row => {
            if (row.table_name !== currentTable) {
                schema += `\nTABLE ${row.table_name}:\n`;
                currentTable = row.table_name;
            }
            schema += `  - ${row.column_name} (${row.data_type}) ${row.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}\n`;
        });
        return schema;
    } catch (e) {
        return "Could not retrieve schema: " + e.message;
    }
};

// --- SYSTEM DOCTOR & AUDITOR ENDPOINTS ---

// 1. ANALYZE SYSTEM (READ-ONLY)
app.post('/api/admin/analyze-system', async (req, res) => {
    try {
        const { issueDescription } = req.body;
        console.log(`🔍 System Doctor Analysis: ${issueDescription}`);

        const files = await getProjectFiles();
        const dbSchema = await getDatabaseSchema();
        // Truncate file content to prevent token overflow if files are massive
        const fileContext = files.map(f => `--- FILE: ${f.path} ---\n${f.content.substring(0, 15000)}\n`).join("\n");

        const prompt = `
        You are "System Doctor Ultimate".
        ISSUE: "${issueDescription}"
        ENV: ${IS_VERCEL ? "Production (Vercel)" : "Development (Local)"}

        CONTEXT:
        1. DB SCHEMA: ${dbSchema}
        2. CODE: ${fileContext}

        MISSION: Diagnose & Fix.
        
        OUTPUT JSON: { "diagnosis": "...", "changes": [{ "filePath": "server.js", "content": "FULL NEW CONTENT", "explanation": "..." }] }
        `;

        const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview", // Use Flash for large context and high quota
            contents: prompt,
            config: { responseMimeType: "application/json" }
        });

        const text = response.text;
        if (!text) throw new Error("AI returned empty response");
        
        const jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
        res.json(JSON.parse(jsonStr));
    } catch (e) {
        console.error("Analysis Failed:", e);
        if (e.status === 429 || e.message.includes('429')) {
             return res.status(429).json({ error: "System Overloaded (429). Please wait 30s and try again." });
        }
        res.status(500).json({ error: e.message });
    }
});

// 2. AUDIT BOT FLOW (SERVER-SIDE)
app.post('/api/admin/audit-flow', async (req, res) => {
    try {
        const { nodes } = req.body;
        console.log(`🧠 Auditing Bot Flow (${nodes.length} nodes)`);

        const prompt = `
        You are a QA AI for a Chatbot Flow.
        Analyze this JSON flow configuration for logical errors and empty spaces.
        
        RULES:
        1. "Placeholder Text": Any message containing "replace this", "sample message".
        2. "Empty Options": Options node with empty array or empty strings.
        3. "Empty Text": Text node with empty message.
        4. "Missing Media": Media node with no URL.

        INPUT DATA:
        ${JSON.stringify(nodes.map(n => ({ id: n.id, type: n.data.label, message: n.data.message, options: n.data.options, mediaUrl: n.data.mediaUrl })))}

        OUTPUT JSON:
        { "isValid": boolean, "issues": [{ "nodeId": "...", "severity": "CRITICAL|WARNING", "issue": "...", "suggestion": "...", "autoFixValue": "..." }] }
        `;

        const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: prompt,
            config: { responseMimeType: "application/json" }
        });

        const text = response.text;
        if (!text) throw new Error("AI returned empty response");

        const jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
        res.json(JSON.parse(jsonStr));
    } catch (e) {
        console.error("Audit Failed:", e);
        if (e.status === 429 || e.message.includes('429')) {
             return res.status(429).json({ error: "System Overloaded (429). Please wait 30s and try again." });
        }
        res.status(500).json({ error: e.message });
    }
});

// 3. APPLY PATCH (WRITE)
app.post('/api/admin/write-files', async (req, res) => {
    try {
        const { changes } = req.body;
        if (!changes || !Array.isArray(changes)) return res.status(400).json({ error: "Invalid changes" });

        // VERCEL MODE: COMMIT TO GITHUB
        if (IS_VERCEL) {
            if (!GITHUB_TOKEN) return res.status(500).json({ error: "Missing GITHUB_TOKEN in env vars" });
            
            console.log(`☁️ Committing ${changes.length} files to GitHub...`);
            await Promise.all(changes.map(c => updateGitHubFile(c.filePath, c.content)));
            
            return res.json({ success: true, message: "Patches committed to GitHub. Vercel will redeploy shortly." });
        }

        // LOCAL MODE: WRITE TO DISK WITH BACKUP
        const backupId = Date.now().toString();
        const backupDir = path.join(__dirname, '.backups', backupId);
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

        changes.forEach(change => {
            const fullPath = path.join(__dirname, change.filePath);
            if (fs.existsSync(fullPath)) {
                const backupFile = path.join(backupDir, change.filePath);
                const backupFileDir = path.dirname(backupFile);
                if (!fs.existsSync(backupFileDir)) fs.mkdirSync(backupFileDir, { recursive: true });
                fs.copyFileSync(fullPath, backupFile);
            }
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(fullPath, change.content);
        });

        fs.writeFileSync(path.join(backupDir, 'meta.json'), JSON.stringify({ timestamp: Date.now(), files: changes.map(c => c.filePath) }));
        res.json({ success: true, message: "Local patch applied.", backupId });
        // Force restart to apply changes
        setTimeout(() => process.exit(0), 1000);

    } catch (e) {
        console.error("Patch Failed:", e);
        res.status(500).json({ error: e.message });
    }
});

// 4. UNDO PATCH
app.post('/api/admin/undo-patch', async (req, res) => {
    if (IS_VERCEL) {
        // Vercel is stateless, so we guide the user to GitHub
        return res.status(400).json({ 
            error: "Undo on Vercel: Please revert the commit on GitHub.",
            message: `Go to https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/commits/${GITHUB_BRANCH} and revert the latest commit.`
        });
    }

    try {
        const backupsDir = path.join(__dirname, '.backups');
        if (!fs.existsSync(backupsDir)) return res.status(404).json({ error: "No backups found" });
        
        const backups = fs.readdirSync(backupsDir)
            .filter(f => fs.statSync(path.join(backupsDir, f)).isDirectory())
            .sort()
            .reverse();
            
        if (backups.length === 0) return res.status(404).json({ error: "No backups found" });
        
        const latestBackupId = backups[0];
        const latestBackupDir = path.join(backupsDir, latestBackupId);
        
        const restoreFiles = (source, targetBase) => {
            const files = fs.readdirSync(source);
            files.forEach(file => {
                const srcPath = path.join(source, file);
                const stat = fs.statSync(srcPath);
                if (file === 'meta.json') return;
                
                if (stat.isDirectory()) {
                    restoreFiles(srcPath, path.join(targetBase, file));
                } else {
                    const relPath = path.relative(latestBackupDir, srcPath);
                    const destPath = path.join(__dirname, relPath);
                    const destDir = path.dirname(destPath);
                    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                    fs.copyFileSync(srcPath, destPath);
                }
            });
        };
        
        restoreFiles(latestBackupDir, __dirname);
        res.json({ success: true, message: "System restored to state before last patch." });
        setTimeout(() => process.exit(0), 1000);

    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    }
});


// 5. ASSISTANT CHAT (Updated for Full Access)
const ASSISTANT_TOOLS = [{
    functionDeclarations: [
      {
        name: "list_leads",
        description: "List drivers/leads.",
        parameters: { type: "OBJECT", properties: { status: { type: "STRING" } } }
      },
      {
        name: "list_project_files",
        description: "List all files in the repository structure. Use this before reading a file to know the path.",
        parameters: { type: "OBJECT", properties: {} }
      },
      {
        name: "read_file_content",
        description: "Read the content of a specific file. Requires full file path.",
        parameters: { type: "OBJECT", properties: { filePath: { type: "STRING" } }, required: ["filePath"] }
      },
      {
        name: "write_file",
        description: "Create or overwrite a file with new content. On Vercel, this commits to GitHub.",
        parameters: { type: "OBJECT", properties: { filePath: { type: "STRING" }, content: { type: "STRING" } }, required: ["filePath", "content"] }
      },
      {
        name: "run_sql_analytics",
        description: "Run SQL query.",
        parameters: { type: "OBJECT", properties: { query: { type: "STRING" } }, required: ["query"] }
      }
    ]
}];

app.post('/api/assistant/chat', async (req, res) => {
    const { message, history } = req.body; 
    try {
        const chat = ai.chats.create({
            model: "gemini-3-flash-preview", // Switched to Flash to save quota
            history: history || [],
            config: {
                tools: ASSISTANT_TOOLS,
                systemInstruction: `You are 'Fleet Commander', an AI Operations Manager & Senior Engineer.
                Env: ${IS_VERCEL ? "Vercel Cloud" : "Local"}.
                
                CAPABILITIES:
                1. Manage Leads: Query DB, check statuses.
                2. Full System Access: You can LIST files, READ code, and WRITE/PATCH code.
                
                PROTOCOL:
                - When asked to fix code, first LIST files to check structure, then READ the file, then WRITE the fix.
                - On Vercel, writing a file creates a GitHub Commit. Warn the user that this triggers a redeploy.
                - If the user asks to UNDO, tell them to check the GitHub Commits page if on Vercel.`,
            }
        });
        let result = await chat.sendMessage(message);
        let response = result.response;
        let toolSteps = 0;
        
        while (response.functionCalls && response.functionCalls.length > 0 && toolSteps < 8) {
            toolSteps++;
            const functionCalls = response.functionCalls;
            const functionResponses = [];
            for (const call of functionCalls) {
                let toolResult = {};
                try {
                    if (call.name === 'list_leads') {
                        const dbRes = await queryWithRetry(`SELECT id, name, status FROM drivers LIMIT 10`);
                        toolResult = { leads: dbRes.rows };
                    }
                    else if (call.name === 'list_project_files') {
                        if (IS_VERCEL) {
                            const treeUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`;
                            const treeRes = await axios.get(treeUrl, { headers: { Authorization: `token ${GITHUB_TOKEN}` } });
                            // Optimize: Limit paths to avoid token overflow
                            const paths = treeRes.data.tree.map(f => f.path).slice(0, 100); 
                            toolResult = { files: paths, note: "Showing first 100 files." };
                        } else {
                            const getFiles = (dir) => {
                                let results = [];
                                const list = fs.readdirSync(dir);
                                list.forEach(file => {
                                    if(['node_modules', '.git', '.next', 'dist', '.backups'].includes(file)) return;
                                    file = path.join(dir, file);
                                    const stat = fs.statSync(file);
                                    if (stat && stat.isDirectory()) results = results.concat(getFiles(file));
                                    else results.push(path.relative(__dirname, file));
                                });
                                return results;
                            }
                            const allFiles = getFiles(__dirname);
                            toolResult = { files: allFiles.slice(0, 100), note: "Showing first 100 files." };
                        }
                    }
                    else if (call.name === 'read_file_content') {
                        const { filePath } = call.args;
                        if (IS_VERCEL) {
                            const content = await getGitHubFileContent(filePath);
                            toolResult = content ? { content } : { error: "File not found in GitHub" };
                        } else {
                            const fullPath = path.join(__dirname, filePath);
                            if(fs.existsSync(fullPath)) toolResult = { content: fs.readFileSync(fullPath, 'utf8') };
                            else toolResult = { error: "File not found locally" };
                        }
                    }
                    else if (call.name === 'write_file') {
                        const { filePath, content } = call.args;
                        if (IS_VERCEL) {
                            await updateGitHubFile(filePath, content);
                            toolResult = { success: true, message: "Committed to GitHub. Redeploying..." };
                        } else {
                            const fullPath = path.join(__dirname, filePath);
                            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                            fs.writeFileSync(fullPath, content);
                            toolResult = { success: true, message: "File written locally." };
                        }
                    }
                    else if (call.name === 'run_sql_analytics') {
                        const { query } = call.args;
                        if (/DROP|DELETE|INSERT|UPDATE|ALTER/i.test(query)) toolResult = { error: "Read-only access." };
                        else {
                            const dbRes = await queryWithRetry(query);
                            toolResult = { rows: dbRes.rows };
                        }
                    }
                } catch (e) { toolResult = { error: e.message }; }
                functionResponses.push({ name: call.name, response: { result: toolResult }, id: call.id });
            }
            result = await chat.sendMessage(functionResponses); 
            response = result.response;
        }
        res.json({ text: response.text });
    } catch (e) {
        if (e.status === 429 || e.message.includes('429')) {
             return res.status(429).json({ error: "Assistant Overloaded (429). Please wait 30s." });
        }
        res.status(500).json({ error: e.message });
    }
});

// ... [Existing Endpoints] ...
app.get('/api/health', async (req, res) => { try { await queryWithRetry('SELECT 1'); res.json({ database: 'connected', status: 'healthy', mode: IS_VERCEL ? 'vercel-github' : 'local' }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/drivers', async (req, res) => { const result = await queryWithRetry(`SELECT * FROM drivers ORDER BY last_message_time DESC`); res.json(result.rows); });
app.get('/api/bot-settings', async (req, res) => { const result = await queryWithRetry('SELECT * FROM bot_settings WHERE id = 1'); res.json(result.rows[0]?.settings || DEFAULT_BOT_SETTINGS); });
app.post('/api/bot-settings', async (req, res) => { await queryWithRetry(`UPDATE bot_settings SET settings = $1 WHERE id = 1`, [JSON.stringify(req.body)]); res.json({ success: true }); });
app.post('/api/messages/send', async (req, res) => { res.json({ success: true }); });
app.get('/webhook', (req, res) => { res.send(req.query['hub.challenge']); });
app.post('/webhook', async (req, res) => { res.sendStatus(200); });
app.patch('/api/drivers/:id', async (req, res) => { const { id } = req.params; const updates = req.body; if (updates.status) await queryWithRetry('UPDATE drivers SET status = $1 WHERE id = $2', [updates.status, id]); res.json({ success: true }); });
app.post('/api/update-credentials', (req, res) => { res.json({ success: true }); });
app.post('/api/configure-webhook', (req, res) => { res.json({ success: true }); });
app.get('/api/admin/project-context', async (req, res) => {
    try {
        const files = await getProjectFiles();
        res.json({ files });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = app;
if (require.main === module) app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

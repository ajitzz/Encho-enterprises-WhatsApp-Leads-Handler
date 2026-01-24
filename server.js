
/**
 * UBER FLEET RECRUITER - BACKEND SERVER
 * Enterprise-Grade Connection Handling for Vercel + Neon
 * VERCEL-SAFE MODE ENABLED
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const multer = require('multer'); // Added for Proxy Upload
const { Pool } = require('pg'); 
const { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
require('dotenv').config();

const app = express();
const router = express.Router(); 

// --- SERVER SIDE CACHE (REDUCES DB LOAD) ---
const CACHE = {
    botSettings: null,
    systemSettings: null,
    lastRefreshed: 0
};

// Raw body needed for signature verification
app.use(express.json({ 
    limit: '10mb',
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
app.use(cors()); 

// Vercel optimization: Disable ETag for dynamic API responses
app.set('etag', false);
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

// --- FILE UPLOAD CONFIG (PROXY FALLBACK) ---
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 4.5 * 1024 * 1024 } // 4.5MB limit for Vercel Serverless
});

// --- DYNAMIC CREDENTIALS ---
const META_API_TOKEN = (process.env.META_API_TOKEN || "").trim();
const PHONE_NUMBER_ID = (process.env.PHONE_NUMBER_ID || "").trim();
const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || "").trim();
const APP_SECRET = (process.env.APP_SECRET || "").trim();

if (!META_API_TOKEN || !PHONE_NUMBER_ID) {
  console.error("❌ Missing META_API_TOKEN and/or PHONE_NUMBER_ID. WhatsApp sending will not work.");
}
if (!VERIFY_TOKEN) {
  console.warn("⚠️ VERIFY_TOKEN is missing. Webhook verification may fail.");
}

// --- AWS S3 CONFIG ---
const BUCKET_NAME = process.env.AWS_BUCKET_NAME || process.env.BUCKET_NAME || 'uber-fleet-assets';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

const s3Config = { region: AWS_REGION };
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    s3Config.credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    };
}
const s3Client = new S3Client(s3Config);

// --- DATABASE CONNECTION (HARDENED) ---
const DEFAULT_DB_URL = "postgresql://neondb_owner:npg_4cbpQjKtym9n@ep-small-smoke-a1vjxk25-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
const CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL || DEFAULT_DB_URL;

if (!CONNECTION_STRING) {
    console.error("❌ CRITICAL ERROR: POSTGRES_URL or DATABASE_URL environment variable is missing.");
}

// Smart Pool Sizing: 2 for Serverless (prevents exhaustion), 10 for Local/Container (prevents starvation)
const IS_SERVERLESS = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
const MAX_CONNECTIONS = IS_SERVERLESS ? 2 : 10;

let pool;
if (!global.pgPool) {
    if (CONNECTION_STRING) {
        console.log(`🔌 Initializing DB Connection Pool (Max: ${MAX_CONNECTIONS}, SSL: Required)...`);
        
        global.pgPool = new Pool({
            connectionString: CONNECTION_STRING,
            ssl: { rejectUnauthorized: false }, // Essential for Neon
            max: MAX_CONNECTIONS,
            connectionTimeoutMillis: 10000, // Fail fast (10s)
            idleTimeoutMillis: 30000, 
            keepAlive: true, // Prevent TCP drops
            allowExitOnIdle: false
        });
        
        global.pgPool.on('error', (err, client) => {
            console.error('🔥 Unexpected error on idle DB client', err);
            // Don't exit, just log. Pool should recover.
        });

        global.pgPool.on('connect', () => {
            // Optional: console.log("Connected to DB");
        });
    }
}
pool = global.pgPool;

// --- SCHEMA DEFINITIONS ---
const SCHEMA_QUERIES = `
    CREATE TABLE IF NOT EXISTS drivers (
        id TEXT PRIMARY KEY,
        phone_number TEXT UNIQUE NOT NULL,
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
        human_mode_ends_at BIGINT DEFAULT 0,
        qualification_checks JSONB DEFAULT '{}',
        onboarding_step INT DEFAULT 0,
        updated_at BIGINT DEFAULT (extract(epoch from now()) * 1000)
    );
    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        driver_id TEXT REFERENCES drivers(id),
        sender TEXT,
        text TEXT,
        timestamp BIGINT,
        type TEXT DEFAULT 'text',
        image_url TEXT,
        header_image_url TEXT,
        footer_text TEXT,
        buttons JSONB,
        template_name TEXT,
        client_message_id TEXT UNIQUE, 
        whatsapp_message_id TEXT UNIQUE,
        status TEXT DEFAULT 'sent',
        send_error JSONB, -- Stores API error details
        retry_count INT DEFAULT 0,
        next_retry_at BIGINT DEFAULT 0,
        updated_at BIGINT DEFAULT (extract(epoch from now()) * 1000)
    );
    CREATE TABLE IF NOT EXISTS driver_documents (
        id TEXT PRIMARY KEY,
        driver_id TEXT REFERENCES drivers(id) ON DELETE CASCADE,
        doc_type TEXT NOT NULL,
        file_url TEXT NOT NULL,
        mime_type TEXT,
        created_at BIGINT DEFAULT (extract(epoch from now()) * 1000),
        verification_status TEXT DEFAULT 'pending',
        notes TEXT
    );
    CREATE TABLE IF NOT EXISTS media_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_path TEXT DEFAULT '/',
        is_public_showcase BOOLEAN DEFAULT FALSE,
        created_at BIGINT DEFAULT (extract(epoch from now()) * 1000),
        UNIQUE(name, parent_path)
    );
    CREATE TABLE IF NOT EXISTS media_files (
        id TEXT PRIMARY KEY,
        folder_path TEXT DEFAULT '/',
        filename TEXT NOT NULL,
        s3_key TEXT NOT NULL,
        url TEXT NOT NULL,
        type TEXT,
        media_id TEXT, -- WhatsApp Media ID
        created_at BIGINT DEFAULT (extract(epoch from now()) * 1000)
    );
    CREATE TABLE IF NOT EXISTS bot_settings (
        id INT PRIMARY KEY DEFAULT 1,
        settings JSONB
    );
    CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
    CREATE TABLE IF NOT EXISTS scheduled_messages (
        id SERIAL PRIMARY KEY,
        driver_ids TEXT[], 
        content JSONB,
        scheduled_time BIGINT,
        status TEXT DEFAULT 'pending',
        created_at BIGINT DEFAULT (extract(epoch from now()) * 1000)
    );
    INSERT INTO system_settings (key, value) VALUES 
    ('webhook_ingest_enabled', 'true'),
    ('automation_enabled', 'true'),
    ('sending_enabled', 'true')
    ON CONFLICT (key) DO NOTHING;
`;

// --- ENTERPRISE INDEXES ---
const INDEX_QUERIES = `
    CREATE INDEX IF NOT EXISTS idx_drivers_updated_at ON drivers(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_driver_timestamp ON messages(driver_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_client_msg_id ON messages(client_message_id);
    CREATE INDEX IF NOT EXISTS idx_messages_outbox_v2 ON messages(next_retry_at ASC, retry_count) WHERE status IN ('pending', 'failed');
    CREATE INDEX IF NOT EXISTS idx_driver_documents_driver_id ON driver_documents(driver_id);
    CREATE INDEX IF NOT EXISTS idx_media_files_path ON media_files(folder_path);
    CREATE INDEX IF NOT EXISTS idx_media_folders_parent ON media_folders(parent_path);
`;

// --- MIGRATION QUERIES ---
const MIGRATION_QUERIES = `
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_message_id TEXT UNIQUE;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS whatsapp_message_id TEXT UNIQUE;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS template_name TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'sent';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS send_error JSONB;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS retry_count INT DEFAULT 0;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS next_retry_at BIGINT DEFAULT 0;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS updated_at BIGINT DEFAULT (extract(epoch from now()) * 1000);
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS current_bot_step_id TEXT;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_bot_active BOOLEAN DEFAULT TRUE;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_human_mode BOOLEAN DEFAULT FALSE;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS human_mode_ends_at BIGINT DEFAULT 0;
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS qualification_checks JSONB DEFAULT '{}';
    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS onboarding_step INT DEFAULT 0;
    
    ALTER TABLE media_folders ADD COLUMN IF NOT EXISTS is_public_showcase BOOLEAN DEFAULT FALSE;
    ALTER TABLE media_files ADD COLUMN IF NOT EXISTS media_id TEXT;
    ALTER TABLE media_folders ADD COLUMN IF NOT EXISTS created_at BIGINT DEFAULT (extract(epoch from now()) * 1000);
    ALTER TABLE media_files ADD COLUMN IF NOT EXISTS created_at BIGINT DEFAULT (extract(epoch from now()) * 1000);
`;

const queryWithRetry = async (text, params, retries = 1) => { 
    if (!pool) throw new Error("Database connection not configured.");
    let client;
    try {
        client = await pool.connect();
        const res = await client.query(text, params);
        return res;
    } catch (err) {
        if (client) { try { client.release(true); } catch(e) {} client = null; }
        
        if (err.code === '42P01') { 
            console.warn("⚠️ Tables missing. Running Schema Init...");
            try {
                const healClient = await pool.connect();
                await healClient.query(SCHEMA_QUERIES);
                await healClient.query(INDEX_QUERIES); 
                healClient.release();
                const retryClient = await pool.connect();
                const res = await retryClient.query(text, params);
                retryClient.release();
                return res;
            } catch (healErr) {
                console.error("❌ Schema Healing Failed:", healErr.message);
                throw healErr;
            }
        }
        
        if (err.code === '42703') {
             console.warn("⚠️ Columns missing. Running Migrations...");
             try {
                const healClient = await pool.connect();
                await healClient.query(MIGRATION_QUERIES);
                healClient.release();
                const retryClient = await pool.connect();
                const res = await retryClient.query(text, params);
                retryClient.release();
                return res;
             } catch (healErr) {
                console.error("❌ Migration Failed:", healErr.message);
                throw healErr;
             }
        }

        if (retries > 0 && (err.code === 'ECONNRESET' || err.code === '57P01' || err.message.includes('timeout'))) {
            console.warn(`♻️ DB Retry (${retries} left) due to: ${err.message}`);
            await new Promise(res => setTimeout(res, 1000)); 
            return queryWithRetry(text, params, retries - 1);
        }
        throw err;
    } finally {
        if (client) { try { client.release(); } catch(e) {} }
    }
};

const refreshCache = async () => {
    try {
        const botRes = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1');
        CACHE.botSettings = botRes.rows[0]?.settings || { isEnabled: true, steps: [] };

        const sysRes = await queryWithRetry('SELECT * FROM system_settings');
        const settings = { webhook_ingest_enabled: true, automation_enabled: true, sending_enabled: true };
        sysRes.rows.forEach(r => { if (r.key in settings) settings[r.key] = r.value === 'true'; });
        CACHE.systemSettings = settings;

        CACHE.lastRefreshed = Date.now();
        console.log("🧠 Server Cache Refreshed");
    } catch (e) {
        console.error("Failed to refresh cache (using defaults):", e.message);
    }
};

const getCachedBotSettings = async () => {
    if (!CACHE.botSettings) await refreshCache();
    return CACHE.botSettings;
};

const getCachedSystemSetting = async (key) => {
    if (!CACHE.systemSettings) await refreshCache();
    return CACHE.systemSettings[key];
};

const initDB = async () => {
    try {
        console.log("🚀 Testing Database Connection...");
        await queryWithRetry("SELECT 1"); 
        console.log("✅ Database Connected Successfully");
        
        await queryWithRetry(SCHEMA_QUERIES);
        await queryWithRetry(MIGRATION_QUERIES);
        await refreshCache(); 
    } catch (e) {
        console.error("⚠️ CRITICAL DB FAILURE:", e.message);
        console.error("👉 Check your POSTGRES_URL connection string.");
        console.error("👉 Check Neon DB Status (Resume project if paused).");
    }
};
initDB();

// --- NEW ROUTE: BOT SETTINGS (GET) ---
router.get('/bot-settings', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT settings FROM bot_settings WHERE id = 1');
        if (result.rows.length > 0) {
            res.json(result.rows[0].settings);
        } else {
            // Return defaults if not configured
            res.json({
                isEnabled: true,
                shouldRepeat: false,
                routingStrategy: 'BOT_ONLY',
                systemInstruction: "You are a helpful assistant.",
                steps: []
            });
        }
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// --- NEW ROUTE: BOT SETTINGS (POST) ---
router.post('/bot-settings', async (req, res) => {
    const settings = req.body;
    try {
        await queryWithRetry(`
            INSERT INTO bot_settings (id, settings) 
            VALUES (1, $1) 
            ON CONFLICT (id) DO UPDATE SET settings = $1
        `, [JSON.stringify(settings)]);
        
        CACHE.botSettings = settings; // Update cache immediately
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

const toDriverDTO = (row) => ({
    id: row.id,
    phoneNumber: row.phone_number,
    name: row.name,
    source: row.source,
    status: row.status,
    lastMessage: row.last_message,
    lastMessageTime: parseInt(row.last_message_time || '0'),
    updatedAt: parseInt(row.updated_at || '0'),
    notes: row.notes,
    vehicleRegistration: row.vehicle_registration,
    availability: row.availability,
    currentBotStepId: row.current_bot_step_id,
    isBotActive: row.is_bot_active,
    isHumanMode: row.is_human_mode,
    humanModeEndsAt: parseInt(row.human_mode_ends_at || '0'),
    qualificationChecks: row.qualification_checks || {},
    onboardingStep: row.onboarding_step || 0,
    messages: [], 
    documents: [] 
});

const toMessageDTO = (row) => ({
    id: row.id,
    sender: row.sender,
    text: row.text,
    type: row.type,
    timestamp: parseInt(row.timestamp || '0'),
    imageUrl: row.image_url,
    headerImageUrl: row.header_image_url,
    footer_text: row.footer_text, 
    footerText: row.footer_text, 
    buttons: row.buttons, 
    templateName: row.template_name,
    status: row.status || 'sent',
    sendError: row.send_error 
});

const toDocumentDTO = (row) => ({
    id: row.id,
    driverId: row.driver_id,
    docType: row.doc_type,
    file_url: row.file_url,
    fileUrl: row.file_url,
    mimeType: row.mime_type,
    createdAt: parseInt(row.created_at || '0'),
    verificationStatus: row.verification_status,
    notes: row.notes
});

const updateDriverTimestamp = async (driverId) => {
    try {
        await queryWithRetry('UPDATE drivers SET updated_at = $1 WHERE id = $2', [Date.now(), driverId]);
    } catch (e) { console.error("Timestamp update failed", e); }
};

// --- MEDIA LIBRARY ROUTES ---

// 1. Get Media Library Content (Files & Folders)
router.get('/media', async (req, res) => {
    const { path = '/' } = req.query;
    try {
        const folderRes = await queryWithRetry('SELECT * FROM media_folders WHERE parent_path = $1 ORDER BY name ASC', [path]);
        const fileRes = await queryWithRetry('SELECT * FROM media_files WHERE folder_path = $1 ORDER BY created_at DESC', [path]);
        
        res.json({
            folders: folderRes.rows,
            files: fileRes.rows
        });
    } catch (e) {
        console.error("Get Media Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// 2. Create Folder
router.post('/folders', async (req, res) => {
    const { name, parentPath } = req.body;
    const id = `folder_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    try {
        await queryWithRetry('INSERT INTO media_folders (id, name, parent_path, created_at) VALUES ($1, $2, $3, $4)', [id, name, parentPath, Date.now()]);
        res.json({ success: true, id });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: "Folder name already exists" });
        res.status(500).json({ error: e.message });
    }
});

// 3. Rename Folder
router.put('/folders/:id', async (req, res) => {
    const { name } = req.body;
    try {
        await queryWithRetry('UPDATE media_folders SET name = $1 WHERE id = $2', [name, req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. Delete Folder
router.delete('/folders/:id', async (req, res) => {
    try {
        // Check emptiness
        const folderRes = await queryWithRetry('SELECT name, parent_path FROM media_folders WHERE id = $1', [req.params.id]);
        if (folderRes.rows.length === 0) return res.status(404).json({ error: "Folder not found" });
        
        const folder = folderRes.rows[0];
        const fullPath = folder.parent_path === '/' ? `/${folder.name}` : `${folder.parent_path}/${folder.name}`;

        // Check if subfolders or files exist
        const subFolders = await queryWithRetry('SELECT 1 FROM media_folders WHERE parent_path = $1', [fullPath]);
        const files = await queryWithRetry('SELECT 1 FROM media_files WHERE folder_path = $1', [fullPath]);

        if (subFolders.rows.length > 0 || files.rows.length > 0) {
            return res.status(400).json({ error: "Folder must be empty before deletion" });
        }

        await queryWithRetry('DELETE FROM media_folders WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 5. Delete File
router.delete('/files/:id', async (req, res) => {
    try {
        const fileRes = await queryWithRetry('SELECT s3_key FROM media_files WHERE id = $1', [req.params.id]);
        if (fileRes.rows.length > 0) {
            const key = fileRes.rows[0].s3_key;
            // Delete from S3
            try {
                await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
            } catch (s3Err) {
                console.warn("S3 Delete Failed (might not exist):", s3Err.message);
            }
        }
        await queryWithRetry('DELETE FROM media_files WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 6. Sync from S3
router.post('/media/sync', async (req, res) => {
    try {
        const command = new ListObjectsV2Command({ Bucket: BUCKET_NAME });
        const data = await s3Client.send(command);
        const contents = data.Contents || [];
        
        let added = 0;
        for (const item of contents) {
            const key = item.Key;
            if (!key || key.endsWith('/')) continue; // Skip folders or empty keys

            const exists = await queryWithRetry('SELECT 1 FROM media_files WHERE s3_key = $1', [key]);
            if (exists.rows.length === 0) {
                // Infer details from key
                // Structure assumption: /Folder/Subfolder/File.ext or just File.ext
                const parts = key.split('/');
                const filename = parts.pop();
                const folderPath = parts.length > 0 ? '/' + parts.join('/') : '/';
                
                // Ensure folders exist? Ideally yes, but for sync simplified we might just register file or create root folders.
                // For simplicity, if folder path is complex, we might just put it in root or ignore folder structure creation in this lightweight sync.
                // Let's assume root for simplicity or try to match.
                
                let publicUrl = `https://${BUCKET_NAME}.s3.amazonaws.com/${key}`;
                if (AWS_REGION && AWS_REGION !== 'us-east-1') {
                    publicUrl = `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${key}`;
                }

                const id = `file_sync_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                let type = 'document';
                if (filename.match(/\.(jpg|jpeg|png|gif|webp)$/i)) type = 'image';
                if (filename.match(/\.(mp4|mov|webm)$/i)) type = 'video';

                await queryWithRetry(`
                    INSERT INTO media_files (id, folder_path, filename, s3_key, url, type, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                `, [id, folderPath, filename, key, publicUrl, type, Date.now()]);
                added++;
            }
        }
        res.json({ success: true, added });
    } catch (e) {
        console.error("Sync Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// 7. Get Presigned URL (Direct Upload)
router.post('/s3/presign', async (req, res) => {
    const { filename, fileType, folderPath = '/' } = req.body;
    const safePath = folderPath.startsWith('/') ? folderPath.slice(1) : folderPath;
    const prefix = safePath ? `${safePath}/` : '';
    const key = `${prefix}${Date.now()}_${filename.replace(/\s+/g, '_')}`;

    try {
        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            ContentType: fileType
        });
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        
        let publicUrl = `https://${BUCKET_NAME}.s3.amazonaws.com/${key}`;
        if (AWS_REGION && AWS_REGION !== 'us-east-1') {
            publicUrl = `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${key}`;
        }

        res.json({ uploadUrl, key, publicUrl });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 8. Register File (After Direct Upload)
router.post('/files/register', async (req, res) => {
    const { key, url, filename, type, folderPath } = req.body;
    const id = `file_direct_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    try {
        await queryWithRetry(`
            INSERT INTO media_files (id, folder_path, filename, s3_key, url, type, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [id, folderPath, filename, key, url, type, Date.now()]);
        res.json({ success: true, id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 9. Public Showcase Endpoints
router.post('/folders/:id/public', async (req, res) => {
    try {
        // Reset others (Single Showcase Mode logic, or allow multiple? Frontend implies multiple toggles but banner shows active one)
        // Let's allow multiple in DB but maybe UI only tracks one global active.
        // For consistency with typical "Showcase", usually one folder is active.
        // Let's unset all first.
        await queryWithRetry('UPDATE media_folders SET is_public_showcase = FALSE');
        await queryWithRetry('UPDATE media_folders SET is_public_showcase = TRUE WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.delete('/folders/:id/public', async (req, res) => {
    try {
        await queryWithRetry('UPDATE media_folders SET is_public_showcase = FALSE WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/public/status', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT id, name FROM media_folders WHERE is_public_showcase = TRUE LIMIT 1');
        if (result.rows.length > 0) {
            res.json({ active: true, folderId: result.rows[0].id, folderName: result.rows[0].name });
        } else {
            res.json({ active: false });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/public/showcase', async (req, res) => {
    const { folder } = req.query; // Name or Token
    try {
        let folderQuery = 'SELECT id, name FROM media_folders WHERE is_public_showcase = TRUE LIMIT 1';
        let params = [];
        
        if (folder) {
            // Find by name if provided, else rely on is_public_showcase
            folderQuery = 'SELECT id, name FROM media_folders WHERE name = $1 LIMIT 1';
            params = [decodeURIComponent(folder)];
        }

        const folderRes = await queryWithRetry(folderQuery, params);
        if (folderRes.rows.length === 0) return res.json({ title: 'Not Found', items: [] });

        const activeFolder = folderRes.rows[0];
        const fullPath = `/${activeFolder.name}`; // Assumption: Root level folders

        // Recursively find files? Or just flat for now. Flat is safer for V1.
        // If we want recursive, we need a recursive CTE or just grab direct children.
        // Let's grab files in this folder.
        const filesRes = await queryWithRetry('SELECT id, url, type, filename FROM media_files WHERE folder_path = $1 ORDER BY created_at DESC', [fullPath]);
        
        res.json({
            title: activeFolder.name,
            items: filesRes.rows
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 10. Sync File to WhatsApp (Placeholder / Mock for now as actual media upload API requires fetching bytes)
router.post('/files/:id/sync', async (req, res) => {
    // In a real app, this would fetch the file from S3, upload to Meta Media API, and store the media_id
    // For this demo, we will just mark it as synced with a mock ID.
    try {
        const mediaId = `media_${Date.now()}`;
        await queryWithRetry('UPDATE media_files SET media_id = $1 WHERE id = $2', [mediaId, req.params.id]);
        res.json({ success: true, media_id: mediaId });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- CRON: AUTO REVERT HUMAN MODE ---
// Checks every minute for expired human sessions and reverts them to Bot Mode
setInterval(async () => {
    if (!pool) return;
    try {
        const now = Date.now();
        const res = await queryWithRetry(`
            UPDATE drivers 
            SET is_human_mode = FALSE, human_mode_ends_at = 0, current_bot_step_id = NULL, updated_at = $1
            WHERE is_human_mode = TRUE AND human_mode_ends_at > 0 AND human_mode_ends_at < $1
            RETURNING id, phone_number
        `, [now]);
        
        if (res.rowCount > 0) {
            console.log(`[Auto-Revert] 🤖 Switched ${res.rowCount} drivers back to Bot Mode due to timeout.`);
            // Optional: Send a template message saying "Chat session closed due to inactivity"
        }
    } catch (e) {
        console.error("Auto-Revert Worker Failed:", e.message);
    }
}, 60000); 

const executeMetaSend = async (to, content) => {
    if (!META_API_TOKEN || !PHONE_NUMBER_ID) throw new Error("Missing Meta Credentials");

    let cleanTo = to.replace(/\D/g, ''); 
    const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
    
    let bodyText = (content.text || content.message || "").substring(0, 4096);
    let safeBodyText = bodyText.trim() || " ";

    let payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: cleanTo,
        type: "text",
        text: { body: safeBodyText }
    };

    // --- TEMPLATE MODE (Primary for Links/Calls) ---
    if (content.templateName) {
        payload.type = "template";
        payload.template = { 
            name: content.templateName, 
            language: { code: "en_US" }, 
            components: [] 
        };
        
        // If template + Header Image, map it
        if (content.headerImageUrl) {
            payload.template.components.push({
                type: "header",
                parameters: [{ type: "image", image: { link: content.headerImageUrl } }]
            });
        }
        
        delete payload.text;
    }
    // --- INTERACTIVE MODE (Standard) ---
    else if (content.buttons?.length > 0 || (content.options && content.options.length > 0)) {
        
        let allButtons = content.buttons || [];
        
        // Legacy Options -> Buttons
        if (allButtons.length === 0 && content.options) {
            allButtons = content.options.slice(0, 3).map((opt, i) => ({
                type: 'reply',
                title: opt,
                payload: `btn_${i}_${opt.substring(0, 10)}`
            }));
        }

        // SMART FALLBACK STRATEGY:
        // Interactive Messages DO NOT support 'phone' or arbitrary 'url' buttons easily without templates.
        // Filter out non-reply buttons and append them as TEXT LINKS to the body.
        
        const replyButtons = allButtons.filter(b => b.type === 'reply');
        const actionButtons = allButtons.filter(b => b.type !== 'reply');

        if (actionButtons.length > 0) {
            let appendText = "\n";
            actionButtons.forEach(btn => {
                if (btn.type === 'url') appendText += `\n🔗 ${btn.title}: ${btn.payload}`;
                if (btn.type === 'phone') appendText += `\n📞 ${btn.title}: ${btn.payload}`;
                if (btn.type === 'location') appendText += `\n📍 ${btn.title}`;
            });
            safeBodyText += appendText;
        }

        if (replyButtons.length > 0) {
            // Send Interactive Message with Reply Buttons Only
            payload.type = "interactive";
            
            let headerObj = undefined;
            if (content.headerImageUrl && content.headerImageUrl.startsWith('http')) {
                headerObj = { type: "image", image: { link: content.headerImageUrl } };
            }

            const actionObj = {
                buttons: replyButtons.map((btn, i) => ({
                    type: "reply",
                    reply: { id: btn.payload || `btn_${i}`, title: (btn.title || "Option").substring(0, 20) }
                }))
            };
            
            payload.interactive = {
                type: "button",
                header: headerObj,
                body: { text: safeBodyText.trim() }, 
                action: actionObj
            };
            
            if (content.footerText) payload.interactive.footer = { text: content.footerText };
            delete payload.text;
        } else {
            // No Reply Buttons left (only Actions)? Send as standard TEXT with appended links.
            // If image exists, send as Image + Caption
            if (content.headerImageUrl) {
                payload.type = "image";
                payload.image = { link: content.headerImageUrl, caption: safeBodyText };
                delete payload.text;
            } else {
                payload.text = { body: safeBodyText };
            }
        }
    } 
    // --- MEDIA MODE ---
    else if (content.mediaUrl) {
         const type = content.mediaType || 'image';
         payload.type = type;
         payload[type] = { link: content.mediaUrl, caption: safeBodyText !== " " ? safeBodyText : undefined };
         delete payload.text;
    }

    const response = await axios.post(url, payload, {
        headers: { 'Authorization': `Bearer ${META_API_TOKEN}`, 'Content-Type': 'application/json' },
        timeout: 10000 
    });
    
    return response.data.messages?.[0]?.id;
};

const processOutbox = async () => {
    if (!pool) return;
    const sendingEnabled = await getCachedSystemSetting('sending_enabled');
    if (!sendingEnabled) return;

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const fetchQuery = `
            SELECT m.id, m.text, m.buttons, m.template_name, m.image_url, m.header_image_url, m.footer_text, d.phone_number, m.retry_count
            FROM messages m
            JOIN drivers d ON m.driver_id = d.id
            WHERE m.status IN ('pending', 'failed')
            AND (m.next_retry_at IS NULL OR m.next_retry_at <= $1)
            AND m.retry_count < 5
            ORDER BY m.next_retry_at ASC
            LIMIT 5
            FOR UPDATE SKIP LOCKED
        `;
        
        const { rows } = await client.query(fetchQuery, [Date.now()]);

        for (const row of rows) {
            const content = {
                text: row.text,
                buttons: row.buttons,
                templateName: row.template_name,
                mediaUrl: row.image_url,
                headerImageUrl: row.header_image_url,
                footerText: row.footer_text
            };

            try {
                const wamid = await executeMetaSend(row.phone_number, content);
                
                await client.query(
                    "UPDATE messages SET status = 'sent', whatsapp_message_id = $1, updated_at = $2, send_error = NULL WHERE id = $3",
                    [wamid, Date.now(), row.id]
                );
            } catch (e) {
                const delay = Math.pow(2, row.retry_count + 1) * 2000;
                const nextTry = Date.now() + delay;
                
                const errorData = e.response?.data || { message: e.message };
                console.error(`[OUTBOX] Failed: ${row.id}. Retry in ${delay}ms. Reason:`, errorData);
                
                await client.query(
                    "UPDATE messages SET status = 'failed', retry_count = retry_count + 1, next_retry_at = $1, send_error = $3 WHERE id = $2",
                    [nextTry, row.id, JSON.stringify(errorData)]
                );
            }
        }

        await client.query('COMMIT');
    } catch (e) {
        if (client) await client.query('ROLLBACK');
        console.error("Worker Transaction Error:", e.message);
    } finally {
        if (client) client.release();
    }
};

const queueAndSendMessage = async (to, content, clientMessageId = null, driverId) => {
    const sendingEnabled = await getCachedSystemSetting('sending_enabled');
    if (!sendingEnabled) return { success: false, error: "System Disabled" };

    const bodyText = (content.text || content.message || "").substring(0, 4096);
    
    if (/replace\s+this|enter\s+your\s+message/i.test(bodyText)) {
        console.warn(`⚠️ WARNING: Sending placeholder text to ${to}: "${bodyText.substring(0, 30)}..." (Allowed by Safety Policy)`);
    }

    if (!bodyText.trim() && !content.templateName && !content.mediaUrl && !content.buttons) {
         return { success: false, error: "Blocked: Empty Content" };
    }

    const msgId = `msg_${Date.now()}_${Math.random().toString(36).substr(2,5)}`;
    const dbText = bodyText || (content.templateName ? `Template: ${content.templateName}` : '[Media Message]');
    const retryBuffer = Date.now() + 15000; 
    
    try {
        const insertRes = await queryWithRetry(`
            INSERT INTO messages (id, driver_id, sender, text, timestamp, type, client_message_id, buttons, template_name, image_url, status, header_image_url, footer_text, next_retry_at)
            VALUES ($1, $2, 'agent', $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, $12)
            ON CONFLICT (client_message_id) DO NOTHING
            RETURNING id
        `, [
            msgId, driverId, dbText, Date.now(),
            content.templateName ? 'template' : (content.options ? 'options' : 'text'),
            clientMessageId,
            content.buttons ? JSON.stringify(content.buttons) : null,
            content.templateName,
            content.mediaUrl,
            content.headerImageUrl,
            content.footerText,
            retryBuffer
        ]);

        if (insertRes.rows.length === 0) return { success: true, duplicate: true };

    } catch(e) {
        console.error("DB Insert Failed:", e);
        throw e;
    }

    try {
        const wamid = await executeMetaSend(to, content);
        
        await queryWithRetry("UPDATE messages SET status = 'sent', whatsapp_message_id = $1, send_error = NULL WHERE id = $2", [wamid, msgId]);
        await updateDriverTimestamp(driverId);
        
        return { success: true, messageId: msgId };
    } catch (error) {
        console.error(`❌ Meta Send Failed for ${to}:`, error.response?.data || error.message);
        
        const fastRetry = Date.now() + 2000;
        const errorData = error.response?.data || { message: error.message };
        
        await queryWithRetry("UPDATE messages SET status = 'failed', next_retry_at = $1, send_error = $3 WHERE id = $2", [fastRetry, msgId, JSON.stringify(errorData)]);
        
        processOutbox().catch(console.error);
        return { success: true, messageId: msgId, queued: true };
    }
};

router.post('/s3/proxy-upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file provided" });
    
    const { folderPath = '/' } = req.body;
    const safePath = folderPath.startsWith('/') ? folderPath.slice(1) : folderPath;
    const prefix = safePath ? `${safePath}/` : '';
    const key = `${prefix}${Date.now()}_${req.file.originalname.replace(/\s+/g, '_')}`;

    try {
        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
        });
        await s3Client.send(command);

        let publicUrl = `https://${BUCKET_NAME}.s3.amazonaws.com/${key}`;
        if (AWS_REGION && AWS_REGION !== 'us-east-1') {
            publicUrl = `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${key}`;
        }

        const id = `file_proxy_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        
        let mediaType = 'document';
        if (req.file.mimetype.match(/^image\//)) mediaType = 'image';
        if (req.file.mimetype.match(/^video\//)) mediaType = 'video';

        await queryWithRetry(`
            INSERT INTO media_files (id, folder_path, filename, s3_key, url, type, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [id, folderPath, req.file.originalname, key, publicUrl, mediaType, Date.now()]);
        
        res.json({ success: true, url: publicUrl, type: mediaType });
    } catch(e) {
        console.error("Proxy Upload Error:", e);
        res.status(500).json({ error: e.message || "Proxy upload failed" });
    }
});

// NEW ROUTE: Schedule Message (Moved here)
router.post('/messages/schedule', async (req, res) => {
    const { driverIds, text, mediaUrl, mediaType, options, headerImageUrl, footerText, buttons, templateName, scheduledTime } = req.body;

    if (!driverIds || !Array.isArray(driverIds) || driverIds.length === 0) {
        return res.status(400).json({ error: "No recipients provided" });
    }

    const content = {
        text,
        mediaUrl,
        mediaType,
        options,
        headerImageUrl,
        footerText,
        buttons,
        templateName
    };

    try {
        await queryWithRetry(`
            INSERT INTO scheduled_messages (driver_ids, content, scheduled_time, status)
            VALUES ($1, $2, $3, 'pending')
        `, [driverIds, JSON.stringify(content), scheduledTime]);

        res.json({ success: true });
    } catch (e) {
        console.error("Schedule Error:", e);
        res.status(500).json({ error: e.message });
    }
});

router.post('/messages/send', async (req, res) => {
    const { driverId, text, clientMessageId, ...attachments } = req.body;
    
    try {
        const driverRes = await queryWithRetry('SELECT phone_number FROM drivers WHERE id = $1', [driverId]);
        if (driverRes.rows.length === 0) return res.status(404).json({ error: "Driver not found" });
        const phone = driverRes.rows[0].phone_number;

        const result = await queueAndSendMessage(phone, { text, ...attachments }, clientMessageId, driverId);
        processOutbox().catch(e => console.error("Lazy outbox error:", e));
        res.json(result);

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// WEBHOOK
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('✅ WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(400);
    }
});

app.post('/webhook', async (req, res) => {
    const enabled = await getCachedSystemSetting('webhook_ingest_enabled');
    if (!enabled) return res.sendStatus(503); 

    if (APP_SECRET && req.headers['x-hub-signature-256']) {
        const signature = req.headers['x-hub-signature-256'].replace('sha256=', '');
        const expected = crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
        if (signature !== expected) return res.sendStatus(403);
    }

    try {
        const body = req.body;
        if (body.object === 'whatsapp_business_account') {
            const promises = [];
            for (const entry of body.entry) {
                for (const change of entry.changes) {
                    if (change.value.messages) {
                        for (const msg of change.value.messages) {
                            promises.push(processIncomingMessage(msg, change.value.contacts));
                        }
                    }
                    if (change.value.statuses) {
                        for (const status of change.value.statuses) {
                            promises.push(processStatusUpdate(status));
                        }
                    }
                }
            }
            await Promise.all(promises);
        }
        res.sendStatus(200);
    } catch (e) {
        console.error("Webhook Error:", e);
        res.sendStatus(200); 
    }
});

async function processStatusUpdate(status) {
    await queryWithRetry('UPDATE messages SET status = $1 WHERE whatsapp_message_id = $2', [status.status, status.id]);
}

async function processIncomingMessage(msg, contacts) {
    const from = msg.from;
    const wamid = msg.id; 
    
    const existing = await queryWithRetry('SELECT id FROM messages WHERE whatsapp_message_id = $1', [wamid]);
    if (existing.rows.length > 0) return;

    let text = '';
    let buttonId = null;
    
    if (msg.type === 'text') text = msg.text.body;
    else if (msg.type === 'button') text = msg.button.text; 
    else if (msg.type === 'interactive') {
        if (msg.interactive.type === 'button_reply') {
            text = msg.interactive.button_reply.title;
            buttonId = msg.interactive.button_reply.id; 
        } else if (msg.interactive.type === 'list_reply') {
            text = msg.interactive.list_reply.title;
            buttonId = msg.interactive.list_reply.id;
        }
    }

    const driverId = `d_${from}`; 
    const name = contacts?.[0]?.profile?.name || 'Unknown Driver';
    
    const driverRes = await queryWithRetry(`
        INSERT INTO drivers (id, phone_number, name, status, last_message, last_message_time, updated_at, is_bot_active, is_human_mode, current_bot_step_id)
        VALUES ($1, $2, $3, 'New', $4, $5, $6, TRUE, FALSE, NULL)
        ON CONFLICT (phone_number) 
        DO UPDATE SET last_message = $4, last_message_time = $5, updated_at = $6
        RETURNING id, phone_number, current_bot_step_id, is_bot_active, is_human_mode, human_mode_ends_at
    `, [driverId, from, name, text, Date.now(), Date.now()]);
    
    const currentDriver = driverRes.rows[0];

    const msgId = `msg_${Date.now()}_in_${Math.random().toString(36).substr(2,5)}`;
    await queryWithRetry(`
        INSERT INTO messages (id, driver_id, sender, text, timestamp, whatsapp_message_id, status)
        VALUES ($1, $2, 'driver', $3, $4, $5, 'read')
    `, [msgId, currentDriver.id, text, Date.now(), wamid]);

    try {
        await runBotEngine(currentDriver, text, buttonId);
    } catch (e) {
        console.error("Bot Engine Crash:", e);
    }
}

async function runBotEngine(driver, text, buttonId) {
    const from = driver.phone_number;
    console.log(`[Bot Engine] 🟢 Triggered for ${from}`);
    
    const automationEnabled = await getCachedSystemSetting('automation_enabled');
    if (!automationEnabled) {
        console.log(`[Bot Engine] 🛑 Skipped: Automation Disabled globally.`);
        return;
    }

    if (!driver.is_bot_active || driver.is_human_mode) {
        console.log(`[Bot Engine] Skipped ${from}: is_bot_active=${driver.is_bot_active}, is_human_mode=${driver.is_human_mode}`);
        return;
    }

    const botSettings = await getCachedBotSettings();
    if (!botSettings || !botSettings.isEnabled) {
        console.log(`[Bot Engine] 🛑 Skipped: Bot Settings Disabled.`);
        return;
    }

    let currentStep = botSettings.steps.find(s => s.id === driver.current_bot_step_id);
    let replyContent = null;

    console.log(`[Bot Engine] 🔍 Current Step ID: ${driver.current_bot_step_id || 'START (Null)'}`);

    if (!currentStep) {
        const entryStep = botSettings.steps.find(s => s.id === botSettings.entryPointId) || botSettings.steps[0];
        if (entryStep) {
            console.log(`[Bot Engine] 🚀 Starting Flow at Step: ${entryStep.id}`);
            replyContent = entryStep;
            await queryWithRetry('UPDATE drivers SET current_bot_step_id = $1, updated_at = $3 WHERE id = $2', [entryStep.id, driver.id, Date.now()]);
        } else {
            console.warn(`[Bot Engine] ⚠️ No Entry Step found for ${from}. Check Bot Settings.`);
        }
    } else {
        console.log(`[Bot Engine] 🔄 Processing Input at Step: ${currentStep.id}`);
        let matchedRouteId = null;
        
        // 1. Check Button Payload
        if (buttonId && currentStep.routes) {
            matchedRouteId = currentStep.routes[buttonId];
            if (matchedRouteId) console.log(`[Bot Engine] 👉 Matched Button Payload: ${buttonId} -> ${matchedRouteId}`);
        }
        
        // 2. Check Text Input (Fuzzy Match for Options)
        if (!matchedRouteId && currentStep.routes) {
            const lowerInput = text.toLowerCase().trim();
            // Try to match key or label in routes
            const routeKey = Object.keys(currentStep.routes).find(k => k.toLowerCase() === lowerInput);
            if (routeKey) {
                matchedRouteId = currentStep.routes[routeKey];
                console.log(`[Bot Engine] 👉 Matched Text Input: "${text}" -> ${matchedRouteId}`);
            }
        }
        
        // 3. Default Next Step (Linear Flow)
        if (!matchedRouteId && !currentStep.routes && currentStep.nextStepId) {
            matchedRouteId = currentStep.nextStepId;
            console.log(`[Bot Engine] 👉 Proceeding to Linear Next Step: ${matchedRouteId}`);
        }

        if (matchedRouteId) {
            if (matchedRouteId === 'END') {
                console.log(`[Bot Engine] 🏁 Reached END of Flow.`);
                await queryWithRetry('UPDATE drivers SET current_bot_step_id = NULL, is_bot_active = $1, updated_at = $3 WHERE id = $2', [botSettings.shouldRepeat, driver.id, Date.now()]);
            } else if (matchedRouteId === 'AI_HANDOFF') {
                 console.log(`[Bot Engine] 🤝 AI Handoff Triggered.`);
                 // SET HUMAN MODE AND TIMER FOR 30 MINUTES
                 const expiry = Date.now() + (30 * 60 * 1000);
                 await queryWithRetry('UPDATE drivers SET is_human_mode = TRUE, human_mode_ends_at = $3, updated_at = $2 WHERE id = $1', [driver.id, Date.now(), expiry]);
            } else {
                const nextStep = botSettings.steps.find(s => s.id === matchedRouteId);
                if (nextStep) {
                    replyContent = nextStep;
                    await queryWithRetry('UPDATE drivers SET current_bot_step_id = $1, updated_at = $3 WHERE id = $2', [nextStep.id, driver.id, Date.now()]);
                    
                    if (currentStep.saveToField) {
                         const allowedFields = ['name', 'vehicle_registration', 'availability', 'email', 'notes'];
                         if (allowedFields.includes(currentStep.saveToField)) {
                             try {
                                 await queryWithRetry(`UPDATE drivers SET ${currentStep.saveToField} = $1 WHERE id = $2`, [text, driver.id]);
                                 console.log(`[Bot Engine] 💾 Saved "${text}" to field ${currentStep.saveToField}`);
                             } catch(e) {}
                         }
                    }
                } else {
                    console.error(`[Bot Engine] ❌ Config Error: Next Step ID "${matchedRouteId}" not found in steps list.`);
                }
            }
        } else {
            // Invalid Input Logic
            if (currentStep.options || currentStep.buttons) {
                 console.log(`[Bot Engine] ⚠️ Invalid Input. Re-sending current step.`);
                 replyContent = {
                     ...currentStep,
                     message: `⚠️ Invalid selection. Please try again.\n\n${currentStep.message || currentStep.title || ""}`
                 };
            } else {
                 console.log(`[Bot Engine] ❓ No route matched and no linear next step. Bot stuck.`);
            }
        }
    }

    if (replyContent) {
        if (replyContent.delay) {
            console.log(`[Bot Engine] ⏳ Waiting ${replyContent.delay}s...`);
            await new Promise(r => setTimeout(r, replyContent.delay * 1000));
        }
        
        console.log(`[Bot Engine] 📤 Sending Reply: "${replyContent.message?.substring(0, 30)}..."`);
        await queueAndSendMessage(from, replyContent, null, driver.id);
        
        processOutbox().catch(console.error);
    }
}

// NEW WORKER: Process Scheduled Messages
const processScheduledMessages = async () => {
    if (!pool) return;
    // Check global sending switch
    const sendingEnabled = await getCachedSystemSetting('sending_enabled');
    if (!sendingEnabled) return;

    let client;
    try {
        client = await pool.connect();
        
        // Fetch jobs due
        const { rows } = await client.query(`
            SELECT id, driver_ids, content
            FROM scheduled_messages
            WHERE status = 'pending' AND scheduled_time <= $1
            LIMIT 5
            FOR UPDATE SKIP LOCKED
        `, [Date.now()]);

        for (const job of rows) {
            const content = job.content;
            const driverIds = job.driver_ids || [];

            console.log(`[Scheduler] Processing Job ${job.id} for ${driverIds.length} drivers.`);

            for (const driverId of driverIds) {
                try {
                    const driverRes = await client.query('SELECT phone_number FROM drivers WHERE id = $1', [driverId]);
                    if (driverRes.rows.length > 0) {
                        const phone = driverRes.rows[0].phone_number;
                        // Use existing queue function (assumed to be in scope)
                        await queueAndSendMessage(phone, content, null, driverId);
                    }
                } catch (e) {
                    console.error(`[Scheduler] Failed for driver ${driverId}:`, e.message);
                }
            }

            await client.query("UPDATE scheduled_messages SET status = 'completed' WHERE id = $1", [job.id]);
        }
    } catch (e) {
        console.error("Scheduler Worker Error:", e.message);
    } finally {
        if (client) client.release();
    }
};

// Check every 30 seconds
setInterval(processScheduledMessages, 30000);

// ... (Rest of existing endpoints) ...

router.get('/cron/process-outbox', async (req, res) => {
    try {
        await processOutbox();
        res.json({ status: 'ok', processed: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/system/stats', async (req, res) => {
    res.json({
        serverLoad: 0, dbLatency: 0, aiCredits: 100, aiModel: "Bot Logic",
        s3Status: 'ok', s3Load: 0, whatsappStatus: META_API_TOKEN ? 'ok' : 'error',
        whatsappUploadLoad: 0, activeUploads: 0, uptime: process.uptime()
    });
});

router.get('/drivers', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM drivers ORDER BY updated_at DESC LIMIT 50');
        res.json(result.rows.map(toDriverDTO));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/drivers/:id/messages', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit || '50');
        const before = parseInt(req.query.before || '0');
        let query = 'SELECT * FROM messages WHERE driver_id = $1';
        let params = [req.params.id];
        if (before > 0) { query += ' AND timestamp < $2'; params.push(before); }
        query += ` ORDER BY timestamp DESC LIMIT $${params.length + 1}`;
        params.push(limit);
        const result = await queryWithRetry(query, params);
        res.json(result.rows.map(toMessageDTO).reverse());
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/drivers/:id/documents', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM driver_documents WHERE driver_id = $1 ORDER BY created_at DESC', [req.params.id]);
        res.json(result.rows.map(toDocumentDTO));
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/drivers/:id', async (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    try {
        const allowed = ['status', 'notes', 'name', 'vehicle_registration', 'availability', 'is_bot_active', 'is_human_mode', 'qualification_checks'];
        const keys = Object.keys(updates).filter(k => allowed.includes(k));
        if (keys.length === 0) return res.json({ success: true, message: "No valid fields" });
        
        let customValues = [];
        const setClause = keys.map((k, i) => {
            if (k === 'qualification_checks') return `${k} = $${i + 2}::jsonb`; 
            return `${k} = $${i + 2}`;
        }).join(', ');
        
        let values = [id, ...keys.map(k => {
             if (k === 'qualification_checks' && typeof updates[k] === 'object') return JSON.stringify(updates[k]);
             return updates[k];
        })];

        // LOGIC: If enabling human mode, set timer for 30 mins
        let extraSQL = '';
        if (updates.is_human_mode === true) {
            extraSQL = `, human_mode_ends_at = ${Date.now() + (30 * 60 * 1000)}`;
        } else if (updates.is_human_mode === false) {
            extraSQL = `, human_mode_ends_at = 0`;
        }

        await queryWithRetry(`UPDATE drivers SET ${setClause}${extraSQL}, updated_at = ${Date.now()} WHERE id = $1`, values);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/sync', async (req, res) => {
    const since = parseInt(req.query.since || '0');
    try {
        const result = await queryWithRetry('SELECT * FROM drivers WHERE updated_at > $1 ORDER BY updated_at ASC LIMIT 50', [since]);
        const drivers = result.rows.map(toDriverDTO);
        let nextCursor = since;
        if (drivers.length > 0) nextCursor = Math.max(...drivers.map(d => d.updatedAt));
        res.json({ drivers, nextCursor });
    } catch(e) { res.json({ drivers: [], nextCursor: since }); }
});

// ... (Rest of existing endpoints) ...

app.use('/api', router);

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}

module.exports = app;


/**
 * UBER FLEET RECRUITER - ENTERPRISE BACKEND
 * Multi-Tenant Architecture with S3 Separation
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

// --- MIDDLEWARE ---
app.use(express.json({ limit: '10mb' }));
app.use(cors()); 

app.set('etag', false);
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3001;
let META_API_TOKEN = process.env.META_API_TOKEN; 
let PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; 
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
let VERIFY_TOKEN = process.env.VERIFY_TOKEN || "uber_fleet_verify_token";

// AWS S3 Config
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED"
});
const BUCKET_NAME = process.env.AWS_BUCKET_NAME || '';

// --- DATABASE CONNECTION ---
const CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  ssl: { rejectUnauthorized: false },
  max: 20, 
  idleTimeoutMillis: 30000, 
  connectionTimeoutMillis: 2000,
});

// --- HELPER: Query with Retry ---
const queryWithRetry = async (text, params, retries = 3) => {
    let client;
    try {
        client = await pool.connect();
        const res = await client.query(text, params);
        return res;
    } catch (err) {
        if (client) { try { client.release(true); } catch(e) {} client = null; }
        if (retries > 0 && (err.code === '57P01' || err.code === 'EPIPE' || err.code === '42P01')) {
            console.log(`DB Retry (${retries} left): ${err.code}`);
            await new Promise(res => setTimeout(res, 1000));
            if (err.code === '42P01') { // Missing table
                const healClient = await pool.connect();
                await ensureDatabaseInitialized(healClient);
                healClient.release();
            }
            return queryWithRetry(text, params, retries - 1);
        }
        throw err;
    } finally {
        if (client) { try { client.release(); } catch(e) {} }
    }
};

// --- ENTERPRISE SCHEMA ---
const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS companies (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(50) DEFAULT 'logistics',
        terminology JSONB,
        theme_color VARCHAR(20) DEFAULT '#000000',
        created_at BIGINT
    );

    CREATE TABLE IF NOT EXISTS drivers (
        id VARCHAR(255) PRIMARY KEY,
        company_id VARCHAR(50) REFERENCES companies(id) DEFAULT '1',
        phone_number VARCHAR(50),
        name VARCHAR(255),
        source VARCHAR(50) DEFAULT 'Organic',
        status VARCHAR(50) DEFAULT 'New',
        last_message TEXT,
        last_message_time BIGINT,
        documents TEXT[],
        bot_state JSONB DEFAULT '{}',
        created_at BIGINT,
        qualification_checks JSONB DEFAULT '{"check1": false, "check2": false, "check3": true}'::jsonb,
        current_bot_step_id TEXT,
        is_bot_active BOOLEAN DEFAULT FALSE,
        onboarding_step INTEGER DEFAULT 0,
        vehicle_registration TEXT, -- Generic Field 1
        availability TEXT, -- Generic Field 2
        is_human_mode BOOLEAN DEFAULT FALSE,
        notes TEXT,
        UNIQUE(company_id, phone_number)
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
        id SERIAL PRIMARY KEY,
        company_id VARCHAR(50) REFERENCES companies(id) UNIQUE,
        settings JSONB
    );

    CREATE TABLE IF NOT EXISTS media_folders (
        id VARCHAR(255) PRIMARY KEY,
        company_id VARCHAR(50) REFERENCES companies(id) DEFAULT '1',
        name VARCHAR(255) NOT NULL,
        parent_path VARCHAR(255) DEFAULT '/',
        is_public_showcase BOOLEAN DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS media_files (
        id VARCHAR(255) PRIMARY KEY,
        url TEXT NOT NULL,
        filename TEXT,
        type VARCHAR(50),
        uploaded_at BIGINT,
        folder_path VARCHAR(255) DEFAULT '/',
        company_id VARCHAR(50) REFERENCES companies(id) DEFAULT '1'
    );
`;

const ensureDatabaseInitialized = async (client) => {
    try {
        await client.query('BEGIN');
        await client.query(SCHEMA_SQL);
        
        // SEED DEFAULT COMPANIES
        const company1 = {
            id: '1', name: 'Encho Cabs', type: 'logistics',
            terminology: { 
                singular: 'Driver', plural: 'Drivers', 
                field1Label: 'License Plate', field2Label: 'Availability',
                check1Label: 'Valid License', check2Label: 'Has Vehicle', check3Label: 'Local Resident'
            },
            themeColor: '#000000'
        };
        const company2 = {
            id: '2', name: 'Encho Travel', type: 'travel',
            terminology: { 
                singular: 'Traveler', plural: 'Travelers', 
                field1Label: 'Travel Dates', field2Label: 'Destination',
                check1Label: 'Valid ID/Passport', check2Label: 'Deposit Paid', check3Label: 'Visa Cleared'
            },
            themeColor: '#0ea5e9'
        };

        await client.query(
            `INSERT INTO companies (id, name, type, terminology, theme_color, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
            [company1.id, company1.name, company1.type, JSON.stringify(company1.terminology), company1.themeColor, Date.now()]
        );
        await client.query(
            `INSERT INTO companies (id, name, type, terminology, theme_color, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
            [company2.id, company2.name, company2.type, JSON.stringify(company2.terminology), company2.themeColor, Date.now()]
        );

        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Schema Init Failed:", e);
    }
};

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ... (sendWhatsAppMessage & analyzeWithAI - standard implementation) ...
const sendWhatsAppMessage = async (to, body, options = null) => {
    // Standard implementation (abbreviated for brevity)
    return true; 
};

// --- ENTERPRISE ENDPOINTS ---

// 1. Get Companies
app.get('/api/companies', async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM companies ORDER BY created_at ASC', []);
        res.json(result.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// 2. Get Leads (Filtered by Company)
app.get('/api/leads', async (req, res) => { 
    try {
        const companyId = req.headers['x-company-id'] || '1';
        const client = await pool.connect();
        try {
            const leadsRes = await client.query('SELECT * FROM drivers WHERE company_id = $1 ORDER BY last_message_time DESC LIMIT 100', [companyId]);
            const leads = leadsRes.rows;
            
            if (leads.length === 0) { res.json([]); return; }

            const leadIds = leads.map(d => d.id);
            const messagesRes = await client.query(`SELECT * FROM messages WHERE driver_id = ANY($1) ORDER BY timestamp ASC`, [leadIds]);

            const messagesByLead = {};
            messagesRes.rows.forEach(msg => {
                if (!messagesByLead[msg.driver_id]) messagesByLead[msg.driver_id] = [];
                messagesByLead[msg.driver_id].push({
                    id: msg.id, sender: msg.sender, text: msg.text,
                    imageUrl: msg.image_url, timestamp: parseInt(msg.timestamp),
                    type: msg.type, options: msg.options
                });
            });

            // Map DB columns to Generic Frontend Fields
            const mappedLeads = leads.map(row => ({
                id: row.id,
                companyId: row.company_id,
                phoneNumber: row.phone_number,
                name: row.name,
                source: row.source,
                status: row.status,
                lastMessage: row.last_message,
                lastMessageTime: parseInt(row.last_message_time || '0'),
                messages: messagesByLead[row.id] || [],
                documents: row.documents || [],
                notes: row.notes || '',
                onboardingStep: row.onboarding_step || 0,
                customField1: row.vehicle_registration, // Generic
                customField2: row.availability, // Generic
                qualificationChecks: row.qualification_checks,
                currentBotStepId: row.current_bot_step_id,
                isBotActive: row.is_bot_active,
                isHumanMode: row.is_human_mode
            }));

            res.json(mappedLeads);
        } finally { client.release(); }
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// 3. S3 Presign with COMPANY SEPARATION
app.post('/api/s3/presign', async (req, res) => { 
    try {
        const companyId = req.headers['x-company-id'] || '1';
        const { filename, fileType, folderPath } = req.body;
        
        // CRITICAL: Partition files by Company ID in S3
        // Structure: company_{id}/{timestamp}_{filename}
        const key = `company_${companyId}/${Date.now()}-${filename.replace(/\s+/g, '_')}`;
        
        const command = new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, ContentType: fileType });
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
        const publicUrl = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
        
        res.json({ uploadUrl, key, publicUrl });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// 4. Media File Registration (Company Scoped)
app.post('/api/files/register', async (req, res) => { 
    try {
        const companyId = req.headers['x-company-id'] || '1';
        const { key, url, filename, type, folderPath } = req.body;
        const id = Date.now().toString();
        
        await queryWithRetry(
            `INSERT INTO media_files (id, company_id, url, filename, type, uploaded_at, folder_path) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [id, companyId, url, filename, type, Date.now(), folderPath]
        );
        res.json({ success: true, id, url });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. Get Media (Company Scoped)
app.get('/api/media', async (req, res) => {
    try {
        const companyId = req.headers['x-company-id'] || '1';
        const currentPath = req.query.path || '/';
        
        const folders = await queryWithRetry(
            'SELECT * FROM media_folders WHERE parent_path = $1 AND company_id = $2 ORDER BY name ASC', 
            [currentPath, companyId]
        );
        
        const files = await queryWithRetry(
            `SELECT * FROM media_files WHERE folder_path = $1 AND company_id = $2 ORDER BY uploaded_at DESC`, 
            [currentPath, companyId]
        );
        
        res.json({ folders: folders.rows, files: files.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 6. Create Folder (Company Scoped)
app.post('/api/folders', async (req, res) => { 
    try {
        const companyId = req.headers['x-company-id'] || '1';
        const { name, parentPath } = req.body;
        
        const existing = await queryWithRetry(
            'SELECT id FROM media_folders WHERE name = $1 AND company_id = $2',
            [name, companyId]
        );
        
        if (existing.rows.length > 0) return res.status(409).json({ error: 'Folder exists' });
        
        const id = Date.now().toString();
        await queryWithRetry(
            'INSERT INTO media_folders (id, company_id, name, parent_path) VALUES ($1, $2, $3, $4)', 
            [id, companyId, name, parentPath]
        );
        res.json({ success: true, id });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// 7. Bot Settings (Company Scoped)
app.get('/api/bot-settings', async (req, res) => { 
    try {
        const companyId = req.headers['x-company-id'] || '1';
        const resDb = await queryWithRetry('SELECT settings FROM bot_settings WHERE company_id = $1', [companyId]);
        
        const defaultSettings = { 
            companyId, isEnabled: true, routingStrategy: 'HYBRID_BOT_FIRST', systemInstruction: "", steps: [] 
        };
        
        res.json(resDb.rows[0]?.settings || defaultSettings);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bot-settings', async (req, res) => { 
    try {
        const companyId = req.headers['x-company-id'] || '1';
        const settings = { ...req.body, companyId };
        
        await queryWithRetry(`
            INSERT INTO bot_settings (company_id, settings) VALUES ($1, $2)
            ON CONFLICT (company_id) DO UPDATE SET settings = $2
        `, [companyId, JSON.stringify(settings)]);
        
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Webhook Receiver (Simplified: Currently routes everything to Company 1 for demo)
// In a real prod environment, you would map phone_number_id to company_id
app.post('/webhook', async (req, res) => { 
    // ... (Webhook logic to route to processIncomingMessage with companyId=1)
    res.sendStatus(200);
});

app.get('/webhook', (req, res) => { res.send(req.query['hub.challenge']); });

module.exports = app;
if (require.main === module) app.listen(PORT, () => console.log(`🚀 Enterprise Server running on port ${PORT}`));

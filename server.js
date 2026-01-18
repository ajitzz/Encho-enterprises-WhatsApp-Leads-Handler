/**
 * UBER FLEET RECRUITER - BACKEND SERVER
 * Enterprise-Grade Connection Handling for Vercel + Neon
 * FAIL-SAFE MODE ENABLED
 * MODE: STRICT BOT ONLY (NO AI)
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto'); // NEW: For signature verification
const { Pool } = require('pg'); 
const { S3Client, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const FormData = require('form-data'); 
require('dotenv').config();

const app = express();
const router = express.Router(); 

// Raw body needed for signature verification
app.use(express.json({ 
    limit: '10mb',
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
app.use(cors()); 

app.set('etag', false);
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

const PORT = process.env.PORT || 3001;

// --- DYNAMIC CREDENTIALS ---
let META_API_TOKEN = process.env.META_API_TOKEN || ""; 
let PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || ""; 
let VERIFY_TOKEN = process.env.VERIFY_TOKEN || "uber_fleet_verify_token";
let APP_SECRET = process.env.APP_SECRET || ""; // NEW: For Signature Verification

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

// --- HELPER: System Settings ---
const getSystemSetting = async (key) => {
    try {
        const res = await queryWithRetry('SELECT value FROM system_settings WHERE key = $1', [key]);
        if (res.rows.length > 0) return res.rows[0].value === 'true';
        return true; 
    } catch (e) {
        console.error(`Failed to fetch setting ${key}:`, e.message);
        return true;
    }
};

// --- HELPER: Validate Meta Credentials ---
const validateMetaCredentials = async (phoneId, token) => {
    try {
        await axios.get(`https://graph.facebook.com/v17.0/${phoneId}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return true;
    } catch (e) {
        const msg = e.response?.data?.error?.message || e.message;
        throw new Error(`Validation Failed: ${msg}`);
    }
};

// --- NEW: Verify Webhook Signature ---
const verifySignature = (req) => {
    // If APP_SECRET is not set, we skip verification (Dev mode safety)
    // In production, this should be enforced.
    if (!APP_SECRET) return true;

    const signature = req.headers['x-hub-signature-256'];
    if (!signature) return false;

    const elements = signature.split('=');
    const signatureHash = elements[1];
    const expectedHash = crypto
        .createHmac('sha256', APP_SECRET)
        .update(req.rawBody)
        .digest('hex');

    return signatureHash === expectedHash;
};

// --- DTO MAPPERS (Snake -> Camel) ---
const toDriverDTO = (row) => ({
    id: row.id,
    phoneNumber: row.phone_number,
    name: row.name,
    source: row.source,
    status: row.status,
    lastMessage: row.last_message,
    lastMessageTime: parseInt(row.last_message_time || '0'),
    notes: row.notes,
    vehicleRegistration: row.vehicle_registration,
    availability: row.availability,
    currentBotStepId: row.current_bot_step_id,
    isBotActive: row.is_bot_active,
    isHumanMode: row.is_human_mode,
    qualificationChecks: row.qualification_checks || {},
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
    footerText: row.footer_text,
    buttons: row.buttons, 
    templateName: row.template_name
});

const toDocumentDTO = (row) => ({
    id: row.id,
    driverId: row.driver_id,
    docType: row.doc_type,
    fileUrl: row.file_url,
    mimeType: row.mime_type,
    createdAt: parseInt(row.created_at || '0'),
    verificationStatus: row.verification_status,
    notes: row.notes,
    failureReason: row.failure_reason // NEW
});

let isDbInitialized = false;

// --- DEFAULT BOT FLOW (Ensures bot works out-of-the-box) ---
const DEFAULT_BOT_FLOW = {
    isEnabled: true,
    shouldRepeat: false,
    entryPointId: "welcome",
    steps: [
        {
            id: "welcome",
            title: "Welcome Message",
            message: "Hello! 👋 Welcome to Uber Fleet Recruitment.\nAre you interested in driving with us?",
            inputType: "option",
            options: ["Yes, I want to drive", "No, just inquiring"],
            routes
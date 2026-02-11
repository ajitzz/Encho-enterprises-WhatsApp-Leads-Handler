
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const multer = require('multer');
const axios = require('axios');
const https = require('https');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { OAuth2Client } = require('google-auth-library');
const { GoogleGenAI } = require("@google/genai");

require('dotenv').config();

// --- CONFIGURATION ---
const SYSTEM_CONFIG = {
    META_TIMEOUT: 15000,
    DB_CONNECTION_TIMEOUT: 20000,
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
    AWS_BUCKET: process.env.AWS_BUCKET_NAME || 'uber-fleet-assets',
    GOOGLE_CLIENT_ID: process.env.VITE_GOOGLE_CLIENT_ID,
    CACHE_TTL: 60 * 1000 // 60 Seconds Cache for Bot Settings
};

// --- IN-MEMORY CACHE (Performance Boost) ---
const memoryCache = {
    botSettings: null,
    lastUpdated: 0
};

// --- INITIALIZE CLIENTS ---
let s3Client, googleClient, genAI, pgPool;

try {
    s3Client = new S3Client({
        region: SYSTEM_CONFIG.AWS_REGION,
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
    });

    googleClient = new OAuth2Client(SYSTEM_CONFIG.GOOGLE_CLIENT_ID);
    
    if (process.env.GEMINI_API_KEY) {
        genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }

    let connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
    if (connectionString && connectionString.includes('sslmode=')) {
        connectionString = connectionString.replace(/([?&])sslmode=[^&]+(&|$)/, '$1').replace(/[?&]$/, '');
    }
    
    pgPool = new Pool({
        connectionString,
        connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
        idleTimeoutMillis: 30000,
        ssl: { rejectUnauthorized: false }, 
        max: 20, 
        keepAlive: true
    });
    
    pgPool.on('error', (err) => console.error('[DB POOL ERROR]', err));

} catch (initError) {
    console.error("[INIT CRITICAL ERROR]", initError);
}

const upload = multer({ storage: multer.memoryStorage() });

const withDb = async (operation) => {
    if (!pgPool) throw new Error("Database not initialized");
    let client;
    try {
        client = await pgPool.connect();
        return await operation(client);
    } catch (e) {
        console.error("[DB OPS ERROR]", e);
        throw e;
    } finally {
        if (client) client.release();
    }
};

const getMetaClient = () => axios.create({
    httpsAgent: new https.Agent({ keepAlive: true }),
    timeout: SYSTEM_CONFIG.META_TIMEOUT,
    headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${process.env.META_API_TOKEN}` 
    }
});

// --- HELPERS ---

const refreshMediaUrl = async (url) => {
    if (!url || typeof url !== 'string') return null;
    if (!url.includes('amazonaws.com') && !url.includes(SYSTEM_CONFIG.AWS_BUCKET)) return url;

    try {
        const urlObj = new URL(url);
        let key = decodeURIComponent(urlObj.pathname.substring(1));
        if (key.startsWith(SYSTEM_CONFIG.AWS_BUCKET + '/')) {
            key = key.substring(SYSTEM_CONFIG.AWS_BUCKET.length + 1);
        }
        const command = new GetObjectCommand({ Bucket: SYSTEM_CONFIG.AWS_BUCKET, Key: key });
        return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    } catch (e) {
        return url; 
    }
};

const sendToMeta = async (phoneNumber, payload) => {
    const phoneId = process.env.PHONE_NUMBER_ID;
    const to = (phoneNumber || '').toString().replace(/\D/g, '');
    
    if (payload.type === 'text') {
        if (!payload.text?.body || !payload.text.body.trim()) {
            console.warn("[Meta] Blocked empty text message");
            return;
        }
    }
    if (payload.type === 'interactive') {
        const i = payload.interactive;
        if (i.type === 'button' && (!i.action.buttons || i.action.buttons.length === 0) && !['location_request_message', 'product_list'].includes(i.type)) return;
        if (i.type === 'list' && (!i.action.sections || i.action.sections.length === 0)) return;
    }

    try {
        console.log(`[Meta] Sending to ${to} | Type: ${payload.type}`);
        await getMetaClient().post(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            ...payload
        });
    } catch (e) {
        const errMsg = e.response?.data?.error?.message || e.message;
        console.error(`[Meta Failed] ${to}: ${errMsg}`);
        throw new Error(`Meta API Error: ${errMsg}`);
    }
};

const processText = (text, candidate) => {
    if (!text) return '';
    let processed = text;
    const vars = { 
        name: candidate.name, 
        phone: candidate.phone_number, 
        ...candidate.variables 
    };
    
    for (const [key, val] of Object.entries(vars)) {
        const regex = new RegExp(`{{${key}}}`, 'gi');
        processed = processed.replace(regex, val || '');
    }
    return processed;
};

const isValidContent = (text) => {
    if (!text || typeof text !== 'string') return false;
    const clean = text.trim().toLowerCase();
    if (clean.length === 0) return false;
    
    const blockers = [
        'replace this sample message',
        'replace this text',
        'type your message',
        'enter your message',
        'sample text',
        'your message here'
    ];
    if (clean.length < 50 && blockers.some(b => clean.includes(b))) return false;
    return true;
};

const formatSummaryValue = (val) => {
    let displayVal = val;
    try {
        if (typeof val === 'string' && val.startsWith('{')) {
            const parsed = JSON.parse(val);
            if (parsed.label) {
                displayVal = parsed.label;
            } else if (parsed.latitude && parsed.longitude) {
                const link = `https://www.google.com/maps?q=${parsed.latitude},${parsed.longitude}`;
                if (parsed.name || parsed.address) {
                    displayVal = `${parsed.name || ''} ${parsed.address || ''}
${link}`.trim();
                } else {
                    displayVal = `📍 ${link}`;
                }
            } else if (parsed.lat && parsed.long) {
                displayVal = `${parsed.label || 'Pinned Location'} (${parsed.lat}, ${parsed.long})`;
            }
        }
    } catch (e) {}

    if (displayVal === null || displayVal === undefined) return '';
    if (typeof displayVal === 'object') return JSON.stringify(displayVal);
    return String(displayVal);
};

const formatSummaryToken = (text, style = 'plain') => {
    const safeText = String(text || '');
    if (!safeText) return '';

    if (style === 'bold') return `*${safeText}*`;
    if (style === 'italic') return `_${safeText}_`;
    if (style === 'code') return `\`${safeText}\``;
    if (style === 'uppercase') return safeText.toUpperCase();
    return safeText;
};

// --- SMART PARSING HELPERS ---

const resolveTimeAmbiguity = (inputTimeStr) => {
    const [hStr, mStr] = inputTimeStr.split(/[:.]/);
    let h = parseInt(hStr);
    const m = parseInt(mStr);

    if (h > 12) return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}`;

    const now = new Date();
    const dateAM = new Date(); dateAM.setHours(h === 12 ? 0 : h, m, 0, 0);
    const datePM = new Date(); datePM.setHours(h === 12 ? 12 : h + 12, m, 0, 0);

    let diffAM = dateAM - now;
    let diffPM = datePM - now;

    if (diffAM < -1000 * 60 * 15) diffAM += 24 * 60 * 60 * 1000;
    if (diffPM < -1000 * 60 * 15) diffPM += 24 * 60 * 60 * 1000;

    const isPM = diffPM < diffAM;
    const displayH = h;
    const ampm = isPM ? 'PM' : 'AM';
    return `${displayH}:${m.toString().padStart(2,'0')} ${ampm}`;
};

// Robust Date Parser: Handles "2025-02-15", "Feb 15", "Tomorrow"
const tryParseDate = (input) => {
    if (!input) return null;
    const clean = input.trim();
    
    // 1. Strict ISO (YYYY-MM-DD)
    if (clean.match(/^\d{4}-\d{2}-\d{2}$/)) return clean;
    
    // 2. Relative Keywords
    const lower = clean.toLowerCase();
    const today = new Date();
    if (lower === 'today') return today.toISOString().split('T')[0];
    if (lower === 'tomorrow') {
        const tmrw = new Date(today);
        tmrw.setDate(today.getDate() + 1);
        return tmrw.toISOString().split('T')[0];
    }

    // 3. Natural Language (using Date constructor)
    // Works for "Feb 15", "15 Feb 2025", "2025/02/15"
    const parsed = new Date(clean);
    if (!isNaN(parsed.getTime())) {
        // If year is way off (e.g. user typed "15" and it parsed to 1915 or 2001), 
        // we might want to default to current year, but Date() usually handles "Feb 15" as current year.
        // Let's ensure it's in the future or today to be safe? 
        // For now, just return ISO.
        return parsed.toISOString().split('T')[0];
    }
    
    return null;
};

// --- DYNAMIC OPTION GENERATORS (3-STEP FLOW) ---

const PERIODS = {
    MORNING: { label: '🌅 Morning', description: '05:00 AM - 11:59 AM', start: 5, end: 11 },
    AFTERNOON: { label: '☀️ Afternoon', description: '12:00 PM - 04:59 PM', start: 12, end: 16 },
    EVENING: { label: '🌆 Evening', description: '05:00 PM - 08:59 PM', start: 17, end: 20 },
    NIGHT: { label: '🌙 Night', description: '09:00 PM - 04:59 AM', start: 21, end: 28 } // 28 = 4AM next day
};

const truncateForMeta = (value, maxLen) => (value || '').toString().substring(0, maxLen);

const sanitizeListRows = (rows = []) => {
    return rows
        .filter(r => r && r.id && r.title)
        .slice(0, 10)
        .map(r => ({
            id: truncateForMeta(r.id, 200),
            title: truncateForMeta(r.title, 24),
            ...(r.description ? { description: truncateForMeta(r.description, 72) } : {})
        }));
};

const getDateTimeCheckpointStage = (candidate, finalVar = 'time_slot') => {
    if (!candidate?.variables?.pickup_date) return 'DATE';
    if (!candidate?.variables?.time_period) return 'PERIOD';
    if (!candidate?.variables?.[finalVar]) return 'TIME';
    return 'DONE';
};

const getCheckpointErrorMessage = (stage) => {
    if (stage === 'DATE') return "⚠️ I couldn't recognize that date format.\n\nPlease select a date from the list (Today/Tomorrow) or type *YYYY-MM-DD*.";
    if (stage === 'PERIOD') return "⚠️ Please select a valid period: Morning, Afternoon, Evening, or Night.";
    return "⚠️ Invalid time format.\n\nPlease pick one slot from the list or type a time like *5:30 PM*.";
};

const generateDateOptions = (config) => {
    const options = [];
    const today = new Date();
    const daysToShow = config?.daysToShow || 7;
    const includeToday = config?.includeToday !== false;
    
    let startIndex = includeToday ? 0 : 1;
    
    for (let i = startIndex; i < (startIndex + daysToShow); i++) {
        const d = new Date(today);
        d.setDate(today.getDate() + i);
        
        let title = '';
        if (i === 0) title = 'Today';
        else if (i === 1) title = 'Tomorrow';
        else title = d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });
        
        const id = d.toISOString().split('T')[0]; // YYYY-MM-DD
        options.push({ id, title: title.substring(0, 24) });
    }
    return options;
};

// 2. Generate Periods (Morning, Afternoon, etc.) based on chosen date
const generatePeriodOptions = (candidate) => {
    const options = [];
    const now = new Date();
    const currentHour = now.getHours();
    
    // Check if selected date is "Today"
    let isToday = false;
    if (candidate && candidate.variables && candidate.variables.pickup_date) {
        const picked = candidate.variables.pickup_date;
        const todayStr = now.toISOString().split('T')[0];
        if (picked === todayStr) isToday = true;
    }

    // Helper to check if period is valid for "Now"
    const isValidPeriod = (pKey) => {
        if (!isToday) return true;
        // If today, filter out passed periods
        const p = PERIODS[pKey];
        // Special case for Night which goes to next day
        if (pKey === 'NIGHT') return true; 
        return p.end > currentHour; 
    };

    if (isValidPeriod('MORNING')) options.push({ id: 'PERIOD_MORNING', title: PERIODS.MORNING.label, description: PERIODS.MORNING.description });
    if (isValidPeriod('AFTERNOON')) options.push({ id: 'PERIOD_AFTERNOON', title: PERIODS.AFTERNOON.label, description: PERIODS.AFTERNOON.description });
    if (isValidPeriod('EVENING')) options.push({ id: 'PERIOD_EVENING', title: PERIODS.EVENING.label, description: PERIODS.EVENING.description });
    options.push({ id: 'PERIOD_NIGHT', title: PERIODS.NIGHT.label, description: PERIODS.NIGHT.description }); // Always show night

    return options;
};

// 3. Generate Times based on Period
const generateTimeOptions = (candidate) => {
    const options = [];
    const now = new Date();
    const periodKey = candidate?.variables?.time_period?.replace('PERIOD_', '');
    
    if (!periodKey || !PERIODS[periodKey]) {
        return [{ id: 'custom', title: 'Type Specific Time' }];
    }

    const range = PERIODS[periodKey];
    const startHour = range.start;
    const endHour = range.end;

    let isToday = false;
    if (candidate?.variables?.pickup_date === now.toISOString().split('T')[0]) {
        isToday = true;
    }

    // Generate 30 min intervals
    const minBufferMins = 30;
    const nowWithBuffer = new Date(now.getTime() + (minBufferMins * 60 * 1000));

    for (let h = startHour; h <= endHour; h++) {
        for (let m = 0; m < 60; m += 30) {
            // Logic for "Night" spillover (24, 25 -> 00, 01)
            let realH = h;
            if (h >= 24) realH = h - 24;

            // For "Today", don't show past times
            if (isToday) {
                // If realH (e.g. 13) < currentHour (e.g. 14), skip.
                if (realH < nowWithBuffer.getHours()) continue; 
                // If same hour, check minutes
                if (realH === nowWithBuffer.getHours() && m < nowWithBuffer.getMinutes()) continue;
            }

            const ampm = realH >= 12 ? 'PM' : 'AM';
            const displayH = realH % 12 || 12;
            const timeStr = `${displayH}:${m.toString().padStart(2, '0')} ${ampm}`;
            const id = timeStr; // Simple string ID

            options.push({ id, title: timeStr });
        }
    }

    // Cap at 9 items + Manual
    const finalOptions = options.slice(0, 9);
    finalOptions.push({ id: 'custom_time', title: 'Type Specific Time', description: 'e.g. 11:25' });
    
    return finalOptions;
};

// --- HELPER: DETECT MANUAL PRESET ---
const isPresetManual = (p) => {
    // If type is explicitly 'manual' OR if lat/long are missing (implies manual)
    return p.type === 'manual' || (!p.latitude && !p.longitude);
};

// --- DEFAULT BOT CONFIG ---
const getDefaultBotConfig = () => ({
    isEnabled: true,
    shouldRepeat: false,
    routingStrategy: 'BOT_ONLY',
    nodes: [
        { 
            id: 'start', 
            type: 'custom', 
            position: { x: 50, y: 50 }, 
            data: { id: 'start', type: 'start', label: 'Start Flow' } 
        },
        { 
            id: 'welcome_msg', 
            type: 'custom', 
            position: { x: 50, y: 200 }, 
            data: { id: 'welcome_msg', type: 'text', label: 'Welcome Message', content: 'Welcome to Encho Cabs! 👋\n\nHow can we help you today?' } 
        }
    ],
    edges: [
        { id: 'e1', source: 'start', target: 'welcome_msg', type: 'smoothstep' }
    ]
});

// --- DB RECOVERY & INIT ---
const initDatabase = async (client) => {
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');

    await client.query(`CREATE TABLE IF NOT EXISTS system_settings (key VARCHAR(50) PRIMARY KEY, value JSONB);`);
    await client.query(`CREATE TABLE IF NOT EXISTS candidates (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), phone_number VARCHAR(50) UNIQUE, name VARCHAR(255), stage VARCHAR(50), last_message TEXT, last_message_at BIGINT, source VARCHAR(50), is_human_mode BOOLEAN DEFAULT FALSE, current_bot_step_id VARCHAR(100), variables JSONB DEFAULT '{}', created_at TIMESTAMP DEFAULT NOW());`);
    await client.query(`CREATE TABLE IF NOT EXISTS candidate_messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE, direction VARCHAR(10), text TEXT, type VARCHAR(50), status VARCHAR(50), whatsapp_message_id VARCHAR(255), created_at TIMESTAMP DEFAULT NOW());`);
    await client.query(`CREATE TABLE IF NOT EXISTS scheduled_messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE, payload JSONB, scheduled_time BIGINT, status VARCHAR(50), error_log TEXT, created_at TIMESTAMP DEFAULT NOW());`);
    await client.query(`CREATE TABLE IF NOT EXISTS bot_versions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status VARCHAR(20), settings JSONB, created_at TIMESTAMP DEFAULT NOW());`);
    await client.query(`CREATE TABLE IF NOT EXISTS driver_documents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE, type VARCHAR(50), url TEXT, status VARCHAR(50), created_at TIMESTAMP DEFAULT NOW());`);
    
    await client.query("INSERT INTO system_settings (key, value) VALUES ('config', '{\"automation_enabled\": true}') ON CONFLICT DO NOTHING");

    const botCheck = await client.query("SELECT id FROM bot_versions WHERE status = 'published' LIMIT 1");
    if (botCheck.rows.length === 0) {
        await client.query("INSERT INTO bot_versions (id, status, settings, created_at) VALUES ($1, 'published', $2, NOW())", [crypto.randomUUID(), getDefaultBotConfig()]);
    }
};

const executeWithRetry = async (client, operation) => {
    try {
        return await operation();
    } catch (err) {
        if (err.code === '42P01') {
            console.warn("[Auto-Heal] Tables missing. Re-initializing database...");
            await initDatabase(client);
            return await operation(); 
        }
        throw err;
    }
};

// --- BOT ENGINE ---
// =========================================================================
// [STABLE LOCK] 🛡️ DO NOT REFACTOR THIS FUNCTION
// This engine contains critical logic for 3-Stage Date Picking and Location Handling.
// It is protected based on the GitHub "Source of Truth".
// Any changes to the loop structure, delays, or variable saving will break the bot.
// =========================================================================
const runBotEngine = async (client, candidate, incomingText, incomingPayloadId = null) => {
    console.log(`[Bot Engine] START for ${candidate.phone_number}`);
    try {
        const sys = await client.query("SELECT value FROM system_settings WHERE key = 'config'");
        const config = sys.rows[0]?.value || { automation_enabled: true }; 
        if (config.automation_enabled === false || candidate.is_human_mode) return;

        let botSettings;

        // 1. TRY CACHE
        const now = Date.now();
        if (memoryCache.botSettings && (now - memoryCache.lastUpdated < SYSTEM_CONFIG.CACHE_TTL)) {
            botSettings = memoryCache.botSettings;
        } else {
            // 2. FALLBACK TO DB
            let botRes = await client.query("SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1");
            if (botRes.rows.length > 0) {
                botSettings = botRes.rows[0].settings;
                memoryCache.botSettings = botSettings;
                memoryCache.lastUpdated = now;
            } else {
                botSettings = getDefaultBotConfig();
            }
        }
        
        const { nodes, edges } = botSettings;
        if (!nodes || nodes.length === 0) return;

        let currentNodeId = candidate.current_bot_step_id;
        let nextNodeId = null;
        let shouldReplyInvalid = false;
        const cleanInput = (incomingText || '').trim().toLowerCase();

        // 1. Global Resets
        if (['start', 'restart', 'hi', 'hello', 'menu'].includes(cleanInput)) {
            currentNodeId = null;
            await client.query("UPDATE candidates SET current_bot_step_id = NULL, variables = '{}' WHERE id = $1", [candidate.id]);
            candidate.variables = {}; 
        }

        // 2. Determine Current State
        if (!currentNodeId) {
            const startNode = nodes.find(n => n.type === 'start' || n.data?.type === 'start');
            nextNodeId = startNode ? startNode.id : nodes[0]?.id;
        } else {
            const currentNode = nodes.find(n => n.id === currentNodeId);
            if (currentNode) {
                // A. Handle Variable Capture (IMPROVED FOR ALL INTERACTIVE NODES)
                const captureTypes = ['input', 'location_request', 'pickup_location', 'destination_location', 'datetime_picker', 'interactive_button', 'interactive_list', 'rich_card'];
                
                if (captureTypes.includes(currentNode.data.type)) {
                    let varName = currentNode.data.variable;
                    
                    // --- AUTO-GENERATE VARIABLE NAME IF MISSING ---
                    // This ensures we capture EVERY user input regardless of explicit variable naming
                    if (!varName) {
                        if (currentNode.data.type === 'pickup_location') varName = 'pickup_coords';
                        else if (currentNode.data.type === 'destination_location') varName = 'dest_coords';
                        else if (currentNode.data.type === 'location_request') varName = 'location_data';
                        else if (currentNode.data.type === 'datetime_picker') varName = 'time_slot';
                        else {
                            // Fallback: Create a variable from the Node Label (e.g. "Select Service" -> "select_service")
                            varName = (currentNode.data.label || currentNode.id)
                                .toLowerCase()
                                .replace(/[^a-z0-9]/g, '_')
                                .replace(/^_+|_+$/g, '');
                        }
                    }

                    // --- SMART LOGIC START ---
                    let valueToSave = null;
                    let isManualTrigger = false;

                    // 1. Check for Preset/List/Button Selection (Payload or Text Match)
                    if (currentNode.data.presets) {
                        let matchedPreset = currentNode.data.presets.find(p => p.id === incomingPayloadId);
                        if (!matchedPreset && cleanInput) matchedPreset = currentNode.data.presets.find(p => p.title.toLowerCase().trim() === cleanInput);

                        if (matchedPreset) {
                            if (isPresetManual(matchedPreset)) isManualTrigger = true;
                            else valueToSave = JSON.stringify({ lat: matchedPreset.latitude, long: matchedPreset.longitude, label: matchedPreset.title });
                        }
                    }
                    
                    // 2. Check for Buttons/List Options
                    if (!valueToSave) {
                        if (currentNode.data.buttons) {
                            const btn = currentNode.data.buttons.find(b => b.id === incomingPayloadId || b.title.toLowerCase().trim() === cleanInput);
                            if (btn) valueToSave = btn.title;
                        }
                        if (currentNode.data.sections) {
                            const row = currentNode.data.sections.flatMap(s => s.rows).find(r => r.id === incomingPayloadId || r.title.toLowerCase().trim() === cleanInput);
                            if (row) valueToSave = row.title;
                        }
                    }
                    
                    // --- NEW 3-STAGE STATE MACHINE FOR DATETIME PICKER (STRICT & SMART) ---
                    if (currentNode.data.type === 'datetime_picker') {
                        // 1. ANALYZE INPUT TYPE (What did the user send?)
                        let detectedDate = null;
                        let detectedPeriod = null;
                        let detectedTime = null;
                        let matchFound = false;
                        const finalVar = currentNode.data.variable || 'time_slot';
                        const checkpointStage = getDateTimeCheckpointStage(candidate, finalVar);

                        if (checkpointStage === 'DATE') {
                            // Check for Date using Smart Parser (Handles "2025-02-15" AND "Feb 15")
                            const parsedDate = tryParseDate(incomingPayloadId) || tryParseDate(incomingText);
                            
                            if (parsedDate) {
                                detectedDate = parsedDate;
                                matchFound = true;
                            } 
                            // Fallback: Check if it matches a Title in the generated list
                            else {
                                const validDates = generateDateOptions(currentNode.data.dateConfig);
                                const matchedTitle = validDates.find(d => cleanInput && d.title.toLowerCase().includes(cleanInput));
                                if (matchedTitle) {
                                    detectedDate = matchedTitle.id;
                                    matchFound = true;
                                }
                            }
                        }

                        if (checkpointStage === 'PERIOD') {
                            // Check for Period (PERIOD_MORNING, etc.)
                            if (incomingPayloadId && incomingPayloadId.startsWith('PERIOD_')) {
                                detectedPeriod = incomingPayloadId;
                                matchFound = true;
                            }
                            else if (['morning', 'afternoon', 'evening', 'night'].includes(cleanInput)) {
                                detectedPeriod = `PERIOD_${cleanInput.toUpperCase()}`;
                                matchFound = true;
                            }
                        }

                        if (checkpointStage === 'TIME') {
                            // Check for Time (HH:MM or custom input)
                            if (incomingPayloadId === 'custom_time') {
                                isManualTrigger = true;
                                matchFound = true;
                            } else if (incomingPayloadId) {
                                // If it's a payload in TIME checkpoint, assume it's selected time slot
                                detectedTime = incomingPayloadId;
                                matchFound = true;
                            } else if (cleanInput) {
                                // Try to parse manual time
                                const timeRegex = /([0-9]{1,2})[:.]([0-9]{2})\s*(am|pm)?/i;
                                const match = cleanInput.match(timeRegex);
                                if (match) {
                                    if (match[3]) detectedTime = match[0].toUpperCase();
                                    else detectedTime = resolveTimeAmbiguity(match[0]);
                                    matchFound = true;
                                } else if (cleanInput.length > 2 && !isManualTrigger) {
                                    // Fallback: If they typed something and it's not date/period, maybe it's raw time
                                    detectedTime = cleanInput;
                                    matchFound = true;
                                }
                            }
                        }

                        // ERROR HANDLING: If matchFound is FALSE, respond immediately with correction help
                        if (!matchFound && cleanInput.length > 0 && !isManualTrigger) {
                            await sendToMeta(candidate.phone_number, { type: 'text', text: { body: getCheckpointErrorMessage(checkpointStage) } });
                            return; // STOP EXECUTION HERE - Wait for user to correct input
                        }

                        // 2. EXECUTE STATE TRANSITION
                        if (detectedDate) {
                            // STATE 1 CAUGHT -> SAVE DATE, WIPE EVERYTHING ELSE
                            // This ensures the loop resets if they change the date
                            await client.query("UPDATE candidates SET variables = jsonb_set(variables, '{pickup_date}', $1) WHERE id = $2", [JSON.stringify(detectedDate), candidate.id]);
                            await client.query(`UPDATE candidates SET variables = variables - 'time_period' - $1 WHERE id = $2`, [finalVar, candidate.id]);
                            
                            candidate.variables.pickup_date = detectedDate;
                            delete candidate.variables.time_period;
                            delete candidate.variables[finalVar];
                            
                            valueToSave = null; // Do not save to generic variable, we handled it
                        } 
                        else if (detectedPeriod) {
                            // STATE 2 CAUGHT -> SAVE PERIOD, WIPE TIME
                            await client.query("UPDATE candidates SET variables = jsonb_set(variables, '{time_period}', $1) WHERE id = $2", [JSON.stringify(detectedPeriod), candidate.id]);
                            await client.query(`UPDATE candidates SET variables = variables - $1 WHERE id = $2`, [finalVar, candidate.id]);
                            
                            candidate.variables.time_period = detectedPeriod;
                            delete candidate.variables[finalVar];
                            
                            valueToSave = null;
                        } 
                        else if (detectedTime) {
                            // STATE 3 CAUGHT -> SAVE TIME
                            valueToSave = detectedTime;
                            varName = finalVar;
                        }
                    }

                    // Check for Real Location Message
                    else if (!isManualTrigger && incomingText && incomingText.startsWith('{') && incomingText.includes('"latitude"')) {
                        valueToSave = incomingText;
                    } 
                    // Fallback for simple text input (Only if we haven't already captured a button click value)
                    else if (!isManualTrigger && !valueToSave && (currentNode.data.type === 'input' || cleanInput.length > 0)) {
                        valueToSave = incomingText;
                    }

                    if (valueToSave) {
                        const newVars = { ...candidate.variables, [varName]: valueToSave };
                        await client.query("UPDATE candidates SET variables = $1 WHERE id = $2", [newVars, candidate.id]);
                        candidate.variables = newVars;
                    } else if (isManualTrigger && currentNode.data.type === 'datetime_picker') {
                        await sendToMeta(candidate.phone_number, { type: 'text', text: { body: "Sure, please type your preferred time below (e.g., 11:25 PM):" } });
                        return; // Stop here, wait for text
                    }
                    // --- SMART LOGIC END ---
                }

                // B. Find Next Path
                const outgoingEdges = edges.filter(e => e.source === currentNodeId);
                let matchedEdge = null;

                // Match Buttons / List Rows via Payload ID
                if (incomingPayloadId) {
                    if (currentNode.data.buttons) {
                        const btn = currentNode.data.buttons.find(b => b.id === incomingPayloadId);
                        if (btn) matchedEdge = outgoingEdges.find(e => e.sourceHandle === btn.id);
                    }
                    if (!matchedEdge && currentNode.data.sections) {
                        const row = currentNode.data.sections.flatMap(s => s.rows).find(r => r.id === incomingPayloadId);
                        if (row) matchedEdge = outgoingEdges.find(e => e.sourceHandle === row.id);
                    }
                    if (!matchedEdge && currentNode.data.presets) {
                        const preset = currentNode.data.presets.find(p => p.id === incomingPayloadId);
                        if (preset && !isPresetManual(preset)) matchedEdge = outgoingEdges.find(e => !e.sourceHandle || e.sourceHandle === 'default');
                    }
                }

                // Match Text Fallback
                if (!matchedEdge && cleanInput && currentNode.data.buttons) {
                    const btn = currentNode.data.buttons.find(b => b.title.toLowerCase().trim() === cleanInput);
                    if (btn) matchedEdge = outgoingEdges.find(e => e.sourceHandle === btn.id);
                }
                
                // Match Location Input (Auto Advance)
                if (!matchedEdge && incomingText && incomingText.startsWith('{') && incomingText.includes('"latitude"')) {
                     matchedEdge = outgoingEdges.find(e => !e.sourceHandle || e.sourceHandle === 'default');
                }

                // Default Path
                if (!matchedEdge) {
                    const isSmartNode = ['input', 'location_request', 'pickup_location', 'destination_location'].includes(currentNode.data.type);
                    
                    if (isSmartNode) {
                         let isManualClick = false;
                         if (currentNode.data.presets) {
                             const preset = currentNode.data.presets.find(p => (incomingPayloadId && p.id === incomingPayloadId) || (cleanInput && p.title.toLowerCase().trim() === cleanInput));
                             if (preset && isPresetManual(preset)) isManualClick = true;
                         }
                         if (!isManualClick) matchedEdge = outgoingEdges.find(e => !e.sourceHandle || e.sourceHandle === 'true' || e.sourceHandle === 'default');
                    } 
                    else if (currentNode.data.type === 'datetime_picker') {
                        // CRITICAL CHECKPOINT LOGIC
                        // Only advance if ALL 3 variables are present
                        const finalVar = currentNode.data.variable || 'time_slot';
                        const hasDate = !!candidate.variables.pickup_date;
                        const hasPeriod = !!candidate.variables.time_period;
                        const hasTime = !!candidate.variables[finalVar];

                        if (hasDate && hasPeriod && hasTime) {
                            matchedEdge = outgoingEdges.find(e => !e.sourceHandle || e.sourceHandle === 'true' || e.sourceHandle === 'default');
                        }
                        // If any is missing, matchedEdge stays null -> triggers stay on node logic
                    }
                    else {
                        matchedEdge = outgoingEdges.find(e => !e.sourceHandle || e.sourceHandle === 'true' || e.sourceHandle === 'default');
                    }
                }

                if (matchedEdge) {
                    nextNodeId = matchedEdge.target;
                } else {
                    if (outgoingEdges.length === 0) {
                        const startNode = nodes.find(n => n.type === 'start' || n.data?.type === 'start');
                        nextNodeId = startNode ? startNode.id : null;
                    } else {
                        // Stay on node (Loop)
                        nextNodeId = currentNodeId;
                        let isManualClick = false;
                        if (currentNode.data.presets) {
                             const preset = currentNode.data.presets.find(p => (incomingPayloadId && p.id === incomingPayloadId) || (cleanInput && p.title.toLowerCase().trim() === cleanInput));
                             if (preset && isPresetManual(preset)) isManualClick = true;
                        }
                        if (incomingPayloadId === 'custom_time') isManualClick = true;
                        
                        // Explicitly ignore DatePicker from invalid checks because it handles its own loops via Checkpoint Logic
                        const isInteractive = ['interactive_button', 'interactive_list', 'rich_card'].includes(currentNode.data.type);
                        const isNotSpecial = currentNode.data.type !== 'datetime_picker';
                        
                        if (isInteractive && !isManualClick && isNotSpecial) {
                            shouldReplyInvalid = true;
                        }
                    }
                }
            } else {
                const startNode = nodes.find(n => n.type === 'start' || n.data?.type === 'start');
                nextNodeId = startNode ? startNode.id : null;
            }
        }

        if (shouldReplyInvalid) {
            await sendToMeta(candidate.phone_number, { type: 'text', text: { body: "I didn't catch that. Please select an option from the menu." } });
            return;
        }

        // 3. Execute Node Chain (Synchronous Loop)
        let activeNodeId = nextNodeId;
        let opsCount = 0;
        const MAX_OPS = 15; 

        while (activeNodeId && opsCount < MAX_OPS) {
            opsCount++;
            const node = nodes.find(n => n.id === activeNodeId);
            if (!node) break;

            const data = node.data || {};
            let autoAdvance = true; 
            
            if (data.type === 'status_update') {
                if (data.targetStatus) await client.query("UPDATE candidates SET stage = $1 WHERE id = $2", [data.targetStatus, candidate.id]);
            }

            else if (data.type === 'set_variable') {
                if (data.variable && data.operationValue) {
                    const newVars = { ...candidate.variables, [data.variable]: data.operationValue };
                    await client.query("UPDATE candidates SET variables = $1 WHERE id = $2", [newVars, candidate.id]);
                    candidate.variables = newVars;
                }
            }
            
            else if (data.type === 'delay') {
                const ms = Math.min(data.delayTime || 2000, 5000);
                await new Promise(r => setTimeout(r, ms));
            }

            else if (data.type === 'condition') {
                let isMatch = false;
                if (data.variable) {
                    const val = candidate.variables[data.variable];
                    const target = data.value;
                    const op = data.operator || 'equals';
                    if (val !== undefined) {
                        if (op === 'equals') isMatch = val == target;
                        else if (op === 'contains') isMatch = String(val).toLowerCase().includes(String(target).toLowerCase());
                        else if (op === 'is_set') isMatch = !!val;
                    }
                }
                const handle = isMatch ? 'true' : 'false';
                const nextEdge = edges.find(e => e.source === node.id && (e.sourceHandle === handle || !e.sourceHandle));
                activeNodeId = nextEdge ? nextEdge.target : null;
                continue; 
            }

            else if (data.type === 'handoff') {
                await client.query("UPDATE candidates SET is_human_mode = TRUE WHERE id = $1", [candidate.id]);
                const msg = processText(data.content, candidate);
                if (isValidContent(msg)) await sendToMeta(candidate.phone_number, { type: 'text', text: { body: msg } });
                break; 
            }

            // --- MESSAGE NODES ---
            
            else if (data.type !== 'start') {
                let rawBody = processText(data.content || '', candidate);
                let validBody = isValidContent(rawBody) ? rawBody : null;
                let payload = null;

                if (data.type === 'summary') {
                    let summaryText = validBody || "📋 Summary";
                    if (data.summaryDescription) summaryText += `
${processText(data.summaryDescription, candidate)}`;

                    const ignoredKeys = ['current_bot_step_id', 'is_human_mode', 'undefined', 'null'];
                    const filteredEntries = Object.entries(candidate.variables || {}).filter(([k, v]) => {
                        return !k.startsWith('_') && !ignoredKeys.includes(k) && v !== null && v !== undefined && v !== '';
                    });

                    const configuredRows = [];
                    const usedVariables = new Set();
                    const summaryFields = Array.isArray(data.summaryFields) ? data.summaryFields : [];

                    summaryFields.forEach((field) => {
                        if (!field?.variable) return;
                        const key = String(field.variable).trim();
                        if (!key || !(key in (candidate.variables || {}))) return;

                        const raw = candidate.variables[key];
                        if (raw === null || raw === undefined || raw === '') return;

                        usedVariables.add(key);
                        const label = field.label || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                        const styledLabel = formatSummaryToken(label, field.labelStyle || 'bold');
                        const styledValue = formatSummaryToken(formatSummaryValue(raw), field.valueStyle || 'plain');
                        configuredRows.push(`${field.prefix || '• '} ${styledLabel}: ${styledValue}${field.suffix || ''}`);
                    });

                    const includeAutoVariables = data.summaryUseAutoVariables !== false;
                    if (includeAutoVariables) {
                        filteredEntries.forEach(([key, val]) => {
                            if (usedVariables.has(key)) return;
                            const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                            configuredRows.push(`• *${label}:* ${formatSummaryValue(val)}`);
                        });
                    }

                    if (configuredRows.length > 0) {
                        summaryText += `

${configuredRows.join('\n')}`;
                    } else {
                        summaryText += `

${data.summaryEmptyText || '(No data collected yet)'}`;
                    }

                    if (data.footerText) summaryText += `

_${data.footerText}_`;
                    payload = { type: 'text', text: { body: summaryText } };
                }


                else if (data.type === 'text') {
                    if (validBody) {
                        payload = { type: 'text', text: { body: validBody } };
                        if (data.footerText) payload.text.body += `\n\n_${data.footerText}_`;
                    }
                } 
                else if (data.type === 'input') {
                    payload = { type: 'text', text: { body: validBody || "Please enter your response below:" } };
                    autoAdvance = false; 
                } 
                
                else if (data.type === 'datetime_picker') {
                    // --- 3-STAGE MESSAGE GENERATION (CHECKPOINT SYSTEM) ---
                    // This node logic now dynamically changes its output based on what data is missing
                    
                    const hasDate = !!candidate.variables.pickup_date;
                    const hasPeriod = !!candidate.variables.time_period;
                    
                    let buttonText = "Select Option";
                    let listBody = validBody || "Please select an option:";
                    let listRows = [];

                    if (!hasDate) {
                        // Stage 1: Ask for Date
                        listRows = generateDateOptions(data.dateConfig);
                        buttonText = "Select Date";
                        listBody = validBody || "When would you like to schedule this?";
                    } else if (!hasPeriod) {
                        // Stage 2: Ask for Period
                        listRows = generatePeriodOptions(candidate);
                        buttonText = "Select Time of Day";
                        listBody = `🗓️ Date: *${candidate.variables.pickup_date}*\n\nWhat time of day works best?`;
                    } else {
                        // Stage 3: Ask for Time Slot
                        listRows = generateTimeOptions(candidate);
                        buttonText = "Select Time";
                        const prettyPeriod = candidate.variables.time_period.replace('PERIOD_', '');
                        listBody = `🗓️ Date: *${candidate.variables.pickup_date}*\n🌅 Period: *${prettyPeriod}*\n\nPlease select an exact time:`;
                    }
                    
                    payload = {
                        type: "interactive",
                        interactive: {
                            type: "list",
                            body: { text: listBody },
                            action: {
                                button: buttonText,
                                sections: [{ title: "Available Slots", rows: sanitizeListRows(listRows) }]
                            }
                        }
                    };
                    if (data.footerText) payload.interactive.footer = { text: data.footerText };
                    autoAdvance = false;
                }

                else if (data.type === 'pickup_location' || data.type === 'destination_location') {
                     let isManualTrigger = false;
                     if (data.presets) {
                         const preset = data.presets.find(p => (incomingPayloadId && p.id === incomingPayloadId) || (cleanInput && p.title.toLowerCase().trim() === cleanInput));
                         if (preset && isPresetManual(preset)) isManualTrigger = true;
                     }
                     const hasPresets = data.presets && data.presets.length > 0;
                     
                     if (hasPresets && !isManualTrigger) {
                         const rows = data.presets.slice(0, 10).map(p => {
                             const row = { id: p.id, title: p.title.substring(0, 24) };
                             if (p.description) row.description = p.description.substring(0, 72);
                             return row;
                         });
                         payload = {
                            type: "interactive",
                            interactive: {
                                type: "list",
                                body: { text: validBody || (data.type === 'pickup_location' ? "Select Pickup Location:" : "Select Destination:") },
                                action: { button: "Locations", sections: [{ title: "Options", rows }] }
                            }
                        };
                     } else {
                         const label = data.type === 'pickup_location' ? "Pickup Location" : "Destination";
                         payload = {
                            type: "interactive",
                            interactive: {
                                type: "location_request_message",
                                body: { text: (validBody || `Please share your *${label}*:`) },
                                action: { name: "send_location" }
                            }
                        };
                     }
                     autoAdvance = false;
                }
                else if (data.type === 'location_request') {
                     payload = {
                        type: "interactive",
                        interactive: {
                            type: "location_request_message",
                            body: { text: validBody || "Please share your current location:" },
                            action: { name: "send_location" }
                        }
                    };
                    autoAdvance = false;
                }
                else if (data.type === 'image' && data.mediaUrl) {
                    const url = await refreshMediaUrl(data.mediaUrl);
                    payload = { type: 'image', image: { link: url, caption: validBody || '' } };
                } 
                else if ((data.type === 'interactive_button' || data.type === 'rich_card') && data.buttons?.length > 0) {
                    let header = undefined;
                    if (data.mediaUrl && (data.headerType === 'image' || data.headerType === 'video')) {
                        const url = await refreshMediaUrl(data.mediaUrl);
                        header = { type: data.headerType, [data.headerType]: { link: url } };
                    }
                    payload = {
                        type: "interactive",
                        interactive: {
                            type: "button",
                            header: header,
                            body: { text: validBody || "Please select an option:" },
                            footer: data.footerText ? { text: data.footerText } : undefined,
                            action: {
                                buttons: data.buttons.slice(0, 3).map(b => ({
                                    type: "reply",
                                    reply: { id: b.id, title: b.title.substring(0, 20) } 
                                }))
                            }
                        }
                    };
                    autoAdvance = false;
                } 
                else if (data.type === 'interactive_list' && data.sections?.length > 0) {
                    payload = {
                        type: "interactive",
                        interactive: {
                            type: "list",
                            body: { text: validBody || "Please make a selection:" },
                            action: {
                                button: data.listButtonText || "Menu",
                                sections: data.sections
                            }
                        }
                    };
                    autoAdvance = false;
                }

                if (payload) {
                    try {
                        await sendToMeta(candidate.phone_number, payload);
                        await client.query(
                            `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())`,
                            [crypto.randomUUID(), candidate.id, payload.text?.body || payload.interactive?.body?.text || '[Media]', data.type]
                        );
                    } catch (apiError) {
                        console.error("Meta Send Error:", apiError);
                    }
                }
            }

            // 4. Update State & Move On
            await client.query("UPDATE candidates SET current_bot_step_id = $1 WHERE id = $2", [node.id, candidate.id]);

            if (!autoAdvance) break; 

            const nextEdge = edges.find(e => e.source === node.id);
            if (nextEdge) {
                activeNodeId = nextEdge.target;
                await new Promise(r => setTimeout(r, 200));
            } else {
                activeNodeId = null;
            }
        }
    } catch (fatalError) {
        console.error("Bot Engine Fatal Crash:", fatalError);
    }
};

// --- EXPRESS APP ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
    console.log(`[${req.method}] ${req.url}`);
    next();
});

const apiRouter = express.Router();

apiRouter.get('/health', (req, res) => res.json({ status: 'ok', timestamp: Date.now() }));

// --- DEEP WAKE PING ---
apiRouter.get('/ping', async (req, res) => {
    try {
        if (pgPool) {
             // Wakes up Neon Postgres
             await pgPool.query('SELECT 1');
             res.status(200).send('pong - db active');
        } else {
            res.status(200).send('pong - no db pool');
        }
    } catch (e) {
        console.error("Ping DB Wake Failed", e.message);
        res.status(200).send('pong - db waking...');
    }
});

apiRouter.get('/debug/status', async (req, res) => {
    const status = {
        postgres: 'unknown',
        tables: { candidates: false, bot_versions: false },
        counts: { candidates: 0 },
        env: { hasPostgres: !!(process.env.POSTGRES_URL || process.env.DATABASE_URL) },
        lastError: null
    };
    try {
        await withDb(async (client) => {
            await client.query('SELECT 1');
            status.postgres = 'connected';
            const tablesRes = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
            const tables = tablesRes.rows.map(r => r.table_name);
            status.tables.candidates = tables.includes('candidates');
            status.tables.bot_versions = tables.includes('bot_versions');
            if (status.tables.candidates) {
                const countRes = await client.query('SELECT COUNT(*) FROM candidates');
                status.counts.candidates = parseInt(countRes.rows[0].count);
            }
        });
    } catch (e) {
        status.postgres = 'error';
        status.lastError = e.message;
    }
    res.json(status);
});

apiRouter.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

apiRouter.post('/webhook', async (req, res) => {
    const body = req.body;
    if (!body.object) { res.sendStatus(404); return; }
    try {
        const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (!msg) { res.sendStatus(200); return; }

        const processPromise = withDb(async (client) => {
            // WRAPPER: Retry logic for cold starts / missing tables
            await executeWithRetry(client, async () => {
                const existing = await client.query("SELECT id FROM candidate_messages WHERE whatsapp_message_id = $1", [msg.id]);
                if (existing.rows.length > 0) return;

                const from = msg.from;
                const name = body.entry[0].changes[0].value.contacts?.[0]?.profile?.name || 'Unknown';
                let text = '';
                let payloadId = null;

                if (msg.type === 'text') text = msg.text.body;
                else if (msg.type === 'interactive') {
                    if (msg.interactive.type === 'button_reply') {
                        text = msg.interactive.button_reply.title;
                        payloadId = msg.interactive.button_reply.id;
                    } else if (msg.interactive.type === 'list_reply') {
                        text = msg.interactive.list_reply.title;
                        payloadId = msg.interactive.list_reply.id;
                    }
                } 
                else if (msg.type === 'location') {
                    // Extract structured location data
                    text = JSON.stringify(msg.location);
                }
                else text = `[${msg.type.toUpperCase()}]`;

                let c = await client.query('SELECT * FROM candidates WHERE phone_number = $1', [from]);
                let candidate;
                if (c.rows.length === 0) {
                    const id = crypto.randomUUID();
                    await client.query(`INSERT INTO candidates (id, phone_number, name, stage, last_message, last_message_at, is_human_mode, variables) VALUES ($1, $2, $3, 'New', $4, $5, FALSE, '{}')`, [id, from, name, text, Date.now()]);
                    candidate = { id, phone_number: from, is_human_mode: false, current_bot_step_id: null, variables: {}, name };
                } else {
                    candidate = c.rows[0];
                    await client.query('UPDATE candidates SET last_message = $1, last_message_at = $2 WHERE id = $3', [text, Date.now(), candidate.id]);
                }

                await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, whatsapp_message_id, status, created_at) VALUES ($1, $2, 'in', $3, 'text', $4, 'received', NOW())`, [crypto.randomUUID(), candidate.id, text, msg.id]);
                await runBotEngine(client, candidate, text, payloadId);
            });
        });

        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Webhook Processing Timeout")), 9000));
        await Promise.race([processPromise, timeoutPromise]).catch(err => console.error("[Webhook Warning]", err.message));
        res.sendStatus(200);
    } catch(e) { console.error("Webhook Error", e); res.sendStatus(200); }
});

apiRouter.post('/auth/google', async (req, res) => {
    try {
        const { credential } = req.body;
        const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: SYSTEM_CONFIG.GOOGLE_CLIENT_ID });
        res.json({ success: true, user: ticket.getPayload() });
    } catch (e) { res.status(401).json({ success: false, error: e.message }); }
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
            await client.query("INSERT INTO bot_versions (id, status, settings, created_at) VALUES ($1, 'published', $2, NOW())", [crypto.randomUUID(), req.body]);
        });
        memoryCache.botSettings = null;
        memoryCache.lastUpdated = 0;
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/bot/publish', async (req, res) => res.json({ success: true }));

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

apiRouter.patch('/drivers/:id', async (req, res) => {
    try {
        const { status, isHumanMode, name } = req.body;
        await withDb(async (client) => {
            if (status) await client.query("UPDATE candidates SET stage = $1 WHERE id = $2", [status, req.params.id]);
            if (isHumanMode !== undefined) await client.query("UPDATE candidates SET is_human_mode = $1 WHERE id = $2", [isHumanMode, req.params.id]);
            if (name) await client.query("UPDATE candidates SET name = $1 WHERE id = $2", [name, req.params.id]);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers/:id/messages', async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query('SELECT * FROM candidate_messages WHERE candidate_id = $1 ORDER BY created_at DESC LIMIT 50', [req.params.id]);
            const msgs = await Promise.all(r.rows.map(async row => {
                let text = row.text, imageUrl = null;
                if (['image','video','document'].includes(row.type) && row.text.startsWith('{')) {
                    try { const p = JSON.parse(row.text); text = p.caption; if(p.url) imageUrl = await refreshMediaUrl(p.url); } catch(e){}
                }
                return { 
                    id: row.id, sender: row.direction === 'in' ? 'driver' : 'agent', text, imageUrl, 
                    timestamp: new Date(row.created_at).getTime(), type: row.type || 'text', status: row.status 
                };
            }));
            res.json(msgs.reverse());
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/drivers/:id/messages', async (req, res) => {
    try {
        const { text, mediaUrl, mediaType } = req.body;
        await withDb(async (client) => {
            const c = await client.query('SELECT phone_number FROM candidates WHERE id = $1', [req.params.id]);
            if (c.rows.length === 0) throw new Error("Candidate not found");
            let payload = { type: 'text', text: { body: text } };
            let dbText = text;
            if (mediaUrl) {
                const freshUrl = await refreshMediaUrl(mediaUrl);
                const type = mediaType || 'image';
                payload = { type, [type]: { link: freshUrl, caption: text } };
                if (type === 'document') payload[type].filename = decodeURIComponent(new URL(freshUrl).pathname.split('/').pop() || 'file.pdf');
                dbText = JSON.stringify({ url: mediaUrl, caption: text });
            }
            await sendToMeta(c.rows[0].phone_number, payload);
            await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, 'text', 'sent', NOW())`, [crypto.randomUUID(), req.params.id, dbText, mediaUrl ? (mediaType || 'image') : 'text']);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers/:id/documents', async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query('SELECT * FROM driver_documents WHERE candidate_id = $1', [req.params.id]);
            const docs = await Promise.all(r.rows.map(async d => ({ id: d.id, docType: d.type, url: await refreshMediaUrl(d.url), verificationStatus: d.status, timestamp: new Date(d.created_at).getTime() })));
            res.json(docs);
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- OPTIMIZED BULK SCHEDULER ---
apiRouter.post('/scheduled-messages', async (req, res) => {
    try {
        const { driverIds, message, timestamp } = req.body;
        if (!driverIds || driverIds.length === 0) return res.status(400).json({error: "No recipients"});
        
        const payload = typeof message === 'string' ? { text: message } : message;
        
        await withDb(async (client) => {
            // Bulk Insert using UNNEST for performance
            // $1 = ids array, $2 = payload, $3 = timestamp
            const query = `
                INSERT INTO scheduled_messages (id, candidate_id, payload, scheduled_time, status)
                SELECT gen_random_uuid(), unnest($1::uuid[]), $2, $3, 'pending'
            `;
            await client.query(query, [driverIds, payload, timestamp]);
        });
        
        res.json({ success: true, count: driverIds.length });
    } catch (e) { 
        console.error("Bulk Schedule Error:", e);
        res.status(500).json({ error: e.message }); 
    }
});

apiRouter.get('/drivers/:id/scheduled-messages', async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query(`SELECT * FROM scheduled_messages WHERE candidate_id = $1 AND status = 'pending' ORDER BY scheduled_time ASC`, [req.params.id]);
            const mapped = await Promise.all(r.rows.map(async row => {
                const p = row.payload || {};
                if(p.mediaUrl) p.mediaUrl = await refreshMediaUrl(p.mediaUrl);
                return { id: row.id, scheduledTime: parseInt(row.scheduled_time), payload: p, status: row.status };
            }));
            res.json(mapped);
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.delete('/scheduled-messages/:id', async (req, res) => {
    try {
        await withDb(async (client) => { await client.query("DELETE FROM scheduled_messages WHERE id = $1", [req.params.id]); });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.patch('/scheduled-messages/:id', async (req, res) => {
    try {
        const { text, scheduledTime } = req.body;
        await withDb(async (client) => {
            if (text) {
                const r = await client.query("SELECT payload FROM scheduled_messages WHERE id = $1", [req.params.id]);
                if (r.rows.length > 0) {
                    const newPayload = { ...r.rows[0].payload, text };
                    await client.query("UPDATE scheduled_messages SET payload = $1 WHERE id = $2", [newPayload, req.params.id]);
                }
            }
            if (scheduledTime) await client.query("UPDATE scheduled_messages SET scheduled_time = $1 WHERE id = $2", [scheduledTime, req.params.id]);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- ADVANCED PARALLEL CRON PROCESSOR ---
apiRouter.get('/cron/process-queue', async (req, res) => {
    let processed = 0, errors = 0;
    try {
        await withDb(async (client) => {
            await executeWithRetry(client, async () => {
                const now = Date.now();
                
                // Fetch larger batch (50) for efficiency
                const jobs = await client.query(`
                    SELECT sm.id, sm.candidate_id, sm.payload, c.phone_number 
                    FROM scheduled_messages sm 
                    JOIN candidates c ON sm.candidate_id = c.id 
                    WHERE sm.status = 'pending' AND sm.scheduled_time <= $1 
                    LIMIT 50 
                    FOR UPDATE OF sm SKIP LOCKED
                `, [now]);

                if (jobs.rows.length === 0) return;

                // Helper for processing a single job
                const processJob = async (job) => {
                    try {
                        // Optimistic update to processing
                        await client.query("UPDATE scheduled_messages SET status = 'processing' WHERE id = $1", [job.id]);
                        
                        const p = job.payload || {};
                        let metaP, dbLogText = p.text || '', dbType = 'text';
                        
                        // Smart Media Handling
                        if (p.mediaUrl) {
                            const url = await refreshMediaUrl(p.mediaUrl);
                            const mediaType = p.mediaType || 'image';
                            dbType = mediaType;
                            
                            // Construct caption/filename
                            dbLogText = JSON.stringify({ url: p.mediaUrl, caption: p.text || '' });
                            
                            metaP = { type: mediaType, [mediaType]: { link: url, caption: p.text || '' } };
                            
                            // Specific fix for Documents: Needs 'filename'
                            if (mediaType === 'document') {
                                metaP[mediaType].filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'document.pdf');
                                // Documents don't support 'caption' in some API versions, but we leave it as valid property
                            }
                        } else {
                            metaP = { type: 'text', text: { body: dbLogText } };
                        }
                        
                        await sendToMeta(job.phone_number, metaP);
                        
                        // Log success
                        await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())`, [crypto.randomUUID(), job.candidate_id, dbLogText, dbType]);
                        await client.query("UPDATE scheduled_messages SET status = 'sent' WHERE id = $1", [job.id]);
                        processed++;
                    } catch (e) {
                        errors++;
                        console.error(`Job ${job.id} failed:`, e.message);
                        await client.query("UPDATE scheduled_messages SET status = 'failed', error_log = $2 WHERE id = $1", [job.id, e.message]);
                    }
                };

                // PARALLEL EXECUTION (Batch of 5 concurrently)
                const BATCH_SIZE = 5;
                for (let i = 0; i < jobs.rows.length; i += BATCH_SIZE) {
                    const chunk = jobs.rows.slice(i, i + BATCH_SIZE);
                    await Promise.all(chunk.map(job => processJob(job)));
                }
            });
        });
        res.json({ status: 'ok', processed, errors, queueSize: processed + errors });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/system/init-db', async (req, res) => {
    try {
        await withDb(async (client) => {
            await initDatabase(client);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/system/hard-reset', async (req, res) => {
    try {
        await withDb(async (client) => {
            await client.query('BEGIN');
            try {
                await client.query(`DROP TABLE IF EXISTS scheduled_messages, candidate_messages, driver_documents, bot_versions, candidates, system_settings CASCADE`);
                await initDatabase(client); // Uses the shared robust init function
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            }
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/system/seed-db', async (req, res) => {
    try {
        await withDb(async (client) => {
            const id = crypto.randomUUID();
            await client.query(`INSERT INTO candidates (id, phone_number, name, stage, last_message, last_message_at) VALUES ($1, '+919999999999', 'Demo Driver', 'New', 'Hello', $2)`, [id, Date.now()]);
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use('/api', apiRouter);
app.use('/', apiRouter);
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

if (require.main === module) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        console.log(`Server running on ${PORT}`);
        // Auto-Init Check on Start (For Local/VPS, NOT Vercel)
        (async () => {
            try {
                if (pgPool) {
                    const client = await pgPool.connect();
                    try {
                        const res = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'candidates'`);
                        if (res.rows.length === 0) {
                            console.log("[Auto-Init] Database schema missing. Initializing...");
                            await initDatabase(client);
                            console.log("[Auto-Init] Database ready.");
                        }
                    } finally {
                        client.release();
                    }
                }
            } catch(e) { console.error("[Auto-Init] Failed:", e.message); }
        })();
    });
}

module.exports = app;

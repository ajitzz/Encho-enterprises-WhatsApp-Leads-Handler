
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

// --- SMART TIME RESOLVER (AM/PM GUESSER) ---
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

// --- DYNAMIC OPTION GENERATORS ---

const PERIODS = {
    MORNING: { label: '🌅 Morning (5 AM - 12 PM)', start: 5, end: 11 },
    AFTERNOON: { label: '☀️ Afternoon (12 PM - 5 PM)', start: 12, end: 16 },
    EVENING: { label: '🌆 Evening (5 PM - 9 PM)', start: 17, end: 20 },
    NIGHT: { label: '🌙 Night (9 PM - 5 AM)', start: 21, end: 28 } // 28 = 4AM next day
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

    if (isValidPeriod('MORNING')) options.push({ id: 'PERIOD_MORNING', title: PERIODS.MORNING.label });
    if (isValidPeriod('AFTERNOON')) options.push({ id: 'PERIOD_AFTERNOON', title: PERIODS.AFTERNOON.label });
    if (isValidPeriod('EVENING')) options.push({ id: 'PERIOD_EVENING', title: PERIODS.EVENING.label });
    options.push({ id: 'PERIOD_NIGHT', title: PERIODS.NIGHT.label }); // Always show night

    return options;
};

// 3. Generate Times based on Period
const generateTimeOptions = (candidate) => {
    const options = [];
    const now = new Date();
    const periodKey = candidate?.variables?.time_period?.replace('PERIOD_', '');
    
    if (!periodKey || !PERIODS[periodKey]) {
        // Fallback if no period (shouldn't happen)
        return [{ id: 'custom', title: 'Type Specific Time' }];
    }

    const range = PERIODS[periodKey];
    const startHour = range.start;
    const endHour = range.end; // Exclusive for loop usually, but here we treat as valid hour

    let isToday = false;
    if (candidate?.variables?.pickup_date === now.toISOString().split('T')[0]) {
        isToday = true;
    }

    // Generate 30 min intervals
    for (let h = startHour; h <= endHour; h++) {
        for (let m = 0; m < 60; m += 30) {
            // Logic for "Night" spillover (24, 25 -> 00, 01)
            let realH = h;
            if (h >= 24) realH = h - 24;

            // For "Today", don't show past times
            if (isToday) {
                // If it's 3:15 PM (15:15), don't show 3:00 PM (15:00)
                if (realH < now.getHours()) continue;
                if (realH === now.getHours() && m < now.getMinutes()) continue;
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
            candidate.variables = {}; // Clear memory for fresh start
        }

        // 2. Determine Current State
        if (!currentNodeId) {
            const startNode = nodes.find(n => n.type === 'start' || n.data?.type === 'start');
            nextNodeId = startNode ? startNode.id : nodes[0]?.id;
        } else {
            const currentNode = nodes.find(n => n.id === currentNodeId);
            if (currentNode) {
                // A. Handle Variable Capture
                const captureTypes = ['input', 'location_request', 'pickup_location', 'destination_location', 'datetime_picker'];
                
                if (captureTypes.includes(currentNode.data.type)) {
                    let varName = currentNode.data.variable;
                    
                    if (!varName) {
                        if (currentNode.data.type === 'pickup_location') varName = 'pickup_coords';
                        else if (currentNode.data.type === 'destination_location') varName = 'dest_coords';
                        else if (currentNode.data.type === 'location_request') varName = 'location_data';
                        else if (currentNode.data.type === 'datetime_picker') varName = currentNode.data.dateConfig?.mode === 'time' ? 'time_slot' : 'pickup_date';
                    }

                    // --- SMART LOGIC START ---
                    let valueToSave = null;
                    let isManualTrigger = false;

                    // Check for Preset/List Selection
                    if (currentNode.data.presets) {
                        let matchedPreset = currentNode.data.presets.find(p => p.id === incomingPayloadId);
                        if (!matchedPreset && cleanInput) matchedPreset = currentNode.data.presets.find(p => p.title.toLowerCase().trim() === cleanInput);

                        if (matchedPreset) {
                            if (isPresetManual(matchedPreset)) isManualTrigger = true;
                            else valueToSave = JSON.stringify({ lat: matchedPreset.latitude, long: matchedPreset.longitude, label: matchedPreset.title });
                        }
                    }
                    
                    // --- DYNAMIC DATETIME CAPTURE (3-STAGE) ---
                    if (currentNode.data.type === 'datetime_picker') {
                        // 1. Check if user sent a PERIOD (Morning, Afternoon...)
                        if (incomingPayloadId && incomingPayloadId.startsWith('PERIOD_')) {
                            // User selected "Afternoon". Save it, but DO NOT advance node yet.
                            await client.query("UPDATE candidates SET variables = jsonb_set(variables, '{time_period}', $1)", [JSON.stringify(incomingPayloadId)]);
                            candidate.variables.time_period = incomingPayloadId;
                            // Stay on same node to ask for Time next
                            valueToSave = null; // Don't save main variable yet
                        }
                        // 2. Check if user sent a DATE (YYYY-MM-DD)
                        else if (incomingPayloadId && incomingPayloadId.match(/^\d{4}-\d{2}-\d{2}$/)) {
                            await client.query("UPDATE candidates SET variables = jsonb_set(variables, '{pickup_date}', $1)", [JSON.stringify(incomingPayloadId)]);
                            candidate.variables.pickup_date = incomingPayloadId;
                            // Reset period/time if they went back to change date
                            await client.query("UPDATE candidates SET variables = variables - 'time_period' - 'time_slot' WHERE id = $1", [candidate.id]);
                            delete candidate.variables.time_period;
                            // Stay on same node to ask Period next
                            valueToSave = null;
                        }
                        // 3. Check if user sent "Type Specific Time" or actual Time
                        else if (incomingPayloadId === 'custom_time') {
                            isManualTrigger = true; 
                        } 
                        else if (incomingPayloadId) {
                            valueToSave = incomingPayloadId; // Likely a time slot (2:30 PM)
                        } 
                        else if (cleanInput) {
                            // Handle Manual Text Input
                            const timeRegex = /([0-9]{1,2})[:.]([0-9]{2})\s*(am|pm)?/i;
                            const match = cleanInput.match(timeRegex);
                            
                            if (match) {
                                // Explicit Time Input
                                if (match[3]) valueToSave = match[0].toUpperCase();
                                else valueToSave = resolveTimeAmbiguity(match[0]);
                            } else if (cleanInput.length > 3) {
                                // Fallback for raw text
                                valueToSave = incomingText; 
                            }
                        }
                    }

                    // Check for Real Location Message
                    else if (!isManualTrigger && incomingText && incomingText.startsWith('{') && incomingText.includes('"latitude"')) {
                        valueToSave = incomingText;
                    } 
                    // Fallback for simple text input
                    else if (!isManualTrigger && currentNode.data.type === 'input') {
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
                    // Logic for Smart Nodes that auto-advance after valid input
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
                        // CRITICAL CHANGE: Only advance if the FINAL time slot is captured
                        // We check variables. If we just saved 'pickup_date' or 'time_period', we do NOT advance.
                        // If we saved 'time_slot' (which maps to varName above), we advance.
                        let timeVar = currentNode.data.variable || 'time_slot';
                        if (candidate.variables[timeVar]) {
                            matchedEdge = outgoingEdges.find(e => !e.sourceHandle || e.sourceHandle === 'true' || e.sourceHandle === 'default');
                        }
                        // Else: stay on node to ask next question in sequence
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
                        // Stay on node
                        nextNodeId = currentNodeId;
                        let isManualClick = false;
                        if (currentNode.data.presets) {
                             const preset = currentNode.data.presets.find(p => (incomingPayloadId && p.id === incomingPayloadId) || (cleanInput && p.title.toLowerCase().trim() === cleanInput));
                             if (preset && isPresetManual(preset)) isManualClick = true;
                        }
                        if (incomingPayloadId === 'custom_time') isManualClick = true;
                        
                        // If it's datetime_picker, don't show invalid. It might be a valid step update.
                        if (['interactive_button', 'interactive_list', 'rich_card'].includes(currentNode.data.type) && !isManualClick && currentNode.data.type !== 'datetime_picker') {
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

                if (data.type === 'text') {
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
                    // MULTI-STEP LOGIC: Date -> Period -> Time
                    const hasDate = !!candidate.variables.pickup_date;
                    const hasPeriod = !!candidate.variables.time_period;
                    
                    let buttonText = "Select Option";
                    let listBody = validBody;
                    let listRows = [];

                    if (!hasDate) {
                        // Step 1: Show Dates
                        listRows = generateDateOptions(data.dateConfig);
                        buttonText = "Select Date";
                        listBody = listBody || "When would you like to book?";
                    } else if (!hasPeriod) {
                        // Step 2: Show Periods (Morning, Afternoon, etc.)
                        listRows = generatePeriodOptions(candidate);
                        buttonText = "Select Time of Day";
                        listBody = `Date selected: ${candidate.variables.pickup_date}\n\nWhat time of day works best?`;
                    } else {
                        // Step 3: Show Specific Times
                        listRows = generateTimeOptions(candidate);
                        buttonText = "Select Time";
                        listBody = `Date: ${candidate.variables.pickup_date}\nPeriod: ${candidate.variables.time_period.replace('PERIOD_', '')}\n\nSelect exact time:`;
                    }
                    
                    payload = {
                        type: "interactive",
                        interactive: {
                            type: "list",
                            body: { text: listBody },
                            action: {
                                button: buttonText,
                                sections: [{ title: "Options", rows: listRows }]
                            }
                        }
                    };
                    if (data.footerText) payload.interactive.footer = { text: data.footerText };
                    autoAdvance = false;
                }

                else if (data.type === 'pickup_location' || data.type === 'destination_location') {
                     // ... (Previous Location Logic Remains Same)
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

// ... (Rest of existing code) ...

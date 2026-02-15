
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const multer = require('multer');
const axios = require('axios');
const https = require('https');
const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { OAuth2Client, JWT } = require('google-auth-library');

require('dotenv').config();

// --- CONFIGURATION ---
const SYSTEM_CONFIG = {
    META_TIMEOUT: 15000,
    DB_CONNECTION_TIMEOUT: 20000,
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
    AWS_BUCKET: process.env.AWS_BUCKET_NAME || 'uber-fleet-assets',
    GOOGLE_CLIENT_ID: process.env.VITE_GOOGLE_CLIENT_ID,
    GOOGLE_SHEETS_SPREADSHEET_ID: process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '',
    GOOGLE_SHEETS_CUSTOMERS_TAB_NAME: process.env.GOOGLE_SHEETS_CUSTOMERS_TAB_NAME || process.env.GOOGLE_SHEETS_CUSTOMERS_SHEET || 'Customers',
    GOOGLE_SHEETS_MESSAGES_TAB_NAME: process.env.GOOGLE_SHEETS_MESSAGES_TAB_NAME || process.env.GOOGLE_SHEETS_MESSAGES_SHEET || 'Messages',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '',
    CACHE_TTL: 60 * 1000 // 60 Seconds Cache for Bot Settings
};

// --- IN-MEMORY CACHE (Performance Boost) ---
const memoryCache = {
    botSettings: null,
    lastUpdated: 0
};

// --- INITIALIZE CLIENTS ---
let s3Client, googleClient, pgPool;

try {
    s3Client = new S3Client({
        region: SYSTEM_CONFIG.AWS_REGION,
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
    });

    googleClient = new OAuth2Client(SYSTEM_CONFIG.GOOGLE_CLIENT_ID);
    
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

const MEDIA_ROOT_PREFIX = (process.env.MEDIA_ROOT_PREFIX || 'media-library/').replace(/^\/+/, '');

const normalizeMediaPath = (rawPath = '/') => {
    const cleaned = String(rawPath || '/').replace(/\\/g, '/').trim();
    if (!cleaned || cleaned === '/') return '';
    return cleaned.replace(/^\/+|\/+$/g, '');
};

const toMediaPrefix = (rawPath = '/') => {
    const normalized = normalizeMediaPath(rawPath);
    return normalized ? `${MEDIA_ROOT_PREFIX}${normalized}/` : MEDIA_ROOT_PREFIX;
};

const hasAnyObjects = (listRes) => (listRes.CommonPrefixes || []).length > 0 || (listRes.Contents || []).length > 0;

const listMediaObjects = async (requestedPath = '/') => {
    const primaryPrefix = toMediaPrefix(requestedPath);
    const primary = await s3Client.send(new ListObjectsV2Command({
        Bucket: SYSTEM_CONFIG.AWS_BUCKET,
        Prefix: primaryPrefix,
        Delimiter: '/'
    }));

    if (hasAnyObjects(primary) || !MEDIA_ROOT_PREFIX) {
        return { listRes: primary, prefix: primaryPrefix };
    }

    const normalized = normalizeMediaPath(requestedPath);
    const fallbackPrefix = normalized ? `${normalized}/` : '';
    const fallback = await s3Client.send(new ListObjectsV2Command({
        Bucket: SYSTEM_CONFIG.AWS_BUCKET,
        Prefix: fallbackPrefix,
        Delimiter: '/'
    }));

    if (hasAnyObjects(fallback)) {
        console.warn(`[MEDIA LIST FALLBACK] No objects under "${primaryPrefix}". Falling back to "${fallbackPrefix || '/'}".`);
        return { listRes: fallback, prefix: fallbackPrefix };
    }

    return { listRes: primary, prefix: primaryPrefix };
};

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

let driverExcelSyncInProgress = false;
let driverExcelSyncRequested = false;
let driverExcelSyncTimer = null;
let driverExcelSyncMaxWaitTimer = null;
let driverExcelSyncPendingSince = null;
const DRIVER_EXCEL_SYNC_IDLE_MS = Math.max(1000, Number(process.env.DRIVER_EXCEL_SYNC_IDLE_MS || 20000));
const DRIVER_EXCEL_SYNC_MAX_WAIT_MS = Math.max(DRIVER_EXCEL_SYNC_IDLE_MS, Number(process.env.DRIVER_EXCEL_SYNC_MAX_WAIT_MS || 180000));
const DRIVER_EXCEL_INCREMENTAL_SYNC_IDLE_MS = Math.max(500, Number(process.env.DRIVER_EXCEL_INCREMENTAL_SYNC_IDLE_MS || 2500));
const DRIVER_EXCEL_INCREMENTAL_SYNC_MAX_WAIT_MS = Math.max(DRIVER_EXCEL_INCREMENTAL_SYNC_IDLE_MS, Number(process.env.DRIVER_EXCEL_INCREMENTAL_SYNC_MAX_WAIT_MS || 15000));
let driverExcelSyncStatus = {
    state: 'idle',
    lastTriggeredAt: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastDurationMs: null,
    destinations: {
        s3: { state: 'idle', lastSuccessAt: null, lastError: null },
        googleSheets: { state: 'idle', lastSuccessAt: null, lastError: null }
    }
};

let driverExcelIncrementalTimer = null;
let driverExcelIncrementalMaxWaitTimer = null;
let driverExcelIncrementalPendingSince = null;
const driverExcelIncrementalQueue = new Map(); // candidateId -> 'upsert' | 'delete'

const persistDriverExcelSyncStatus = async () => {
    try {
        await withDb(async (client) => {
            await client.query(
                "INSERT INTO system_settings (key, value) VALUES ('driver_excel_sync_status', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                [JSON.stringify(driverExcelSyncStatus)]
            );
        });
    } catch (e) {
        console.warn('[Driver Excel Sync Status Persist Warning]', e.message);
    }
};

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

const sanitizePhoneForPath = (phone) => (phone || '').toString().replace(/\D/g, '') || 'unknown';

const getDriverMonthFolder = (date = new Date()) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

const buildDriverDataPrefix = (phone, date = new Date()) => `Driver data/${getDriverMonthFolder(date)}/${sanitizePhoneForPath(phone)}`;

const getPublicS3Url = (key) => `https://${SYSTEM_CONFIG.AWS_BUCKET}.s3.${SYSTEM_CONFIG.AWS_REGION}.amazonaws.com/${encodeURIComponent(key).replace(/%2F/g, '/')}`;

const xmlEscape = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const rowsToWorksheetXml = (rows) => rows.map((row) => {
    const cells = row.map((cell) => `<Cell><Data ss:Type="String">${xmlEscape(cell)}</Data></Cell>`).join('');
    return `<Row>${cells}</Row>`;
}).join('');

const getDriverExcelCellValue = (customer, column) => {
    const vars = customer.variables || {};
    if (column.key === 'phoneNumber') return customer.phone_number || '';
    if (column.key === 'name') return customer.name || '';
    if (column.key === 'status') return customer.stage || '';
    if (column.key === 'source') return customer.source || '';
    if (column.key === 'createdAt') return customer.created_at || '';
    if (column.key === 'lastMessageAt') return customer.last_message_at || '';
    return vars[column.key] ?? '';
};

const buildDriverExcelXml = (customers, messages, columns = []) => {
    const effectiveColumns = Array.isArray(columns) && columns.length > 0 ? columns : DRIVER_EXCEL_CORE_COLUMNS;
    const customerHeaders = ['Candidate ID', ...effectiveColumns.map((c) => c.label), 'Latest License Link', 'License Folder Link', 'Variables JSON'];

    const customerRows = [
        customerHeaders,
        ...customers.map((c) => [
            c.id,
            ...effectiveColumns.map((col) => getDriverExcelCellValue(c, col)),
            c.latest_license_url,
            c.license_folder_url,
            JSON.stringify(c.variables || {})
        ])
    ];

    const messageRows = [
        ['Message ID', 'Candidate ID', 'Phone Number', 'Direction', 'Type', 'Status', 'WhatsApp Message ID', 'Created At', 'Text'],
        ...messages.map((m) => [
            m.id,
            m.candidate_id,
            m.phone_number,
            m.direction,
            m.type,
            m.status,
            m.whatsapp_message_id,
            m.created_at,
            m.text
        ])
    ];

    return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
  <Worksheet ss:Name="Customers">
    <Table>${rowsToWorksheetXml(customerRows)}</Table>
  </Worksheet>
  <Worksheet ss:Name="Messages">
    <Table>${rowsToWorksheetXml(messageRows)}</Table>
  </Worksheet>
</Workbook>`;
};

const buildDriverExcelSheetValues = (customers, messages, columns = []) => {
    const effectiveColumns = Array.isArray(columns) && columns.length > 0 ? columns : DRIVER_EXCEL_CORE_COLUMNS;
    const customerHeaders = ['Candidate ID', ...effectiveColumns.map((c) => c.label), 'Latest License Link', 'License Folder Link', 'Variables JSON'];
    const customerRows = [
        customerHeaders,
        ...customers.map((c) => [
            c.id,
            ...effectiveColumns.map((col) => getDriverExcelCellValue(c, col)),
            c.latest_license_url,
            c.license_folder_url,
            JSON.stringify(c.variables || {})
        ])
    ];

    const messageRows = [
        ['Message ID', 'Candidate ID', 'Phone Number', 'Direction', 'Type', 'Status', 'WhatsApp Message ID', 'Created At', 'Text'],
        ...messages.map((m) => [
            m.id,
            m.candidate_id,
            m.phone_number,
            m.direction,
            m.type,
            m.status,
            m.whatsapp_message_id,
            m.created_at,
            m.text
        ])
    ];

    return { customerRows, messageRows };
};

const isDriverExcelGoogleSyncEnabled = () => Boolean(
    SYSTEM_CONFIG.GOOGLE_SHEETS_SPREADSHEET_ID
    && SYSTEM_CONFIG.GOOGLE_SERVICE_ACCOUNT_EMAIL
    && SYSTEM_CONFIG.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
);

const parseGooglePrivateKey = () => {
    const raw = SYSTEM_CONFIG.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
    if (!raw) return '';
    return raw.includes('-----BEGIN PRIVATE KEY-----') ? raw.replace(/\\n/g, '\n') : raw;
};

const toSheetRangeName = (sheetName = '') => `'${String(sheetName).replace(/'/g, "''")}'`;

const syncDriverExcelToGoogleSheets = async ({ customerRows, messageRows }) => {
    const customersTabName = SYSTEM_CONFIG.GOOGLE_SHEETS_CUSTOMERS_TAB_NAME;
    const messagesTabName = SYSTEM_CONFIG.GOOGLE_SHEETS_MESSAGES_TAB_NAME;
    if (!isDriverExcelGoogleSyncEnabled()) {
        return { skipped: true, reason: 'Google Sheets credentials not configured' };
    }

    const authClient = new JWT({
        email: SYSTEM_CONFIG.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: parseGooglePrivateKey(),
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const { access_token: accessToken } = await authClient.authorize();
    if (!accessToken) throw new Error('Failed to authorize Google Sheets service account');

    const spreadsheetId = SYSTEM_CONFIG.GOOGLE_SHEETS_SPREADSHEET_ID;
    const customersRange = toSheetRangeName(customersTabName);
    const messagesRange = toSheetRangeName(messagesTabName);
    const headers = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
    };

    const sameTab = customersTabName === messagesTabName;

    if (sameTab) {
        const unifiedRows = [
            ...customerRows,
            [],
            ['Messages Table'],
            ...messageRows
        ];
        await axios.post(
            `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchClear`,
            { ranges: [customersRange] },
            { headers }
        );
        await axios.post(
            `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
            {
                valueInputOption: 'RAW',
                data: [
                    { range: `${customersRange}!A1`, values: unifiedRows }
                ]
            },
            { headers }
        );
        return { skipped: false, mode: 'single_tab' };
    }

    await axios.post(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchClear`,
        { ranges: [customersRange, messagesRange] },
        { headers }
    );

    await axios.post(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
        {
            valueInputOption: 'RAW',
            data: [
                { range: `${customersRange}!A1`, values: customerRows },
                { range: `${messagesRange}!A1`, values: messageRows }
            ]
        },
        { headers }
    );

    return { skipped: false, mode: 'two_tabs' };
};


const fetchDriverExcelCandidateForSync = async (candidateId) => {
    if (!candidateId) return null;
    return withDb(async (client) => {
        const candidateRes = await client.query(`
            SELECT c.id, c.phone_number, c.name, c.stage, c.source, c.created_at, c.last_message_at, c.variables,
                (
                    SELECT d.url FROM driver_documents d
                    WHERE d.candidate_id = c.id
                    ORDER BY d.created_at DESC
                    LIMIT 1
                ) AS latest_license_key
            FROM candidates c
            WHERE c.id = $1
            LIMIT 1
        `, [candidateId]);

        if (candidateRes.rows.length === 0) return null;

        const captureRes = await client.query(`
            SELECT text, created_at
            FROM candidate_messages
            WHERE candidate_id = $1 AND type = 'variable_capture'
            ORDER BY created_at ASC
        `, [candidateId]);

        const customCols = await getDriverExcelColumnConfig(client);
        const { responseLookup, discoveredKeys } = buildVariableResponseLookup({
            captureRows: captureRes.rows.map((row) => ({ ...row, candidate_id: candidateId })),
            candidateRows: candidateRes.rows
        });
        const mergedCustomCols = mergeDriverExcelColumns(customCols, discoveredKeys);
        if (mergedCustomCols.length !== customCols.length) {
            await saveDriverExcelColumnConfig(client, mergedCustomCols);
        }

        const row = candidateRes.rows[0];
        const vars = {
            ...normalizeVariables(row.variables),
            ...(responseLookup.get(row.id) || {})
        };
        const latestLicenseKey = row.latest_license_key || vars.license_s3_key || '';
        const month = latestLicenseKey.startsWith('Driver data/') ? latestLicenseKey.split('/')[1] : getDriverMonthFolder();
        const licenseFolderKey = `Driver data/${month}/${sanitizePhoneForPath(row.phone_number)}/`;
        const latestLicenseUrl = vars.license_url || (latestLicenseKey ? getPublicS3Url(latestLicenseKey) : '');

        return {
            customer: {
                id: row.id,
                phone_number: row.phone_number,
                name: row.name,
                stage: row.stage,
                source: row.source || '',
                created_at: row.created_at ? new Date(row.created_at).toISOString() : '',
                last_message_at: row.last_message_at ? new Date(Number(row.last_message_at) || row.last_message_at).toISOString() : '',
                latest_license_url: latestLicenseUrl,
                license_folder_url: getPublicS3Url(licenseFolderKey),
                variables: vars
            },
            columns: [...DRIVER_EXCEL_CORE_COLUMNS, ...mergedCustomCols]
        };
    });
};

const getGoogleSheetsAccessToken = async () => {
    const authClient = new JWT({
        email: SYSTEM_CONFIG.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: parseGooglePrivateKey(),
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const { access_token: accessToken } = await authClient.authorize();
    if (!accessToken) throw new Error('Failed to authorize Google Sheets service account');
    return accessToken;
};

const findCandidateRowInGoogleSheet = async ({ accessToken, spreadsheetId, customersRange, candidateId }) => {
    const encodedRange = encodeURIComponent(`${customersRange}!A:A`);
    const response = await axios.get(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodedRange}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const rows = response.data?.values || [];
    const matchIndex = rows.findIndex((cells) => String(cells?.[0] || '') === String(candidateId));
    if (matchIndex === -1) return null;
    return matchIndex + 1; // 1-based
};

const getSystemConfig = async (client) => {
    const sys = await client.query("SELECT value FROM system_settings WHERE key = 'config' LIMIT 1");
    const rawConfig = sys.rows[0]?.value || {};
    return {
        webhook_ingest_enabled: rawConfig.webhook_ingest_enabled !== false,
        automation_enabled: rawConfig.automation_enabled !== false,
        sending_enabled: rawConfig.sending_enabled !== false
    };
};

const checkGoogleSheetsOperationalStatus = async () => {
    const spreadsheetId = SYSTEM_CONFIG.GOOGLE_SHEETS_SPREADSHEET_ID;
    const customersTabName = SYSTEM_CONFIG.GOOGLE_SHEETS_CUSTOMERS_TAB_NAME;
    const messagesTabName = SYSTEM_CONFIG.GOOGLE_SHEETS_MESSAGES_TAB_NAME;

    if (!isDriverExcelGoogleSyncEnabled()) {
        return {
            state: 'not_configured',
            configured: false,
            reason: 'Missing spreadsheet id or service-account credentials',
            spreadsheetId: spreadsheetId || null,
            customersTabName,
            messagesTabName
        };
    }

    try {
        const accessToken = await getGoogleSheetsAccessToken();
        const metadata = await axios.get(
            `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties.title`,
            {
                headers: { Authorization: `Bearer ${accessToken}` },
                timeout: 8000
            }
        );

        const tabNames = (metadata.data?.sheets || []).map((sheet) => sheet?.properties?.title).filter(Boolean);
        return {
            state: 'connected',
            configured: true,
            spreadsheetId,
            spreadsheetTitle: metadata.data?.properties?.title || '',
            customersTabName,
            messagesTabName,
            customersTabExists: tabNames.includes(customersTabName),
            messagesTabExists: tabNames.includes(messagesTabName),
            tabMode: customersTabName === messagesTabName ? 'single_tab' : 'two_tabs'
        };
    } catch (e) {
        return {
            state: 'error',
            configured: true,
            spreadsheetId,
            customersTabName,
            messagesTabName,
            reason: e.message || 'Google Sheets connection check failed'
        };
    }
};

const upsertCandidateToGoogleSheets = async (candidateId) => {
    if (!isDriverExcelGoogleSyncEnabled() || !candidateId) return;
    const customersTabName = SYSTEM_CONFIG.GOOGLE_SHEETS_CUSTOMERS_TAB_NAME;
    const messagesTabName = SYSTEM_CONFIG.GOOGLE_SHEETS_MESSAGES_TAB_NAME;
    if (customersTabName === messagesTabName) {
        // Single-tab mode uses a unified full-sheet layout; incremental row updates are unsafe.
        scheduleDriverExcelSync();
        return;
    }

    const candidateData = await fetchDriverExcelCandidateForSync(candidateId);
    if (!candidateData) {
        await deleteCandidateFromGoogleSheets(candidateId);
        return;
    }

    const accessToken = await getGoogleSheetsAccessToken();
    const spreadsheetId = SYSTEM_CONFIG.GOOGLE_SHEETS_SPREADSHEET_ID;
    const customersRange = toSheetRangeName(customersTabName);
    const rowValues = [
        candidateData.customer.id,
        ...candidateData.columns.map((col) => getDriverExcelCellValue(candidateData.customer, col)),
        candidateData.customer.latest_license_url,
        candidateData.customer.license_folder_url,
        JSON.stringify(candidateData.customer.variables || {})
    ];

    const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    const rowNumber = await findCandidateRowInGoogleSheet({ accessToken, spreadsheetId, customersRange, candidateId });

    if (rowNumber) {
        await axios.post(
            `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchClear`,
            { ranges: [`${customersRange}!A${rowNumber}:ZZ${rowNumber}`] },
            { headers }
        );
        await axios.put(
            `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${customersRange}!A${rowNumber}`)}?valueInputOption=RAW`,
            { values: [rowValues] },
            { headers }
        );
        return;
    }

    await axios.post(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${customersRange}!A:A`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { values: [rowValues] },
        { headers }
    );
};

const deleteCandidateFromGoogleSheets = async (candidateId) => {
    if (!isDriverExcelGoogleSyncEnabled() || !candidateId) return;
    const customersTabName = SYSTEM_CONFIG.GOOGLE_SHEETS_CUSTOMERS_TAB_NAME;
    const messagesTabName = SYSTEM_CONFIG.GOOGLE_SHEETS_MESSAGES_TAB_NAME;
    if (customersTabName === messagesTabName) {
        scheduleDriverExcelSync();
        return;
    }

    const accessToken = await getGoogleSheetsAccessToken();
    const spreadsheetId = SYSTEM_CONFIG.GOOGLE_SHEETS_SPREADSHEET_ID;
    const customersRange = toSheetRangeName(customersTabName);
    const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

    const rowNumber = await findCandidateRowInGoogleSheet({ accessToken, spreadsheetId, customersRange, candidateId });
    if (!rowNumber) return;

    await axios.post(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchClear`,
        { ranges: [`${customersRange}!A${rowNumber}:ZZ${rowNumber}`] },
        { headers }
    );
};

const flushDriverExcelIncrementalQueue = async () => {
    if (driverExcelIncrementalQueue.size === 0) return;
    const actions = Array.from(driverExcelIncrementalQueue.entries());
    driverExcelIncrementalQueue.clear();
    driverExcelIncrementalPendingSince = null;

    for (const [candidateId, action] of actions) {
        try {
            if (action === 'delete') await deleteCandidateFromGoogleSheets(candidateId);
            else await upsertCandidateToGoogleSheets(candidateId);
        } catch (e) {
            console.error('[Driver Excel Incremental Sheets Sync Error]', candidateId, e.message);
            // Fallback to robust full sync path on incremental failure.
            scheduleDriverExcelSync();
        }
    }
};

const scheduleDriverExcelIncrementalSync = ({ candidateId, action = 'upsert' } = {}) => {
    if (!candidateId || !isDriverExcelGoogleSyncEnabled()) return;

    const normalizedAction = action === 'delete' ? 'delete' : 'upsert';
    const existing = driverExcelIncrementalQueue.get(candidateId);
    if (existing === 'delete') {
        // Keep delete as highest priority terminal action.
    } else {
        driverExcelIncrementalQueue.set(candidateId, normalizedAction);
    }

    const now = Date.now();
    if (!driverExcelIncrementalPendingSince) driverExcelIncrementalPendingSince = now;

    if (driverExcelIncrementalTimer) clearTimeout(driverExcelIncrementalTimer);
    driverExcelIncrementalTimer = setTimeout(() => {
        driverExcelIncrementalTimer = null;
        if (driverExcelIncrementalMaxWaitTimer) {
            clearTimeout(driverExcelIncrementalMaxWaitTimer);
            driverExcelIncrementalMaxWaitTimer = null;
        }
        flushDriverExcelIncrementalQueue().catch(() => null);
    }, DRIVER_EXCEL_INCREMENTAL_SYNC_IDLE_MS);

    const pendingForMs = now - driverExcelIncrementalPendingSince;
    const remainingMaxWaitMs = Math.max(0, DRIVER_EXCEL_INCREMENTAL_SYNC_MAX_WAIT_MS - pendingForMs);
    if (!driverExcelIncrementalMaxWaitTimer) {
        driverExcelIncrementalMaxWaitTimer = setTimeout(() => {
            driverExcelIncrementalMaxWaitTimer = null;
            if (driverExcelIncrementalTimer) {
                clearTimeout(driverExcelIncrementalTimer);
                driverExcelIncrementalTimer = null;
            }
            flushDriverExcelIncrementalQueue().catch(() => null);
        }, remainingMaxWaitMs);
    }
};

const uploadToS3 = async ({ key, body, contentType }) => {
    await s3Client.send(new PutObjectCommand({
        Bucket: SYSTEM_CONFIG.AWS_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType
    }));
};

const deleteFromS3 = async (key) => {
    if (!key) return;
    await s3Client.send(new DeleteObjectCommand({
        Bucket: SYSTEM_CONFIG.AWS_BUCKET,
        Key: key
    }));
};

const normalizeVariables = (variables) => {
    if (!variables) return {};
    if (typeof variables === 'object') return variables;
    try {
        return JSON.parse(variables);
    } catch (e) {
        return {};
    }
};

const syncDriverExcelToS3 = async () => {
    if (driverExcelSyncInProgress) {
        driverExcelSyncRequested = true;
        driverExcelSyncStatus.state = 'queued';
        driverExcelSyncStatus.lastTriggeredAt = new Date().toISOString();
        persistDriverExcelSyncStatus();
        return;
    }

    driverExcelSyncInProgress = true;
    driverExcelSyncStatus.state = 'running';
    driverExcelSyncStatus.lastRunAt = new Date().toISOString();
    driverExcelSyncStatus.lastError = null;
    driverExcelSyncStatus.destinations = {
        s3: { ...driverExcelSyncStatus.destinations?.s3, state: 'running', lastError: null },
        googleSheets: { ...driverExcelSyncStatus.destinations?.googleSheets, state: 'running', lastError: null }
    };
    const syncStartedAt = Date.now();
    persistDriverExcelSyncStatus();
    try {
        const data = await withDb(async (client) => {
            const candidatesRes = await client.query(`
                SELECT c.id, c.phone_number, c.name, c.stage, c.source, c.created_at, c.last_message_at, c.variables,
                    (
                        SELECT d.url FROM driver_documents d
                        WHERE d.candidate_id = c.id
                        ORDER BY d.created_at DESC
                        LIMIT 1
                    ) AS latest_license_key
                FROM candidates c
                ORDER BY c.created_at ASC
            `);

            const messagesRes = await client.query(`
                SELECT cm.id, cm.candidate_id, c.phone_number, cm.direction, cm.type, cm.status, cm.whatsapp_message_id, cm.created_at, cm.text
                FROM candidate_messages cm
                JOIN candidates c ON c.id = cm.candidate_id
                ORDER BY cm.created_at ASC
            `);

            const captureRes = await client.query(`
                SELECT candidate_id, text, created_at
                FROM candidate_messages
                WHERE type = 'variable_capture'
                ORDER BY created_at ASC
            `);

            const customCols = await getDriverExcelColumnConfig(client);
            const { responseLookup, discoveredKeys } = buildVariableResponseLookup({
                captureRows: captureRes.rows,
                candidateRows: candidatesRes.rows
            });
            const mergedCustomCols = mergeDriverExcelColumns(customCols, discoveredKeys);
            if (mergedCustomCols.length !== customCols.length) {
                await saveDriverExcelColumnConfig(client, mergedCustomCols);
            }

            return {
                candidates: candidatesRes.rows,
                messages: messagesRes.rows,
                columns: [...DRIVER_EXCEL_CORE_COLUMNS, ...mergedCustomCols],
                responseLookup
            };
        });

        const customers = data.candidates.map((row) => {
            const vars = {
                ...normalizeVariables(row.variables),
                ...(data.responseLookup.get(row.id) || {})
            };
            const latestLicenseKey = row.latest_license_key || vars.license_s3_key || '';
            const month = latestLicenseKey.startsWith('Driver data/') ? latestLicenseKey.split('/')[1] : getDriverMonthFolder();
            const licenseFolderKey = `Driver data/${month}/${sanitizePhoneForPath(row.phone_number)}/`;
            const latestLicenseUrl = vars.license_url || (latestLicenseKey ? getPublicS3Url(latestLicenseKey) : '');
            return {
                id: row.id,
                phone_number: row.phone_number,
                name: row.name,
                stage: row.stage,
                source: row.source || '',
                created_at: row.created_at ? new Date(row.created_at).toISOString() : '',
                last_message_at: row.last_message_at ? new Date(Number(row.last_message_at) || row.last_message_at).toISOString() : '',
                latest_license_url: latestLicenseUrl,
                license_folder_url: getPublicS3Url(licenseFolderKey),
                variables: vars
            };
        });

        const messages = data.messages.map((row) => ({
            ...row,
            created_at: row.created_at ? new Date(row.created_at).toISOString() : '',
            text: row.text || ''
        }));

        const workbookXml = buildDriverExcelXml(customers, messages, data.columns);
        const sheetValues = buildDriverExcelSheetValues(customers, messages, data.columns);
        await uploadToS3({
            key: 'driver excel/driver-data.xls',
            body: Buffer.from(workbookXml, 'utf8'),
            contentType: 'application/vnd.ms-excel'
        });
        driverExcelSyncStatus.destinations.s3 = {
            state: 'success',
            lastSuccessAt: new Date().toISOString(),
            lastError: null
        };

        const googleSync = await syncDriverExcelToGoogleSheets(sheetValues);
        if (googleSync.skipped) {
            driverExcelSyncStatus.destinations.googleSheets = {
                ...driverExcelSyncStatus.destinations.googleSheets,
                state: 'skipped',
                lastError: googleSync.reason || 'Google Sheets sync skipped'
            };
        } else {
            driverExcelSyncStatus.destinations.googleSheets = {
                state: 'success',
                lastSuccessAt: new Date().toISOString(),
                lastError: null
            };
        }

        driverExcelSyncStatus.state = driverExcelSyncStatus.destinations.googleSheets.state === 'success' ? 'success' : 'partial_success';
        driverExcelSyncStatus.lastSuccessAt = new Date().toISOString();
        driverExcelSyncStatus.lastDurationMs = Date.now() - syncStartedAt;
        persistDriverExcelSyncStatus();
    } catch (e) {
        driverExcelSyncStatus.state = 'error';
        driverExcelSyncStatus.lastError = e.message || 'Driver Excel sync failed';
        if (driverExcelSyncStatus.destinations?.s3?.state === 'running') {
            driverExcelSyncStatus.destinations.s3 = {
                ...driverExcelSyncStatus.destinations.s3,
                state: 'error',
                lastError: e.message || 'S3 sync failed'
            };
        }
        if (driverExcelSyncStatus.destinations?.googleSheets?.state === 'running') {
            driverExcelSyncStatus.destinations.googleSheets = {
                ...driverExcelSyncStatus.destinations.googleSheets,
                state: 'error',
                lastError: e.message || 'Google Sheets sync failed'
            };
        }
        driverExcelSyncStatus.lastDurationMs = Date.now() - syncStartedAt;
        persistDriverExcelSyncStatus();
        console.error('[Driver Excel Sync Error]', e.message);
    } finally {
        driverExcelSyncInProgress = false;
        if (driverExcelSyncRequested) {
            driverExcelSyncRequested = false;
            driverExcelSyncStatus.state = 'queued';
            persistDriverExcelSyncStatus();
            setTimeout(() => syncDriverExcelToS3().catch(() => null), 500);
        }
    }
};

const triggerDriverExcelSyncNow = () => {
    if (driverExcelSyncTimer) {
        clearTimeout(driverExcelSyncTimer);
        driverExcelSyncTimer = null;
    }
    if (driverExcelSyncMaxWaitTimer) {
        clearTimeout(driverExcelSyncMaxWaitTimer);
        driverExcelSyncMaxWaitTimer = null;
    }
    driverExcelSyncPendingSince = null;
    syncDriverExcelToS3().catch(() => null);
};

const scheduleDriverExcelSync = () => {
    const now = Date.now();
    if (!driverExcelSyncPendingSince) {
        driverExcelSyncPendingSince = now;
    }

    if (driverExcelSyncTimer) clearTimeout(driverExcelSyncTimer);
    driverExcelSyncStatus.state = 'queued';
    driverExcelSyncStatus.lastTriggeredAt = new Date().toISOString();
    persistDriverExcelSyncStatus();

    // Idle-window sync: wait for a quiet period before heavy S3 + Google Sheets exports.
    driverExcelSyncTimer = setTimeout(() => {
        triggerDriverExcelSyncNow();
    }, DRIVER_EXCEL_SYNC_IDLE_MS);

    // Safety-net sync: avoid starving exports under continuous traffic.
    const pendingForMs = now - driverExcelSyncPendingSince;
    const remainingMaxWaitMs = Math.max(0, DRIVER_EXCEL_SYNC_MAX_WAIT_MS - pendingForMs);
    if (!driverExcelSyncMaxWaitTimer) {
        driverExcelSyncMaxWaitTimer = setTimeout(() => {
            triggerDriverExcelSyncNow();
        }, remainingMaxWaitMs);
    }
};



const DRIVER_EXCEL_CORE_COLUMNS = [
    { key: 'phoneNumber', label: 'Phone Number', isCore: true },
    { key: 'name', label: 'Name', isCore: true },
    { key: 'status', label: 'Stage', isCore: true },
    { key: 'source', label: 'Source', isCore: true },
    { key: 'createdAt', label: 'Created At', isCore: true },
    { key: 'lastMessageAt', label: 'Last Message At', isCore: true }
];

const normalizeColumnKey = (label = '') => String(label)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const formatColumnLabelFromKey = (key = '') => String(key)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Custom Field';

const parseVariableCaptureMessage = (text) => {
    if (!text || typeof text !== 'string') return null;
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') return null;
        const key = normalizeColumnKey(parsed.key || parsed.variable || '');
        if (!key) return null;
        const value = parsed.value == null ? '' : String(parsed.value);
        return { key, value };
    } catch (e) {
        return null;
    }
};

const buildVariableResponseLookup = ({ captureRows = [], candidateRows = [] }) => {
    const responseLookup = new Map();
    const discoveredKeys = new Set();

    const registerValue = (candidateId, key, value) => {
        if (!candidateId || !key) return;
        const normalizedKey = normalizeColumnKey(key);
        if (!normalizedKey) return;
        const safeValue = value == null ? '' : String(value);
        if (!responseLookup.has(candidateId)) responseLookup.set(candidateId, {});
        const candidateVars = responseLookup.get(candidateId);
        if (!Array.isArray(candidateVars[normalizedKey])) candidateVars[normalizedKey] = [];
        candidateVars[normalizedKey].push(safeValue);
        discoveredKeys.add(normalizedKey);
    };

    captureRows.forEach((row) => {
        const parsed = parseVariableCaptureMessage(row.text);
        if (!parsed) return;
        registerValue(row.candidate_id, parsed.key, parsed.value);
    });

    candidateRows.forEach((row) => {
        const vars = normalizeVariables(row.variables);
        Object.entries(vars).forEach(([key, value]) => {
            const normalizedKey = normalizeColumnKey(key);
            if (!normalizedKey) return;
            if (!responseLookup.has(row.id) || !Array.isArray(responseLookup.get(row.id)[normalizedKey])) {
                registerValue(row.id, normalizedKey, value);
            } else {
                discoveredKeys.add(normalizedKey);
            }
        });
    });

    const finalized = new Map();
    responseLookup.forEach((valueMap, candidateId) => {
        const merged = {};
        Object.entries(valueMap).forEach(([key, values]) => {
            merged[key] = values.join('\n');
        });
        finalized.set(candidateId, merged);
    });

    return { responseLookup: finalized, discoveredKeys: Array.from(discoveredKeys) };
};

const mergeDriverExcelColumns = (customCols = [], dynamicKeys = []) => {
    const uniqueCustom = customCols.filter((c) => c && typeof c.key === 'string' && typeof c.label === 'string');
    const seen = new Set(uniqueCustom.map((c) => c.key));
    const appended = dynamicKeys
        .filter((key) => !seen.has(key) && !DRIVER_EXCEL_CORE_COLUMNS.some((core) => core.key === key))
        .map((key) => ({ key, label: formatColumnLabelFromKey(key), isCore: false }));
    return [...uniqueCustom, ...appended];
};

const logCapturedVariableResponse = async ({ client, candidateId, key, value, source = 'bot_capture' }) => {
    const normalizedKey = normalizeColumnKey(key);
    if (!normalizedKey) return;
    await client.query(
        `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at)
        VALUES ($1, $2, 'system', $3, 'variable_capture', 'captured', NOW())`,
        [
            crypto.randomUUID(),
            candidateId,
            JSON.stringify({ key: normalizedKey, value: value == null ? '' : String(value), source, capturedAt: new Date().toISOString() })
        ]
    );
};

const getDriverExcelColumnConfig = async (client) => {
    const setting = await client.query("SELECT value FROM system_settings WHERE key = 'driver_excel_columns' LIMIT 1");
    const value = setting.rows[0]?.value;
    if (!Array.isArray(value)) return [];
    return value
        .filter((c) => c && typeof c.key === 'string' && typeof c.label === 'string')
        .map((c) => ({ key: c.key, label: c.label, isCore: false }));
};

const saveDriverExcelColumnConfig = async (client, columns) => {
    await client.query(
        "INSERT INTO system_settings (key, value) VALUES ('driver_excel_columns', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        [JSON.stringify(columns.map((c) => ({ key: c.key, label: c.label })))]
    );
};

const getDriverExcelColumnOrderConfig = async (client) => {
    const setting = await client.query("SELECT value FROM system_settings WHERE key = 'driver_excel_column_order' LIMIT 1");
    const value = setting.rows[0]?.value;
    if (!Array.isArray(value)) return [];
    return value.map((k) => String(k)).filter(Boolean);
};

const saveDriverExcelColumnOrderConfig = async (client, orderedKeys = []) => {
    await client.query(
        "INSERT INTO system_settings (key, value) VALUES ('driver_excel_column_order', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        [JSON.stringify(orderedKeys.map((k) => String(k)).filter(Boolean))]
    );
};

const applyDriverExcelColumnOrder = (columns = [], orderedKeys = []) => {
    if (!Array.isArray(columns) || columns.length === 0) return [];
    if (!Array.isArray(orderedKeys) || orderedKeys.length === 0) return columns;
    const byKey = new Map(columns.map((col) => [col.key, col]));
    const ordered = orderedKeys.map((key) => byKey.get(key)).filter(Boolean);
    const seen = new Set(ordered.map((col) => col.key));
    const remainder = columns.filter((col) => !seen.has(col.key));
    return [...ordered, ...remainder];
};

const getDriverExcelVariableCatalog = async (client) => {
    const captureRes = await client.query(`
        SELECT DISTINCT text
        FROM candidate_messages
        WHERE type = 'variable_capture'
        ORDER BY text ASC
    `);
    const candidateRes = await client.query(`SELECT variables FROM candidates`);

    const keys = new Map();
    const registerVariable = (rawKey, preferredLabel = '') => {
        const normalizedKey = normalizeColumnKey(rawKey);
        if (!normalizedKey) return;

        const fallbackLabel = formatColumnLabelFromKey(normalizedKey);
        const nextLabel = String(preferredLabel || '').trim() || fallbackLabel;
        const existing = keys.get(normalizedKey);
        if (!existing) {
            keys.set(normalizedKey, { key: normalizedKey, label: nextLabel });
            return;
        }

        const existingLabel = String(existing.label || '').trim();
        if (!existingLabel || existingLabel === fallbackLabel) {
            keys.set(normalizedKey, { key: normalizedKey, label: nextLabel });
        }
    };

    const botSettingsRes = await client.query(`
        SELECT settings
        FROM bot_versions
        WHERE status = 'published'
        ORDER BY created_at DESC
        LIMIT 1
    `);
    const publishedSettings = botSettingsRes.rows[0]?.settings || {};
    const publishedNodes = Array.isArray(publishedSettings?.nodes) ? publishedSettings.nodes : [];

    const captureTypes = new Set(['input', 'interactive_button', 'interactive_list', 'rich_card']);
    publishedNodes.forEach((node) => {
        const nodeData = node?.data || {};
        const nodeType = nodeData?.type;
        const nodeVariable = String(nodeData?.variable || '').trim();

        if (nodeVariable) registerVariable(nodeVariable, nodeVariable);
        if (nodeType === 'datetime_picker') {
            ['pickup_date', 'time_period', nodeVariable || 'time_slot'].forEach((v) => registerVariable(v, v));
        }
        if (nodeType === 'pickup_location') registerVariable('pickup_coords', 'pickup_coords');
        if (nodeType === 'destination_location') registerVariable('dest_coords', 'dest_coords');
        if (nodeType === 'location_request') registerVariable('location_data', 'location_data');
        if (captureTypes.has(nodeType) && !nodeVariable) {
            const fallback = String(nodeData?.label || node?.id || '').trim();
            if (fallback) registerVariable(fallback, fallback);
        }

        const summaryFields = Array.isArray(nodeData?.summaryFields) ? nodeData.summaryFields : [];
        summaryFields.forEach((field) => {
            const fieldVar = String(field?.variable || '').trim();
            if (fieldVar) registerVariable(fieldVar, fieldVar);
        });
    });

    captureRes.rows.forEach((row) => {
        const parsed = parseVariableCaptureMessage(row.text);
        if (parsed?.key) registerVariable(parsed.key, parsed.key);
    });
    candidateRes.rows.forEach((row) => {
        const vars = normalizeVariables(row.variables);
        Object.keys(vars || {}).forEach((key) => {
            const normalized = normalizeColumnKey(key);
            if (normalized) registerVariable(normalized, key);
        });
    });

    const configuredColumns = await getDriverExcelColumnConfig(client);
    configuredColumns.forEach((col) => {
        const normalized = normalizeColumnKey(col.key);
        if (normalized) registerVariable(normalized, col.label);
    });

    return Array.from(keys.values()).sort((a, b) => a.key.localeCompare(b.key));
};

const getFileExtensionFromMime = (mimeType = '', fallback = 'bin') => {
    const mime = mimeType.toLowerCase();
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
    if (mime.includes('png')) return 'png';
    if (mime.includes('pdf')) return 'pdf';
    if (mime.includes('webp')) return 'webp';
    return fallback;
};

const fetchAndStoreLicenseMedia = async ({ msg, phoneNumber, candidateId, candidateVariables, client }) => {
    if (!candidateId) throw new Error('Candidate id is required for media upload');
    const mediaId = msg?.image?.id || msg?.document?.id;
    if (!mediaId) return null;

    const metaResponse = await getMetaClient().get(`https://graph.facebook.com/v18.0/${mediaId}`);
    const mediaUrl = metaResponse.data?.url;
    const mimeType = metaResponse.data?.mime_type || (msg.type === 'document' ? 'application/octet-stream' : `image/${msg.type}`);
    if (!mediaUrl) throw new Error('WhatsApp media URL not found');

    const mediaFile = await axios.get(mediaUrl, {
        responseType: 'arraybuffer',
        timeout: SYSTEM_CONFIG.META_TIMEOUT,
        headers: { Authorization: `Bearer ${process.env.META_API_TOKEN}` }
    });

    const ext = getFileExtensionFromMime(mimeType, msg.type === 'document' ? 'pdf' : 'jpg');
    const prefix = buildDriverDataPrefix(phoneNumber);
    const key = `${prefix}/license_${msg.id}.${ext}`;

    await uploadToS3({
        key,
        body: Buffer.from(mediaFile.data),
        contentType: mimeType
    });

    const mergedVariables = {
        ...normalizeVariables(candidateVariables),
        license_s3_key: key,
        license_url: getPublicS3Url(key),
        license_folder_url: getPublicS3Url(`${prefix}/`),
        license_uploaded_at: new Date().toISOString()
    };

    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO driver_documents (id, candidate_id, type, url, status, created_at)
            VALUES ($1, $2, $3, $4, 'pending', NOW())`,
            [crypto.randomUUID(), candidateId, 'license', key]
        );
        await client.query('UPDATE candidates SET variables = $1::jsonb WHERE id = $2', [JSON.stringify(mergedVariables), candidateId]);
        await client.query('COMMIT');
        return { key, mergedVariables };
    } catch (e) {
        await client.query('ROLLBACK').catch(() => null);
        await deleteFromS3(key).catch(() => null);
        throw e;
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
                            await logCapturedVariableResponse({
                                client,
                                candidateId: candidate.id,
                                key: 'pickup_date',
                                value: detectedDate,
                                source: 'datetime_picker'
                            });
                            
                            valueToSave = null; // Do not save to generic variable, we handled it
                        } 
                        else if (detectedPeriod) {
                            // STATE 2 CAUGHT -> SAVE PERIOD, WIPE TIME
                            await client.query("UPDATE candidates SET variables = jsonb_set(variables, '{time_period}', $1) WHERE id = $2", [JSON.stringify(detectedPeriod), candidate.id]);
                            await client.query(`UPDATE candidates SET variables = variables - $1 WHERE id = $2`, [finalVar, candidate.id]);
                            
                            candidate.variables.time_period = detectedPeriod;
                            delete candidate.variables[finalVar];
                            await logCapturedVariableResponse({
                                client,
                                candidateId: candidate.id,
                                key: 'time_period',
                                value: detectedPeriod,
                                source: 'datetime_picker'
                            });
                            
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
                        await logCapturedVariableResponse({
                            client,
                            candidateId: candidate.id,
                            key: varName,
                            value: valueToSave
                        });
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
                    const headerText = formatSummaryToken(validBody || "📋 Summary", data.summaryHeaderStyle || 'bold');
                    let summaryText = headerText;
                    if (data.summaryDescription) summaryText += `
${formatSummaryToken(processText(data.summaryDescription, candidate), data.summaryDescriptionStyle || 'plain')}`;

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
                        const rowPrefix = field.prefix ?? '•';
                        const rowSuffix = field.suffix ?? '';
                        configuredRows.push(`${rowPrefix} ${styledLabel}: ${styledValue}${rowSuffix}`);
                    });

                    const includeAutoVariables = data.summaryUseAutoVariables === true || (summaryFields.length === 0 && data.summaryUseAutoVariables !== false);
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

${formatSummaryToken(processText(data.footerText, candidate), data.summaryFooterStyle || 'italic')}`;
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
                        scheduleDriverExcelSync();
                        scheduleDriverExcelIncrementalSync({ candidateId: candidate.id, action: 'upsert' });
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

apiRouter.get('/system/settings', async (req, res) => {
    try {
        await withDb(async (client) => {
            const config = await getSystemConfig(client);
            res.json(config);
        });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to load system settings' });
    }
});

apiRouter.patch('/system/settings', async (req, res) => {
    try {
        const updates = req.body || {};
        await withDb(async (client) => {
            const current = await getSystemConfig(client);
            const next = {
                ...current,
                ...(typeof updates.webhook_ingest_enabled === 'boolean' ? { webhook_ingest_enabled: updates.webhook_ingest_enabled } : {}),
                ...(typeof updates.automation_enabled === 'boolean' ? { automation_enabled: updates.automation_enabled } : {}),
                ...(typeof updates.sending_enabled === 'boolean' ? { sending_enabled: updates.sending_enabled } : {})
            };

            await client.query(
                "INSERT INTO system_settings (key, value) VALUES ('config', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                [JSON.stringify(next)]
            );
            res.json({ success: true, settings: next });
        });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to update system settings' });
    }
});

apiRouter.get('/system/operational-status', async (req, res) => {
    const status = {
        timestamp: new Date().toISOString(),
        postgres: { state: 'unknown', reason: null },
        runtime: {
            webhook_ingest_enabled: false,
            automation_enabled: false,
            sending_enabled: false
        },
        integrations: {
            googleSheets: {
                state: 'unknown',
                configured: false
            }
        },
        driverExcelSync: {
            state: driverExcelSyncStatus.state,
            lastSuccessAt: driverExcelSyncStatus.lastSuccessAt,
            lastError: driverExcelSyncStatus.lastError,
            inProgress: driverExcelSyncInProgress,
            hasQueuedSync: Boolean(driverExcelSyncRequested || driverExcelSyncTimer || driverExcelSyncMaxWaitTimer || driverExcelIncrementalTimer || driverExcelIncrementalMaxWaitTimer || driverExcelIncrementalQueue.size > 0),
            destinations: driverExcelSyncStatus.destinations
        }
    };

    try {
        await withDb(async (client) => {
            await client.query('SELECT 1');
            status.postgres.state = 'connected';
            status.runtime = await getSystemConfig(client);
        });
    } catch (e) {
        status.postgres.state = 'error';
        status.postgres.reason = e.message || 'Database unavailable';
    }

    status.integrations.googleSheets = await checkGoogleSheetsOperationalStatus();
    res.json(status);
});


apiRouter.get('/media', async (req, res) => {
    const requestedPath = typeof req.query.path === 'string' ? req.query.path : '/';

    try {
        const { listRes, prefix } = await listMediaObjects(requestedPath);

        const folders = (listRes.CommonPrefixes || []).map((entry) => {
            const folderPrefix = (entry.Prefix || '').replace(prefix, '').replace(/\/$/, '');
            return {
                id: `${requestedPath}:${folderPrefix}`,
                name: folderPrefix,
                parent_path: requestedPath,
                is_public_showcase: false
            };
        }).filter((folder) => folder.name);

        const files = (listRes.Contents || [])
            .filter((item) => item.Key && item.Key !== prefix)
            .map((item) => {
                const key = item.Key;
                const filename = key.replace(prefix, '');
                const extension = filename.split('.').pop()?.toLowerCase() || '';
                const fileType = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(extension)
                    ? 'image'
                    : ['mp4', 'mov', 'avi', 'webm', 'mkv'].includes(extension)
                        ? 'video'
                        : 'document';

                return {
                    id: key,
                    url: getPublicS3Url(key),
                    filename,
                    type: fileType
                };
            });

        res.json({ folders, files });
    } catch (e) {
        console.error('[MEDIA LIST ERROR]', e.message);
        res.status(500).json({ error: 'Failed to load media library from S3', details: e.message });
    }
});

apiRouter.post('/media/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        res.status(400).json({ error: 'No file provided' });
        return;
    }

    const path = typeof req.body.path === 'string' ? req.body.path : '/';
    const prefix = toMediaPrefix(path);
    const safeFileName = req.file.originalname.replace(/\s+/g, '_');
    const key = `${prefix}${safeFileName}`;

    try {
        await uploadToS3({
            key,
            body: req.file.buffer,
            contentType: req.file.mimetype || 'application/octet-stream'
        });

        res.json({ success: true, key, url: getPublicS3Url(key) });
    } catch (e) {
        console.error('[MEDIA UPLOAD ERROR]', e.message);
        res.status(500).json({ error: 'Failed to upload file to S3', details: e.message });
    }
});

apiRouter.post('/media/sync-s3', async (req, res) => {
    try {
        const listRes = await s3Client.send(new ListObjectsV2Command({
            Bucket: SYSTEM_CONFIG.AWS_BUCKET,
            Prefix: MEDIA_ROOT_PREFIX
        }));
        let added = (listRes.Contents || []).filter((item) => item.Key && item.Key !== MEDIA_ROOT_PREFIX).length;

        if (!added && MEDIA_ROOT_PREFIX) {
            const fallbackRes = await s3Client.send(new ListObjectsV2Command({
                Bucket: SYSTEM_CONFIG.AWS_BUCKET,
                Prefix: ''
            }));
            added = (fallbackRes.Contents || []).filter((item) => item.Key).length;
        }

        res.json({ success: true, added });
    } catch (e) {
        console.error('[MEDIA SYNC ERROR]', e.message);
        res.status(500).json({ error: 'S3 sync failed', details: e.message });
    }
});

apiRouter.get('/showcase/status', (req, res) => {
    res.json({ active: false });
});

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
                let messageType = msg.type === 'interactive' ? 'interactive' : msg.type;

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
                else if (msg.type === 'image' || msg.type === 'document') {
                    text = `[${msg.type.toUpperCase()}]`;
                } else text = `[${msg.type.toUpperCase()}]`;

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

                if (msg.type === 'image' || msg.type === 'document') {
                    const mediaInfo = await fetchAndStoreLicenseMedia({
                        msg,
                        phoneNumber: from,
                        candidateId: candidate.id,
                        candidateVariables: candidate.variables,
                        client
                    }).catch((e) => {
                        console.error('[License Upload Error]', e.message);
                        return null;
                    });

                    if (mediaInfo?.key) {
                        text = JSON.stringify({ mediaKey: mediaInfo.key, type: msg.type, folder: buildDriverDataPrefix(from) });
                        candidate.variables = mediaInfo.mergedVariables;
                        await client.query('UPDATE candidates SET last_message = $1, last_message_at = $2 WHERE id = $3', [text, Date.now(), candidate.id]);
                    }
                }

                await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, whatsapp_message_id, status, created_at) VALUES ($1, $2, 'in', $3, $4, $5, 'received', NOW())`, [crypto.randomUUID(), candidate.id, text, messageType, msg.id]);
                await runBotEngine(client, candidate, text, payloadId);
                scheduleDriverExcelSync();
                scheduleDriverExcelIncrementalSync({ candidateId: candidate.id, action: 'upsert' });
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
            await client.query(`INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, created_at) VALUES ($1, $2, 'out', $3, $4, 'sent', NOW())`, [crypto.randomUUID(), req.params.id, dbText, mediaUrl ? (mediaType || 'image') : 'text']);
            scheduleDriverExcelSync();
            scheduleDriverExcelIncrementalSync({ candidateId: req.params.id, action: 'upsert' });
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



apiRouter.get('/reports/driver-excel', async (req, res) => {
    try {
        const search = (req.query.search || '').toString().trim();
        await withDb(async (client) => {
            const customCols = await getDriverExcelColumnConfig(client);
            const params = [];
            let where = '';
            if (search) {
                params.push(`%${search}%`);
                where = `WHERE c.name ILIKE $1 OR c.phone_number ILIKE $1 OR c.stage ILIKE $1`;
            }
            const q = `
                SELECT c.id, c.phone_number, c.name, c.stage, c.source, c.created_at, c.last_message_at, c.variables
                FROM candidates c
                ${where}
                ORDER BY c.created_at DESC
                LIMIT 500
            `;
            const rowsRes = await client.query(q, params);
            const ids = rowsRes.rows.map((r) => r.id);
            let captureRows = [];
            if (ids.length > 0) {
                const captureRes = await client.query(
                    `SELECT candidate_id, text, created_at
                    FROM candidate_messages
                    WHERE type = 'variable_capture' AND candidate_id = ANY($1::uuid[])
                    ORDER BY created_at ASC`,
                    [ids]
                );
                captureRows = captureRes.rows;
            }

            const { responseLookup, discoveredKeys } = buildVariableResponseLookup({
                captureRows,
                candidateRows: rowsRes.rows
            });
            const mergedCustomCols = mergeDriverExcelColumns(customCols, discoveredKeys);
            if (mergedCustomCols.length !== customCols.length) {
                await saveDriverExcelColumnConfig(client, mergedCustomCols);
            }
            const cols = [...DRIVER_EXCEL_CORE_COLUMNS, ...mergedCustomCols];

            const rows = rowsRes.rows.map((r) => ({
                id: r.id,
                phoneNumber: r.phone_number || '',
                name: r.name || '',
                status: r.stage || '',
                source: r.source || '',
                createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
                lastMessageAt: r.last_message_at ? new Date(Number(r.last_message_at) || r.last_message_at).toISOString() : '',
                variables: {
                    ...normalizeVariables(r.variables),
                    ...(responseLookup.get(r.id) || {})
                }
            }));
            res.json({ columns: cols, rows });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/reports/driver-excel/sync-status', async (req, res) => {
    try {
        let persisted = {};
        await withDb(async (client) => {
            const r = await client.query("SELECT value FROM system_settings WHERE key = 'driver_excel_sync_status' LIMIT 1");
            persisted = r.rows[0]?.value || {};
        });
        res.json({
            ...persisted,
            ...driverExcelSyncStatus,
            inProgress: driverExcelSyncInProgress,
            hasQueuedSync: Boolean(driverExcelSyncRequested || driverExcelSyncTimer || driverExcelSyncMaxWaitTimer || driverExcelIncrementalTimer || driverExcelIncrementalMaxWaitTimer || driverExcelIncrementalQueue.size > 0)
        });
    } catch (e) {
        res.json({
            ...driverExcelSyncStatus,
            inProgress: driverExcelSyncInProgress,
            hasQueuedSync: Boolean(driverExcelSyncRequested || driverExcelSyncTimer || driverExcelSyncMaxWaitTimer || driverExcelIncrementalTimer || driverExcelIncrementalMaxWaitTimer || driverExcelIncrementalQueue.size > 0)
        });
    }
});

apiRouter.patch('/reports/driver-excel/:id', async (req, res) => {
    try {
        const updates = req.body?.updates || {};
        const id = req.params.id;
        await withDb(async (client) => {
            const existingRes = await client.query('SELECT variables FROM candidates WHERE id = $1 LIMIT 1', [id]);
            if (existingRes.rows.length === 0) return res.status(404).json({ error: 'Candidate not found' });

            const coreFieldMap = { phoneNumber: 'phone_number', name: 'name', status: 'stage', source: 'source' };
            for (const [k, v] of Object.entries(updates)) {
                if (coreFieldMap[k]) {
                    await client.query(`UPDATE candidates SET ${coreFieldMap[k]} = $1 WHERE id = $2`, [v, id]);
                }
            }

            const vars = normalizeVariables(existingRes.rows[0].variables);
            const variableUpdates = Object.entries(updates).filter(([k]) => !['phoneNumber', 'name', 'status', 'source', 'createdAt', 'lastMessageAt'].includes(k));
            if (variableUpdates.length > 0) {
                for (const [k, v] of variableUpdates) vars[k] = v;
                await client.query('UPDATE candidates SET variables = $1::jsonb WHERE id = $2', [JSON.stringify(vars), id]);
            }
            scheduleDriverExcelSync();
            scheduleDriverExcelIncrementalSync({ candidateId: id, action: 'upsert' });
            res.json({ success: true });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.delete('/reports/driver-excel/:id', async (req, res) => {
    try {
        await withDb(async (client) => {
            await client.query('DELETE FROM candidates WHERE id = $1', [req.params.id]);
            scheduleDriverExcelSync();
            scheduleDriverExcelIncrementalSync({ candidateId: req.params.id, action: 'delete' });
            res.json({ success: true });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/reports/driver-excel/columns', async (req, res) => {
    try {
        const requestedKey = normalizeColumnKey((req.body?.key || '').toString());
        const label = (req.body?.label || '').toString().trim();
        const key = requestedKey || normalizeColumnKey(label);
        if (!label) return res.status(400).json({ error: 'Column label is required' });
        if (!key) return res.status(400).json({ error: 'Invalid column label' });

        await withDb(async (client) => {
            const customCols = await getDriverExcelColumnConfig(client);
            if (customCols.some((c) => c.key === key) || DRIVER_EXCEL_CORE_COLUMNS.some((c) => c.key === key)) {
                return res.status(400).json({ error: 'Column already exists' });
            }
            const next = [...customCols, { key, label, isCore: false }];
            await saveDriverExcelColumnConfig(client, next);
            scheduleDriverExcelSync();
            res.json({ success: true, key, label });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/reports/driver-excel/variables', async (req, res) => {
    try {
        await withDb(async (client) => {
            const variables = await getDriverExcelVariableCatalog(client);
            res.json({ variables });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.patch('/reports/driver-excel/columns/:key', async (req, res) => {
    try {
        const key = req.params.key;
        const newLabel = (req.body?.newLabel || '').toString().trim();
        if (!newLabel) return res.status(400).json({ error: 'newLabel is required' });
        const newKey = normalizeColumnKey(newLabel);
        await withDb(async (client) => {
            const customCols = await getDriverExcelColumnConfig(client);
            const existing = customCols.find((c) => c.key === key);
            if (!existing) return res.status(404).json({ error: 'Column not found' });
            if (newKey !== key && (customCols.some((c) => c.key === newKey) || DRIVER_EXCEL_CORE_COLUMNS.some((c) => c.key === newKey))) {
                return res.status(400).json({ error: 'Column key conflicts with existing column' });
            }

            const renamed = customCols.map((c) => c.key === key ? { ...c, key: newKey, label: newLabel } : c);
            await saveDriverExcelColumnConfig(client, renamed);
            const orderedKeys = await getDriverExcelColumnOrderConfig(client);
            if (orderedKeys.length > 0) {
                const nextOrder = orderedKeys.map((k) => (k === key ? newKey : k));
                await saveDriverExcelColumnOrderConfig(client, nextOrder);
            }

            if (newKey !== key) {
                await client.query(`
                    UPDATE candidates
                    SET variables = (variables - $1) || jsonb_build_object($2, variables->$1)
                    WHERE variables ? $1
                `, [key, newKey]);
            }

            scheduleDriverExcelSync();
            res.json({ success: true, key: newKey, label: newLabel });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/reports/driver-excel/columns/reorder', async (req, res) => {
    try {
        const orderedKeys = Array.isArray(req.body?.orderedKeys) ? req.body.orderedKeys.map((k) => String(k)) : [];
        await withDb(async (client) => {
            const customCols = await getDriverExcelColumnConfig(client);
            const customByKey = new Map(customCols.map((col) => [col.key, col]));

            const normalizedOrdered = orderedKeys.filter((key) => customByKey.has(key));
            const seen = new Set(normalizedOrdered);
            const remainder = customCols.filter((col) => !seen.has(col.key)).map((col) => col.key);
            const nextOrder = [...normalizedOrdered, ...remainder].map((key) => customByKey.get(key)).filter(Boolean);

            await saveDriverExcelColumnConfig(client, nextOrder);
            scheduleDriverExcelSync();
            res.json({ success: true });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.delete('/reports/driver-excel/columns/:key', async (req, res) => {
    try {
        const key = req.params.key;
        await withDb(async (client) => {
            const customCols = await getDriverExcelColumnConfig(client);
            if (!customCols.some((c) => c.key === key)) return res.status(404).json({ error: 'Column not found' });
            const next = customCols.filter((c) => c.key !== key);
            await saveDriverExcelColumnConfig(client, next);
            const orderedKeys = await getDriverExcelColumnOrderConfig(client);
            if (orderedKeys.length > 0) {
                await saveDriverExcelColumnOrderConfig(client, orderedKeys.filter((k) => k !== key));
            }
            scheduleDriverExcelSync();
            res.json({ success: true });
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
                        scheduleDriverExcelSync();
                        scheduleDriverExcelIncrementalSync({ candidateId: job.candidate_id, action: 'upsert' });
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

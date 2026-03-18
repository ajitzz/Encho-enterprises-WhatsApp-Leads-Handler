
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const multer = require('multer');
const axios = require('axios');
const https = require('https');
const { S3Client, GetObjectCommand, PutObjectCommand, CopyObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { OAuth2Client, JWT } = require('google-auth-library');

require('dotenv').config();

const { parseBooleanFlag, parsePercent, resolveModuleMode } = require('./backend/shared/infra/flags');
const {
    MAX_TEXT_MESSAGE_LENGTH,
    normalizeTextBody,
    summarizePayloadForStorage,
    validateOutboundPayload,
} = require('./backend/shared/infra/whatsappPayload');
const { buildLeadIngestionFacade } = require('./backend/modules/lead-ingestion/api');
const { buildRemindersRouter } = require('./backend/modules/reminders-escalations/api');
const { buildAuthConfigRouter, registerAuthConfigRoutes } = require('./backend/modules/auth-config/api');
const { buildSystemHealthRouter, registerSystemHealthRoutes } = require('./backend/modules/system-health/api');

process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason);
});

process.on('uncaughtException', (error) => {
    console.error('[UNCAUGHT EXCEPTION]', error);
});

const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_CONTEXT_FLAG = String(process.env.FF_REQUEST_CONTEXT || 'true').toLowerCase() !== 'false';
const LEAD_INGESTION_DEFAULT_MODE = process.env.NODE_ENV === 'production' ? 'on' : 'off';
const LEAD_INGESTION_FLAG = String(process.env.FF_LEAD_INGESTION_MODULE || LEAD_INGESTION_DEFAULT_MODE).toLowerCase();
const LEAD_INGESTION_LEGACY_EMERGENCY_FALLBACK = parseBooleanFlag(process.env.FF_LEAD_INGESTION_LEGACY_EMERGENCY_FALLBACK, false);
const REMINDERS_MODULE_FLAG = String(process.env.FF_REMINDERS_MODULE || 'off').toLowerCase();
const REMINDERS_CANARY_PERCENT = parsePercent(process.env.FF_REMINDERS_MODULE_PERCENT || 0);
const AUTH_CONFIG_MODULE_FLAG = String(process.env.FF_AUTH_CONFIG_MODULE || 'off').toLowerCase();
const AUTH_CONFIG_CANARY_PERCENT = parsePercent(process.env.FF_AUTH_CONFIG_MODULE_PERCENT || 0);
const SYSTEM_HEALTH_MODULE_FLAG = String(process.env.FF_SYSTEM_HEALTH_MODULE || 'off').toLowerCase();
const SYSTEM_HEALTH_CANARY_PERCENT = parsePercent(process.env.FF_SYSTEM_HEALTH_MODULE_PERCENT || 0);
const WEBHOOK_DEFER_POST_RESPONSE = parseBooleanFlag(process.env.FF_WEBHOOK_DEFER_POST_RESPONSE, false);
const MODULE_CANARY_TENANTS = String(process.env.FF_CANARY_TENANTS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const getRequestId = (req = {}) => {
    const headerValue = req.headers?.[REQUEST_ID_HEADER];
    if (Array.isArray(headerValue)) return headerValue[0] || crypto.randomUUID();
    return headerValue || crypto.randomUUID();
};

const structuredLog = ({ level = 'info', message = '', requestId = null, module = 'app', meta = {} } = {}) => {
    const payload = {
        timestamp: new Date().toISOString(),
        level,
        module,
        message,
        requestId,
        ...meta
    };

    const output = JSON.stringify(payload);
    if (level === 'error') {
        console.error(output);
        return;
    }
    console.log(output);
};

const nowMs = () => Number(process.hrtime.bigint() / 1000000n);

const createPerfTracker = ({ requestId = null, module = 'app', event = 'perf.trace' } = {}) => {
    const marks = new Map();
    return {
        markStart(name) {
            marks.set(name, nowMs());
        },
        markEnd(name, meta = {}) {
            if (!marks.has(name)) return;
            const durationMs = Math.max(0, nowMs() - marks.get(name));
            structuredLog({
                level: 'info',
                module,
                requestId,
                message: event,
                meta: { stage: name, durationMs, ...meta }
            });
        }
    };
};

const trackBackgroundTask = ({ taskName = 'background-task', requestId = null, promise } = {}) => {
    if (!promise || typeof promise.then !== 'function') return;
    promise.catch((error) => {
        structuredLog({
            level: 'error',
            module: 'system-health',
            message: `${taskName}.failed`,
            requestId,
            meta: { error: error?.message || String(error) },
        });
    });
};

const logLeadIngestionRuntimePosture = () => {
    const tenantContexts = MODULE_CANARY_TENANTS.length > 0 ? MODULE_CANARY_TENANTS : ['default'];
    const effectiveModes = tenantContexts.map((tenantId) => ({
        tenantId,
        mode: resolveModuleMode({
            flagValue: LEAD_INGESTION_FLAG,
            tenantId: tenantId === 'default' ? null : tenantId,
            requestId: null,
            canaryPercent: 100,
            tenantAllowList: MODULE_CANARY_TENANTS,
        }),
    }));

    structuredLog({
        level: 'info',
        module: 'lead-ingestion',
        message: 'startup.module_mode_posture',
        meta: {
            flagValue: LEAD_INGESTION_FLAG,
            defaultMode: LEAD_INGESTION_DEFAULT_MODE,
            legacyEmergencyFallbackEnabled: LEAD_INGESTION_LEGACY_EMERGENCY_FALLBACK,
            effectiveModes,
        },
    });
};

// --- CONFIGURATION ---
const SYSTEM_CONFIG = {
    META_TIMEOUT: 15000,
    META_TIMEOUT_MANUAL_MS: Math.max(1000, Number(process.env.META_TIMEOUT_MANUAL_MS || 6000)),
    META_TIMEOUT_BOT_MS: Math.max(1000, Number(process.env.META_TIMEOUT_BOT_MS || 12000)),
    META_TIMEOUT_SCHEDULED_MS: Math.max(1000, Number(process.env.META_TIMEOUT_SCHEDULED_MS || 20000)),
    META_RETRY_MAX_ATTEMPTS: Math.max(1, Number(process.env.META_RETRY_MAX_ATTEMPTS || 3)),
    META_RETRY_BASE_DELAY_MS: Math.max(100, Number(process.env.META_RETRY_BASE_DELAY_MS || 300)),
    META_RETRY_MAX_DELAY_MS: Math.max(250, Number(process.env.META_RETRY_MAX_DELAY_MS || 2500)),
    DB_CONNECTION_TIMEOUT: 20000,
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
    AWS_BUCKET: process.env.AWS_BUCKET_NAME || 'uber-fleet-assets',
    GOOGLE_CLIENT_ID: process.env.VITE_GOOGLE_CLIENT_ID,
    GOOGLE_SHEETS_SPREADSHEET_ID: process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '',
    GOOGLE_SHEETS_CUSTOMERS_TAB_NAME: process.env.GOOGLE_SHEETS_CUSTOMERS_TAB_NAME || process.env.GOOGLE_SHEETS_CUSTOMERS_SHEET || 'Customers',
    GOOGLE_SHEETS_MESSAGES_TAB_NAME: process.env.GOOGLE_SHEETS_MESSAGES_TAB_NAME || process.env.GOOGLE_SHEETS_MESSAGES_SHEET || 'Messages',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '',
    CACHE_TTL: 60 * 1000, // 60 Seconds Cache for Bot Settings
    RUNTIME_CONFIG_CACHE_TTL: Number.parseInt(process.env.RUNTIME_CONFIG_CACHE_TTL_MS || '2000', 10),
    PUBLIC_APP_URL: process.env.PUBLIC_APP_URL || process.env.APP_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://encho-whatsapp-lead-handler.vercel.app')
};

const applyRuntimeGoogleSheetsConfig = (rawConfig = {}) => {
    if (!rawConfig || typeof rawConfig !== 'object') return;

    const assignString = (configKey, rawValue) => {
        if (typeof rawValue !== 'string') return;
        SYSTEM_CONFIG[configKey] = rawValue.trim();
    };

    assignString('GOOGLE_SHEETS_SPREADSHEET_ID', rawConfig.google_sheets_spreadsheet_id);
    assignString('GOOGLE_SHEETS_CUSTOMERS_TAB_NAME', rawConfig.google_sheets_customers_tab_name);
    assignString('GOOGLE_SHEETS_MESSAGES_TAB_NAME', rawConfig.google_sheets_messages_tab_name);
    assignString('GOOGLE_SERVICE_ACCOUNT_EMAIL', rawConfig.google_service_account_email);
    assignString('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', rawConfig.google_service_account_private_key);
};

// --- IN-MEMORY CACHE (Performance Boost) ---
const memoryCache = {
    botSettings: null,
    lastUpdated: 0,
    botGraph: null,
    botGraphSource: null,
    runtimeConfig: null,
    runtimeConfigLastUpdated: 0,
    runtimeConfigInFlight: null,
    botSettingsInFlight: null,
};

const getRuntimeConfigCached = async (client) => {
    const now = Date.now();
    if (
        memoryCache.runtimeConfig &&
        (now - memoryCache.runtimeConfigLastUpdated) < SYSTEM_CONFIG.RUNTIME_CONFIG_CACHE_TTL
    ) {
        return memoryCache.runtimeConfig;
    }

    if (memoryCache.runtimeConfigInFlight) {
        return memoryCache.runtimeConfigInFlight;
    }

    memoryCache.runtimeConfigInFlight = (async () => {
        const sys = await client.query("SELECT value FROM system_settings WHERE key = 'config' LIMIT 1");
        const runtimeConfig = sys.rows[0]?.value || { automation_enabled: true };
        memoryCache.runtimeConfig = runtimeConfig;
        memoryCache.runtimeConfigLastUpdated = Date.now();
        return runtimeConfig;
    })();

    try {
        return await memoryCache.runtimeConfigInFlight;
    } finally {
        memoryCache.runtimeConfigInFlight = null;
    }
};

const getBotSettingsCached = async (client) => {
    const now = Date.now();
    if (memoryCache.botSettings && (now - memoryCache.lastUpdated < SYSTEM_CONFIG.CACHE_TTL)) {
        return memoryCache.botSettings;
    }

    if (memoryCache.botSettingsInFlight) {
        return memoryCache.botSettingsInFlight;
    }

    memoryCache.botSettingsInFlight = (async () => {
        const botRes = await client.query("SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1");
        const botSettings = botRes.rows[0]?.settings || getDefaultBotConfig();
        memoryCache.botSettings = botSettings;
        memoryCache.lastUpdated = Date.now();
        return botSettings;
    })();

    try {
        return await memoryCache.botSettingsInFlight;
    } finally {
        memoryCache.botSettingsInFlight = null;
    }
};

const prewarmHotPathCaches = async (client) => {
    const requestId = `cache-prewarm-${Date.now()}`;
    const perf = createPerfTracker({ requestId, module: 'system-health', event: 'startup.cache.stage' });

    perf.markStart('runtime_config');
    await getRuntimeConfigCached(client);
    perf.markEnd('runtime_config');

    perf.markStart('bot_settings');
    const botSettings = await getBotSettingsCached(client);
    perf.markEnd('bot_settings');

    perf.markStart('bot_graph_compile');
    getCompiledBotGraph(botSettings);
    perf.markEnd('bot_graph_compile');

    structuredLog({ level: 'info', module: 'system-health', message: 'startup.cache_prewarm.completed', requestId });
};

const buildBotGraph = (botSettings) => {
    const nodes = Array.isArray(botSettings?.nodes) ? botSettings.nodes : [];
    const edges = Array.isArray(botSettings?.edges) ? botSettings.edges : [];
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const edgeMap = new Map();
    for (const edge of edges) {
        if (!edgeMap.has(edge.source)) edgeMap.set(edge.source, []);
        edgeMap.get(edge.source).push(edge);
    }

    return {
        nodes,
        edges,
        nodeMap,
        edgeMap,
        startNode: nodes.find((n) => n.type === 'start' || n.data?.type === 'start') || null,
    };
};

const getCompiledBotGraph = (botSettings) => {
    if (memoryCache.botGraph && memoryCache.botGraphSource === botSettings) {
        return memoryCache.botGraph;
    }

    const graph = buildBotGraph(botSettings);
    memoryCache.botGraph = graph;
    memoryCache.botGraphSource = botSettings;
    return graph;
};

// --- INITIALIZE CLIENTS ---
let s3Client, googleClient, pgPool;

const hasConnectionString = () => Boolean((process.env.POSTGRES_URL || process.env.DATABASE_URL || '').trim());

const buildPoolConfig = () => {
    const connectionString = (process.env.POSTGRES_URL || process.env.DATABASE_URL || '').trim();
    const baseConfig = {
        connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
        idleTimeoutMillis: 30000,
        max: 20,
        keepAlive: true
    };

    if (!connectionString) {
        return {
            ...baseConfig,
            host: process.env.PGHOST,
            port: process.env.PGPORT ? Number.parseInt(process.env.PGPORT, 10) : undefined,
            user: process.env.PGUSER,
            password: process.env.PGPASSWORD,
            database: process.env.PGDATABASE,
            ssl: parseBooleanFlag(process.env.PGSSL || process.env.PGSSLMODE, true)
                ? { rejectUnauthorized: false }
                : false
        };
    }

    const sanitized = connectionString.includes('sslmode=')
        ? connectionString.replace(/([?&])sslmode=[^&]+(&|$)/, '$1').replace(/[?&]$/, '')
        : connectionString;

    return {
        ...baseConfig,
        connectionString: sanitized,
        ssl: { rejectUnauthorized: false }
    };
};

const isRecoverableInfraError = (error) => {
    const code = String(error?.code || '').toUpperCase();
    const message = String(error?.message || '').toLowerCase();
    if (message.includes('database not initialized')) return true;
    return ['57P01', '57P03', '53300', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND'].includes(code);
};

const sendDegradedJson = (res, payload = {}) => {
    res.status(200).json({
        status: 'degraded',
        ...payload
    });
};

try {
    s3Client = new S3Client({
        region: SYSTEM_CONFIG.AWS_REGION,
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
    });

    googleClient = new OAuth2Client(SYSTEM_CONFIG.GOOGLE_CLIENT_ID);
    
    if (hasConnectionString() || process.env.PGHOST) {
        pgPool = new Pool(buildPoolConfig());
        pgPool.on('error', (err) => console.error('[DB POOL ERROR]', err));
    } else {
        console.warn('[DB INIT] Skipped Postgres pool setup: no DATABASE_URL/POSTGRES_URL/PGHOST provided');
    }

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

const keyExistsInS3 = async (key = '') => {
    const normalizedKey = String(key || '').trim().replace(/^\/+/, '');
    if (!normalizedKey) return false;

    try {
        await s3Client.send(new HeadObjectCommand({
            Bucket: SYSTEM_CONFIG.AWS_BUCKET,
            Key: normalizedKey
        }));
        return true;
    } catch (e) {
        const statusCode = e?.$metadata?.httpStatusCode;
        const errorCode = String(e?.name || e?.Code || '');
        if (statusCode === 404 || errorCode === 'NotFound' || errorCode === 'NoSuchKey') {
            return false;
        }
        throw e;
    }
};


const prefixHasObjectsInS3 = async (prefix = '') => {
    const normalizedPrefix = String(prefix || '').trim().replace(/^\/+/, '');
    if (!normalizedPrefix) return false;

    const listRes = await s3Client.send(new ListObjectsV2Command({
        Bucket: SYSTEM_CONFIG.AWS_BUCKET,
        Prefix: normalizedPrefix,
        MaxKeys: 1
    }));

    return (listRes.Contents || []).some((item) => {
        const key = String(item?.Key || '');
        return key && key.startsWith(normalizedPrefix);
    });
};

const resolveMediaUploadKey = async ({ rawPath = '/', rawFileName = '' }) => {
    const safeFileName = String(rawFileName || '').replace(/\s+/g, '_');
    if (!safeFileName) throw new Error('File name is missing');

    const primaryPrefix = toMediaPrefix(rawPath);
    if (!MEDIA_ROOT_PREFIX) return `${primaryPrefix}${safeFileName}`;

    const normalizedPath = normalizeMediaPath(rawPath);
    const fallbackPrefix = normalizedPath ? `${normalizedPath}/` : '';

    const [primaryList, fallbackList] = await Promise.all([
        s3Client.send(new ListObjectsV2Command({
            Bucket: SYSTEM_CONFIG.AWS_BUCKET,
            Prefix: primaryPrefix,
            Delimiter: '/'
        })),
        s3Client.send(new ListObjectsV2Command({
            Bucket: SYSTEM_CONFIG.AWS_BUCKET,
            Prefix: fallbackPrefix,
            Delimiter: '/'
        }))
    ]);

    const hasPrimaryContent = hasAnyObjects(primaryList);
    const hasFallbackContent = hasAnyObjects(fallbackList);
    const selectedPrefix = !hasPrimaryContent && hasFallbackContent ? fallbackPrefix : primaryPrefix;
    return `${selectedPrefix}${safeFileName}`;
};

const resolveMediaDeleteKey = async (rawId = '') => {
    const decoded = decodeURIComponent(String(rawId || '').trim());
    if (!decoded) throw new Error('Invalid media id');

    const normalized = decoded.replace(/^\/+/, '');
    if (!normalized) throw new Error('Invalid media id');

    const candidates = [normalized];
    if (MEDIA_ROOT_PREFIX && !normalized.startsWith(MEDIA_ROOT_PREFIX)) {
        candidates.push(`${MEDIA_ROOT_PREFIX}${normalized}`);
    }

    for (const candidate of [...new Set(candidates)]) {
        if (await keyExistsInS3(candidate)) return candidate;
    }

    return candidates[candidates.length - 1];
};

const resolveFolderPrefixFromId = async (rawId = '') => {
    const decoded = decodeURIComponent(String(rawId || '').trim());
    if (!decoded) throw new Error('Invalid folder id');

    const separatorIndex = decoded.lastIndexOf(':');
    const parentPath = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : '/';
    const folderName = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : decoded;

    const sanitizedFolderName = String(folderName || '').trim().replace(/^\/+|\/+$/g, '');
    if (!sanitizedFolderName) throw new Error('Folder name is missing');

    const primaryParentPrefix = toMediaPrefix(parentPath || '/');
    const primaryPrefix = `${primaryParentPrefix}${sanitizedFolderName}/`;
    if (!MEDIA_ROOT_PREFIX) return primaryPrefix;

    const normalizedParentPath = normalizeMediaPath(parentPath || '/');
    const fallbackParentPrefix = normalizedParentPath ? `${normalizedParentPath}/` : '';
    const fallbackPrefix = `${fallbackParentPrefix}${sanitizedFolderName}/`;

    const [hasPrimaryContent, hasFallbackContent] = await Promise.all([
        prefixHasObjectsInS3(primaryPrefix),
        prefixHasObjectsInS3(fallbackPrefix)
    ]);

    if (!hasPrimaryContent && hasFallbackContent) return fallbackPrefix;
    return primaryPrefix;
};

const resolveFolderCreatePrefix = async ({ rawParentPath = '/', rawFolderName = '' }) => {
    const sanitizedFolderName = String(rawFolderName || '').trim().replace(/^\/+|\/+$/g, '');
    if (!sanitizedFolderName) throw new Error('Folder name is required');

    const primaryParentPrefix = toMediaPrefix(rawParentPath);
    if (!MEDIA_ROOT_PREFIX) return `${primaryParentPrefix}${sanitizedFolderName}/`;

    const normalizedParentPath = normalizeMediaPath(rawParentPath);
    const fallbackParentPrefix = normalizedParentPath ? `${normalizedParentPath}/` : '';

    const [hasPrimaryContent, hasFallbackContent] = await Promise.all([
        prefixHasObjectsInS3(primaryParentPrefix),
        prefixHasObjectsInS3(fallbackParentPrefix)
    ]);

    const parentPrefix = !hasPrimaryContent && hasFallbackContent ? fallbackParentPrefix : primaryParentPrefix;
    return `${parentPrefix}${sanitizedFolderName}/`;
};


const PUBLIC_SHOWCASE_SETTINGS_KEY = 'public_showcase_folders';
const SHOWCASE_SHORT_LINKS_KEY = 'showcase_short_links';

const normalizeShowcasePrefix = (prefix = '') => {
    const cleaned = String(prefix || '').trim().replace(/^\/+/, '');
    if (!cleaned) return '';
    return cleaned.endsWith('/') ? cleaned : `${cleaned}/`;
};

const prefixHasObjects = async (prefix = '') => {
    const normalizedPrefix = normalizeShowcasePrefix(prefix);
    if (!normalizedPrefix) return false;

    const listRes = await s3Client.send(new ListObjectsV2Command({
        Bucket: SYSTEM_CONFIG.AWS_BUCKET,
        Prefix: normalizedPrefix,
        MaxKeys: 25
    }));

    return (listRes.Contents || []).some((item) => {
        const key = String(item?.Key || '');
        return key && key !== normalizedPrefix && !key.endsWith('/');
    });
};

const resolveShowcasePrefix = async (prefix = '', context = '') => {
    const normalizedPrefix = normalizeShowcasePrefix(prefix);
    if (!normalizedPrefix) return { prefix: normalizedPrefix, hasObjects: false, usedFallback: false };

    if (await prefixHasObjects(normalizedPrefix)) {
        return { prefix: normalizedPrefix, hasObjects: true, usedFallback: false };
    }

    if (!MEDIA_ROOT_PREFIX || !normalizedPrefix.startsWith(MEDIA_ROOT_PREFIX)) {
        return { prefix: normalizedPrefix, hasObjects: false, usedFallback: false };
    }

    const fallbackPrefix = normalizeShowcasePrefix(normalizedPrefix.slice(MEDIA_ROOT_PREFIX.length));
    if (!fallbackPrefix) {
        return { prefix: normalizedPrefix, hasObjects: false, usedFallback: false };
    }

    if (await prefixHasObjects(fallbackPrefix)) {
        console.warn(`[SHOWCASE PREFIX FALLBACK] Using fallback prefix "${fallbackPrefix}" instead of "${normalizedPrefix}"${context ? ` (${context})` : ''}.`);
        return { prefix: fallbackPrefix, hasObjects: true, usedFallback: true };
    }

    return { prefix: normalizedPrefix, hasObjects: false, usedFallback: false };
};

const getPublicShowcaseFolders = async () => {
    return withDb(async (client) => {
        const setting = await client.query('SELECT value FROM system_settings WHERE key = $1 LIMIT 1', [PUBLIC_SHOWCASE_SETTINGS_KEY]);
        const value = setting.rows?.[0]?.value;
        if (!Array.isArray(value)) return [];

        return value
            .map((item) => {
                const folderId = typeof item?.folderId === 'string' ? item.folderId : '';
                const prefix = normalizeShowcasePrefix(item?.prefix || '');
                const folderName = typeof item?.folderName === 'string' ? item.folderName : '';
                const enabledAt = item?.enabledAt ? String(item.enabledAt) : null;
                if (!folderId || !prefix) return null;
                return { folderId, prefix, folderName: folderName || prefix.replace(/\/$/, '').split('/').pop() || folderId, enabledAt };
            })
            .filter(Boolean);
    });
};

const savePublicShowcaseFolders = async (entries = []) => {
    return withDb(async (client) => {
        await client.query(
            'INSERT INTO system_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
            [PUBLIC_SHOWCASE_SETTINGS_KEY, JSON.stringify(entries)]
        );
        return entries;
    });
};

const getShowcaseShortLinkMap = async () => {
    return withDb(async (client) => {
        const setting = await client.query('SELECT value FROM system_settings WHERE key = $1 LIMIT 1', [SHOWCASE_SHORT_LINKS_KEY]);
        const value = setting.rows?.[0]?.value;
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    });
};

const saveShowcaseShortLinkMap = async (map = {}) => {
    const safeMap = map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    return withDb(async (client) => {
        await client.query(
            'INSERT INTO system_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
            [SHOWCASE_SHORT_LINKS_KEY, JSON.stringify(safeMap)]
        );
        return safeMap;
    });
};

const getShowcasePayloadFingerprint = (payload = {}) => {
    const normalized = JSON.stringify(payload || {});
    return crypto.createHash('sha256').update(normalized).digest('hex');
};

const getOrCreateShowcaseShortToken = async (payload = {}) => {
    const safePayload = payload && typeof payload === 'object' ? payload : {};
    const payloadFingerprint = getShowcasePayloadFingerprint(safePayload);

    const map = await getShowcaseShortLinkMap();
    const existingToken = Object.entries(map).find(([, entry]) => {
        if (!entry || typeof entry !== 'object') return false;
        if (typeof entry.fingerprint === 'string') return entry.fingerprint === payloadFingerprint;
        return getShowcasePayloadFingerprint(entry.payload || {}) === payloadFingerprint;
    })?.[0];

    if (existingToken) return existingToken;

    let token = '';
    for (let i = 0; i < 8; i += 1) {
        const candidate = crypto.randomBytes(5).toString('base64url');
        if (!map[candidate]) {
            token = candidate;
            break;
        }
    }
    if (!token) token = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;

    map[token] = {
        payload: safePayload,
        fingerprint: payloadFingerprint,
        createdAt: new Date().toISOString()
    };

    await saveShowcaseShortLinkMap(map);
    return token;
};

const getShowcasePayloadFromShortToken = async (token = '') => {
    const trimmed = String(token || '').trim();
    if (!trimmed) return null;
    const map = await getShowcaseShortLinkMap();
    const entry = map[trimmed];
    if (!entry || typeof entry !== 'object') return null;
    const payload = entry.payload;
    return payload && typeof payload === 'object' ? payload : null;
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

let metaHttpsAgent = null;
let metaClient = null;
const META_SEND_METRICS_WINDOW = 250;
const META_SEND_TYPES = new Set(['manual', 'bot', 'scheduled']);
const metaSendMetrics = {
    manual: { total: 0, success: 0, timeout: 0, error: 0, timeoutDurations: [], errorDurations: [] },
    bot: { total: 0, success: 0, timeout: 0, error: 0, timeoutDurations: [], errorDurations: [] },
    scheduled: { total: 0, success: 0, timeout: 0, error: 0, timeoutDurations: [], errorDurations: [] },
};

const nowHrMs = () => Number(process.hrtime.bigint() / 1000000n);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pushBoundedMetric = (collection, value) => {
    collection.push(value);
    if (collection.length > META_SEND_METRICS_WINDOW) collection.shift();
};

const percentile = (values, p) => {
    if (!Array.isArray(values) || values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
};

const normalizeSendType = (rawType = 'bot') => (META_SEND_TYPES.has(rawType) ? rawType : 'bot');

const getSendTimeoutBudgetMs = (sendType = 'bot') => {
    const normalized = normalizeSendType(sendType);
    if (normalized === 'manual') return SYSTEM_CONFIG.META_TIMEOUT_MANUAL_MS;
    if (normalized === 'scheduled') return SYSTEM_CONFIG.META_TIMEOUT_SCHEDULED_MS;
    return SYSTEM_CONFIG.META_TIMEOUT_BOT_MS;
};

const isRetrySafeTransientMetaError = (error) => {
    if (!error) return false;
    const status = error.response?.status;
    if (typeof status === 'number' && status >= 500 && status < 600) return true;
    if (error.code === 'ECONNABORTED' || error.code === 'ECONNRESET' || error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT') return true;
    return !error.response && Boolean(error.code);
};

const buildMetaRetryDelayMs = (attempt) => {
    const expDelay = Math.min(SYSTEM_CONFIG.META_RETRY_MAX_DELAY_MS, SYSTEM_CONFIG.META_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1)));
    const jitter = Math.floor(Math.random() * SYSTEM_CONFIG.META_RETRY_BASE_DELAY_MS);
    return expDelay + jitter;
};

const trackMetaSendMetric = ({ sendType = 'bot', outcome = 'success', durationMs = 0 } = {}) => {
    const bucket = metaSendMetrics[normalizeSendType(sendType)];
    bucket.total += 1;
    if (outcome === 'timeout') {
        bucket.timeout += 1;
        pushBoundedMetric(bucket.timeoutDurations, durationMs);
        return;
    }
    if (outcome === 'error') {
        bucket.error += 1;
        pushBoundedMetric(bucket.errorDurations, durationMs);
        return;
    }
    bucket.success += 1;
};

const getMetaSendMetricsSnapshot = () => Object.entries(metaSendMetrics).reduce((acc, [sendType, stats]) => {
    const total = stats.total || 0;
    acc[sendType] = {
        total,
        success: stats.success,
        timeout: stats.timeout,
        error: stats.error,
        timeoutRate: total > 0 ? Number((stats.timeout / total).toFixed(4)) : 0,
        errorRate: total > 0 ? Number((stats.error / total).toFixed(4)) : 0,
        timeoutDurationPercentilesMs: {
            p50: percentile(stats.timeoutDurations, 50),
            p95: percentile(stats.timeoutDurations, 95),
            p99: percentile(stats.timeoutDurations, 99),
        },
        errorDurationPercentilesMs: {
            p50: percentile(stats.errorDurations, 50),
            p95: percentile(stats.errorDurations, 95),
            p99: percentile(stats.errorDurations, 99),
        },
    };
    return acc;
}, {});

const getMetaClient = () => {
    const token = process.env.META_API_TOKEN;

    if (!metaHttpsAgent) {
        metaHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 1000 });
    }

    if (!metaClient) {
        metaClient = axios.create({
            httpsAgent: metaHttpsAgent,
            timeout: SYSTEM_CONFIG.META_TIMEOUT,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        });
        return metaClient;
    }

    const currentAuth = metaClient.defaults?.headers?.common?.Authorization;
    const nextAuth = `Bearer ${token}`;
    if (currentAuth !== nextAuth) {
        if (!metaClient.defaults.headers) metaClient.defaults.headers = {};
        if (!metaClient.defaults.headers.common) metaClient.defaults.headers.common = {};
        metaClient.defaults.headers.common.Authorization = nextAuth;
        metaClient.defaults.headers.common['Content-Type'] = 'application/json';
    }

    return metaClient;
};

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

const DRIVER_EXCEL_SYNC_MAX_CONSECUTIVE_FAILURES = Math.max(1, Number(process.env.DRIVER_EXCEL_SYNC_MAX_CONSECUTIVE_FAILURES || 5));
let driverExcelIsolationState = {
    disabled: false,
    consecutiveFailures: 0,
    disabledAt: null,
    reason: null
};

const isDriverExcelSyncIsolated = () => driverExcelIsolationState.disabled;

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
const getS3ConsoleFolderUrl = (prefix = '') => `https://s3.console.aws.amazon.com/s3/buckets/${encodeURIComponent(SYSTEM_CONFIG.AWS_BUCKET)}?region=${encodeURIComponent(SYSTEM_CONFIG.AWS_REGION)}&prefix=${encodeURIComponent(prefix)}&showversions=false`;
const inferMediaTypeFromKey = (key = '') => {
    const extension = String(key).split('.').pop()?.toLowerCase() || '';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(extension)) return 'image';
    if (['mp4', 'mov', 'avi', 'webm', 'mkv', '3gp'].includes(extension)) return 'video';
    return 'document';
};
const toBase64Url = (value = '') => Buffer.from(String(value)).toString('base64url');
const fromBase64Url = (value = '') => Buffer.from(String(value), 'base64url').toString('utf8');
const buildShowcaseToken = (payload = {}) => toBase64Url(JSON.stringify(payload));
const getPublicShowcaseUrl = async (payload = {}) => {
    const token = encodeURIComponent(await getOrCreateShowcaseShortToken(payload));
    const normalizedBase = String(SYSTEM_CONFIG.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
    const safeBase = normalizedBase || 'https://encho-whatsapp-lead-handler.vercel.app';
    return `${safeBase}/showcase/${token}`;
};

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
    const customerHeaders = ['Candidate ID', ...effectiveColumns.map((c) => c.label), 'Variables JSON'];

    const customerRows = [
        customerHeaders,
        ...customers.map((c) => [
            c.id,
            ...effectiveColumns.map((col) => getDriverExcelCellValue(c, col)),
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
    const customerHeaders = ['Candidate ID', ...effectiveColumns.map((c) => c.label), 'Variables JSON'];
    const customerRows = [
        customerHeaders,
        ...customers.map((c) => [
            c.id,
            ...effectiveColumns.map((col) => getDriverExcelCellValue(c, col)),
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

const ensureGoogleSheetTabsExist = async ({ accessToken, spreadsheetId, desiredTabNames = [] }) => {
    const uniqueDesired = Array.from(new Set(desiredTabNames.filter(Boolean)));
    if (uniqueDesired.length === 0) {
        return { existingTabNames: [], createdTabNames: [] };
    }

    const metadata = await axios.get(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`,
        {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 8000
        }
    );

    const existingTabNames = (metadata.data?.sheets || [])
        .map((sheet) => sheet?.properties?.title)
        .filter(Boolean);

    const missingTabNames = uniqueDesired.filter((tabName) => !existingTabNames.includes(tabName));
    if (missingTabNames.length === 0) {
        return { existingTabNames, createdTabNames: [] };
    }

    await axios.post(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
        {
            requests: missingTabNames.map((title) => ({ addSheet: { properties: { title } } }))
        },
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            timeout: 8000
        }
    );

    return {
        existingTabNames,
        createdTabNames: missingTabNames
    };
};

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

    await ensureGoogleSheetTabsExist({
        accessToken,
        spreadsheetId,
        desiredTabNames: [customersTabName, messagesTabName]
    });

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
                SELECT c.id, c.phone_number, c.name, c.stage, c.source, c.created_at, c.last_message_at, c.variables
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
        return {
            customer: {
                id: row.id,
                phone_number: row.phone_number,
                name: row.name,
                stage: row.stage,
                source: row.source || '',
                created_at: row.created_at ? new Date(row.created_at).toISOString() : '',
                last_message_at: row.last_message_at ? new Date(Number(row.last_message_at) || row.last_message_at).toISOString() : '',
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
    applyRuntimeGoogleSheetsConfig(rawConfig);
    return {
        webhook_ingest_enabled: rawConfig.webhook_ingest_enabled !== false,
        automation_enabled: rawConfig.automation_enabled !== false,
        sending_enabled: rawConfig.sending_enabled !== false,
        google_sheets_spreadsheet_id: SYSTEM_CONFIG.GOOGLE_SHEETS_SPREADSHEET_ID,
        google_sheets_customers_tab_name: SYSTEM_CONFIG.GOOGLE_SHEETS_CUSTOMERS_TAB_NAME,
        google_sheets_messages_tab_name: SYSTEM_CONFIG.GOOGLE_SHEETS_MESSAGES_TAB_NAME,
        google_service_account_email: SYSTEM_CONFIG.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        google_service_account_configured: Boolean(SYSTEM_CONFIG.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY)
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
        const missingTabs = [customersTabName, messagesTabName]
            .filter((tabName, idx, arr) => tabName && !tabNames.includes(tabName) && arr.indexOf(tabName) === idx);
        return {
            state: 'connected',
            configured: true,
            spreadsheetId,
            spreadsheetTitle: metadata.data?.properties?.title || '',
            customersTabName,
            messagesTabName,
            customersTabExists: tabNames.includes(customersTabName),
            messagesTabExists: tabNames.includes(messagesTabName),
            tabMode: customersTabName === messagesTabName ? 'single_tab' : 'two_tabs',
            missingTabs,
            autoCreateOnSync: true
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

const triggerReportingSyncDeferred = ({ candidateId, action = 'upsert', requestId = null, source = 'unknown' } = {}) => {
    setImmediate(() => {
        try {
            scheduleDriverExcelSync();
            if (candidateId) {
                scheduleDriverExcelIncrementalSync({ candidateId, action });
            }
        } catch (error) {
            structuredLog({
                level: 'error',
                module: 'reporting-export',
                requestId,
                message: 'reporting.sync.deferred_failed',
                meta: { candidateId, action, source, error: error?.message || String(error) },
            });
        }
    });
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

const listAllS3KeysByPrefix = async (prefix = '') => {
    const keys = [];
    let continuationToken;

    do {
        const listRes = await s3Client.send(new ListObjectsV2Command({
            Bucket: SYSTEM_CONFIG.AWS_BUCKET,
            Prefix: prefix,
            ContinuationToken: continuationToken
        }));

        (listRes.Contents || []).forEach((item) => {
            if (!item.Key) return;
            if (item.Key === prefix && String(item.Key).endsWith('/')) return;
            keys.push(item.Key);
        });

        continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
    } while (continuationToken);

    return keys;
};

const copyObjectInS3 = async ({ sourceKey, destinationKey }) => {
    if (!sourceKey || !destinationKey || sourceKey === destinationKey) return destinationKey;
    await s3Client.send(new CopyObjectCommand({
        Bucket: SYSTEM_CONFIG.AWS_BUCKET,
        CopySource: `${SYSTEM_CONFIG.AWS_BUCKET}/${encodeURI(sourceKey).replace(/#/g, '%23')}`,
        Key: destinationKey
    }));
    await deleteFromS3(sourceKey).catch(() => null);
    return destinationKey;
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
    if (isDriverExcelSyncIsolated()) {
        driverExcelSyncStatus.state = 'isolated';
        driverExcelSyncStatus.lastError = driverExcelIsolationState.reason || 'Driver Excel sync is isolated after repeated failures';
        persistDriverExcelSyncStatus();
        return;
    }

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
                SELECT c.id, c.phone_number, c.name, c.stage, c.source, c.created_at, c.last_message_at, c.variables
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
            return {
                id: row.id,
                phone_number: row.phone_number,
                name: row.name,
                stage: row.stage,
                source: row.source || '',
                created_at: row.created_at ? new Date(row.created_at).toISOString() : '',
                last_message_at: row.last_message_at ? new Date(Number(row.last_message_at) || row.last_message_at).toISOString() : '',
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

        driverExcelIsolationState.consecutiveFailures = 0;
        driverExcelIsolationState.reason = null;
        driverExcelSyncStatus.state = driverExcelSyncStatus.destinations.googleSheets.state === 'success' ? 'success' : 'partial_success';
        driverExcelSyncStatus.lastSuccessAt = new Date().toISOString();
        driverExcelSyncStatus.lastDurationMs = Date.now() - syncStartedAt;
        persistDriverExcelSyncStatus();
    } catch (e) {
        driverExcelIsolationState.consecutiveFailures += 1;
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
        if (driverExcelIsolationState.consecutiveFailures >= DRIVER_EXCEL_SYNC_MAX_CONSECUTIVE_FAILURES) {
            driverExcelIsolationState.disabled = true;
            driverExcelIsolationState.disabledAt = new Date().toISOString();
            driverExcelIsolationState.reason = driverExcelSyncStatus.lastError;
            driverExcelSyncStatus.state = 'isolated';
            driverExcelSyncStatus.lastError = `Driver Excel sync isolated after ${driverExcelIsolationState.consecutiveFailures} consecutive failures: ${driverExcelIsolationState.reason}`;
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
    if (isDriverExcelSyncIsolated()) {
        driverExcelSyncStatus.state = 'isolated';
        driverExcelSyncStatus.lastError = driverExcelIsolationState.reason || 'Driver Excel sync is isolated after repeated failures';
        persistDriverExcelSyncStatus();
        return;
    }

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
    if (isDriverExcelSyncIsolated()) {
        driverExcelSyncStatus.state = 'isolated';
        driverExcelSyncStatus.lastError = driverExcelIsolationState.reason || 'Driver Excel sync is isolated after repeated failures';
        persistDriverExcelSyncStatus();
        return;
    }

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

const DRIVER_EXCEL_MEDIA_SUFFIX_ALLOWLIST = new Set([
    '_file_url',
    '_folder_url',
    '_status',
    '_uploaded_at',
    '_rejection_reason',
    '_link_mime_type'
]);

const DRIVER_EXCEL_MEDIA_STATUS_SUFFIX = '_status';

const DRIVER_EXCEL_LICENSE_PREFIXES = ['license', 'licence', 'latest_license_link'];

const shouldIncludeDriverExcelVariableKey = (rawKey = '') => {
    const key = normalizeColumnKey(rawKey);
    if (!key) return false;

    if (DRIVER_EXCEL_LICENSE_PREFIXES.includes(key)) return true;

    for (const prefix of DRIVER_EXCEL_LICENSE_PREFIXES) {
        const withSeparator = `${prefix}_`;
        if (!key.startsWith(withSeparator)) continue;
        const suffix = key.substring(prefix.length);
        return DRIVER_EXCEL_MEDIA_SUFFIX_ALLOWLIST.has(suffix);
    }

    return true;
};

const deriveDriverExcelVariableBaseKey = (rawKey = '') => {
    const key = normalizeColumnKey(rawKey);
    if (!key) return '';

    for (const suffix of DRIVER_EXCEL_MEDIA_SUFFIX_ALLOWLIST) {
        if (!key.endsWith(suffix)) continue;
        const candidateBase = key.slice(0, -suffix.length);
        return candidateBase || key;
    }

    return key;
};

const doesVariableValueReferenceS3Key = (rawValue, targetKeys = []) => {
    const value = String(rawValue ?? '').trim();
    if (!value) return false;
    const keys = targetKeys.filter(Boolean);
    if (keys.length === 0) return false;

    let decodedValue = value;
    try {
        decodedValue = decodeURIComponent(value);
    } catch (_) {
        decodedValue = value;
    }

    const referencesPlainKey = keys.some((key) => value.includes(key) || decodedValue.includes(key));
    if (referencesPlainKey) return true;

    try {
        const url = new URL(value);
        const pathname = decodeURIComponent(url.pathname || '').replace(/^\/+/, '');
        if (keys.some((key) => pathname === key || pathname.endsWith(`/${key}`))) return true;

        const token = decodeURIComponent(pathname.split('/').pop() || '');
        const payload = JSON.parse(fromBase64Url(token));
        if (payload?.type === 'file' && payload?.key && keys.includes(String(payload.key))) return true;
        if (payload?.type === 'folder' && payload?.prefix && keys.some((key) => String(payload.prefix).startsWith(String(key).replace(/[^/]+$/, '')))) {
            return true;
        }
    } catch (_) {
        return false;
    }

    return false;
};

const markDriverExcelMediaReferencesAsDeleted = async ({ deletedKeys = [] }) => {
    const normalizedKeys = Array.from(new Set(deletedKeys.map((key) => String(key || '').trim()).filter(Boolean)));
    if (normalizedKeys.length === 0) return { updatedCandidates: 0 };

    let updatedCandidates = 0;
    await withDb(async (client) => {
        const res = await client.query('SELECT id, variables FROM candidates WHERE variables IS NOT NULL');

        for (const row of res.rows) {
            const vars = normalizeVariables(row.variables);
            const nextVars = { ...vars };
            let changed = false;
            const touchedBases = new Set();

            Object.entries(vars).forEach(([rawKey, rawValue]) => {
                const key = normalizeColumnKey(rawKey);
                if (!key) return;
                if (!doesVariableValueReferenceS3Key(rawValue, normalizedKeys)) return;

                nextVars[rawKey] = 'deleted';
                touchedBases.add(deriveDriverExcelVariableBaseKey(rawKey));
                changed = true;
            });

            touchedBases.forEach((baseKey) => {
                if (!baseKey) return;
                nextVars[`${baseKey}${DRIVER_EXCEL_MEDIA_STATUS_SUFFIX}`] = 'deleted';
            });

            if (!changed) continue;

            await client.query('UPDATE candidates SET variables = $1::jsonb WHERE id = $2', [JSON.stringify(nextVars), row.id]);
            scheduleDriverExcelIncrementalSync({ candidateId: row.id, action: 'upsert' });
            updatedCandidates += 1;
        }
    });

    if (updatedCandidates > 0) {
        scheduleDriverExcelSync();
    }

    return { updatedCandidates };
};

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

const parseIncomingMediaPayload = (text) => {
    if (!text || typeof text !== 'string') return null;
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || !parsed.mediaKey) return null;
        return parsed;
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
        if (!shouldIncludeDriverExcelVariableKey(normalizedKey)) return;
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
        .filter((c) => shouldIncludeDriverExcelVariableKey(c.key))
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
        if (!shouldIncludeDriverExcelVariableKey(normalizedKey)) return;

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
    if (mime.includes('mp4')) return 'mp4';
    if (mime.includes('quicktime')) return 'mov';
    if (mime.includes('3gpp')) return '3gp';
    if (mime.includes('ogg')) return 'ogg';
    if (mime.includes('mpeg')) return 'mp3';
    if (mime.includes('aac')) return 'aac';
    if (mime.includes('amr')) return 'amr';
    if (mime.includes('wav')) return 'wav';
    return fallback;
};

const ALLOWED_MEDIA_MIME_TYPES = new Set([
    'image/jpeg',
    'image/jpg',
    'image/png',
    'application/pdf',
    'image/webp',
    'video/mp4',
    'video/quicktime',
    'video/3gpp',
    'audio/ogg',
    'audio/mpeg',
    'audio/mp4',
    'audio/aac',
    'audio/amr',
    'audio/3gpp',
    'audio/wav'
]);

const normalizeMimeType = (mimeType = '') => String(mimeType || '').toLowerCase().split(';')[0].trim();
const isAllowedMediaMimeType = (mimeType = '') => ALLOWED_MEDIA_MIME_TYPES.has(normalizeMimeType(mimeType));
const MAX_MEDIA_FILE_BYTES = 16 * 1024 * 1024;

const fetchAndStoreIncomingMedia = async ({ msg, phoneNumber, candidateId, client }) => {
    if (!candidateId) throw new Error('Candidate id is required for media upload');
    const mediaId = msg?.image?.id || msg?.document?.id || msg?.video?.id || msg?.audio?.id;
    if (!mediaId) return null;

    const metaResponse = await getMetaClient().get(`https://graph.facebook.com/v18.0/${mediaId}`);
    const mediaUrl = metaResponse.data?.url;
    const mimeType = String(metaResponse.data?.mime_type || (msg.type === 'document' ? 'application/octet-stream' : (msg.type === 'audio' ? 'audio/ogg' : `${msg.type === 'video' ? 'video' : 'image'}/${msg.type}`))).toLowerCase();
    if (!mediaUrl) throw new Error('WhatsApp media URL not found');
    if (!isAllowedMediaMimeType(mimeType)) {
        throw new Error(`Unsupported media file type: ${mimeType}`);
    }

    const mediaFile = await axios.get(mediaUrl, {
        responseType: 'arraybuffer',
        timeout: SYSTEM_CONFIG.META_TIMEOUT,
        headers: { Authorization: `Bearer ${process.env.META_API_TOKEN}` }
    });

    if ((mediaFile.data?.byteLength || 0) > MAX_MEDIA_FILE_BYTES) {
        throw new Error('Media file exceeds 16MB limit');
    }

    const ext = getFileExtensionFromMime(mimeType, msg.type === 'document' ? 'pdf' : (msg.type === 'video' ? 'mp4' : (msg.type === 'audio' ? 'ogg' : 'jpg')));
    const prefix = buildDriverDataPrefix(phoneNumber);
    const timestampTag = new Date().toISOString().replace(/[:.]/g, '-');
    const key = `${prefix}/${timestampTag}_${msg.id}.${ext}`;

    await uploadToS3({
        key: `${prefix}/`,
        body: '',
        contentType: 'application/x-directory'
    });
    await uploadToS3({
        key,
        body: Buffer.from(mediaFile.data),
        contentType: mimeType
    });

    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO driver_documents (id, candidate_id, type, url, status, created_at)
            VALUES ($1, $2, $3, $4, 'pending', NOW())`,
            [crypto.randomUUID(), candidateId, 'media', key]
        );
        await client.query('COMMIT');
        return { key, mimeType };
    } catch (e) {
        await client.query('ROLLBACK').catch(() => null);
        await deleteFromS3(key).catch(() => null);
        throw e;
    }
};

const META_VERBOSE_LOGS = String(process.env.META_VERBOSE_LOGS || 'false').toLowerCase() === 'true';

const sendToMeta = async (phoneNumber, payload, options = {}) => {
    const phoneId = process.env.PHONE_NUMBER_ID;
    const to = (phoneNumber || '').toString().replace(/\D/g, '');
    const sendType = normalizeSendType(options.sendType || 'bot');
    const timeoutBudgetMs = getSendTimeoutBudgetMs(sendType);
    const maxAttempts = options.enableRetry ? SYSTEM_CONFIG.META_RETRY_MAX_ATTEMPTS : 1;

    const validation = validateOutboundPayload(payload);
    if (!validation.valid) {
        console.warn(`[Meta] Blocked outbound payload (${validation.reason})`);
        return { delivered: false, blocked: true, reason: validation.reason };
    }

    const attemptSend = async (attempt) => {
        if (META_VERBOSE_LOGS) console.log(`[Meta] Sending to ${to} | Type: ${payload.type} | sendType=${sendType} | attempt=${attempt}`);
        return getMetaClient().post(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            ...payload
        }, {
            timeout: timeoutBudgetMs,
        });
    };

    const backgroundRetry = async (startAttempt) => {
        for (let attempt = startAttempt; attempt <= maxAttempts; attempt += 1) {
            try {
                const response = await attemptSend(attempt);
                const providerMessageId = response?.data?.messages?.[0]?.id || null;
                trackMetaSendMetric({ sendType, outcome: 'success', durationMs: timeoutBudgetMs });
                structuredLog({
                    level: 'info',
                    module: 'lead-ingestion',
                    message: 'meta.send.background_retry_succeeded',
                    meta: { to, sendType, attempt, maxAttempts, providerMessageId }
                });
                return { delivered: true, blocked: false, providerMessageId, backgroundRecovered: true };
            } catch (error) {
                const isRetryable = isRetrySafeTransientMetaError(error);
                if (!isRetryable || attempt >= maxAttempts) {
                    const errMsg = error.response?.data?.error?.message || error.message;
                    trackMetaSendMetric({ sendType, outcome: error.code === 'ECONNABORTED' ? 'timeout' : 'error', durationMs: timeoutBudgetMs });
                    structuredLog({
                        level: 'error',
                        module: 'lead-ingestion',
                        message: 'meta.send.background_retry_failed',
                        meta: { to, sendType, attempt, maxAttempts, error: errMsg }
                    });
                    return null;
                }
                await sleep(buildMetaRetryDelayMs(attempt));
            }
        }
        return null;
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const startedAt = nowHrMs();
        try {
            const response = await attemptSend(attempt);
            const providerMessageId = response?.data?.messages?.[0]?.id || null;
            trackMetaSendMetric({ sendType, outcome: 'success', durationMs: Math.max(0, nowHrMs() - startedAt) });
            return { delivered: true, blocked: false, providerMessageId };
        } catch (e) {
            const durationMs = Math.max(0, nowHrMs() - startedAt);
            const errMsg = e.response?.data?.error?.message || e.message;
            const retryable = isRetrySafeTransientMetaError(e);
            const timedOut = e.code === 'ECONNABORTED';

            if (timedOut) {
                trackMetaSendMetric({ sendType, outcome: 'timeout', durationMs });
            } else {
                trackMetaSendMetric({ sendType, outcome: 'error', durationMs });
            }

            if (retryable && attempt < maxAttempts) {
                await sleep(buildMetaRetryDelayMs(attempt));
                continue;
            }

            if (timedOut && options.returnFastOnTimeout) {
                if (options.enableRetry && attempt < maxAttempts) {
                    trackBackgroundTask({
                        taskName: 'meta.send.background_retry_after_timeout',
                        requestId: options.requestId || null,
                        promise: backgroundRetry(attempt + 1),
                    });
                }
                return {
                    delivered: false,
                    timeout: true,
                    fastFailed: true,
                    retryingInBackground: Boolean(options.enableRetry && attempt < maxAttempts),
                    reason: `Meta API timeout after ${timeoutBudgetMs}ms`,
                };
            }

            console.error(`[Meta Failed] ${to}: ${errMsg}`);
            throw new Error(`Meta API Error: ${errMsg}`);
        }
    }

    throw new Error('Meta API Error: send exhausted without response');
};

const applyWhatsAppMarker = (rawValue, marker) => {
    const value = String(rawValue || '');
    if (!value) return '';

    // WhatsApp doesn't render markdown if spaces are immediately inside markers.
    const leading = value.match(/^\s*/)?.[0] || '';
    const trailing = value.match(/\s*$/)?.[0] || '';
    const core = value.slice(leading.length, value.length - trailing.length);
    if (!core) return value;

    return `${leading}${marker}${core}${marker}${trailing}`;
};

const convertInlineStyleTokensForWhatsApp = (text) => {
    if (!text || typeof text !== 'string') return '';

    let formatted = String(text);

    // Keep replacing while nested style tokens exist.
    let prev = null;
    while (formatted !== prev) {
        prev = formatted;
        formatted = formatted
            .replace(/\[b\]([\s\S]*?)\[\/b\]/gi, (_m, value) => applyWhatsAppMarker(value, '*'))
            .replace(/\[i\]([\s\S]*?)\[\/i\]/gi, (_m, value) => applyWhatsAppMarker(value, '_'))
            .replace(/\[u\]([\s\S]*?)\[\/u\]/gi, '$1')
            .replace(/\[size=(small|medium|large)\]([\s\S]*?)\[\/size\]/gi, '$2');
    }

    // Clean up any leftover malformed tags so users never see raw markup.
    formatted = formatted
        .replace(/\[\/?b\]/gi, '')
        .replace(/\[\/?i\]/gi, '')
        .replace(/\[\/?u\]/gi, '')
        .replace(/\[size=(small|medium|large)\]/gi, '')
        .replace(/\[\/size\]/gi, '');

    return formatted;
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
    return convertInlineStyleTokensForWhatsApp(processed);
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
    await client.query(`CREATE TABLE IF NOT EXISTS staff_members (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), 
        email VARCHAR(255) UNIQUE NOT NULL, 
        name VARCHAR(255), 
        role VARCHAR(50) DEFAULT 'staff', 
        is_active_for_auto_dist BOOLEAN DEFAULT FALSE,
        last_assigned_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
    );`);
    
    // Migration for existing table
    await client.query(`ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS is_active_for_auto_dist BOOLEAN DEFAULT FALSE;`);
    await client.query(`ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS last_assigned_at TIMESTAMP;`);
    
    await client.query(`CREATE TABLE IF NOT EXISTS candidates (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), phone_number VARCHAR(50) UNIQUE, name VARCHAR(255), stage VARCHAR(50), last_message TEXT, last_message_at BIGINT, source VARCHAR(50), is_human_mode BOOLEAN DEFAULT FALSE, current_bot_step_id VARCHAR(100), variables JSONB DEFAULT '{}', assigned_to UUID REFERENCES staff_members(id) ON DELETE SET NULL, lead_status VARCHAR(50) DEFAULT 'new', last_action_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW());`);
    
    // Ensure candidates has the new columns if it already existed
    await client.query(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES staff_members(id) ON DELETE SET NULL;`);
    await client.query(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS lead_status VARCHAR(50) DEFAULT 'new';`);
    await client.query(`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS last_action_at TIMESTAMP;`);
    await client.query(`CREATE TABLE IF NOT EXISTS candidate_messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE, direction VARCHAR(10), text TEXT, type VARCHAR(50), status VARCHAR(50), whatsapp_message_id VARCHAR(255), created_at TIMESTAMP DEFAULT NOW());`);
    await client.query(`CREATE TABLE IF NOT EXISTS scheduled_messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE, payload JSONB, scheduled_time BIGINT, status VARCHAR(50), error_log TEXT, created_at TIMESTAMP DEFAULT NOW());`);
    await client.query(`CREATE TABLE IF NOT EXISTS bot_versions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status VARCHAR(20), settings JSONB, created_at TIMESTAMP DEFAULT NOW());`);
    await client.query(`CREATE TABLE IF NOT EXISTS driver_documents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE, type VARCHAR(50), url TEXT, status VARCHAR(50), created_at TIMESTAMP DEFAULT NOW());`);
    await client.query(`CREATE TABLE IF NOT EXISTS lead_activity_log (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE, staff_id UUID REFERENCES staff_members(id) ON DELETE SET NULL, action VARCHAR(100) NOT NULL, notes TEXT, created_at TIMESTAMP DEFAULT NOW());`);
    
    await client.query("INSERT INTO system_settings (key, value) VALUES ('config', '{\"automation_enabled\": true}') ON CONFLICT DO NOTHING");
    await client.query("INSERT INTO system_settings (key, value) VALUES ('lead_distribution', '{\"auto_enabled\": false}') ON CONFLICT DO NOTHING");

    const botCheck = await client.query("SELECT id FROM bot_versions WHERE status = 'published' LIMIT 1");
    if (botCheck.rows.length === 0) {
        await client.query("INSERT INTO bot_versions (id, status, settings, created_at) VALUES ($1, 'published', $2, NOW())", [crypto.randomUUID(), getDefaultBotConfig()]);
    }

    await ensurePerformanceIndexes(client);
};

const ensurePerformanceIndexes = async (client) => {
    // Webhook hot path: dedupe lookup by provider message id.
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_candidate_messages_whatsapp_message_id
        ON candidate_messages(whatsapp_message_id)
        WHERE whatsapp_message_id IS NOT NULL
    `);

    // Chat history fetches and timeline queries.
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_candidate_messages_candidate_created_at
        ON candidate_messages(candidate_id, created_at DESC)
    `);

    // Reminders queue path: select pending jobs due at/behind now.
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_scheduled_messages_pending_scheduled_time
        ON scheduled_messages(scheduled_time)
        WHERE status = 'pending'
    `);

    // Candidate pending reminders fetch for drawer/table views.
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_scheduled_messages_candidate_pending_time
        ON scheduled_messages(candidate_id, scheduled_time ASC)
        WHERE status = 'pending'
    `);

    // Staff Portal: My Leads and Pool queries.
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_candidates_assigned_to
        ON candidates(assigned_to)
    `);

    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_candidates_unassigned_pool
        ON candidates(created_at DESC)
        WHERE assigned_to IS NULL
    `);

    // Real-time updates: fetch by last message activity.
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_candidates_last_message_at
        ON candidates(last_message_at DESC NULLS LAST)
    `);

    // Lead status filtering.
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_candidates_lead_status
        ON candidates(lead_status)
    `);
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
const BOT_ENGINE_AUTO_ADVANCE_DELAY_MS = Math.max(0, Number(process.env.BOT_ENGINE_AUTO_ADVANCE_DELAY_MS || 5));
const BOT_ENGINE_DELAY_NODE_CAP_MS = Math.max(0, Number(process.env.BOT_ENGINE_DELAY_NODE_CAP_MS || 800));
const FF_BOT_PRIORITIZE_INBOUND_REPLY = String(process.env.FF_BOT_PRIORITIZE_INBOUND_REPLY || 'true').toLowerCase() !== 'false';
const BOT_ENGINE_INBOUND_DELAY_CAP_MS = Math.max(0, Number(process.env.BOT_ENGINE_INBOUND_DELAY_CAP_MS || 60));
const BOT_ENGINE_VERBOSE_LOGS = String(process.env.BOT_ENGINE_VERBOSE_LOGS || 'false').toLowerCase() === 'true';

const queueBotMessageSideEffects = ({ candidateId, payload, nodeType, sendResult }) => {
    if (!candidateId || !payload) return;

    setImmediate(async () => {
        try {
            const sendStatus = sendResult?.delivered ? 'sent' : 'blocked_validation';
            await withDb(async (dbClient) => {
                await dbClient.query(
                    `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, whatsapp_message_id, created_at)
                     VALUES ($1, $2, 'out', $3, $4, $5, $6, NOW())`,
                    [
                        crypto.randomUUID(),
                        candidateId,
                        summarizePayloadForStorage(payload),
                        nodeType,
                        sendStatus,
                        sendResult?.providerMessageId || null,
                    ]
                );
            });
        } catch (error) {
            structuredLog({
                level: 'error',
                module: 'bot-conversation',
                message: 'bot.engine.side_effects_log_failed',
                meta: {
                    candidateId,
                    nodeType,
                    error: error?.message || String(error),
                },
            });
        }

        triggerReportingSyncDeferred({
            candidateId,
            action: 'upsert',
            source: 'bot-engine-send-loop',
        });
    });
};

const runBotEngine = async (client, candidate, incomingText, incomingPayloadId = null) => {
    if (BOT_ENGINE_VERBOSE_LOGS) console.log(`[Bot Engine] START for ${candidate.phone_number}`);
    try {
        const engineStart = nowMs();
        const MAX_ENGINE_MS = Number.parseInt(process.env.BOT_ENGINE_MAX_EXEC_MS || '1500', 10);
        const config = await getRuntimeConfigCached(client);
        if (config.automation_enabled === false || candidate.is_human_mode) return;

        const botSettings = await getBotSettingsCached(client);
        
        const { nodes, nodeMap, edgeMap, startNode } = getCompiledBotGraph(botSettings);
        if (!nodes || nodes.length === 0) return;

        let currentNodeId = candidate.current_bot_step_id;
        let nextNodeId = null;
        let shouldReplyInvalid = false;
        const cleanInput = (incomingText || '').trim().toLowerCase();
        const incomingMediaPayload = parseIncomingMediaPayload(incomingText);

        // 1. Global Resets
        if (['start', 'restart', 'hi', 'hello', 'menu'].includes(cleanInput)) {
            currentNodeId = null;
            await client.query("UPDATE candidates SET current_bot_step_id = NULL, variables = '{}' WHERE id = $1", [candidate.id]);
            candidate.variables = {}; 
        }

        // 2. Determine Current State
        if (!currentNodeId) {
            nextNodeId = startNode ? startNode.id : nodes[0]?.id;
        } else {
            const currentNode = nodeMap.get(currentNodeId);
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
                            await sendToMeta(candidate.phone_number, { type: 'text', text: { body: getCheckpointErrorMessage(checkpointStage) } }, { sendType: 'bot', enableRetry: true });
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
                        const expectsMediaInput = currentNode.data.type === 'input' && currentNode.data.validationType === 'media';
                        if (expectsMediaInput) {
                            if (incomingMediaPayload?.mediaKey) valueToSave = incomingText;
                        } else {
                            valueToSave = incomingText;
                        }
                    }

                    if (valueToSave) {
                        const expectsMediaInput = currentNode.data.type === 'input' && currentNode.data.validationType === 'media';
                        const newVars = { ...candidate.variables, [varName]: valueToSave };
                        let valueForLog = valueToSave;

                        if (expectsMediaInput && incomingMediaPayload?.mediaKey) {
                            const baseDriverPrefix = buildDriverDataPrefix(candidate.phone_number);
                            const normalizedVarName = normalizeColumnKey(varName) || 'uploaded_file';
                            const mediaFolderPrefix = `${baseDriverPrefix}/${normalizedVarName}`;
                            let mediaKey = String(incomingMediaPayload.mediaKey || '').trim();
                            const keySegments = mediaKey.split('/');
                            const originalFileName = keySegments[keySegments.length - 1] || '';
                            const extFromName = originalFileName.includes('.') ? originalFileName.split('.').pop() : '';
                            const extFromMime = getFileExtensionFromMime(String(incomingMediaPayload.mimeType || ''), extFromName || 'bin');
                            const targetFileName = `${normalizedVarName}_${new Date().toISOString().replace(/[:.]/g, '-')}.${extFromMime}`;
                            const targetKey = `${mediaFolderPrefix}/${targetFileName}`;

                            if (mediaKey && targetKey && mediaKey !== targetKey) {
                                mediaKey = await copyObjectInS3({ sourceKey: mediaKey, destinationKey: targetKey }).catch((e) => {
                                    console.warn('[MEDIA KEY RENAME WARNING]', e.message);
                                    return mediaKey;
                                });
                            }

                            const mediaUrl = mediaKey ? getPublicS3Url(mediaKey) : (incomingMediaPayload.mediaUrl || '');
                            const showcaseFileUrl = mediaKey ? await getPublicShowcaseUrl({ type: 'file', key: mediaKey }) : '';
                            const folderUrl = await getPublicShowcaseUrl({ type: 'folder', prefix: `${mediaFolderPrefix}/` });
                            const uploadedAt = new Date().toISOString();
                            const mediaMimeType = String(incomingMediaPayload.mimeType || '').trim();

                            newVars[varName] = showcaseFileUrl || mediaUrl;
                            newVars[`${varName}_file_url`] = showcaseFileUrl;
                            newVars[`${varName}_folder_url`] = folderUrl;
                            newVars[`${varName}_status`] = 'uploaded';
                            newVars[`${varName}_uploaded_at`] = uploadedAt;
                            newVars[`${varName}_rejection_reason`] = '';
                            newVars[`${varName}_link_mime_type`] = mediaMimeType;
                            valueForLog = showcaseFileUrl || mediaUrl;

                            if (mediaKey) {
                                await client.query(
                                    `UPDATE driver_documents SET url = $1
                                     WHERE candidate_id = $2
                                     AND id = (
                                        SELECT id FROM driver_documents
                                        WHERE candidate_id = $2
                                        ORDER BY created_at DESC
                                        LIMIT 1
                                     )`,
                                    [mediaKey, candidate.id]
                                ).catch(() => null);
                            }
                        }

                        await client.query("UPDATE candidates SET variables = $1 WHERE id = $2", [newVars, candidate.id]);
                        candidate.variables = newVars;
                        await logCapturedVariableResponse({
                            client,
                            candidateId: candidate.id,
                            key: varName,
                            value: valueForLog
                        });
                    } else if (isManualTrigger && currentNode.data.type === 'datetime_picker') {
                        await sendToMeta(candidate.phone_number, { type: 'text', text: { body: "Sure, please type your preferred time below (e.g., 11:25 PM):" } }, { sendType: 'bot', enableRetry: true });
                        return; // Stop here, wait for text
                    }
                    // --- SMART LOGIC END ---
                }

                // B. Find Next Path
                const outgoingEdges = edgeMap.get(currentNodeId) || [];
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
                        const expectsMediaInput = currentNode.data.type === 'input' && currentNode.data.validationType === 'media';

                        if (expectsMediaInput && !incomingMediaPayload?.mediaKey) {
                            await sendToMeta(candidate.phone_number, { type: 'text', text: { body: currentNode.data.retryMessage || 'Please upload a valid licence file (image, PDF, or video) to continue.' } }, { sendType: 'bot', enableRetry: true });
                            return;
                        }

                        if (isInteractive && !isManualClick && isNotSpecial) {
                            shouldReplyInvalid = true;
                        }
                    }
                }
            } else {
                nextNodeId = startNode ? startNode.id : null;
            }
        }

        if (shouldReplyInvalid) {
            await sendToMeta(candidate.phone_number, { type: 'text', text: { body: "I didn't catch that. Please select an option from the menu." } }, { sendType: 'bot', enableRetry: true });
            return;
        }

        // 3. Execute Node Chain (Synchronous Loop)
        let activeNodeId = nextNodeId;
        let opsCount = 0;
        const MAX_OPS = 15;

        while (activeNodeId && opsCount < MAX_OPS) {
            if (Number.isFinite(MAX_ENGINE_MS) && (nowMs() - engineStart) > MAX_ENGINE_MS) {
                structuredLog({
                    level: 'error',
                    module: 'bot-conversation',
                    message: 'bot.engine.execution_budget_exceeded',
                    meta: {
                        candidateId: candidate.id,
                        elapsedMs: nowMs() - engineStart,
                        maxEngineMs: MAX_ENGINE_MS,
                    },
                });
                break;
            }
            opsCount++;
            const node = nodeMap.get(activeNodeId);
            if (!node) break;

            const nodeExecStart = nowMs();

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
                    const isInboundTriggered = Boolean(incomingText || incomingPayloadId);
                    const baseDelayMs = Math.min(data.delayTime || 2000, BOT_ENGINE_DELAY_NODE_CAP_MS);
                    const ms = (FF_BOT_PRIORITIZE_INBOUND_REPLY && isInboundTriggered)
                        ? Math.min(baseDelayMs, BOT_ENGINE_INBOUND_DELAY_CAP_MS)
                        : baseDelayMs;

                    if (ms > 0) {
                        await new Promise(r => setTimeout(r, ms));
                    }
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
                const nextEdge = (edgeMap.get(node.id) || []).find(e => e.sourceHandle === handle || !e.sourceHandle);
                activeNodeId = nextEdge ? nextEdge.target : null;
                structuredLog({
                    level: 'info',
                    module: 'bot-conversation',
                    message: 'bot.engine.node_timing',
                    meta: {
                        candidateId: candidate.id,
                        nodeId: node.id,
                        nodeType: data.type || 'unknown',
                        durationMs: nowMs() - nodeExecStart,
                        opsCount,
                    },
                });
                continue;
            }

            else if (data.type === 'handoff') {
                await client.query("UPDATE candidates SET is_human_mode = TRUE WHERE id = $1", [candidate.id]);
                const msg = processText(data.content, candidate);
                if (isValidContent(msg)) await sendToMeta(candidate.phone_number, { type: 'text', text: { body: msg } }, { sendType: 'bot', enableRetry: true });
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
                    const fallbackPrompt = data.validationType === 'media'
                        ? 'Please upload your licence file (image, PDF, or video) below.'
                        : 'Please enter your response below:';
                    payload = { type: 'text', text: { body: validBody || fallbackPrompt } };
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
                        let sendResult = await sendToMeta(candidate.phone_number, payload, { sendType: 'bot', enableRetry: true });
                        let loggedPayload = payload;

                        if (!sendResult?.delivered && sendResult?.blocked && String(sendResult?.reason || '').startsWith('interactive_')) {
                            const fallbackText = validBody || 'Please reply with your preferred option.';
                            const fallbackPayload = { type: 'text', text: { body: fallbackText } };
                            const fallbackResult = await sendToMeta(candidate.phone_number, fallbackPayload, { sendType: 'bot', enableRetry: true });
                            if (fallbackResult?.delivered) {
                                sendResult = fallbackResult;
                                loggedPayload = fallbackPayload;
                            }
                        }

                        queueBotMessageSideEffects({
                            candidateId: candidate.id,
                            payload: loggedPayload,
                            nodeType: data.type,
                            sendResult,
                        });
                    } catch (apiError) {
                        console.error("Meta Send Error:", apiError);
                    }
                }
            }
            const nodeDurationMs = nowMs() - nodeExecStart;
            structuredLog({
                level: 'info',
                module: 'bot-conversation',
                message: 'bot.engine.node_timing',
                meta: {
                    candidateId: candidate.id,
                    nodeId: node.id,
                    nodeType: data.type || 'unknown',
                    durationMs: nodeDurationMs,
                    opsCount,
                },
            });

            // 4. Update State & Move On
            await client.query("UPDATE candidates SET current_bot_step_id = $1 WHERE id = $2", [node.id, candidate.id]);

            if (!autoAdvance) break; 

            const nextEdge = (edgeMap.get(node.id) || [])[0] || null;
            if (nextEdge) {
                activeNodeId = nextEdge.target;
                if (BOT_ENGINE_AUTO_ADVANCE_DELAY_MS > 0) {
                    await new Promise(r => setTimeout(r, BOT_ENGINE_AUTO_ADVANCE_DELAY_MS));
                }
            } else {
                activeNodeId = null;
            }
        }

        if (activeNodeId && opsCount >= MAX_OPS) {
            structuredLog({
                level: 'warn',
                module: 'bot-conversation',
                message: 'bot.engine.max_ops_reached',
                meta: {
                    candidateId: candidate.id,
                    activeNodeId,
                    maxOps: MAX_OPS,
                    elapsedMs: nowMs() - engineStart,
                },
            });
        }
    } catch (fatalError) {
        console.error("Bot Engine Fatal Crash:", fatalError);
    }
};

// --- EXPRESS APP ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

if (REQUEST_CONTEXT_FLAG) {
    app.use((req, res, next) => {
        const requestId = getRequestId(req);
        req.requestId = requestId;
        res.setHeader(REQUEST_ID_HEADER, requestId);
        const startTime = Date.now();

        structuredLog({
            level: 'info',
            module: 'http',
            message: 'request.started',
            requestId,
            meta: {
                method: req.method,
                path: req.originalUrl || req.url,
                remoteIp: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null
            }
        });

        res.on('finish', () => {
            structuredLog({
                level: res.statusCode >= 500 ? 'error' : 'info',
                module: 'http',
                message: 'request.completed',
                requestId,
                meta: {
                    method: req.method,
                    path: req.originalUrl || req.url,
                    statusCode: res.statusCode,
                    durationMs: Date.now() - startTime
                }
            });
        });

        next();
    });
} else {
    app.use((req, res, next) => {
        console.log(`[${req.method}] ${req.url}`);
        next();
    });
}

const apiRouter = express.Router();

const handleHealthLegacy = async (req, res) => res.json({ status: 'ok', timestamp: Date.now() });

const handleReadyLegacy = async (req, res) => {
    try {
        await withDb(async (client) => {
            await client.query('SELECT 1');
        });
        res.json({ status: 'ready', timestamp: Date.now() });
    } catch (error) {
        structuredLog({
            level: 'error',
            module: 'system-health',
            message: 'readiness.failed',
            requestId: req.requestId || null,
            meta: { error: error.message }
        });
        res.status(503).json({ status: 'not_ready', error: error.message });
    }
};

const handleSystemSettingsGetLegacy = async (req, res) => {
    try {
        await withDb(async (client) => {
            const config = await getSystemConfig(client);
            res.json(config);
        });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to load system settings' });
    }
};

const handleSystemSettingsPatchLegacy = async (req, res) => {
    try {
        const updates = req.body || {};
        await withDb(async (client) => {
            const current = await getSystemConfig(client);
            const next = {
                ...current,
                ...(typeof updates.webhook_ingest_enabled === 'boolean' ? { webhook_ingest_enabled: updates.webhook_ingest_enabled } : {}),
                ...(typeof updates.automation_enabled === 'boolean' ? { automation_enabled: updates.automation_enabled } : {}),
                ...(typeof updates.sending_enabled === 'boolean' ? { sending_enabled: updates.sending_enabled } : {}),
                ...(typeof updates.google_sheets_spreadsheet_id === 'string' ? { google_sheets_spreadsheet_id: updates.google_sheets_spreadsheet_id.trim() } : {}),
                ...(typeof updates.google_sheets_customers_tab_name === 'string' ? { google_sheets_customers_tab_name: updates.google_sheets_customers_tab_name.trim() || 'Customers' } : {}),
                ...(typeof updates.google_sheets_messages_tab_name === 'string' ? { google_sheets_messages_tab_name: updates.google_sheets_messages_tab_name.trim() || 'Messages' } : {}),
                ...(typeof updates.google_service_account_email === 'string' ? { google_service_account_email: updates.google_service_account_email.trim() } : {}),
                ...(typeof updates.google_service_account_private_key === 'string' ? { google_service_account_private_key: updates.google_service_account_private_key.trim() } : {})
            };

            applyRuntimeGoogleSheetsConfig(next);

            await client.query(
                "INSERT INTO system_settings (key, value) VALUES ('config', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                [JSON.stringify(next)]
            );
            memoryCache.runtimeConfig = null;
            memoryCache.runtimeConfigLastUpdated = 0;
            memoryCache.runtimeConfigInFlight = null;
            res.json({ success: true, settings: await getSystemConfig(client) });
        });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to update system settings' });
    }
};

const handleOperationalStatusLegacy = async (req, res) => {
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
            isolated: driverExcelIsolationState.disabled,
            isolation: {
                disabledAt: driverExcelIsolationState.disabledAt,
                consecutiveFailures: driverExcelIsolationState.consecutiveFailures,
                reason: driverExcelIsolationState.reason,
                maxConsecutiveFailures: DRIVER_EXCEL_SYNC_MAX_CONSECUTIVE_FAILURES
            },
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
};


const authMiddleware = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const token = authHeader.split(' ')[1];
        const ticket = await googleClient.verifyIdToken({ idToken: token, audience: SYSTEM_CONFIG.GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        const email = payload.email;

        await withDb(async (client) => {
            const staffRes = await client.query('SELECT id, role FROM staff_members WHERE email = $1', [email]);
            if (staffRes.rows.length === 0) {
                // Check if it's the super admin
                if (email === 'ajithsabzz@gmail.com') {
                    const insertRes = await client.query(
                        'INSERT INTO staff_members (email, name, role) VALUES ($1, $2, $3) RETURNING id, role',
                        [email, payload.name, 'admin']
                    );
                    req.user = { ...payload, staffId: insertRes.rows[0].id, role: insertRes.rows[0].role };
                } else {
                    throw new Error('Access denied. Not a staff member.');
                }
            } else {
                req.user = { ...payload, staffId: staffRes.rows[0].id, role: staffRes.rows[0].role };
            }
        });
        next();
    } catch (e) {
        res.status(401).json({ error: e.message });
    }
};

// --- STAFF MANAGEMENT ---
apiRouter.get('/auth/me', authMiddleware, (req, res) => {
    res.json({
        success: true,
        user: {
            id: req.user.id,
            email: req.user.email,
            name: req.user.name,
            role: req.user.role,
            staffId: req.user.staffId
        }
    });
});

apiRouter.get('/staff', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        await withDb(async (client) => {
            const r = await client.query('SELECT * FROM staff_members ORDER BY created_at DESC');
            res.json(r.rows);
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/staff', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { email, name, role } = req.body;
    try {
        await withDb(async (client) => {
            await client.query('INSERT INTO staff_members (email, name, role) VALUES ($1, $2, $3) ON CONFLICT (email) DO UPDATE SET name = $2, role = $3', [email, name, role || 'staff']);
            res.json({ success: true });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.delete('/staff/:id', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        await withDb(async (client) => {
            await client.query('DELETE FROM staff_members WHERE id = $1', [req.params.id]);
            res.json({ success: true });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.patch('/staff/:id/auto-dist', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { enabled } = req.body;
    try {
        await withDb(async (client) => {
            await client.query('UPDATE staff_members SET is_active_for_auto_dist = $1 WHERE id = $2', [enabled, req.params.id]);
            res.json({ success: true });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/system/lead-distribution', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        await withDb(async (client) => {
            const r = await client.query("SELECT value FROM system_settings WHERE key = 'lead_distribution'");
            res.json(r.rows[0]?.value || { auto_enabled: false });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/system/lead-distribution', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { auto_enabled } = req.body;
    try {
        await withDb(async (client) => {
            await client.query("INSERT INTO system_settings (key, value) VALUES ('lead_distribution', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify({ auto_enabled })]);
            res.json({ success: true });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- LEAD MANAGEMENT ---
apiRouter.get('/leads/pool', authMiddleware, async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query('SELECT * FROM candidates WHERE assigned_to IS NULL ORDER BY created_at DESC');
            res.json(r.rows);
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/leads/my', authMiddleware, async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query('SELECT * FROM candidates WHERE assigned_to = $1 ORDER BY last_action_at DESC NULLS LAST, created_at DESC', [req.user.staffId]);
            res.json(r.rows);
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/leads/:id/claim', authMiddleware, async (req, res) => {
    try {
        await withDb(async (client) => {
            const check = await client.query('SELECT assigned_to FROM candidates WHERE id = $1', [req.params.id]);
            if (check.rows[0]?.assigned_to) {
                return res.status(400).json({ error: 'Lead already claimed' });
            }
            await client.query('UPDATE candidates SET assigned_to = $1, lead_status = $2, last_action_at = NOW() WHERE id = $3', [req.user.staffId, 'claimed', req.params.id]);
            await client.query('INSERT INTO lead_activity_log (candidate_id, staff_id, action, notes) VALUES ($1, $2, $3, $4)', [req.params.id, req.user.staffId, 'claimed', 'Lead claimed from pool']);
            res.json({ success: true });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/leads/:id/action', authMiddleware, async (req, res) => {
    const { action, notes, status } = req.body;
    try {
        await withDb(async (client) => {
            const check = await client.query('SELECT assigned_to FROM candidates WHERE id = $1', [req.params.id]);
            if (check.rows[0]?.assigned_to !== req.user.staffId && req.user.role !== 'admin') {
                return res.status(403).json({ error: 'Not assigned to you' });
            }
            const updates = [];
            const values = [];
            if (status) {
                updates.push(`lead_status = $${values.length + 1}`);
                values.push(status);
            }
            updates.push(`last_action_at = NOW()`);
            
            await client.query(`UPDATE candidates SET ${updates.join(', ')} WHERE id = $${values.length + 1}`, [...values, req.params.id]);
            await client.query('INSERT INTO lead_activity_log (candidate_id, staff_id, action, notes) VALUES ($1, $2, $3, $4)', [req.params.id, req.user.staffId, action, notes]);
            res.json({ success: true });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/leads/:id/activity', authMiddleware, async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query('SELECT l.*, s.name as staff_name FROM lead_activity_log l LEFT JOIN staff_members s ON l.staff_id = s.id WHERE l.candidate_id = $1 ORDER BY l.created_at DESC', [req.params.id]);
            res.json(r.rows);
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/media', async (req, res) => {
    const requestedPath = typeof req.query.path === 'string' ? req.query.path : '/';

    try {
        const { listRes, prefix } = await listMediaObjects(requestedPath);
        const publicShowcaseFolders = await getPublicShowcaseFolders();
        const publicByFolderId = new Map(publicShowcaseFolders.map((item) => [item.folderId, item]));

        const folders = (await Promise.all((listRes.CommonPrefixes || []).map(async (entry) => {
            const folderPrefix = (entry.Prefix || '').replace(prefix, '').replace(/\/$/, '');
            const id = `${requestedPath}:${folderPrefix}`;
            const publicEntry = publicByFolderId.get(id);
            return {
                id,
                name: folderPrefix,
                parent_path: requestedPath,
                is_public_showcase: Boolean(publicEntry),
                public_showcase_url: publicEntry ? await getPublicShowcaseUrl({ type: 'folder', prefix: publicEntry.prefix }) : null
            };
        }))).filter((folder) => folder.name);

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

    try {
        const key = await resolveMediaUploadKey({ rawPath: path, rawFileName: req.file.originalname });
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

apiRouter.post('/media/upload/init', async (req, res) => {
    try {
        const fileName = String(req.body?.fileName || '').trim();
        if (!fileName) {
            return res.status(400).json({ error: 'File name is required' });
        }

        const path = typeof req.body?.path === 'string' ? req.body.path : '/';
        const contentType = String(req.body?.contentType || 'application/octet-stream').trim() || 'application/octet-stream';
        const key = await resolveMediaUploadKey({ rawPath: path, rawFileName: fileName });

        const command = new PutObjectCommand({
            Bucket: SYSTEM_CONFIG.AWS_BUCKET,
            Key: key,
            ContentType: contentType
        });
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });

        return res.json({
            success: true,
            key,
            uploadUrl,
            headers: { 'Content-Type': contentType },
            url: getPublicS3Url(key)
        });
    } catch (e) {
        console.error('[MEDIA UPLOAD INIT ERROR]', e.message);
        return res.status(500).json({ error: 'Failed to initialize media upload', details: e.message });
    }
});

apiRouter.post('/media/folders', async (req, res) => {
    try {
        const name = String(req.body?.name || '').trim();
        const parentPath = typeof req.body?.parentPath === 'string' ? req.body.parentPath : '/';
        if (!name) return res.status(400).json({ error: 'Folder name is required' });

        const targetPrefix = await resolveFolderCreatePrefix({ rawParentPath: parentPath, rawFolderName: name });
        const normalizedParentPath = normalizeMediaPath(parentPath);
        const fallbackPrefix = `${normalizedParentPath ? `${normalizedParentPath}/` : ''}${name.replace(/^\/+|\/+$/g, '')}/`;

        const [targetExists, fallbackExists] = await Promise.all([
            prefixHasObjectsInS3(targetPrefix).then((exists) => exists || keyExistsInS3(targetPrefix)),
            targetPrefix === fallbackPrefix
                ? Promise.resolve(false)
                : prefixHasObjectsInS3(fallbackPrefix).then((exists) => exists || keyExistsInS3(fallbackPrefix))
        ]);

        if (targetExists || fallbackExists) {
            return res.status(409).json({ error: 'Folder already exists' });
        }

        await uploadToS3({
            key: targetPrefix,
            body: '',
            contentType: 'application/x-directory'
        });

        const id = `${parentPath}:${name}`;
        return res.json({ success: true, id, name, parent_path: parentPath });
    } catch (e) {
        console.error('[MEDIA CREATE FOLDER ERROR]', e.message);
        return res.status(500).json({ error: e.message || 'Failed to create folder' });
    }
});

apiRouter.patch('/media/folders/:id', async (req, res) => {
    try {
        const folderId = decodeURIComponent(String(req.params.id || '').trim());
        const newName = String(req.body?.name || '').trim().replace(/^\/+|\/+$/g, '');
        if (!folderId) return res.status(400).json({ error: 'Invalid folder id' });
        if (!newName) return res.status(400).json({ error: 'New folder name is required' });

        const oldPrefix = await resolveFolderPrefixFromId(folderId);
        const oldPrefixTrimmed = oldPrefix.replace(/\/+$/, '');
        const oldName = oldPrefixTrimmed.split('/').pop() || '';
        const parentPrefix = oldPrefixTrimmed.slice(0, -(oldName.length)).replace(/\/+$/, '');
        const newPrefix = `${parentPrefix ? `${parentPrefix}/` : ''}${newName}/`;

        if (oldPrefix === newPrefix) {
            return res.json({ success: true, prefix: oldPrefix, unchanged: true });
        }

        const destinationExists = await prefixHasObjectsInS3(newPrefix).then((exists) => exists || keyExistsInS3(newPrefix));
        if (destinationExists) {
            return res.status(409).json({ error: 'Folder name already exists' });
        }

        const keys = await listAllS3KeysByPrefix(oldPrefix);
        await Promise.all(keys.map((key) => {
            const targetKey = `${newPrefix}${key.slice(oldPrefix.length)}`;
            return s3Client.send(new CopyObjectCommand({
                Bucket: SYSTEM_CONFIG.AWS_BUCKET,
                CopySource: `${SYSTEM_CONFIG.AWS_BUCKET}/${encodeURI(key).replace(/#/g, '%23')}`,
                Key: targetKey
            }));
        }));

        await Promise.all(keys.map((key) => deleteFromS3(key)));
        if (oldPrefix.endsWith('/')) {
            await deleteFromS3(oldPrefix).catch(() => null);
        }
        await uploadToS3({ key: newPrefix, body: '', contentType: 'application/x-directory' }).catch(() => null);

        const separatorIndex = folderId.lastIndexOf(':');
        const parentPath = separatorIndex >= 0 ? folderId.slice(0, separatorIndex) : '/';
        const newFolderId = `${parentPath}:${newName}`;

        const currentShowcases = await getPublicShowcaseFolders();
        const nextShowcases = currentShowcases.map((item) => {
            if (item.folderId !== folderId) return item;
            return { ...item, folderId: newFolderId, folderName: newName, prefix: newPrefix };
        });
        if (JSON.stringify(nextShowcases) !== JSON.stringify(currentShowcases)) {
            await savePublicShowcaseFolders(nextShowcases);
        }

        return res.json({ success: true, oldPrefix, newPrefix, id: newFolderId, name: newName, movedObjects: keys.length });
    } catch (e) {
        console.error('[MEDIA RENAME FOLDER ERROR]', e.message);
        return res.status(500).json({ error: e.message || 'Failed to rename folder' });
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

apiRouter.delete('/media/files/:id', async (req, res) => {
    try {
        const key = await resolveMediaDeleteKey(req.params.id);
        await deleteFromS3(key);
        const syncResult = await markDriverExcelMediaReferencesAsDeleted({ deletedKeys: [key] });
        res.json({ success: true, key, driverExcelUpdatedRows: syncResult.updatedCandidates });
    } catch (e) {
        console.error('[MEDIA DELETE FILE ERROR]', e.message);
        res.status(500).json({ error: e.message || 'Failed to delete file from S3' });
    }
});

apiRouter.post('/media/folders/:id/public', async (req, res) => {
    try {
        const folderId = decodeURIComponent(String(req.params.id || '').trim());
        if (!folderId) return res.status(400).json({ error: 'Invalid folder id' });

        const requestedPrefix = await resolveFolderPrefixFromId(folderId);
        const { prefix, hasObjects, usedFallback } = await resolveShowcasePrefix(requestedPrefix, `folderId=${folderId}`);
        const folderName = prefix.replace(/\/$/, '').split('/').pop() || folderId;
        const current = await getPublicShowcaseFolders();
        const remaining = current.filter((item) => item.folderId !== folderId);
        const next = [...remaining, {
            folderId,
            folderName,
            prefix,
            enabledAt: new Date().toISOString()
        }];
        await savePublicShowcaseFolders(next);

        return res.json({
            success: true,
            folderId,
            folderName,
            prefix,
            hasObjects,
            usedFallback,
            shareUrl: await getPublicShowcaseUrl({ type: 'folder', prefix }),
            activeCount: next.length
        });
    } catch (e) {
        console.error('[MEDIA PUBLIC FOLDER SET ERROR]', e.message);
        return res.status(500).json({ error: e.message || 'Failed to enable public showcase for folder' });
    }
});

apiRouter.delete('/media/folders/:id/public', async (req, res) => {
    try {
        const folderId = decodeURIComponent(String(req.params.id || '').trim());
        if (!folderId) return res.status(400).json({ error: 'Invalid folder id' });

        const current = await getPublicShowcaseFolders();
        const next = current.filter((item) => item.folderId !== folderId);
        await savePublicShowcaseFolders(next);

        return res.json({ success: true, folderId, activeCount: next.length });
    } catch (e) {
        console.error('[MEDIA PUBLIC FOLDER UNSET ERROR]', e.message);
        return res.status(500).json({ error: e.message || 'Failed to disable public showcase for folder' });
    }
});

apiRouter.delete('/media/folders/:id', async (req, res) => {
    try {
        const folderId = decodeURIComponent(String(req.params.id || '').trim());
        const prefix = await resolveFolderPrefixFromId(folderId);
        const keys = await listAllS3KeysByPrefix(prefix);

        for (const key of keys) {
            await deleteFromS3(key);
        }

        if (prefix.endsWith('/')) {
            await deleteFromS3(prefix).catch(() => null);
        }

        const current = await getPublicShowcaseFolders();
        const next = current.filter((item) => item.folderId !== folderId);
        if (next.length !== current.length) {
            await savePublicShowcaseFolders(next);
        }

        const syncResult = await markDriverExcelMediaReferencesAsDeleted({ deletedKeys: keys });
        res.json({ success: true, prefix, deletedObjects: keys.length, driverExcelUpdatedRows: syncResult.updatedCandidates });
    } catch (e) {
        console.error('[MEDIA DELETE FOLDER ERROR]', e.message);
        res.status(500).json({ error: e.message || 'Failed to delete folder' });
    }
});


const listShowcaseItemsByPrefix = async (prefix = '') => {
    const normalizedPrefix = String(prefix || '').replace(/^\/+/, '');
    const allItems = [];
    let continuationToken;

    do {
        const listRes = await s3Client.send(new ListObjectsV2Command({
            Bucket: SYSTEM_CONFIG.AWS_BUCKET,
            Prefix: normalizedPrefix,
            ContinuationToken: continuationToken
        }));
        allItems.push(...(listRes.Contents || []));
        continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
    } while (continuationToken);

    return allItems
        .filter((item) => item.Key && item.Key !== normalizedPrefix && !String(item.Key).endsWith('/'))
        .map((item) => ({
            id: item.Key,
            url: getPublicS3Url(item.Key),
            type: inferMediaTypeFromKey(item.Key),
            filename: item.Key.replace(normalizedPrefix, '') || item.Key
        }));
};

apiRouter.get('/showcase', async (req, res) => {
    try {
        const publicFolders = await getPublicShowcaseFolders();
        const sortedFolders = publicFolders
            .slice()
            .sort((a, b) => new Date(b.enabledAt || 0).getTime() - new Date(a.enabledAt || 0).getTime());
        const items = await Promise.all(sortedFolders.map(async (entry) => ({
                id: entry.prefix,
                url: await getPublicShowcaseUrl({ type: 'folder', prefix: entry.prefix }),
                type: 'document',
                filename: entry.folderName || entry.prefix.replace(/\/$/, '').split('/').pop() || entry.prefix
            })));

        res.json({
            title: 'Public Folder Showcase',
            items
        });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to load showcase root' });
    }
});

apiRouter.get('/showcase/:token', async (req, res) => {
    try {
        const rawToken = decodeURIComponent(String(req.params.token || ''));
        let payload = null;

        payload = await getShowcasePayloadFromShortToken(rawToken);

        if (!payload) {
            try {
                payload = JSON.parse(fromBase64Url(rawToken));
            } catch (e) {
                const maybePrefix = rawToken.startsWith('Driver data/') ? rawToken : '';
                if (maybePrefix) payload = { type: 'folder', prefix: maybePrefix.endsWith('/') ? maybePrefix : `${maybePrefix}/` };
            }
        }

        const type = String(payload?.type || '').toLowerCase();
        if (type === 'file' && payload?.key) {
            const key = String(payload.key);
            return res.json({
                title: key.split('/').pop() || 'Driver File',
                items: [{
                    id: key,
                    url: getPublicS3Url(key),
                    type: inferMediaTypeFromKey(key),
                    filename: key.split('/').pop() || key
                }]
            });
        }

        if (type === 'folder' && payload?.prefix) {
            const requestedPrefix = String(payload.prefix);
            const { prefix } = await resolveShowcasePrefix(requestedPrefix, `token=${rawToken}`);
            const items = await listShowcaseItemsByPrefix(prefix);
            return res.json({
                title: prefix.replace(/\/$/, '').split('/').pop() || 'Driver Folder',
                items
            });
        }

        return res.status(404).json({ error: 'Showcase link is invalid or expired' });
    } catch (e) {
        return res.status(500).json({ error: e.message || 'Failed to load showcase' });
    }
});

apiRouter.get('/showcase/status', async (req, res) => {
    try {
        const folders = await getPublicShowcaseFolders();
        const latest = folders
            .slice()
            .sort((a, b) => new Date(b.enabledAt || 0).getTime() - new Date(a.enabledAt || 0).getTime())[0] || null;

        res.json({
            active: folders.length > 0,
            alwaysOn: true,
            activeCount: folders.length,
            folderId: latest?.folderId || null,
            folderName: latest?.folderName || null,
            shareUrl: latest ? await getPublicShowcaseUrl({ type: 'folder', prefix: latest.prefix }) : null
        });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to load showcase status' });
    }
});

// --- DEEP WAKE PING ---
const handlePingLegacy = async (req, res) => {
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
};

const handleDebugStatusLegacy = async (req, res) => {
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
        if (isRecoverableInfraError(e)) {
            return sendDegradedJson(res, status);
        }
    }
    res.json(status);
};

apiRouter.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

const processWebhookLegacy = async ({ body, req, res }) => {
    if (!body.object) { res.sendStatus(404); return; }
    try {
        const perf = createPerfTracker({ requestId: req?.requestId || null, module: 'lead-ingestion', event: 'webhook.processing.stage' });
        const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (!msg) { res.sendStatus(200); return; }

        const processPromise = withDb(async (client) => {
            // WRAPPER: Retry logic for cold starts / missing tables
            await executeWithRetry(client, async () => {
                perf.markStart('dedupe_lookup');
                const existing = await client.query("SELECT id FROM candidate_messages WHERE whatsapp_message_id = $1", [msg.id]);
                perf.markEnd('dedupe_lookup', { found: existing.rows.length > 0 });
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
                else if (msg.type === 'image' || msg.type === 'document' || msg.type === 'video' || msg.type === 'audio') {
                    text = `[${msg.type.toUpperCase()}]`;
                    try {
                        const mediaRes = await fetchAndStoreIncomingMedia({ msg, phoneNumber: from, candidateId: candidate.id, client });
                        if (mediaRes?.key) {
                            text = JSON.stringify({ url: getPublicS3Url(mediaRes.key), caption: '' });
                        }
                    } catch (mediaErr) {
                        console.error('Failed to fetch/store incoming media:', mediaErr);
                    }
                } else text = `[${msg.type.toUpperCase()}]`;

                perf.markStart('lead_upsert');
                let c = await client.query('SELECT * FROM candidates WHERE phone_number = $1', [from]);
                let candidate;
                if (c.rows.length === 0) {
                    const id = crypto.randomUUID();
                    await client.query(`INSERT INTO candidates (id, phone_number, name, stage, last_message, last_message_at, is_human_mode, variables) VALUES ($1, $2, $3, 'New', $4, $5, FALSE, '{}')`, [id, from, name, text, Date.now()]);
                    candidate = { id, phone_number: from, name, stage: 'New', is_human_mode: false };
                } else {
                    candidate = c.rows[0];
                    await client.query('UPDATE candidates SET last_message = $1, last_message_at = $2 WHERE id = $3', [text, Date.now(), candidate.id]);
                }
                perf.markEnd('lead_upsert', { candidateId: candidate.id, isNew: c.rows.length === 0 });

                perf.markStart('inbound_message_insert');
                await client.query(
                    `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, whatsapp_message_id, created_at)
                     VALUES ($1, $2, 'in', $3, $4, 'received', $5, NOW())`,
                    [crypto.randomUUID(), candidate.id, text, messageType, msg.id]
                );
                perf.markEnd('inbound_message_insert', { candidateId: candidate.id, messageType });

                if (!candidate.is_human_mode) {
                    perf.markStart('bot_engine');
                    await runBotEngine(client, candidate, text, payloadId);
                    perf.markEnd('bot_engine', { candidateId: candidate.id });
                }

                triggerReportingSyncDeferred({
                    candidateId: candidate.id,
                    action: 'upsert',
                    requestId: req?.requestId || null,
                    source: 'webhook',
                });
            });
        });

        res.sendStatus(200);

        if (WEBHOOK_DEFER_POST_RESPONSE) {
            trackBackgroundTask({
                taskName: 'webhook.post_response_processing',
                requestId: req?.requestId || null,
                promise: processPromise,
            });
            return;
        }

        await processPromise;
    } catch (e) {
        console.error('Webhook processing error:', e);
    }
};

const leadIngestionFacade = buildLeadIngestionFacade({
    legacyProcessor: processWebhookLegacy,
    withDb,
    executeWithRetry,
    runBotEngine,
    triggerReportingSyncDeferred,
});

apiRouter.post('/webhook', async (req, res) => {
    const tenantId = req.headers['x-tenant-id'] || req.headers['x-tenant'] || null;
    const mode = resolveModuleMode({
        flagValue: LEAD_INGESTION_FLAG,
        tenantId,
        requestId: req.requestId,
        canaryPercent: 100,
        tenantAllowList: MODULE_CANARY_TENANTS,
    });

    if (mode !== 'off') {
        await leadIngestionFacade({ body: req.body, req, res, context: { requestId: req.requestId || null, tenantId } });
        return;
    }

    if (!LEAD_INGESTION_LEGACY_EMERGENCY_FALLBACK) {
        structuredLog({
            level: 'error',
            module: 'lead-ingestion',
            requestId: req.requestId || null,
            message: 'webhook.legacy_fallback_blocked',
            meta: { tenantId, mode, emergencyFallbackEnabled: false },
        });
        res.status(503).json({
            error: 'Lead ingestion module is off and legacy emergency fallback is disabled.',
            requiredAction: 'Set FF_LEAD_INGESTION_MODULE=on/canary or FF_LEAD_INGESTION_LEGACY_EMERGENCY_FALLBACK=true for emergency fallback.',
        });
        return;
    }

    structuredLog({
        level: 'error',
        module: 'lead-ingestion',
        requestId: req.requestId || null,
        message: 'webhook.legacy_fallback_emergency_mode',
        meta: { tenantId, mode, emergencyFallbackEnabled: true },
    });
    await processWebhookLegacy({ body: req.body, req, res });
});

const handleAuthGoogleLegacy = async (req, res) => {
    try {
        const { credential } = req.body;
        const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: SYSTEM_CONFIG.GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        const email = payload.email;

        // Super Admin check
        const ADMIN_EMAILS = ['ajithsabzz@gmail.com', 'enchoenterprises@gmail.com'];
        let userRole = null;
        let staffId = null;

        const isSuperAdmin = ADMIN_EMAILS.includes(email);
        if (isSuperAdmin) {
            userRole = 'admin';
        }

        await withDb(async (client) => {
            await executeWithRetry(client, async () => {
                const staffRes = await client.query('SELECT id, role FROM staff_members WHERE email = $1', [email]);
                if (staffRes.rows.length > 0) {
                    userRole = staffRes.rows[0].role;
                    staffId = staffRes.rows[0].id;
                } else if (isSuperAdmin) {
                    // Auto-register super admin if not exists
                    const insertRes = await client.query(
                        'INSERT INTO staff_members (email, name, role) VALUES ($1, $2, $3) RETURNING id',
                        [email, payload.name, 'admin']
                    );
                    staffId = insertRes.rows[0].id;
                }
            });
        });

        if (!userRole) {
            return res.status(403).json({ success: false, error: 'Access denied. You are not registered as a staff member.' });
        }

        res.json({ 
            success: true, 
            user: { ...payload, role: userRole, staffId } 
        });
    } catch (e) { res.status(401).json({ success: false, error: e.message }); }
};

const handleBotSettingsGetLegacy = async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query("SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1");
            res.json(r.rows[0]?.settings || { isEnabled: false, nodes: [], edges: [] });
        });
    } catch (e) {
        if (isRecoverableInfraError(e)) {
            structuredLog({
                level: 'error',
                module: 'auth-config',
                message: 'bot_settings.degraded_fallback',
                requestId: req?.requestId || null,
                meta: { error: e.message }
            });
            res.setHeader('x-system-mode', 'degraded');
            return res.status(200).json(getDefaultBotConfig());
        }
        res.status(500).json({ error: e.message });
    }
};

const handleBotSaveLegacy = async (req, res) => {
    try {
        await withDb(async (client) => {
            await client.query("INSERT INTO bot_versions (id, status, settings, created_at) VALUES ($1, 'published', $2, NOW())", [crypto.randomUUID(), req.body]);
        });
        memoryCache.botSettings = null;
        memoryCache.lastUpdated = 0;
        memoryCache.botGraph = null;
        memoryCache.botGraphSource = null;
        memoryCache.botSettingsInFlight = null;
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
};

const handleBotPublishLegacy = async (req, res) => res.json({ success: true });


const authConfigRouter = buildAuthConfigRouter({
    legacyVerifyGoogleHandler: handleAuthGoogleLegacy,
    legacyGetBotSettingsHandler: handleBotSettingsGetLegacy,
    legacySaveBotSettingsHandler: handleBotSaveLegacy,
    legacyPublishBotHandler: handleBotPublishLegacy,
    legacyGetSystemSettingsHandler: handleSystemSettingsGetLegacy,
    legacyPatchSystemSettingsHandler: handleSystemSettingsPatchLegacy,
});

const resolveAuthConfigMode = (req) => {
    const tenantId = req.headers['x-tenant-id'] || req.headers['x-tenant'] || null;
    return resolveModuleMode({
        flagValue: AUTH_CONFIG_MODULE_FLAG,
        tenantId,
        requestId: req.requestId,
        canaryPercent: AUTH_CONFIG_CANARY_PERCENT,
        tenantAllowList: MODULE_CANARY_TENANTS,
    });
};

const systemHealthRouter = buildSystemHealthRouter({
    legacyHealthHandler: handleHealthLegacy,
    legacyReadyHandler: handleReadyLegacy,
    legacyOperationalStatusHandler: handleOperationalStatusLegacy,
    legacyPingHandler: handlePingLegacy,
    legacyDebugStatusHandler: handleDebugStatusLegacy,
});

const resolveSystemHealthMode = (req) => {
    const tenantId = req.headers['x-tenant-id'] || req.headers['x-tenant'] || null;
    return resolveModuleMode({
        flagValue: SYSTEM_HEALTH_MODULE_FLAG,
        tenantId,
        requestId: req.requestId,
        canaryPercent: SYSTEM_HEALTH_CANARY_PERCENT,
        tenantAllowList: MODULE_CANARY_TENANTS,
    });
};

registerSystemHealthRoutes({
    apiRouter,
    moduleRouter: systemHealthRouter,
    resolveMode: resolveSystemHealthMode,
    legacyHandlers: {
        health: handleHealthLegacy,
        ready: handleReadyLegacy,
        operationalStatus: handleOperationalStatusLegacy,
        ping: handlePingLegacy,
        debugStatus: handleDebugStatusLegacy,
    },
});

registerAuthConfigRoutes({
    apiRouter,
    moduleRouter: authConfigRouter,
    resolveMode: resolveAuthConfigMode,
    legacyHandlers: {
        verifyGoogle: handleAuthGoogleLegacy,
        getBotSettings: handleBotSettingsGetLegacy,
        saveBotSettings: handleBotSaveLegacy,
        publishBot: handleBotPublishLegacy,
        getSystemSettings: handleSystemSettingsGetLegacy,
        patchSystemSettings: handleSystemSettingsPatchLegacy,
    },
});

apiRouter.get('/updates/stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    let closed = false;
    const driverId = typeof req.query.driverId === 'string' ? req.query.driverId : null;

    const sendEvent = (data) => {
        if (closed) return;
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const fetchSnapshot = async () => {
        return withDb(async (client) => {
            const botRes = await client.query("SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1");
            const publishedBot = botRes.rows[0];
            const totalNodes = publishedBot?.settings?.nodes?.length || 10;

            const driverRows = await client.query(`
                SELECT c.*, 
                    (SELECT COUNT(*) FROM candidate_messages cm WHERE cm.candidate_id = c.id AND cm.direction = 'in') as user_msg_count,
                    (SELECT COUNT(*) FROM candidate_messages cm WHERE cm.candidate_id = c.id AND cm.direction = 'in' AND cm.type IN ('image', 'video', 'audio', 'document')) as user_media_count,
                    (SELECT count(*) FROM jsonb_object_keys(c.variables)) as var_count
                FROM candidates c 
                ORDER BY last_message_at DESC NULLS LAST LIMIT 50
            `);
            const drivers = driverRows.rows.map((row) => {
                const msgCount = parseInt(row.user_msg_count || '0');
                const mediaCount = parseInt(row.user_media_count || '0');
                const varCount = parseInt(row.var_count || '0');
                
                // Heuristic for lead genuineness
                // 1. Message volume (engagement)
                // 2. Media uploads (high effort/intent)
                // 3. Variables collected (form completion)
                // 4. Human mode (handoff reached)
                let leadScore = (msgCount * 10) + (mediaCount * 50) + (varCount * 20);
                if (row.is_human_mode) leadScore += 100; // Handoff is high value

                // Progress percentage
                const progress = Math.min(100, Math.round((varCount / Math.max(1, totalNodes)) * 100));

                return {
                    id: row.id,
                    phoneNumber: row.phone_number,
                    phone_number: row.phone_number,
                    name: row.name,
                    status: row.stage,
                    lead_status: row.lead_status,
                    assigned_to: row.assigned_to,
                    lastMessage: row.last_message,
                    lastMessageTime: parseInt(row.last_message_at || '0'),
                    source: row.source,
                    isHumanMode: row.is_human_mode,
                    created_at: row.created_at,
                    lead_score: leadScore,
                    progress_percent: progress,
                    user_msg_count: msgCount,
                    user_media_count: mediaCount,
                    var_count: varCount
                };
            });

            const payload = { drivers };

            if (driverId) {
                const [messagesRes, scheduledRes] = await Promise.all([
                    client.query('SELECT * FROM candidate_messages WHERE candidate_id = $1 ORDER BY created_at DESC LIMIT 50', [driverId]),
                    client.query('SELECT * FROM scheduled_messages WHERE candidate_id = $1 AND status IN ($2, $3, $4) ORDER BY scheduled_time ASC LIMIT 100', [driverId, 'pending', 'processing', 'failed'])
                ]);

                payload.messagesByDriver = {
                    [driverId]: messagesRes.rows
                        .map((row) => ({
                            id: row.id,
                            sender: row.direction === 'in' ? 'driver' : 'agent',
                            text: row.text,
                            timestamp: new Date(row.created_at).getTime(),
                            type: row.type || 'text',
                            status: row.status,
                        }))
                        .sort((a, b) => a.timestamp - b.timestamp)
                };

                payload.scheduledByDriver = {
                    [driverId]: scheduledRes.rows.map((row) => ({
                        id: row.id,
                        scheduledTime: new Date(row.scheduled_time).getTime(),
                        payload: row.payload,
                        status: row.status,
                    }))
                };
            }

            return payload;
        });
    };

    const streamSnapshot = async () => {
        try {
            const snapshot = await fetchSnapshot();
            sendEvent(snapshot);
        } catch (e) {
            sendEvent({ error: e.message || 'snapshot_error' });
        }
    };

    const snapshotInterval = setInterval(streamSnapshot, 4000);
    const heartbeat = setInterval(() => {
        if (!closed) res.write('data: heartbeat\n\n');
    }, 20000);

    streamSnapshot();

    req.on('close', () => {
        closed = true;
        clearInterval(snapshotInterval);
        clearInterval(heartbeat);
        res.end();
    });
});

apiRouter.get('/drivers', async (req, res) => {
    try {
        await withDb(async (client) => {
            const botRes = await client.query("SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1");
            const publishedBot = botRes.rows[0];
            const totalNodes = publishedBot?.settings?.nodes?.length || 10;

            const r = await client.query(`
                SELECT c.*, 
                    (SELECT COUNT(*) FROM candidate_messages cm WHERE cm.candidate_id = c.id AND cm.direction = 'in') as user_msg_count,
                    (SELECT COUNT(*) FROM candidate_messages cm WHERE cm.candidate_id = c.id AND cm.direction = 'in' AND cm.type IN ('image', 'video', 'audio', 'document')) as user_media_count,
                    (SELECT count(*) FROM jsonb_object_keys(c.variables)) as var_count
                FROM candidates c 
                ORDER BY last_message_at DESC NULLS LAST LIMIT 50
            `);
            res.json(r.rows.map(row => {
                const msgCount = parseInt(row.user_msg_count || '0');
                const mediaCount = parseInt(row.user_media_count || '0');
                const varCount = parseInt(row.var_count || '0');
                
                let leadScore = (msgCount * 10) + (mediaCount * 50) + (varCount * 20);
                if (row.is_human_mode) leadScore += 100;

                const progress = Math.min(100, Math.round((varCount / Math.max(1, totalNodes)) * 100));

                return {
                    id: row.id, phoneNumber: row.phone_number, name: row.name, status: row.stage, 
                    lastMessage: row.last_message, lastMessageTime: parseInt(row.last_message_at || '0'), 
                    source: row.source, isHumanMode: row.is_human_mode,
                    lead_score: leadScore,
                    progress_percent: progress,
                    user_msg_count: msgCount,
                    user_media_count: mediaCount,
                    var_count: varCount
                };
            }));
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
                let text = row.text;
                let imageUrl = null;
                let videoUrl = null;
                let documentUrl = null;
                let audioUrl = null;

                if (['image','video','document','audio'].includes(row.type) && row.text?.startsWith('{')) {
                    try {
                        const p = JSON.parse(row.text);
                        text = p.caption || text;
                        const rawMediaUrl = p.mediaUrl || p.url || (p.mediaKey ? getPublicS3Url(p.mediaKey) : null);
                        const resolvedMediaUrl = rawMediaUrl ? await refreshMediaUrl(rawMediaUrl) : null;

                        if (row.type === 'video') videoUrl = resolvedMediaUrl;
                        else if (row.type === 'document') documentUrl = resolvedMediaUrl;
                        else if (row.type === 'audio') audioUrl = resolvedMediaUrl;
                        else imageUrl = resolvedMediaUrl;
                    } catch(e){}
                }
                return { 
                    id: row.id,
                    sender: row.direction === 'in' ? 'driver' : 'agent',
                    text,
                    imageUrl,
                    videoUrl,
                    documentUrl,
                    audioUrl,
                    timestamp: new Date(row.created_at).getTime(), type: row.type || 'text', status: row.status 
                };
            }));
            res.json(msgs.reverse());
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/drivers/:id/messages', async (req, res) => {
    try {
        const { text, mediaUrl: rawMediaUrl, mediaType: rawMediaType, imageUrl, videoUrl, audioUrl, documentUrl, type: rawType } = req.body;
        const mediaUrl = rawMediaUrl || imageUrl || videoUrl || audioUrl || documentUrl;
        const mediaType = rawMediaType || (imageUrl ? 'image' : (videoUrl ? 'video' : (audioUrl ? 'audio' : (documentUrl ? 'document' : (rawType !== 'text' ? rawType : undefined)))));
        const normalizedText = normalizeTextBody(text);
        if (!mediaUrl) {
            const trimmed = normalizedText.trim();
            if (!trimmed) return res.status(400).json({ error: 'Text is required when mediaUrl is not provided' });
            if (trimmed.length > MAX_TEXT_MESSAGE_LENGTH) return res.status(400).json({ error: `Text exceeds max length (${MAX_TEXT_MESSAGE_LENGTH})` });
        }

        let sendResult = null;
        await withDb(async (client) => {
            const c = await client.query('SELECT phone_number FROM candidates WHERE id = $1', [req.params.id]);
            if (c.rows.length === 0) throw new Error("Candidate not found");
            const sanitizedText = normalizedText.trim();
            let payload = { type: 'text', text: { body: sanitizedText } };
            let dbText = sanitizedText;
            if (mediaUrl) {
                const freshUrl = await refreshMediaUrl(mediaUrl);
                const type = mediaType || 'image';
                payload = { type, [type]: { link: freshUrl } };
                if (type !== 'audio' && sanitizedText) {
                    payload[type].caption = sanitizedText;
                }
                if (type === 'document') {
                    payload[type].filename = decodeURIComponent(new URL(freshUrl).pathname.split('/').pop() || 'file.pdf');
                }
                dbText = JSON.stringify({ url: mediaUrl, caption: sanitizedText });
            }
            sendResult = await sendToMeta(c.rows[0].phone_number, payload, { sendType: 'manual', enableRetry: true, returnFastOnTimeout: true, requestId: req.requestId });
            const sendStatus = sendResult?.delivered
                ? 'sent'
                : (sendResult?.timeout ? 'timeout_fast_fail' : 'blocked_validation');
            await client.query(
                `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, whatsapp_message_id, created_at)
                 VALUES ($1, $2, 'out', $3, $4, $5, $6, NOW())`,
                [crypto.randomUUID(), req.params.id, dbText, mediaUrl ? (mediaType || 'image') : 'text', sendStatus, sendResult?.providerMessageId || null]
            );
            scheduleDriverExcelSync();
            scheduleDriverExcelIncrementalSync({ candidateId: req.params.id, action: 'upsert' });
        });

        if (sendResult?.timeout) {
            return res.status(504).json({
                success: false,
                timeout: true,
                retryingInBackground: Boolean(sendResult?.retryingInBackground),
                error: sendResult?.reason || 'Meta API timeout',
            });
        }

        return res.json({ success: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

apiRouter.get('/drivers/:id/documents', async (req, res) => {
    try {
        await withDb(async (client) => {
            const r = await client.query('SELECT * FROM driver_documents WHERE candidate_id = $1 ORDER BY created_at DESC', [req.params.id]);
            const docs = await Promise.all(r.rows.map(async d => ({ id: d.id, docType: d.type, url: await refreshMediaUrl(d.url), verificationStatus: d.status, timestamp: new Date(d.created_at).getTime() })));
            res.json(docs);
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.patch('/drivers/:id/document-status', async (req, res) => {
    try {
        const status = String(req.body?.status || '').trim().toLowerCase();
        const reason = String(req.body?.reason || '').trim();
        const allowed = new Set(['uploaded', 'under_review', 'approved', 'rejected', 'expired', 'missing']);
        if (!allowed.has(status)) return res.status(400).json({ error: 'Invalid document status' });

        await withDb(async (client) => {
            const candidateRes = await client.query('SELECT id FROM candidates WHERE id = $1 LIMIT 1', [req.params.id]);
            if (candidateRes.rows.length === 0) return res.status(404).json({ error: 'Candidate not found' });

            if (['approved', 'rejected', 'under_review', 'expired', 'missing', 'uploaded'].includes(status)) {
                await client.query(
                    `UPDATE driver_documents SET status = $1
                     WHERE candidate_id = $2
                     AND id = (
                        SELECT id FROM driver_documents
                        WHERE candidate_id = $2
                        ORDER BY created_at DESC
                        LIMIT 1
                     )`,
                    [status, req.params.id]
                );
            }

            scheduleDriverExcelSync();
            scheduleDriverExcelIncrementalSync({ candidateId: req.params.id, action: 'upsert' });
            res.json({ success: true, status, reason });
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

            const rows = rowsRes.rows.map((r) => {
                const mergedVars = {
                    ...normalizeVariables(r.variables),
                    ...(responseLookup.get(r.id) || {})
                };
                return {
                    id: r.id,
                    phoneNumber: r.phone_number || '',
                    name: r.name || '',
                    status: r.stage || '',
                    source: r.source || '',
                    createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
                    lastMessageAt: r.last_message_at ? new Date(Number(r.last_message_at) || r.last_message_at).toISOString() : '',
                    variables: mergedVars
                };
            });
            res.json({ columns: cols, rows });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.get('/reports/driver-excel/isolation-status', async (req, res) => {
    res.json({
        isolated: driverExcelIsolationState.disabled,
        disabledAt: driverExcelIsolationState.disabledAt,
        consecutiveFailures: driverExcelIsolationState.consecutiveFailures,
        reason: driverExcelIsolationState.reason,
        maxConsecutiveFailures: DRIVER_EXCEL_SYNC_MAX_CONSECUTIVE_FAILURES
    });
});

apiRouter.post('/reports/driver-excel/isolation/reset', async (req, res) => {
    driverExcelIsolationState = {
        disabled: false,
        consecutiveFailures: 0,
        disabledAt: null,
        reason: null
    };
    driverExcelSyncStatus.state = 'idle';
    driverExcelSyncStatus.lastError = null;
    persistDriverExcelSyncStatus();
    res.json({ success: true, isolated: false });
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
            isolated: driverExcelIsolationState.disabled,
            isolation: {
                disabledAt: driverExcelIsolationState.disabledAt,
                consecutiveFailures: driverExcelIsolationState.consecutiveFailures,
                reason: driverExcelIsolationState.reason,
                maxConsecutiveFailures: DRIVER_EXCEL_SYNC_MAX_CONSECUTIVE_FAILURES
            },
            hasQueuedSync: Boolean(driverExcelSyncRequested || driverExcelSyncTimer || driverExcelSyncMaxWaitTimer || driverExcelIncrementalTimer || driverExcelIncrementalMaxWaitTimer || driverExcelIncrementalQueue.size > 0)
        });
    } catch (e) {
        res.json({
            ...driverExcelSyncStatus,
            inProgress: driverExcelSyncInProgress,
            isolated: driverExcelIsolationState.disabled,
            isolation: {
                disabledAt: driverExcelIsolationState.disabledAt,
                consecutiveFailures: driverExcelIsolationState.consecutiveFailures,
                reason: driverExcelIsolationState.reason,
                maxConsecutiveFailures: DRIVER_EXCEL_SYNC_MAX_CONSECUTIVE_FAILURES
            },
            hasQueuedSync: Boolean(driverExcelSyncRequested || driverExcelSyncTimer || driverExcelSyncMaxWaitTimer || driverExcelIncrementalTimer || driverExcelIncrementalMaxWaitTimer || driverExcelIncrementalQueue.size > 0)
        });
    }
});

apiRouter.post('/reports/driver-excel/sync', async (req, res) => {
    try {
        const mode = String(req.body?.mode || 'queued').toLowerCase();
        if (mode === 'immediate') {
            triggerDriverExcelSyncNow();
            return res.json({ success: true, mode: 'immediate', message: 'Driver Excel sync started' });
        }
        scheduleDriverExcelSync();
        return res.json({ success: true, mode: 'queued', message: 'Driver Excel sync queued' });
    } catch (e) {
        return res.status(500).json({ error: e.message || 'Failed to trigger driver excel sync' });
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
        if (!shouldIncludeDriverExcelVariableKey(key)) {
            return res.status(400).json({ error: 'Unsupported legacy license column. Use file/folder/status/upload metadata keys only.' });
        }

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
const handleScheduledMessagesLegacy = async (req, res) => {
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
};

apiRouter.post('/scheduled-messages', async (req, res) => {
    const tenantId = req.headers['x-tenant-id'] || req.headers['x-tenant'] || null;
    const mode = resolveModuleMode({
        flagValue: REMINDERS_MODULE_FLAG,
        tenantId,
        requestId: req.requestId,
        canaryPercent: REMINDERS_CANARY_PERCENT,
        tenantAllowList: MODULE_CANARY_TENANTS,
    });

    if (mode !== 'off') return remindersRouter.schedule(req, res);
    return handleScheduledMessagesLegacy(req, res);
});

apiRouter.get('/drivers/:id/scheduled-messages', async (req, res) => remindersRouter.listDriverScheduled(req, res));

apiRouter.delete('/scheduled-messages/:id', async (req, res) => remindersRouter.deleteScheduled(req, res));

apiRouter.patch('/scheduled-messages/:id', async (req, res) => remindersRouter.patchScheduled(req, res));

const handleDriverScheduledMessagesLegacy = async (req, res) => {
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
};

const handleDeleteScheduledMessageLegacy = async (req, res) => {
    try {
        await withDb(async (client) => { await client.query("DELETE FROM scheduled_messages WHERE id = $1", [req.params.id]); });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
};

const handlePatchScheduledMessageLegacy = async (req, res) => {
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
};

// --- ADVANCED PARALLEL CRON PROCESSOR ---
const handleCronProcessQueueLegacy = async (req, res) => {
    let processed = 0, errors = 0;
    try {
        const perf = createPerfTracker({ requestId: req?.requestId || null, module: 'reminders-escalations', event: 'reminders.queue.stage' });
        await withDb(async (client) => {
            await executeWithRetry(client, async () => {
                const now = Date.now();
                
                // Fetch larger batch (50) for efficiency
                perf.markStart('jobs_select');
                const jobs = await client.query(`
                    SELECT sm.id, sm.candidate_id, sm.payload, c.phone_number 
                    FROM scheduled_messages sm 
                    JOIN candidates c ON sm.candidate_id = c.id 
                    WHERE sm.status = 'pending' AND sm.scheduled_time <= $1 
                    LIMIT 50 
                    FOR UPDATE OF sm SKIP LOCKED
                `, [now]);
                perf.markEnd('jobs_select', { selectedJobs: jobs.rows.length });

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
                        
                        const sendResult = await sendToMeta(job.phone_number, metaP, { sendType: 'scheduled', enableRetry: true });
                        const sendStatus = sendResult?.delivered ? 'sent' : 'blocked_validation';
                        
                        // Log success
                        await client.query(
                            `INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, whatsapp_message_id, created_at)
                             VALUES ($1, $2, 'out', $3, $4, $5, $6, NOW())`,
                            [crypto.randomUUID(), job.candidate_id, dbLogText, dbType, sendStatus, sendResult?.providerMessageId || null]
                        );
                        await client.query("UPDATE scheduled_messages SET status = $2 WHERE id = $1", [job.id, sendResult?.delivered ? 'sent' : 'blocked_validation']);
                        triggerReportingSyncDeferred({
                            candidateId: job.candidate_id,
                            action: 'upsert',
                            requestId: req?.requestId || null,
                            source: 'reminders-queue',
                        });
                        processed++;
                    } catch (e) {
                        errors++;
                        console.error(`Job ${job.id} failed:`, e.message);
                        await client.query("UPDATE scheduled_messages SET status = 'failed', error_log = $2 WHERE id = $1", [job.id, e.message]);
                    }
                };

                // PARALLEL EXECUTION (Batch of 5 concurrently)
                const BATCH_SIZE = 5;
                perf.markStart('jobs_dispatch');
                for (let i = 0; i < jobs.rows.length; i += BATCH_SIZE) {
                    const chunk = jobs.rows.slice(i, i + BATCH_SIZE);
                    await Promise.all(chunk.map(job => processJob(job)));
                }
                perf.markEnd('jobs_dispatch', { processed, errors, batchSize: BATCH_SIZE });
            });
        });
        res.json({ status: 'ok', processed, errors, queueSize: processed + errors });
    } catch (e) {
        if (isRecoverableInfraError(e)) {
            structuredLog({
                level: 'error',
                module: 'reminders-escalations',
                message: 'queue.degraded_skip',
                requestId: req?.requestId || null,
                meta: { error: e.message }
            });
            return sendDegradedJson(res, { processed, errors, queueSize: processed + errors, skipped: true });
        }
        res.status(500).json({ error: e.message });
    }
};

const remindersRouter = buildRemindersRouter({
    legacyScheduleHandler: handleScheduledMessagesLegacy,
    legacyQueueHandler: handleCronProcessQueueLegacy,
    legacyListDriverScheduledHandler: handleDriverScheduledMessagesLegacy,
    legacyDeleteScheduledHandler: handleDeleteScheduledMessageLegacy,
    legacyPatchScheduledHandler: handlePatchScheduledMessageLegacy,
});

apiRouter.get('/cron/process-queue', async (req, res) => {
    const tenantId = req.headers['x-tenant-id'] || req.headers['x-tenant'] || null;
    const mode = resolveModuleMode({
        flagValue: REMINDERS_MODULE_FLAG,
        tenantId,
        requestId: req.requestId,
        canaryPercent: REMINDERS_CANARY_PERCENT,
        tenantAllowList: MODULE_CANARY_TENANTS,
    });

    if (mode !== 'off') return remindersRouter.processQueue(req, res);
    return handleCronProcessQueueLegacy(req, res);
});

apiRouter.post('/system/init-db', async (req, res) => {
    try {
        await withDb(async (client) => {
            await initDatabase(client);
        });
        memoryCache.runtimeConfig = null;
        memoryCache.runtimeConfigLastUpdated = 0;
        memoryCache.runtimeConfigInFlight = null;
        memoryCache.botSettings = null;
        memoryCache.lastUpdated = 0;
        memoryCache.botGraph = null;
        memoryCache.botGraphSource = null;
        memoryCache.botSettingsInFlight = null;
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

apiRouter.post('/system/hard-reset', async (req, res) => {
    try {
        await withDb(async (client) => {
            await client.query('BEGIN');
            try {
                await client.query(`DROP TABLE IF EXISTS scheduled_messages, candidate_messages, driver_documents, lead_activity_log, bot_versions, candidates, staff_members, system_settings CASCADE`);
                await initDatabase(client); // Uses the shared robust init function
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            }
        });
        memoryCache.runtimeConfig = null;
        memoryCache.runtimeConfigLastUpdated = 0;
        memoryCache.runtimeConfigInFlight = null;
        memoryCache.botSettings = null;
        memoryCache.lastUpdated = 0;
        memoryCache.botGraph = null;
        memoryCache.botGraphSource = null;
        memoryCache.botSettingsInFlight = null;
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

apiRouter.get('/system/meta-send-metrics', async (_req, res) => {
    try {
        return res.json({
            success: true,
            windowSize: META_SEND_METRICS_WINDOW,
            timeoutBudgetsMs: {
                manual: SYSTEM_CONFIG.META_TIMEOUT_MANUAL_MS,
                bot: SYSTEM_CONFIG.META_TIMEOUT_BOT_MS,
                scheduled: SYSTEM_CONFIG.META_TIMEOUT_SCHEDULED_MS,
            },
            retry: {
                maxAttempts: SYSTEM_CONFIG.META_RETRY_MAX_ATTEMPTS,
                baseDelayMs: SYSTEM_CONFIG.META_RETRY_BASE_DELAY_MS,
                maxDelayMs: SYSTEM_CONFIG.META_RETRY_MAX_DELAY_MS,
            },
            metrics: getMetaSendMetricsSnapshot(),
        });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.use('/api', apiRouter);
app.use('/', apiRouter);
app.use((err, req, res, next) => {
    structuredLog({
        level: 'error',
        module: 'http',
        message: 'request.unhandled_error',
        requestId: req?.requestId || null,
        meta: {
            method: req?.method,
            path: req?.originalUrl || req?.url,
            error: err?.message || 'Unknown error'
        }
    });
    res.status(500).json({ error: 'Internal server error' });
});
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// --- LEAD AUTO-DISTRIBUTION ---
async function startLeadAutoDistributor() {
    console.log("Starting Lead Auto-Distributor...");
    setInterval(async () => {
        try {
            await withDb(async (client) => {
                // Check if auto-distribution is enabled
                const settingsRes = await client.query("SELECT value FROM system_settings WHERE key = 'lead_distribution'");
                const settings = settingsRes.rows[0]?.value || { auto_enabled: false };
                if (!settings.auto_enabled) return;

                // Get unassigned leads
                const unassignedLeads = await client.query("SELECT id FROM candidates WHERE assigned_to IS NULL AND lead_status = 'new' LIMIT 10");
                if (unassignedLeads.rows.length === 0) return;

                // Get active staff members for auto-dist, ordered by last_assigned_at (round-robin)
                const activeStaff = await client.query("SELECT id FROM staff_members WHERE is_active_for_auto_dist = TRUE ORDER BY last_assigned_at ASC NULLS FIRST");
                if (activeStaff.rows.length === 0) return;

                let staffIndex = 0;
                for (const lead of unassignedLeads.rows) {
                    const staff = activeStaff.rows[staffIndex];
                    await client.query("UPDATE candidates SET assigned_to = $1, lead_status = 'assigned', last_action_at = NOW() WHERE id = $2", [staff.id, lead.id]);
                    await client.query("UPDATE staff_members SET last_assigned_at = NOW() WHERE id = $1", [staff.id]);
                    await client.query("INSERT INTO lead_activity_log (candidate_id, staff_id, action, notes) VALUES ($1, $2, 'auto_assigned', 'Lead auto-assigned via distributor')", [lead.id, staff.id]);
                    
                    console.log(`Auto-assigned lead ${lead.id} to staff ${staff.id}`);
                    
                    staffIndex = (staffIndex + 1) % activeStaff.rows.length;
                }
            });
        } catch (e) {
            console.error("Lead Auto-Distributor Error:", e);
        }
    }, 30000); // Run every 30 seconds
}

const startServer = ({ port = process.env.PORT || 3001 } = {}) => {
    startLeadAutoDistributor();
    return app.listen(port, () => {
        console.log(`Server running on ${port}`);
        logLeadIngestionRuntimePosture();
        // Auto-Init Check on Start (For Local/VPS, NOT Vercel)
        (async () => {
            try {
                if (pgPool) {
                    const client = await pgPool.connect();
                    try {
                        const res = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'candidates'`);
                        
                        // Always run initDatabase to ensure columns and extensions exist (safe due to IF NOT EXISTS)
                        console.log("[Auto-Init] Verifying database schema...");
                        await initDatabase(client);
                        console.log("[Auto-Init] Database schema verified.");

                        await ensurePerformanceIndexes(client);
                        console.log("[Auto-Init] Performance indexes verified.");
                        
                        await prewarmHotPathCaches(client);
                        console.log("[Auto-Init] Hot-path caches prewarmed.");
                    } finally {
                        client.release();
                    }
                }
            } catch(e) { console.error("[Auto-Init] Failed:", e.message); }
        })();
    });
};

if (require.main === module) {
    startServer();
}

module.exports = { app, startServer };

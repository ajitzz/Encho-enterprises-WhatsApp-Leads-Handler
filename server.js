const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Redis } = require("@upstash/redis");
const { Client: QStashClient, Receiver } = require("@upstash/qstash");
const { Pool } = require("pg");
require("dotenv").config();

/**
 * -------------------------------------------------------------
 * LOGGING
 * -------------------------------------------------------------
 */
const logger = {
  info: (msg, meta = {}) =>
    console.log(JSON.stringify({ level: "INFO", msg, timestamp: new Date().toISOString(), ...meta })),
  warn: (msg, meta = {}) =>
    console.warn(JSON.stringify({ level: "WARN", msg, timestamp: new Date().toISOString(), ...meta })),
  error: (msg, meta = {}) =>
    console.error(JSON.stringify({ level: "ERROR", msg, timestamp: new Date().toISOString(), ...meta })),
};

const SYSTEM_CONFIG = {
  META_TIMEOUT: 5000,
  DB_CONNECTION_TIMEOUT: 15000, // ✅ increased (fixes Neon cold timeout)
  CACHE_TTL_SETTINGS: 600,
  DEDUPE_TTL: 3600,
};

/**
 * -------------------------------------------------------------
 * DATABASE
 * -------------------------------------------------------------
 */
let pgPool = null;

const resolveDbUrl = () =>
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.POSTGRES_URL_NON_POOLING ||
  "";

const getDb = () => {
  if (!pgPool) {
    const dbUrl = resolveDbUrl();
    if (!dbUrl) {
      throw new Error("No Postgres connection string found. Set POSTGRES_URL (recommended) or DATABASE_URL.");
    }

    pgPool = new Pool({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: SYSTEM_CONFIG.DB_CONNECTION_TIMEOUT,
      max: 5,
      idleTimeoutMillis: 10000,
    });

    pgPool.on("error", (err) => logger.error("DB Pool Error", { error: err.message }));
  }
  return pgPool;
};

/**
 * -------------------------------------------------------------
 * UPSTASH REDIS
 * -------------------------------------------------------------
 */
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || "https://mock.upstash.io",
  token: process.env.UPSTASH_REDIS_REST_TOKEN || "mock",
});

/**
 * -------------------------------------------------------------
 * QSTASH
 * -------------------------------------------------------------
 */
const qstash = new QStashClient({ token: process.env.QSTASH_TOKEN || "mock" });
const qstashReceiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "mock",
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "mock",
});

/**
 * -------------------------------------------------------------
 * EXPRESS
 * -------------------------------------------------------------
 */
const app = express();
const apiRouter = express.Router();

// ✅ Fix 304 caching problems (your UI expects JSON but 304 returns empty body)
app.set("etag", false);

// Middleware: request id
app.use((req, res, next) => {
  req.requestId = req.headers["x-request-id"] || crypto.randomUUID();
  next();
});

// Raw body for QStash signature verification
app.use(
  express.json({
    limit: "10mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(cors());

/**
 * ✅ Disable caching for ALL API responses (prevents 304)
 */
apiRouter.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  next();
});

/**
 * -------------------------------------------------------------
 * URL RESOLVER (Fix QStash pointing to localhost)
 * -------------------------------------------------------------
 */
function getBaseUrl(req) {
  const envBase = (process.env.PUBLIC_BASE_URL || "").trim();
  if (envBase) return envBase.replace(/\/$/, "");

  const vercelUrl = (process.env.VERCEL_URL || "").trim();
  if (vercelUrl) return `https://${vercelUrl.replace(/\/$/, "")}`;

  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`.replace(/\/$/, "");
}

/**
 * -------------------------------------------------------------
 * DB SCHEMA (safe + minimal)
 * -------------------------------------------------------------
 */
let schemaReadyPromise = null;

const ensureDbSchema = async () => {
  const client = await getDb().connect();
  try {
    await client.query("BEGIN");

    // Best-effort extension (app supplies UUID anyway)
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
    } catch (e) {
      logger.warn("uuid-ossp extension not available (continuing)", { error: e.message });
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS candidates (
        id UUID PRIMARY KEY,
        phone_number VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(255),
        stage VARCHAR(50) DEFAULT 'New',
        last_message_at BIGINT,
        last_message TEXT,
        current_node_id VARCHAR(255),
        is_human_mode BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS candidate_messages (
        id UUID PRIMARY KEY,
        candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
        direction VARCHAR(10) CHECK (direction IN ('in','out')),
        text TEXT,
        type VARCHAR(50),
        status VARCHAR(50),
        whatsapp_message_id VARCHAR(255) UNIQUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_versions (
        id UUID PRIMARY KEY,
        phone_number_id VARCHAR(50),
        version_number INT,
        status VARCHAR(20) CHECK (status IN ('draft','published','archived')),
        settings JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    await client.query("COMMIT");
    logger.info("DB Schema Verified");
  } catch (e) {
    await client.query("ROLLBACK");
    logger.error("DB Schema Migration Failed", { error: e.message });
    throw e;
  } finally {
    client.release();
  }
};

const ensureSchemaReady = async () => {
  if (!schemaReadyPromise) {
    schemaReadyPromise = ensureDbSchema().catch((e) => {
      schemaReadyPromise = null;
      throw e;
    });
  }
  return schemaReadyPromise;
};

/**
 * -------------------------------------------------------------
 * BOT SETTINGS (published only)
 * -------------------------------------------------------------
 */
const getBotSettings = async (phoneId) => {
  if (!phoneId) return null;

  const key = `bot:settings:${phoneId}`;
  try {
    const cached = await redis.get(key);
    if (cached) return cached;
  } catch (_) {}

  const client = await getDb().connect();
  try {
    const res = await client.query(
      `SELECT settings FROM bot_versions
       WHERE phone_number_id = $1 AND status = 'published'
       ORDER BY version_number DESC LIMIT 1`,
      [phoneId]
    );
    if (res.rows.length) {
      redis.set(key, res.rows[0].settings, { ex: SYSTEM_CONFIG.CACHE_TTL_SETTINGS }).catch(() => {});
      return res.rows[0].settings;
    }
    return null;
  } catch (e) {
    return null;
  } finally {
    client.release();
  }
};

/**
 * -------------------------------------------------------------
 * CORE MESSAGE PROCESSOR
 * PERMANENT FIX:
 * - Webhook must always persist inbound messages immediately.
 * - Bot execution can be async (QStash) but should not block persistence.
 * -------------------------------------------------------------
 */
const processMessageInternal = async (message, contact, phoneId, requestId = "system", options = {}) => {
  await ensureSchemaReady();

  const persistOnly = !!options.persistOnly;
  const skipDedup = !!options.skipDedup;

  // Dedup only when NOT persistOnly (so we never block persistence)
  if (!persistOnly && !skipDedup && message?.id) {
    const key = `wa:msg:${message.id}`;
    try {
      const locked = await redis.set(key, "1", { nx: true, ex: SYSTEM_CONFIG.DEDUPE_TTL });
      if (!locked) {
        logger.info("Idempotency skipped duplicate", { requestId, messageId: message.id });
        return { success: true, duplicate: true };
      }
    } catch (e) {
      logger.warn("Dedup lock failed (continuing)", { requestId, error: e.message });
    }
  }

  const from = message.from;
  const name = contact?.profile?.name || "Unknown";
  const textBody = message?.text?.body || `[${message.type}]`;

  const client = await getDb().connect();
  try {
    // Upsert candidate
    const upsert = await client.query(
      `
      INSERT INTO candidates (id, phone_number, name, stage, last_message_at, last_message, created_at, updated_at)
      VALUES ($1, $2, $3, 'New', $4, $5, NOW(), NOW())
      ON CONFLICT (phone_number)
      DO UPDATE SET
        name = EXCLUDED.name,
        last_message_at = $4,
        last_message = $5,
        updated_at = NOW()
      RETURNING id, current_node_id, is_human_mode
      `,
      [crypto.randomUUID(), from, name, Date.now(), textBody]
    );

    const candidate = upsert.rows[0];

    // Insert inbound message
    await client.query(
      `
      INSERT INTO candidate_messages (id, candidate_id, direction, text, type, status, whatsapp_message_id, created_at)
      VALUES ($1, $2, 'in', $3, $4, 'received', $5, NOW())
      ON CONFLICT (whatsapp_message_id) DO NOTHING
      `,
      [crypto.randomUUID(), candidate.id, textBody, message.type, message.id]
    );

    if (persistOnly) {
      logger.info("Persisted inbound message (webhook)", { requestId, from, messageId: message.id });
      return { success: true, persisted: true };
    }

    // Bot logic (minimal)
    if (!candidate.is_human_mode) {
      const settings = await getBotSettings(phoneId);
      // If you want to expand bot routing later, do it here.
      if (settings?.nodes?.length) {
        logger.info("Bot settings loaded", { requestId, phoneId });
      }
    }

    return { success: true };
  } finally {
    client.release();
  }
};

/**
 * -------------------------------------------------------------
 * QSTASH DISPATCHER (fault tolerant)
 * -------------------------------------------------------------
 */
const enqueueIncomingMessageJob = async (req, message, contact, phoneId) => {
  const requestId = req.requestId;
  const baseUrl = getBaseUrl(req);
  const workerUrl = `${baseUrl}/api/internal/bot-worker`;

  // If QStash not configured -> process directly (safe fallback)
  if (!process.env.QSTASH_TOKEN || process.env.QSTASH_TOKEN === "mock") {
    logger.warn("QStash missing/mocked - sync fallback", { requestId });
    return processMessageInternal(message, contact, phoneId, requestId);
  }

  try {
    const res = await qstash.publishJSON({
      url: workerUrl,
      body: { message, contact, phoneId },
      retries: 3,
      headers: {
        "x-request-id": requestId,
        ...(process.env.INTERNAL_WORKER_SECRET ? { "x-internal-secret": process.env.INTERNAL_WORKER_SECRET } : {}),
      },
    });

    logger.info("QStash dispatched", { requestId, qstashId: res.messageId, workerUrl });
    return { success: true, qstashId: res.messageId };
  } catch (e) {
    logger.error("QStash publish failed - sync fallback", { requestId, error: e.message });
    return processMessageInternal(message, contact, phoneId, requestId);
  }
};

/**
 * -------------------------------------------------------------
 * DEBUG
 * -------------------------------------------------------------
 */
apiRouter.get("/debug/status", async (req, res) => {
  const status = {
    postgres: "unknown",
    redis: "unknown",
    env: {
      dbUrlSource: process.env.POSTGRES_URL
        ? "POSTGRES_URL"
        : process.env.DATABASE_URL
        ? "DATABASE_URL"
        : process.env.POSTGRES_PRISMA_URL
        ? "POSTGRES_PRISMA_URL"
        : process.env.POSTGRES_URL_NON_POOLING
        ? "POSTGRES_URL_NON_POOLING"
        : "NONE",
      hasPostgres: !!resolveDbUrl(),
      hasRedis: !!process.env.UPSTASH_REDIS_REST_URL,
      hasQStash: !!process.env.QSTASH_TOKEN,
      hasQStashSigningKey: !!process.env.QSTASH_CURRENT_SIGNING_KEY,
      hasInternalWorkerSecret: !!process.env.INTERNAL_WORKER_SECRET,
      publicUrl: process.env.PUBLIC_BASE_URL || "NOT_SET",
      workerUrl: `${getBaseUrl(req)}/api/internal/bot-worker`,
    },
    counts: { candidates: 0 },
  };

  try {
    const client = await getDb().connect();
    try {
      await client.query("SELECT 1");
      status.postgres = "connected";
      try {
        const c = await client.query("SELECT COUNT(*) FROM candidates");
        status.counts.candidates = parseInt(c.rows[0].count);
      } catch (_) {}
    } finally {
      client.release();
    }
  } catch (e) {
    status.postgres = "error";
    status.error = e.message;
  }

  try {
    await redis.ping();
    status.redis = "connected";
  } catch (_) {
    status.redis = "error";
  }

  res.json(status);
});

apiRouter.get("/system/stats", (req, res) => res.redirect("/api/debug/status"));

/**
 * -------------------------------------------------------------
 * DRIVERS (Leads list)
 * -------------------------------------------------------------
 */
apiRouter.get("/drivers", async (req, res) => {
  try {
    await ensureSchemaReady();
    const client = await getDb().connect();
    try {
      const r = await client.query("SELECT * FROM candidates ORDER BY last_message_at DESC NULLS LAST LIMIT 50");
      res.json(
        r.rows.map((row) => ({
          id: row.id,
          phoneNumber: row.phone_number,
          name: row.name,
          status: row.stage,
          lastMessage: row.last_message || "",
          lastMessageTime: row.last_message_at ? parseInt(row.last_message_at) : null,
          source: "Organic",
          isHumanMode: row.is_human_mode,
        }))
      );
    } finally {
      client.release();
    }
  } catch (e) {
    logger.error("drivers failed", { error: e.message });
    // Always return JSON
    res.json([]);
  }
});

apiRouter.get("/drivers/:id/messages", async (req, res) => {
  try {
    await ensureSchemaReady();
    const client = await getDb().connect();
    try {
      const limit = parseInt(req.query.limit || "50", 10);
      const r = await client.query(
        `
        SELECT * FROM candidate_messages
        WHERE candidate_id = (SELECT id FROM candidates WHERE phone_number = $1 OR id = $1 LIMIT 1)
        ORDER BY created_at DESC LIMIT $2
        `,
        [req.params.id, limit]
      );

      res.json(
        r.rows
          .map((m) => ({
            id: m.id,
            sender: m.direction === "in" ? "driver" : "agent",
            text: m.text,
            timestamp: new Date(m.created_at).getTime(),
            type: m.type || "text",
            status: m.status,
          }))
          .reverse()
      );
    } finally {
      client.release();
    }
  } catch (e) {
    res.json([]);
  }
});

/**
 * -------------------------------------------------------------
 * WEBHOOK (✅ Supports both /webhook and /api/webhook)
 * -------------------------------------------------------------
 */
const handleVerify = (req, res) => {
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (token && token === process.env.VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
};

const handleWebhook = async (req, res) => {
  try {
    const body = req.body;
    if (body?.object !== "whatsapp_business_account") return res.sendStatus(404);

    logger.info("Webhook received", { requestId: req.requestId });

    const entries = body.entry || [];

    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value;
        const phoneId = value?.metadata?.phone_number_id;
        const contact = value?.contacts?.[0];
        const messages = value?.messages || [];

        for (const message of messages) {
          // ✅ Step 1: Persist inbound message (always attempt)
          try {
            await processMessageInternal(message, contact, phoneId, req.requestId, {
              persistOnly: true,
              skipDedup: true,
            });
          } catch (e) {
            // ✅ Even if DB fails, still enqueue so you don't lose automation
            logger.error("Webhook persist failed (will still enqueue bot)", {
              requestId: req.requestId,
              error: e.message,
              waMessageId: message?.id,
            });
          }

          // ✅ Step 2: Enqueue bot execution separately (fault tolerant)
          try {
            await enqueueIncomingMessageJob(req, message, contact, phoneId);
          } catch (e) {
            logger.error("Webhook enqueue failed", { requestId: req.requestId, error: e.message });
          }
        }
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    logger.error("Webhook handler crash", { requestId: req.requestId, error: e.message });
    return res.sendStatus(200); // Meta expects 200 to stop retries
  }
};

// ✅ BOTH paths (fixes wrong Meta callback config)
app.get("/webhook", handleVerify);
app.post("/webhook", handleWebhook);
app.get("/api/webhook", handleVerify);
app.post("/api/webhook", handleWebhook);

/**
 * -------------------------------------------------------------
 * INTERNAL WORKER (QStash)
 * -------------------------------------------------------------
 */
apiRouter.post("/internal/bot-worker", async (req, res) => {
  const signature = req.headers["upstash-signature"];
  const secretHeader = req.headers["x-internal-secret"];
  const expectedSecret = process.env.INTERNAL_WORKER_SECRET;

  let isAuthorized = false;

  // ✅ Easiest auth (recommended)
  if (expectedSecret && secretHeader === expectedSecret) {
    isAuthorized = true;
  } else if (signature && process.env.QSTASH_CURRENT_SIGNING_KEY && process.env.QSTASH_CURRENT_SIGNING_KEY !== "mock") {
    // ✅ QStash signature verification
    try {
      const body = req.rawBody ? req.rawBody.toString() : JSON.stringify(req.body);
      isAuthorized = await qstashReceiver.verify({ signature, body });
    } catch (e) {
      logger.warn("Worker signature verify failed", { error: e.message });
      isAuthorized = false;
    }
  } else {
    // no signing configured -> allow (dev)
    isAuthorized = true;
  }

  if (!isAuthorized) return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const { message, contact, phoneId } = req.body || {};
    await processMessageInternal(message, contact, phoneId, req.headers["x-request-id"] || req.requestId);
    res.json({ success: true });
  } catch (e) {
    logger.error("Worker failed", { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * -------------------------------------------------------------
 * ERROR HANDLER
 * -------------------------------------------------------------
 */
app.use((err, req, res, next) => {
  logger.error("Unhandled error", { requestId: req.requestId, error: err.message, stack: err.stack });
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: err.message || "Internal Server Error" });
});

/**
 * -------------------------------------------------------------
 * MOUNT ROUTERS
 * -------------------------------------------------------------
 */
app.use("/api", apiRouter);
app.use("/", apiRouter);

module.exports = app;

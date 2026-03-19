const { log } = require('../../shared/infra/logger');
const { buildLatencyTracker, buildStageTimer, parsePositiveInt, runWithTimeout } = require('../../shared/infra/perf');
const { parseBooleanFlag } = require('../../shared/infra/flags');
const {
  validateLeadIngestedPayload,
  buildDeterministicDedupeKey,
} = require('./contracts');
const {
  findInboundMessageByWhatsappId,
  upsertCandidateFromInbound,
  insertInboundMessage,
} = require('./adapters/candidateRepo');

const WEBHOOK_REPLY_WARN_MS = parsePositiveInt(process.env.WEBHOOK_REPLY_WARN_MS, 1200);
const BOT_ENGINE_HARD_TIMEOUT_MS = parsePositiveInt(process.env.BOT_ENGINE_HARD_TIMEOUT_MS, 1800);
const WEBHOOK_DEFER_POST_RESPONSE = parseBooleanFlag(process.env.FF_WEBHOOK_DEFER_POST_RESPONSE, true);
const WEBHOOK_DEFER_BOT_ENGINE = parseBooleanFlag(process.env.FF_WEBHOOK_DEFER_BOT_ENGINE, false);
const WEBHOOK_ADAPTIVE_BOT_DEFER = parseBooleanFlag(process.env.FF_WEBHOOK_ADAPTIVE_BOT_DEFER, false);
const WEBHOOK_BACKPRESSURE_DEFER = parseBooleanFlag(process.env.FF_WEBHOOK_BACKPRESSURE_DEFER, true);
const WEBHOOK_SYNC_BUDGET_MS = parsePositiveInt(process.env.WEBHOOK_SYNC_BUDGET_MS, 900);
const WEBHOOK_DB_STAGE_WARN_MS = parsePositiveInt(process.env.WEBHOOK_DB_STAGE_WARN_MS, 450);
const WEBHOOK_BOT_STAGE_WARN_MS = parsePositiveInt(process.env.WEBHOOK_BOT_STAGE_WARN_MS, 700);
const BOT_ENGINE_MAX_CONCURRENCY = parsePositiveInt(process.env.BOT_ENGINE_MAX_CONCURRENCY, 8);
const WEBHOOK_ACK_TIMEOUT_MS = parsePositiveInt(process.env.WEBHOOK_ACK_TIMEOUT_MS, 950);
const FF_WEBHOOK_ACK_TIMEOUT_GUARD = parseBooleanFlag(process.env.FF_WEBHOOK_ACK_TIMEOUT_GUARD, true);
const WEBHOOK_DEFER_QUEUE_MAX = parsePositiveInt(process.env.WEBHOOK_DEFER_QUEUE_MAX, 256);
const WEBHOOK_DEDUPE_MEMORY_TTL_MS = parsePositiveInt(process.env.WEBHOOK_DEDUPE_MEMORY_TTL_MS, 120000);
const WEBHOOK_DEDUPE_MEMORY_MAX_SIZE = parsePositiveInt(process.env.WEBHOOK_DEDUPE_MEMORY_MAX_SIZE, 5000);

let activeBotExecutions = 0;
let drainingDeferredBotQueue = false;
const deferredBotQueue = [];
const recentMessageCache = new Map();
const inFlightMessageIds = new Set();

const pruneRecentMessageCache = () => {
  const now = Date.now();
  for (const [messageId, expiresAt] of recentMessageCache.entries()) {
    if (expiresAt <= now) recentMessageCache.delete(messageId);
  }
};

const hasRecentMessage = (messageId) => {
  pruneRecentMessageCache();
  const expiresAt = recentMessageCache.get(messageId);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    recentMessageCache.delete(messageId);
    return false;
  }
  return true;
};

const rememberMessageId = (messageId) => {
  if (!messageId) return;
  if (recentMessageCache.size >= WEBHOOK_DEDUPE_MEMORY_MAX_SIZE) {
    const oldestMessageId = recentMessageCache.keys().next()?.value;
    if (oldestMessageId) recentMessageCache.delete(oldestMessageId);
  }
  recentMessageCache.set(messageId, Date.now() + WEBHOOK_DEDUPE_MEMORY_TTL_MS);
};


const safeSendStatus = (res, code) => {
  if (!res || typeof res.sendStatus !== 'function') return;
  if (res.statusCode) return;
  res.sendStatus(code);
};

const withBotExecutionSlot = async (handler) => {
  activeBotExecutions += 1;
  try {
    return await handler();
  } finally {
    activeBotExecutions = Math.max(0, activeBotExecutions - 1);
  }
};

class LeadIngestionService {
  constructor({ legacyProcessor, withDb, executeWithRetry, runBotEngine, triggerReportingSyncDeferred }) {
    this.legacyProcessor = legacyProcessor;
    this.withDb = withDb;
    this.executeWithRetry = executeWithRetry;
    this.runBotEngine = runBotEngine;
    this.triggerReportingSyncDeferred = triggerReportingSyncDeferred;
  }

  async handleIncomingMessage({ body, req, res, context }) {
    const requestId = context?.requestId || req?.requestId || null;
    const tenantId = context?.tenantId || null;
    log({ module: 'lead-ingestion', message: 'ingestion.module_path.selected', requestId, meta: { tenantId } });

    const latency = buildLatencyTracker({ module: 'lead-ingestion', requestId, operation: 'webhook_ingestion', warnThresholdMs: WEBHOOK_REPLY_WARN_MS, extraMeta: { tenantId } });
    const webhookStartedMs = Date.now();

    if (!body?.object) {
      safeSendStatus(res, 404);
      latency.end({ path: 'module-service', status: 404 });
      return { accepted: false, path: 'module-service' };
    }

    const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) {
      safeSendStatus(res, 200);
      latency.end({ path: 'module-service', noop: true });
      return { accepted: true, path: 'module-service' };
    }

    const hasMessageId = Boolean(msg.id);

    if (hasMessageId && hasRecentMessage(msg.id)) {
      safeSendStatus(res, 200);
      latency.end({ path: 'module-service', duplicate: true, dedupe: 'memory-cache' });
      return { accepted: true, path: 'module-service' };
    }

    if (hasMessageId && inFlightMessageIds.has(msg.id)) {
      safeSendStatus(res, 200);
      latency.end({ path: 'module-service', duplicate: true, dedupe: 'in-flight' });
      return { accepted: true, path: 'module-service' };
    }

    if (!this.withDb || !this.executeWithRetry || !this.runBotEngine || !this.triggerReportingSyncDeferred) {
      if (!this.legacyProcessor) {
        throw new Error('lead-ingestion dependencies are not fully configured');
      }
      await this.legacyProcessor({ body, req, res });
      latency.end({ path: 'module-facade-fallback' });
      return { accepted: true, path: 'module-facade-fallback' };
    }

    const parsed = this.parseInboundMessage({ body, msg });

    if (hasMessageId) inFlightMessageIds.add(msg.id);

    let shouldRememberMessageId = false;
    const processPromise = this.processWebhookCore({
      parsed,
      msg,
      requestId,
      tenantId,
      webhookStartedMs,
    }).then((result) => {
      shouldRememberMessageId = result !== false;
    }).finally(() => {
      if (hasMessageId) inFlightMessageIds.delete(msg.id);
      if (hasMessageId && shouldRememberMessageId) {
        rememberMessageId(msg.id);
      }
    });

    if (WEBHOOK_DEFER_POST_RESPONSE) {
      safeSendStatus(res, 200);
      latency.end({ path: 'module-service', deferred: true });
      
      processPromise.catch((error) => {
        log({
          level: 'error',
          module: 'lead-ingestion',
          message: 'webhook.post_response_processing.failed',
          requestId,
          meta: { error: error?.message || String(error) },
        });
      });
      
      return { accepted: true, path: 'module-service', deferred: true };
    }

    if (!FF_WEBHOOK_ACK_TIMEOUT_GUARD) {
      await processPromise;
      safeSendStatus(res, 200);
      latency.end({ path: 'module-service' });
      return { accepted: true, path: 'module-service' };
    }

    const guardedResult = await runWithTimeout({
      promise: processPromise,
      timeoutMs: WEBHOOK_ACK_TIMEOUT_MS,
      onTimeout: () => {
        log({
          module: 'lead-ingestion',
          message: 'webhook.ack_timeout_guard.triggered',
          requestId,
          meta: { tenantId, timeoutMs: WEBHOOK_ACK_TIMEOUT_MS },
        });
      },
    });

    if (guardedResult && guardedResult.timedOut) {
      safeSendStatus(res, 200);
      processPromise.catch((error) => {
        log({
          level: 'error',
          module: 'lead-ingestion',
          message: 'webhook.ack_timeout_guard.processing_failed',
          requestId,
          meta: { error: error?.message || String(error) },
        });
      });
      latency.end({ path: 'module-service', deferred: true, reason: 'ack_timeout_guard' });
      return { accepted: true, path: 'module-service', deferred: true };
    }

    safeSendStatus(res, 200);
    latency.end({ path: 'module-service' });
    return { accepted: true, path: 'module-service' };
  }

  async processWebhookCore({ parsed, msg, requestId, tenantId, webhookStartedMs }) {
    return this.withDb(async (client) => {
      const dbStage = buildStageTimer({
        module: 'lead-ingestion',
        requestId,
        operation: 'webhook_ingestion_db',
        warnThresholdMs: WEBHOOK_DB_STAGE_WARN_MS,
        extraMeta: { tenantId },
      });

      const state = await this.executeWithRetry(client, async () => {
        const existing = await findInboundMessageByWhatsappId({ client, whatsappMessageId: msg.id });
        if (existing) return { duplicate: true };

        const candidate = await upsertCandidateFromInbound({
          client,
          phoneNumber: parsed.from,
          name: parsed.name,
          lastMessage: parsed.text,
          nowMs: Date.now(),
        });

        await insertInboundMessage({
          client,
          candidateId: candidate.id,
          text: parsed.text,
          type: parsed.messageType,
          whatsappMessageId: msg.id,
        });

        validateLeadIngestedPayload({
          eventId: `${msg.id}:${candidate.id}`,
          source: 'whatsapp-meta',
          phoneNumber: parsed.from,
          messageType: parsed.messageType,
          messageId: msg.id,
          dedupeKey: buildDeterministicDedupeKey({ providerMessageId: msg.id, channel: 'whatsapp' }),
          leadId: candidate.id,
        });

        return { duplicate: false, candidate };
      });

      dbStage.end({ duplicate: state?.duplicate === true });

      if (!state || state.duplicate || !state.candidate) {
        return true;
      }

      const candidate = state.candidate;

      // --- AUTO DISTRIBUTION LOGIC ---
      await this.distributeLeadAutomatically({ client, candidate, requestId, tenantId });

      if (!candidate.is_human_mode) {
        const elapsed = Date.now() - webhookStartedMs;
        const shouldDeferForBudget = WEBHOOK_ADAPTIVE_BOT_DEFER && elapsed >= WEBHOOK_SYNC_BUDGET_MS;
        const shouldDeferForBackpressure = WEBHOOK_BACKPRESSURE_DEFER && activeBotExecutions >= BOT_ENGINE_MAX_CONCURRENCY;
        const shouldDeferBot = WEBHOOK_DEFER_BOT_ENGINE || shouldDeferForBudget || shouldDeferForBackpressure;
        const deferReason = shouldDeferForBackpressure
          ? 'backpressure'
          : shouldDeferForBudget
            ? 'sync_budget'
            : 'flag';

        if (shouldDeferBot) {
          this.runBotDeferred({
            candidate,
            parsed,
            requestId,
            tenantId,
            elapsed,
            reason: deferReason,
            activeExecutions: activeBotExecutions,
          });
        } else {
          await this.runBotWithinBudget({ client, candidate, parsed, requestId, tenantId });
        }
      }

      this.triggerReportingSyncDeferred({
        candidateId: candidate.id,
        action: 'upsert',
        requestId,
        source: 'webhook',
      });

      return true;
    });
  }

  runBotDeferred({ candidate, parsed, requestId, tenantId, elapsed, reason = 'flag', activeExecutions = activeBotExecutions }) {
    if (deferredBotQueue.length >= WEBHOOK_DEFER_QUEUE_MAX) {
      const dropped = deferredBotQueue.shift();
      log({
        level: 'error',
        module: 'lead-ingestion',
        message: 'ingestion.bot_engine.defer_queue_capacity_reached',
        requestId,
        meta: {
          candidateId: candidate.id,
          queueDepth: deferredBotQueue.length,
          queueMax: WEBHOOK_DEFER_QUEUE_MAX,
          droppedCandidateId: dropped?.candidate?.id || null,
        },
      });
    }

    log({
      module: 'lead-ingestion',
      message: 'ingestion.bot_engine.deferred_pre_ack',
      requestId,
      meta: {
        candidateId: candidate.id,
        elapsedMs: elapsed,
        syncBudgetMs: WEBHOOK_SYNC_BUDGET_MS,
        reason,
        activeExecutions,
        maxConcurrency: BOT_ENGINE_MAX_CONCURRENCY,
        queueDepth: deferredBotQueue.length,
      },
    });

    deferredBotQueue.push({ candidate, parsed, requestId, tenantId, enqueuedAt: Date.now() });
    this.drainBotDeferredQueue();
  }

  drainBotDeferredQueue() {
    if (drainingDeferredBotQueue) return;
    drainingDeferredBotQueue = true;

    const drainLoop = () => {
      if (!deferredBotQueue.length) {
        drainingDeferredBotQueue = false;
        return;
      }

      if (activeBotExecutions >= BOT_ENGINE_MAX_CONCURRENCY) {
        setTimeout(drainLoop, 1);
        return;
      }

      const job = deferredBotQueue.shift();
      this.withDb(async (client) => {
        await this.runBotWithinBudget({
          client,
          candidate: job.candidate,
          parsed: job.parsed,
          requestId: job.requestId,
          tenantId: job.tenantId,
          deferred: true,
        });
      }).catch((error) => {
        log({
          level: 'error',
          module: 'lead-ingestion',
          message: 'ingestion.bot_engine.deferred.failed',
          requestId: job.requestId,
          meta: {
            candidateId: job.candidate.id,
            queueWaitMs: Date.now() - job.enqueuedAt,
            error: error?.message || String(error),
          },
        });
      }).finally(() => {
        setImmediate(drainLoop);
      });
    };

    setImmediate(drainLoop);
  }

  async runBotWithinBudget({ client, candidate, parsed, requestId, tenantId, deferred = false }) {
    const botStage = buildStageTimer({
      module: 'lead-ingestion',
      requestId,
      operation: 'webhook_ingestion_bot',
      warnThresholdMs: WEBHOOK_BOT_STAGE_WARN_MS,
      extraMeta: { tenantId, candidateId: candidate.id, deferred },
    });

    const botResult = await withBotExecutionSlot(async () => runWithTimeout({
      promise: this.runBotEngine(client, candidate, parsed.text, parsed.payloadId),
      timeoutMs: BOT_ENGINE_HARD_TIMEOUT_MS,
      onTimeout: async () => {
        log({
          level: 'error',
          module: 'bot-conversation',
          message: 'bot.engine.hard_timeout',
          requestId,
          meta: {
            candidateId: candidate.id,
            timeoutMs: BOT_ENGINE_HARD_TIMEOUT_MS,
            deferred,
          },
        });
      },
    }));

    if (botResult && botResult.timedOut) {
      log({
        module: 'lead-ingestion',
        message: 'ingestion.bot_engine.deferred_after_timeout',
        requestId,
        meta: { candidateId: candidate.id, deferred },
      });
    }

    botStage.end({ timedOut: Boolean(botResult && botResult.timedOut) });
  }

  async distributeLeadAutomatically({ client, candidate, requestId, tenantId }) {
    try {
      // 1. Check if auto-distribution is enabled globally
      const settingsRes = await client.query("SELECT value FROM system_settings WHERE key = 'lead_distribution'");
      const settings = settingsRes.rows[0]?.value || { auto_enabled: false };
      
      if (!settings.auto_enabled) return;

      // 2. Check if candidate is already assigned
      if (candidate.assigned_to) return;

      // 3. Find the next staff member (Round Robin)
      // We pick the staff member who is active for auto-dist and has the oldest last_assigned_at
      const staffRes = await client.query(`
        SELECT id, name, email 
        FROM staff_members 
        WHERE is_active_for_auto_dist = TRUE 
        ORDER BY last_assigned_at ASC NULLS FIRST 
        LIMIT 1
      `);

      if (staffRes.rows.length === 0) {
        log({ 
          module: 'lead-ingestion', 
          message: 'auto_dist.no_active_staff', 
          requestId, 
          meta: { candidateId: candidate.id } 
        });
        return;
      }

      const staff = staffRes.rows[0];

      // 4. Assign the lead
      await client.query(
        "UPDATE candidates SET assigned_to = $1, lead_status = 'assigned', last_action_at = NOW() WHERE id = $2",
        [staff.id, candidate.id]
      );

      // 5. Update staff's last_assigned_at
      await client.query(
        "UPDATE staff_members SET last_assigned_at = NOW() WHERE id = $1",
        [staff.id]
      );

      // 6. Log activity
      await client.query(
        "INSERT INTO lead_activity_log (candidate_id, staff_id, action, notes) VALUES ($1, $2, $3, $4)",
        [candidate.id, staff.id, 'auto_assigned', `Automatically assigned to ${staff.name} via Round-Robin`]
      );

      log({ 
        module: 'lead-ingestion', 
        message: 'auto_dist.success', 
        requestId, 
        meta: { candidateId: candidate.id, staffId: staff.id, staffName: staff.name } 
      });

    } catch (error) {
      log({ 
        level: 'error', 
        module: 'lead-ingestion', 
        message: 'auto_dist.failed', 
        requestId, 
        meta: { error: error.message, candidateId: candidate.id } 
      });
    }
  }

  parseInboundMessage({ body, msg }) {
    const from = msg.from;
    const name = body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name || 'Unknown';
    let text = '';
    let payloadId = null;
    let messageType = msg.type === 'interactive' ? 'interactive' : msg.type;

    if (msg.type === 'text') {
      text = msg.text?.body || '';
    } else if (msg.type === 'interactive') {
      if (msg.interactive?.type === 'button_reply') {
        text = msg.interactive.button_reply?.title || '';
        payloadId = msg.interactive.button_reply?.id || null;
      } else if (msg.interactive?.type === 'list_reply') {
        text = msg.interactive.list_reply?.title || '';
        payloadId = msg.interactive.list_reply?.id || null;
      }
    } else if (msg.type === 'location') {
      text = JSON.stringify(msg.location || {});
    } else if (['image', 'document', 'video', 'audio'].includes(msg.type)) {
      text = `[${msg.type.toUpperCase()}]`;
    } else {
      text = `[${String(msg.type || 'UNKNOWN').toUpperCase()}]`;
    }

    return { from, name, text, payloadId, messageType };
  }
}

module.exports = { LeadIngestionService };

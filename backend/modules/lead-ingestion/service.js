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

const safeSendStatus = (res, code) => {
  if (!res || typeof res.sendStatus !== 'function') return;
  if (res.statusCode) return;
  res.sendStatus(code);
};

class LeadIngestionService {
  constructor({ legacyProcessor, withDb, executeWithRetry, runBotEngine, triggerReportingSyncDeferred, assignmentService, fetchAndStoreIncomingMedia, redis }) {
    this.legacyProcessor = legacyProcessor;
    this.withDb = withDb;
    this.executeWithRetry = executeWithRetry;
    this.runBotEngine = runBotEngine;
    this.triggerReportingSyncDeferred = triggerReportingSyncDeferred;
    this.assignmentService = assignmentService;
    this.fetchAndStoreIncomingMedia = fetchAndStoreIncomingMedia;
    this.redis = redis;
  }

  async hasRecentMessage(messageId) {
    if (!this.redis || !messageId) return false;
    const key = `webhook_dedupe:${messageId}`;
    const exists = await this.redis.get(key);
    return !!exists;
  }

  async rememberMessageId(messageId) {
    if (!this.redis || !messageId) return;
    const key = `webhook_dedupe:${messageId}`;
    await this.redis.set(key, '1', { px: WEBHOOK_DEDUPE_MEMORY_TTL_MS });
  }

  async getActiveBotExecutions() {
    if (!this.redis) return 0;
    const count = await this.redis.get('active_bot_executions');
    return parseInt(count || '0', 10);
  }

  async withBotExecutionSlot(handler) {
    if (!this.redis) return await handler();
    
    await this.redis.incr('active_bot_executions');
    try {
      return await handler();
    } finally {
      await this.redis.decr('active_bot_executions');
    }
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

    if (hasMessageId && await this.hasRecentMessage(msg.id)) {
      safeSendStatus(res, 200);
      latency.end({ path: 'module-service', duplicate: true, dedupe: 'redis' });
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

    let shouldRememberMessageId = false;
    const processPromise = this.processWebhookCore({
      parsed,
      msg,
      requestId,
      tenantId,
      webhookStartedMs,
    }).then((result) => {
      shouldRememberMessageId = result !== false;
    }).finally(async () => {
      if (hasMessageId && shouldRememberMessageId) {
        await this.rememberMessageId(msg.id);
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

        let finalMessageText = parsed.text;
        const candidate = await upsertCandidateFromInbound({
          client,
          phoneNumber: parsed.from,
          name: parsed.name,
          lastMessage: finalMessageText,
          nowMs: Date.now(),
        });

        // Handle Media Storage if applicable
        if (this.fetchAndStoreIncomingMedia && ['image', 'document', 'video', 'audio', 'voice', 'sticker'].includes(msg.type)) {
          try {
            const mediaRes = await this.fetchAndStoreIncomingMedia({ msg, phoneNumber: parsed.from, candidateId: candidate.id, client });
            if (mediaRes?.key) {
              const caption = msg[msg.type]?.caption || '';
              finalMessageText = JSON.stringify({ url: mediaRes.url || mediaRes.key, caption: caption });
              
              // Update candidate last_message with the JSON string
              await client.query('UPDATE candidates SET last_message = $1 WHERE id = $2', [finalMessageText, candidate.id]);
            }
          } catch (mediaErr) {
            log({ level: 'error', module: 'lead-ingestion', message: 'media_storage.failed', requestId, meta: { error: mediaErr.message, candidateId: candidate.id } });
          }
        }

        await insertInboundMessage({
          client,
          candidateId: candidate.id,
          text: finalMessageText,
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
        const activeBotExecutions = await this.getActiveBotExecutions();
        const shouldDeferForBudget = WEBHOOK_ADAPTIVE_BOT_DEFER && elapsed >= WEBHOOK_SYNC_BUDGET_MS;
        const shouldDeferForBackpressure = WEBHOOK_BACKPRESSURE_DEFER && activeBotExecutions >= BOT_ENGINE_MAX_CONCURRENCY;
        const shouldDeferBot = WEBHOOK_DEFER_BOT_ENGINE || shouldDeferForBudget || shouldDeferForBackpressure;
        const deferReason = shouldDeferForBackpressure
          ? 'backpressure'
          : shouldDeferForBudget
            ? 'sync_budget'
            : 'flag';

        if (shouldDeferBot) {
          await this.runBotDeferred({
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

  async runBotDeferred({ candidate, parsed, requestId, tenantId, elapsed, reason = 'flag', activeExecutions }) {
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
      },
    });

    // In Vercel, we use QStash for deferred processing
    if (process.env.QSTASH_TOKEN) {
      try {
        const { Client } = require('@upstash/qstash');
        const qstash = new Client({ token: process.env.QSTASH_TOKEN });
        
        await qstash.publishJSON({
          url: `${process.env.PUBLIC_BASE_URL}/api/webhooks/deferred-bot`,
          body: { candidateId: candidate.id, parsed, requestId, tenantId },
          delay: 0,
        });
        
        log({ module: 'lead-ingestion', message: 'ingestion.bot_engine.qstash_enqueued', requestId, meta: { candidateId: candidate.id } });
      } catch (error) {
        log({ level: 'error', module: 'lead-ingestion', message: 'ingestion.bot_engine.qstash_failed', requestId, meta: { candidateId: candidate.id, error: error.message } });
      }
    } else {
      log({ level: 'warn', module: 'lead-ingestion', message: 'ingestion.bot_engine.defer_skipped_no_qstash', requestId, meta: { candidateId: candidate.id } });
    }
  }

  async runBotWithinBudget({ client, candidate, parsed, requestId, tenantId, deferred = false }) {
    const botStage = buildStageTimer({
      module: 'lead-ingestion',
      requestId,
      operation: 'webhook_ingestion_bot',
      warnThresholdMs: WEBHOOK_BOT_STAGE_WARN_MS,
      extraMeta: { tenantId, candidateId: candidate.id, deferred },
    });

    const botResult = await this.withBotExecutionSlot(async () => runWithTimeout({
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

  async handleDeferredBot({ body, requestId, tenantId }) {
    const { candidateId, parsed } = body;
    if (!candidateId || !parsed) {
      log({ level: 'error', module: 'lead-ingestion', message: 'deferred_bot.invalid_payload', requestId });
      return;
    }

    await this.withDb(async (client) => {
      const candidateRes = await client.query('SELECT * FROM candidates WHERE id = $1', [candidateId]);
      if (candidateRes.rows.length === 0) {
        log({ level: 'error', module: 'lead-ingestion', message: 'deferred_bot.candidate_not_found', requestId, meta: { candidateId } });
        return;
      }
      const candidate = candidateRes.rows[0];
      await this.runBotWithinBudget({ client, candidate, parsed, requestId, tenantId, deferred: true });
    });
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
    } else if (msg.type === 'sticker') {
      text = '[STICKER]';
    } else if (msg.type === 'audio' || msg.type === 'voice') {
      const caption = msg[msg.type]?.caption || '';
      text = msg.voice ? `[VOICE NOTE]${caption ? ': ' + caption : ''}` : `[AUDIO]${caption ? ': ' + caption : ''}`;
    } else if (['image', 'document', 'video'].includes(msg.type)) {
      const caption = msg[msg.type]?.caption || '';
      text = `[${msg.type.toUpperCase()}]${caption ? ': ' + caption : ''}`;
    } else {
      text = `[${String(msg.type || 'UNKNOWN').toUpperCase()}]`;
    }

    return { from, name, text, payloadId, messageType };
  }
}

module.exports = { LeadIngestionService };

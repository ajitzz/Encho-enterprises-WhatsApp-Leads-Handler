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
const WEBHOOK_DEFER_POST_RESPONSE = parseBooleanFlag(process.env.FF_WEBHOOK_DEFER_POST_RESPONSE, false);
const WEBHOOK_DEFER_BOT_ENGINE = parseBooleanFlag(process.env.FF_WEBHOOK_DEFER_BOT_ENGINE, false);
const WEBHOOK_ADAPTIVE_BOT_DEFER = parseBooleanFlag(process.env.FF_WEBHOOK_ADAPTIVE_BOT_DEFER, false);
const WEBHOOK_BACKPRESSURE_DEFER = parseBooleanFlag(process.env.FF_WEBHOOK_BACKPRESSURE_DEFER, true);
const WEBHOOK_SYNC_BUDGET_MS = parsePositiveInt(process.env.WEBHOOK_SYNC_BUDGET_MS, 900);
const WEBHOOK_DB_STAGE_WARN_MS = parsePositiveInt(process.env.WEBHOOK_DB_STAGE_WARN_MS, 450);
const WEBHOOK_BOT_STAGE_WARN_MS = parsePositiveInt(process.env.WEBHOOK_BOT_STAGE_WARN_MS, 700);
const BOT_ENGINE_MAX_CONCURRENCY = parsePositiveInt(process.env.BOT_ENGINE_MAX_CONCURRENCY, 8);

let activeBotExecutions = 0;

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
      res.sendStatus(404);
      latency.end({ path: 'module-service', status: 404 });
      return { accepted: false, path: 'module-service' };
    }

    const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) {
      res.sendStatus(200);
      latency.end({ path: 'module-service', noop: true });
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

    const processPromise = this.processWebhookCore({
      parsed,
      msg,
      requestId,
      tenantId,
      webhookStartedMs,
    });

    if (WEBHOOK_DEFER_POST_RESPONSE) {
      res.sendStatus(200);
      processPromise.catch((error) => {
        log({
          level: 'error',
          module: 'lead-ingestion',
          message: 'webhook.post_response_processing.failed',
          requestId,
          meta: { error: error?.message || String(error) },
        });
      });
      latency.end({ path: 'module-service', deferred: true });
      return { accepted: true, path: 'module-service', deferred: true };
    }

    await processPromise;
    res.sendStatus(200);
    latency.end({ path: 'module-service' });
    return { accepted: true, path: 'module-service' };
  }

  async processWebhookCore({ parsed, msg, requestId, tenantId, webhookStartedMs }) {
    await this.withDb(async (client) => {
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
        return;
      }

      const candidate = state.candidate;
      if (!candidate.is_human_mode) {
        const elapsed = Date.now() - webhookStartedMs;
        const shouldDeferForBudget = WEBHOOK_ADAPTIVE_BOT_DEFER && elapsed >= WEBHOOK_SYNC_BUDGET_MS;
        const shouldDeferForBackpressure = WEBHOOK_BACKPRESSURE_DEFER && activeBotExecutions >= BOT_ENGINE_MAX_CONCURRENCY;
        const shouldDeferBot = WEBHOOK_DEFER_BOT_ENGINE || shouldDeferForBudget || shouldDeferForBackpressure;

        if (shouldDeferBot) {
          this.runBotDeferred({
            candidate,
            parsed,
            requestId,
            tenantId,
            elapsed,
            reason: shouldDeferForBackpressure ? 'backpressure' : 'sync_budget',
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
    });
  }

  runBotDeferred({ candidate, parsed, requestId, tenantId, elapsed, reason = 'flag', activeExecutions = activeBotExecutions }) {
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

    setImmediate(() => {
      this.withDb(async (client) => {
        await this.runBotWithinBudget({ client, candidate, parsed, requestId, tenantId, deferred: true });
      }).catch((error) => {
        log({
          level: 'error',
          module: 'lead-ingestion',
          message: 'ingestion.bot_engine.deferred.failed',
          requestId,
          meta: {
            candidateId: candidate.id,
            error: error?.message || String(error),
          },
        });
      });
    });
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

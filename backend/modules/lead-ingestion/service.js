const { log } = require('../../shared/infra/logger');
const { buildLatencyTracker, parsePositiveInt, runWithTimeout } = require('../../shared/infra/perf');
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

    const processPromise = this.withDb(async (client) => {
      await this.executeWithRetry(client, async () => {
        const existing = await findInboundMessageByWhatsappId({ client, whatsappMessageId: msg.id });
        if (existing) return;

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

        if (!candidate.is_human_mode) {
          const botResult = await runWithTimeout({
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
                },
              });
            },
          });

          if (botResult && botResult.timedOut) {
            log({
              module: 'lead-ingestion',
              message: 'ingestion.bot_engine.deferred_after_timeout',
              requestId,
              meta: { candidateId: candidate.id },
            });
          }
        }

        this.triggerReportingSyncDeferred({
          candidateId: candidate.id,
          action: 'upsert',
          requestId,
          source: 'webhook',
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
      });
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

const { log } = require('../../shared/infra/logger');
const { buildLatencyTracker, parsePositiveInt } = require('../../shared/infra/perf');

const WEBHOOK_REPLY_WARN_MS = parsePositiveInt(process.env.WEBHOOK_REPLY_WARN_MS, 1200);

class LeadIngestionService {
  constructor({ legacyProcessor }) {
    this.legacyProcessor = legacyProcessor;
  }

  async handleIncomingMessage({ body, req, res, context }) {
    if (!this.legacyProcessor) {
      throw new Error('legacyProcessor is required for staged lead-ingestion migration');
    }

    log({
      module: 'lead-ingestion',
      message: 'ingestion.module_path.selected',
      requestId: context?.requestId || req?.requestId || null,
      meta: { tenantId: context?.tenantId || null }
    });

    const latency = buildLatencyTracker({
      module: 'lead-ingestion',
      requestId: context?.requestId || req?.requestId || null,
      operation: 'webhook_ingestion',
      warnThresholdMs: WEBHOOK_REPLY_WARN_MS,
      extraMeta: { tenantId: context?.tenantId || null }
    });

    await this.legacyProcessor({ body, req, res });
    latency.end({ path: 'module-facade' });
    return { accepted: true, path: 'module-facade' };
  }
}

module.exports = { LeadIngestionService };

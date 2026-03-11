const { log } = require('../../shared/infra/logger');

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

    await this.legacyProcessor({ body, req, res });
    return { accepted: true, path: 'module-facade' };
  }
}

module.exports = { LeadIngestionService };

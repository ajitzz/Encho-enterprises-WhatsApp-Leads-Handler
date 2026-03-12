const { LeadIngestionService } = require('./service');

const buildLeadIngestionFacade = ({
  legacyProcessor,
  withDb,
  executeWithRetry,
  runBotEngine,
  triggerReportingSyncDeferred,
}) => {
  const service = new LeadIngestionService({
    legacyProcessor,
    withDb,
    executeWithRetry,
    runBotEngine,
    triggerReportingSyncDeferred,
  });

  return async ({ body, req, res, context }) => {
    return service.handleIncomingMessage({ body, req, res, context });
  };
};

module.exports = { buildLeadIngestionFacade };

const { LeadIngestionService } = require('./service');
const { LeadAssignmentService } = require('./assignment');

const buildLeadIngestionFacade = ({
  legacyProcessor,
  withDb,
  executeWithRetry,
  runBotEngine,
  triggerReportingSyncDeferred,
  fetchAndStoreIncomingMedia,
}) => {
  const assignmentService = new LeadAssignmentService({
    withDb,
    executeWithRetry,
  });

  const service = new LeadIngestionService({
    legacyProcessor,
    withDb,
    executeWithRetry,
    runBotEngine,
    triggerReportingSyncDeferred,
    assignmentService,
    fetchAndStoreIncomingMedia,
  });

  return async ({ body, req, res, context }) => {
    return service.handleIncomingMessage({ body, req, res, context });
  };
};

module.exports = { buildLeadIngestionFacade };

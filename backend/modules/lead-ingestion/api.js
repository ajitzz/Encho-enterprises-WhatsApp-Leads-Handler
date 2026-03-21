const { LeadIngestionService } = require('./service');
const { LeadAssignmentService } = require('./assignment');
const { redis } = require('../../shared/infra/redis');

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
    redis,
  });

  const handleIncomingMessage = async ({ body, req, res, context }) => {
    return service.handleIncomingMessage({ body, req, res, context });
  };

  const handleDeferredBot = async ({ body, req, res, context }) => {
    return service.handleDeferredBot({ body, requestId: context?.requestId || req?.requestId, tenantId: context?.tenantId });
  };

  return { handleIncomingMessage, handleDeferredBot };
};

module.exports = { buildLeadIngestionFacade };

import { LeadIngestionService } from './service.js';
import { LeadAssignmentService } from './assignment.js';

export const buildLeadIngestionFacade = ({
  legacyProcessor,
  withDb,
  executeWithRetry,
  runBotEngine,
  triggerReportingSyncDeferred,
  notifyUpdates,
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
    notifyUpdates,
  });

  return async ({ body, req, res, context }) => {
    return service.handleIncomingMessage({ body, req, res, context });
  };
};

export default { buildLeadIngestionFacade };

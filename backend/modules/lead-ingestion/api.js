const { LeadIngestionService } = require('./service');

const buildLeadIngestionFacade = ({ legacyProcessor }) => {
  const service = new LeadIngestionService({ legacyProcessor });

  return async ({ body, req, res, context }) => {
    return service.handleIncomingMessage({ body, req, res, context });
  };
};

module.exports = { buildLeadIngestionFacade };

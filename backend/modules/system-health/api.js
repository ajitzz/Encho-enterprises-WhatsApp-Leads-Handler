const { SystemHealthServiceFacade } = require('./service');

const buildSystemHealthRouter = ({
  legacyHealthHandler,
  legacyReadyHandler,
  legacyOperationalStatusHandler,
  legacyPingHandler,
  legacyDebugStatusHandler,
}) => {
  const facade = new SystemHealthServiceFacade({
    legacyHealthHandler,
    legacyReadyHandler,
    legacyOperationalStatusHandler,
    legacyPingHandler,
    legacyDebugStatusHandler,
  });

  return {
    health: (req, res) => facade.health(req, res),
    ready: (req, res) => facade.ready(req, res),
    operationalStatus: (req, res) => facade.operationalStatus(req, res),
    ping: (req, res) => facade.ping(req, res),
    debugStatus: (req, res) => facade.debugStatus(req, res),
  };
};

module.exports = { buildSystemHealthRouter };

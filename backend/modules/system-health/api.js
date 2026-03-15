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

const registerSystemHealthRoutes = ({
  apiRouter,
  moduleRouter,
  resolveMode,
  legacyHandlers,
}) => {
  const routes = [
    {
      method: 'get',
      path: '/health',
      moduleHandler: moduleRouter.health,
      legacyHandler: legacyHandlers.health,
    },
    {
      method: 'get',
      path: '/ready',
      moduleHandler: moduleRouter.ready,
      legacyHandler: legacyHandlers.ready,
    },
    {
      method: 'get',
      path: '/system/operational-status',
      moduleHandler: moduleRouter.operationalStatus,
      legacyHandler: legacyHandlers.operationalStatus,
    },
    {
      method: 'get',
      path: '/ping',
      moduleHandler: moduleRouter.ping,
      legacyHandler: legacyHandlers.ping,
    },
    {
      method: 'get',
      path: '/debug/status',
      moduleHandler: moduleRouter.debugStatus,
      legacyHandler: legacyHandlers.debugStatus,
    },
  ];

  for (const route of routes) {
    apiRouter[route.method](route.path, async (req, res) => {
      const mode = resolveMode(req);
      if (mode !== 'off') return route.moduleHandler(req, res);
      return route.legacyHandler(req, res);
    });
  }
};

module.exports = { buildSystemHealthRouter, registerSystemHealthRoutes };

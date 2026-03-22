import { AuthConfigServiceFacade } from './service.js';

export const buildAuthConfigRouter = ({
  legacyVerifyGoogleHandler,
  legacyGetBotSettingsHandler,
  legacySaveBotSettingsHandler,
  legacyPublishBotHandler,
  legacyGetSystemSettingsHandler,
  legacyPatchSystemSettingsHandler,
}) => {
  const facade = new AuthConfigServiceFacade({
    legacyVerifyGoogleHandler,
    legacyGetBotSettingsHandler,
    legacySaveBotSettingsHandler,
    legacyPublishBotHandler,
    legacyGetSystemSettingsHandler,
    legacyPatchSystemSettingsHandler,
  });

  return {
    verifyGoogle: (req, res) => facade.verifyGoogle(req, res),
    getBotSettings: (req, res) => facade.getBotSettings(req, res),
    saveBotSettings: (req, res) => facade.saveBotSettings(req, res),
    publishBot: (req, res) => facade.publishBot(req, res),
    getSystemSettings: (req, res) => facade.getSystemSettings(req, res),
    patchSystemSettings: (req, res) => facade.patchSystemSettings(req, res),
  };
};

export const registerAuthConfigRoutes = ({
  apiRouter,
  moduleRouter,
  resolveMode,
  legacyHandlers,
}) => {
  const routes = [
    {
      method: 'get',
      path: '/system/settings',
      moduleHandler: moduleRouter.getSystemSettings,
      legacyHandler: legacyHandlers.getSystemSettings,
    },
    {
      method: 'patch',
      path: '/system/settings',
      moduleHandler: moduleRouter.patchSystemSettings,
      legacyHandler: legacyHandlers.patchSystemSettings,
    },
    {
      method: 'post',
      path: '/auth/google',
      moduleHandler: moduleRouter.verifyGoogle,
      legacyHandler: legacyHandlers.verifyGoogle,
    },
    {
      method: 'get',
      path: '/bot/settings',
      moduleHandler: moduleRouter.getBotSettings,
      legacyHandler: legacyHandlers.getBotSettings,
    },
    {
      method: 'post',
      path: '/bot/save',
      moduleHandler: moduleRouter.saveBotSettings,
      legacyHandler: legacyHandlers.saveBotSettings,
    },
    {
      method: 'post',
      path: '/bot/publish',
      moduleHandler: moduleRouter.publishBot,
      legacyHandler: legacyHandlers.publishBot,
    },
  ];

  console.log('[AUTH CONFIG] Registering routes...');
  for (const route of routes) {
    console.log(`[AUTH CONFIG] Registering ${route.method.toUpperCase()} ${route.path}`);
    apiRouter[route.method](route.path, async (req, res) => {
      console.log(`[AUTH CONFIG] Hit ${route.method.toUpperCase()} ${route.path}`);
      const mode = resolveMode(req);
      console.log(`[AUTH CONFIG] Mode resolved to: ${mode}`);
      if (mode !== 'off') {
        console.log('[AUTH CONFIG] Using module handler');
        return route.moduleHandler(req, res);
      }
      console.log('[AUTH CONFIG] Using legacy handler');
      return route.legacyHandler(req, res);
    });
  }
};

export default { buildAuthConfigRouter, registerAuthConfigRoutes };

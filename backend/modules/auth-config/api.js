const { AuthConfigServiceFacade } = require('./service');

const buildAuthConfigRouter = ({
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

module.exports = { buildAuthConfigRouter };

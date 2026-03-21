import { log } from '../../shared/infra/logger.js';
import { buildLatencyTracker, parsePositiveInt } from '../../shared/infra/perf.js';

const AUTH_CONFIG_WARN_MS = parsePositiveInt(process.env.AUTH_CONFIG_WARN_MS, 800);

export class AuthConfigServiceFacade {
  constructor({
    legacyVerifyGoogleHandler,
    legacyGetBotSettingsHandler,
    legacySaveBotSettingsHandler,
    legacyPublishBotHandler,
    legacyGetSystemSettingsHandler,
    legacyPatchSystemSettingsHandler,
  }) {
    this.legacyVerifyGoogleHandler = legacyVerifyGoogleHandler;
    this.legacyGetBotSettingsHandler = legacyGetBotSettingsHandler;
    this.legacySaveBotSettingsHandler = legacySaveBotSettingsHandler;
    this.legacyPublishBotHandler = legacyPublishBotHandler;
    this.legacyGetSystemSettingsHandler = legacyGetSystemSettingsHandler;
    this.legacyPatchSystemSettingsHandler = legacyPatchSystemSettingsHandler;
  }

  async verifyGoogle(req, res) {
    return this.#withFacadeTracing({
      req,
      operation: 'auth_config_verify_google',
      selectionEvent: 'auth-config.verify-google.module_path.selected',
      handler: this.legacyVerifyGoogleHandler,
    }, res);
  }

  async getBotSettings(req, res) {
    return this.#withFacadeTracing({
      req,
      operation: 'auth_config_get_bot_settings',
      selectionEvent: 'auth-config.bot-settings.get.module_path.selected',
      handler: this.legacyGetBotSettingsHandler,
    }, res);
  }

  async saveBotSettings(req, res) {
    return this.#withFacadeTracing({
      req,
      operation: 'auth_config_save_bot_settings',
      selectionEvent: 'auth-config.bot-settings.save.module_path.selected',
      handler: this.legacySaveBotSettingsHandler,
    }, res);
  }

  async publishBot(req, res) {
    return this.#withFacadeTracing({
      req,
      operation: 'auth_config_publish_bot',
      selectionEvent: 'auth-config.bot-settings.publish.module_path.selected',
      handler: this.legacyPublishBotHandler,
    }, res);
  }

  async getSystemSettings(req, res) {
    return this.#withFacadeTracing({
      req,
      operation: 'auth_config_get_system_settings',
      selectionEvent: 'auth-config.system-settings.get.module_path.selected',
      handler: this.legacyGetSystemSettingsHandler,
    }, res);
  }

  async patchSystemSettings(req, res) {
    return this.#withFacadeTracing({
      req,
      operation: 'auth_config_patch_system_settings',
      selectionEvent: 'auth-config.system-settings.patch.module_path.selected',
      handler: this.legacyPatchSystemSettingsHandler,
    }, res);
  }

  async #withFacadeTracing({ req, operation, selectionEvent, handler }, res) {
    log({
      module: 'auth-config',
      message: selectionEvent,
      requestId: req?.requestId || null,
    });

    const latency = buildLatencyTracker({
      module: 'auth-config',
      requestId: req?.requestId || null,
      operation,
      warnThresholdMs: AUTH_CONFIG_WARN_MS,
    });

    const result = await handler(req, res);
    latency.end({ path: 'module-facade' });
    return result;
  }
}

export default { AuthConfigServiceFacade };

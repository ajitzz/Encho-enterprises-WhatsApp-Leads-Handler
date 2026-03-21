import { log } from '../../shared/infra/logger.js';
import { buildLatencyTracker, parsePositiveInt } from '../../shared/infra/perf.js';

const HEALTH_WARN_MS = parsePositiveInt(process.env.SYSTEM_HEALTH_WARN_MS, 400);
const PING_WARN_MS = parsePositiveInt(process.env.SYSTEM_PING_WARN_MS, 600);
const DEBUG_WARN_MS = parsePositiveInt(process.env.SYSTEM_DEBUG_WARN_MS, 1200);

export class SystemHealthServiceFacade {
  constructor({
    legacyHealthHandler,
    legacyReadyHandler,
    legacyOperationalStatusHandler,
    legacyPingHandler,
    legacyDebugStatusHandler,
  }) {
    this.legacyHealthHandler = legacyHealthHandler;
    this.legacyReadyHandler = legacyReadyHandler;
    this.legacyOperationalStatusHandler = legacyOperationalStatusHandler;
    this.legacyPingHandler = legacyPingHandler;
    this.legacyDebugStatusHandler = legacyDebugStatusHandler;
  }

  async health(req, res) {
    return this.#withFacadeTracing({
      req,
      operation: 'system_health',
      selectionEvent: 'system-health.health.module_path.selected',
      warnThresholdMs: HEALTH_WARN_MS,
      handler: this.legacyHealthHandler,
    }, res);
  }

  async ready(req, res) {
    return this.#withFacadeTracing({
      req,
      operation: 'system_ready',
      selectionEvent: 'system-health.ready.module_path.selected',
      warnThresholdMs: HEALTH_WARN_MS,
      handler: this.legacyReadyHandler,
    }, res);
  }

  async operationalStatus(req, res) {
    return this.#withFacadeTracing({
      req,
      operation: 'system_operational_status',
      selectionEvent: 'system-health.operational-status.module_path.selected',
      warnThresholdMs: DEBUG_WARN_MS,
      handler: this.legacyOperationalStatusHandler,
    }, res);
  }

  async ping(req, res) {
    return this.#withFacadeTracing({
      req,
      operation: 'system_ping',
      selectionEvent: 'system-health.ping.module_path.selected',
      warnThresholdMs: PING_WARN_MS,
      handler: this.legacyPingHandler,
    }, res);
  }

  async debugStatus(req, res) {
    return this.#withFacadeTracing({
      req,
      operation: 'system_debug_status',
      selectionEvent: 'system-health.debug.module_path.selected',
      warnThresholdMs: DEBUG_WARN_MS,
      handler: this.legacyDebugStatusHandler,
    }, res);
  }

  async #withFacadeTracing({ req, operation, selectionEvent, warnThresholdMs, handler }, res) {
    log({
      module: 'system-health',
      message: selectionEvent,
      requestId: req?.requestId || null,
    });

    const latency = buildLatencyTracker({
      module: 'system-health',
      requestId: req?.requestId || null,
      operation,
      warnThresholdMs,
    });

    const result = await handler(req, res);
    latency.end({ path: 'module-facade' });
    return result;
  }
}

export default { SystemHealthServiceFacade };

import { log } from './logger.js';

export const nowMs = () => Number(process.hrtime.bigint() / 1000000n);

export const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
};

export const buildLatencyTracker = ({ module, requestId = null, operation, warnThresholdMs = 1500, extraMeta = {} } = {}) => {
  const startedAt = nowMs();

  return {
    end(meta = {}) {
      const durationMs = nowMs() - startedAt;
      const level = durationMs > warnThresholdMs ? 'error' : 'info';
      const message = durationMs > warnThresholdMs
        ? `${operation}.latency_budget_exceeded`
        : `${operation}.latency`;

      log({
        level,
        module,
        message,
        requestId,
        meta: {
          operation,
          durationMs,
          warnThresholdMs,
          ...extraMeta,
          ...meta,
        },
      });

      return durationMs;
    },
  };
};

export const buildStageTimer = ({ module, requestId = null, operation, warnThresholdMs = 300, extraMeta = {} } = {}) => {
  const startedAt = nowMs();

  return {
    end(meta = {}) {
      const durationMs = nowMs() - startedAt;
      const level = durationMs > warnThresholdMs ? 'error' : 'info';
      const message = durationMs > warnThresholdMs
        ? `${operation}.stage_latency_budget_exceeded`
        : `${operation}.stage_latency`;

      log({
        level,
        module,
        message,
        requestId,
        meta: {
          operation,
          durationMs,
          warnThresholdMs,
          ...extraMeta,
          ...meta,
        },
      });

      return durationMs;
    }
  };
};

export const runWithTimeout = async ({
  promise,
  timeoutMs,
  onTimeout,
} = {}) => {
  const normalizedTimeout = parsePositiveInt(timeoutMs, 0);
  if (!normalizedTimeout || !promise || typeof promise.then !== 'function') {
    return promise;
  }

  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(async () => {
          if (typeof onTimeout === 'function') {
            Promise.resolve(onTimeout()).catch(() => null);
          }
          resolve({ timedOut: true });
        }, normalizedTimeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export default {
  buildLatencyTracker,
  buildStageTimer,
  parsePositiveInt,
  runWithTimeout,
};

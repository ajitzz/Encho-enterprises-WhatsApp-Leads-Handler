const { log } = require('./logger');

const nowMs = () => Number(process.hrtime.bigint() / 1000000n);

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const buildLatencyTracker = ({ module, requestId = null, operation, warnThresholdMs = 1500, extraMeta = {} } = {}) => {
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

module.exports = {
  buildLatencyTracker,
  parsePositiveInt,
};

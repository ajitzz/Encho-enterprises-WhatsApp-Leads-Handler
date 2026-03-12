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

const runWithTimeout = async ({
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
            await onTimeout();
          }
          resolve({ timedOut: true });
        }, normalizedTimeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

module.exports = {
  buildLatencyTracker,
  parsePositiveInt,
  runWithTimeout,
};

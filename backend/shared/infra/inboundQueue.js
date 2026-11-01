import { redis } from './redis.js';
import { log } from './logger.js';

const INBOUND_QUEUE_KEY = 'whatsapp:inbound:queue';

// Circuit breaker state
let isCircuitBreakerOpen = false;
let circuitBreakerResetAt = 0;
let consecutiveFailures = 0;
let lastFailureReason = null;
let lastWarningLoggedAt = 0;

const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown when quota is exceeded
const CONSECUTIVE_FAILURE_THRESHOLD = 3;
const SHORT_COOLDOWN_MS = 60 * 1000; // 1 minute cooldown for generic transient errors

/**
 * Checks whether an error is a Redis quota or rate limit error (e.g. Upstash request cap).
 */
export const isQuotaOrRateLimitError = (errorMsg) => {
  if (!errorMsg || typeof errorMsg !== 'string') return false;
  const lower = errorMsg.toLowerCase();
  return (
    lower.includes('max requests limit exceeded') ||
    lower.includes('max_requests_limit') ||
    lower.includes('err max requests') ||
    lower.includes('quota exceeded') ||
    lower.includes('daily request limit') ||
    lower.includes('monthly request limit') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests')
  );
};

/**
 * Trip the circuit breaker for durationMs.
 */
export const tripCircuitBreaker = (reason, durationMs = DEFAULT_COOLDOWN_MS) => {
  isCircuitBreakerOpen = true;
  circuitBreakerResetAt = Date.now() + durationMs;
  lastFailureReason = reason;

  const now = Date.now();
  if (now - lastWarningLoggedAt > 60000) {
    lastWarningLoggedAt = now;
    log({
      level: 'warn',
      module: 'lead-ingestion',
      message: 'queue.redis.circuit_breaker_tripped',
      meta: {
        reason,
        cooldownSeconds: Math.round(durationMs / 1000),
        action: 'Falling back to direct in-memory webhook processing (sub-15ms fast-ack).'
      }
    });
    console.warn(`[Redis Circuit Breaker] ${reason}. Tripping circuit breaker for ${Math.round(durationMs / 1000)}s. Bypassing Redis write-behind and using direct in-memory execution.`);
  }
};

/**
 * Reset the circuit breaker to closed state.
 */
export const resetCircuitBreaker = () => {
  isCircuitBreakerOpen = false;
  circuitBreakerResetAt = 0;
  consecutiveFailures = 0;
  lastFailureReason = null;
};

/**
 * Get current circuit breaker status.
 */
export const getCircuitBreakerStatus = () => {
  if (isCircuitBreakerOpen && circuitBreakerResetAt > 0 && Date.now() > circuitBreakerResetAt) {
    isCircuitBreakerOpen = false;
    consecutiveFailures = 0;
  }
  return {
    isOpen: isCircuitBreakerOpen,
    resetAt: circuitBreakerResetAt,
    consecutiveFailures,
    lastFailureReason,
    remainingCooldownMs: Math.max(0, circuitBreakerResetAt - Date.now())
  };
};

/**
 * Check if Redis is configured and healthy (circuit breaker closed).
 */
export const isRedisAvailable = () => {
  if (isCircuitBreakerOpen) {
    if (Date.now() > circuitBreakerResetAt) {
      // Half-open: test recovery
      isCircuitBreakerOpen = false;
      consecutiveFailures = 0;
    } else {
      return false;
    }
  }
  return Boolean(redis);
};

/**
 * Push an incoming webhook payload into the Redis write-behind queue.
 * Returns true if enqueued into Redis, false if Redis is unavailable or fails.
 */
export const enqueueInboundPayload = async ({ body, requestId, tenantId, receivedAt = Date.now() }) => {
  if (!isRedisAvailable()) return false;
  try {
    const payloadString = JSON.stringify({ body, requestId, tenantId, receivedAt });
    await redis.rpush(INBOUND_QUEUE_KEY, payloadString);
    consecutiveFailures = 0;
    log({
      level: 'info',
      module: 'lead-ingestion',
      message: 'queue.redis.enqueued',
      requestId,
      meta: { queue: INBOUND_QUEUE_KEY, tenantId }
    });
    return true;
  } catch (err) {
    const errMsg = err?.message || String(err);
    if (isQuotaOrRateLimitError(errMsg)) {
      tripCircuitBreaker(`Upstash Redis quota exceeded: ${errMsg}`, DEFAULT_COOLDOWN_MS);
    } else {
      consecutiveFailures++;
      if (consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
        tripCircuitBreaker(`Multiple consecutive Redis failures (${consecutiveFailures}): ${errMsg}`, SHORT_COOLDOWN_MS);
      }
    }
    log({
      level: 'warn',
      module: 'lead-ingestion',
      message: 'queue.redis.enqueue_failed_falling_back',
      requestId,
      meta: { error: errMsg }
    });
    return false;
  }
};

/**
 * Fetch and pop a batch of queued webhook payloads from Redis.
 */
export const popInboundBatch = async (batchSize = 10) => {
  if (!isRedisAvailable()) return [];
  try {
    const items = [];
    for (let i = 0; i < batchSize; i++) {
      const raw = await redis.lpop(INBOUND_QUEUE_KEY);
      if (!raw) break;
      try {
        const item = typeof raw === 'string' ? JSON.parse(raw) : raw;
        items.push(item);
      } catch {
        // Skip malformed item
      }
    }
    consecutiveFailures = 0;
    return items;
  } catch (err) {
    const errMsg = err?.message || String(err);
    if (isQuotaOrRateLimitError(errMsg)) {
      tripCircuitBreaker(`Upstash Redis quota exceeded on pop: ${errMsg}`, DEFAULT_COOLDOWN_MS);
    } else {
      consecutiveFailures++;
      if (consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
        tripCircuitBreaker(`Multiple consecutive Redis failures on pop (${consecutiveFailures}): ${errMsg}`, SHORT_COOLDOWN_MS);
      }
    }
    const now = Date.now();
    if (now - lastWarningLoggedAt > 10000) {
      log({
        level: 'error',
        module: 'lead-ingestion',
        message: 'queue.redis.pop_error',
        meta: { error: errMsg }
      });
    }
    return [];
  }
};

/**
 * Get the current queue depth in Redis.
 */
export const getQueueLength = async () => {
  if (!isRedisAvailable()) return 0;
  try {
    const len = await redis.llen(INBOUND_QUEUE_KEY);
    consecutiveFailures = 0;
    return len;
  } catch (err) {
    const errMsg = err?.message || String(err);
    if (isQuotaOrRateLimitError(errMsg)) {
      tripCircuitBreaker(`Upstash Redis quota exceeded on llen: ${errMsg}`, DEFAULT_COOLDOWN_MS);
    }
    return 0;
  }
};

export default {
  isRedisAvailable,
  enqueueInboundPayload,
  popInboundBatch,
  getQueueLength,
  isQuotaOrRateLimitError,
  tripCircuitBreaker,
  resetCircuitBreaker,
  getCircuitBreakerStatus,
};

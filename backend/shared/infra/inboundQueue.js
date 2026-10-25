import { redis } from './redis.js';
import { log } from './logger.js';

const INBOUND_QUEUE_KEY = 'whatsapp:inbound:queue';

export const isRedisAvailable = () => Boolean(redis);

/**
 * Push an incoming webhook payload into the Redis write-behind queue.
 * Returns true if enqueued into Redis, false if Redis is unavailable.
 */
export const enqueueInboundPayload = async ({ body, requestId, tenantId, receivedAt = Date.now() }) => {
  if (!redis) return false;
  try {
    const payloadString = JSON.stringify({ body, requestId, tenantId, receivedAt });
    await redis.rpush(INBOUND_QUEUE_KEY, payloadString);
    log({
      level: 'info',
      module: 'lead-ingestion',
      message: 'queue.redis.enqueued',
      requestId,
      meta: { queue: INBOUND_QUEUE_KEY, tenantId }
    });
    return true;
  } catch (err) {
    log({
      level: 'warn',
      module: 'lead-ingestion',
      message: 'queue.redis.enqueue_failed_falling_back',
      requestId,
      meta: { error: err?.message || String(err) }
    });
    return false;
  }
};

/**
 * Fetch and pop a batch of queued webhook payloads from Redis.
 */
export const popInboundBatch = async (batchSize = 10) => {
  if (!redis) return [];
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
    return items;
  } catch (err) {
    log({
      level: 'error',
      module: 'lead-ingestion',
      message: 'queue.redis.pop_error',
      meta: { error: err?.message || String(err) }
    });
    return [];
  }
};

/**
 * Get the current queue depth in Redis.
 */
export const getQueueLength = async () => {
  if (!redis) return 0;
  try {
    return await redis.llen(INBOUND_QUEUE_KEY);
  } catch {
    return 0;
  }
};

export default {
  isRedisAvailable,
  enqueueInboundPayload,
  popInboundBatch,
  getQueueLength,
};

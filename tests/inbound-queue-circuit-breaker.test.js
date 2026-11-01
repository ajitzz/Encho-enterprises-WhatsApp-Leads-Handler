import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isQuotaOrRateLimitError,
  tripCircuitBreaker,
  resetCircuitBreaker,
  getCircuitBreakerStatus,
  isRedisAvailable,
  enqueueInboundPayload,
  popInboundBatch,
  getQueueLength
} from '../backend/shared/infra/inboundQueue.js';

test('Inbound Queue Circuit Breaker: identifies Upstash quota and rate limit errors', () => {
  const upstashError = 'Command failed: ERR max requests limit exceeded. Limit: 500000, Usage: 500000. See https://upstash.com/docs/redis/troubleshooting/max_requests_limit for details';
  assert.equal(isQuotaOrRateLimitError(upstashError), true);
  assert.equal(isQuotaOrRateLimitError('ERR max requests'), true);
  assert.equal(isQuotaOrRateLimitError('Daily request limit reached'), true);
  assert.equal(isQuotaOrRateLimitError('Monthly request limit reached'), true);
  assert.equal(isQuotaOrRateLimitError('rate limit exceeded'), true);
  assert.equal(isQuotaOrRateLimitError('Too many requests'), true);

  // Normal / non-quota errors
  assert.equal(isQuotaOrRateLimitError('SyntaxError: Unexpected token'), false);
  assert.equal(isQuotaOrRateLimitError('Connection timed out'), false);
  assert.equal(isQuotaOrRateLimitError(null), false);
  assert.equal(isQuotaOrRateLimitError(undefined), false);
});

test('Inbound Queue Circuit Breaker: tripping circuit breaker immediately marks Redis unavailable', async () => {
  resetCircuitBreaker();

  // Initially check status
  const initialStatus = getCircuitBreakerStatus();
  assert.equal(initialStatus.isOpen, false);

  // Trip circuit breaker with quota error
  tripCircuitBreaker('Upstash Redis quota exceeded: Limit 500000', 5000);

  const trippedStatus = getCircuitBreakerStatus();
  assert.equal(trippedStatus.isOpen, true);
  assert.equal(trippedStatus.lastFailureReason.includes('quota exceeded'), true);
  assert.equal(isRedisAvailable(), false);

  // Enqueue and pop should short-circuit and return immediately without throwing
  const enqueued = await enqueueInboundPayload({
    body: { test: true },
    requestId: 'req-test-1',
    tenantId: 'tenant-test'
  });
  assert.equal(enqueued, false);

  const batch = await popInboundBatch(10);
  assert.deepEqual(batch, []);

  const queueLen = await getQueueLength();
  assert.equal(queueLen, 0);

  // Reset circuit breaker
  resetCircuitBreaker();
  const resetStatus = getCircuitBreakerStatus();
  assert.equal(resetStatus.isOpen, false);
});

test('Inbound Queue Circuit Breaker: auto-recovers after cooldown duration expires', async () => {
  resetCircuitBreaker();

  // Trip for 50ms cooldown
  tripCircuitBreaker('Temporary test trip', 50);
  assert.equal(getCircuitBreakerStatus().isOpen, true);

  // Wait 60ms for cooldown to elapse
  await new Promise((resolve) => setTimeout(resolve, 60));

  // Accessing isRedisAvailable after expiration should clear the circuit breaker
  const available = isRedisAvailable();
  // If redis client is null in test environment, it returns false (since redis is not configured),
  // but circuit breaker itself transitions out of open state
  const currentStatus = getCircuitBreakerStatus();
  assert.equal(currentStatus.isOpen, false);

  resetCircuitBreaker();
});

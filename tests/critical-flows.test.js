const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveModuleMode } = require('../backend/shared/infra/flags');
const { LeadIngestionService } = require('../backend/modules/lead-ingestion/service');
const { ReminderServiceFacade } = require('../backend/modules/reminders-escalations/service');
const {
  validateLeadIngestedPayload,
  toLegacyLeadIngestedPayload,
  buildDeterministicDedupeKey,
} = require('../backend/modules/lead-ingestion/contracts');
const {
  normalizeReminderTaskDispatchedPayload,
  toLegacyReminderTaskDispatchedPayload,
  buildReminderAttemptIdempotencyKey,
} = require('../backend/modules/reminders-escalations/contracts');
const { buildStageTransitionFingerprint } = require('../backend/shared/contracts/idempotency');
const {
  EVENT_TYPES,
  SCHEMA_VERSION,
  buildEventEnvelope,
  assertEventEnvelope,
} = require('../backend/shared/contracts/internalEvents');

test('resolveModuleMode supports tenant canary', () => {
  const mode = resolveModuleMode({
    flagValue: 'canary',
    tenantId: 'tenant-a',
    requestId: 'req-1',
    canaryPercent: 0,
    tenantAllowList: ['tenant-a'],
  });

  assert.equal(mode, 'canary');
});

test('lead ingestion facade service delegates to legacy processor', async () => {
  let called = false;
  const service = new LeadIngestionService({
    legacyProcessor: async ({ body }) => {
      called = true;
      assert.deepEqual(body, { message: 'hello' });
    },
  });

  const result = await service.handleIncomingMessage({
    body: { message: 'hello' },
    req: { requestId: 'r-1' },
    res: {},
    context: { requestId: 'r-1', tenantId: 't-1' },
  });

  assert.equal(called, true);
  assert.deepEqual(result, { accepted: true, path: 'module-facade' });
});

test('reminder facade delegates schedule and processQueue handlers', async () => {
  const calls = [];
  const facade = new ReminderServiceFacade({
    legacyScheduleHandler: async () => {
      calls.push('schedule');
      return 'scheduled';
    },
    legacyQueueHandler: async () => {
      calls.push('queue');
      return 'queued';
    },
  });

  await facade.schedule({ requestId: 'r-2' }, {});
  await facade.processQueue({ requestId: 'r-2' }, {});

  assert.deepEqual(calls, ['schedule', 'queue']);
});

test('event envelope includes required metadata and schemaVersion', () => {
  const event = buildEventEnvelope({
    eventType: EVENT_TYPES.LEAD_INGESTED_V1,
    sourceModule: 'lead-ingestion',
    correlationId: 'corr-1',
    payload: { leadId: 'l-1' },
  });

  assert.equal(event.schemaVersion, SCHEMA_VERSION);
  assert.equal(event.eventType, EVENT_TYPES.LEAD_INGESTED_V1);
  assert.ok(assertEventEnvelope(event));
});

test('assertEventEnvelope throws for invalid event', () => {
  assert.throws(() => assertEventEnvelope({ eventType: 'x' }), /missing eventId/);
});

test('lead-ingested compatibility mapper supports old/new fields', () => {
  const normalized = validateLeadIngestedPayload({
    eventId: 'evt-1',
    received_at: '2026-01-01T00:00:00.000Z',
    source: 'meta',
    phone_number: '+15551234567',
    message_type: 'interactive',
    message_id: 'wamid-1',
    dedupeKey: 'whatsapp:wamid-1',
    leadId: 'lead-1',
  });

  assert.equal(normalized.phoneNumber, '+15551234567');
  assert.equal(normalized.messageType, 'interactive');

  const legacy = toLegacyLeadIngestedPayload(normalized);
  assert.equal(legacy.phone_number, normalized.phoneNumber);
  assert.equal(legacy.message_type, normalized.messageType);
});

test('reminder dispatched compatibility mapper supports old/new fields', () => {
  const normalized = normalizeReminderTaskDispatchedPayload({
    taskId: 'task-1',
    leadId: 'lead-1',
    dispatched_at: '2026-01-01T00:00:00.000Z',
    provider_message_id: 'msg-1',
    success: true,
  });

  assert.equal(normalized.dispatchedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(normalized.providerMessageId, 'msg-1');

  const legacy = toLegacyReminderTaskDispatchedPayload(normalized);
  assert.equal(legacy.provider_message_id, 'msg-1');
  assert.equal(legacy.dispatched_at, normalized.dispatchedAt);
});

test('idempotency builders are deterministic for ingestion/reminders/stage transitions', () => {
  const dedupeA = buildDeterministicDedupeKey({ providerMessageId: 'wamid-abc', channel: 'whatsapp' });
  const dedupeB = buildDeterministicDedupeKey({ providerMessageId: 'wamid-abc', channel: 'whatsapp' });
  assert.equal(dedupeA, dedupeB);

  const attemptA = buildReminderAttemptIdempotencyKey({ taskId: 'task-1', attemptCount: 2 });
  const attemptB = buildReminderAttemptIdempotencyKey({ taskId: 'task-1', attemptCount: 2 });
  assert.equal(attemptA, attemptB);

  const fingerprintA = buildStageTransitionFingerprint({
    leadId: 'lead-1',
    fromStage: 'New',
    toStage: 'Qualified',
    changedAt: 1710000000000,
  });
  const fingerprintB = buildStageTransitionFingerprint({
    leadId: 'lead-1',
    fromStage: 'New',
    toStage: 'Qualified',
    changedAt: 1710000000000,
  });
  assert.equal(fingerprintA, fingerprintB);
});

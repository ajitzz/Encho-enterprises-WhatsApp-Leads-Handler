const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveModuleMode } = require('../backend/shared/infra/flags');
const { LeadIngestionService } = require('../backend/modules/lead-ingestion/service');
const { ReminderServiceFacade } = require('../backend/modules/reminders-escalations/service');
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

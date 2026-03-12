const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveModuleMode } = require('../backend/shared/infra/flags');
const { buildLatencyTracker, parsePositiveInt } = require('../backend/shared/infra/perf');
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

const { validateStageTransitionInput } = require('../backend/modules/lead-lifecycle/contracts');
const { validateReportingExportInput } = require('../backend/modules/reporting-export/contracts');
const { validateMediaOperationInput } = require('../backend/modules/media/contracts');
const { validateConversationAdvanceInput } = require('../backend/modules/bot-conversation/contracts');
const { validateWorkspaceLeadDetailInput } = require('../backend/modules/agent-workspace/contracts');
const { validateCampaignJobUpdatedPayload } = require('../backend/modules/campaign-broadcast/contracts');
const { validateSystemHealthSnapshot } = require('../backend/modules/system-health/contracts');
const { validateAuthConfigUpdateInput } = require('../backend/modules/auth-config/contracts');
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

test('lead ingestion service processes webhook via module service path', async () => {
  const calls = [];
  const service = new LeadIngestionService({
    withDb: async (handler) => {
      calls.push('withDb');
      await handler({
        query: async (sql) => {
          if (String(sql).includes('SELECT id FROM candidate_messages')) return { rows: [] };
          if (String(sql).includes('INSERT INTO candidates')) {
            return { rows: [{ id: 'lead-1', phone_number: '+123', is_human_mode: false }] };
          }
          return { rows: [] };
        }
      });
    },
    executeWithRetry: async (_, handler) => {
      calls.push('executeWithRetry');
      await handler();
    },
    runBotEngine: async () => {
      calls.push('runBotEngine');
    },
    triggerReportingSyncDeferred: () => {
      calls.push('reportingSync');
    }
  });

  const req = { requestId: 'r-1' };
  const res = {
    statusCode: null,
    sendStatus(code) {
      this.statusCode = code;
    },
  };

  const body = {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          contacts: [{ profile: { name: 'Test User' } }],
          messages: [{ id: 'wamid-1', from: '+123', type: 'text', text: { body: 'Hello' } }]
        }
      }]
    }]
  };

  const result = await service.handleIncomingMessage({
    body,
    req,
    res,
    context: { requestId: 'r-1', tenantId: 't-1' },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(result, { accepted: true, path: 'module-service' });
  assert.deepEqual(calls, ['withDb', 'executeWithRetry', 'runBotEngine', 'reportingSync']);
});

test('lead ingestion service falls back to facade path when dependencies are missing', async () => {
  let called = false;
  const service = new LeadIngestionService({
    legacyProcessor: async ({ body }) => {
      called = true;
      assert.equal(body.object, 'whatsapp_business_account');
    },
  });

  const result = await service.handleIncomingMessage({
    body: { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ id: 'wamid-1' }] } }] }] },
    req: { requestId: 'r-1' },
    res: { sendStatus() {} },
    context: { requestId: 'r-1', tenantId: 't-1' },
  });

  assert.equal(called, true);
  assert.deepEqual(result, { accepted: true, path: 'module-facade-fallback' });
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

test('parsePositiveInt uses fallback for invalid values', () => {
  assert.equal(parsePositiveInt('1200', 500), 1200);
  assert.equal(parsePositiveInt('-5', 500), 500);
  assert.equal(parsePositiveInt(undefined, 700), 700);
});

test('buildLatencyTracker returns a numeric duration', async () => {
  const tracker = buildLatencyTracker({
    module: 'test-module',
    requestId: 'req-1',
    operation: 'test_operation',
    warnThresholdMs: 1,
  });

  await new Promise((resolve) => setTimeout(resolve, 3));
  const duration = tracker.end({ check: true });
  assert.equal(typeof duration, 'number');
  assert.ok(duration >= 0);
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

test('lead-lifecycle contract validates stage transition ingress payloads', () => {
  const payload = validateStageTransitionInput({
    leadId: 'lead-1',
    fromStage: 'New',
    toStage: 'Qualified',
    actor: 'agent-1',
    changedAt: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(payload.schemaVersion, '1.0.0');
  assert.equal(payload.toStage, 'Qualified');

  assert.throws(
    () => validateStageTransitionInput({ leadId: 'lead-1', fromStage: 'Unknown', toStage: 'Qualified', actor: 'agent-1', changedAt: Date.now() }),
    /fromStage is invalid/
  );
});

test('reporting-export contract validates export request payloads', () => {
  const payload = validateReportingExportInput({
    exportType: 'driver-excel',
    triggeredBy: 'system-cron',
    includeArchived: 0,
  });

  assert.equal(payload.schemaVersion, '1.0.0');
  assert.equal(payload.includeArchived, false);

  assert.throws(
    () => validateReportingExportInput({ exportType: 'invalid-type', triggeredBy: 'system-cron' }),
    /exportType is invalid/
  );
});

test('media contract validates media operation ingress payloads', () => {
  const payload = validateMediaOperationInput({
    action: 'list',
    folder: 'driver-docs',
  });

  assert.equal(payload.schemaVersion, '1.0.0');
  assert.equal(payload.action, 'list');

  assert.throws(
    () => validateMediaOperationInput({ action: 'wipe-bucket' }),
    /action is invalid/
  );
});

test('bot-conversation contract validates advance payload', () => {
  const payload = validateConversationAdvanceInput({
    leadId: 'lead-1',
    currentStepId: 'step-1',
    inboundType: 'interactive',
    content: 'Yes',
  });

  assert.equal(payload.schemaVersion, '1.0.0');
  assert.equal(payload.inboundType, 'interactive');

  assert.throws(
    () => validateConversationAdvanceInput({ leadId: 'lead-1', currentStepId: 'step-1', inboundType: 'voice' }),
    /inboundType is invalid/
  );
});

test('agent-workspace contract validates lead detail request', () => {
  const payload = validateWorkspaceLeadDetailInput({
    leadId: 'lead-1',
    includeMessages: 1,
    includeTimeline: 0,
  });

  assert.equal(payload.schemaVersion, '1.0.0');
  assert.equal(payload.includeMessages, true);
  assert.equal(payload.includeTimeline, false);

  assert.throws(
    () => validateWorkspaceLeadDetailInput({ leadId: null }),
    /leadId is required/
  );
});

test('campaign-broadcast contract validates job status updates', () => {
  const payload = validateCampaignJobUpdatedPayload({
    jobId: 'job-1',
    previousStatus: 'queued',
    currentStatus: 'processing',
    counters: { queued: 100, sent: 0 },
  });

  assert.equal(payload.schemaVersion, '1.0.0');
  assert.equal(payload.currentStatus, 'processing');

  assert.throws(
    () => validateCampaignJobUpdatedPayload({ jobId: 'job-1', previousStatus: 'queued', currentStatus: 'invalid', counters: {} }),
    /currentStatus is invalid/
  );
});

test('system-health contract validates operational snapshot payload', () => {
  const payload = validateSystemHealthSnapshot({
    status: 'degraded',
    timestamp: '2026-01-01T00:00:00.000Z',
    dependencies: { db: 'ok', queue: 'degraded' },
    degradedReasons: ['queue lag elevated'],
  });

  assert.equal(payload.schemaVersion, '1.0.0');
  assert.equal(payload.status, 'degraded');

  assert.throws(
    () => validateSystemHealthSnapshot({ status: 'warn' }),
    /status is invalid/
  );
});

test('auth-config contract validates runtime config update payload', () => {
  const payload = validateAuthConfigUpdateInput({
    actor: 'ops-admin',
    googleClientId: 'google-client-id',
    publicAppUrl: 'https://example.com',
  });

  assert.equal(payload.schemaVersion, '1.0.0');
  assert.equal(payload.actor, 'ops-admin');

  assert.throws(
    () => validateAuthConfigUpdateInput({ actor: 'ops-admin', googleClientId: '', publicAppUrl: 'https://example.com' }),
    /googleClientId is required/
  );
});

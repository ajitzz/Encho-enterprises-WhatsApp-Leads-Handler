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

const loadLeadIngestionServiceWithEnv = (env = {}) => {
  const servicePath = require.resolve('../backend/modules/lead-ingestion/service');
  const previousEnv = {};
  for (const key of Object.keys(env)) {
    previousEnv[key] = process.env[key];
  }

  Object.assign(process.env, env);
  delete require.cache[servicePath];
  const { LeadIngestionService: ReloadedLeadIngestionService } = require('../backend/modules/lead-ingestion/service');

  for (const key of Object.keys(env)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }

  return ReloadedLeadIngestionService;
};

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
      return handler();
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

test('lead ingestion service supports deferred webhook ack mode', async () => {
  const DeferredLeadIngestionService = loadLeadIngestionServiceWithEnv({ FF_WEBHOOK_DEFER_POST_RESPONSE: 'true' });
  let resolveProcessing;
  let processed = false;

  const service = new DeferredLeadIngestionService({
    withDb: async (handler) => {
      await handler({
        query: async (sql) => {
          if (String(sql).includes('SELECT id FROM candidate_messages')) return { rows: [] };
          if (String(sql).includes('INSERT INTO candidates')) return { rows: [{ id: 'lead-2', phone_number: '+999', is_human_mode: false }] };
          return { rows: [] };
        }
      });
      await new Promise((resolve) => {
        resolveProcessing = resolve;
      });
      processed = true;
    },
    executeWithRetry: async (_, handler) => { await new Promise((resolve) => setTimeout(resolve, 3)); return handler(); },
    runBotEngine: async () => {},
    triggerReportingSyncDeferred: () => {},
  });

  const res = { statusCode: null, sendStatus(code) { this.statusCode = code; } };
  const webhookPromise = service.handleIncomingMessage({
    body: {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { contacts: [{ profile: { name: 'Deferred User' } }], messages: [{ id: 'wamid-2', from: '+999', type: 'text', text: { body: 'Hi' } }] } }] }],
    },
    req: { requestId: 'r-3' },
    res,
    context: { requestId: 'r-3', tenantId: 't-3' },
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(res.statusCode, 200);
  assert.equal(processed, false);

  resolveProcessing();
  const result = await webhookPromise;
  assert.deepEqual(result, { accepted: true, path: 'module-service', deferred: true });
  assert.equal(processed, true);
});

test('lead ingestion service defers bot on backpressure to keep webhook fast', async () => {
  const BackpressureLeadIngestionService = loadLeadIngestionServiceWithEnv({
    BOT_ENGINE_MAX_CONCURRENCY: '1',
    FF_WEBHOOK_BACKPRESSURE_DEFER: 'true',
    FF_WEBHOOK_ADAPTIVE_BOT_DEFER: 'false',
    FF_WEBHOOK_DEFER_BOT_ENGINE: 'false',
  });

  let releaseFirst;
  let leadCounter = 0;
  const calls = [];

  const service = new BackpressureLeadIngestionService({
    withDb: async (handler) => {
      await handler({
        query: async (sql) => {
          if (String(sql).includes('SELECT id FROM candidate_messages')) return { rows: [] };
          if (String(sql).includes('INSERT INTO candidates')) {
            leadCounter += 1;
            return { rows: [{ id: `lead-bp-${leadCounter}`, phone_number: '+100', is_human_mode: false }] };
          }
          return { rows: [] };
        }
      });
    },
    executeWithRetry: async (_, handler) => handler(),
    runBotEngine: async () => {
      calls.push('runBotEngine');
      await new Promise((resolve) => {
        if (!releaseFirst) {
          releaseFirst = resolve;
          return;
        }
        resolve();
      });
    },
    triggerReportingSyncDeferred: () => {
      calls.push('reportingSync');
    },
  });

  const res1 = { statusCode: null, sendStatus(code) { this.statusCode = code; } };
  const res2 = { statusCode: null, sendStatus(code) { this.statusCode = code; } };

  const first = service.handleIncomingMessage({
    body: {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { contacts: [{ profile: { name: 'A' } }], messages: [{ id: 'wamid-bp-1', from: '+100', type: 'text', text: { body: 'one' } }] } }] }],
    },
    req: { requestId: 'r-bp-1' },
    res: res1,
    context: { requestId: 'r-bp-1', tenantId: 't-bp' },
  });

  await new Promise((resolve) => setTimeout(resolve, 5));

  const second = service.handleIncomingMessage({
    body: {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { contacts: [{ profile: { name: 'B' } }], messages: [{ id: 'wamid-bp-2', from: '+100', type: 'text', text: { body: 'two' } }] } }] }],
    },
    req: { requestId: 'r-bp-2' },
    res: res2,
    context: { requestId: 'r-bp-2', tenantId: 't-bp' },
  });

  const secondResult = await second;

  releaseFirst();
  await first;

  assert.equal(res1.statusCode, 200);
  assert.equal(res2.statusCode, 200);
  assert.deepEqual(secondResult, { accepted: true, path: 'module-service' });
  assert.ok(calls.filter((call) => call === 'runBotEngine').length >= 1);
});

test('lead ingestion service logs timeout and continues when bot exceeds hard timeout', async () => {
  const TimeoutLeadIngestionService = loadLeadIngestionServiceWithEnv({ BOT_ENGINE_HARD_TIMEOUT_MS: '10' });
  let reportingTriggered = false;

  const service = new TimeoutLeadIngestionService({
    withDb: async (handler) => {
      await handler({
        query: async (sql) => {
          if (String(sql).includes('SELECT id FROM candidate_messages')) return { rows: [] };
          if (String(sql).includes('INSERT INTO candidates')) return { rows: [{ id: 'lead-3', phone_number: '+111', is_human_mode: false }] };
          return { rows: [] };
        }
      });
    },
    executeWithRetry: async (_, handler) => { await new Promise((resolve) => setTimeout(resolve, 3)); return handler(); },
    runBotEngine: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
    triggerReportingSyncDeferred: () => {
      reportingTriggered = true;
    },
  });

  const res = { statusCode: null, sendStatus(code) { this.statusCode = code; } };
  const result = await service.handleIncomingMessage({
    body: {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { contacts: [{ profile: { name: 'Timeout User' } }], messages: [{ id: 'wamid-3', from: '+111', type: 'text', text: { body: 'Hello' } }] } }] }],
    },
    req: { requestId: 'r-4' },
    res,
    context: { requestId: 'r-4', tenantId: 't-4' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(reportingTriggered, true);
  assert.deepEqual(result, { accepted: true, path: 'module-service' });
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

test('lead ingestion service defers bot when sync budget is exceeded', async () => {
  const AdaptiveLeadIngestionService = loadLeadIngestionServiceWithEnv({
    WEBHOOK_SYNC_BUDGET_MS: '1',
    FF_WEBHOOK_ADAPTIVE_BOT_DEFER: 'true',
    FF_WEBHOOK_DEFER_BOT_ENGINE: 'false',
  });

  let runBotCalls = 0;
  const service = new AdaptiveLeadIngestionService({
    withDb: async (handler) => {
      await handler({
        query: async (sql) => {
          if (String(sql).includes('SELECT id FROM candidate_messages')) return { rows: [] };
          if (String(sql).includes('INSERT INTO candidates')) return { rows: [{ id: 'lead-4', phone_number: '+222', is_human_mode: false }] };
          return { rows: [] };
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    executeWithRetry: async (_, handler) => { await new Promise((resolve) => setTimeout(resolve, 3)); return handler(); },
    runBotEngine: async () => {
      runBotCalls += 1;
    },
    triggerReportingSyncDeferred: () => {},
  });

  const res = { statusCode: null, sendStatus(code) { this.statusCode = code; } };
  const result = await service.handleIncomingMessage({
    body: {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { contacts: [{ profile: { name: 'Adaptive User' } }], messages: [{ id: 'wamid-4', from: '+222', type: 'text', text: { body: 'Hello' } }] } }] }],
    },
    req: { requestId: 'r-5' },
    res,
    context: { requestId: 'r-5', tenantId: 't-5' },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(result, { accepted: true, path: 'module-service' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runBotCalls, 1);
});

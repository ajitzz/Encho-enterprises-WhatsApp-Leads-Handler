const SCHEMA_VERSION = '1.0.0';

const EVENT_TYPES = {
  LEAD_INGESTED_V1: 'lead.ingested.v1',
  CONVERSATION_ADVANCED_V1: 'conversation.advanced.v1',
  LEAD_STAGE_CHANGED_V1: 'lead.stage.changed.v1',
  REMINDER_TASK_CREATED_V1: 'reminder.task.created.v1',
  REMINDER_TASK_DISPATCHED_V1: 'reminder.task.dispatched.v1',
  CAMPAIGN_JOB_UPDATED_V1: 'campaign.job.updated.v1',
};

const buildEventEnvelope = ({
  eventType,
  payload,
  sourceModule,
  correlationId,
  causationId = null,
  tenantId = null,
  eventId = null,
  occurredAt = null,
} = {}) => {
  if (!eventType) throw new Error('eventType is required');
  if (!sourceModule) throw new Error('sourceModule is required');
  if (!correlationId) throw new Error('correlationId is required');

  return {
    eventId: eventId || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    eventType,
    occurredAt: occurredAt || new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    sourceModule,
    correlationId,
    causationId,
    tenantId,
    payload: payload || {},
  };
};

const assertEventEnvelope = (event) => {
  const required = ['eventId', 'eventType', 'occurredAt', 'schemaVersion', 'sourceModule', 'correlationId', 'payload'];
  for (const field of required) {
    if (event?.[field] === undefined || event?.[field] === null || event?.[field] === '') {
      throw new Error(`invalid event envelope: missing ${field}`);
    }
  }
  return true;
};

module.exports = {
  SCHEMA_VERSION,
  EVENT_TYPES,
  buildEventEnvelope,
  assertEventEnvelope,
};

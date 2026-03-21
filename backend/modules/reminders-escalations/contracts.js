import { SCHEMA_VERSION, EVENT_TYPES } from '../../shared/contracts/internalEvents.js';

export const REMINDER_MODES = {
  OFF: 'off',
  CANARY: 'canary',
  ON: 'on'
};

export const REMINDER_TASK_CREATED_CONTRACT = {
  eventType: EVENT_TYPES.REMINDER_TASK_CREATED_V1,
  schemaVersion: SCHEMA_VERSION,
  requiredFields: ['taskId', 'leadId', 'scheduledAt', 'payloadType'],
};

export const REMINDER_TASK_DISPATCHED_CONTRACT = {
  eventType: EVENT_TYPES.REMINDER_TASK_DISPATCHED_V1,
  schemaVersion: SCHEMA_VERSION,
  requiredFields: ['taskId', 'leadId', 'dispatchedAt', 'success'],
};

export const normalizeReminderTaskCreatedPayload = (payload = {}) => ({
  taskId: payload.taskId,
  leadId: payload.leadId,
  scheduledAt: payload.scheduledAt ?? payload.scheduled_at,
  payloadType: payload.payloadType ?? payload.payload_type ?? 'text',
  schemaVersion: payload.schemaVersion || SCHEMA_VERSION,
});

export const normalizeReminderTaskDispatchedPayload = (payload = {}) => ({
  taskId: payload.taskId,
  leadId: payload.leadId,
  dispatchedAt: payload.dispatchedAt ?? payload.dispatched_at,
  providerMessageId: payload.providerMessageId ?? payload.provider_message_id ?? null,
  success: Boolean(payload.success),
  error: payload.error ?? null,
  schemaVersion: payload.schemaVersion || SCHEMA_VERSION,
});

export const toLegacyReminderTaskDispatchedPayload = (payload = {}) => ({
  taskId: payload.taskId,
  leadId: payload.leadId,
  dispatched_at: payload.dispatchedAt,
  provider_message_id: payload.providerMessageId ?? null,
  success: Boolean(payload.success),
  error: payload.error ?? null,
  schemaVersion: payload.schemaVersion || SCHEMA_VERSION,
});

export const buildReminderAttemptIdempotencyKey = ({ taskId, attemptCount } = {}) => {
  if (!taskId) throw new Error('taskId is required');
  if (!Number.isInteger(attemptCount) || attemptCount < 0) {
    throw new Error('attemptCount must be a non-negative integer');
  }
  return `${taskId}:${attemptCount}`;
};

export default {
  REMINDER_MODES,
  REMINDER_TASK_CREATED_CONTRACT,
  REMINDER_TASK_DISPATCHED_CONTRACT,
  normalizeReminderTaskCreatedPayload,
  normalizeReminderTaskDispatchedPayload,
  toLegacyReminderTaskDispatchedPayload,
  buildReminderAttemptIdempotencyKey,
};

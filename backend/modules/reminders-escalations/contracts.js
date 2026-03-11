const { SCHEMA_VERSION, EVENT_TYPES } = require('../../shared/contracts/internalEvents');

module.exports = {
  REMINDER_MODES: {
    OFF: 'off',
    CANARY: 'canary',
    ON: 'on'
  },
  REMINDER_TASK_CREATED_CONTRACT: {
    eventType: EVENT_TYPES.REMINDER_TASK_CREATED_V1,
    schemaVersion: SCHEMA_VERSION,
    requiredFields: ['taskId', 'leadId', 'scheduledAt', 'payloadType'],
  },
  REMINDER_TASK_DISPATCHED_CONTRACT: {
    eventType: EVENT_TYPES.REMINDER_TASK_DISPATCHED_V1,
    schemaVersion: SCHEMA_VERSION,
    requiredFields: ['taskId', 'leadId', 'dispatchedAt', 'success'],
  }
};

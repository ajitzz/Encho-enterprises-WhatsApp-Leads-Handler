const { SCHEMA_VERSION, EVENT_TYPES } = require('../../shared/contracts/internalEvents');

const CAMPAIGN_JOB_UPDATED_CONTRACT = {
  eventType: EVENT_TYPES.CAMPAIGN_JOB_UPDATED_V1,
  schemaVersion: SCHEMA_VERSION,
  requiredFields: ['jobId', 'previousStatus', 'currentStatus', 'counters'],
};

const ALLOWED_CAMPAIGN_STATUSES = new Set(['queued', 'processing', 'paused', 'completed', 'failed', 'cancelled']);

function validateCampaignJobUpdatedPayload(input = {}) {
  const normalized = {
    jobId: input.jobId,
    previousStatus: input.previousStatus,
    currentStatus: input.currentStatus,
    counters: input.counters,
    schemaVersion: input.schemaVersion || SCHEMA_VERSION,
  };

  for (const field of CAMPAIGN_JOB_UPDATED_CONTRACT.requiredFields) {
    if (normalized[field] === undefined || normalized[field] === null || normalized[field] === '') {
      throw new Error(`campaign-broadcast.contract: missing ${field}`);
    }
  }

  if (!ALLOWED_CAMPAIGN_STATUSES.has(normalized.currentStatus)) {
    throw new Error('campaign-broadcast.contract: currentStatus is invalid');
  }

  if (!ALLOWED_CAMPAIGN_STATUSES.has(normalized.previousStatus)) {
    throw new Error('campaign-broadcast.contract: previousStatus is invalid');
  }

  if (typeof normalized.counters !== 'object' || Array.isArray(normalized.counters)) {
    throw new Error('campaign-broadcast.contract: counters must be an object');
  }

  return normalized;
}

module.exports = {
  CAMPAIGN_JOB_UPDATED_CONTRACT,
  ALLOWED_CAMPAIGN_STATUSES,
  validateCampaignJobUpdatedPayload,
};

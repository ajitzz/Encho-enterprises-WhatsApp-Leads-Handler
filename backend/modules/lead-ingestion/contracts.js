const { SCHEMA_VERSION, EVENT_TYPES } = require('../../shared/contracts/internalEvents');

/**
 * @typedef {Object} IngestionContext
 * @property {string | null} requestId
 * @property {string | null} tenantId
 */

/**
 * @typedef {Object} IngestionResult
 * @property {boolean} accepted
 * @property {string} path
 */

const LEAD_INGESTED_CONTRACT = {
  eventType: EVENT_TYPES.LEAD_INGESTED_V1,
  schemaVersion: SCHEMA_VERSION,
  requiredFields: ['eventId', 'receivedAt', 'source', 'phoneNumber', 'messageType', 'messageId', 'dedupeKey', 'leadId'],
};

module.exports = {
  LEAD_INGESTED_CONTRACT,
};

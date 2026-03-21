import { SCHEMA_VERSION, EVENT_TYPES } from '../../shared/contracts/internalEvents.js';

export const LEAD_INGESTED_CONTRACT = {
  eventType: EVENT_TYPES.LEAD_INGESTED_V1,
  schemaVersion: SCHEMA_VERSION,
  requiredFields: ['eventId', 'receivedAt', 'source', 'phoneNumber', 'messageType', 'messageId', 'dedupeKey', 'leadId'],
};

export const normalizeLeadIngestedPayload = (payload = {}) => {
  // Compatibility mapper: old field names -> new field names.
  const phoneNumber = payload.phoneNumber ?? payload.phone_number ?? null;
  const messageType = payload.messageType ?? payload.message_type ?? 'text';
  const messageId = payload.messageId ?? payload.message_id ?? null;
  const receivedAt = payload.receivedAt ?? payload.received_at ?? new Date().toISOString();
  const source = payload.source ?? 'whatsapp-meta';

  return {
    eventId: payload.eventId,
    receivedAt,
    source,
    phoneNumber,
    messageType,
    messageId,
    dedupeKey: payload.dedupeKey,
    leadId: payload.leadId,
    schemaVersion: payload.schemaVersion || SCHEMA_VERSION,
  };
};

export const toLegacyLeadIngestedPayload = (payload = {}) => ({
  eventId: payload.eventId,
  received_at: payload.receivedAt,
  source: payload.source,
  phone_number: payload.phoneNumber,
  message_type: payload.messageType,
  message_id: payload.messageId,
  dedupeKey: payload.dedupeKey,
  leadId: payload.leadId,
  schemaVersion: payload.schemaVersion || SCHEMA_VERSION,
});

export const validateLeadIngestedPayload = (payload = {}) => {
  const normalized = normalizeLeadIngestedPayload(payload);
  for (const field of LEAD_INGESTED_CONTRACT.requiredFields) {
    if (normalized[field] === undefined || normalized[field] === null || normalized[field] === '') {
      throw new Error(`lead.ingested contract violation: missing ${field}`);
    }
  }
  return normalized;
};

export const buildDeterministicDedupeKey = ({ providerMessageId, channel = 'whatsapp' } = {}) => {
  if (!providerMessageId) throw new Error('providerMessageId is required');
  return `${String(channel).toLowerCase()}:${String(providerMessageId).trim()}`;
};

export default {
  LEAD_INGESTED_CONTRACT,
  normalizeLeadIngestedPayload,
  toLegacyLeadIngestedPayload,
  validateLeadIngestedPayload,
  buildDeterministicDedupeKey,
};

export const BOT_CONVERSATION_SCHEMA_VERSION = '1.0.0';

export const ALLOWED_INBOUND_TYPES = new Set(['text', 'interactive', 'location', 'media', 'unknown']);

export function validateConversationAdvanceInput(input = {}) {
  const {
    leadId,
    currentStepId,
    inboundType = 'text',
    content,
    receivedAt,
    schemaVersion = BOT_CONVERSATION_SCHEMA_VERSION,
  } = input;

  if (!leadId || typeof leadId !== 'string') {
    throw new Error('bot-conversation.contract: leadId is required');
  }

  if (!currentStepId || typeof currentStepId !== 'string') {
    throw new Error('bot-conversation.contract: currentStepId is required');
  }

  if (!ALLOWED_INBOUND_TYPES.has(String(inboundType))) {
    throw new Error('bot-conversation.contract: inboundType is invalid');
  }

  if (content !== undefined && content !== null && typeof content !== 'string') {
    throw new Error('bot-conversation.contract: content must be a string when provided');
  }

  const receivedAtIso = receivedAt ? new Date(receivedAt).toISOString() : new Date().toISOString();
  if (Number.isNaN(Date.parse(receivedAtIso))) {
    throw new Error('bot-conversation.contract: receivedAt must be a valid timestamp');
  }

  return {
    schemaVersion,
    leadId,
    currentStepId,
    inboundType: String(inboundType),
    content: content ?? '',
    receivedAt: receivedAtIso,
  };
}

export default {
  BOT_CONVERSATION_SCHEMA_VERSION,
  ALLOWED_INBOUND_TYPES,
  validateConversationAdvanceInput,
};

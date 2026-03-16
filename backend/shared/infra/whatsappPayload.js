const MAX_TEXT_MESSAGE_LENGTH = Number.parseInt(process.env.MAX_TEXT_MESSAGE_LENGTH || '4096', 10);

const normalizeTextBody = (value) => (typeof value === 'string' ? value : String(value || ''));

const summarizePayloadForStorage = (payload) => {
  if (!payload || typeof payload !== 'object') return '[Unknown payload]';
  if (payload.type === 'text') return normalizeTextBody(payload.text?.body);
  if (payload.type === 'interactive') return normalizeTextBody(payload.interactive?.body?.text || '[Interactive]');
  if (payload.type === 'image') return normalizeTextBody(payload.image?.caption || '[Image]');
  if (payload.type === 'video') return normalizeTextBody(payload.video?.caption || '[Video]');
  if (payload.type === 'document') return normalizeTextBody(payload.document?.caption || '[Document]');
  if (payload.type === 'audio') return '[Audio]';
  return '[Media]';
};

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

const validateInteractiveButtons = (interactive) => {
  const bodyText = normalizeTextBody(interactive?.body?.text).trim();
  if (!bodyText) return { valid: false, reason: 'interactive_body_missing' };

  const buttons = interactive?.action?.buttons;
  if (!Array.isArray(buttons) || buttons.length === 0) return { valid: false, reason: 'interactive_buttons_missing' };

  const hasInvalidButton = buttons.some((button) => {
    const title = button?.reply?.title;
    const id = button?.reply?.id;
    return !isNonEmptyString(title) || !isNonEmptyString(id);
  });

  if (hasInvalidButton) return { valid: false, reason: 'interactive_button_invalid' };
  return { valid: true };
};

const validateInteractiveList = (interactive) => {
  const bodyText = normalizeTextBody(interactive?.body?.text).trim();
  if (!bodyText) return { valid: false, reason: 'interactive_body_missing' };

  const actionButton = normalizeTextBody(interactive?.action?.button).trim();
  if (!actionButton) return { valid: false, reason: 'interactive_action_button_missing' };

  const sections = interactive?.action?.sections;
  if (!Array.isArray(sections) || sections.length === 0) return { valid: false, reason: 'interactive_sections_missing' };

  const hasInvalidSection = sections.some((section) => {
    const rows = section?.rows;
    if (!Array.isArray(rows) || rows.length === 0) return true;
    return rows.some((row) => !isNonEmptyString(row?.id) || !isNonEmptyString(row?.title));
  });

  if (hasInvalidSection) return { valid: false, reason: 'interactive_section_row_invalid' };
  return { valid: true };
};

const validateOutboundPayload = (payload) => {
  if (!payload || typeof payload !== 'object') return { valid: false, reason: 'payload_missing' };

  if (payload.type === 'text') {
    const body = normalizeTextBody(payload.text?.body).trim();
    if (!body) return { valid: false, reason: 'empty_text_body' };
    if (body.length > MAX_TEXT_MESSAGE_LENGTH) return { valid: false, reason: 'text_too_long' };
    return { valid: true };
  }

  if (payload.type === 'interactive') {
    const interactive = payload.interactive || {};
    if (interactive.type === 'button') return validateInteractiveButtons(interactive);
    if (interactive.type === 'list') return validateInteractiveList(interactive);
    if (interactive.type === 'location_request_message') {
      const bodyText = normalizeTextBody(interactive?.body?.text).trim();
      return bodyText ? { valid: true } : { valid: false, reason: 'interactive_body_missing' };
    }
    return { valid: false, reason: 'interactive_type_unsupported' };
  }

  return { valid: true };
};

module.exports = {
  MAX_TEXT_MESSAGE_LENGTH,
  normalizeTextBody,
  summarizePayloadForStorage,
  validateOutboundPayload,
};

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateOutboundPayload,
  summarizePayloadForStorage,
} from '../backend/shared/infra/whatsappPayload.js';

test('validateOutboundPayload blocks empty text body', () => {
  const result = validateOutboundPayload({ type: 'text', text: { body: '   ' } });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'empty_text_body');
});

test('validateOutboundPayload blocks interactive list with missing row ids', () => {
  const result = validateOutboundPayload({
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: 'Choose one' },
      action: {
        button: 'Menu',
        sections: [{ title: 'Options', rows: [{ title: 'A' }] }],
      },
    },
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'interactive_section_row_invalid');
});

test('validateOutboundPayload allows valid interactive button payload', () => {
  const result = validateOutboundPayload({
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'Select one' },
      action: {
        buttons: [{ type: 'reply', reply: { id: 'id-1', title: 'Option' } }],
      },
    },
  });

  assert.equal(result.valid, true);
});

test('summarizePayloadForStorage returns safe defaults for media', () => {
  assert.equal(summarizePayloadForStorage({ type: 'audio', audio: { link: 'https://x' } }), '[Audio]');
  assert.equal(summarizePayloadForStorage({ type: 'image', image: { link: 'https://x' } }), '[Image]');
});

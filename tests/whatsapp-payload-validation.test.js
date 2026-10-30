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
  assert.equal(summarizePayloadForStorage({ type: 'template', template: { name: 'property_showcase' } }), '[Template: property_showcase]');
});

test('validateOutboundPayload allows valid WhatsApp template payload', () => {
  const result = validateOutboundPayload({
    type: 'template',
    template: {
      name: 'property_showcase_v1',
      language: { code: 'en' },
      components: [
        {
          type: 'body',
          parameters: [{ type: 'text', text: 'Villa 2' }]
        }
      ]
    }
  });
  assert.equal(result.valid, true);
});

import {
  matchKeywordRule,
  findMatchingKeywordNode,
  normalizeConversationalText,
  extractCoreTokens
} from '../backend/shared/infra/botTriggerMatcher.js';

test('Global keyword matching normalizer correctly matches variations of property triggers without false positives', () => {
  // Test variations of user asking for Property 2
  assert.equal(matchKeywordRule("send the property Number2", "property 2", "contains"), true);
  assert.equal(matchKeywordRule("Please share Property #2 details", "property 2", "contains"), true);
  assert.equal(matchKeywordRule("send the property Number2", "property number 2", "contains"), true);
  assert.equal(matchKeywordRule("property 2", "property 2", "exact"), true);
  assert.equal(matchKeywordRule("property #2", "property 2", "exact"), true);

  // Test False Positive Prevention:
  // User says "hi" -> MUST NOT match a node configured with "vehicle" (even though "veHIcle" has "hi")
  assert.equal(matchKeywordRule("hi", "vehicle", "contains"), false);
  assert.equal(matchKeywordRule("ok", "look", "contains"), false);
});

test('findMatchingKeywordNode evaluates priority order correctly', () => {
  const nodes = [
    {
      id: 'node-low-priority',
      data: {
        label: 'Low Priority Property 2',
        keywords: ['property 2'],
        keywordPriority: 10
      }
    },
    {
      id: 'node-high-priority',
      data: {
        label: 'High Priority Property 2 Showcase',
        keywords: ['property 2'],
        keywordPriority: 90
      }
    }
  ];

  const matched = findMatchingKeywordNode(nodes, "send the property Number2");
  assert.ok(matched);
  assert.equal(matched.id, 'node-high-priority');
});

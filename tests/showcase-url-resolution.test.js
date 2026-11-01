import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePublicAppOrigin } from '../server.ts';

test('Showcase URL: resolves origin dynamically from Cloudflare Worker x-forwarded-host header', () => {
  const req = {
    headers: {
      'x-forwarded-host': 'encho-whatsapp-lead-handler.enchoenterprises.workers.dev',
      'x-forwarded-proto': 'https',
    },
  };
  const origin = resolvePublicAppOrigin(req);
  assert.equal(origin, 'https://encho-whatsapp-lead-handler.enchoenterprises.workers.dev');
});

test('Showcase URL: resolves origin dynamically from request origin header', () => {
  const req = {
    headers: {
      origin: 'https://encho-whatsapp-lead-handler.enchoenterprises.workers.dev',
    },
  };
  const origin = resolvePublicAppOrigin(req);
  assert.equal(origin, 'https://encho-whatsapp-lead-handler.enchoenterprises.workers.dev');
});

test('Showcase URL: resolves origin dynamically from referer header', () => {
  const req = {
    headers: {
      referer: 'https://encho-whatsapp-lead-handler.enchoenterprises.workers.dev/media',
    },
  };
  const origin = resolvePublicAppOrigin(req);
  assert.equal(origin, 'https://encho-whatsapp-lead-handler.enchoenterprises.workers.dev');
});

test('Showcase URL: automatically sanitizes stale vercel.app references to canonical workers.dev domain', () => {
  const req = {
    headers: {
      'x-forwarded-host': 'encho-whatsapp-lead-handler.vercel.app',
      'x-forwarded-proto': 'https',
    },
  };
  const origin = resolvePublicAppOrigin(req);
  assert.equal(origin, 'https://encho-whatsapp-lead-handler.enchoenterprises.workers.dev');
});

test('Showcase URL: ignores internal onrender.com backend host and returns canonical workers.dev domain', () => {
  const req = {
    headers: {
      'x-forwarded-host': 'encho-enterprises-whatsapp-leads-handler-q7ac.onrender.com',
      'x-forwarded-proto': 'https',
    },
  };
  const origin = resolvePublicAppOrigin(req);
  assert.equal(origin, 'https://encho-whatsapp-lead-handler.enchoenterprises.workers.dev');
});

test('Showcase URL: fallback without request object returns canonical workers.dev domain', () => {
  const origin = resolvePublicAppOrigin();
  assert.equal(origin, 'https://encho-whatsapp-lead-handler.enchoenterprises.workers.dev');
});

import test from 'node:test';
import assert from 'node:assert/strict';

import handler from '../api/index.js';

test('vercel api entrypoint exports a request handler function', () => {
  assert.equal(typeof handler, 'function');
});

test('vercel api entrypoint can delegate requests to express app', async () => {
  const req = {
    method: 'GET',
    url: '/__non_existing_route__',
    headers: {},
  };

  let statusCode = null;
  let jsonPayload = null;

  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      jsonPayload = payload;
      return this;
    },
    setHeader() {
      return this;
    },
    getHeader() {
      return undefined;
    },
    end() {
      return this;
    }
  };

  await new Promise((resolve, reject) => {
    try {
      handler(req, res);
      setTimeout(resolve, 25);
    } catch (error) {
      reject(error);
    }
  });

  assert.equal(statusCode, 404);
  assert.deepEqual(jsonPayload, { error: 'Route not found' });
});

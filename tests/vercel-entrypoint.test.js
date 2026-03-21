const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const handler = require('../api/index');

test('vercel api entrypoint exports a request handler function', () => {
  assert.equal(typeof handler, 'function');
});

test('vercel api entrypoint can delegate requests to express app', async () => {
  const server = http.createServer((req, res) => handler(req, res));

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const response = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/__non_existing_route__',
        method: 'GET',
        headers: {
          accept: 'application/json',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );

    req.on('error', reject);
    req.end();
  });

  server.close();

  assert.equal(response.statusCode, 404);
  assert.equal(typeof response.body, 'string');
  assert.ok(response.body.length > 0);
});

'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { requireMutationToken, validateRequestOrigin } = require('../lib/api-security');

test('dashboard API accepts only loopback hosts and origins', () => {
  assert.equal(validateRequestOrigin({ headers: { host: '127.0.0.1:16300' } }), true);
  assert.equal(validateRequestOrigin({ headers: { host: 'localhost:16300', origin: 'http://localhost:16300' } }), true);
  assert.equal(validateRequestOrigin({ headers: { host: '192.168.1.20:16300' } }), false);
  assert.equal(validateRequestOrigin({ headers: { host: '127.0.0.1:16300', origin: 'https://example.com' } }), false);
});

test('mock API integration rejects untrusted writes and accepts its session token', async (t) => {
  const token = 'unit-test-session-token';
  const server = http.createServer((request, response) => {
    try {
      requireMutationToken(request, token, { port: server.address().port });
      response.writeHead(200).end('accepted');
    } catch (error) {
      response.writeHead(403).end(error.message);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;

  const rejected = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' });
  assert.equal(rejected.status, 403);
  assert.match(await rejected.text(), /token/i);

  const accepted = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'x-zedwatch-token': token },
  });
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), 'accepted');
});

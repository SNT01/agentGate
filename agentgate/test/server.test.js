'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Registry } = require('../src/registry/registry');
const { TokenBroker } = require('../src/broker/broker');
const { sign, randomId } = require('../src/shared/crypto');
const { tempDataDir, cleanup } = require('./helpers');

// The server reads admin config at module load, so set it before requiring.
process.env.AGENTGATE_ADMIN_TOKEN = 'test-admin-token-that-is-long-enough-x';
const { createServer } = require('../src/broker/server');
const ADMIN = process.env.AGENTGATE_ADMIN_TOKEN;

function request(port, { method = 'GET', path = '/', body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_e) {
            /* leave null */
          }
          resolve({ status: res.statusCode, body: json, text });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(fn) {
  const dir = tempDataDir('server');
  const registry = new Registry(dir);
  const broker = new TokenBroker(dir, { registry });
  const server = createServer(broker);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await fn({ port, registry, broker });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanup(dir);
  }
}

test('GET /health returns the broker public key without auth', async () => {
  await withServer(async ({ port, broker }) => {
    const res = await request(port, { path: '/health' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');
    assert.strictEqual(res.body.brokerPublicKey, broker.publicKey);
  });
});

test('POST /token grants a scoped token over HTTP', async () => {
  await withServer(async ({ port, registry }) => {
    const { humanId, privateKey } = registry.enrollHuman({ name: 'Alice', allowedContexts: ['office'] });
    const nonce = randomId('nonce');
    const timestamp = Date.now();
    const res = await request(port, {
      method: 'POST',
      path: '/token',
      body: {
        humanId,
        nonce,
        timestamp,
        humanSignature: sign({ humanId, nonce, timestamp }, privateKey),
        context: 'office',
      },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.granted, true);
    assert.ok(res.body.token.sessionId);
  });
});

test('POST /token returns 403 when the request is denied', async () => {
  await withServer(async ({ port, registry }) => {
    const { humanId, privateKey } = registry.enrollHuman({ name: 'Alice', allowedContexts: ['office'] });
    const nonce = randomId('nonce');
    const timestamp = Date.now();
    const res = await request(port, {
      method: 'POST',
      path: '/token',
      body: {
        humanId,
        nonce,
        timestamp,
        humanSignature: sign({ humanId, nonce, timestamp }, privateKey),
        context: 'home-network',
      },
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.granted, false);
  });
});

test('POST /token rejects invalid JSON with 400', async () => {
  await withServer(async ({ port }) => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/token', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        }
      );
      req.on('error', reject);
      req.write('{not valid json');
      req.end();
    });
    assert.strictEqual(res.status, 400);
  });
});

test('admin endpoints require the bearer token', async () => {
  await withServer(async ({ port }) => {
    const noAuth = await request(port, { path: '/audit' });
    assert.strictEqual(noAuth.status, 401);

    const wrongAuth = await request(port, { path: '/audit', headers: { Authorization: 'Bearer wrong-token' } });
    assert.strictEqual(wrongAuth.status, 401);

    const ok = await request(port, { path: '/audit', headers: { Authorization: `Bearer ${ADMIN}` } });
    assert.strictEqual(ok.status, 200);
    assert.ok(Array.isArray(ok.body.entries));
  });
});

test('GET /audit/verify reports chain integrity to an admin', async () => {
  await withServer(async ({ port }) => {
    const res = await request(port, { path: '/audit/verify', headers: { Authorization: `Bearer ${ADMIN}` } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.valid, true);
  });
});

test('unknown routes return 404', async () => {
  await withServer(async ({ port }) => {
    const res = await request(port, { path: '/nope' });
    assert.strictEqual(res.status, 404);
  });
});

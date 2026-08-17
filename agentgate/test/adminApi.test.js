'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Registry } = require('../src/registry/registry');
const { TokenBroker } = require('../src/broker/broker');
const { sign, randomId } = require('../src/shared/crypto');
const { tempDataDir, cleanup } = require('./helpers');

process.env.AGENTGATE_ADMIN_TOKEN = 'test-admin-token-that-is-long-enough-x';
process.env.AGENTGATE_UI_ENABLED = '1';
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
            /* leave null for non-JSON responses */
          }
          resolve({ status: res.statusCode, headers: res.headers, body: json, text });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(fn) {
  const dir = tempDataDir('admin-api');
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

function signedTokenRequest(humanId, privateKey, overrides = {}) {
  const nonce = randomId('nonce');
  const timestamp = Date.now();
  return {
    humanId,
    nonce,
    timestamp,
    humanSignature: sign({ humanId, nonce, timestamp }, privateKey),
    context: 'office',
    ...overrides,
  };
}

function auth(token = ADMIN) {
  return { Authorization: `Bearer ${token}` };
}

// --- /admin/identities ---

test('GET /admin/identities requires the admin bearer token', async () => {
  await withServer(async ({ port }) => {
    assert.strictEqual((await request(port, { path: '/admin/identities' })).status, 401);
    assert.strictEqual(
      (await request(port, { path: '/admin/identities', headers: auth('wrong') })).status,
      401
    );
  });
});

test('GET /admin/identities lists humans and agent cards', async () => {
  await withServer(async ({ port, registry }) => {
    const { humanId } = registry.enrollHuman({ name: 'Alice', allowedContexts: ['office'] });
    registry.issueAgentCard({
      sponsorId: humanId,
      tool: { name: 'claude-code', version: '2.4.0' },
      context: 'office',
      requestedCapabilities: { branches: ['feature/*'], actions: ['push'] },
    });

    const res = await request(port, { path: '/admin/identities', headers: auth() });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.humans.length, 1);
    assert.strictEqual(res.body.humans[0].name, 'Alice');
    assert.strictEqual(res.body.humans[0].revoked, false);
    assert.strictEqual(res.body.agents.length, 1);
    assert.strictEqual(res.body.agents[0].tool.name, 'claude-code');
  });
});

test('GET /admin/identities reflects revocation, including sponsor cascade', async () => {
  await withServer(async ({ port, registry }) => {
    const { humanId } = registry.enrollHuman({ name: 'Bob', allowedContexts: ['office'] });
    const { agentCardId } = registry.issueAgentCard({
      sponsorId: humanId,
      tool: { name: 'gemini-cli' },
      context: 'office',
      requestedCapabilities: { branches: ['feature/*'], actions: ['push'] },
    });
    registry.revoke(humanId, 'offboarded');

    const res = await request(port, { path: '/admin/identities', headers: auth() });
    const human = res.body.humans.find((h) => h.id === humanId);
    const agent = res.body.agents.find((a) => a.id === agentCardId);
    assert.strictEqual(human.revoked, true);
    assert.strictEqual(agent.revoked, true, 'sponsor revocation must cascade into the agent listing');
  });
});

test('GET /admin/identities never exposes a privateKey field', async () => {
  // Registry read paths never store private keys, but the endpoint must
  // stay safe even if a future field addition slipped one in — verified by
  // asserting on the raw response text, not just parsed keys.
  await withServer(async ({ port, registry }) => {
    registry.enrollHuman({ name: 'Carol', allowedContexts: ['office'] });
    const res = await request(port, { path: '/admin/identities', headers: auth() });
    assert.ok(!/privateKey/i.test(res.text));
  });
});

// --- /admin/sessions ---

test('GET /admin/sessions requires the admin bearer token', async () => {
  await withServer(async ({ port }) => {
    assert.strictEqual((await request(port, { path: '/admin/sessions' })).status, 401);
  });
});

test('GET /admin/sessions never returns a signature field', async (t) => {
  // This is the regression test that matters most in this file: a session's
  // signature is a live, usable credential (the git credential helper hands
  // it to GitHub as a password). Leaking it here would mean the dashboard
  // publishes working credentials over HTTP.
  await withServer(async ({ port, registry }) => {
    const { humanId, privateKey } = registry.enrollHuman({ name: 'Dave', allowedContexts: ['office'] });
    const grant = await request(port, {
      method: 'POST',
      path: '/token',
      body: signedTokenRequest(humanId, privateKey),
    });
    assert.strictEqual(grant.body.granted, true);
    const issuedSignature = grant.body.token.signature;
    assert.ok(issuedSignature, 'precondition: the issued token must actually carry a signature');

    const res = await request(port, { path: '/admin/sessions', headers: auth() });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.sessions.length, 1);
    // redact() replaces the field rather than deleting it — either way, the
    // real signature must never reach the response.
    assert.strictEqual(res.body.sessions[0].signature, '[redacted]');
    assert.ok(!res.text.includes(issuedSignature), 'the raw issued signature must not appear anywhere in the response');
  });
});

test('GET /admin/sessions reports scope and context for a live session', async () => {
  await withServer(async ({ port, registry }) => {
    const { humanId, privateKey } = registry.enrollHuman({
      name: 'Erin',
      allowedContexts: ['office'],
      capabilities: { branches: ['*'], actions: ['push', 'pr:open'] },
    });
    await request(port, { method: 'POST', path: '/token', body: signedTokenRequest(humanId, privateKey) });

    const res = await request(port, { path: '/admin/sessions', headers: auth() });
    assert.strictEqual(res.body.sessions[0].humanId, humanId);
    assert.strictEqual(res.body.sessions[0].context, 'office');
    assert.deepStrictEqual(res.body.sessions[0].scope.actions, ['push', 'pr:open']);
  });
});

// --- POST /admin/revoke ---

test('POST /admin/revoke requires the admin bearer token', async () => {
  await withServer(async ({ port }) => {
    const res = await request(port, { method: 'POST', path: '/admin/revoke', body: { id: 'human_x' } });
    assert.strictEqual(res.status, 401);
  });
});

test('POST /admin/revoke revokes an identity and cascades to sponsored agents', async () => {
  await withServer(async ({ port, registry }) => {
    const { humanId } = registry.enrollHuman({ name: 'Frank', allowedContexts: ['office'] });
    const { agentCardId } = registry.issueAgentCard({
      sponsorId: humanId,
      tool: { name: 'claude-code' },
      context: 'office',
      requestedCapabilities: { branches: ['feature/*'], actions: ['push'] },
    });

    const res = await request(port, {
      method: 'POST',
      path: '/admin/revoke',
      headers: auth(),
      body: { id: humanId, reason: 'left the company' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.revoked, humanId);
    assert.deepStrictEqual(res.body.cascadedTo, [agentCardId]);
    assert.strictEqual(registry.verifyAgentCard(agentCardId).valid, false);
  });
});

test('POST /admin/revoke records the action on the audit chain', async () => {
  // Revocation via the bare registry method leaves no audit trace; the
  // admin endpoint must not repeat that gap now that revoking is a button.
  await withServer(async ({ port, registry, broker }) => {
    const { humanId } = registry.enrollHuman({ name: 'Grace', allowedContexts: ['office'] });

    await request(port, {
      method: 'POST',
      path: '/admin/revoke',
      headers: auth(),
      body: { id: humanId, reason: 'rotated off the team' },
    });

    const entries = broker.audit.all();
    const revocationEntry = entries.find((e) => e.action === 'identity_revoked');
    assert.ok(revocationEntry, 'expected an identity_revoked entry on the audit chain');
    assert.strictEqual(revocationEntry.revokedId, humanId);
    assert.strictEqual(revocationEntry.reason, 'rotated off the team');
    assert.strictEqual(broker.audit.verifyChain(broker.publicKey).valid, true);
  });
});

test('POST /admin/revoke on an unknown identity returns 404, not 500', async () => {
  await withServer(async ({ port }) => {
    const res = await request(port, {
      method: 'POST',
      path: '/admin/revoke',
      headers: auth(),
      body: { id: 'human_does_not_exist' },
    });
    assert.strictEqual(res.status, 404);
  });
});

test('POST /admin/revoke without an id is rejected with 400', async () => {
  await withServer(async ({ port }) => {
    const res = await request(port, { method: 'POST', path: '/admin/revoke', headers: auth(), body: {} });
    assert.strictEqual(res.status, 400);
  });
});

// --- static dashboard assets ---

test('GET /ui returns 404 when the dashboard is disabled', async () => {
  const dir = tempDataDir('admin-api-ui-disabled');
  const registry = new Registry(dir);
  const broker = new TokenBroker(dir, { registry });
  const server = createServer(broker);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    process.env.AGENTGATE_UI_ENABLED = '0';
    const res = await request(port, { path: '/ui' });
    assert.strictEqual(res.status, 404);
  } finally {
    process.env.AGENTGATE_UI_ENABLED = '1';
    await new Promise((resolve) => server.close(resolve));
    cleanup(dir);
  }
});

/**
 * Both tests below must not depend on whether a real `ui/` build happens to
 * exist on disk at the default asset root — that is an environment detail,
 * not something a test should assert around. Point AGENTGATE_UI_ASSET_ROOT
 * at a location whose existence *this test* controls instead.
 */
async function withIsolatedAssetRoot(assetRoot, fn) {
  const saved = process.env.AGENTGATE_UI_ASSET_ROOT;
  process.env.AGENTGATE_UI_ASSET_ROOT = assetRoot;
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env.AGENTGATE_UI_ASSET_ROOT;
    else process.env.AGENTGATE_UI_ASSET_ROOT = saved;
  }
}

test('GET /ui explains how to build the dashboard when assets are missing', async () => {
  const missingRoot = require('path').join(require('os').tmpdir(), `agentgate-ui-missing-${randomId('x')}`);
  await withIsolatedAssetRoot(missingRoot, () =>
    withServer(async ({ port }) => {
      const res = await request(port, { path: '/ui' });
      assert.strictEqual(res.status, 503);
      assert.match(res.text, /npm run build/);
    })
  );
});

test('GET /ui serves the built dashboard when assets are present', async () => {
  const fs = require('fs');
  const path = require('path');
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'agentgate-ui-present-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>AgentGate</title>');
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log("ok")');

  try {
    await withIsolatedAssetRoot(root, () =>
      withServer(async ({ port }) => {
        const index = await request(port, { path: '/ui' });
        assert.strictEqual(index.status, 200);
        assert.strictEqual(index.headers['content-type'], 'text/html; charset=utf-8');
        assert.match(index.text, /AgentGate/);

        const asset = await request(port, { path: '/ui/assets/app.js' });
        assert.strictEqual(asset.status, 200);
        assert.strictEqual(asset.headers['content-type'], 'text/javascript; charset=utf-8');

        // Unknown client-side route (e.g. a reload on /ui/audit) must fall
        // back to index.html so the SPA router can take over.
        const clientRoute = await request(port, { path: '/ui/audit' });
        assert.strictEqual(clientRoute.status, 200);
        assert.match(clientRoute.text, /AgentGate/);
      })
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('GET /ui/../../ path traversal is refused even when assets exist', async () => {
  const fs = require('fs');
  const path = require('path');
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'agentgate-ui-traversal-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(path.dirname(root), 'secret-outside-root.txt'), 'top secret');

  try {
    await withIsolatedAssetRoot(root, () =>
      withServer(async ({ port }) => {
        const res = await request(port, { path: '/ui/..%2fsecret-outside-root.txt' });
        assert.strictEqual(res.status, 404);
        assert.ok(!res.text.includes('top secret'), 'must never read a file outside the asset root');
      })
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(root), 'secret-outside-root.txt'), { force: true });
  }
});

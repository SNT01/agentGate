'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { TokenBroker } = require('../src/broker/broker');
const { Registry } = require('../src/registry/registry');
const { sign, randomId } = require('../src/shared/crypto');
const { tempDataDir, cleanup } = require('./helpers');

function setup() {
  const dir = tempDataDir('broker');
  const registry = new Registry(dir);
  const broker = new TokenBroker(dir, { registry });
  const { humanId, privateKey } = registry.enrollHuman({
    name: 'Alice',
    allowedContexts: ['office'],
    capabilities: { branches: ['*'], actions: ['push', 'pr:open', 'pr:comment', 'pr:approve'] },
  });
  const { agentCardId, privateKey: agentKey } = registry.issueAgentCard({
    sponsorId: humanId,
    tool: { name: 'claude-code', version: '2.4.0' },
    context: 'office',
    requestedCapabilities: { branches: ['feature/*'], actions: ['push', 'pr:open', 'pr:comment'] },
  });
  return { dir, registry, broker, humanId, privateKey, agentCardId, agentKey };
}

function signedRequest(humanId, privateKey, overrides = {}) {
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

test('a valid office request is granted and scoped to the intersection', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));

  const result = s.broker.requestToken(signedRequest(s.humanId, s.privateKey, { agentCardId: s.agentCardId }));
  assert.strictEqual(result.granted, true);
  assert.deepStrictEqual(result.token.scope.branches, ['feature/*']);
  assert.ok(!result.token.scope.actions.includes('pr:approve'), 'agent must not receive approve rights');
});

test('replaying a captured request is rejected', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));

  const req = signedRequest(s.humanId, s.privateKey, { agentCardId: s.agentCardId });
  assert.strictEqual(s.broker.requestToken(req).granted, true);

  const replay = s.broker.requestToken(req);
  assert.strictEqual(replay.granted, false, 'the identical request must not succeed twice');
  assert.match(replay.reason, /replay/i);
});

test('a stale request is rejected even with a valid signature', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));

  const stale = signedRequest(s.humanId, s.privateKey, { timestamp: Date.now() - 60 * 60 * 1000 });
  // Re-sign so the signature matches the stale timestamp.
  stale.humanSignature = sign(
    { humanId: s.humanId, nonce: stale.nonce, timestamp: stale.timestamp },
    s.privateKey
  );
  const result = s.broker.requestToken(stale);
  assert.strictEqual(result.granted, false);
  assert.match(result.reason, /too old/i);
});

test('an off-network context is denied', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));

  const result = s.broker.requestToken(
    signedRequest(s.humanId, s.privateKey, { agentCardId: s.agentCardId, context: 'home-network' })
  );
  assert.strictEqual(result.granted, false);
  assert.match(result.reason, /posture/i);
});

test('a forged signature is rejected', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));

  const req = signedRequest(s.humanId, s.privateKey);
  req.humanSignature = Buffer.from('not-a-real-signature').toString('base64');
  const result = s.broker.requestToken(req);
  assert.strictEqual(result.granted, false);
  assert.match(result.reason, /signature/i);
});

test('an agent card presented by the wrong human is rejected', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));

  const other = s.registry.enrollHuman({ name: 'Mallory', allowedContexts: ['office'] });
  const result = s.broker.requestToken(
    signedRequest(other.humanId, other.privateKey, { agentCardId: s.agentCardId })
  );
  assert.strictEqual(result.granted, false);
  assert.match(result.reason, /sponsor mismatch/i);
});

test('requests are denied after the sponsor is revoked', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));

  s.registry.revoke(s.humanId, 'offboarded');
  const result = s.broker.requestToken(signedRequest(s.humanId, s.privateKey, { agentCardId: s.agentCardId }));
  assert.strictEqual(result.granted, false);
  assert.match(result.reason, /revoked/i);
});

test('malformed requests are rejected without crashing', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));

  for (const bad of [undefined, null, {}, { humanId: 123 }, { humanId: 'x', humanSignature: 'y' }]) {
    const result = s.broker.requestToken(bad);
    assert.strictEqual(result.granted, false);
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
  }
});

test('an issued token verifies, and stops verifying once the holder is revoked', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));

  const { token } = s.broker.requestToken(signedRequest(s.humanId, s.privateKey));
  assert.strictEqual(s.broker.verifySessionToken(token).valid, true);

  s.registry.revoke(s.humanId, 'offboarded');
  const after = s.broker.verifySessionToken(token);
  assert.strictEqual(after.valid, false, 'a live token must stop working when its holder is revoked');
});

test('every decision, granted or denied, lands in the audit chain', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));

  s.broker.requestToken(signedRequest(s.humanId, s.privateKey));
  s.broker.requestToken(signedRequest(s.humanId, s.privateKey, { context: 'home' }));

  const entries = s.broker.audit.all();
  assert.ok(entries.some((e) => e.outcome === 'granted'));
  assert.ok(entries.some((e) => e.outcome === 'denied'));
  assert.strictEqual(s.broker.audit.verifyChain(s.broker.publicKey).valid, true);
});

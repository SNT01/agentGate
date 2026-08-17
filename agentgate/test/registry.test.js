'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Registry } = require('../src/registry/registry');
const { tempDataDir, cleanup } = require('./helpers');

function newRegistry() {
  const dir = tempDataDir('registry');
  return { registry: new Registry(dir), dir };
}

test('an enrolled human can be looked up and verifies their own signature', (t) => {
  const { registry, dir } = newRegistry();
  t.after(() => cleanup(dir));

  const { humanId, privateKey } = registry.enrollHuman({ name: 'Alice' });
  const human = registry.getHuman(humanId);
  assert.strictEqual(human.name, 'Alice');

  const { sign } = require('../src/shared/crypto');
  const payload = { humanId, nonce: 'nonce_1', timestamp: Date.now() };
  assert.strictEqual(registry.verifyHumanSignature(humanId, payload, sign(payload, privateKey)), true);
});

test("an agent card cannot exceed its sponsor's capabilities", (t) => {
  const { registry, dir } = newRegistry();
  t.after(() => cleanup(dir));

  const { humanId } = registry.enrollHuman({
    name: 'Bob',
    capabilities: { branches: ['feature/*'], actions: ['push', 'pr:open'] },
  });
  const { card } = registry.issueAgentCard({
    sponsorId: humanId,
    tool: { name: 'claude-code', version: '2.4.0' },
    context: 'office',
    // Ask for more than the sponsor holds: merge rights and all branches.
    requestedCapabilities: { branches: ['feature/*', 'main'], actions: ['push', 'pr:open', 'pr:merge'] },
  });

  assert.deepStrictEqual(card.capabilities.branches, ['feature/*'], 'must not gain a branch the sponsor lacks');
  assert.ok(!card.capabilities.actions.includes('pr:merge'), 'must not gain an action the sponsor lacks');
});

test('an agent card verifies, and fails once its signature is tampered with', (t) => {
  const { registry, dir } = newRegistry();
  t.after(() => cleanup(dir));

  const { humanId } = registry.enrollHuman({ name: 'Carol' });
  const { agentCardId, card } = registry.issueAgentCard({
    sponsorId: humanId,
    tool: { name: 'gemini-cli', version: '1.0.0' },
    context: 'office',
    requestedCapabilities: { branches: ['feature/*'], actions: ['push'] },
  });

  assert.strictEqual(registry.verifyAgentCard(agentCardId).valid, true);

  const forged = { ...card, capabilities: { branches: ['*'], actions: ['push', 'pr:merge'] } };
  const result = registry.verifyAgentCard(forged);
  assert.strictEqual(result.valid, false, 'a widened capability set must not verify');
  assert.match(result.reason, /signature/i);
});

test('revoking a sponsor cascades to every card they sponsor', (t) => {
  const { registry, dir } = newRegistry();
  t.after(() => cleanup(dir));

  const { humanId } = registry.enrollHuman({ name: 'Dave' });
  const a1 = registry.issueAgentCard({
    sponsorId: humanId,
    tool: { name: 'claude-code' },
    context: 'office',
    requestedCapabilities: { branches: ['feature/*'], actions: ['push'] },
  });
  const a2 = registry.issueAgentCard({
    sponsorId: humanId,
    tool: { name: 'codex' },
    context: 'office',
    requestedCapabilities: { branches: ['feature/*'], actions: ['push'] },
  });

  const result = registry.revoke(humanId, 'left the company');
  assert.strictEqual(result.cascadedTo.length, 2);
  assert.strictEqual(registry.verifyAgentCard(a1.agentCardId).valid, false);
  assert.strictEqual(registry.verifyAgentCard(a2.agentCardId).valid, false);
});

test('an expired agent card does not verify', (t) => {
  const { registry, dir } = newRegistry();
  t.after(() => cleanup(dir));

  const { humanId } = registry.enrollHuman({ name: 'Erin' });
  const { agentCardId } = registry.issueAgentCard({
    sponsorId: humanId,
    tool: { name: 'claude-code' },
    context: 'office',
    requestedCapabilities: { branches: ['feature/*'], actions: ['push'] },
    ttlMs: -1000, // already expired
  });
  const result = registry.verifyAgentCard(agentCardId);
  assert.strictEqual(result.valid, false);
  assert.match(result.reason, /expired/i);
});

test('an agent cannot be issued for a context its sponsor lacks', (t) => {
  const { registry, dir } = newRegistry();
  t.after(() => cleanup(dir));

  const { humanId } = registry.enrollHuman({ name: 'Frank', allowedContexts: ['office'] });
  assert.throws(
    () =>
      registry.issueAgentCard({
        sponsorId: humanId,
        tool: { name: 'claude-code' },
        context: 'home',
        requestedCapabilities: { branches: ['feature/*'], actions: ['push'] },
      }),
    /context/i
  );
});

test('invalid input is rejected with a clear error', (t) => {
  const { registry, dir } = newRegistry();
  t.after(() => cleanup(dir));

  assert.throws(() => registry.enrollHuman({ name: '' }), /name/i);
  assert.throws(
    () => registry.enrollHuman({ name: 'X', capabilities: { branches: ['*'], actions: ['delete-everything'] } }),
    /unknown action/i
  );
  assert.throws(() => registry.revoke('human_does_not_exist'), /unknown identity/i);
});

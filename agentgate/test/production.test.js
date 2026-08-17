'use strict';
/**
 * Production-mode invariants. These guard the deployment path exercised by
 * scripts/e2e-docker.sh: keys are generated client-side and only public
 * keys are ever registered.
 */
const test = require('node:test');
const assert = require('node:assert');
const { generateKeyPair, sign } = require('../src/shared/crypto');
const { assertProductionSafe } = require('../src/shared/config');
const { tempDataDir, cleanup } = require('./helpers');

/** Run `fn` with NODE_ENV=production and a fresh require of the registry. */
function inProduction(env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, { NODE_ENV: 'production' }, env);
  // Config reads process.env lazily, but Registry caches nothing, so a
  // fresh instance is enough — no module cache surgery required.
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
}

test('production refuses to start without an admin token', () => {
  inProduction({ AGENTGATE_ADMIN_TOKEN: '' }, () => {
    assert.throws(() => assertProductionSafe(), /ADMIN_TOKEN must be set/i);
  });
});

test('production refuses a short admin token', () => {
  inProduction({ AGENTGATE_ADMIN_TOKEN: 'too-short' }, () => {
    assert.throws(() => assertProductionSafe(), /at least 32 characters/i);
  });
});

test('production refuses an over-long token lifetime', () => {
  inProduction(
    { AGENTGATE_ADMIN_TOKEN: 'a'.repeat(40), AGENTGATE_TOKEN_TTL_MS: String(2 * 60 * 60 * 1000) },
    () => {
      assert.throws(() => assertProductionSafe(), /exceeds 1 hour/i);
    }
  );
});

test('production requires explicit confirmation to bind publicly', () => {
  inProduction({ AGENTGATE_ADMIN_TOKEN: 'a'.repeat(40), AGENTGATE_BROKER_HOST: '0.0.0.0' }, () => {
    assert.throws(() => assertProductionSafe(), /ALLOW_PUBLIC_BIND/i);
  });
  inProduction(
    {
      AGENTGATE_ADMIN_TOKEN: 'a'.repeat(40),
      AGENTGATE_BROKER_HOST: '0.0.0.0',
      AGENTGATE_ALLOW_PUBLIC_BIND: '1',
    },
    () => {
      assert.doesNotThrow(() => assertProductionSafe());
    }
  );
});

test('a valid production configuration is accepted', () => {
  inProduction({ AGENTGATE_ADMIN_TOKEN: 'a'.repeat(40) }, () => {
    assert.doesNotThrow(() => assertProductionSafe());
  });
});

test('production refuses to generate keys server-side, but accepts a public key', (t) => {
  const dir = tempDataDir('production');
  t.after(() => cleanup(dir));

  inProduction({ AGENTGATE_ADMIN_TOKEN: 'a'.repeat(40) }, () => {
    const { Registry } = require('../src/registry/registry');
    const registry = new Registry(dir);

    assert.throws(() => registry.enrollHuman({ name: 'Alice' }), /requires a publicKey/i);

    // The supported path: the client generates the keypair and registers
    // only the public half.
    const keys = generateKeyPair();
    const { humanId, privateKey } = registry.enrollHuman({ name: 'Alice', publicKey: keys.publicKey });
    assert.ok(humanId);
    assert.strictEqual(privateKey, undefined, 'the server must not return a private key');

    // The client's retained private key still authenticates.
    const payload = { humanId, nonce: 'nonce_abcdefgh', timestamp: Date.now() };
    assert.strictEqual(
      registry.verifyHumanSignature(humanId, payload, sign(payload, keys.privateKey)),
      true
    );

    // Agent cards follow the same rule.
    assert.throws(
      () =>
        registry.issueAgentCard({
          sponsorId: humanId,
          tool: { name: 'claude-code' },
          context: 'office',
          requestedCapabilities: { branches: ['feature/*'], actions: ['push'] },
        }),
      /requires a publicKey/i
    );

    const agentKeys = generateKeyPair();
    const issued = registry.issueAgentCard({
      sponsorId: humanId,
      tool: { name: 'claude-code' },
      context: 'office',
      requestedCapabilities: { branches: ['feature/*'], actions: ['push'] },
      publicKey: agentKeys.publicKey,
    });
    assert.ok(issued.agentCardId);
    assert.strictEqual(issued.privateKey, undefined, 'the server must not return an agent private key');
  });
});

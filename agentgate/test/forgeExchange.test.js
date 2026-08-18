'use strict';
/**
 * The forge exchange: turning an authorization decision into a credential
 * GitHub will actually accept.
 *
 * The mint function is injected through the constructor — the suite has no
 * mocking library and no require interception, and `options.registry`
 * already establishes the pattern. Every test here runs with no GitHub
 * credentials and no network.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { TokenBroker, resolveForgeRepositories } = require('../src/broker/broker');
const { Registry } = require('../src/registry/registry');
const { sign, randomId } = require('../src/shared/crypto');
const { tempDataDir, cleanup } = require('./helpers');

const MINTED = 'ghs_exampleinstallationtoken';

function setup(options = {}) {
  const dir = tempDataDir('forge');
  const registry = new Registry(dir);
  const broker = new TokenBroker(dir, { registry, ...options });
  const { humanId, privateKey } = registry.enrollHuman({
    name: 'Alice',
    allowedContexts: ['office'],
    capabilities: { branches: ['*'], actions: ['push', 'pr:open', 'pr:comment', 'pr:approve'] },
  });
  const { agentCardId } = registry.issueAgentCard({
    sponsorId: humanId,
    tool: { name: 'claude-code', version: '2.4.0' },
    context: 'office',
    requestedCapabilities: { branches: ['feature/*'], actions: ['push', 'pr:open'] },
  });
  return { dir, registry, broker, humanId, privateKey, agentCardId };
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
    repository: 'yourorg/api',
    ...overrides,
  };
}

/** A mint that records what it was asked for and succeeds. */
function recordingMint(calls) {
  return async (params) => {
    calls.push(params);
    return {
      token: MINTED,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      permissions: { metadata: 'read', contents: 'write' },
    };
  };
}

/** Run `fn` with AGENTGATE_GITHUB_OWNER set, restoring it afterwards. */
function withOwner(owner, fn) {
  const saved = process.env.AGENTGATE_GITHUB_OWNER;
  if (owner === null) delete process.env.AGENTGATE_GITHUB_OWNER;
  else process.env.AGENTGATE_GITHUB_OWNER = owner;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.AGENTGATE_GITHUB_OWNER;
    else process.env.AGENTGATE_GITHUB_OWNER = saved;
  }
}

test('the session token still verifies once a forge credential is attached', async (t) => {
  const s = setup({ mintForgeToken: recordingMint([]) });
  t.after(() => cleanup(s.dir));

  const result = await s.broker.requestTokenWithForgeCredential(signedRequest(s.humanId, s.privateKey));
  assert.strictEqual(result.granted, true);
  // The regression guard: the broker signs every field of `token` except the
  // signature itself, so a forge credential placed *inside* `token` would
  // silently invalidate every session token in flight.
  assert.strictEqual(s.broker.verifySessionToken(result.token).valid, true);
  assert.ok(!('git' in result.token), 'the forge credential must be a sibling of token, never a field in it');
});

test('mint receives bare repository names and the already-intersected scope', async (t) => {
  const calls = [];
  const s = setup({ mintForgeToken: recordingMint(calls) });
  t.after(() => cleanup(s.dir));

  const result = await s.broker.requestTokenWithForgeCredential(
    signedRequest(s.humanId, s.privateKey, { agentCardId: s.agentCardId })
  );
  assert.strictEqual(result.granted, true);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].repositories, ['api'], 'octokit wants bare names, not owner/name');
  assert.deepStrictEqual(calls[0].scope.branches, ['feature/*']);
  assert.ok(!calls[0].scope.actions.includes('pr:approve'), 'the exchange must never widen the granted scope');
  assert.strictEqual(result.git.password, MINTED);
  assert.strictEqual(result.git.username, 'x-access-token');
});

test('with no forge configured the result is identical to a plain requestToken', async (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));

  const plain = s.broker.requestToken(signedRequest(s.humanId, s.privateKey));
  const viaForge = await s.broker.requestTokenWithForgeCredential(signedRequest(s.humanId, s.privateKey));
  assert.strictEqual(viaForge.granted, true);
  assert.ok(!('git' in viaForge), 'an unconfigured broker must behave exactly as it did before the exchange existed');
  assert.deepStrictEqual(Object.keys(viaForge).sort(), Object.keys(plain).sort());
});

test('a policy denial never reaches the mint', async (t) => {
  const calls = [];
  const s = setup({ mintForgeToken: recordingMint(calls) });
  t.after(() => cleanup(s.dir));

  const result = await s.broker.requestTokenWithForgeCredential(
    signedRequest(s.humanId, s.privateKey, { context: 'home-network' })
  );
  assert.strictEqual(result.granted, false);
  assert.strictEqual(calls.length, 0, 'authorization must fail before any credential is minted');
});

test('a failing mint denies, drops the session, and leaves the audit chain valid', async (t) => {
  const s = setup({
    mintForgeToken: async () => {
      throw Object.assign(new Error('nope'), { status: 404 });
    },
  });
  t.after(() => cleanup(s.dir));

  const result = await s.broker.requestTokenWithForgeCredential(signedRequest(s.humanId, s.privateKey));
  assert.strictEqual(result.granted, false, 'a mint failure must arrive as a denial, not a thrown 500');
  assert.match(result.reason, /404/);

  const sessions = JSON.parse(fs.readFileSync(path.join(s.dir, 'sessions.json'), 'utf8'));
  assert.deepStrictEqual(sessions, {}, 'a live session with no usable credential would lie to the enforcer');

  const actions = s.broker.audit.all().map((e) => e.action);
  // Both entries stand: the chain is tamper-evident by construction, so the
  // true sequence is the correct history — the earlier grant is not rewritten.
  assert.ok(actions.includes('token_issued'));
  assert.ok(actions.includes('forge_exchange_failed'));
  assert.strictEqual(s.broker.audit.verifyChain(s.broker.publicKey).valid, true);
});

test('an owner mismatch denies without calling the mint', async (t) => {
  const calls = [];
  const s = setup({ mintForgeToken: recordingMint(calls) });
  t.after(() => cleanup(s.dir));

  const result = await withOwner('yourorg', () =>
    s.broker.requestTokenWithForgeCredential(signedRequest(s.humanId, s.privateKey, { repository: 'attacker/api' }))
  );
  assert.strictEqual(result.granted, false);
  assert.match(result.reason, /installation owner/);
  // Bare names resolve against the installation's account, so minting here
  // would have produced a token for yourorg/api on an attacker's request.
  assert.strictEqual(calls.length, 0);
});

test('a missing repository names the git option that supplies it', async (t) => {
  const s = setup({ mintForgeToken: recordingMint([]) });
  t.after(() => cleanup(s.dir));

  const saved = process.env.AGENTGATE_REPOSITORY;
  delete process.env.AGENTGATE_REPOSITORY;
  try {
    const result = await s.broker.requestTokenWithForgeCredential(
      signedRequest(s.humanId, s.privateKey, { repository: null })
    );
    assert.strictEqual(result.granted, false);
    assert.match(result.reason, /useHttpPath/);
  } finally {
    if (saved !== undefined) process.env.AGENTGATE_REPOSITORY = saved;
  }
});

test('the minted credential reaches neither sessions.json nor audit.json', async (t) => {
  const s = setup({ mintForgeToken: recordingMint([]) });
  t.after(() => cleanup(s.dir));

  const result = await s.broker.requestTokenWithForgeCredential(signedRequest(s.humanId, s.privateKey));
  assert.strictEqual(result.git.password, MINTED);

  for (const file of ['sessions.json', 'audit.json']) {
    const text = fs.readFileSync(path.join(s.dir, file), 'utf8');
    assert.ok(!text.includes(MINTED), `${file} must never contain a forge credential`);
  }
  // The success path is still auditable — just without the secret.
  const entry = s.broker.audit.all().find((e) => e.action === 'forge_token_issued');
  assert.ok(entry, 'a successful exchange must be recorded');
  assert.strictEqual(entry.repository, 'yourorg/api');
  assert.ok(entry.forgeExpiresAt, 'the forge expiry outlives the session and must be visible');
  assert.deepStrictEqual(entry.branchScope, ['*']);
});

test('a stalled forge API becomes a denial rather than a hung push', async (t) => {
  const saved = process.env.AGENTGATE_GITHUB_MINT_TIMEOUT_MS;
  process.env.AGENTGATE_GITHUB_MINT_TIMEOUT_MS = '50';
  const s = setup({ mintForgeToken: () => new Promise(() => {}) });
  t.after(() => {
    cleanup(s.dir);
    if (saved === undefined) delete process.env.AGENTGATE_GITHUB_MINT_TIMEOUT_MS;
    else process.env.AGENTGATE_GITHUB_MINT_TIMEOUT_MS = saved;
  });

  const result = await s.broker.requestTokenWithForgeCredential(signedRequest(s.humanId, s.privateKey));
  assert.strictEqual(result.granted, false);
  assert.match(result.reason, /timed out|unreachable/i);
});

test('resolveForgeRepositories rejects paths that are not owner/name', () => {
  withOwner(null, () => {
    assert.deepStrictEqual(resolveForgeRepositories({ repository: 'owner/repo.git' }).repositories, ['repo']);
    assert.deepStrictEqual(resolveForgeRepositories({ repository: '/owner/repo' }).repository, 'owner/repo');
    assert.throws(() => resolveForgeRepositories({ repository: 'justaname' }), /owner\/name/);
    assert.throws(() => resolveForgeRepositories({ repository: '../../etc/passwd' }), /does not allow|owner\/name/);
  });
  // GitHub logins are case-insensitive, so a case difference is legitimate.
  withOwner('YourOrg', () => {
    assert.deepStrictEqual(resolveForgeRepositories({ repository: 'yourorg/api' }).repositories, ['api']);
  });
});

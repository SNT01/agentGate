'use strict';
/**
 * Capability profiles and per-repository ceilings.
 *
 * The repository half of this file is the third stage of the documented chain
 * `sponsor → agent card → repo policy → issued token`, which until now did not
 * exist: `repoPolicy` reached the broker only in the body of the untrusted
 * `POST /token` request, and nothing ever sent one. So these tests care most
 * about two things — that a configured ceiling actually narrows a real issued
 * token, and that no way of writing the file can *widen* one.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { PolicyStore } = require('../src/shared/policyStore');
const { TokenBroker } = require('../src/broker/broker');
const { Registry } = require('../src/registry/registry');
const { intersectCapabilities } = require('../src/shared/capability');
const { sign, randomId } = require('../src/shared/crypto');
const { tempDataDir, cleanup } = require('./helpers');

function withPolicies(t, policies) {
  const dir = tempDataDir('policy');
  t.after(() => cleanup(dir));
  fs.writeFileSync(path.join(dir, 'policies.json'), JSON.stringify(policies, null, 2));
  return { dir, store: new PolicyStore(dir) };
}

test('no policies file at all leaves behaviour unchanged', (t) => {
  const dir = tempDataDir('policy-none');
  t.after(() => cleanup(dir));
  const store = new PolicyStore(dir);

  assert.strictEqual(store.repositoryPolicy('acme/api'), null);
  assert.strictEqual(store.profile('anything'), null);
  assert.deepStrictEqual(store.validate(), []);
});

test('an exact repository match becomes the ceiling', (t) => {
  const { store } = withPolicies(t, {
    repositories: { 'acme/payments': { branches: ['feature/*'], actions: ['push'] } },
  });

  const policy = store.repositoryPolicy('acme/payments');
  assert.deepStrictEqual(policy.branches, ['feature/*']);
  assert.deepStrictEqual(policy.actions, ['push']);
  assert.strictEqual(store.repositoryPolicy('acme/other'), null, 'an unmatched repository has no ceiling');
});

test('every matching rule applies, so a broad rule cannot loosen a specific one', (t) => {
  const { store } = withPolicies(t, {
    repositories: {
      'acme/*': { actions: ['push', 'pr:open', 'pr:comment'] },
      'acme/payments': { branches: ['feature/*'], actions: ['push'] },
    },
  });

  // Intersection rather than precedence: adding rules can only ever mean less
  // authority, so there is no ordering question to get wrong.
  const policy = store.repositoryPolicy('acme/payments');
  assert.deepStrictEqual(policy.actions, ['push']);
  assert.deepStrictEqual(policy.branches, ['feature/*']);
});

test('an omitted field imposes no restriction rather than denying everything', (t) => {
  const { store } = withPolicies(t, {
    repositories: { 'acme/*': { actions: ['push'] } },
  });

  // The bug this guards: a missing field left absent makes narrowField see an
  // empty concrete list and intersect every branch away, so a policy naming
  // only `actions` silently granted nothing at all.
  const policy = store.repositoryPolicy('acme/website');
  assert.deepStrictEqual(policy.branches, ['*'], 'branches must be unrestricted, not empty');

  const scope = intersectCapabilities({ branches: ['*'], actions: ['push', 'pr:open'] }, policy);
  assert.deepStrictEqual(scope.branches, ['*']);
  assert.deepStrictEqual(scope.actions, ['push']);
});

test('a wildcard owner matches every repository under it', (t) => {
  const { store } = withPolicies(t, {
    repositories: { 'acme/*': { actions: ['push'] } },
  });
  assert.ok(store.repositoryPolicy('acme/anything'));
  assert.strictEqual(store.repositoryPolicy('other/anything'), null);
});

test('a configured ceiling narrows a real issued token', (t) => {
  const { dir } = withPolicies(t, {
    repositories: { 'acme/payments': { branches: ['feature/*'], actions: ['push'] } },
  });

  const registry = new Registry(dir);
  const { humanId, privateKey } = registry.enrollHuman({
    name: 'Alice',
    allowedContexts: ['office'],
    capabilities: { branches: ['*'], actions: ['push', 'pr:open', 'pr:approve'] },
  });
  const broker = new TokenBroker(dir, { registry });

  const ask = (repository) => {
    const nonce = randomId('nonce');
    const timestamp = Date.now();
    return broker.requestToken({
      humanId,
      nonce,
      timestamp,
      context: 'office',
      repository,
      humanSignature: sign({ humanId, nonce, timestamp }, privateKey),
    });
  };

  const constrained = ask('acme/payments');
  assert.strictEqual(constrained.granted, true);
  assert.deepStrictEqual(constrained.token.scope.actions, ['push'], 'pr:open and pr:approve must be dropped');
  assert.deepStrictEqual(constrained.token.scope.branches, ['feature/*']);

  const unconstrained = ask('other/repo');
  assert.strictEqual(unconstrained.granted, true);
  assert.deepStrictEqual(unconstrained.token.scope.actions, ['push', 'pr:open', 'pr:approve']);

  assert.strictEqual(broker.audit.verifyChain(broker.publicKey).valid, true);
});

test('a repository policy can never widen a card', (t) => {
  const { dir } = withPolicies(t, {
    // A policy naming more than the card holds must not grant it.
    repositories: { 'acme/api': { actions: ['push', 'pr:approve', 'pr:merge'] } },
  });

  const registry = new Registry(dir);
  const { humanId, privateKey } = registry.enrollHuman({
    name: 'Bob',
    allowedContexts: ['office'],
    capabilities: { branches: ['feature/*'], actions: ['push'] },
  });
  const broker = new TokenBroker(dir, { registry });

  const nonce = randomId('nonce');
  const timestamp = Date.now();
  const result = broker.requestToken({
    humanId,
    nonce,
    timestamp,
    context: 'office',
    repository: 'acme/api',
    humanSignature: sign({ humanId, nonce, timestamp }, privateKey),
  });

  assert.strictEqual(result.granted, true);
  assert.deepStrictEqual(result.token.scope.actions, ['push'], 'the policy must not add authority');
  assert.deepStrictEqual(result.token.scope.branches, ['feature/*']);
});

test('an unreadable policy file denies rather than granting an unbounded token', (t) => {
  const dir = tempDataDir('policy-corrupt');
  t.after(() => cleanup(dir));
  fs.writeFileSync(path.join(dir, 'policies.json'), '{ not json at all');

  const registry = new Registry(dir);
  const { humanId, privateKey } = registry.enrollHuman({
    name: 'Carol',
    allowedContexts: ['office'],
    capabilities: { branches: ['*'], actions: ['push'] },
  });
  const broker = new TokenBroker(dir, { registry });

  const nonce = randomId('nonce');
  const timestamp = Date.now();
  const result = broker.requestToken({
    humanId,
    nonce,
    timestamp,
    context: 'office',
    repository: 'acme/api',
    humanSignature: sign({ humanId, nonce, timestamp }, privateKey),
  });

  // Failing open here would issue a token broader than anything the operator
  // wrote down, which is the opposite of what this stage is for.
  assert.strictEqual(result.granted, false);
  assert.match(result.reason, /empty capability intersection/i);
});

// --- profiles ---------------------------------------------------------------

test('a profile supplies capabilities, context, and TTL', (t) => {
  const { store } = withPolicies(t, {
    profiles: { 'ci-agent': { branches: ['ci/*'], actions: ['push'], context: 'ci', cardTtlDays: 7 } },
  });

  const profile = store.profile('ci-agent');
  assert.deepStrictEqual(profile.branches, ['ci/*']);
  assert.strictEqual(profile.context, 'ci');
  assert.strictEqual(profile.cardTtlDays, 7);
  assert.deepStrictEqual(store.profileNames(), ['ci-agent']);
});

test('validate reports what is wrong, naming the entry', (t) => {
  const { store } = withPolicies(t, {
    profiles: {
      incomplete: { actions: ['push'] }, // a profile must be complete
      bogus: { branches: ['x'], actions: ['deploy'] }, // not a real action
      'bad-ttl': { branches: ['x'], actions: ['push'], cardTtlDays: 0 },
    },
    repositories: {
      'no-slash': { actions: ['push'] },
      'acme/api': { actions: ['teleport'] },
    },
  });

  const problems = store.validate();
  assert.ok(problems.some((p) => /profile "incomplete".*branches is required/.test(p)), problems.join('; '));
  assert.ok(problems.some((p) => /profile "bogus".*unknown action "deploy"/.test(p)));
  assert.ok(problems.some((p) => /bad-ttl.*cardTtlDays/.test(p)));
  assert.ok(problems.some((p) => /no-slash.*owner\/name/.test(p)));
  assert.ok(problems.some((p) => /acme\/api.*unknown action "teleport"/.test(p)));
});

test('a repository policy may omit fields without being invalid', (t) => {
  const { store } = withPolicies(t, {
    repositories: { 'acme/*': { actions: ['push'] } },
  });
  // Unlike a profile, a ceiling is allowed to constrain only one dimension.
  assert.deepStrictEqual(store.validate(), []);
});

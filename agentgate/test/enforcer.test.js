'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Registry } = require('../src/registry/registry');
const { verifyCommit, verifyPullRequest } = require('../src/enforcer/verify');
const { evaluateReview } = require('../src/enforcer/reviewGate');
const { parseTrailers, mapGitHubCommit } = require('../src/enforcer/githubApp');
const { sign, generateKeyPair } = require('../src/shared/crypto');
const { tempDataDir, cleanup } = require('./helpers');

function setup() {
  const dir = tempDataDir('enforcer');
  const registry = new Registry(dir);
  const { humanId, privateKey: humanKey } = registry.enrollHuman({
    name: 'Alice',
    capabilities: { branches: ['*'], actions: ['push', 'pr:open', 'pr:comment', 'pr:approve'] },
  });
  const { agentCardId, privateKey: agentKey } = registry.issueAgentCard({
    sponsorId: humanId,
    tool: { name: 'claude-code', version: '2.4.0' },
    context: 'office',
    requestedCapabilities: { branches: ['feature/*'], actions: ['push', 'pr:open', 'pr:comment'] },
  });
  return { dir, registry, humanId, humanKey, agentCardId, agentKey };
}

function makeCommit({ sha, authorId, key, branch, isAgent, sponsorId, sessionId }) {
  const message = `feat: change on ${branch}`;
  const payload = { sha, message };
  return {
    sha,
    authorId,
    isAgent: !!isAgent,
    branch,
    payload,
    signature: sign(payload, key),
    trailers: isAgent ? { 'Agent-ID': authorId, Sponsor: sponsorId } : undefined,
    sessionId,
  };
}

test('a signed commit from a verified human passes', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));
  const commit = makeCommit({ sha: 'a'.repeat(40), authorId: s.humanId, key: s.humanKey, branch: 'feature/x' });
  assert.strictEqual(verifyCommit(commit, s.registry).ok, true);
});

test('a commit from an unenrolled author fails', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));
  const stranger = generateKeyPair();
  const commit = makeCommit({ sha: 'b'.repeat(40), authorId: 'human_ghost', key: stranger.privateKey, branch: 'main' });
  const result = verifyCommit(commit, s.registry);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /unknown or unenrolled/i);
});

test('an unsigned commit fails', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));
  const commit = makeCommit({ sha: 'c'.repeat(40), authorId: s.humanId, key: s.humanKey, branch: 'feature/x' });
  delete commit.signature;
  const result = verifyCommit(commit, s.registry);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /unsigned/i);
});

test('an agent commit on an allowed branch passes', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));
  const commit = makeCommit({
    sha: 'd'.repeat(40),
    authorId: s.agentCardId,
    key: s.agentKey,
    branch: 'feature/jwt',
    isAgent: true,
    sponsorId: s.humanId,
  });
  assert.strictEqual(verifyCommit(commit, s.registry).ok, true);
});

test('an agent commit to main is rejected by its capability ceiling', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));
  const commit = makeCommit({
    sha: 'e'.repeat(40),
    authorId: s.agentCardId,
    key: s.agentKey,
    branch: 'main',
    isAgent: true,
    sponsorId: s.humanId,
  });
  const result = verifyCommit(commit, s.registry);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /not authorized to push/i);
});

test('a mismatched Sponsor trailer is rejected', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));
  const commit = makeCommit({
    sha: 'f'.repeat(40),
    authorId: s.agentCardId,
    key: s.agentKey,
    branch: 'feature/x',
    isAgent: true,
    sponsorId: 'human_someone_else',
  });
  const result = verifyCommit(commit, s.registry);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /sponsor trailer/i);
});

test("a commit signed with another party's key is rejected", (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));
  const impostor = generateKeyPair();
  const commit = makeCommit({
    sha: '1'.repeat(40),
    authorId: s.agentCardId,
    key: impostor.privateKey,
    branch: 'feature/x',
    isAgent: true,
    sponsorId: s.humanId,
  });
  const result = verifyCommit(commit, s.registry);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /signature/i);
});

test('session lookup rejects a push with no live broker session', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));
  const commit = makeCommit({
    sha: '2'.repeat(40),
    authorId: s.agentCardId,
    key: s.agentKey,
    branch: 'feature/x',
    isAgent: true,
    sponsorId: s.humanId,
  });
  const result = verifyCommit(commit, s.registry, () => null);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /session/i);
});

test('a pull request fails if any single commit fails', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));
  const good = makeCommit({ sha: '3'.repeat(40), authorId: s.humanId, key: s.humanKey, branch: 'feature/x' });
  const stranger = generateKeyPair();
  const bad = makeCommit({ sha: '4'.repeat(40), authorId: 'human_ghost', key: stranger.privateKey, branch: 'feature/x' });

  assert.strictEqual(verifyPullRequest([good], s.registry).conclusion, 'success');
  const mixed = verifyPullRequest([good, bad], s.registry);
  assert.strictEqual(mixed.conclusion, 'failure');
  assert.match(mixed.summary, /1\/2/);
});

test('an empty pull request fails closed', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));
  assert.strictEqual(verifyPullRequest([], s.registry).conclusion, 'failure');
});

// --- Review gate ---

test('a verified human approval counts', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));
  const d = evaluateReview({ reviewerId: s.humanId, isAgent: false, state: 'APPROVED' }, s.registry);
  assert.strictEqual(d.shouldDismiss, false);
});

test('an agent approval is always dismissed', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));
  const d = evaluateReview({ reviewerId: s.agentCardId, isAgent: true, state: 'APPROVED' }, s.registry);
  assert.strictEqual(d.shouldDismiss, true);
});

test('an agent comment is not dismissed', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));
  const d = evaluateReview({ reviewerId: s.agentCardId, isAgent: true, state: 'COMMENTED' }, s.registry);
  assert.strictEqual(d.shouldDismiss, false);
});

test('an approval from a revoked or unenrolled reviewer is dismissed', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));
  assert.strictEqual(
    evaluateReview({ reviewerId: 'human_ghost', isAgent: false, state: 'APPROVED' }, s.registry).shouldDismiss,
    true
  );
  s.registry.revoke(s.humanId, 'offboarded');
  assert.strictEqual(
    evaluateReview({ reviewerId: s.humanId, isAgent: false, state: 'APPROVED' }, s.registry).shouldDismiss,
    true
  );
});

test('an approval from someone without pr:approve is dismissed', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));
  const limited = s.registry.enrollHuman({
    name: 'Intern',
    capabilities: { branches: ['feature/*'], actions: ['push', 'pr:open'] },
  });
  const d = evaluateReview({ reviewerId: limited.humanId, isAgent: false, state: 'APPROVED' }, s.registry);
  assert.strictEqual(d.shouldDismiss, true);
  assert.match(d.reason, /pr:approve/);
});

// --- GitHub payload mapping ---

test('git trailers are parsed and mapped to a verifiable commit', () => {
  const message = 'feat: add refresh\n\nAgent-ID: agent_123\nSponsor: human_456\nSignature: sig==';
  const trailers = parseTrailers(message);
  assert.strictEqual(trailers['Agent-ID'], 'agent_123');
  assert.strictEqual(trailers.Sponsor, 'human_456');

  const mapped = mapGitHubCommit({ sha: 'abc', commit: { message }, author: { login: 'someone' } }, 'feature/x');
  assert.strictEqual(mapped.isAgent, true);
  assert.strictEqual(mapped.authorId, 'agent_123');
  assert.strictEqual(mapped.branch, 'feature/x');
});

'use strict';
/**
 * Scripted end-to-end walkthrough. Exercises the real modules — no mocks —
 * and prints what happens at each step, so the whole system can be seen
 * working in one command: `npm run demo`.
 *
 * The exhaustive assertions live in `test/` (`npm test`); this file is the
 * narrative version.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Registry } = require('../src/registry/registry');
const { TokenBroker } = require('../src/broker/broker');
const { verifyPullRequest } = require('../src/enforcer/verify');
const { evaluateReview } = require('../src/enforcer/reviewGate');
const { sign, randomId, generateKeyPair } = require('../src/shared/crypto');

const DEMO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-demo-'));

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
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

function makeCommit({ sha, authorId, key, branch, isAgent, sponsorId }) {
  const message = `feat: work on ${branch}`;
  const payload = { sha, message };
  return {
    sha,
    authorId,
    isAgent: !!isAgent,
    branch,
    payload,
    signature: sign(payload, key),
    trailers: isAgent ? { 'Agent-ID': authorId, Sponsor: sponsorId } : undefined,
  };
}

(function run() {
  const registry = new Registry(DEMO_DIR);
  const broker = new TokenBroker(DEMO_DIR, { registry });

  section('Setup');
  const { humanId, privateKey: humanKey } = registry.enrollHuman({
    name: 'Priya (verified employee)',
    oidcSubject: 'sso:priya@example.com',
    allowedContexts: ['office'],
    capabilities: { branches: ['*'], actions: ['push', 'pr:open', 'pr:comment', 'pr:approve', 'pr:merge'] },
  });
  console.log(`  Enrolled human: ${humanId}`);

  const { agentCardId, privateKey: agentKey, card } = registry.issueAgentCard({
    sponsorId: humanId,
    tool: { name: 'claude-code', version: '2.4.0' },
    operator: humanId,
    context: 'office',
    requestedCapabilities: { branches: ['feature/*', 'agent/*'], actions: ['push', 'pr:open', 'pr:comment'] },
  });
  console.log(`  Issued agent card: ${agentCardId} (${card.tool.name}@${card.tool.version})`);
  console.log(`  Agent scope: branches=[${card.capabilities.branches}] actions=[${card.capabilities.actions}]`);

  section('1. An outsider cannot land code');
  const stranger = generateKeyPair();
  const rogue = makeCommit({ sha: 'a'.repeat(40), authorId: 'human_ghost', key: stranger.privateKey, branch: 'main' });
  const r1 = verifyPullRequest([rogue], registry);
  check('unenrolled author fails the agentgate/verified check', r1.conclusion === 'failure', r1.summary);

  section('2. A verified employee works normally');
  const humanCommit = makeCommit({ sha: 'b'.repeat(40), authorId: humanId, key: humanKey, branch: 'feature/login' });
  const r2 = verifyPullRequest([humanCommit], registry);
  check('signed commit from a verified human passes', r2.conclusion === 'success', r2.summary);

  const humanApproval = evaluateReview({ reviewerId: humanId, isAgent: false, state: 'APPROVED' }, registry);
  check('their approval counts', humanApproval.shouldDismiss === false, humanApproval.reason);

  section('3. An AI agent can propose, but never approve or reach main');
  const agentCommit = makeCommit({
    sha: 'c'.repeat(40),
    authorId: agentCardId,
    key: agentKey,
    branch: 'feature/jwt-refresh',
    isAgent: true,
    sponsorId: humanId,
  });
  const r3 = verifyPullRequest([agentCommit], registry);
  check('agent commit on an allowed branch passes', r3.conclusion === 'success', r3.summary);

  const agentApproval = evaluateReview({ reviewerId: agentCardId, isAgent: true, state: 'APPROVED' }, registry);
  check('agent self-approval is dismissed', agentApproval.shouldDismiss === true, agentApproval.reason);

  const agentOnMain = makeCommit({
    sha: 'd'.repeat(40),
    authorId: agentCardId,
    key: agentKey,
    branch: 'main',
    isAgent: true,
    sponsorId: humanId,
  });
  const r3b = verifyPullRequest([agentOnMain], registry);
  check('agent push to main is refused by its capability ceiling', r3b.conclusion === 'failure', r3b.summary);

  section('4. Credentials are granted only in the right context');
  const officeReq = broker.requestToken(signedRequest(humanId, humanKey, { agentCardId }));
  check('office request is granted', officeReq.granted === true, JSON.stringify(officeReq.reason || ''));
  if (officeReq.granted) {
    console.log(`        scope: branches=[${officeReq.token.scope.branches}] actions=[${officeReq.token.scope.actions}]`);
  }

  const homeReq = broker.requestToken(signedRequest(humanId, humanKey, { agentCardId, context: 'home-network' }));
  check('the same request from off-network is denied', homeReq.granted === false, homeReq.reason);

  section('5. A captured request cannot be replayed');
  const captured = signedRequest(humanId, humanKey, { agentCardId });
  const first = broker.requestToken(captured);
  const replay = broker.requestToken(captured);
  check('first use of the request succeeds', first.granted === true);
  check('replaying the identical request is refused', replay.granted === false, replay.reason);

  section('6. Revoking a person disables their agents immediately');
  registry.revoke(humanId, 'left the company');
  const afterRevoke = broker.requestToken(signedRequest(humanId, humanKey, { agentCardId }));
  check('token request after revocation is denied', afterRevoke.granted === false, afterRevoke.reason);
  check('the sponsored agent card no longer verifies', registry.verifyAgentCard(agentCardId).valid === false);

  section('7. The audit trail cannot be quietly edited');
  const before = broker.audit.verifyChain(broker.publicKey);
  check('audit chain verifies', before.valid === true, JSON.stringify(before));

  const auditPath = path.join(DEMO_DIR, 'audit.json');
  const raw = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  raw.entries[0].reason = 'edited by an attacker';
  fs.writeFileSync(auditPath, JSON.stringify(raw, null, 2));

  const after = broker.audit.verifyChain(broker.publicKey);
  check('editing a past entry is detected', after.valid === false, `broken at entry ${after.brokenAt}: ${after.reason}`);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));
  console.log(`\nRun \`npm test\` for the full assertion suite.\n`);

  fs.rmSync(DEMO_DIR, { recursive: true, force: true });
  process.exitCode = failed > 0 ? 1 : 0;
})();

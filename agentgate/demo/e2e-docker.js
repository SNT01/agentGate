'use strict';
/**
 * End-to-end test against a running AgentGate container.
 *
 * Unlike `run-demo.js`, which exercises the modules in-process, this drives
 * the deployed service the way a real client does: identities are created
 * inside the container via the CLI, and every authorization decision is
 * made by the containerized broker over HTTP.
 *
 * Usage:
 *   AGENTGATE_URL=http://127.0.0.1:4790 \
 *   AGENTGATE_ADMIN_TOKEN=... \
 *   node demo/e2e-docker.js '<identities-json>'
 *
 * The identities argument is the JSON emitted by the enrollment step in
 * scripts/e2e-docker.sh (ids and private keys created inside the container).
 */
const http = require('http');
const { sign, randomId } = require('../src/shared/crypto');

const BASE = process.env.AGENTGATE_URL || 'http://127.0.0.1:4790';
const ADMIN = process.env.AGENTGATE_ADMIN_TOKEN || '';
const ids = JSON.parse(process.argv[2] || '{}');

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

function request(path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
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
            /* non-JSON response */
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

function tokenRequest(humanId, privateKey, overrides = {}) {
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

(async function run() {
  console.log(`Testing deployed AgentGate at ${BASE}\n${'='.repeat(60)}`);

  section('1. Service health');
  const health = await request('/health');
  check('GET /health returns ok', health.status === 200 && health.body.status === 'ok');
  check('broker exposes its public key', typeof health.body.brokerPublicKey === 'string' && health.body.brokerPublicKey.length > 40);

  section('2. A verified human gets a scoped credential');
  const granted = await request('/token', {
    method: 'POST',
    body: tokenRequest(ids.humanId, ids.humanKey),
  });
  check('token request is granted (HTTP 200)', granted.status === 200 && granted.body.granted === true, granted.text);
  const humanToken = granted.body && granted.body.token;
  if (humanToken) {
    const ttl = humanToken.expiresAt - humanToken.issuedAt;
    check('token is short-lived (15 minutes)', ttl === 15 * 60 * 1000, `ttl=${ttl}ms`);
    check('token carries a session id', typeof humanToken.sessionId === 'string');
  }

  section('3. An agent receives strictly less authority than its sponsor');
  const agentGrant = await request('/token', {
    method: 'POST',
    body: tokenRequest(ids.humanId, ids.humanKey, { agentCardId: ids.agentCardId }),
  });
  check('agent token request is granted', agentGrant.status === 200 && agentGrant.body.granted === true, agentGrant.text);
  const agentScope = agentGrant.body && agentGrant.body.token && agentGrant.body.token.scope;
  if (agentScope) {
    console.log(`        agent scope: branches=[${agentScope.branches}] actions=[${agentScope.actions}]`);
    check('agent is confined to feature branches', !agentScope.branches.includes('*') && agentScope.branches.every((b) => b !== 'main'));
    check('agent cannot approve pull requests', !agentScope.actions.includes('pr:approve'));
    check('agent cannot merge', !agentScope.actions.includes('pr:merge'));
  }

  section('4. Requests from outside the office are refused');
  const offsite = await request('/token', {
    method: 'POST',
    body: tokenRequest(ids.humanId, ids.humanKey, { agentCardId: ids.agentCardId, context: 'home-network' }),
  });
  check('off-network request denied (HTTP 403)', offsite.status === 403 && offsite.body.granted === false, offsite.text);
  check('denial explains the posture failure', /posture/i.test(offsite.body.reason || ''), offsite.body.reason);

  section('5. A captured request cannot be replayed');
  const captured = tokenRequest(ids.humanId, ids.humanKey);
  const firstUse = await request('/token', { method: 'POST', body: captured });
  const replayed = await request('/token', { method: 'POST', body: captured });
  check('first use succeeds', firstUse.status === 200 && firstUse.body.granted === true);
  check('replay is refused', replayed.status === 403 && replayed.body.granted === false, replayed.text);
  check('denial names the replay', /replay/i.test(replayed.body.reason || ''), replayed.body.reason);

  section('6. Forged and malformed requests are rejected');
  const forged = tokenRequest(ids.humanId, ids.humanKey);
  forged.humanSignature = Buffer.from('forged').toString('base64');
  const forgedRes = await request('/token', { method: 'POST', body: forged });
  check('forged signature denied', forgedRes.status === 403 && /signature/i.test(forgedRes.body.reason || ''), forgedRes.text);

  const unknown = await request('/token', {
    method: 'POST',
    body: tokenRequest('human_does_not_exist', ids.humanKey),
  });
  check('unknown identity denied', unknown.status === 403, unknown.text);

  const malformed = await request('/token', { method: 'POST', body: { nonsense: true } });
  check('malformed request denied without crashing', malformed.status === 403, malformed.text);

  section('7. Admin endpoints are protected');
  const noAuth = await request('/audit');
  check('audit log rejects unauthenticated access (401)', noAuth.status === 401);

  const wrongAuth = await request('/audit', { headers: { Authorization: 'Bearer wrong-token' } });
  check('audit log rejects a wrong token (401)', wrongAuth.status === 401);

  const withAuth = await request('/audit', { headers: { Authorization: `Bearer ${ADMIN}` } });
  check('admin can read the audit log', withAuth.status === 200 && Array.isArray(withAuth.body.entries));

  section('8. Every decision was recorded, and the log verifies');
  const entries = (withAuth.body && withAuth.body.entries) || [];
  const granted_count = entries.filter((e) => e.outcome === 'granted').length;
  const denied_count = entries.filter((e) => e.outcome === 'denied').length;
  console.log(`        ${entries.length} entries: ${granted_count} granted, ${denied_count} denied`);
  check('grants were recorded', granted_count >= 3);
  check('denials were recorded', denied_count >= 5);
  check('the acting tool is attributed', entries.some((e) => e.tool && e.tool.name === 'claude-code'));

  const verifyRes = await request('/audit/verify', { headers: { Authorization: `Bearer ${ADMIN}` } });
  check('audit chain verifies on the server', verifyRes.status === 200 && verifyRes.body.valid === true, verifyRes.text);

  section('9. Unknown routes are not served');
  const notFound = await request('/../etc/passwd');
  check('unknown route returns 404', notFound.status === 404);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));
  process.exitCode = failed > 0 ? 1 : 0;
})().catch((err) => {
  console.error(`\nE2E run failed: ${err.message}`);
  process.exitCode = 1;
});

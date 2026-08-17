'use strict';
/**
 * Git credential helper — makes AgentGate invisible in daily use.
 *
 * Install:
 *   git config --global credential.helper \
 *     '!node /absolute/path/to/agentgate/src/cli/credentialHelper.js'
 *
 * Git invokes this with `get` and reads `username=` / `password=` from
 * stdout. The password returned is a broker-minted, scope-narrowed,
 * short-lived token — never a long-lived personal access token — so
 * `git push` works exactly as before while every credential stays
 * attributable and expiring.
 *
 * Configuration (in production these come from the OS keychain, not raw
 * environment variables):
 *   AGENTGATE_HUMAN_ID, AGENTGATE_HUMAN_PRIVATE_KEY
 *   AGENTGATE_AGENT_CARD_ID, AGENTGATE_AGENT_PRIVATE_KEY   (when an AI agent is acting)
 *   AGENTGATE_CONTEXT        (default: office)
 *   AGENTGATE_BROKER_URL     (default: http://127.0.0.1:4790)
 */
const http = require('http');
const https = require('https');
const { sign, randomId } = require('../shared/crypto');

const DEFAULT_BROKER = 'http://127.0.0.1:4790';
const REQUEST_TIMEOUT_MS = 10_000;

function postJson(urlString, bodyObj) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = JSON.stringify(bodyObj);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(JSON.parse(text));
          } catch (_e) {
            reject(new Error(`broker returned non-JSON response (HTTP ${res.statusCode}): ${text.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error(`broker did not respond within ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function requestToken() {
  const humanId = process.env.AGENTGATE_HUMAN_ID;
  const humanPrivateKey = process.env.AGENTGATE_HUMAN_PRIVATE_KEY;
  if (!humanId || !humanPrivateKey) {
    throw new Error(
      'AGENTGATE_HUMAN_ID / AGENTGATE_HUMAN_PRIVATE_KEY are not set — run `agentgate enroll` and export the values it prints'
    );
  }

  // The nonce and timestamp are both signed: the broker rejects stale or
  // reused requests, so a captured request cannot be replayed.
  const nonce = randomId('nonce');
  const timestamp = Date.now();
  const humanSignature = sign({ humanId, nonce, timestamp }, humanPrivateKey);

  const brokerUrl = process.env.AGENTGATE_BROKER_URL || DEFAULT_BROKER;
  return postJson(`${brokerUrl.replace(/\/$/, '')}/token`, {
    humanId,
    humanSignature,
    nonce,
    timestamp,
    agentCardId: process.env.AGENTGATE_AGENT_CARD_ID || null,
    context: process.env.AGENTGATE_CONTEXT || 'office',
  });
}

async function main() {
  const mode = process.argv[2]; // git passes 'get' | 'store' | 'erase'
  if (mode !== 'get') {
    // Nothing to store or erase: tokens are never persisted client-side.
    process.exit(0);
  }

  const result = await requestToken();
  if (!result.granted) {
    process.stderr.write(`AgentGate: access denied — ${result.reason}\n`);
    process.exit(1);
  }
  process.stdout.write('username=x-access-token\n');
  process.stdout.write(`password=${result.token.signature}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`AgentGate credential helper error: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { requestToken };

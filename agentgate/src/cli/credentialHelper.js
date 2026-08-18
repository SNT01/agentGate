'use strict';
/**
 * Git credential helper — makes AgentGate invisible in daily use.
 *
 * Install:
 *   git config --global credential.useHttpPath true
 *   git config --global credential.helper \
 *     '!node /absolute/path/to/agentgate/src/cli/credentialHelper.js'
 *
 * `useHttpPath` is not optional. Without it git never tells the helper which
 * repository the credential is for, and the broker cannot scope the token to
 * one repository — so it denies rather than mint something broader.
 *
 * Git invokes this with `get` and reads `username=` / `password=` from
 * stdout. The password returned is a real GitHub App installation token,
 * minted per request, scoped to this one repository and to the permissions
 * AgentGate's capability intersection allows — never a long-lived personal
 * access token. `git push` works exactly as before while every credential
 * stays attributable and expiring.
 *
 * Nothing is written to disk. `store` and `erase` are deliberate no-ops:
 * caching a forge credential on the client would undo the property that
 * makes this design worth having.
 *
 * Configuration (in production these come from the OS keychain, not raw
 * environment variables):
 *   AGENTGATE_HUMAN_ID, AGENTGATE_HUMAN_PRIVATE_KEY
 *   AGENTGATE_AGENT_CARD_ID, AGENTGATE_AGENT_PRIVATE_KEY   (when an AI agent is acting)
 *   AGENTGATE_CONTEXT        (default: office)
 *   AGENTGATE_BROKER_URL     (default: http://127.0.0.1:4790)
 *   AGENTGATE_REPOSITORY     (fallback for CI, where git config is not global)
 */
const http = require('http');
const https = require('https');
const { sign, randomId } = require('../shared/crypto');

const DEFAULT_BROKER = 'http://127.0.0.1:4790';
const REQUEST_TIMEOUT_MS = 10_000;
const FORGE_HOSTS = /(^|\.)(github\.com|githubusercontent\.com)$/i;

/**
 * Parse git's credential protocol: `key=value` lines, terminated by a blank
 * line. Never throws — a malformed line is skipped, because failing here
 * would break `git push` for a field we may not even need.
 */
function parseCredentialInput(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    if (line === '') break; // blank line terminates the request
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    // `wwwauth[]` is multi-valued and irrelevant here; keeping only the last
    // value would be quietly wrong, so skip the whole family.
    if (key.endsWith('[]')) continue;
    out[key] = line.slice(eq + 1).replace(/\r$/, '');
  }
  return out;
}

/**
 * Normalise git's `path` (`owner/repo.git`, sometimes with a leading slash
 * or a trailing query) to `owner/repo`. Returns null when git sent nothing
 * usable, which almost always means `credential.useHttpPath` is unset.
 */
function parseRepository(pathValue) {
  if (!pathValue || typeof pathValue !== 'string') return null;
  const cleaned = pathValue.trim().split(/[?#]/)[0];
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  // A path may be deeper than owner/repo — git sends the smart-HTTP route
  // (`owner/repo.git/info/refs`) in some flows. The first two segments are
  // the repository, and `.git` is stripped from the name, not the whole
  // string, so a deeper path normalises the same way a bare one does.
  return `${parts[0]}/${parts[1].replace(/\.git$/i, '')}`;
}

/**
 * Read git's request from stdin.
 *
 * Resolves empty when stdin is a TTY — otherwise running the helper by hand
 * to debug it hangs forever with no indication why.
 */
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      text += chunk;
    });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', () => resolve(text));
  });
}

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

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);

/**
 * The request carries the human's signature. Over plaintext HTTP to another
 * machine, anyone on the path can capture it — the nonce bounds replay, but
 * only within the replay window, and the whole authorization request is in
 * the clear regardless. Loopback is fine; anything else must be TLS.
 */
function assertBrokerTransportSafe(brokerUrl) {
  const url = new URL(brokerUrl);
  if (url.protocol === 'https:') return;
  if (LOOPBACK.has(url.hostname)) return;
  throw new Error(
    `refusing to send a signed token request to ${url.origin} over plaintext HTTP — ` +
      'use https:// for a remote broker, or tunnel it to loopback'
  );
}

/**
 * Ask the broker for a credential for a specific repository.
 *
 * @param {{repository?: string, host?: string, protocol?: string}} [context]
 */
async function requestToken(context = {}) {
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

  const brokerUrl = (process.env.AGENTGATE_BROKER_URL || DEFAULT_BROKER).replace(/\/$/, '');
  assertBrokerTransportSafe(brokerUrl);

  return postJson(`${brokerUrl}/token`, {
    humanId,
    humanSignature,
    nonce,
    timestamp,
    agentCardId: process.env.AGENTGATE_AGENT_CARD_ID || null,
    context: process.env.AGENTGATE_CONTEXT || 'office',
    // Repository scoping: without this the broker cannot narrow the forge
    // token to one repository. AGENTGATE_REPOSITORY covers CI and agent
    // processes that have no global git config.
    repository: context.repository || process.env.AGENTGATE_REPOSITORY || null,
    forgeHost: context.host || null,
    forgeProtocol: context.protocol || null,
  });
}

async function main() {
  const mode = process.argv[2]; // git passes 'get' | 'store' | 'erase'
  if (mode !== 'get') {
    // Nothing to store or erase: credentials are never persisted client-side.
    process.exit(0);
  }

  const input = parseCredentialInput(await readStdin());
  const repository = parseRepository(input.path);
  const result = await requestToken({
    repository,
    host: input.host || null,
    protocol: input.protocol || null,
  });

  if (!result.granted) {
    process.stderr.write(`AgentGate: access denied — ${result.reason}\n`);
    process.exit(1);
  }

  if (!result.git || !result.git.password) {
    // The broker authorized the request but minted no forge credential. The
    // AgentGate session token's signature is an internal artifact that GitHub
    // has never seen; emitting it produces the opaque
    // "Invalid username or token" error from the remote. Fail locally, where
    // we can name the actual cause.
    const host = input.host || '';
    if (FORGE_HOSTS.test(host) || !host) {
      process.stderr.write(
        'AgentGate: authorized, but no GitHub credential was minted.\n' +
          '  The broker has no GitHub App configured. Set AGENTGATE_GITHUB_APP_ID,\n' +
          '  AGENTGATE_GITHUB_INSTALLATION_ID, AGENTGATE_GITHUB_OWNER and\n' +
          '  AGENTGATE_GITHUB_PRIVATE_KEY_PATH on the broker, and install\n' +
          '  @octokit/auth-app there. See README §"Live GitHub App wiring".\n'
      );
      process.exit(1);
    }
    // A non-GitHub host: no forge module claims it, so say nothing and let
    // git fall through to the next helper in its chain.
    process.exit(0);
  }

  process.stdout.write(`username=${result.git.username || 'x-access-token'}\n`);
  process.stdout.write(`password=${result.git.password}\n`);
  // Tell git when the credential dies, so it re-invokes this helper instead
  // of caching a token past its expiry (git >= 2.41 honours this).
  if (result.git.expiresAt) {
    const seconds = Math.floor(new Date(result.git.expiresAt).getTime() / 1000);
    if (Number.isFinite(seconds)) process.stdout.write(`password_expiry_utc=${seconds}\n`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`AgentGate credential helper error: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { requestToken, parseCredentialInput, parseRepository, readStdin };

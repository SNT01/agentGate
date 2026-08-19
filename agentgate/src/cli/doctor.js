'use strict';
/**
 * `agentgate doctor` — check a deployment and name the fix for whatever is
 * wrong.
 *
 * The failures worth catching here are the *quiet* ones. AgentGate sits
 * between `git push` and GitHub, so a misconfiguration usually surfaces as
 * something that looks nothing like its cause: an empty audit log (git never
 * called the helper), `Invalid username or token` from the remote (the broker
 * minted no forge credential), or `unknown human` on every request (the CLI
 * wrote to a different data directory than the broker reads). Each check below
 * exists because one of those cost somebody an hour.
 *
 * Every check reports one of three things and never throws: `pass`, `warn`
 * (works, but not what a production deployment should look like), or `fail`
 * with the command that fixes it. Exit status is non-zero only for `fail`, so
 * this is usable in CI as a smoke test.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const { config, validateConfig } = require('../shared/config');

const PASS = 'pass';
const WARN = 'warn';
const FAIL = 'fail';

const MARKS = { [PASS]: '✓', [WARN]: '!', [FAIL]: '✗' };

/** GET a URL, resolving to {status, body} and never throwing. */
function get(urlString, headers = {}, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (err) {
      return resolve({ error: `not a valid URL: ${urlString}` });
    }
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try {
            body = JSON.parse(text);
          } catch (_e) {
            /* not JSON; body stays null */
          }
          resolve({ status: res.statusCode, body, text });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`no response within ${timeoutMs}ms`)));
    req.on('error', (err) => resolve({ error: err.message }));
    req.end();
  });
}

/** Read a git config value, or null when git is unavailable or it is unset. */
function gitConfig(args) {
  try {
    return execFileSync('git', ['config', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_err) {
    return null;
  }
}

function brokerUrl() {
  if (process.env.AGENTGATE_BROKER_URL) return process.env.AGENTGATE_BROKER_URL.replace(/\/$/, '');
  const { defaultBrokerUrl } = require('./credentialHelper');
  return defaultBrokerUrl();
}

// --- checks -----------------------------------------------------------------
// Each returns {name, status, detail, fix?}. Kept as small independent
// functions so a new check is an addition, not an edit.

function checkConfigFile() {
  const { path: envPath, problems } = config.envFile;
  if (problems.length) {
    return {
      name: 'configuration file',
      status: FAIL,
      detail: problems.join('; '),
      fix: 'correct the lines above, or delete the file to fall back to defaults',
    };
  }
  if (!envPath) {
    return {
      name: 'configuration file',
      status: WARN,
      detail: 'no .env found — running on environment variables and defaults',
      fix: 'cp env.example.txt .env    (optional; skip if you set variables another way)',
    };
  }
  return { name: 'configuration file', status: PASS, detail: envPath };
}

function checkConfigValues() {
  const problems = validateConfig();
  if (problems.length) {
    return {
      name: 'configuration values',
      status: FAIL,
      detail: problems.join('; '),
      fix: 'fix the variables named above — the broker refuses to start until then',
    };
  }
  return {
    name: 'configuration values',
    status: PASS,
    detail: `${config.env}, token TTL ${Math.round(config.tokenTtlMs / 1000)}s`,
  };
}

function checkAdminToken() {
  if (!config.adminToken) {
    return {
      name: 'admin token',
      status: WARN,
      detail: 'unset — the admin API and dashboard are disabled',
      fix: 'AGENTGATE_ADMIN_TOKEN="$(openssl rand -hex 32)"',
    };
  }
  if (config.adminToken.length < 32) {
    return {
      name: 'admin token',
      status: config.isProduction ? FAIL : WARN,
      detail: `${config.adminToken.length} characters — production requires at least 32`,
      fix: 'AGENTGATE_ADMIN_TOKEN="$(openssl rand -hex 32)"',
    };
  }
  return { name: 'admin token', status: PASS, detail: `set (${config.adminToken.length} characters)` };
}

function checkDataDir() {
  const dir = config.dataDir;
  const rootKeyPath = path.join(dir, 'registry-root-key.json');
  const registryPath = path.join(dir, 'registry.json');

  if (!fs.existsSync(dir)) {
    return {
      name: 'data directory',
      status: WARN,
      detail: `${dir} does not exist yet — it is created on first use`,
      fix: 'if you expected existing identities here, check AGENTGATE_DATA_DIR',
    };
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (_err) {
    return {
      name: 'data directory',
      status: FAIL,
      detail: `${dir} is not writable by this user`,
      fix: `chown/chmod ${dir} so the broker's user can write it`,
    };
  }

  const hasRootKey = fs.existsSync(rootKeyPath);
  let identities = 0;
  if (fs.existsSync(registryPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      identities = Object.keys(data.humans || {}).length + Object.keys(data.agents || {}).length;
    } catch (_err) {
      return {
        name: 'data directory',
        status: FAIL,
        detail: `${registryPath} is not readable JSON`,
        fix: 'restore it from backup — this file is the identity registry',
      };
    }
  }

  // The dangerous combination: identities exist but the key that signed them
  // does not. Every agent card will fail verification.
  if (identities > 0 && !hasRootKey) {
    return {
      name: 'data directory',
      status: FAIL,
      detail: `${dir} holds ${identities} identities but registry-root-key.json is missing`,
      fix: 'restore registry-root-key.json from backup — without it every agent card fails verification',
    };
  }

  return {
    name: 'data directory',
    status: PASS,
    detail: `${dir} (${identities} identities${hasRootKey ? '' : ', no root key yet'})`,
  };
}

/**
 * Agent cards about to expire.
 *
 * An expiring card is not a misconfiguration, but it becomes an outage on a
 * known date, and nothing else tells anybody. On a 30-day TTL a fleet of a few
 * hundred agents produces several of these a day, so it belongs in the routine
 * check rather than in a calendar reminder somebody has to remember to make.
 */
function checkExpiringCards() {
  const dir = config.dataDir;
  const registryPath = path.join(dir, 'registry.json');
  if (!fs.existsSync(registryPath)) {
    return { name: 'card expiry', status: PASS, detail: 'no identities yet' };
  }

  let registry;
  try {
    // Read directly: constructing a Registry would generate a root key as a
    // side effect on a directory that has none.
    const { Registry } = require('../registry/registry');
    registry = new Registry(dir);
  } catch (err) {
    return { name: 'card expiry', status: WARN, detail: `could not read the registry: ${err.message}` };
  }

  const soon = registry.listExpiringAgentCards(7 * 24 * 60 * 60 * 1000);
  if (!soon.length) {
    return { name: 'card expiry', status: PASS, detail: 'no agent cards expire within 7 days' };
  }

  const expired = soon.filter((c) => c.expiresInMs <= 0);
  const detail = expired.length
    ? `${expired.length} agent card(s) have ALREADY expired and are failing now; ${soon.length - expired.length} more within 7 days`
    : `${soon.length} agent card(s) expire within 7 days`;

  return {
    name: 'card expiry',
    status: expired.length ? FAIL : WARN,
    detail,
    fix: `agentgate list agents --expiring 7    then: agentgate renew <agentCardId>`,
  };
}

async function checkBrokerReachable() {
  const url = brokerUrl();
  const res = await get(`${url}/health`);
  if (res.error) {
    return {
      name: 'broker reachable',
      status: WARN,
      detail: `${url} — ${res.error}`,
      fix: `npm run broker    (or set AGENTGATE_BROKER_URL if it runs elsewhere)`,
    };
  }
  if (res.status !== 200) {
    return { name: 'broker reachable', status: FAIL, detail: `${url}/health returned HTTP ${res.status}` };
  }
  return {
    name: 'broker reachable',
    status: PASS,
    detail: `${url} (public key ${String((res.body && res.body.brokerPublicKey) || '').slice(0, 16)}…)`,
  };
}

async function checkAdminApi() {
  if (!config.adminToken) {
    return { name: 'admin API', status: WARN, detail: 'skipped — no admin token configured' };
  }
  const url = brokerUrl();
  const res = await get(`${url}/audit/verify`, { Authorization: `Bearer ${config.adminToken}` });
  if (res.error) {
    return { name: 'admin API', status: WARN, detail: `skipped — broker unreachable (${res.error})` };
  }
  if (res.status === 401) {
    return {
      name: 'admin API',
      status: FAIL,
      detail: 'the broker rejected this admin token',
      fix: 'the broker is running with a different AGENTGATE_ADMIN_TOKEN than this shell has — align them',
    };
  }
  if (res.status !== 200) {
    return { name: 'admin API', status: FAIL, detail: `/audit/verify returned HTTP ${res.status}` };
  }
  const valid = res.body && res.body.valid;
  return {
    name: 'admin API',
    status: valid ? PASS : FAIL,
    detail: valid
      ? `authenticated; audit chain valid (${(res.body && res.body.count) || 0} entries)`
      : `audit chain does NOT verify: ${JSON.stringify(res.body)}`,
    fix: valid ? undefined : 'investigate immediately — the log records where the chain breaks',
  };
}

/**
 * Is AgentGate actually in git's credential chain?
 *
 * This is the check that pays for the whole command. Git accumulates helpers
 * across config scopes and stops at the first that answers, so on macOS the
 * Command Line Tools gitconfig registers `osxkeychain` ahead of AgentGate and
 * a cached credential satisfies every push. The symptom is an empty audit
 * log — the broker is simply never consulted — which looks like AgentGate
 * doing nothing rather than a configuration problem.
 */
function checkGitCredentialHelper() {
  const helpers = gitConfig(['--get-all', 'credential.helper']);
  if (helpers === null) {
    return {
      name: 'git credential helper',
      status: WARN,
      detail: 'git is unavailable, or no credential.helper is configured',
      fix: "git config --global credential.helper '!node " + path.resolve(__dirname, 'credentialHelper.js') + "'",
    };
  }

  // Git accumulates helpers in configuration order, and an *empty* value
  // resets the accumulated list. Honouring that reset is the whole point of
  // the documented macOS fix, so the empty entries cannot simply be filtered
  // out — they are the instruction that discards everything before them.
  const lines = [];
  for (const raw of helpers.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      lines.length = 0;
      continue;
    }
    lines.push(line);
  }

  const agentGateIndex = lines.findIndex((l) => /credentialHelper\.js/.test(l));
  if (agentGateIndex === -1) {
    return {
      name: 'git credential helper',
      status: FAIL,
      detail: `AgentGate is not in git's helper chain (found: ${lines.join(', ') || 'none'})`,
      fix: "git config --global credential.helper '!node " + path.resolve(__dirname, 'credentialHelper.js') + "'",
    };
  }

  // Whatever survives the resets and precedes AgentGate can answer first.
  const shadowing = [...new Set(lines.slice(0, agentGateIndex))];
  if (shadowing.length) {
    return {
      name: 'git credential helper',
      status: FAIL,
      detail: `${shadowing.join(', ')} is consulted before AgentGate and will answer first — pushes will never reach the broker (the symptom is an empty audit log)`,
      fix:
        'git config --global --unset-all credential.helper && ' +
        "git config --global --add credential.helper '' && " +
        "git config --global --add credential.helper '!node " +
        path.resolve(__dirname, 'credentialHelper.js') +
        "'",
    };
  }

  return { name: 'git credential helper', status: PASS, detail: 'AgentGate answers first' };
}

function checkUseHttpPath() {
  const value = gitConfig(['--get', 'credential.useHttpPath']);
  if (value === 'true') {
    return { name: 'credential.useHttpPath', status: PASS, detail: 'true — git sends the repository path' };
  }
  if (process.env.AGENTGATE_REPOSITORY) {
    return {
      name: 'credential.useHttpPath',
      status: PASS,
      detail: `unset, but AGENTGATE_REPOSITORY=${process.env.AGENTGATE_REPOSITORY} covers it`,
    };
  }
  return {
    name: 'credential.useHttpPath',
    status: FAIL,
    detail: 'unset — git will not tell the broker which repository a credential is for, so it cannot scope the token and will deny',
    fix: 'git config --global credential.useHttpPath true    (or set AGENTGATE_REPOSITORY=owner/name in CI)',
  };
}

function checkClientIdentity() {
  const { resolveIdentity, credentialsPath } = require('./clientConfig');
  const identity = resolveIdentity();

  if (!identity.humanId || !identity.humanPrivateKey) {
    return {
      name: 'client identity',
      status: WARN,
      detail: `no identity in the environment or ${credentialsPath()}`,
      fix: 'agentgate setup-client --human human_... --key "MC4C..."    (only needed on a machine that pushes)',
    };
  }

  // Naming the source matters: "it works in my shell but not from my editor"
  // is exactly what an environment-only identity looks like.
  const from = identity.source.humanId === 'env' ? 'environment' : credentialsPath();
  return {
    name: 'client identity',
    status: PASS,
    detail: `${identity.humanId}${identity.agentCardId ? ` acting as ${identity.agentCardId}` : ' (no agent card — pushing as yourself)'}, context ${identity.context} — from ${from}`,
  };
}

function checkGithubApp() {
  if (!config.githubAppConfigured) {
    const partial = [
      config.githubAppId && 'AGENTGATE_GITHUB_APP_ID',
      config.githubInstallationId && 'AGENTGATE_GITHUB_INSTALLATION_ID',
      config.githubOwner && 'AGENTGATE_GITHUB_OWNER',
      (config.githubPrivateKey || config.githubPrivateKeyPath) && 'a private key',
    ].filter(Boolean);

    if (partial.length) {
      return {
        name: 'GitHub App',
        status: FAIL,
        detail: `partially configured (${partial.join(', ')} set) — a half-configured exchange fails at the first push`,
        fix: 'set all of AGENTGATE_GITHUB_APP_ID, AGENTGATE_GITHUB_INSTALLATION_ID, AGENTGATE_GITHUB_OWNER and AGENTGATE_GITHUB_PRIVATE_KEY_PATH',
      };
    }
    return {
      name: 'GitHub App',
      status: WARN,
      detail: 'not configured — the broker issues AgentGate session tokens only, which GitHub rejects',
      fix: 'see README §6 "Live GitHub App wiring" (not needed for the demo or tests)',
    };
  }

  // Configured: the failure modes now are the key file and the dependency.
  if (config.githubPrivateKeyPath) {
    try {
      const pem = fs.readFileSync(config.githubPrivateKeyPath, 'utf8');
      if (!pem.includes('PRIVATE KEY')) {
        return {
          name: 'GitHub App',
          status: FAIL,
          detail: `${config.githubPrivateKeyPath} does not look like a PEM private key`,
          fix: 'download the App private key from GitHub and point AGENTGATE_GITHUB_PRIVATE_KEY_PATH at the .pem',
        };
      }
      const mode = fs.statSync(config.githubPrivateKeyPath).mode & 0o077;
      if (mode !== 0) {
        return {
          name: 'GitHub App',
          status: FAIL,
          detail: `${config.githubPrivateKeyPath} is readable by group or others`,
          fix: `chmod 600 ${config.githubPrivateKeyPath}`,
        };
      }
    } catch (err) {
      return {
        name: 'GitHub App',
        status: FAIL,
        detail: `${config.githubPrivateKeyPath} is not readable: ${err.message}`,
        fix: 'check the path and that the broker\'s user can read it',
      };
    }
  }

  try {
    require.resolve('@octokit/auth-app');
  } catch (_err) {
    return {
      name: 'GitHub App',
      status: FAIL,
      detail: '@octokit/auth-app is not installed, so no credential can be minted',
      fix: 'npm install --no-save @octokit/auth-app',
    };
  }

  return {
    name: 'GitHub App',
    status: PASS,
    detail: `app ${config.githubAppId}, installation ${config.githubInstallationId}, owner ${config.githubOwner}`,
  };
}

function checkDashboard() {
  if (!config.uiEnabled) {
    return {
      name: 'dashboard',
      status: WARN,
      detail: 'disabled',
      fix: 'set AGENTGATE_ADMIN_TOKEN (enables it by default) or AGENTGATE_UI_ENABLED=true',
    };
  }
  const indexPath = path.join(config.uiAssetRoot, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return {
      name: 'dashboard',
      status: FAIL,
      detail: `enabled, but no built assets at ${config.uiAssetRoot}`,
      fix: 'cd ui && npm ci && npm run build',
    };
  }
  return { name: 'dashboard', status: PASS, detail: `built, served at /ui from ${config.uiAssetRoot}` };
}

/**
 * Checks are grouped, because "what is wrong" depends on which machine you are
 * on. A broker host has no git config to speak of; a developer's laptop has no
 * data directory.
 */
async function runChecks({ scope = 'all' } = {}) {
  const groups = [];

  if (scope === 'all' || scope === 'broker') {
    groups.push({
      title: 'Configuration',
      results: [
        checkConfigFile(),
        checkConfigValues(),
        checkAdminToken(),
        checkDataDir(),
        checkExpiringCards(),
      ],
    });
    groups.push({
      title: 'Broker',
      results: [await checkBrokerReachable(), await checkAdminApi(), checkDashboard(), checkGithubApp()],
    });
  }

  if (scope === 'all' || scope === 'client') {
    groups.push({
      title: 'Client (this machine pushing code)',
      results: [checkGitCredentialHelper(), checkUseHttpPath(), checkClientIdentity()],
    });
  }

  return groups;
}

function report(groups) {
  const lines = [];
  let failures = 0;
  let warnings = 0;

  for (const group of groups) {
    lines.push('', group.title, '-'.repeat(group.title.length));
    for (const result of group.results) {
      if (result.status === FAIL) failures++;
      if (result.status === WARN) warnings++;
      lines.push(`  ${MARKS[result.status]} ${result.name}: ${result.detail}`);
      if (result.fix && result.status !== PASS) lines.push(`      fix: ${result.fix}`);
    }
  }

  lines.push('');
  if (failures) {
    lines.push(`${failures} problem(s) to fix${warnings ? `, ${warnings} thing(s) worth a look` : ''}.`);
  } else if (warnings) {
    lines.push(`No problems. ${warnings} thing(s) worth a look — each is fine to ignore for a local trial.`);
  } else {
    lines.push('Everything checks out.');
  }
  lines.push('');

  return { text: lines.join('\n'), failures, warnings };
}

async function cmdDoctor(flags = {}) {
  const scope = flags.client ? 'client' : flags.broker ? 'broker' : 'all';
  const groups = await runChecks({ scope });

  if (flags.json) {
    const flat = groups.flatMap((g) => g.results.map((r) => ({ group: g.title, ...r })));
    console.log(JSON.stringify({ checks: flat }, null, 2));
    if (flat.some((r) => r.status === FAIL)) process.exitCode = 1;
    return;
  }

  const { text, failures } = report(groups);
  console.log(text);
  if (failures) process.exitCode = 1;
}

module.exports = { cmdDoctor, runChecks, report, PASS, WARN, FAIL };

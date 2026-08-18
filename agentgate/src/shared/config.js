'use strict';
/**
 * Centralised configuration, read from the environment.
 *
 * Values are exposed as getters that read `process.env` on each access
 * rather than being snapshotted at require time. That means a rotated
 * secret (notably AGENTGATE_ADMIN_TOKEN) takes effect without a restart,
 * and callers cannot accidentally depend on module load order.
 *
 * `assertProductionSafe()` is called at startup when NODE_ENV=production so
 * a misconfigured deployment fails loudly at boot rather than silently at
 * the first request.
 */
const fs = require('fs');
const path = require('path');

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${name}: expected a positive number, got "${raw}"`);
  }
  return n;
}

function str(name, fallback = null) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

const config = {
  /** Where registry, audit, and session state live. */
  get dataDir() {
    return str('AGENTGATE_DATA_DIR') || path.join(__dirname, '..', '..', 'data');
  },

  /** Broker HTTP listener. Loopback by default — set the host explicitly to expose it. */
  get port() {
    return int('AGENTGATE_BROKER_PORT', 4790);
  },
  get host() {
    return str('AGENTGATE_BROKER_HOST', '127.0.0.1');
  },

  /** Lifetime of an issued session token. Short by design: a leaked token
   *  should expire before it is useful. */
  get tokenTtlMs() {
    return int('AGENTGATE_TOKEN_TTL_MS', 15 * 60 * 1000);
  },

  /** How long an Agent Identity Card stays valid before reissue. */
  get agentCardTtlMs() {
    return int('AGENTGATE_AGENT_CARD_TTL_MS', 30 * 24 * 60 * 60 * 1000);
  },

  /** Replay window: how long a nonce is remembered, and the maximum age of
   *  an accepted request. Bounds both replay exposure and memory use. */
  get nonceWindowMs() {
    return int('AGENTGATE_NONCE_WINDOW_MS', 5 * 60 * 1000);
  },

  /** Maximum accepted HTTP request body, guarding against memory exhaustion. */
  get maxBodyBytes() {
    return int('AGENTGATE_MAX_BODY_BYTES', 64 * 1024);
  },

  /** Shared secret for admin endpoints. Unset disables them entirely. */
  get adminToken() {
    return str('AGENTGATE_ADMIN_TOKEN');
  },

  /**
   * Whether to serve the dashboard's static assets at all. Defaults to
   * "on only when an admin token is configured" — the dashboard's API calls
   * are useless without one, and serving the shell with no way to sign in
   * is a confusing dead end, not a safe default. Set explicitly to
   * override either way.
   */
  get uiEnabled() {
    const raw = str('AGENTGATE_UI_ENABLED');
    if (raw === null) return !!config.adminToken;
    return raw === '1' || raw.toLowerCase() === 'true';
  },

  /** Where the built dashboard (ui/dist output) is expected to live. */
  get uiAssetRoot() {
    return str('AGENTGATE_UI_ASSET_ROOT') || path.join(__dirname, '..', 'ui', 'dist');
  },

  /**
   * --- GitHub App (forge credential exchange) ---
   *
   * When these are set the broker exchanges each authorization decision for
   * a real, repository-scoped GitHub App installation token. When they are
   * not, the broker issues AgentGate session tokens only and behaves exactly
   * as it did before the exchange existed. `githubAppConfigured` is the
   * single switch every caller reads, so "unconfigured" is one condition
   * rather than four scattered null checks.
   */
  get githubAppId() {
    return str('AGENTGATE_GITHUB_APP_ID');
  },
  get githubInstallationId() {
    return str('AGENTGATE_GITHUB_INSTALLATION_ID');
  },
  get githubPrivateKey() {
    const inline = str('AGENTGATE_GITHUB_PRIVATE_KEY');
    return inline ? inline.replace(/\\n/g, '\n') : null;
  },
  get githubPrivateKeyPath() {
    return str('AGENTGATE_GITHUB_PRIVATE_KEY_PATH');
  },
  /** The account the installation belongs to. Bare repository names resolve
   *  against it, so a mismatch is a scope-escalation attempt, not a typo. */
  get githubOwner() {
    return str('AGENTGATE_GITHUB_OWNER');
  },
  /** GitHub Enterprise Server API root. Unset means github.com. */
  get githubApiBaseUrl() {
    return str('AGENTGATE_GITHUB_API_BASE_URL');
  },
  /** Upper bound on the token-exchange call, so a stalled GitHub API becomes
   *  a prompt denial rather than a hung `git push`. */
  get githubMintTimeoutMs() {
    return int('AGENTGATE_GITHUB_MINT_TIMEOUT_MS', 8000);
  },

  get githubAppConfigured() {
    return !!(
      config.githubAppId &&
      config.githubInstallationId &&
      config.githubOwner &&
      (config.githubPrivateKey || config.githubPrivateKeyPath)
    );
  },

  /** 'debug' | 'info' | 'warn' | 'error' */
  get logLevel() {
    return str('AGENTGATE_LOG_LEVEL', 'info');
  },

  get env() {
    return str('NODE_ENV', 'development');
  },

  get isProduction() {
    return this.env === 'production';
  },
};

/** Throws unless the current environment is safe to run in production. */
function assertProductionSafe() {
  const problems = [];
  if (!config.adminToken) {
    problems.push('AGENTGATE_ADMIN_TOKEN must be set (admin endpoints are disabled without it)');
  } else if (config.adminToken.length < 32) {
    problems.push('AGENTGATE_ADMIN_TOKEN must be at least 32 characters');
  }
  if (config.tokenTtlMs > 60 * 60 * 1000) {
    problems.push('AGENTGATE_TOKEN_TTL_MS exceeds 1 hour — short-lived tokens are a core guarantee');
  }
  if (config.host === '0.0.0.0' && !process.env.AGENTGATE_ALLOW_PUBLIC_BIND) {
    problems.push(
      'Broker is bound to 0.0.0.0 — terminate TLS in front of it and set AGENTGATE_ALLOW_PUBLIC_BIND=1 to confirm this is intended'
    );
  }
  // --- GitHub App: partial configuration is the dangerous state ---
  // All-unset is a supported deployment (session tokens only). Some-set means
  // an operator intended the exchange and it will fail at the first push,
  // long after the deploy that broke it.
  const githubVars = {
    AGENTGATE_GITHUB_APP_ID: config.githubAppId,
    AGENTGATE_GITHUB_INSTALLATION_ID: config.githubInstallationId,
    AGENTGATE_GITHUB_OWNER: config.githubOwner,
  };
  const keyConfigured = config.githubPrivateKey || config.githubPrivateKeyPath;
  const anyGithub = keyConfigured || Object.values(githubVars).some(Boolean);
  if (anyGithub) {
    for (const [name, value] of Object.entries(githubVars)) {
      if (!value) problems.push(`${name} must be set when any AGENTGATE_GITHUB_* variable is`);
    }
    if (!keyConfigured) {
      problems.push(
        'AGENTGATE_GITHUB_PRIVATE_KEY_PATH (preferred) or AGENTGATE_GITHUB_PRIVATE_KEY must be set when any AGENTGATE_GITHUB_* variable is'
      );
    } else if (config.githubPrivateKeyPath) {
      // Read it now: a private key that is missing or unreadable by this uid
      // must surface at boot, not on the first developer's first push.
      try {
        const pem = fs.readFileSync(config.githubPrivateKeyPath, 'utf8');
        if (!pem.includes('PRIVATE KEY')) {
          problems.push(`AGENTGATE_GITHUB_PRIVATE_KEY_PATH does not look like a PEM private key: ${config.githubPrivateKeyPath}`);
        }
        const mode = fs.statSync(config.githubPrivateKeyPath).mode & 0o077;
        if (mode !== 0) {
          problems.push(
            `AGENTGATE_GITHUB_PRIVATE_KEY_PATH is readable by group or others — chmod 600 ${config.githubPrivateKeyPath}`
          );
        }
      } catch (err) {
        problems.push(`AGENTGATE_GITHUB_PRIVATE_KEY_PATH is not readable: ${err.message}`);
      }
    }
  }

  if (problems.length) {
    throw new Error(`Unsafe production configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

module.exports = { config, assertProductionSafe };

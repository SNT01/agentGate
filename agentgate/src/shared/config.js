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
  if (problems.length) {
    throw new Error(`Unsafe production configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

module.exports = { config, assertProductionSafe };

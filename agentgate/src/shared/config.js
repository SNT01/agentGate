'use strict';
/**
 * Centralised configuration, read from the environment.
 *
 * Values are exposed as getters that read `process.env` on each access
 * rather than being snapshotted at require time. That means a rotated
 * secret (notably AGENTGATE_ADMIN_TOKEN) takes effect without a restart,
 * and callers cannot accidentally depend on module load order.
 *
 * A `.env` file (if present) is loaded into `process.env` at require time,
 * with real environment variables always taking precedence.
 *
 * Two startup checks, in increasing strictness:
 *  - `validateConfig()` reads every value and returns the parse failures. Run
 *    in every environment, because laziness otherwise defers a typo to
 *    whichever request first touches the variable.
 *  - `assertProductionSafe()` additionally enforces the deployment rules that
 *    only matter in production, and throws.
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

/**
 * Parse a dotenv-style file. Deliberately hand-rolled: the broker ships with
 * no runtime dependencies, and the subset of the format that matters here is
 * small — `KEY=value`, `export KEY=value`, `#` comments, and single- or
 * double-quoted values (escapes expanded only inside double quotes, matching
 * every other dotenv implementation).
 *
 * Unparseable lines are returned as `problems` rather than thrown: a stray
 * line in a config file should be reported with its line number, not crash
 * the process before the logger exists.
 */
function parseEnvFile(text) {
  const values = {};
  const problems = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) {
      problems.push(`line ${i + 1}: expected KEY=value, got "${line}"`);
      continue;
    }

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      problems.push(`line ${i + 1}: "${key}" is not a valid environment variable name`);
      continue;
    }

    let value = withoutExport.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      // Unquoted: an inline comment ends the value.
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    values[key] = value;
  }

  return { values, problems };
}

/**
 * Load `.env` into `process.env`. Real environment variables always win, so
 * a container's `-e` flags override the file rather than the other way round.
 *
 * This exists because `env.example.txt` told people to "copy to .env" for a
 * long time while nothing read it — a broker that silently ran on defaults.
 * Called once at require time; `loadedEnvFile` records what was used so
 * `agentgate doctor` and the startup log can say so.
 */
const envFileState = { path: null, problems: [], applied: [] };

function loadEnvFile() {
  const explicit = process.env.AGENTGATE_ENV_FILE;
  const candidates = explicit
    ? [explicit]
    : [path.join(process.cwd(), '.env'), path.join(REPO_ROOT, '.env')];

  for (const candidate of candidates) {
    let text;
    try {
      text = fs.readFileSync(candidate, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      // An unreadable file the operator explicitly pointed at is worth
      // surfacing; a permissions problem here means the config they think is
      // loaded is not.
      envFileState.problems.push(`${candidate} is not readable: ${err.message}`);
      continue;
    }

    const { values, problems } = parseEnvFile(text);
    envFileState.path = candidate;
    envFileState.problems = problems.map((p) => `${candidate} ${p}`);
    for (const [key, value] of Object.entries(values)) {
      // An empty variable counts as unset, matching `str()`/`int()` below.
      // Otherwise an exported-but-blank variable would shadow the file while
      // every reader treated it as absent.
      const current = process.env[key];
      if (current === undefined || current === '') {
        process.env[key] = value;
        envFileState.applied.push(key);
      }
    }
    return envFileState;
  }

  if (explicit) {
    envFileState.problems.push(`AGENTGATE_ENV_FILE points at a file that does not exist: ${explicit}`);
  }
  return envFileState;
}

loadEnvFile();

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

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

/**
 * Parse a boolean environment variable strictly.
 *
 * The strictness is the point. `AGENTGATE_ALLOW_PUBLIC_BIND` used to be read
 * as raw truthiness, so `=0` and `=false` both *satisfied* the confirmation
 * that a public bind was intended — the one guard whose whole job is to be an
 * explicit opt-in accepted its own negation. Meanwhile `AGENTGATE_UI_ENABLED`
 * accepted only `1`/`true`, so `=yes` silently disabled the dashboard.
 *
 * Anything outside the two vocabularies throws rather than guessing, because
 * a typo in a security switch must not resolve to a default.
 */
function bool(name, fallback = null) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  throw new Error(
    `Invalid ${name}: expected one of 1/true/yes/on or 0/false/no/off, got "${raw}"`
  );
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

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
    const explicit = bool('AGENTGATE_UI_ENABLED');
    if (explicit === null) return !!config.adminToken;
    return explicit;
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
    const raw = str('AGENTGATE_LOG_LEVEL', 'info');
    const normalized = String(raw).trim().toLowerCase();
    if (!LOG_LEVELS.includes(normalized)) {
      // Previously a typo fell through to `info`, so `warning` silently meant
      // "log everything" — the opposite of what the operator asked for.
      throw new Error(
        `Invalid AGENTGATE_LOG_LEVEL: expected one of ${LOG_LEVELS.join(', ')}, got "${raw}"`
      );
    }
    return normalized;
  },

  /**
   * Explicit confirmation that a non-loopback bind is intended, checked by
   * `assertProductionSafe`. Strict boolean: see `bool()`.
   */
  get allowPublicBind() {
    return bool('AGENTGATE_ALLOW_PUBLIC_BIND', false);
  },

  get env() {
    return str('NODE_ENV', 'development');
  },

  get isProduction() {
    return this.env === 'production';
  },

  /** Which `.env` file was loaded, if any, and anything wrong with it. */
  get envFile() {
    return { path: envFileState.path, problems: envFileState.problems.slice() };
  },
};

/**
 * Every value that can fail to parse, in one list. `validateConfig` touches
 * each one so a bad value surfaces at boot rather than at the first request
 * that happens to read it.
 */
const VALIDATED_KEYS = [
  'dataDir', 'port', 'host', 'tokenTtlMs', 'agentCardTtlMs', 'nonceWindowMs',
  'maxBodyBytes', 'adminToken', 'uiEnabled', 'uiAssetRoot', 'githubAppId',
  'githubInstallationId', 'githubPrivateKey', 'githubPrivateKeyPath',
  'githubOwner', 'githubApiBaseUrl', 'githubMintTimeoutMs', 'logLevel',
  'allowPublicBind', 'env',
];

/**
 * Read every configuration value once, collecting parse failures.
 *
 * The getters are lazy by design (so a rotated admin token takes effect
 * without a restart), but laziness meant an invalid
 * `AGENTGATE_MAX_BODY_BYTES` threw inside the request handler, where
 * `server.js` converts any 500 into an opaque `{"error":"internal error"}`.
 * The operator saw a broken broker; the message naming the variable went only
 * to the log. Touching everything at startup moves that to boot, where it
 * belongs.
 *
 * @returns {string[]} problems, empty when the configuration parses cleanly
 */
function validateConfig() {
  const problems = [...envFileState.problems];
  for (const key of VALIDATED_KEYS) {
    try {
      void config[key];
    } catch (err) {
      problems.push(err.message);
    }
  }
  return problems;
}

/** Throws unless the current environment is safe to run in production. */
function assertProductionSafe() {
  // Parse failures first and alone: the checks below read these same values,
  // so continuing past an unparseable one would throw a bare error instead of
  // the collected report.
  const parseProblems = validateConfig();
  if (parseProblems.length) {
    throw new Error(`Unsafe production configuration:\n  - ${parseProblems.join('\n  - ')}`);
  }

  const problems = [];
  if (!config.adminToken) {
    problems.push('AGENTGATE_ADMIN_TOKEN must be set (admin endpoints are disabled without it)');
  } else if (config.adminToken.length < 32) {
    problems.push('AGENTGATE_ADMIN_TOKEN must be at least 32 characters');
  }
  if (config.tokenTtlMs > 60 * 60 * 1000) {
    problems.push('AGENTGATE_TOKEN_TTL_MS exceeds 1 hour — short-lived tokens are a core guarantee');
  }
  if (config.host === '0.0.0.0' && !config.allowPublicBind) {
    problems.push(
      'Broker is bound to 0.0.0.0 — terminate TLS in front of it and set AGENTGATE_ALLOW_PUBLIC_BIND=true to confirm this is intended'
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

module.exports = { config, assertProductionSafe, validateConfig, parseEnvFile };

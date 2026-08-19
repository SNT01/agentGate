'use strict';
/**
 * Client-side identity: where a developer's (or agent's) credentials live on
 * the machine that pushes code.
 *
 * Until now the only answer was "export five environment variables", which in
 * practice meant pasting an Ed25519 private key into a shell profile — a
 * world-readable file, backed up and synced, in every shell the user opens.
 * Git also does not run the credential helper with the user's interactive
 * environment in every context, so the variables were frequently absent
 * exactly when the helper needed them.
 *
 * So there are two sources, in this order:
 *
 *   1. Environment variables — unchanged, and still authoritative. CI sets
 *      them, and an agent process may want a different identity per run.
 *   2. `~/.config/agentgate/credentials.json`, mode 0600, written by
 *      `agentgate setup-client`.
 *
 * Environment first means nothing that works today stops working, and a
 * temporary override is a matter of prefixing one command.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Honours XDG_CONFIG_HOME, falling back to ~/.config. */
function configDir() {
  if (process.env.AGENTGATE_CLIENT_CONFIG_DIR) return process.env.AGENTGATE_CLIENT_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'agentgate');
}

function credentialsPath() {
  return path.join(configDir(), 'credentials.json');
}

/** Read the stored credentials, or `{}` when there are none. Never throws. */
function loadStored() {
  try {
    return JSON.parse(fs.readFileSync(credentialsPath(), 'utf8')) || {};
  } catch (_err) {
    // Missing, unreadable, or corrupt all mean the same thing to a caller:
    // fall back to the environment. A corrupt file is surfaced by `doctor`.
    return {};
  }
}

/**
 * Write credentials at mode 0600.
 *
 * The file holds a private key, so the directory is 0700 and the file is
 * written to a temp name and renamed — a crash must not leave a half-written
 * key where the helper will read it.
 */
function saveStored(values) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = credentialsPath();
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(values, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, target);
  return target;
}

/**
 * The identity the credential helper should act as: environment variables
 * first, then the stored file.
 *
 * @returns {{humanId, humanPrivateKey, agentCardId, agentPrivateKey, context,
 *            brokerUrl, source: {humanId: 'env'|'file'|'none', ...}}}
 */
function resolveIdentity() {
  const stored = loadStored();
  const source = {};

  const pick = (envName, storedKey) => {
    const fromEnv = process.env[envName];
    if (fromEnv !== undefined && fromEnv !== '') {
      source[storedKey] = 'env';
      return fromEnv;
    }
    if (stored[storedKey] !== undefined && stored[storedKey] !== '' && stored[storedKey] !== null) {
      source[storedKey] = 'file';
      return stored[storedKey];
    }
    source[storedKey] = 'none';
    return null;
  };

  return {
    humanId: pick('AGENTGATE_HUMAN_ID', 'humanId'),
    humanPrivateKey: pick('AGENTGATE_HUMAN_PRIVATE_KEY', 'humanPrivateKey'),
    agentCardId: pick('AGENTGATE_AGENT_CARD_ID', 'agentCardId'),
    agentPrivateKey: pick('AGENTGATE_AGENT_PRIVATE_KEY', 'agentPrivateKey'),
    context: pick('AGENTGATE_CONTEXT', 'context') || 'office',
    brokerUrl: pick('AGENTGATE_BROKER_URL', 'brokerUrl'),
    source,
  };
}

module.exports = { configDir, credentialsPath, loadStored, saveStored, resolveIdentity };

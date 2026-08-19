'use strict';
/**
 * Structured JSON logging. One line per event, machine-parseable, so the
 * broker's decisions are greppable and shippable to any log aggregator
 * without a parsing layer.
 *
 * Security note: never log private keys, signatures, or raw tokens. The
 * `redact` helper strips the fields we never want persisted to logs.
 */
const { config } = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold() {
  // `config.logLevel` now rejects a value it cannot recognise, and startup
  // refuses to boot on one. Logging is the wrong place to re-litigate that:
  // if this is reached with a bad value (a library consumer that skipped the
  // startup check), log everything rather than nothing.
  try {
    return LEVELS[config.logLevel];
  } catch (_err) {
    return LEVELS.debug;
  }
}

const SECRET_KEYS = new Set([
  'privateKey', 'private_key', 'signature', 'humanSignature',
  'token', 'password', 'adminToken', 'secret',
  // Forge credentials. The primary defence is structural — the minted token
  // is a sibling of the session token and is never handed to anything that
  // persists or logs (see broker.js §"git" response field). This is the
  // second line, for the day someone logs the whole response by mistake.
  'git', 'forgeToken', 'installationToken', 'accessToken',
]);

function redact(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.has(k) ? '[redacted]' : redact(v);
  }
  return out;
}

function emit(level, message, fields) {
  if (LEVELS[level] < threshold()) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...redact(fields || {}),
  });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

module.exports = {
  debug: (m, f) => emit('debug', m, f),
  info: (m, f) => emit('info', m, f),
  warn: (m, f) => emit('warn', m, f),
  error: (m, f) => emit('error', m, f),
  redact,
};

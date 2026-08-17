'use strict';
/**
 * Read-only (plus one narrow write) admin API backing the dashboard.
 *
 * Every handler here assumes the caller has already run `isAuthorizedAdmin`
 * — these are plain functions, not route handlers, so they can be unit
 * tested without spinning up an HTTP server.
 *
 * Security rule that matters most in this file: a session's `signature`
 * field is a live, usable credential (the git credential helper hands it
 * straight to GitHub as a password — see src/cli/credentialHelper.js). It
 * must never leave this process. `logger.redact` already implements exactly
 * that stripping for structured logs; reusing it here means there is one
 * definition of "what counts as a secret", not two that can drift apart.
 */
const log = require('../shared/logger');

/** Humans and agent cards, with revocation state already folded in by the registry. */
function listIdentities(registry) {
  return {
    humans: registry.listHumans().map(log.redact),
    agents: registry.listAgentCards().map(log.redact),
  };
}

/** Live (unexpired) sessions, with credential material stripped. */
function listSessions(broker) {
  const sessions = broker.sessions.load();
  return { sessions: Object.values(sessions).map(log.redact) };
}

/**
 * Revoke a human or agent card, and — unlike a bare registry.revoke() call —
 * record the action on the audit chain. Revocation was previously silent:
 * it updated registry.json but left no trace, which was tolerable for a
 * CLI-only tool but not once revoking becomes a button in a browser. This
 * makes the dashboard's most consequential action also its most visible one.
 *
 * @returns {{revoked: string, cascadedTo: string[]}}
 */
function revokeIdentity(registry, broker, { id, reason }) {
  if (typeof id !== 'string' || !id) {
    throw Object.assign(new Error('id is required'), { statusCode: 400 });
  }
  let result;
  try {
    result = registry.revoke(id, reason);
  } catch (err) {
    throw Object.assign(new Error(err.message), { statusCode: 404 });
  }
  broker.recordAction({
    action: 'identity_revoked',
    revokedId: result.revoked,
    reason: reason || 'unspecified',
    cascadedTo: result.cascadedTo,
    outcome: 'applied',
  });
  return result;
}

module.exports = { listIdentities, listSessions, revokeIdentity };

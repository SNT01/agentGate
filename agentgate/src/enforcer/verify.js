'use strict';
/**
 * Commit verification — the logic behind the `agentgate/verified` status
 * check that gates every pull request.
 *
 * These are pure functions with no GitHub dependency, so the authorization
 * rules can be tested exhaustively without webhooks or credentials. The
 * GitHub wiring lives in `githubApp.js`.
 *
 * A commit is described by:
 *   {
 *     sha, authorId, isAgent, branch,
 *     payload,      // signed material, e.g. { sha, message }
 *     signature,    // author's signature over `payload`
 *     trailers?,    // { 'Agent-ID': ..., 'Sponsor': ... } for agent commits
 *     sessionId?,   // broker session the push was made under
 *   }
 */
const { verify: verifySignature } = require('../shared/crypto');
const { isActionAllowed } = require('../shared/capability');

/**
 * Verify one commit's authorization to land on its branch.
 * @param {object} commit
 * @param {import('../registry/registry').Registry} registry
 * @param {(sessionId: string) => object|null} [sessionLookup] optional
 *   broker-session lookup for defence in depth: proves the push happened
 *   under a live, in-scope session rather than merely being signable.
 */
function verifyCommit(commit, registry, sessionLookup) {
  if (!commit || typeof commit !== 'object') return { ok: false, reason: 'malformed commit record' };
  const { authorId, isAgent, branch, payload, signature, trailers, sessionId } = commit;

  if (!authorId) return { ok: false, reason: 'commit has no resolvable author identity' };
  if (!signature) return { ok: false, reason: 'commit is unsigned' };
  if (!branch) return { ok: false, reason: 'commit has no target branch' };

  if (isAgent) {
    const result = registry.verifyAgentCard(authorId);
    if (!result.valid) return { ok: false, reason: `agent card invalid: ${result.reason}` };
    const card = result.card;

    // Trailer consistency: a commit must self-declare the same agent and
    // sponsor as the card it is verified against, so a valid signature from
    // one agent cannot be presented under another agent's name.
    if (trailers) {
      if (trailers['Agent-ID'] && trailers['Agent-ID'] !== authorId) {
        return { ok: false, reason: 'Agent-ID trailer does not match the presented agent card' };
      }
      if (trailers['Sponsor'] && trailers['Sponsor'] !== card.sponsorId) {
        return { ok: false, reason: 'Sponsor trailer does not match the agent card sponsor' };
      }
    }

    if (!verifySignature(payload, signature, card.publicKey)) {
      return { ok: false, reason: 'commit signature does not verify against the agent card key' };
    }

    if (!isActionAllowed(card.capabilities, 'push', branch)) {
      return { ok: false, reason: `agent is not authorized to push to "${branch}"` };
    }

    if (sessionLookup) {
      if (!sessionId) return { ok: false, reason: 'commit carries no broker session id (unattributed push)' };
      const session = sessionLookup(sessionId);
      if (!session) return { ok: false, reason: 'no broker session found for this commit (unattributed push)' };
      if (session.agentCardId !== authorId) return { ok: false, reason: 'broker session belongs to a different agent' };
      if (!isActionAllowed(session.scope, 'push', branch)) {
        return { ok: false, reason: `broker session scope did not permit pushing to "${branch}"` };
      }
    }

    return { ok: true, actor: { type: 'agent', id: authorId, sponsorId: card.sponsorId, tool: card.tool } };
  }

  // --- Human commit path ---
  if (registry.isRevoked(authorId)) return { ok: false, reason: 'author identity has been revoked' };
  const human = registry.getHuman(authorId);
  if (!human) return { ok: false, reason: 'unknown or unenrolled author — signature cannot be verified' };
  if (!verifySignature(payload, signature, human.publicKey)) {
    return { ok: false, reason: 'commit signature does not verify against the enrolled author key' };
  }
  if (!isActionAllowed(human.capabilities, 'push', branch)) {
    return { ok: false, reason: `author is not authorized to push to "${branch}"` };
  }
  return { ok: true, actor: { type: 'human', id: authorId, name: human.name } };
}

/**
 * Verify every commit in a pull request. Returns the conclusion the
 * `agentgate/verified` check run should report, plus a human-readable
 * summary naming exactly which commits failed and why.
 */
function verifyPullRequest(commits, registry, sessionLookup) {
  if (!Array.isArray(commits) || commits.length === 0) {
    return { conclusion: 'failure', results: [], summary: 'No commits found to verify.' };
  }
  const results = commits.map((c) => ({ sha: c.sha, ...verifyCommit(c, registry, sessionLookup) }));
  const failed = results.filter((r) => !r.ok);
  return {
    conclusion: failed.length === 0 ? 'success' : 'failure',
    results,
    summary:
      failed.length === 0
        ? `All ${results.length} commit(s) verified.`
        : `${failed.length}/${results.length} commit(s) failed verification: ` +
          failed.map((f) => `${String(f.sha).slice(0, 7)} (${f.reason})`).join('; '),
  };
}

module.exports = { verifyCommit, verifyPullRequest };

'use strict';
/**
 * Token Broker — the gate every repository credential passes through.
 *
 * No human or agent holds a long-lived GitHub credential. Each request is
 * checked in three stages, and any failure denies the request outright:
 *
 *   1. Identity  — the human's signature verifies against their enrolled
 *                  key, they are not revoked, and (when an agent is acting)
 *                  its card verifies against the registry root and names
 *                  that same human as sponsor.
 *   2. Freshness — the request carries a recent timestamp and an unused
 *                  nonce, so a captured request cannot be replayed.
 *   3. Posture &  — the declared context is on the allowlist, and the issued
 *      capability   scope is the intersection of sponsor rights, agent card
 *                   ceiling, and repo policy. Scope is computed here, never
 *                   supplied by the caller, and intersection can only narrow.
 *
 * Every decision — grant or deny — is written to the tamper-evident audit
 * chain before the response is returned.
 */
const path = require('path');
const { Registry } = require('../registry/registry');
const { checkPosture } = require('./posture');
const { NonceStore } = require('./nonceStore');
const { intersectCapabilities, isEmptyCapabilitySet } = require('../shared/capability');
const { AuditChain } = require('../shared/auditChain');
const { generateKeyPair, randomId, sign, verify } = require('../shared/crypto');
const { JsonStore } = require('../shared/store');
const { mintInstallationToken, describeMintError } = require('./githubToken');
const { config } = require('../shared/config');
const log = require('../shared/logger');

/** Reject a promise that outlives `ms`, so a stalled forge API becomes a
 *  prompt denial rather than a `git push` that hangs until git gives up. */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      // Deliberately not unref'd: the timer is what guarantees this settles.
      // It is always cleared below, so it holds the loop for at most `ms`.
      timer = setTimeout(() => reject(Object.assign(new Error(message), { code: 'ETIMEDOUT' })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Repository names GitHub accepts: letters, digits, `.`, `_`, `-`. */
const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Reduce the request's `repository` to the bare names octokit's
 * `repositoryNames` expects, and refuse anything that would widen scope.
 *
 * Two rules carry weight:
 *
 *  - An absent repository throws a message naming `credential.useHttpPath`.
 *    Git only sends the repository path when that option is set, and this is
 *    the message that saves the next operator an hour.
 *  - An owner mismatch against AGENTGATE_GITHUB_OWNER throws. This is a
 *    security check, not tidiness: bare names resolve against the
 *    *installation's* account, so without it a request naming
 *    `attacker/api` would mint a token scoped to `yourorg/api`.
 */
function resolveForgeRepositories(req) {
  const raw = (req && req.repository) || process.env.AGENTGATE_REPOSITORY || null;
  if (!raw || typeof raw !== 'string') {
    throw new Error(
      'no repository in the credential request — set `git config --global credential.useHttpPath true` ' +
        'so git tells AgentGate which repository the credential is for, or set AGENTGATE_REPOSITORY'
    );
  }

  const parts = raw.trim().split('/').filter(Boolean);
  if (parts.length !== 2) {
    throw new Error(`repository must be in "owner/name" form, got "${raw}"`);
  }
  const owner = parts[0];
  const name = parts[1].replace(/\.git$/i, '');
  if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(name)) {
    throw new Error(`repository contains characters GitHub does not allow: "${raw}"`);
  }

  const expected = config.githubOwner;
  // GitHub logins are case-insensitive; a case difference is a legitimate
  // request, not an attack.
  if (expected && owner.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `repository owner "${owner}" is not the configured installation owner "${expected}" — refusing to mint a token`
    );
  }

  return { repositories: [name], repository: `${owner}/${name}` };
}

class TokenBroker {
  constructor(dataDir = config.dataDir, options = {}) {
    this.dataDir = dataDir;
    this.registry = options.registry || new Registry(dataDir);
    this.keyStore = new JsonStore(path.join(dataDir, 'broker-key.json'), null);
    let key = this.keyStore.load();
    if (!key) {
      key = generateKeyPair();
      this.keyStore.save(key);
    }
    this.keyPair = key;
    this.audit = new AuditChain(path.join(dataDir, 'audit.json'), this.keyPair);
    this.sessions = new JsonStore(path.join(dataDir, 'sessions.json'), {});
    this.nonces = options.nonceStore || new NonceStore();
    this.tokenTtlMs = options.tokenTtlMs || config.tokenTtlMs;
    // Injectable so the forge exchange is testable without GitHub credentials
    // and without a mocking library. `null` (the default) means "resolve from
    // configuration at call time", which keeps a rotated App configuration
    // from requiring a broker restart.
    this.mintForgeToken = options.mintForgeToken || null;
  }

  get publicKey() {
    return this.keyPair.publicKey;
  }

  /**
   * Request a scoped, short-lived session token.
   *
   * @param {object} req
   * @param {string} req.humanId          acting/sponsoring human's registry id
   * @param {string} req.humanSignature   signature over {humanId, nonce, timestamp}
   * @param {string} req.nonce            single-use freshness nonce
   * @param {number} req.timestamp        client clock, ms since epoch
   * @param {string} [req.agentCardId]    present when an AI agent is acting
   * @param {string} req.context          declared context, e.g. 'office'
   * @param {object} [req.repoPolicy]     repo-level capability ceiling
   * @returns {{granted: true, token: object} | {granted: false, reason: string}}
   */
  requestToken(req) {
    const { humanId, humanSignature, nonce, timestamp, agentCardId, context, repoPolicy } = req || {};

    // --- Input validation (reject malformed requests before any crypto) ---
    if (typeof humanId !== 'string' || !humanId) return this._deny({ context }, 'humanId is required');
    if (typeof humanSignature !== 'string' || !humanSignature) return this._deny({ humanId, context }, 'humanSignature is required');
    if (typeof context !== 'string' || !context) return this._deny({ humanId, context: null }, 'context is required');
    if (agentCardId !== undefined && agentCardId !== null && typeof agentCardId !== 'string') {
      return this._deny({ humanId, context }, 'agentCardId must be a string when present');
    }

    // --- Stage 2 (cheap): freshness, before signature verification ---
    const freshness = this.nonces.checkAndRecord(nonce, timestamp);
    if (!freshness.ok) return this._deny({ humanId, agentCardId, context }, `replay check failed: ${freshness.reason}`);

    // --- Stage 1: identity ---
    const human = this.registry.getHuman(humanId);
    if (!human) return this._deny({ humanId, agentCardId, context }, 'unknown human');
    if (this.registry.isRevoked(humanId)) return this._deny({ humanId, agentCardId, context }, 'human revoked');
    if (!this.registry.verifyHumanSignature(humanId, { humanId, nonce, timestamp }, humanSignature)) {
      return this._deny({ humanId, agentCardId, context }, 'invalid human signature');
    }

    let agentCard = null;
    if (agentCardId) {
      const result = this.registry.verifyAgentCard(agentCardId);
      if (!result.valid) return this._deny({ humanId, agentCardId, context }, `agent card invalid: ${result.reason}`);
      agentCard = result.card;
      if (agentCard.sponsorId !== humanId) {
        return this._deny({ humanId, agentCardId, context }, 'agent card sponsor mismatch');
      }
    }

    // --- Stage 3: posture ---
    // An agent is pinned to the single context its card was issued for; a
    // human may act from any context on their own allowlist.
    const allowedContexts = agentCard ? [agentCard.context] : human.allowedContexts;
    const posture = checkPosture(context, allowedContexts);
    if (!posture.allowed) return this._deny({ humanId, agentCardId, context }, `posture denied: ${posture.reason}`);

    // --- Stage 3: capability intersection ---
    const sets = [human.capabilities];
    if (agentCard) sets.push(agentCard.capabilities);
    if (repoPolicy) sets.push(repoPolicy);
    const scope = intersectCapabilities(...sets);
    if (isEmptyCapabilitySet(scope)) {
      return this._deny({ humanId, agentCardId, context }, 'empty capability intersection (nothing would be granted)');
    }

    const sessionId = randomId('session');
    const issuedAt = Date.now();
    const expiresAt = issuedAt + this.tokenTtlMs;

    // The broker-signed session token below is what downstream AgentGate
    // components verify offline. In a GitHub deployment the caller uses
    // `requestTokenWithForgeCredential` instead, which wraps this method and
    // additionally exchanges the decision for a real, scope-limited GitHub
    // App installation token (see src/broker/githubToken.js).
    const tokenPayload = {
      sessionId,
      humanId,
      agentCardId: agentCardId || null,
      scope,
      context,
      issuedAt,
      expiresAt,
    };
    const token = { ...tokenPayload, signature: sign(tokenPayload, this.keyPair.privateKey) };

    this._recordSession(token);

    this.audit.append({
      action: 'token_issued',
      humanId,
      agentCardId: agentCardId || null,
      tool: agentCard ? agentCard.tool : null,
      context,
      sessionId,
      scope,
      outcome: 'granted',
    });
    log.info('token issued', { humanId, agentCardId: agentCardId || null, context, sessionId, scope });

    return { granted: true, token };
  }

  /**
   * Request a session token *and* a forge credential git can actually use.
   *
   * `requestToken` above is deliberately synchronous — the authorization
   * decision involves no I/O, and keeping it that way lets the test suite
   * read as a security specification with no async plumbing in the way.
   * Minting is I/O, so it lives here, in a sibling the HTTP layer calls.
   *
   * The minted credential is returned as `git`, a *sibling* of `token`,
   * never a field inside it. Two properties follow, both load-bearing:
   *
   *   - `verifySessionToken` verifies the broker signature over every field
   *     of `token` except `signature`. A new key inside `token` would
   *     silently invalidate every session token in flight.
   *   - `_recordSession` persists `token` alone, so the forge credential is
   *     *structurally* incapable of reaching sessions.json or
   *     GET /admin/sessions — stronger than remembering to redact it.
   *
   * @param {object} req  as `requestToken`, plus `repository` ("owner/name"),
   *                      `forgeHost`, and `forgeProtocol` from the helper.
   * @returns {Promise<{granted: true, token: object, git?: object} | {granted: false, reason: string}>}
   */
  async requestTokenWithForgeCredential(req) {
    const decision = this.requestToken(req);
    if (!decision.granted) return decision;

    const mint = this._resolveMint();
    if (!mint) return decision; // no forge configured — unchanged behaviour

    let repositories;
    let repository;
    try {
      ({ repositories, repository } = resolveForgeRepositories(req));
    } catch (err) {
      return this._denyIssued(decision, err.message);
    }

    let minted;
    try {
      minted = await withTimeout(
        mint({ scope: decision.token.scope, repositories }),
        config.githubMintTimeoutMs,
        'GitHub token exchange timed out'
      );
    } catch (err) {
      return this._denyIssued(decision, describeMintError(err));
    }

    if (!minted || !minted.token) {
      return this._denyIssued(decision, 'GitHub token exchange returned no token');
    }

    this.audit.append({
      action: 'forge_token_issued',
      humanId: decision.token.humanId,
      agentCardId: decision.token.agentCardId,
      context: decision.token.context,
      sessionId: decision.token.sessionId,
      repository,
      permissions: minted.permissions || null,
      // The forge token expires on GitHub's schedule (~1 hour), not
      // AgentGate's. Recording both makes the divergence auditable rather
      // than folklore — see README §"What the forge credential does not bound".
      forgeExpiresAt: minted.expiresAt || null,
      sessionExpiresAt: new Date(decision.token.expiresAt).toISOString(),
      // GitHub tokens are repository-scoped, never branch-scoped. The branch
      // half of the granted scope is enforced by the enforcer and by branch
      // protection; recording it here keeps that boundary visible.
      branchScope: decision.token.scope.branches,
      outcome: 'granted',
    });
    log.info('forge token issued', {
      sessionId: decision.token.sessionId,
      repository,
      permissions: minted.permissions || null,
      forgeExpiresAt: minted.expiresAt || null,
    });

    return {
      granted: true,
      token: decision.token,
      git: {
        username: 'x-access-token',
        password: minted.token,
        expiresAt: minted.expiresAt || null,
        permissions: minted.permissions || null,
        repositories,
      },
    };
  }

  /** The mint function to use, or null when no forge is configured. */
  _resolveMint() {
    if (this.mintForgeToken) return this.mintForgeToken;
    return config.githubAppConfigured ? mintInstallationToken : null;
  }

  /**
   * Turn an already-granted decision into a denial.
   *
   * Ordering matters. The session is dropped first: a live session with no
   * usable credential would lie to the enforcer and to /admin/sessions. The
   * earlier `token_issued` entry is deliberately *not* rewritten — the chain
   * is tamper-evident by construction, and two entries recording what
   * actually happened are the correct history, not a bug to paper over.
   */
  _denyIssued(decision, reason) {
    this._dropSession(decision.token.sessionId);
    this.audit.append({
      action: 'forge_exchange_failed',
      humanId: decision.token.humanId,
      agentCardId: decision.token.agentCardId,
      context: decision.token.context,
      sessionId: decision.token.sessionId,
      reason,
      outcome: 'denied',
    });
    log.warn('forge exchange failed', { sessionId: decision.token.sessionId, reason });
    return { granted: false, reason };
  }

  _dropSession(sessionId) {
    const sessions = this.sessions.load();
    if (sessions[sessionId]) {
      delete sessions[sessionId];
      this.sessions.save(sessions);
    }
  }

  _recordSession(token) {
    const sessions = this.sessions.load();
    const now = Date.now();
    // Prune expired sessions on write so the file cannot grow unbounded.
    for (const [id, s] of Object.entries(sessions)) {
      if (!s || s.expiresAt <= now) delete sessions[id];
    }
    sessions[token.sessionId] = token;
    this.sessions.save(sessions);
  }

  _deny(who, reason) {
    this.audit.append({ action: 'token_denied', ...who, reason, outcome: 'denied' });
    log.warn('token denied', { ...who, reason });
    return { granted: false, reason };
  }

  /** Verify a session token offline: broker signature + expiry + not revoked. */
  verifySessionToken(token) {
    if (!token || typeof token !== 'object') return { valid: false, reason: 'malformed token' };
    const { signature, ...body } = token;
    if (!verify(body, signature, this.keyPair.publicKey)) return { valid: false, reason: 'invalid broker signature' };
    if (Date.now() > body.expiresAt) return { valid: false, reason: 'token expired' };
    if (this.registry.isRevoked(body.humanId)) return { valid: false, reason: 'human revoked since issuance' };
    if (body.agentCardId && !this.registry.verifyAgentCard(body.agentCardId).valid) {
      return { valid: false, reason: 'agent card invalid since issuance' };
    }
    return { valid: true, body };
  }

  getSession(sessionId) {
    return this.sessions.load()[sessionId] || null;
  }

  /** Record a repository action (push, PR, review) against the audit chain. */
  recordAction(entry) {
    return this.audit.append(entry);
  }
}

module.exports = { TokenBroker, resolveForgeRepositories };

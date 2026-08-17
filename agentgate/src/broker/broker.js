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
const { config } = require('../shared/config');
const log = require('../shared/logger');

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

    // In a GitHub deployment this is where the broker exchanges the verified
    // decision for a real, scope-limited GitHub App installation token (see
    // src/broker/githubToken.js). The broker-signed session token below is
    // what downstream AgentGate components verify offline.
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

module.exports = { TokenBroker };

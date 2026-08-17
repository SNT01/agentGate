'use strict';
/**
 * Identity Registry — AgentGate's root of trust.
 *
 * Responsibilities:
 *  - Hold the organisation's root signing key (analogous to a CA root).
 *  - Enroll humans, binding an org identity to a signing public key and the
 *    contexts they are allowed to act from.
 *  - Issue Agent Identity Cards (AICs). An AIC binds four independently
 *    meaningful facts about an AI agent — its sponsoring human, the tool and
 *    version it runs, who provisioned it, and the context it may run in —
 *    into one root-signed credential carrying a capability ceiling.
 *  - Revoke identities, with sponsor revocation cascading instantly to every
 *    agent card that sponsor issued.
 *
 * An agent card's capabilities are computed at issuance as
 * `sponsor_capabilities ∩ requested_capabilities`, so an agent can never
 * hold more authority than the human accountable for it.
 */
const path = require('path');
const { JsonStore } = require('../shared/store');
const { generateKeyPair, sign, verify, randomId } = require('../shared/crypto');
const { intersectCapabilities, isEmptyCapabilitySet } = require('../shared/capability');
const { config } = require('../shared/config');

const VALID_ACTIONS = ['push', 'pr:open', 'pr:comment', 'pr:approve', 'pr:merge', '*'];

function validateCapabilities(caps, label) {
  if (!caps || typeof caps !== 'object') throw new Error(`${label}: capabilities must be an object`);
  if (!Array.isArray(caps.branches) || caps.branches.length === 0) {
    throw new Error(`${label}: capabilities.branches must be a non-empty array`);
  }
  if (!Array.isArray(caps.actions) || caps.actions.length === 0) {
    throw new Error(`${label}: capabilities.actions must be a non-empty array`);
  }
  for (const a of caps.actions) {
    if (!VALID_ACTIONS.includes(a)) {
      throw new Error(`${label}: unknown action "${a}" (valid: ${VALID_ACTIONS.join(', ')})`);
    }
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required and must be a non-empty string`);
  }
  return value.trim();
}

class Registry {
  constructor(dataDir = config.dataDir) {
    this.rootKeyStore = new JsonStore(path.join(dataDir, 'registry-root-key.json'), null);
    this.store = new JsonStore(path.join(dataDir, 'registry.json'), {
      humans: {},
      agents: {},
      revoked: {},
    });
    this._ensureRootKey();
  }

  _ensureRootKey() {
    let key = this.rootKeyStore.load();
    if (!key) {
      key = generateKeyPair();
      this.rootKeyStore.save(key);
    }
    this.rootKeyPair = key;
  }

  get rootPublicKey() {
    return this.rootKeyPair.publicKey;
  }

  /**
   * Enroll a human. In production this runs immediately after a verified
   * SSO/OIDC callback, and `publicKey` is supplied by the caller's local
   * keychain — the registry should never see a private key. `generateKey`
   * is offered only for local development and single-machine trials.
   *
   * @returns {{humanId: string, privateKey?: string}} privateKey is present
   *   only when the registry generated the keypair (development path).
   */
  enrollHuman({ name, oidcSubject, allowedContexts, capabilities, publicKey }) {
    requireNonEmptyString(name, 'name');
    const caps = capabilities || {
      branches: ['*'],
      actions: ['push', 'pr:open', 'pr:comment', 'pr:approve'],
    };
    validateCapabilities(caps, 'enrollHuman');

    const contexts = allowedContexts && allowedContexts.length ? allowedContexts : ['office'];

    let generated = null;
    let pub = publicKey;
    if (!pub) {
      if (config.isProduction) {
        throw new Error(
          'enrollHuman requires a publicKey in production — generate the keypair locally (agentgate enroll) and register only the public key'
        );
      }
      generated = generateKeyPair();
      pub = generated.publicKey;
    }

    const id = randomId('human');
    const data = this.store.load();
    data.humans[id] = {
      id,
      name,
      oidcSubject: oidcSubject || `sso:${name}`,
      publicKey: pub,
      allowedContexts: contexts,
      capabilities: caps,
      enrolledAt: new Date().toISOString(),
    };
    this.store.save(data);

    return generated ? { humanId: id, privateKey: generated.privateKey } : { humanId: id };
  }

  /**
   * Issue an Agent Identity Card bound to a sponsoring human.
   * @returns {{agentCardId: string, card: object, privateKey?: string}}
   */
  issueAgentCard({ sponsorId, tool, operator, context, requestedCapabilities, publicKey, ttlMs }) {
    requireNonEmptyString(sponsorId, 'sponsorId');
    if (!tool || !tool.name) throw new Error('tool.name is required (e.g. { name: "claude-code", version: "2.4.0" })');
    requireNonEmptyString(context, 'context');
    validateCapabilities(requestedCapabilities, 'issueAgentCard');

    const data = this.store.load();
    const sponsor = data.humans[sponsorId];
    if (!sponsor) throw new Error(`Unknown sponsor: ${sponsorId}`);
    if (data.revoked[sponsorId]) throw new Error(`Sponsor ${sponsorId} is revoked`);
    if (!sponsor.allowedContexts.includes(context) && !sponsor.allowedContexts.includes('*')) {
      throw new Error(
        `Sponsor is not permitted to act from context "${context}" (allowed: ${sponsor.allowedContexts.join(', ')}) — an agent cannot be granted a context its sponsor lacks`
      );
    }

    const ceiling = intersectCapabilities(sponsor.capabilities, requestedCapabilities);
    if (isEmptyCapabilitySet(ceiling)) {
      throw new Error(
        'Requested capabilities do not overlap the sponsor\'s own capabilities — the resulting card would grant nothing'
      );
    }

    let generated = null;
    let pub = publicKey;
    if (!pub) {
      if (config.isProduction) {
        throw new Error(
          'issueAgentCard requires a publicKey in production — generate the agent keypair in the local keychain and register only the public key'
        );
      }
      generated = generateKeyPair();
      pub = generated.publicKey;
    }

    const id = randomId('agent');
    const card = {
      id,
      sponsorId,
      tool: { name: tool.name, version: tool.version || '0.0.0', packageHash: tool.packageHash || null },
      operator: operator || sponsorId,
      context,
      publicKey: pub,
      capabilities: ceiling,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (ttlMs || config.agentCardTtlMs)).toISOString(),
    };
    card.signature = sign(card, this.rootKeyPair.privateKey);

    data.agents[id] = card;
    this.store.save(data);

    return generated
      ? { agentCardId: id, card, privateKey: generated.privateKey }
      : { agentCardId: id, card };
  }

  getHuman(id) {
    return this.store.load().humans[id];
  }

  getAgentCard(id) {
    return this.store.load().agents[id];
  }

  listHumans() {
    const data = this.store.load();
    return Object.values(data.humans).map((h) => ({ ...h, revoked: !!data.revoked[h.id] }));
  }

  listAgentCards() {
    const data = this.store.load();
    return Object.values(data.agents).map((a) => ({
      ...a,
      revoked: !!data.revoked[a.id] || !!data.revoked[a.sponsorId],
    }));
  }

  /**
   * Verify an Agent Identity Card: root signature valid, not revoked,
   * sponsor not revoked (cascade), not expired.
   * @returns {{valid: true, card: object} | {valid: false, reason: string}}
   */
  verifyAgentCard(cardOrId) {
    const data = this.store.load();
    const card = typeof cardOrId === 'string' ? data.agents[cardOrId] : cardOrId;
    if (!card) return { valid: false, reason: 'unknown agent card' };
    if (data.revoked[card.id]) return { valid: false, reason: 'agent card revoked' };
    if (data.revoked[card.sponsorId]) return { valid: false, reason: 'sponsor revoked (cascaded)' };
    if (new Date(card.expiresAt) < new Date()) return { valid: false, reason: 'agent card expired' };
    const { signature, ...body } = card;
    if (!verify(body, signature, this.rootKeyPair.publicKey)) {
      return { valid: false, reason: 'invalid registry signature' };
    }
    return { valid: true, card };
  }

  verifyHumanSignature(humanId, payload, signature) {
    const data = this.store.load();
    const human = data.humans[humanId];
    if (!human || data.revoked[humanId]) return false;
    return verify(payload, signature, human.publicKey);
  }

  /**
   * Revoke a human or an agent card. Revoking a human cascades to every
   * card they sponsor — enforced live in `verifyAgentCard`, so the cascade
   * is instantaneous and needs no descendant walk.
   */
  revoke(id, reason) {
    const data = this.store.load();
    if (!data.humans[id] && !data.agents[id]) {
      throw new Error(`Unknown identity: ${id}`);
    }
    data.revoked[id] = { reason: reason || 'unspecified', at: new Date().toISOString() };
    this.store.save(data);
    const cascaded = Object.values(data.agents).filter((a) => a.sponsorId === id).map((a) => a.id);
    return { revoked: id, cascadedTo: cascaded };
  }

  isRevoked(id) {
    return !!this.store.load().revoked[id];
  }
}

module.exports = { Registry, VALID_ACTIONS };

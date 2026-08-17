'use strict';
/**
 * Tamper-evident audit log.
 *
 * Every entry embeds the hash of the previous entry, and every entry's hash
 * is signed with the broker's Ed25519 key. Editing any historical entry
 * breaks the chain from that point forward, and forging a replacement
 * requires the broker's private key. `verifyChain` reports the exact
 * sequence number where integrity fails.
 */
const { JsonStore } = require('./store');
const { sha256, sign, verify } = require('./crypto');

const GENESIS_HASH = '0'.repeat(64);

class AuditChain {
  constructor(filePath, brokerKeyPair) {
    this.store = new JsonStore(filePath, { entries: [] });
    this.keyPair = brokerKeyPair;
  }

  append(action) {
    const { entries } = this.store.load();
    const prevHash = entries.length ? entries[entries.length - 1].hash : GENESIS_HASH;
    const body = {
      seq: entries.length,
      timestamp: new Date().toISOString(),
      prev_hash: prevHash,
      ...action,
    };
    const hash = sha256(body);
    const signature = sign({ hash }, this.keyPair.privateKey);
    const entry = { ...body, hash, signature };
    entries.push(entry);
    this.store.save({ entries });
    return entry;
  }

  all() {
    return this.store.load().entries;
  }

  /** Most recent `limit` entries, newest last. */
  recent(limit = 100) {
    const { entries } = this.store.load();
    return entries.slice(-limit);
  }

  /**
   * Verifies, for every entry: (1) the prev_hash linkage, (2) the entry's
   * own hash over its body, (3) the broker's signature over that hash.
   * @returns {{valid: true, count: number} | {valid: false, brokenAt: number, reason: string}}
   */
  verifyChain(brokerPublicKey) {
    const { entries } = this.store.load();
    let expectedPrev = GENESIS_HASH;
    for (const entry of entries) {
      const { hash, signature, ...body } = entry;
      if (body.prev_hash !== expectedPrev) {
        return { valid: false, brokenAt: entry.seq, reason: 'prev_hash mismatch (chain broken or entry removed)' };
      }
      if (sha256(body) !== hash) {
        return { valid: false, brokenAt: entry.seq, reason: 'hash mismatch (entry content was modified)' };
      }
      if (!verify({ hash }, signature, brokerPublicKey)) {
        return { valid: false, brokenAt: entry.seq, reason: 'signature invalid (entry not signed by this broker)' };
      }
      expectedPrev = hash;
    }
    return { valid: true, count: entries.length };
  }
}

module.exports = { AuditChain, GENESIS_HASH };

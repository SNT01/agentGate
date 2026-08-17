'use strict';
/**
 * Replay protection.
 *
 * A signed token request proves the holder controls the private key — but
 * without freshness tracking, an attacker who captures one valid request
 * can replay it forever. This store closes that hole with two checks:
 *
 *   1. Timestamp window — the request must be recent (within nonceWindowMs).
 *      This bounds how long any captured request stays replayable AND how
 *      many nonces we must remember.
 *   2. Single use — a nonce already seen inside the window is rejected.
 *
 * Entries outside the window are pruned on write, so memory is bounded by
 * request rate × window, not by uptime.
 *
 * For multi-instance deployments, back this with Redis (SETNX + TTL); the
 * interface (`checkAndRecord`) is deliberately one method so that swap is
 * a single-file change.
 */
const { config } = require('../shared/config');

class NonceStore {
  constructor(windowMs = config.nonceWindowMs) {
    this.windowMs = windowMs;
    this.seen = new Map(); // nonce -> expiry timestamp (ms)
  }

  _prune(now) {
    for (const [nonce, expiry] of this.seen) {
      if (expiry <= now) this.seen.delete(nonce);
    }
  }

  /**
   * @returns {{ok: true} | {ok: false, reason: string}}
   */
  checkAndRecord(nonce, timestamp, now = Date.now()) {
    if (typeof nonce !== 'string' || nonce.length < 8) {
      return { ok: false, reason: 'missing or malformed nonce' };
    }
    if (!Number.isFinite(timestamp)) {
      return { ok: false, reason: 'missing or malformed request timestamp' };
    }

    const age = now - timestamp;
    if (age > this.windowMs) {
      return { ok: false, reason: `request too old (${Math.round(age / 1000)}s); replay window is ${Math.round(this.windowMs / 1000)}s` };
    }
    // Reject far-future timestamps: a client with a badly skewed clock (or an
    // attacker pre-minting requests) must not get an extended replay window.
    if (age < -this.windowMs) {
      return { ok: false, reason: 'request timestamp is in the future (check clock skew)' };
    }

    this._prune(now);

    if (this.seen.has(nonce)) {
      return { ok: false, reason: 'nonce already used (replay detected)' };
    }

    this.seen.set(nonce, timestamp + this.windowMs);
    return { ok: true };
  }

  get size() {
    return this.seen.size;
  }
}

module.exports = { NonceStore };

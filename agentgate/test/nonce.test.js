'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { NonceStore } = require('../src/broker/nonceStore');

test('a fresh nonce is accepted once', () => {
  const store = new NonceStore(60_000);
  const now = 1_000_000;
  assert.strictEqual(store.checkAndRecord('nonce_abcdef12', now, now).ok, true);
});

test('replaying the same nonce is rejected', () => {
  const store = new NonceStore(60_000);
  const now = 1_000_000;
  store.checkAndRecord('nonce_abcdef12', now, now);
  const replay = store.checkAndRecord('nonce_abcdef12', now, now + 1000);
  assert.strictEqual(replay.ok, false);
  assert.match(replay.reason, /replay/i);
});

test('a request older than the window is rejected', () => {
  const store = new NonceStore(60_000);
  const now = 1_000_000;
  const result = store.checkAndRecord('nonce_stale123', now - 120_000, now);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /too old/i);
});

test('a far-future timestamp is rejected (no extended replay window)', () => {
  const store = new NonceStore(60_000);
  const now = 1_000_000;
  const result = store.checkAndRecord('nonce_future12', now + 600_000, now);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /future/i);
});

test('malformed nonces and timestamps are rejected', () => {
  const store = new NonceStore(60_000);
  const now = 1_000_000;
  assert.strictEqual(store.checkAndRecord('', now, now).ok, false);
  assert.strictEqual(store.checkAndRecord('short', now, now).ok, false);
  assert.strictEqual(store.checkAndRecord('nonce_abcdef12', undefined, now).ok, false);
  assert.strictEqual(store.checkAndRecord('nonce_abcdef12', 'not-a-number', now).ok, false);
});

test('expired nonces are pruned so memory stays bounded', () => {
  const store = new NonceStore(1_000);
  const now = 1_000_000;
  for (let i = 0; i < 50; i++) store.checkAndRecord(`nonce_${String(i).padStart(8, '0')}`, now, now);
  assert.strictEqual(store.size, 50);
  // Advance well past the window; the next write prunes everything stale.
  store.checkAndRecord('nonce_ffffffff', now + 10_000, now + 10_000);
  assert.strictEqual(store.size, 1);
});

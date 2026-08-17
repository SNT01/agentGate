'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { generateKeyPair, sign, verify, sha256, canonicalize } = require('../src/shared/crypto');

test('a signature verifies with the matching public key only', () => {
  const a = generateKeyPair();
  const b = generateKeyPair();
  const payload = { hello: 'world', n: 1 };
  const sig = sign(payload, a.privateKey);
  assert.strictEqual(verify(payload, sig, a.publicKey), true);
  assert.strictEqual(verify(payload, sig, b.publicKey), false);
});

test('altering the payload invalidates the signature', () => {
  const { publicKey, privateKey } = generateKeyPair();
  const payload = { amount: 10 };
  const sig = sign(payload, privateKey);
  assert.strictEqual(verify({ amount: 11 }, sig, publicKey), false);
});

test('property order does not change the signature', () => {
  const { publicKey, privateKey } = generateKeyPair();
  const sig = sign({ a: 1, b: 2 }, privateKey);
  assert.strictEqual(verify({ b: 2, a: 1 }, sig, publicKey), true);
});

test('malformed signatures are rejected rather than throwing', () => {
  const { publicKey } = generateKeyPair();
  assert.strictEqual(verify({ a: 1 }, 'not-base64!!', publicKey), false);
  assert.strictEqual(verify({ a: 1 }, undefined, publicKey), false);
  assert.strictEqual(verify({ a: 1 }, '', publicKey), false);
});

// Regression: hashed records are persisted with JSON.stringify, which drops
// undefined-valued keys. If canonicalize kept them, a record's hash would
// change across a save/load round trip and every stored signature would
// fail to verify — which is exactly how the audit chain broke.
test('undefined-valued keys are omitted, matching JSON.stringify', () => {
  const withUndefined = { a: 1, b: undefined, c: 3 };
  const roundTripped = JSON.parse(JSON.stringify(withUndefined));

  assert.strictEqual(canonicalize(withUndefined), canonicalize(roundTripped));
  assert.strictEqual(sha256(withUndefined), sha256(roundTripped));
});

test('a signature survives a JSON save/load round trip', () => {
  const { publicKey, privateKey } = generateKeyPair();
  const record = { humanId: 'human_1', agentCardId: undefined, context: 'office' };
  const sig = sign(record, privateKey);
  const reloaded = JSON.parse(JSON.stringify(record));
  assert.strictEqual(verify(reloaded, sig, publicKey), true);
});

test('undefined array elements canonicalize as null, as JSON does', () => {
  assert.strictEqual(canonicalize([1, undefined, 3]), JSON.stringify([1, undefined, 3]));
});

test('hashing or signing an undefined value fails loudly', () => {
  const { privateKey } = generateKeyPair();
  assert.throws(() => sha256(undefined), /undefined/i);
  assert.throws(() => sign(undefined, privateKey), /undefined/i);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { AuditChain } = require('../src/shared/auditChain');
const { generateKeyPair } = require('../src/shared/crypto');
const { tempDataDir, cleanup } = require('./helpers');

function setup() {
  const dir = tempDataDir('audit');
  const keyPair = generateKeyPair();
  const file = path.join(dir, 'audit.json');
  return { dir, file, keyPair, chain: new AuditChain(file, keyPair) };
}

test('a clean chain verifies', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));
  for (let i = 0; i < 5; i++) s.chain.append({ action: 'token_issued', seqLabel: i });
  const result = s.chain.verifyChain(s.keyPair.publicKey);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.count, 5);
});

test('editing a historical entry is detected', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));
  for (let i = 0; i < 5; i++) s.chain.append({ action: 'token_issued', label: `entry-${i}` });

  const raw = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  raw.entries[2].label = 'tampered';
  fs.writeFileSync(s.file, JSON.stringify(raw, null, 2));

  const result = s.chain.verifyChain(s.keyPair.publicKey);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.brokenAt, 2);
  assert.match(result.reason, /modified/i);
});

test('deleting an entry breaks the chain', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));
  for (let i = 0; i < 5; i++) s.chain.append({ action: 'token_issued', label: `entry-${i}` });

  const raw = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  raw.entries.splice(2, 1);
  fs.writeFileSync(s.file, JSON.stringify(raw, null, 2));

  const result = s.chain.verifyChain(s.keyPair.publicKey);
  assert.strictEqual(result.valid, false);
  assert.match(result.reason, /prev_hash|chain/i);
});

test('an entry signed by a different key is detected', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));
  s.chain.append({ action: 'token_issued' });

  const other = generateKeyPair();
  const result = s.chain.verifyChain(other.publicKey);
  assert.strictEqual(result.valid, false);
  assert.match(result.reason, /signature/i);
});

test('recent() returns the newest entries', (t) => {
  const s = setup();
  t.after(() => cleanup(s.dir));
  for (let i = 0; i < 10; i++) s.chain.append({ action: 'x', label: `entry-${i}` });
  const recent = s.chain.recent(3);
  assert.strictEqual(recent.length, 3);
  assert.strictEqual(recent[2].label, 'entry-9');
});

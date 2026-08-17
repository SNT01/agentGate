'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { checkPosture, checkSourceIp, ipToInt } = require('../src/broker/posture');

test('a context on the allowlist is permitted', () => {
  assert.strictEqual(checkPosture('office', ['office', 'ci']).allowed, true);
});

test('a context off the allowlist is denied', () => {
  const result = checkPosture('home', ['office', 'ci']);
  assert.strictEqual(result.allowed, false);
  assert.match(result.reason, /not in the allowed set/i);
});

test('an empty or missing allowlist denies by default', () => {
  assert.strictEqual(checkPosture('office', []).allowed, false);
  assert.strictEqual(checkPosture('office', undefined).allowed, false);
  assert.strictEqual(checkPosture('', ['office']).allowed, false);
});

test('source IPs inside an office CIDR are permitted', () => {
  assert.strictEqual(checkSourceIp('10.1.2.3', ['10.0.0.0/8']).allowed, true);
  assert.strictEqual(checkSourceIp('203.0.113.7', ['203.0.113.7/32']).allowed, true);
});

test('source IPs outside every CIDR are denied', () => {
  const result = checkSourceIp('8.8.8.8', ['10.0.0.0/8', '192.168.0.0/16']);
  assert.strictEqual(result.allowed, false);
  assert.match(result.reason, /outside the allowed ranges/i);
});

test('IPv4-mapped IPv6 addresses are normalised, not silently denied', () => {
  // Node reports this form on dual-stack listeners; without normalisation
  // every office range would silently fail to match.
  assert.strictEqual(ipToInt('::ffff:10.1.2.3'), ipToInt('10.1.2.3'));
  assert.strictEqual(checkSourceIp('::ffff:10.1.2.3', ['10.0.0.0/8']).allowed, true);
});

test('an unconfigured or unparseable source is denied', () => {
  assert.strictEqual(checkSourceIp('10.0.0.1', []).allowed, false);
  assert.strictEqual(checkSourceIp('not-an-ip', ['10.0.0.0/8']).allowed, false);
});

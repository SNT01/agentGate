'use strict';
/**
 * The credential helper's parsers. No git, no network, no broker — just the
 * two functions that stand between git's stdin protocol and a correctly
 * scoped request.
 */
const test = require('node:test');
const assert = require('node:assert');
const { parseCredentialInput, parseRepository } = require('../src/cli/credentialHelper');

test('git credential input parses to key/value pairs', () => {
  const parsed = parseCredentialInput('protocol=https\nhost=github.com\npath=owner/repo.git\n');
  assert.deepStrictEqual(parsed, { protocol: 'https', host: 'github.com', path: 'owner/repo.git' });
});

test('a blank line terminates the request', () => {
  const parsed = parseCredentialInput('host=github.com\n\nhost=evil.example\n');
  assert.strictEqual(parsed.host, 'github.com', 'anything after the blank line is not part of this request');
});

test('multi-valued wwwauth[] keys are skipped rather than collapsed', () => {
  const parsed = parseCredentialInput('host=github.com\nwwwauth[]=Basic realm="a"\nwwwauth[]=Bearer\n');
  assert.ok(!('wwwauth[]' in parsed), 'keeping only the last value of a multi-valued key would be quietly wrong');
  assert.strictEqual(parsed.host, 'github.com');
});

test('malformed input never throws — a broken line must not break git push', () => {
  for (const input of ['', 'no-equals-sign\n', '=leading\n', null, undefined, 'a=b\r\n']) {
    assert.doesNotThrow(() => parseCredentialInput(input));
  }
  assert.strictEqual(parseCredentialInput('a=b\r\n').a, 'b', 'CRLF must not leak into the value');
});

test('repository paths normalise to owner/name', () => {
  assert.strictEqual(parseRepository('owner/repo.git'), 'owner/repo');
  assert.strictEqual(parseRepository('/owner/repo'), 'owner/repo');
  assert.strictEqual(parseRepository('owner/repo/'), 'owner/repo');
  assert.strictEqual(parseRepository('owner/repo.git?foo=1'), 'owner/repo');
  assert.strictEqual(parseRepository('owner/repo.git/info/refs'), 'owner/repo');
  assert.strictEqual(parseRepository('owner/REPO.GIT'), 'owner/REPO');
});

test('an unusable path returns null so the broker can name useHttpPath', () => {
  // Git omits `path` entirely unless credential.useHttpPath is set — this is
  // the single most common misconfiguration for this helper.
  for (const value of [undefined, null, '', '/', 'repo-with-no-owner', 42]) {
    assert.strictEqual(parseRepository(value), null);
  }
});

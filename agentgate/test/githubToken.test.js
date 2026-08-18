'use strict';
/**
 * Pure tests for the GitHub translation layer: no network, no credentials.
 * These cover the two things that are easy to get quietly wrong — the
 * permission mapping, and the error text a developer sees when a push fails.
 */
const test = require('node:test');
const assert = require('node:assert');
const { toGitHubPermissions, describeMintError } = require('../src/broker/githubToken');

test('permission mapping is conservative and never grants admin', () => {
  const readOnly = toGitHubPermissions({ actions: ['pr:comment'] });
  assert.strictEqual(readOnly.contents, 'read', 'no push in scope must not yield write access to contents');
  assert.strictEqual(readOnly.pull_requests, 'write');

  const pushOnly = toGitHubPermissions({ actions: ['push'] });
  assert.strictEqual(pushOnly.contents, 'write');
  assert.ok(!('pull_requests' in pushOnly), 'unrequested permissions must be omitted, not set to read');

  const nothing = toGitHubPermissions({ actions: [] });
  assert.deepStrictEqual(nothing, { metadata: 'read', contents: 'read' });

  for (const scope of [{ actions: ['*'] }, { actions: ['push', 'pr:approve'] }, {}, { actions: null }]) {
    const mapped = toGitHubPermissions(scope);
    assert.ok(
      !Object.values(mapped).includes('admin'),
      'no capability set may ever map to an admin permission'
    );
  }
});

test('`pr:approve` grants no more than `pr:comment` does', () => {
  // GitHub cannot separate approve from comment — both are pull_requests:write.
  // The human-only approval rule lives in the enforcer's review gate, and this
  // test exists so nobody later "fixes" the mapping to enforce it here.
  assert.deepStrictEqual(
    toGitHubPermissions({ actions: ['pr:approve', 'pr:comment'] }),
    toGitHubPermissions({ actions: ['pr:comment'] })
  );
});

test('every mint failure maps to a message naming the fix', () => {
  const cases = [
    [Object.assign(new Error('bad'), { status: 401 }), /APP_ID|private key|clock/i],
    [Object.assign(new Error('bad'), { status: 404 }), /INSTALLATION_ID|installed/i],
    [Object.assign(new Error('bad'), { status: 403 }), /permission/i],
    [Object.assign(new Error('bad'), { status: 422 }), /permission/i],
    [Object.assign(new Error('bad'), { code: 'ENOTFOUND' }), /unreachable/i],
    [Object.assign(new Error('bad'), { code: 'ETIMEDOUT' }), /unreachable|timed out/i],
    [Object.assign(new Error('bad'), { code: 'ECONNREFUSED' }), /unreachable|timed out/i],
    [new Error('GitHub App private key not configured — set AGENTGATE_GITHUB_PRIVATE_KEY_PATH'), /PRIVATE_KEY/],
    [Object.assign(new Error('bad'), { status: 500 }), /500/],
    [new Error('something unclassified'), /something unclassified/],
  ];
  for (const [err, pattern] of cases) {
    assert.match(describeMintError(err), pattern);
  }
});

test('a missing @octokit/auth-app is reported as an install instruction', { skip: hasOctokit() }, async () => {
  const { mintInstallationToken } = require('../src/broker/githubToken');
  await assert.rejects(
    () => mintInstallationToken({ scope: { actions: ['push'] }, repositories: ['api'] }),
    /npm install .*@octokit\/auth-app/
  );
});

test('minting refuses to fall back to an installation-wide token', async () => {
  const { mintInstallationToken } = require('../src/broker/githubToken');
  if (!hasOctokit()) return; // the dependency check fires first; covered above
  await assert.rejects(
    () => mintInstallationToken({ scope: { actions: ['push'] }, repositories: [] }),
    /no repository was resolved/
  );
});

function hasOctokit() {
  try {
    require.resolve('@octokit/auth-app');
    return true;
  } catch (_e) {
    return false;
  }
}

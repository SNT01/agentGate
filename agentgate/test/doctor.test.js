'use strict';
/**
 * `agentgate doctor` — the diagnostic itself needs to be trustworthy.
 *
 * The check that carries the most weight is the git credential-helper chain.
 * Git accumulates helpers across configuration scopes, stops at the first that
 * answers, and treats an *empty* value as a reset of everything before it.
 * Getting that reset wrong in either direction is expensive: reporting a
 * working setup as broken sends the operator to fix nothing, and reporting a
 * shadowed setup as fine leaves them with an empty audit log and no
 * explanation.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runChecks, report, PASS, WARN, FAIL } = require('../src/cli/doctor');

/**
 * Run with `env` applied, then restore.
 *
 * Awaits `fn` inside the try: `runChecks` is async, and restoring the
 * environment when it merely *returned* its promise would undo the setup
 * before any check that follows an `await` ever reads it.
 */
async function withEnv(env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
}

/** Write a global gitconfig with the given credential.helper lines. */
function gitConfigWith(t, helperLines, extra = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-doctor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'gitconfig');
  const helpers = helperLines.map((l) => `\thelper = ${l}`).join('\n');
  fs.writeFileSync(file, `[credential]\n${helpers}\n${extra}\n`);
  return file;
}

const HELPER_PATH = path.resolve(__dirname, '..', 'src', 'cli', 'credentialHelper.js');

/** Find one named check in the grouped results. */
async function checkNamed(name, env) {
  const groups = await withEnv(env, () => runChecks({ scope: 'client' }));
  const all = groups.flatMap((g) => g.results);
  const found = all.find((r) => r.name === name);
  assert.ok(found, `expected a check named "${name}", got ${all.map((r) => r.name).join(', ')}`);
  return found;
}

test('an empty helper entry resets the chain ahead of AgentGate', async (t) => {
  // This is the documented macOS fix: the inherited osxkeychain entry is
  // discarded by the empty reset, so AgentGate really does answer first.
  const file = gitConfigWith(t, ['osxkeychain', '', `!node ${HELPER_PATH}`]);
  const result = await checkNamed('git credential helper', { GIT_CONFIG_GLOBAL: file });
  assert.strictEqual(result.status, PASS, `expected pass, got ${result.status}: ${result.detail}`);
});

test('a helper ahead of AgentGate is reported as shadowing it', async (t) => {
  const file = gitConfigWith(t, ['osxkeychain', `!node ${HELPER_PATH}`]);
  const result = await checkNamed('git credential helper', { GIT_CONFIG_GLOBAL: file });
  assert.strictEqual(result.status, FAIL);
  assert.match(result.detail, /osxkeychain/);
  assert.match(result.detail, /empty audit log/, 'the symptom is what makes this diagnosable');
  assert.match(result.fix, /credential\.helper ''/, 'the fix must include the empty reset');
});

test('a duplicated shadowing helper is named once', async (t) => {
  const file = gitConfigWith(t, ['osxkeychain', 'osxkeychain', `!node ${HELPER_PATH}`]);
  const result = await checkNamed('git credential helper', { GIT_CONFIG_GLOBAL: file });
  assert.strictEqual(result.status, FAIL);
  assert.strictEqual(result.detail.match(/osxkeychain/g).length, 1);
});

test('AgentGate missing from the chain is a failure naming the fix', async (t) => {
  const file = gitConfigWith(t, ['osxkeychain']);
  const result = await checkNamed('git credential helper', { GIT_CONFIG_GLOBAL: file });
  assert.strictEqual(result.status, FAIL);
  assert.match(result.detail, /not in git's helper chain/);
  assert.match(result.fix, /credentialHelper\.js/);
});

test('useHttpPath is required, but AGENTGATE_REPOSITORY substitutes for it', async (t) => {
  const withoutPath = gitConfigWith(t, [`!node ${HELPER_PATH}`]);
  const missing = await checkNamed('credential.useHttpPath', {
    GIT_CONFIG_GLOBAL: withoutPath,
    AGENTGATE_REPOSITORY: '',
  });
  assert.strictEqual(missing.status, FAIL);
  assert.match(missing.detail, /which repository/);

  const covered = await checkNamed('credential.useHttpPath', {
    GIT_CONFIG_GLOBAL: withoutPath,
    AGENTGATE_REPOSITORY: 'acme/api',
  });
  assert.strictEqual(covered.status, PASS, 'CI sets the repository explicitly instead');

  const set = gitConfigWith(t, [`!node ${HELPER_PATH}`], '\tuseHttpPath = true');
  const configured = await checkNamed('credential.useHttpPath', { GIT_CONFIG_GLOBAL: set });
  assert.strictEqual(configured.status, PASS);
});

test('client identity reports the acting agent card when one is set', async (t) => {
  const file = gitConfigWith(t, [`!node ${HELPER_PATH}`]);
  const asHuman = await checkNamed('client identity', {
    GIT_CONFIG_GLOBAL: file,
    AGENTGATE_HUMAN_ID: 'human_abc',
    AGENTGATE_HUMAN_PRIVATE_KEY: 'key',
    AGENTGATE_AGENT_CARD_ID: '',
  });
  assert.strictEqual(asHuman.status, PASS);
  assert.match(asHuman.detail, /no agent card/);

  const asAgent = await checkNamed('client identity', {
    GIT_CONFIG_GLOBAL: file,
    AGENTGATE_HUMAN_ID: 'human_abc',
    AGENTGATE_HUMAN_PRIVATE_KEY: 'key',
    AGENTGATE_AGENT_CARD_ID: 'agent_xyz',
  });
  assert.strictEqual(asAgent.status, PASS);
  assert.match(asAgent.detail, /agent_xyz/);
});

test('a partially configured GitHub App fails rather than warns', async () => {
  // All-unset is a supported deployment. Some-set means the operator intended
  // the exchange, and it would fail at the first push instead.
  const groups = await withEnv(
    { AGENTGATE_GITHUB_APP_ID: '12345', AGENTGATE_GITHUB_INSTALLATION_ID: '', AGENTGATE_GITHUB_OWNER: '' },
    () => runChecks({ scope: 'broker' })
  );
  const result = groups.flatMap((g) => g.results).find((r) => r.name === 'GitHub App');
  assert.strictEqual(result.status, FAIL);
  assert.match(result.detail, /partially configured/);
});

test('report() exits non-zero only for failures, not warnings', () => {
  const clean = report([{ title: 'T', results: [{ name: 'a', status: PASS, detail: 'ok' }] }]);
  assert.strictEqual(clean.failures, 0);
  assert.match(clean.text, /Everything checks out/);

  const warned = report([{ title: 'T', results: [{ name: 'a', status: WARN, detail: 'hmm' }] }]);
  assert.strictEqual(warned.failures, 0, 'a warning must not fail the command');
  assert.strictEqual(warned.warnings, 1);

  const failed = report([
    { title: 'T', results: [{ name: 'a', status: FAIL, detail: 'broken', fix: 'do this' }] },
  ]);
  assert.strictEqual(failed.failures, 1);
  assert.match(failed.text, /fix: do this/, 'a failure must always carry its fix');
});

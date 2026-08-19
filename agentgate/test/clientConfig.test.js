'use strict';
/**
 * Client-side identity resolution and `agentgate setup-client`.
 *
 * Two properties matter here. The first is precedence: environment variables
 * must keep winning over the stored file, or a CI job that sets them starts
 * silently pushing as whoever last ran `setup-client` on that machine. The
 * second is that the stored file holds an Ed25519 private key, so its
 * permissions are part of its correctness.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli', 'cli.js');
const { saveStored, loadStored, resolveIdentity, credentialsPath } = require('../src/cli/clientConfig');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-client-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function withEnv(env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
}

function runCli(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

test('a stored identity is written 0600 in a 0700 directory', (t) => {
  const dir = scratch(t);
  withEnv({ AGENTGATE_CLIENT_CONFIG_DIR: path.join(dir, 'cfg') }, () => {
    const written = saveStored({ humanId: 'human_abc', humanPrivateKey: 'secret-key' });
    // It holds a private key: anything group- or world-readable is a finding.
    assert.strictEqual(fs.statSync(written).mode & 0o077, 0);
    assert.strictEqual(fs.statSync(path.dirname(written)).mode & 0o077, 0);
    assert.deepStrictEqual(loadStored().humanId, 'human_abc');
  });
});

test('the environment overrides the stored file', (t) => {
  const dir = scratch(t);
  const cfg = path.join(dir, 'cfg');
  withEnv({ AGENTGATE_CLIENT_CONFIG_DIR: cfg }, () => {
    saveStored({ humanId: 'human_stored', humanPrivateKey: 'stored-key', context: 'office' });
  });

  withEnv(
    {
      AGENTGATE_CLIENT_CONFIG_DIR: cfg,
      AGENTGATE_HUMAN_ID: 'human_from_env',
      AGENTGATE_HUMAN_PRIVATE_KEY: 'env-key',
      AGENTGATE_CONTEXT: 'ci',
    },
    () => {
      const identity = resolveIdentity();
      assert.strictEqual(identity.humanId, 'human_from_env');
      assert.strictEqual(identity.context, 'ci');
      assert.strictEqual(identity.source.humanId, 'env');
    }
  );
});

test('the stored file is used when the environment is unset', (t) => {
  const dir = scratch(t);
  const cfg = path.join(dir, 'cfg');
  withEnv({ AGENTGATE_CLIENT_CONFIG_DIR: cfg }, () => {
    saveStored({ humanId: 'human_stored', humanPrivateKey: 'stored-key', agentCardId: 'agent_1' });
  });

  withEnv(
    {
      AGENTGATE_CLIENT_CONFIG_DIR: cfg,
      AGENTGATE_HUMAN_ID: '',
      AGENTGATE_HUMAN_PRIVATE_KEY: '',
      AGENTGATE_AGENT_CARD_ID: '',
      AGENTGATE_CONTEXT: '',
    },
    () => {
      const identity = resolveIdentity();
      assert.strictEqual(identity.humanId, 'human_stored');
      assert.strictEqual(identity.agentCardId, 'agent_1');
      assert.strictEqual(identity.source.humanId, 'file');
      assert.strictEqual(identity.context, 'office', 'context falls back to the documented default');
    }
  );
});

test('a corrupt credentials file falls back to the environment rather than throwing', (t) => {
  const dir = scratch(t);
  const cfg = path.join(dir, 'cfg');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'credentials.json'), '{ this is not json');

  withEnv({ AGENTGATE_CLIENT_CONFIG_DIR: cfg, AGENTGATE_HUMAN_ID: 'human_env', AGENTGATE_HUMAN_PRIVATE_KEY: 'k' }, () => {
    // A push must not fail because a config file got truncated.
    const identity = resolveIdentity();
    assert.strictEqual(identity.humanId, 'human_env');
  });
});

test('setup-client puts AgentGate first and resets the inherited chain', (t) => {
  const dir = scratch(t);
  const gitconfig = path.join(dir, 'gitconfig');
  // macOS ships osxkeychain in a broader scope; this is the state being fixed.
  fs.writeFileSync(gitconfig, '[credential]\n\thelper = osxkeychain\n');

  const result = runCli(['setup-client', '--human', 'human_abc', '--key', 'MC4Cfake'], {
    GIT_CONFIG_GLOBAL: gitconfig,
    AGENTGATE_CLIENT_CONFIG_DIR: path.join(dir, 'cfg'),
  });
  assert.strictEqual(result.status, 0, result.stderr);

  const written = fs.readFileSync(gitconfig, 'utf8');
  const helperLines = written.split('\n').filter((l) => l.includes('helper'));
  // The empty entry must come first: it is what discards osxkeychain.
  assert.match(helperLines[0], /helper\s*=\s*$/, `expected an empty reset first, got ${JSON.stringify(helperLines)}`);
  assert.match(helperLines[1], /credentialHelper\.js/);
  assert.ok(!written.includes('osxkeychain'), 'the displaced helper must not remain ahead of AgentGate');
  assert.match(written, /useHttpPath = true/);
  assert.match(result.stdout, /displaced: osxkeychain/);
});

test('setup-client does not clear the keychain unless asked', (t) => {
  const dir = scratch(t);
  const gitconfig = path.join(dir, 'gitconfig');
  fs.writeFileSync(gitconfig, '');

  const result = runCli(['setup-client', '--human', 'human_abc', '--key', 'MC4Cfake'], {
    GIT_CONFIG_GLOBAL: gitconfig,
    AGENTGATE_CLIENT_CONFIG_DIR: path.join(dir, 'cfg'),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  if (process.platform === 'darwin') {
    // Clearing it signs every other tool on the machine out of github.com, so
    // it is offered as a command, never performed silently.
    assert.match(result.stdout, /yours to decide/);
    assert.match(result.stdout, /git credential-osxkeychain erase/);
    assert.match(result.stdout, /--clear-keychain/);
  }
});

test('setup-client is idempotent and keeps a stored identity when re-run bare', (t) => {
  const dir = scratch(t);
  const gitconfig = path.join(dir, 'gitconfig');
  const cfg = path.join(dir, 'cfg');
  fs.writeFileSync(gitconfig, '[credential]\n\thelper = osxkeychain\n');
  const env = { GIT_CONFIG_GLOBAL: gitconfig, AGENTGATE_CLIENT_CONFIG_DIR: cfg };

  /**
   * The effective configuration, which is what git actually acts on. Asserting
   * on raw file bytes would fail on nothing: rewriting the helper list moves
   * `useHttpPath` further down the file without changing its value.
   */
  const effective = () => ({
    helpers: execFileSync('git', ['config', '--global', '--get-all', 'credential.helper'], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    }),
    useHttpPath: execFileSync('git', ['config', '--global', '--get', 'credential.useHttpPath'], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    }).trim(),
  });

  runCli(['setup-client', '--human', 'human_abc', '--key', 'MC4Cfake'], env);
  const first = effective();

  // Re-running to fix git configuration must not discard the identity, and
  // must not stack duplicate helper entries.
  const second = runCli(['setup-client'], env);
  assert.strictEqual(second.status, 0, second.stderr);
  assert.match(second.stdout, /Keeping the identity already stored/);
  assert.deepStrictEqual(effective(), first, 'a second run must not change the effective configuration');
  assert.strictEqual(
    (first.helpers.match(/credentialHelper\.js/g) || []).length,
    1,
    'the helper must appear exactly once, not accumulate'
  );

  const stored = JSON.parse(fs.readFileSync(path.join(cfg, 'credentials.json'), 'utf8'));
  assert.strictEqual(stored.humanId, 'human_abc');
  assert.strictEqual(stored.humanPrivateKey, 'MC4Cfake');
});

test('setup-client --dry-run changes nothing', (t) => {
  const dir = scratch(t);
  const gitconfig = path.join(dir, 'gitconfig');
  const cfg = path.join(dir, 'cfg');
  fs.writeFileSync(gitconfig, '[credential]\n\thelper = osxkeychain\n');

  const result = runCli(['setup-client', '--dry-run', '--human', 'human_abc', '--key', 'MC4Cfake'], {
    GIT_CONFIG_GLOBAL: gitconfig,
    AGENTGATE_CLIENT_CONFIG_DIR: cfg,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /would run: git config/);
  assert.match(fs.readFileSync(gitconfig, 'utf8'), /osxkeychain/, 'git config must be untouched');
  assert.strictEqual(fs.existsSync(path.join(cfg, 'credentials.json')), false, 'no credentials file either');
});

test('a private key without an identity is refused', (t) => {
  const dir = scratch(t);
  const result = runCli(['setup-client', '--key', 'MC4Cfake'], {
    GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'),
    AGENTGATE_CLIENT_CONFIG_DIR: path.join(dir, 'cfg'),
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /--key was given without --human/);
});

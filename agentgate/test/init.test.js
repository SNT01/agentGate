'use strict';
/**
 * `agentgate init` — the wizard's output has to be a configuration the broker
 * will actually start on.
 *
 * A setup command that emits an invalid `.env` is worse than no setup command:
 * the operator believes the hard part is done, and the failure surfaces later
 * as a refusal to boot. So the tests here care about two things — that valid
 * answers produce a file that passes `validateConfig()`, and that invalid ones
 * produce no file at all.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { renderEnv, Prompter } = require('../src/cli/init');
const { parseEnvFile } = require('../src/shared/config');

const CLI = path.join(__dirname, '..', 'src', 'cli', 'cli.js');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-init-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run the CLI, returning {status, stdout, stderr}. */
function runCli(args, { input = '', env = {} } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      input,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

test('init --yes writes a configuration that validates', (t) => {
  const dir = scratch(t);
  const envPath = path.join(dir, '.env');

  const result = runCli(['init', '--yes', '--env', envPath]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(envPath));

  const { values, problems } = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  assert.deepStrictEqual(problems, [], 'the file it writes must be a file it can read back');

  // The generated admin token has to satisfy the production rule, or the
  // wizard has handed the operator a broker that refuses to start.
  assert.ok(values.AGENTGATE_ADMIN_TOKEN.length >= 32);
  assert.strictEqual(values.AGENTGATE_BROKER_HOST, '127.0.0.1');

  // Validate in a child process: the loader reads the file at require time,
  // and this process has already required config with a different environment.
  const configPath = path.join(__dirname, '..', 'src', 'shared', 'config');
  const check = execFileSync(
    process.execPath,
    [
      '-e',
      `const {validateConfig}=require(${JSON.stringify(configPath)});` +
        'process.stdout.write(JSON.stringify(validateConfig()))',
    ],
    {
      env: { ...process.env, AGENTGATE_ENV_FILE: envPath, NODE_ENV: 'production' },
      encoding: 'utf8',
    }
  );
  assert.strictEqual(check, '[]', `generated config must parse cleanly, got ${check}`);
});

test('the generated file is not world-readable', (t) => {
  const dir = scratch(t);
  const envPath = path.join(dir, '.env');
  runCli(['init', '--yes', '--env', envPath]);
  // It holds the admin token.
  assert.strictEqual(fs.statSync(envPath).mode & 0o077, 0);
});

test('init refuses to overwrite an existing file without --force', (t) => {
  const dir = scratch(t);
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'AGENTGATE_ADMIN_TOKEN=existing-token-value\n');

  const result = runCli(['init', '--yes', '--env', envPath]);
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /already exists/);
  assert.match(fs.readFileSync(envPath, 'utf8'), /existing-token-value/, 'the original must be untouched');
});

test('init --force preserves an existing admin token by default', (t) => {
  const dir = scratch(t);
  const envPath = path.join(dir, '.env');
  const token = 'k'.repeat(64);
  fs.writeFileSync(envPath, `AGENTGATE_ADMIN_TOKEN=${token}\n`);

  // Rotating the admin token signs every operator out of the dashboard, so
  // keeping it is the default answer.
  const result = runCli(['init', '--force', '--yes', '--env', envPath]);
  assert.strictEqual(result.status, 0, result.stderr);
  const { values } = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  assert.strictEqual(values.AGENTGATE_ADMIN_TOKEN, token);
});

test('init replaces an admin token that is too short to be valid', (t) => {
  const dir = scratch(t);
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'AGENTGATE_ADMIN_TOKEN=short\n');

  runCli(['init', '--force', '--yes', '--env', envPath]);
  const { values } = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  assert.notStrictEqual(values.AGENTGATE_ADMIN_TOKEN, 'short');
  assert.ok(values.AGENTGATE_ADMIN_TOKEN.length >= 32);
});

test('an invalid answer aborts without writing a file', (t) => {
  const dir = scratch(t);
  const envPath = path.join(dir, '.env');

  // host, port, dataDir, then a token lifetime that is not a number.
  const result = runCli(['init', '--force', '--env', envPath], {
    input: '127.0.0.1\n4790\n./data\nnot-a-number\n',
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr + result.stdout, /positive number of milliseconds/);
  assert.strictEqual(fs.existsSync(envPath), false, 'a rejected answer must leave no file behind');
});

test('a token lifetime over an hour is refused at setup, not at deploy', (t) => {
  const dir = scratch(t);
  const envPath = path.join(dir, '.env');
  const result = runCli(['init', '--force', '--env', envPath], {
    input: '127.0.0.1\n4790\n./data\n7200000\n',
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr + result.stdout, /over 3600000/);
});

test('scripted answers are consumed in order, not just the first', (t) => {
  // Readline emits `close` as soon as piped input ends, which drops every
  // answer after the first if the prompts are driven one at a time.
  const dir = scratch(t);
  const envPath = path.join(dir, '.env');
  const result = runCli(['init', '--force', '--env', envPath], {
    input: ['0.0.0.0', '4900', '/srv/data', '1800000', 'warn', 'n'].join('\n') + '\n',
  });
  assert.strictEqual(result.status, 0, result.stderr);

  const { values } = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  assert.strictEqual(values.AGENTGATE_BROKER_HOST, '0.0.0.0');
  assert.strictEqual(values.AGENTGATE_BROKER_PORT, '4900');
  assert.strictEqual(values.AGENTGATE_DATA_DIR, '/srv/data');
  assert.strictEqual(values.AGENTGATE_TOKEN_TTL_MS, '1800000');
  assert.strictEqual(values.AGENTGATE_LOG_LEVEL, 'warn');
});

test('a public bind is written with its confirmation, never without', (t) => {
  const dir = scratch(t);
  const envPath = path.join(dir, '.env');
  runCli(['init', '--force', '--env', envPath], {
    input: ['0.0.0.0', '4790', './data', '900000', 'info', 'n'].join('\n') + '\n',
  });
  const { values } = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  // Without this the broker would refuse to start in production — the wizard
  // must not produce that state.
  assert.strictEqual(values.AGENTGATE_ALLOW_PUBLIC_BIND, 'true');
});

test('an incomplete GitHub App is omitted rather than half-written', (t) => {
  const dir = scratch(t);
  const envPath = path.join(dir, '.env');
  // Say yes to the App, then supply only the App ID.
  const result = runCli(['init', '--force', '--env', envPath], {
    input: ['127.0.0.1', '4790', './data', '900000', 'info', 'y', '112233', '', '', '', ''].join('\n') + '\n',
  });
  assert.strictEqual(result.status, 0, result.stderr);

  const { values } = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  assert.strictEqual(values.AGENTGATE_GITHUB_APP_ID, undefined, 'partial config fails at the first push — omit it');
  assert.match(result.stdout, /Incomplete GitHub App details/);
});

test('renderEnv output round-trips through the parser', () => {
  const rendered = renderEnv({
    host: '127.0.0.1',
    port: '4790',
    dataDir: './data',
    adminToken: 'a'.repeat(64),
    tokenTtlMs: '900000',
    logLevel: 'info',
    github: {
      appId: '1',
      installationId: '2',
      owner: 'acme',
      privateKeyPath: '/etc/agentgate/key.pem',
      apiBaseUrl: '',
    },
  });
  const { values, problems } = parseEnvFile(rendered);
  assert.deepStrictEqual(problems, []);
  assert.strictEqual(values.AGENTGATE_GITHUB_OWNER, 'acme');
  assert.strictEqual(values.AGENTGATE_GITHUB_API_BASE_URL, undefined, 'a blank base URL is omitted, not written empty');
});

test('Prompter answers from a supplied line queue', async () => {
  const p = new Prompter({ lines: ['first', '', 'third'] });
  assert.strictEqual(await p.ask('a', 'default-a'), 'first');
  assert.strictEqual(await p.ask('b', 'default-b'), 'default-b', 'a blank line takes the default');
  assert.strictEqual(await p.ask('c', 'default-c'), 'third');
  assert.strictEqual(await p.ask('d', 'default-d'), 'default-d', 'running out falls back to defaults');
  p.close();
});

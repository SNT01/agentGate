'use strict';
/**
 * Configuration parsing and validation.
 *
 * Every case here corresponds to a setting that used to fail *silently*: a
 * security switch that accepted its own negation, a dashboard that vanished
 * on a plausible spelling, a log level that quietly meant its opposite, and a
 * `.env` file the documentation told people to write while nothing read it.
 * Silence is the bug being tested for.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { config, validateConfig, assertProductionSafe, parseEnvFile } = require('../src/shared/config');

/** Run `fn` with `env` applied, restoring the environment afterwards. */
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

test('a boolean setting accepts both vocabularies', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
    withEnv({ AGENTGATE_UI_ENABLED: value }, () => {
      assert.strictEqual(config.uiEnabled, true, `${value} should enable the dashboard`);
    });
  }
  for (const value of ['0', 'false', 'no', 'off']) {
    withEnv({ AGENTGATE_UI_ENABLED: value }, () => {
      assert.strictEqual(config.uiEnabled, false, `${value} should disable the dashboard`);
    });
  }
});

test('a boolean setting rejects a value it cannot interpret', () => {
  withEnv({ AGENTGATE_UI_ENABLED: 'maybe' }, () => {
    assert.throws(() => config.uiEnabled, /expected one of 1\/true\/yes\/on/i);
  });
});

test('AGENTGATE_ALLOW_PUBLIC_BIND=0 does not confirm a public bind', () => {
  // The regression this exists for: the guard was read as raw truthiness, so
  // the string "0" was true and the one setting whose entire purpose is
  // explicit opt-in accepted its own negation.
  for (const denial of ['0', 'false', 'no', 'off']) {
    withEnv(
      {
        NODE_ENV: 'production',
        AGENTGATE_ADMIN_TOKEN: 'a'.repeat(40),
        AGENTGATE_BROKER_HOST: '0.0.0.0',
        AGENTGATE_ALLOW_PUBLIC_BIND: denial,
      },
      () => {
        assert.throws(() => assertProductionSafe(), /ALLOW_PUBLIC_BIND/i);
      }
    );
  }
});

test('the dashboard defaults to on with an admin token and off without one', () => {
  withEnv({ AGENTGATE_ADMIN_TOKEN: 'a'.repeat(40), AGENTGATE_UI_ENABLED: '' }, () => {
    assert.strictEqual(config.uiEnabled, true);
  });
  withEnv({ AGENTGATE_ADMIN_TOKEN: '', AGENTGATE_UI_ENABLED: '' }, () => {
    assert.strictEqual(config.uiEnabled, false);
  });
});

test('an unrecognised log level is rejected rather than falling back', () => {
  withEnv({ AGENTGATE_LOG_LEVEL: 'warning' }, () => {
    // "warning" used to resolve to `info`, i.e. more logging than asked for.
    assert.throws(() => config.logLevel, /expected one of debug, info, warn, error/i);
  });
  withEnv({ AGENTGATE_LOG_LEVEL: 'WARN' }, () => {
    assert.strictEqual(config.logLevel, 'warn');
  });
});

test('validateConfig collects every parse failure at once', () => {
  withEnv(
    {
      AGENTGATE_MAX_BODY_BYTES: 'not-a-number',
      AGENTGATE_LOG_LEVEL: 'loud',
      AGENTGATE_UI_ENABLED: 'perhaps',
    },
    () => {
      const problems = validateConfig();
      assert.strictEqual(problems.length, 3, `expected three problems, got ${JSON.stringify(problems)}`);
      assert.ok(problems.some((p) => /MAX_BODY_BYTES/.test(p)));
      assert.ok(problems.some((p) => /LOG_LEVEL/.test(p)));
      assert.ok(problems.some((p) => /UI_ENABLED/.test(p)));
    }
  );
});

test('validateConfig passes on a default configuration', () => {
  // Guards against a new getter that throws on its own default.
  withEnv({ AGENTGATE_LOG_LEVEL: '', AGENTGATE_UI_ENABLED: '' }, () => {
    assert.deepStrictEqual(validateConfig(), []);
  });
});

test('a lazily-read setting is caught before it can become a 500', () => {
  // `int()` throws at first access. Before validateConfig existed, that first
  // access was inside a request handler, where the server converts any 500
  // into an opaque "internal error" and the message naming the variable goes
  // only to the log.
  withEnv({ AGENTGATE_NONCE_WINDOW_MS: '-5' }, () => {
    const problems = validateConfig();
    assert.ok(problems.some((p) => /NONCE_WINDOW_MS/.test(p) && /positive number/.test(p)));
  });
});

test('production reports parse failures instead of throwing a bare error', () => {
  withEnv(
    { NODE_ENV: 'production', AGENTGATE_ADMIN_TOKEN: 'a'.repeat(40), AGENTGATE_BROKER_PORT: 'abc' },
    () => {
      assert.throws(() => assertProductionSafe(), /Unsafe production configuration[\s\S]*BROKER_PORT/i);
    }
  );
});

// --- .env parsing -----------------------------------------------------------

test('parseEnvFile handles the subset of dotenv that matters', () => {
  const { values, problems } = parseEnvFile(
    [
      '# a comment',
      '',
      'PLAIN=value',
      'export EXPORTED=exported-value',
      'QUOTED="spaced value"',
      "SINGLE='raw $value'",
      'ESCAPED="line\\nbreak"',
      'INLINE=value # trailing comment',
      'EMPTY=',
    ].join('\n')
  );

  assert.deepStrictEqual(problems, []);
  assert.strictEqual(values.PLAIN, 'value');
  assert.strictEqual(values.EXPORTED, 'exported-value');
  assert.strictEqual(values.QUOTED, 'spaced value');
  assert.strictEqual(values.SINGLE, 'raw $value');
  assert.strictEqual(values.ESCAPED, 'line\nbreak');
  assert.strictEqual(values.INLINE, 'value');
  assert.strictEqual(values.EMPTY, '');
});

test('parseEnvFile reports a malformed line with its number, and keeps going', () => {
  const { values, problems } = parseEnvFile(['GOOD=1', 'this is not an assignment', 'ALSO_GOOD=2'].join('\n'));
  assert.strictEqual(values.GOOD, '1');
  assert.strictEqual(values.ALSO_GOOD, '2');
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /line 2/);
});

test('a .env file is loaded, and the real environment wins over it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envPath = path.join(dir, 'test.env');
  fs.writeFileSync(envPath, 'AGENTGATE_BROKER_PORT=5999\nAGENTGATE_LOG_LEVEL=warn\n');

  // The loader runs at require time, so this asserts through a child process
  // rather than trying to un-require the module.
  const { execFileSync } = require('child_process');
  const script = `
    const { config } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'shared', 'config'))});
    process.stdout.write(JSON.stringify({
      port: config.port,
      logLevel: config.logLevel,
      envFile: config.envFile.path,
    }));
  `;

  const fromFile = JSON.parse(
    execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, AGENTGATE_ENV_FILE: envPath, AGENTGATE_BROKER_PORT: '', AGENTGATE_LOG_LEVEL: '' },
      encoding: 'utf8',
    })
  );
  assert.strictEqual(fromFile.port, 5999, 'the file should supply the port');
  assert.strictEqual(fromFile.logLevel, 'warn');
  assert.strictEqual(fromFile.envFile, envPath);

  const overridden = JSON.parse(
    execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, AGENTGATE_ENV_FILE: envPath, AGENTGATE_BROKER_PORT: '7777' },
      encoding: 'utf8',
    })
  );
  assert.strictEqual(overridden.port, 7777, 'a real environment variable must override the file');
});

'use strict';
/**
 * `agentgate init` — write a working configuration in one pass.
 *
 * Standing up a broker used to mean reading four README sections and
 * assembling a dozen environment variables by hand, where every omission
 * failed later and elsewhere: no admin token meant a dashboard that 404s, a
 * half-set GitHub App meant a denial at the first push. This asks the few
 * questions that have no safe default, generates what can be generated, and
 * writes a `.env` the broker actually reads.
 *
 * Deliberate properties:
 *  - **Never overwrites secrets silently.** An existing `.env` is left alone
 *    unless `--force`, and the existing admin token is offered for reuse
 *    rather than replaced (rotating it invalidates every operator's session).
 *  - **Generates rather than asks** wherever possible — nobody should be
 *    inventing a 32-character token by hand.
 *  - **Ends by pointing at `agentgate doctor`**, which verifies what this
 *    wrote against a running broker.
 *  - `--yes` answers every prompt with its default, for containers and CI.
 *
 * Uses `node:readline` only: the broker has no runtime dependencies and a
 * setup wizard is not a good reason to acquire the first one.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

const REPO_ROOT = path.join(__dirname, '..', '..');

/**
 * Question-and-answer over stdin, with defaults.
 *
 * Three input modes, because "interactive" is only one of the ways this gets
 * run:
 *  - `assumeYes`: answer everything with its default, touching stdin at all.
 *  - a TTY: prompt through readline, one question at a time.
 *  - anything else (a pipe, a heredoc, a file): read every line up front and
 *    answer from that queue. Readline emits `close` as soon as a piped stream
 *    ends, which is typically *before* the later questions are asked, so
 *    driving it question-by-question silently drops all but the first answer.
 *    Queueing makes scripted input deterministic; running out of lines falls
 *    back to defaults rather than hanging.
 */
class Prompter {
  constructor({ assumeYes = false, lines = null } = {}) {
    this.assumeYes = assumeYes;
    this.queue = null;
    this.rl = null;

    if (assumeYes) return;
    if (lines) {
      this.queue = [...lines];
    } else if (process.stdin.isTTY) {
      this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    } else {
      this.queue = [];
    }
  }

  /** Load piped stdin into the answer queue. Call before the first `ask`. */
  async prime() {
    if (this.assumeYes || this.rl || (this.queue && this.queue.length)) return;
    if (process.stdin.isTTY) return;
    const text = await new Promise((resolve) => {
      let buffer = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
      });
      process.stdin.on('end', () => resolve(buffer));
      process.stdin.on('error', () => resolve(buffer));
    });
    this.queue = text.split('\n');
    if (this.queue.length && this.queue[this.queue.length - 1] === '') this.queue.pop();
  }

  async ask(question, fallback = '') {
    if (this.assumeYes) return fallback;

    let answer;
    if (this.queue) {
      answer = this.queue.shift();
      if (answer === undefined) answer = '';
      // Echo, so a scripted run still produces a readable transcript.
      process.stdout.write(`${question}${fallback === '' ? '' : ` [${fallback}]`}: ${answer}\n`);
    } else {
      const suffix = fallback === '' ? '' : ` [${fallback}]`;
      answer = await new Promise((resolve) => this.rl.question(`${question}${suffix}: `, resolve));
    }

    const trimmed = String(answer).trim();
    return trimmed === '' ? fallback : trimmed;
  }

  /**
   * Ask until the answer validates.
   *
   * A wizard that writes a configuration the broker then refuses to start on
   * has achieved nothing — so every answer that has a shape is checked here,
   * where the question can simply be asked again. Scripted input gets one
   * attempt and a hard error, because re-prompting a pipe would loop forever.
   */
  async askValidated(question, fallback, validate) {
    for (let attempt = 0; ; attempt++) {
      const answer = await this.ask(question, fallback);
      const problem = validate(answer);
      if (!problem) return answer;

      if (this.assumeYes || this.queue || attempt >= 4) {
        throw new Error(`${problem} (got "${answer}")`);
      }
      process.stdout.write(`  ${problem}\n`);
    }
  }

  async confirm(question, fallback = true) {
    if (this.assumeYes) return fallback;
    const answer = await this.askValidated(`${question} (y/n)`, fallback ? 'y' : 'n', (value) =>
      /^(y|yes|n|no)$/i.test(String(value).trim()) ? null : 'Please answer y or n.'
    );
    return /^y(es)?$/i.test(answer.trim());
  }

  close() {
    if (this.rl) this.rl.close();
  }
}

/** Serialise answers as a .env file, preserving the example's explanations. */
function renderEnv(values) {
  const lines = [
    '# AgentGate configuration — generated by `agentgate init`.',
    '#',
    '# Real environment variables override anything here, so a container\'s -e',
    '# flags win over this file. See env.example.txt for every available',
    '# setting and what it does.',
    '',
    '# --- Broker service ---',
    `AGENTGATE_BROKER_HOST=${values.host}`,
    `AGENTGATE_BROKER_PORT=${values.port}`,
  ];

  if (values.host === '0.0.0.0') {
    lines.push(
      '# Confirms a non-loopback bind. Terminate TLS in front of the broker:',
      '# token requests carry signatures and must not cross the network in clear.',
      'AGENTGATE_ALLOW_PUBLIC_BIND=true'
    );
  }

  lines.push(
    '',
    '# --- Storage ---',
    '# Back this up. It holds the registry root key, which signs every agent',
    '# identity card — losing it invalidates all of them.',
    `AGENTGATE_DATA_DIR=${values.dataDir}`,
    '',
    '# --- Security ---',
    '# Guards /audit and /admin, and signs the dashboard in. Rotating it ends',
    '# every dashboard session.',
    `AGENTGATE_ADMIN_TOKEN=${values.adminToken}`,
    `AGENTGATE_TOKEN_TTL_MS=${values.tokenTtlMs}`,
    '',
    '# --- Logging ---',
    `AGENTGATE_LOG_LEVEL=${values.logLevel}`
  );

  if (values.github) {
    lines.push(
      '',
      '# --- GitHub App (the credential `git push` actually uses) ---',
      '# Requires: npm install --no-save @octokit/auth-app',
      `AGENTGATE_GITHUB_APP_ID=${values.github.appId}`,
      `AGENTGATE_GITHUB_INSTALLATION_ID=${values.github.installationId}`,
      '# A security control, not a convenience: bare repository names resolve',
      '# against the installation\'s account, so without this a request for',
      '# "attacker/api" would mint a token scoped to your own "api".',
      `AGENTGATE_GITHUB_OWNER=${values.github.owner}`,
      `AGENTGATE_GITHUB_PRIVATE_KEY_PATH=${values.github.privateKeyPath}`
    );
    if (values.github.apiBaseUrl) {
      lines.push(`AGENTGATE_GITHUB_API_BASE_URL=${values.github.apiBaseUrl}`);
    }
  }

  return lines.join('\n') + '\n';
}

/** Read an existing .env just enough to offer its values back as defaults. */
function readExisting(envPath) {
  if (!fs.existsSync(envPath)) return {};
  try {
    const { parseEnvFile } = require('../shared/config');
    return parseEnvFile(fs.readFileSync(envPath, 'utf8')).values;
  } catch (_err) {
    return {};
  }
}

const GITHUB_APP_INSTRUCTIONS = `
To register the App (once per organisation):

  1. Organisation settings → Developer settings → GitHub Apps → New.
     Untick webhook "Active" if this App only mints push credentials.
  2. Grant exactly these repository permissions:
       Contents        Read and write   (git push)
       Pull requests   Read and write   (pr:open, pr:comment)
       Metadata        Read-only        (mandatory)
     The enforcer needs Checks: write — consider a second App for it, since
     the credential path has no use for that permission.
  3. Generate a private key, move the .pem somewhere outside this repository,
     and chmod 600 it.
  4. Install the App on *only selected repositories*. The URL you land on
     ends in the installation id.
`;

async function cmdInit(flags = {}) {
  const assumeYes = !!(flags.yes || flags.y);
  const envPath = flags.env && flags.env !== true ? path.resolve(flags.env) : path.join(REPO_ROOT, '.env');
  const existing = readExisting(envPath);

  if (fs.existsSync(envPath) && !flags.force) {
    console.log(`\n${envPath} already exists.\n`);
    console.log('  Re-run with --force to replace it, or edit it directly.');
    console.log('  `agentgate doctor` will tell you whether it is complete.\n');
    process.exitCode = 1;
    return;
  }

  const p = new Prompter({ assumeYes, lines: flags._answers });
  try {
    await p.prime();
    if (!assumeYes) {
      console.log('\nAgentGate setup. Press enter to accept each default.\n');
    }

    const host = await p.askValidated(
      'Bind address (127.0.0.1 for local; 0.0.0.0 only behind TLS)',
      existing.AGENTGATE_BROKER_HOST || '127.0.0.1',
      (value) => (/^[A-Za-z0-9.:_-]+$/.test(value) ? null : 'Not a valid host or address.')
    );
    const port = await p.askValidated(
      'Port',
      existing.AGENTGATE_BROKER_PORT || '4790',
      (value) => (/^\d+$/.test(value) && +value > 0 && +value <= 65535 ? null : 'Ports are 1–65535.')
    );
    const dataDir = await p.askValidated(
      'Data directory (holds the registry root key — back it up)',
      existing.AGENTGATE_DATA_DIR || './data',
      (value) => (value.trim() === '' ? 'A path is required.' : null)
    );

    // The admin token is generated, not asked for. Reusing an existing one is
    // the default because rotating it signs every operator out.
    let adminToken = existing.AGENTGATE_ADMIN_TOKEN || '';
    if (adminToken && adminToken.length >= 32) {
      const keep = await p.confirm('Keep the existing admin token?', true);
      if (!keep) adminToken = '';
    }
    if (!adminToken || adminToken.length < 32) {
      adminToken = crypto.randomBytes(32).toString('hex');
      if (!assumeYes) console.log('  Generated a new 64-character admin token.');
    }

    const tokenTtlMs = await p.askValidated(
      'Session token lifetime in ms (production allows at most 3600000)',
      existing.AGENTGATE_TOKEN_TTL_MS || '900000',
      (value) => {
        if (!/^\d+$/.test(value) || +value <= 0) return 'Expected a positive number of milliseconds.';
        if (+value > 60 * 60 * 1000) return 'Production refuses anything over 3600000 (one hour).';
        return null;
      }
    );
    const logLevel = await p.askValidated(
      'Log level (debug|info|warn|error)',
      existing.AGENTGATE_LOG_LEVEL || 'info',
      (value) => (['debug', 'info', 'warn', 'error'].includes(value.toLowerCase()) ? null : 'Expected debug, info, warn, or error.')
    );

    // --- GitHub App -------------------------------------------------------
    // Skipped by default: without it the broker still runs, issues session
    // tokens, and passes the demo and tests. With it, `git push` works
    // against a real repository.
    let github = null;
    const hadGithub = !!existing.AGENTGATE_GITHUB_APP_ID;
    const wantGithub = await p.confirm(
      'Configure a GitHub App now? (needed for real `git push`; skip for a local trial)',
      hadGithub
    );

    if (wantGithub) {
      if (!assumeYes) console.log(GITHUB_APP_INSTRUCTIONS);
      const numericId = (label) => (value) =>
        value === '' || /^\d+$/.test(value) ? null : `The ${label} from GitHub is numeric.`;

      const appId = await p.askValidated(
        'App ID',
        existing.AGENTGATE_GITHUB_APP_ID || '',
        numericId('App ID')
      );
      const installationId = await p.askValidated(
        'Installation ID',
        existing.AGENTGATE_GITHUB_INSTALLATION_ID || '',
        numericId('installation ID')
      );
      const owner = await p.askValidated(
        'Owner (the org or user the App is installed on)',
        existing.AGENTGATE_GITHUB_OWNER || '',
        (value) => (value === '' || /^[A-Za-z0-9._-]+$/.test(value) ? null : 'Not a valid GitHub account name.')
      );
      const privateKeyPath = await p.askValidated(
        'Path to the App private key (.pem)',
        existing.AGENTGATE_GITHUB_PRIVATE_KEY_PATH || '',
        (value) => {
          if (value === '') return null;
          // Catch the wrong file now rather than at the first push, where the
          // failure arrives as a 401 from GitHub.
          if (!fs.existsSync(value)) return 'No file at that path.';
          try {
            if (!fs.readFileSync(value, 'utf8').includes('PRIVATE KEY')) {
              return 'That file does not look like a PEM private key.';
            }
          } catch (err) {
            return `Cannot read that file: ${err.message}`;
          }
          return null;
        }
      );
      const apiBaseUrl = await p.askValidated(
        'GitHub Enterprise API base URL (blank for github.com)',
        existing.AGENTGATE_GITHUB_API_BASE_URL || '',
        (value) => {
          if (value === '') return null;
          try {
            new URL(value);
            return null;
          } catch (_err) {
            return 'Expected a full URL, e.g. https://github.example.com/api/v3';
          }
        }
      );

      if (appId && installationId && owner && privateKeyPath) {
        github = { appId, installationId, owner, privateKeyPath, apiBaseUrl };
      } else {
        // Partial configuration is the one state worse than none: it fails at
        // the first push, long after the deploy that broke it.
        console.log(
          '\n  Incomplete GitHub App details — leaving the exchange unconfigured rather than\n' +
            '  half-configured. Re-run `agentgate init --force` when you have all four.\n'
        );
      }
    }

    const contents = renderEnv({ host, port, dataDir, adminToken, tokenTtlMs, logLevel, github });
    fs.writeFileSync(envPath, contents, { mode: 0o600 });

    console.log(`\nWrote ${envPath} (mode 0600).\n`);

    // Warn about the things this file cannot fix by itself.
    const notes = [];
    if (github) {
      notes.push('npm install --no-save @octokit/auth-app    # the exchange needs it');
      try {
        const mode = fs.statSync(github.privateKeyPath).mode & 0o077;
        if (mode !== 0) notes.push(`chmod 600 ${github.privateKeyPath}    # currently group/world readable`);
      } catch (_err) {
        notes.push(`check ${github.privateKeyPath} — not readable from here`);
      }
    }
    if (host === '0.0.0.0') {
      notes.push('terminate TLS in front of the broker before exposing it');
    }
    if (notes.length) {
      console.log('Still to do:');
      for (const note of notes) console.log(`  · ${note}`);
      console.log('');
    }

    console.log('Next:');
    console.log('  npm run broker            # start it');
    console.log('  agentgate doctor          # verify this configuration end to end');
    console.log('  agentgate enroll --name "Your Name" --admin');
    console.log('');
  } finally {
    p.close();
  }
}

module.exports = { cmdInit, renderEnv, Prompter };

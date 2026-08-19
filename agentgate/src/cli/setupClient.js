'use strict';
/**
 * `agentgate setup-client` — make `git push` go through AgentGate on this
 * machine, in one command.
 *
 * What this replaces: five `export` lines pasted into a shell profile, two
 * `git config` invocations, and — on macOS — a four-command ritual to stop
 * `osxkeychain` answering first. That last one is the whole reason this exists.
 * Git accumulates credential helpers across configuration scopes and stops at
 * the first that answers, and the Command Line Tools gitconfig registers
 * `osxkeychain` before anything a user writes. The symptom of getting it wrong
 * is an empty audit log: AgentGate is simply never consulted, which looks like
 * AgentGate not working rather than a configuration problem.
 *
 * Everything here is idempotent, and `--dry-run` prints the commands instead of
 * running them, because rewriting someone's global git configuration is not a
 * thing to do invisibly.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { saveStored, loadStored, credentialsPath } = require('./clientConfig');

const HELPER_PATH = path.resolve(__dirname, 'credentialHelper.js');
const HELPER_VALUE = `!node ${HELPER_PATH}`;

function git(args, { dryRun = false } = {}) {
  if (dryRun) {
    console.log(`  would run: git ${args.join(' ')}`);
    return '';
  }
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitRead(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_err) {
    return null;
  }
}

/**
 * Rewrite the global credential.helper list as [reset, AgentGate].
 *
 * The empty first entry is not decoration: it discards every helper inherited
 * from a broader configuration scope, which is what puts AgentGate first.
 */
function configureGitHelpers({ dryRun, scope }) {
  const scopeFlag = `--${scope}`;
  const existing = gitRead(['config', scopeFlag, '--get-all', 'credential.helper']);
  const before = existing === null ? [] : existing.split('\n').filter((l) => l.trim() !== '');

  const displaced = before.filter((l) => !l.includes('credentialHelper.js'));

  // --unset-all fails when the key is absent; that is not an error here.
  try {
    git(['config', scopeFlag, '--unset-all', 'credential.helper'], { dryRun });
  } catch (_err) {
    /* nothing was set */
  }
  git(['config', scopeFlag, '--add', 'credential.helper', ''], { dryRun });
  git(['config', scopeFlag, '--add', 'credential.helper', HELPER_VALUE], { dryRun });
  git(['config', scopeFlag, 'credential.useHttpPath', 'true'], { dryRun });

  return { displaced };
}

function cmdSetupClient(flags = {}) {
  const dryRun = !!flags['dry-run'];
  const scope = flags.local ? 'local' : 'global';

  const humanId = flags.human === true ? undefined : flags.human || process.env.AGENTGATE_HUMAN_ID;
  const humanPrivateKey =
    flags.key === true ? undefined : flags.key || process.env.AGENTGATE_HUMAN_PRIVATE_KEY;
  const agentCardId = flags.agent === true ? undefined : flags.agent || process.env.AGENTGATE_AGENT_CARD_ID;
  const agentPrivateKey =
    flags['agent-key'] === true ? undefined : flags['agent-key'] || process.env.AGENTGATE_AGENT_PRIVATE_KEY;
  const context = flags.context === true ? undefined : flags.context || process.env.AGENTGATE_CONTEXT;
  const brokerUrl =
    flags['broker-url'] === true ? undefined : flags['broker-url'] || process.env.AGENTGATE_BROKER_URL;

  console.log('');

  // --- 1. Store the identity ------------------------------------------------
  // Only if something was supplied: re-running this to fix git configuration
  // must not wipe an identity that is already stored.
  const supplied = { humanId, humanPrivateKey, agentCardId, agentPrivateKey, context, brokerUrl };
  const provided = Object.entries(supplied).filter(([, v]) => v !== undefined && v !== '');

  if (provided.length) {
    if (humanPrivateKey && !humanId) {
      throw new Error('--key was given without --human: an identity needs both');
    }
    const merged = { ...loadStored() };
    for (const [key, value] of provided) merged[key] = value;

    if (dryRun) {
      console.log(`  would write ${credentialsPath()} (mode 0600) with: ${provided.map(([k]) => k).join(', ')}`);
    } else {
      const written = saveStored(merged);
      console.log(`Stored identity in ${written} (mode 0600).`);
      console.log(`  ${provided.map(([k]) => k).join(', ')}`);
      console.log('  The credential helper reads this, so nothing needs to be in your shell profile.');
      console.log('  Environment variables still override it when set.');
    }
  } else {
    const stored = loadStored();
    if (stored.humanId) {
      console.log(`Keeping the identity already stored in ${credentialsPath()} (${stored.humanId}).`);
    } else {
      console.log('No identity supplied or stored yet. Configuring git anyway; add one with:');
      console.log('  agentgate setup-client --human human_... --key "MC4C..."');
    }
  }

  // --- 2. Configure git -----------------------------------------------------
  console.log('');
  let displaced = [];
  try {
    ({ displaced } = configureGitHelpers({ dryRun, scope }));
  } catch (err) {
    throw new Error(`could not configure git: ${err.message}`);
  }

  if (dryRun) {
    console.log('');
  } else {
    console.log(`Configured git (${scope}):`);
    console.log('  credential.helper  = "" then AgentGate  (the empty entry discards inherited helpers)');
    console.log('  credential.useHttpPath = true           (so the broker can scope the token to one repo)');
    if (displaced.length) {
      console.log(`  displaced: ${[...new Set(displaced)].join(', ')} — no longer consulted before AgentGate`);
    }
  }

  // --- 3. The cached credential that would pre-empt us ----------------------
  // A credential already in the keychain satisfies git without any helper being
  // asked, so configuring the chain is not sufficient on its own. Clearing it
  // is nevertheless *opt-in*: it signs this machine out of GitHub for every
  // other tool that relies on that entry, which is not a side effect a setup
  // command should have without being asked.
  const host = flags['forge-host'] === true || !flags['forge-host'] ? 'github.com' : flags['forge-host'];
  if (process.platform === 'darwin') {
    console.log('');
    const eraseCommand = `printf 'protocol=https\\nhost=${host}\\n' | git credential-osxkeychain erase`;

    if (!flags['clear-keychain']) {
      console.log('One thing left, and it is yours to decide:');
      console.log(`  A credential cached in the macOS keychain answers before any helper runs,`);
      console.log(`  so pushes would still bypass AgentGate. Clearing it also signs other tools`);
      console.log(`  out of ${host} on this machine, so this command does not do it for you:`);
      console.log('');
      console.log(`    ${eraseCommand}`);
      console.log('');
      console.log('  Or re-run with --clear-keychain. `agentgate doctor --client` will tell you');
      console.log('  whether a cached credential is still winning.');
    } else if (dryRun) {
      console.log(`  would run: ${eraseCommand}`);
    } else {
      try {
        execFileSync('git', ['credential-osxkeychain', 'erase'], {
          input: `protocol=https\nhost=${host}\n`,
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        console.log(`Cleared the cached ${host} credential from the macOS keychain, as requested.`);
      } catch (_err) {
        console.log('Note: could not run git-credential-osxkeychain (it may not be installed).');
      }
    }
  }

  console.log('');
  console.log('Verify it:');
  console.log('  agentgate doctor --client');
  console.log('');

  if (!dryRun && !fs.existsSync(HELPER_PATH)) {
    // Guards against a moved or renamed checkout: git would fail at push time
    // with an exec error rather than anything about AgentGate.
    console.log(`Warning: ${HELPER_PATH} does not exist — git will fail to run the helper.`);
  }
}

module.exports = { cmdSetupClient, HELPER_VALUE, HELPER_PATH };

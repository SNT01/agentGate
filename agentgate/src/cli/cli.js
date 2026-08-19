#!/usr/bin/env node
'use strict';
/**
 * agentgate CLI — the only surface a person touches directly.
 * Run `agentgate help` for usage.
 */
const { Registry, VALID_ACTIONS } = require('../registry/registry');
const { TokenBroker } = require('../broker/broker');
const { config } = require('../shared/config');

const USAGE = `agentgate — identity gate for repositories and the AI agents that act on them

Setup
  agentgate init [--yes] [--force] [--env <path>]
      Write a working .env: bind address, generated admin token, data
      directory, and optionally a GitHub App. Start here on a new install.
      --yes accepts every default, for containers and CI.

  agentgate keygen
      Generate a keypair locally. Keep the private key; hand the public key
      to an administrator to enroll with. Required in production, where the
      server refuses to generate keys on your behalf.

  agentgate enroll --name "Alice" [--contexts office,ci] [--admin]
                   [--public-key <base64>]
      Enroll a human identity. Without --public-key (development only) a
      keypair is generated and the private key printed once.

  agentgate issue-agent --sponsor <humanId> --tool claude-code [--version 2.4.0]
                        [--profile <name>] [--context office]
                        [--branches "feature/*,agent/*"]
                        [--actions "push,pr:open,pr:comment"]
      Issue an Agent Identity Card for an AI tool, sponsored by a human.
      The card's capabilities are narrowed to at most the sponsor's own.
      --profile takes branches, actions, context, and TTL from a named
      preset in policies.json; explicit flags still win.

  agentgate setup-client [--human <id>] [--key <base64>] [--agent <id>]
                        [--context office] [--broker-url URL]
                        [--local] [--dry-run] [--clear-keychain]
      Point this machine's \`git push\` at AgentGate: store the identity in
      ~/.config/agentgate/credentials.json (mode 0600), put the credential
      helper first in git's chain, and set credential.useHttpPath.
      A cached keychain credential still answers first; this prints the
      command to clear it, or does it with --clear-keychain.

Operations
  agentgate list [humans|agents] [--tool NAME] [--sponsor <id>]
                 [--status active|revoked|expired] [--expiring DAYS] [--json]
      Show identities. The filters are what make a fleet navigable:
      --expiring 7 answers "what breaks this week", soonest first.

  agentgate renew <agentCardId> [--days N]
      Extend a card's expiry, keeping its id — so its audit history and the
      commit trailers naming it still resolve. Recomputed against the
      sponsor's current capabilities, so it can only narrow, never widen.

  agentgate status <id>               Check one identity or agent card
  agentgate revoke <id> [--reason ".."]  Revoke; sponsors cascade to their agents
  agentgate audit [list|verify] [--limit N]   Inspect or verify the audit chain

  agentgate policy [list] [--json]
  agentgate policy check <owner/name>
      Show the capability profiles and per-repository ceilings defined in
      policies.json, or what the ceiling works out to for one repository.

Diagnosis
  agentgate doctor [--broker|--client] [--json]
      Check this deployment and name the fix for anything wrong: config that
      does not parse, an unreachable broker, a git credential helper that
      never gets consulted, a half-configured GitHub App, an unbuilt
      dashboard. Start here when something does not work.

Valid actions: ${VALID_ACTIONS.join(', ')}
Data directory: ${config.dataDir}
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function list(value, fallback) {
  if (!value || value === true) return fallback;
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function cmdKeygen(flags) {
  const { generateKeyPair } = require('../shared/crypto');
  const { publicKey, privateKey } = generateKeyPair();

  if (flags.json) {
    console.log(JSON.stringify({ publicKey, privateKey }, null, 2));
    return;
  }
  console.log('Keypair generated. The private key is shown once and is not stored anywhere.\n');
  console.log(`  public key:  ${publicKey}`);
  console.log(`  private key: ${privateKey}`);
  console.log('\n  Store the private key in your OS keychain, then ask an administrator to run:');
  console.log(`    agentgate enroll --name "Your Name" --public-key "${publicKey}"`);
}

function cmdEnroll(registry, flags) {
  if (!flags.name || flags.name === true) throw new Error('--name "Your Name" is required');
  const contexts = list(flags.contexts, ['office']);
  const capabilities = {
    branches: list(flags.branches, ['*']),
    actions: flags.admin
      ? ['push', 'pr:open', 'pr:comment', 'pr:approve', 'pr:merge']
      : list(flags.actions, ['push', 'pr:open', 'pr:comment', 'pr:approve']),
  };
  const result = registry.enrollHuman({
    name: flags.name,
    oidcSubject: flags.oidc === true ? undefined : flags.oidc,
    allowedContexts: contexts,
    capabilities,
    publicKey: flags['public-key'] === true ? undefined : flags['public-key'],
  });

  console.log('Human enrolled.');
  console.log(`  id:           ${result.humanId}`);
  console.log(`  contexts:     ${contexts.join(', ')}`);
  console.log(`  capabilities: branches=[${capabilities.branches}] actions=[${capabilities.actions}]`);
  if (result.privateKey) {
    console.log(`  private key:  ${result.privateKey}`);
    console.log('\n  This is the only time the private key is shown. Never commit it.');
    console.log('  To use it on the machine that pushes, in one command:');
    console.log(`    agentgate setup-client --human ${result.humanId} --key "${result.privateKey}"`);
    console.log('\n  (That stores it mode 0600 and configures git. Environment variables');
    console.log('   still work if you prefer them:');
    console.log(`     export AGENTGATE_HUMAN_ID=${result.humanId}`);
    console.log(`     export AGENTGATE_HUMAN_PRIVATE_KEY="${result.privateKey}")`);
  }
}

function cmdIssueAgent(registry, flags) {
  if (!flags.sponsor || flags.sponsor === true) throw new Error('--sponsor <humanId> is required');
  if (!flags.tool || flags.tool === true) throw new Error('--tool <name> is required (e.g. claude-code)');

  // A profile supplies the defaults; explicit flags still win, so a profile is
  // a starting point rather than a straitjacket. Spelling out --branches and
  // --actions on every one of a hundred invocations is a hundred chances to
  // type something subtly different.
  const profileName = flags.profile === true ? null : flags.profile;
  let profile = null;
  if (profileName) {
    const { PolicyStore } = require('../shared/policyStore');
    const policies = new PolicyStore(config.dataDir);
    profile = policies.profile(profileName);
    if (!profile) {
      const known = policies.profileNames();
      throw new Error(
        `Unknown profile "${profileName}".${known.length ? ` Known: ${known.join(', ')}` : ' No profiles are defined in policies.json.'}`
      );
    }
  }

  const requestedCapabilities = {
    branches: list(flags.branches, (profile && profile.branches) || ['feature/*', 'agent/*']),
    actions: list(flags.actions, (profile && profile.actions) || ['push', 'pr:open', 'pr:comment']),
  };
  const context =
    flags.context === true || !flags.context ? (profile && profile.context) || 'office' : flags.context;
  const ttlMs =
    profile && profile.cardTtlDays ? Number(profile.cardTtlDays) * 24 * 60 * 60 * 1000 : undefined;

  const result = registry.issueAgentCard({
    sponsorId: flags.sponsor,
    tool: {
      name: flags.tool,
      version: flags.version === true ? '0.0.0' : flags.version || '0.0.0',
      packageHash: flags['package-hash'] === true ? null : flags['package-hash'] || null,
    },
    operator: flags.operator === true ? undefined : flags.operator,
    context,
    requestedCapabilities,
    ttlMs,
    publicKey: flags['public-key'] === true ? undefined : flags['public-key'],
  });
  const { card } = result;

  console.log('Agent Identity Card issued.');
  if (profileName) console.log(`  profile:      ${profileName}`);
  console.log(`  agentCardId:  ${result.agentCardId}`);
  console.log(`  tool:         ${card.tool.name}@${card.tool.version}`);
  console.log(`  sponsor:      ${card.sponsorId}`);
  console.log(`  context:      ${card.context}`);
  console.log(`  capabilities: branches=[${card.capabilities.branches}] actions=[${card.capabilities.actions}]`);
  console.log(`  expires:      ${card.expiresAt}`);
  if (result.privateKey) {
    console.log(`  private key:  ${result.privateKey}`);
    console.log('\n  For the machine or process the agent runs on:');
    console.log(`    agentgate setup-client --agent ${result.agentCardId} --agent-key "${result.privateKey}"`);
    console.log('\n  (Or, for a container or CI job:');
    console.log(`     export AGENTGATE_AGENT_CARD_ID=${result.agentCardId}`);
    console.log(`     export AGENTGATE_AGENT_PRIVATE_KEY="${result.privateKey}")`);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** "in 12 days" / "6 hours ago" — relative time reads faster than a date. */
function relativeTime(ms) {
  const abs = Math.abs(ms);
  const [value, unit] =
    abs >= DAY_MS ? [Math.round(abs / DAY_MS), 'day'] : [Math.round(abs / (60 * 60 * 1000)), 'hour'];
  const plural = value === 1 ? unit : `${unit}s`;
  return ms < 0 ? `${value} ${plural} ago` : `in ${value} ${plural}`;
}

/**
 * List identities, with filters.
 *
 * A flat unpaginated dump is fine for the five identities a trial has and
 * useless at several hundred, which is where this is heading — so the fleet
 * questions ("whose agents are these", "what expires this week") are answerable
 * without piping through grep.
 */
function cmdList(registry, positional, flags = {}) {
  const what = positional[0] || 'all';
  const now = Date.now();

  const wantTool = flags.tool === true ? null : flags.tool;
  const wantSponsor = flags.sponsor === true ? null : flags.sponsor;
  const status = flags.status === true ? null : flags.status;
  const expiringDays = flags.expiring === true ? 7 : flags.expiring ? Number(flags.expiring) : null;

  if (expiringDays !== null && !Number.isFinite(expiringDays)) {
    throw new Error(`--expiring expects a number of days, got "${flags.expiring}"`);
  }
  if (status && !['active', 'revoked', 'expired'].includes(status)) {
    throw new Error(`--status expects active, revoked, or expired, got "${status}"`);
  }

  if (what === 'humans' || what === 'all') {
    let humans = registry.listHumans();
    if (status === 'active') humans = humans.filter((h) => !h.revoked);
    if (status === 'revoked') humans = humans.filter((h) => h.revoked);
    if (status === 'expired') humans = []; // humans do not expire; only cards do

    if (flags.json) {
      console.log(JSON.stringify({ humans }, null, 2));
    } else {
      console.log(`\nHumans (${humans.length}):`);
      for (const h of humans) {
        console.log(
          `  ${h.revoked ? '✗' : '✓'} ${h.id}  ${h.name}  contexts=[${h.allowedContexts}]${h.revoked ? '  REVOKED' : ''}`
        );
      }
    }
  }

  if (what === 'agents' || what === 'all') {
    let agents = registry.listAgentCards().map((a) => ({
      ...a,
      expiresInMs: new Date(a.expiresAt).getTime() - now,
    }));

    if (wantTool) agents = agents.filter((a) => a.tool.name === wantTool);
    if (wantSponsor) agents = agents.filter((a) => a.sponsorId === wantSponsor);
    if (status === 'active') agents = agents.filter((a) => !a.revoked && a.expiresInMs > 0);
    if (status === 'revoked') agents = agents.filter((a) => a.revoked);
    if (status === 'expired') agents = agents.filter((a) => !a.revoked && a.expiresInMs <= 0);
    if (expiringDays !== null) {
      agents = agents.filter((a) => !a.revoked && a.expiresInMs <= expiringDays * DAY_MS);
    }
    agents.sort((a, b) => a.expiresInMs - b.expiresInMs);

    if (flags.json) {
      console.log(JSON.stringify({ agents }, null, 2));
      return;
    }

    const heading = expiringDays !== null ? `Agent cards expiring within ${expiringDays} day(s)` : 'Agent cards';
    console.log(`\n${heading} (${agents.length}):`);
    for (const a of agents) {
      const state = a.revoked ? '  REVOKED' : a.expiresInMs <= 0 ? '  EXPIRED' : '';
      const mark = a.revoked || a.expiresInMs <= 0 ? '✗' : '✓';
      console.log(
        `  ${mark} ${a.id}  ${a.tool.name}@${a.tool.version}  sponsor=${a.sponsorId}  context=${a.context}  expires ${relativeTime(a.expiresInMs)}${state}`
      );
    }
    if (expiringDays !== null && agents.length) {
      console.log(`\n  Renew one: agentgate renew ${agents[0].id}`);
    }
  }
  console.log('');
}

function cmdRenew(registry, broker, positional, flags) {
  const id = positional[0];
  if (!id) throw new Error('usage: agentgate renew <agentCardId> [--days N]');

  const days = flags.days === true ? null : flags.days;
  if (days !== null && days !== undefined && !Number.isFinite(Number(days))) {
    throw new Error(`--days expects a number, got "${days}"`);
  }
  const ttlMs = days ? Number(days) * DAY_MS : undefined;

  const result = registry.renewAgentCard(id, { ttlMs });

  // Renewal extends authority in time, so it belongs on the audit chain. The
  // card id is unchanged, which is the point — the history stays attached to
  // one identity.
  broker.recordAction({
    action: 'agent_card_renewed',
    agentCardId: result.agentCardId,
    sponsorId: result.card.sponsorId,
    tool: result.card.tool,
    previousExpiresAt: result.previousExpiresAt,
    expiresAt: result.card.expiresAt,
    capabilities: result.card.capabilities,
    narrowed: result.narrowed,
    outcome: 'applied',
  });

  console.log(`Renewed ${result.agentCardId} (same id — history and commit trailers still resolve).`);
  console.log(`  was:     ${result.previousExpiresAt}`);
  console.log(`  expires: ${result.card.expiresAt}`);
  if (result.narrowed) {
    console.log(
      `  narrowed to the sponsor's current capabilities: branches=[${result.card.capabilities.branches}] actions=[${result.card.capabilities.actions}]`
    );
  }
}

function cmdStatus(registry, positional) {
  const id = positional[0];
  if (!id) throw new Error('usage: agentgate status <id>');
  if (id.startsWith('agent_')) {
    console.log(JSON.stringify(registry.verifyAgentCard(id), null, 2));
  } else {
    const human = registry.getHuman(id);
    if (!human) throw new Error(`Unknown identity: ${id}`);
    console.log(JSON.stringify({ human, revoked: registry.isRevoked(id) }, null, 2));
  }
}

function cmdRevoke(registry, broker, positional, flags) {
  const id = positional[0];
  if (!id) throw new Error('usage: agentgate revoke <id> [--reason "..."]');
  const reason = flags.reason === true ? undefined : flags.reason;
  const result = registry.revoke(id, reason);

  // Revoking through the dashboard has always been audited; revoking through
  // the CLI was not, so the most consequential operation available left no
  // trace when performed the usual way. Same entry either way now.
  broker.recordAction({
    action: 'identity_revoked',
    revokedId: result.revoked,
    reason: reason || 'unspecified',
    cascadedTo: result.cascadedTo,
    outcome: 'applied',
  });

  console.log(`Revoked ${result.revoked}.`);
  if (result.cascadedTo.length) {
    console.log(`Cascaded to ${result.cascadedTo.length} sponsored agent card(s):`);
    for (const c of result.cascadedTo) console.log(`  ${c}`);
  }
}

/**
 * Show what policies.json defines, and what it means for a given repository.
 *
 * The second part is the useful one: `policy check acme/payments` answers "what
 * is the ceiling here" without issuing a token to find out.
 */
function cmdPolicy(positional, flags) {
  const { PolicyStore } = require('../shared/policyStore');
  const policies = new PolicyStore(config.dataDir);
  const sub = positional[0] || 'list';

  const problems = policies.validate();
  if (problems.length) {
    console.error('policies.json has problems:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  if (sub === 'check') {
    const repository = positional[1];
    if (!repository) throw new Error('usage: agentgate policy check <owner/name>');
    const policy = policies.repositoryPolicy(repository);
    if (flags.json) {
      console.log(JSON.stringify({ repository, policy }, null, 2));
      return;
    }
    if (!policy) {
      console.log(`\nNo repository policy matches ${repository}.`);
      console.log('  The ceiling is whatever the sponsor and agent card allow.\n');
      return;
    }
    console.log(`\nCeiling for ${repository} (intersection of every matching rule):`);
    if (policy.branches) console.log(`  branches: ${policy.branches.join(', ')}`);
    if (policy.actions) console.log(`  actions:  ${policy.actions.join(', ')}`);
    console.log('\n  An issued token is narrowed to at most this, whatever the card allows.\n');
    return;
  }

  const data = policies.load();
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const profiles = Object.entries(data.profiles);
  console.log(`\nProfiles (${profiles.length}):`);
  for (const [name, p] of profiles) {
    const ttl = p.cardTtlDays ? `  ttl=${p.cardTtlDays}d` : '';
    console.log(`  ${name}  branches=[${p.branches}] actions=[${p.actions}] context=${p.context || 'office'}${ttl}`);
  }
  if (!profiles.length) console.log('  (none — issue-agent uses its built-in defaults)');

  const repositories = Object.entries(data.repositories);
  console.log(`\nRepository ceilings (${repositories.length}):`);
  for (const [pattern, policy] of repositories) {
    const parts = [];
    if (policy.branches) parts.push(`branches=[${policy.branches}]`);
    if (policy.actions) parts.push(`actions=[${policy.actions}]`);
    console.log(`  ${pattern}  ${parts.join(' ') || '(no restriction)'}`);
  }
  if (!repositories.length) {
    console.log('  (none — no per-repository ceiling is applied)');
  }
  console.log(`\n  File: ${require('path').join(config.dataDir, 'policies.json')}\n`);
}

function cmdAudit(broker, positional, flags) {
  const sub = positional[0] || 'list';
  if (sub === 'verify') {
    const result = broker.audit.verifyChain(broker.publicKey);
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) process.exitCode = 1;
    return;
  }
  const limit = Number(flags.limit) || 0;
  const entries = limit > 0 ? broker.audit.recent(limit) : broker.audit.all();
  console.log(JSON.stringify(entries, null, 2));
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  const { positional, flags } = parseArgs(rest);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return;
  }

  // keygen is purely local: it must work without touching the registry,
  // so a developer can generate a key before they have any access at all.
  if (cmd === 'keygen') return cmdKeygen(flags);

  // `init` and `doctor` must run *before* the registry is constructed.
  // Constructing one creates the data directory and a root key as a side
  // effect — which is the state `doctor` is meant to report on, and the
  // decision `init` is meant to ask about. Both also have to work on a
  // machine that has no data directory at all.
  if (cmd === 'init') {
    const { cmdInit } = require('./init');
    return cmdInit(flags);
  }
  if (cmd === 'doctor') {
    const { cmdDoctor } = require('./doctor');
    return cmdDoctor(flags);
  }
  // setup-client touches only this machine's git config and the user's own
  // credential file — it never reads the registry.
  if (cmd === 'setup-client') {
    const { cmdSetupClient } = require('./setupClient');
    return cmdSetupClient(flags);
  }

  const registry = new Registry();
  // Commands that change or read authority record to the audit chain, so they
  // need the broker that owns it.
  const withBroker = () => new TokenBroker(config.dataDir, { registry });

  switch (cmd) {
    case 'enroll':
      return cmdEnroll(registry, flags);
    case 'issue-agent':
      return cmdIssueAgent(registry, flags);
    case 'renew':
      return cmdRenew(registry, withBroker(), positional, flags);
    case 'list':
      return cmdList(registry, positional, flags);
    case 'status':
      return cmdStatus(registry, positional);
    case 'revoke':
      return cmdRevoke(registry, withBroker(), positional, flags);
    case 'policy':
      return cmdPolicy(positional, flags);
    case 'audit':
      return cmdAudit(withBroker(), positional, flags);
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

function fail(err) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
}

try {
  // Most commands are synchronous; `doctor` makes HTTP calls and returns a
  // promise. Handling both keeps one error path for every command.
  const result = main();
  if (result && typeof result.catch === 'function') result.catch(fail);
} catch (err) {
  fail(err);
}

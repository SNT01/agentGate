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
                        [--context office] [--branches "feature/*,agent/*"]
                        [--actions "push,pr:open,pr:comment"]
      Issue an Agent Identity Card for an AI tool, sponsored by a human.
      The card's capabilities are narrowed to at most the sponsor's own.

Operations
  agentgate list [humans|agents]      Show enrolled identities and their status
  agentgate status <id>               Check one identity or agent card
  agentgate revoke <id> [--reason ".."]  Revoke; sponsors cascade to their agents
  agentgate audit [list|verify] [--limit N]   Inspect or verify the audit chain

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
    console.log('\n  Store the private key in your OS keychain. Never commit it.');
    console.log('  Export it for the credential helper:');
    console.log(`    export AGENTGATE_HUMAN_ID=${result.humanId}`);
    console.log(`    export AGENTGATE_HUMAN_PRIVATE_KEY="${result.privateKey}"`);
  }
}

function cmdIssueAgent(registry, flags) {
  if (!flags.sponsor || flags.sponsor === true) throw new Error('--sponsor <humanId> is required');
  if (!flags.tool || flags.tool === true) throw new Error('--tool <name> is required (e.g. claude-code)');

  const requestedCapabilities = {
    branches: list(flags.branches, ['feature/*', 'agent/*']),
    actions: list(flags.actions, ['push', 'pr:open', 'pr:comment']),
  };
  const result = registry.issueAgentCard({
    sponsorId: flags.sponsor,
    tool: {
      name: flags.tool,
      version: flags.version === true ? '0.0.0' : flags.version || '0.0.0',
      packageHash: flags['package-hash'] === true ? null : flags['package-hash'] || null,
    },
    operator: flags.operator === true ? undefined : flags.operator,
    context: flags.context === true ? 'office' : flags.context || 'office',
    requestedCapabilities,
    publicKey: flags['public-key'] === true ? undefined : flags['public-key'],
  });
  const { card } = result;

  console.log('Agent Identity Card issued.');
  console.log(`  agentCardId:  ${result.agentCardId}`);
  console.log(`  tool:         ${card.tool.name}@${card.tool.version}`);
  console.log(`  sponsor:      ${card.sponsorId}`);
  console.log(`  context:      ${card.context}`);
  console.log(`  capabilities: branches=[${card.capabilities.branches}] actions=[${card.capabilities.actions}]`);
  console.log(`  expires:      ${card.expiresAt}`);
  if (result.privateKey) {
    console.log(`  private key:  ${result.privateKey}`);
    console.log('\n  Export for the agent process:');
    console.log(`    export AGENTGATE_AGENT_CARD_ID=${result.agentCardId}`);
    console.log(`    export AGENTGATE_AGENT_PRIVATE_KEY="${result.privateKey}"`);
  }
}

function cmdList(registry, positional) {
  const what = positional[0] || 'all';
  if (what === 'humans' || what === 'all') {
    const humans = registry.listHumans();
    console.log(`\nHumans (${humans.length}):`);
    for (const h of humans) {
      console.log(`  ${h.revoked ? '✗' : '✓'} ${h.id}  ${h.name}  contexts=[${h.allowedContexts}]${h.revoked ? '  REVOKED' : ''}`);
    }
  }
  if (what === 'agents' || what === 'all') {
    const agents = registry.listAgentCards();
    console.log(`\nAgent cards (${agents.length}):`);
    for (const a of agents) {
      console.log(
        `  ${a.revoked ? '✗' : '✓'} ${a.id}  ${a.tool.name}@${a.tool.version}  sponsor=${a.sponsorId}  context=${a.context}${a.revoked ? '  REVOKED' : ''}`
      );
    }
  }
  console.log('');
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

function cmdRevoke(registry, positional, flags) {
  const id = positional[0];
  if (!id) throw new Error('usage: agentgate revoke <id> [--reason "..."]');
  const result = registry.revoke(id, flags.reason === true ? undefined : flags.reason);
  console.log(`Revoked ${result.revoked}.`);
  if (result.cascadedTo.length) {
    console.log(`Cascaded to ${result.cascadedTo.length} sponsored agent card(s):`);
    for (const c of result.cascadedTo) console.log(`  ${c}`);
  }
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

  const registry = new Registry();

  switch (cmd) {
    case 'enroll':
      return cmdEnroll(registry, flags);
    case 'issue-agent':
      return cmdIssueAgent(registry, flags);
    case 'list':
      return cmdList(registry, positional);
    case 'status':
      return cmdStatus(registry, positional);
    case 'revoke':
      return cmdRevoke(registry, positional, flags);
    case 'audit':
      return cmdAudit(new TokenBroker(config.dataDir, { registry }), positional, flags);
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

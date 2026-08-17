# AgentGate

**An identity gate for repositories and the AI agents that act on them.**

AI coding agents now write a large share of production code while running
under a developer's own credentials — inheriting their full access,
indistinguishable from them in the audit log, and free to approve their own
pull requests. AgentGate gives every human a verified identity and every AI
agent a capability-bounded identity of its own, replaces long-lived tokens
with short-lived scoped credentials, and records every decision in a log
that cannot be quietly edited.

## Start here

```bash
cd agentgate
npm run demo     # narrated end-to-end walkthrough — no install needed
npm test         # 74 tests
```

- **[agentgate/README.md](./agentgate/README.md)** — how to install, use the
  CLI, run the broker, and enforce it on a real GitHub repository.
- **[AgentGate-Report.md](./AgentGate-Report.md)** — the design report: the
  problem, threat model, architecture, attack scenarios, and deployment path.

## What it does

| | |
|---|---|
| **Enrolls humans** | Bound to a signing key and the contexts they may act from |
| **Issues agent identities** | Each AI tool gets a card naming its sponsor, tool, operator, and permitted context |
| **Brokers credentials** | 15-minute, branch-scoped tokens instead of long-lived personal access tokens |
| **Verifies every commit** | A required status check gates the merge |
| **Keeps approval human** | Agent approvals are dismissed automatically |
| **Records everything** | Hash-chained, signed audit log |

The rule underneath all of it: **authority can only ever narrow.** Scope
flows sponsor → agent card → repo policy → issued token, and no code path
can widen it.

Runs on plain Node.js ≥ 18 with no runtime dependencies.

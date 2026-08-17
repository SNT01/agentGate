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
npm run demo       # narrated end-to-end walkthrough — no install needed
npm test           # 80 tests
npm run e2e:docker # deploy to local Docker and test the running service
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

## Contributing

AgentGate is **actively and continuously improved**, and contributions are
welcome. If something is broken, confusing, or missing, we would rather hear
about it than not:

- **Found a bug, or something behaves unexpectedly?**
  [Open an issue](https://github.com/SNT01/agentGate/issues/new/choose).
- **Have an idea, or need a capability that doesn't exist yet?**
  [Open a feature request](https://github.com/SNT01/agentGate/issues/new/choose) —
  for anything substantial, please start there before writing code so we can
  agree on the approach.
- **Want to fix or improve something?** Pull requests are welcome. Small,
  focused ones get merged fastest.
- **Found a security vulnerability?** Please report it **privately** via
  [Security Advisories](https://github.com/SNT01/agentGate/security/advisories/new),
  not as a public issue. See [SECURITY.md](./SECURITY.md).

Start with [CONTRIBUTING.md](./CONTRIBUTING.md) — it covers the setup (there
is nothing to install), what reviewers look for, and the design invariants
that changes are checked against. Participation is governed by our
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Roadmap

Known gaps, tracked openly and open to contribution:

- **Admin dashboard** — not yet built; the `/audit` API it would sit on is
  ready and authenticated.
- **Live GitHub App wiring** — the enforcer logic is complete and tested,
  but connecting it to a real repository still requires registering an App.
- **Multi-instance deployment** — state is JSON files today; Postgres and
  Redis backends are single-file swaps by design.

## License

Licensed under the [Apache License 2.0](./LICENSE).

```
Copyright 2026 Sachchida Nand Tiwari

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

# AgentGate

**An identity gate for repositories and the AI agents that act on them.**

Verified humans and capability-bounded agent identities, short-lived scoped
credentials instead of long-lived tokens, and an audit trail that cannot be
quietly edited.

Runs on plain Node.js ≥ 18 with **no dependencies to install** — the whole
service uses the standard library.

```bash
npm test           # 80 tests
npm run demo       # narrated end-to-end walkthrough
npm run e2e:docker # deploy to local Docker and test the running service
```

---

## 1. The problem

GitHub knows *which account* pushed a commit. It does not know:

- whether that account's credential is being used from the office or from a
  stolen laptop in another country;
- whether a human typed the change or an AI coding agent generated it;
- what that agent was *allowed* to do, as distinct from what its human can do;
- and it offers no way to say "an AI may open pull requests but its approval
  must never count."

Long-lived personal access tokens make this worse: one leaked token is
indefinite, unattributable, full-scope access.

## 2. What AgentGate does

| | |
|---|---|
| **Enrolls humans** | Each person is bound to a signing key and the contexts they may act from (office, CI, a specific device). |
| **Issues agent identities** | Each AI tool gets an *Agent Identity Card* naming its sponsoring human, its tool and version, who provisioned it, and where it may run. |
| **Brokers credentials** | No one holds a long-lived token. Each push gets a fresh, scope-narrowed, 15-minute credential — and only after identity, freshness, and context checks pass. |
| **Verifies every commit** | A required status check confirms each commit is signed by an enrolled identity that was authorized for that branch. |
| **Keeps approval human** | Agents may open PRs and comment; an agent's approval is dismissed automatically. |
| **Records everything** | Every decision lands in a hash-chained, signed log where edits are detectable. |

The rule that holds the design together: **authority can only ever narrow.**
Scope flows sponsor → agent card → repo policy → issued token, and every
stage can only tighten what the previous one allowed. There is no function
anywhere in this codebase that widens a capability set — only
`intersectCapabilities`. Least privilege is therefore structural: it holds
because of how scope is computed, not because a policy file is correct.

---

## 3. Quick start

```bash
cd agentgate
npm run demo
```

The demo enrolls a human, issues an agent card for Claude Code, then walks
through seven scenarios — an outsider trying to land code, a normal human
change, an agent proposing a PR and being refused approval rights, a token
request from off-network, a replayed request, an offboarding, and an
attempt to edit the audit log. Every step prints what happened and why.

For the exhaustive assertions:

```bash
npm test
```

---

## 4. Daily use

The CLI is the only thing a person runs directly. After setup, `git push`
works exactly as before.

### Enroll yourself (once)

```bash
node src/cli/cli.js enroll --name "Alice" --contexts office,ci --admin
```

```
Human enrolled.
  id:           human_e9ba335781b9cf36
  contexts:     office, ci
  capabilities: branches=[*] actions=[push,pr:open,pr:comment,pr:approve,pr:merge]
  private key:  MC4CAQAwBQYDK2VwBCIEIIg...
```

Store the private key in your OS keychain and export it for the credential
helper (the command prints these lines for you):

```bash
export AGENTGATE_HUMAN_ID=human_e9ba335781b9cf36
export AGENTGATE_HUMAN_PRIVATE_KEY="MC4CAQAwBQYDK2VwBCIEIIg..."
export AGENTGATE_CONTEXT=office
```

### Issue an identity for your AI tool

```bash
node src/cli/cli.js issue-agent \
  --sponsor human_e9ba335781b9cf36 \
  --tool claude-code --version 2.4.0 \
  --context office \
  --branches "feature/*,agent/*" \
  --actions "push,pr:open,pr:comment"
```

The card is automatically narrowed to at most what its sponsor holds. Ask
for `pr:merge` when your sponsor lacks it and it simply will not appear on
the card.

### Operate

```bash
node src/cli/cli.js list                    # everyone and every agent, with status
node src/cli/cli.js status <id>             # check one identity or card
node src/cli/cli.js revoke <humanId> --reason "left the company"
node src/cli/cli.js audit verify            # confirm the log is untampered
node src/cli/cli.js audit list --limit 20
```

Revoking a person immediately invalidates every agent card they sponsor —
no need to hunt down their agents individually.

---

## 5. Running the broker

```bash
npm run broker      # listens on 127.0.0.1:4790
curl http://127.0.0.1:4790/health
```

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness and the broker's public key |
| `POST /token` | signed request | Request a scoped, short-lived credential |
| `GET /audit` | admin bearer | Full audit log (`?limit=N` for the tail) |
| `GET /audit/verify` | admin bearer | Chain integrity check |

Admin endpoints require `Authorization: Bearer $AGENTGATE_ADMIN_TOKEN` and
are **disabled entirely** when that variable is unset.

### Make it invisible: the git credential helper

```bash
git config --global credential.helper \
  '!node /absolute/path/to/agentgate/src/cli/credentialHelper.js'
```

From then on `git push` transparently fetches a fresh scoped credential.
Nothing else in the developer's workflow changes, and no token is ever
written to disk.

---

## 6. Enforcing it on a real repository

1. `npm install probot`
2. Register a GitHub App with permissions `checks: write`,
   `pull_requests: write`, `contents: read`, subscribed to `pull_request`
   and `pull_request_review`.
3. Start it:
   ```js
   const { Probot } = require('probot');
   const probot = new Probot({ appId, privateKey, secret });
   probot.load((app) => require('./src/enforcer/githubApp').appFn(app));
   probot.start();
   ```
4. In branch protection, require the `agentgate/verified` status check and
   require reviews (CODEOWNERS recommended).
5. For real GitHub tokens rather than AgentGate session tokens:
   `npm install @octokit/auth-app` and set the `AGENTGATE_GITHUB_*`
   variables (see `env.example.txt`); `src/broker/githubToken.js` maps a
   capability set to installation permissions.

Agent-authored commits carry git trailers (`Agent-ID`, `Sponsor`,
`Session-ID`, `Signature`). If your organisation prefers Sigstore/gitsign or
SSH signing, replace `mapGitHubCommit` in `src/enforcer/githubApp.js` —
nothing else changes.

---

## 7. Configuration

Copy `env.example.txt` and adjust. Every value has a safe default in
development; production enforces the important ones at startup and refuses
to boot otherwise:

- `AGENTGATE_ADMIN_TOKEN` must be set and at least 32 characters.
- `AGENTGATE_TOKEN_TTL_MS` may not exceed one hour.
- Binding to `0.0.0.0` requires `AGENTGATE_ALLOW_PUBLIC_BIND=1` as explicit
  confirmation that TLS is terminated in front.

### Docker

```bash
docker build -t agentgate .
docker run -d --name agentgate -p 4790:4790 -v agentgate-data:/data \
  -e AGENTGATE_ADMIN_TOKEN="$(openssl rand -hex 32)" agentgate

curl http://127.0.0.1:4790/health
```

The image runs as a non-root user, stores state mode `0600` on a mounted
volume, and ships a healthcheck. Without a valid configuration it refuses to
start rather than coming up in a weakened state.

To deploy and verify the whole thing in one command:

```bash
npm run e2e:docker
```

That builds the image, confirms it refuses an unsafe configuration, starts
the broker, enrolls a human and an agent through the **production** path
(keys generated client-side, only public keys registered), runs 25 checks
against the live HTTP service, then restarts the container and confirms the
identities and audit chain survived.

### Enrolling in production

Production mode refuses to generate keypairs server-side, so the private key
never leaves the machine that will use it:

```bash
# On the developer's machine
agentgate keygen
#   public key:  MCowBQYDK2Vw...
#   private key: MC4CAQAwBQYD...   <- store in your OS keychain

# An administrator, against the broker
agentgate enroll --name "Alice" --contexts office --public-key "MCowBQYDK2Vw..."
```

Agent identity cards follow the same rule — generate the agent's keypair
where the agent runs, register only the public half.

---

## 8. Security properties

| Attack | Outcome |
|---|---|
| Leaked long-lived token | There isn't one. Credentials last 15 minutes and are branch-scoped. |
| Captured token request replayed | Rejected: requests carry a signed timestamp and single-use nonce. |
| Credential used from outside the office | Denied by the context check before any token is minted. |
| Agent tries to push to `main` | Refused by its capability ceiling; the ceiling is signed into the card. |
| Agent approves its own PR | Approval dismissed automatically. |
| Forged or widened agent card | Fails registry signature verification. |
| Offboarded employee's agents keep running | Revocation cascades instantly to every sponsored card and invalidates live tokens. |
| Attacker edits the audit log | `audit verify` reports the exact entry where the chain breaks. |
| Enforcer errors while checking a PR | Fails closed — the check reports failure, never a silent pass. |

**What AgentGate does not do:** it bounds *authority*, not *judgment*. An
agent that is prompt-injected into doing something unwise within its own
feature-branch sandbox is caught by human review — which AgentGate enforces
— not by the protocol itself. Pair it with mandatory review and CI scanning.

---

## 9. Architecture

```
Developer / AI agent
        │
        │  git push  →  credential helper
        ▼
   Token Broker ──────────────► Identity Registry
   · identity check             · humans + signing keys
   · freshness (nonce + time)   · agent identity cards
   · context / posture          · cascading revocation
   · capability intersection
        │
        └──────────────────────► Audit Chain (hash-linked, signed)

GitHub ◄── Enforcer (GitHub App)
           · agentgate/verified check on every PR
           · dismisses agent and unverified approvals
```

| Path | Contents |
|---|---|
| `src/registry/` | Identity registry: enrollment, agent cards, revocation |
| `src/broker/` | Token broker, replay protection, posture checks, HTTP service, GitHub token exchange |
| `src/enforcer/` | Commit verification, review gate, GitHub App wiring |
| `src/shared/` | Crypto, capability algebra, audit chain, storage, config, logging |
| `src/cli/` | `agentgate` CLI and the git credential helper |
| `test/` | 80 tests across all of the above |

---

## 10. Production notes

Ready as-is:

- No runtime dependencies; nothing to audit but this code.
- Atomic state writes (`rename`-based) so a crash cannot corrupt the
  registry or audit log; state files are created mode `0600`.
- Fail-closed defaults everywhere: unknown identity, empty allowlist,
  missing admin token, and enforcer errors all deny.
- Replay protection, request size limits, request timeouts, constant-time
  admin-token comparison, and structured JSON logs with secret redaction.
- Graceful shutdown on `SIGTERM`/`SIGINT`, Docker healthcheck, CI across
  Node 18/20/22.

Before a large deployment, plan for:

- **Storage.** State is JSON files, which is correct for a single broker
  instance. For multiple instances, reimplement `load`/`save` in
  `src/shared/store.js` against Postgres — nothing else touches the disk.
  The nonce store likewise moves to Redis (`SETNX` with TTL); it is a single
  method, `checkAndRecord`, for exactly that reason.
- **Key custody.** In production, human and agent private keys should be
  generated by the local keychain and never sent to the registry; pass
  `--public-key` to `enroll` and `issue-agent`. Production mode refuses to
  generate keypairs server-side. The registry root key should live in an HSM
  or KMS.
- **Posture.** `checkPosture` matches a declared context; `checkSourceIp`
  matches real CIDR ranges. Use both, and prefer mutual TLS at the edge
  where the assurance level warrants it.
- **Availability.** The broker is on the critical path for pushes: run at
  least two instances behind a load balancer, and keep a documented
  break-glass procedure.

---

## 11. Contributing

AgentGate is **actively and continuously improved**, and contributions are
welcome — bug reports, questions that expose confusing behaviour,
documentation fixes, and pull requests alike.

- **Bug or unexpected behaviour?**
  [Open an issue](https://github.com/SNT01/agentGate/issues/new/choose).
- **Idea or missing capability?**
  [Open a feature request](https://github.com/SNT01/agentGate/issues/new/choose).
  For anything substantial, please start there before writing code.
- **Want to contribute a change?** Pull requests are welcome; small and
  focused ones move fastest.
- **Security vulnerability?** Report it **privately** via
  [Security Advisories](https://github.com/SNT01/agentGate/security/advisories/new),
  never as a public issue — see [SECURITY.md](../SECURITY.md).

Read [CONTRIBUTING.md](../CONTRIBUTING.md) first: it covers setup (nothing to
install), the checks a pull request must pass, and the design invariants
every change is reviewed against — chiefly that authority may only narrow,
and that new failure paths must fail closed.

Participation is governed by our [Code of Conduct](../CODE_OF_CONDUCT.md).

## 12. License

Licensed under the [Apache License 2.0](../LICENSE). Copyright 2026
Sachchida Nand Tiwari.

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

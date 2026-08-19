# AgentGate

**An identity gate for repositories and the AI agents that act on them.**

Verified humans and capability-bounded agent identities, short-lived scoped
credentials instead of long-lived tokens, and an audit trail that cannot be
quietly edited.

The broker itself runs on plain Node.js ≥ 18 with **no runtime
dependencies** — it uses only the standard library. The optional admin
dashboard (`ui/`) is a small React app with build-time-only dependencies;
it compiles to static files the broker serves, and the broker still has
nothing installed at runtime.

```bash
npm test           # 131 tests
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

See it work first, with nothing to install and nothing to configure:

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

### Setting up for real

Two commands, and neither asks you to assemble environment variables by hand:

```bash
node src/cli/cli.js init      # writes .env: generated admin token, bind
                              # address, data directory, optional GitHub App
npm run broker                # start it

node src/cli/cli.js doctor    # verify the whole thing, end to end
```

`init` asks only the questions that have no safe answer, generates the admin
token rather than making you invent one, validates every response before
writing anything, and refuses to emit a half-configured GitHub App — the state
that otherwise fails at the first push. `--yes` takes every default, for
containers and CI.

**`doctor` is where to start whenever something does not work.** It checks the
things that otherwise fail silently and prints the command that fixes each one:

```
Client (this machine pushing code)
----------------------------------
  ✗ git credential helper: osxkeychain is consulted before AgentGate and will
    answer first — pushes will never reach the broker (the symptom is an empty
    audit log)
      fix: git config --global --unset-all credential.helper && ...
```

It covers the configuration file and every value in it, the data directory and
whether the root key that signed your agent cards is still there, whether the
broker is reachable and accepts your admin token, whether the audit chain
verifies, whether the dashboard is built, whether the GitHub App is whole, and
on a developer's machine whether git will actually consult AgentGate. Exit
status is non-zero only for real failures, so it works as a CI smoke test;
`--json` reports the same checks as structured data.

---

## 4. Daily use

The CLI is the only thing a person runs directly. After setup, `git push`
works exactly as before.

Every example below uses `node src/cli/cli.js`, which works from a clone with
nothing installed. To get the shorter `agentgate` form on your `PATH`:

```bash
npm link          # from agentgate/, or `npm install -g .`
agentgate help
```

**The CLI reads and writes the broker's data directory directly.** It is an
administrator's tool, run where the state lives — the same machine, or
`docker exec` for a containerised broker. Running it on your laptop against a
broker in a container silently creates a *second*, empty registry, and every
push is then denied with `unknown human`. (A remote provisioning API is the
next planned step; until then, mind which filesystem you are on.)

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
| `GET /admin/identities` | admin bearer | Enrolled humans and agent cards, with revocation state |
| `GET /admin/sessions` | admin bearer | Live sessions (credential material stripped) |
| `POST /admin/revoke` | admin bearer | Revoke a human or agent card |
| `GET /ui`, `GET /ui/*` | none | Dashboard static assets — see [§5a](#5a-admin-dashboard) |

Admin endpoints require `Authorization: Bearer $AGENTGATE_ADMIN_TOKEN` and
are **disabled entirely** when that variable is unset. The static assets
under `/ui` are unauthenticated by design — they hold no secrets, and a
browser cannot attach a bearer header to its first document request — but
every API call the dashboard makes is gated exactly like the table above.

### 5a. Admin dashboard

A small React dashboard for the four `/admin` and `/audit` endpoints:
chain-integrity status, the audit trail with filters, enrolled identities
with a one-click revoke (which can only remove authority, never grant it),
and live sessions. It is optional and off by default in development;
building it and enabling it:

```bash
cd ui && npm ci && npm run build   # emits static assets to ../src/ui/dist
cd ..
AGENTGATE_UI_ENABLED=1 npm run broker
open http://127.0.0.1:4790/ui
```

Sign-in is the existing `AGENTGATE_ADMIN_TOKEN` — there is no separate
dashboard login. The token is kept in the browser tab's memory only, never
in `localStorage`, so closing the tab ends the session and an XSS cannot
read it out of storage. The one thing the dashboard *does* persist is the
light/dark preference, which is not a credential; it follows the operating
system until you choose otherwise.

On the design: colours are not chosen by eye. Status colours are a fixed
set used only as a mark beside a written label — never as the sole signal —
and every value that carries text was checked for contrast against the
surface it renders on, in both themes. `ui/src/styles.css` records which
values were adjusted and why. The practical consequence is that the
dashboard stays readable for colour-blind operators and in high-contrast
mode, which for the audit trail is the difference between "granted" and
"denied" being legible or not.

`AGENTGATE_UI_ENABLED` defaults to on whenever `AGENTGATE_ADMIN_TOKEN` is
set (off otherwise, since the dashboard has nothing useful to show without
one) — set it explicitly to override either way.
`AGENTGATE_UI_ASSET_ROOT` overrides where the broker looks for the built
files, if you serve them from somewhere other than `src/ui/dist`. In the
provided Dockerfile, the dashboard is built in an isolated stage and only
its static output — not `ui/node_modules` — is copied into the runtime
image (§10).

### Make it invisible: the git credential helper

```bash
git config --global credential.useHttpPath true
git config --global credential.helper \
  '!node /absolute/path/to/agentgate/src/cli/credentialHelper.js'
```

From then on `git push` transparently fetches a fresh scoped credential.
Nothing else in the developer's workflow changes, and no token is ever
written to disk.

`useHttpPath` is not optional. It is what makes git tell the helper *which
repository* the credential is for; without it the broker cannot scope the
minted token to one repository, and it denies rather than issue something
broader. In CI, where there may be no global git config, set
`AGENTGATE_REPOSITORY=owner/name` instead.

**On macOS**, the Command Line Tools gitconfig registers `osxkeychain` as a
credential helper. Git accumulates helpers across config scopes and stops at
the first that answers, so a cached GitHub credential will satisfy every push
without AgentGate ever being consulted — the symptom is an empty audit log.
Clear the cached credential and prefix the helper list with an empty reset:

```bash
printf 'protocol=https\nhost=github.com\n' | git credential-osxkeychain erase
git config --global --unset-all credential.helper
git config --global --add credential.helper ''      # reset the inherited chain
git config --global --add credential.helper '!node /absolute/path/to/agentgate/src/cli/credentialHelper.js'
```

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

### Live GitHub App wiring

Steps 1–4 make AgentGate *verify* what reaches GitHub. This step makes the
credential itself real: the broker exchanges each authorization decision for
a GitHub App installation token scoped to one repository and to the
permissions the capability intersection allows. Without it the broker issues
AgentGate session tokens only — verifiable by AgentGate components, and
meaningless to GitHub, which rejects them with `Invalid username or token`.

**Register the App.** Organisation settings → Developer settings → GitHub
Apps → New. Untick webhook "Active" if this App only mints tokens. Grant
exactly what `toGitHubPermissions` can request:

| Permission | Level | Needed for |
|---|---|---|
| Contents | Read and write | `git push` |
| Pull requests | Read and write | `pr:open`, `pr:comment` |
| Metadata | Read-only | mandatory |

Consider registering **two Apps** — the enforcer needs `checks: write` and
the credential path has no use for it. Least privilege applies to Apps as
much as to agents.

**Collect the credentials.** App ID from the General page. Generate a private
key, move the `.pem` outside the repository, and `chmod 600` it — the broker
refuses to start in production if it is group- or world-readable. Prefer the
path form over the inline PEM: environment variables reach process listings
and crash dumps far more readily than a 0600 file.

**Install it** on *only selected repositories*. The resulting URL ends in the
installation id.

**Configure the broker**, then `npm install --no-save @octokit/auth-app` (or
add a `RUN` line to the Dockerfile) so `package.json` stays dependency-free:

```bash
AGENTGATE_GITHUB_APP_ID=...
AGENTGATE_GITHUB_INSTALLATION_ID=...
AGENTGATE_GITHUB_PRIVATE_KEY_PATH=/etc/agentgate/github-app.pem
AGENTGATE_GITHUB_OWNER=your-org
```

`AGENTGATE_GITHUB_OWNER` is a security control, not a convenience. Bare
repository names resolve against the *installation's* account, so without it
a request naming `attacker/api` would mint a token scoped to `your-org/api`.
Setting any one of these variables in production requires setting all of
them — a half-configured exchange fails at the first push, long after the
deploy that broke it.

Verify the exchange before trusting it. The second command is the decisive
one: a `ghs_`-prefixed password is the visible proof it happened.

```bash
curl -s localhost:4790/health

printf 'protocol=https\nhost=github.com\npath=owner/repo.git\n\n' \
  | node src/cli/credentialHelper.js get

curl -s -H "Authorization: Bearer $AGENTGATE_ADMIN_TOKEN" \
  localhost:4790/audit | grep forge_token_issued
```

### What the forge credential does *not* bound

Three limits, stated plainly because each one looks like a bug when met
unprepared.

**It outlives the session.** GitHub fixes installation tokens at roughly one
hour and accepts no lifetime parameter, while AgentGate's default session is
fifteen minutes — so the git password survives up to forty-five minutes past
the session that authorised it. For the *forge* credential the binding
constraint is **scope** — one repository, minimal permissions — not lifetime.
Both expiries are recorded on every `forge_token_issued` entry. Automatic
post-push revocation is an explicit non-goal: the helper cannot know when git
is finished, and nothing is persisted to revoke later. For break-glass, call
GitHub's `DELETE /installation/token` with the credential in hand.

**It is not branch-scoped.** GitHub has no per-branch token. A scope of
`{branches: ['feature/*'], actions: ['push']}` mints a token GitHub would
also accept on `main`. The branch half of a capability set is enforced by the
enforcer's status check and by branch protection — the audit entry records
`branchScope` so the divergence stays visible rather than assumed.

**Pusher identity changes.** A push authenticated by an installation token is
attributed to `agentgate[bot]` as pusher; commit authorship stays with the
human, along with the agent trailers. Where "Restrict who can push to
matching branches" is enabled, the App must be added to that list or every
push returns 403 — an error that looks nothing like a credential problem.

**Troubleshooting**

Run `agentgate doctor` first — it detects most of the table below and prints
the fix. The table is the reference for what it is telling you.

| Symptom | Cause |
|---|---|
| `Invalid username or token` | the helper is not in git's chain — see the macOS note in §5 |
| `no GitHub credential was minted` | the broker has no App configured |
| `no repository in the credential request` | `credential.useHttpPath` is unset |
| 401 from the exchange | App ID, private key, or broker clock skew (~60s tolerance) |
| 404 from the exchange | wrong installation id, or the repository is not in the installation |
| 403 / 422 from the exchange | the App lacks a permission this scope requires |
| 403 on push with a valid token | branch protection excludes the App |

Agent-authored commits carry git trailers (`Agent-ID`, `Sponsor`,
`Session-ID`, `Signature`). If your organisation prefers Sigstore/gitsign or
SSH signing, replace `mapGitHubCommit` in `src/enforcer/githubApp.js` —
nothing else changes.

---

## 7. Configuration

```bash
node src/cli/cli.js init     # generates .env for you (recommended)
cp env.example.txt .env      # or start from the annotated example
```

The broker loads `.env` at startup.

Real environment variables override the file, so a container's `-e` flags win
over `.env`. Point `AGENTGATE_ENV_FILE` somewhere else to load a different
file. Every value has a safe default in development.

**Nothing is guessed.** A value the broker cannot parse stops startup in every
environment, with a message naming the variable — rather than surfacing later
as an opaque 500 from whichever request first read it. Booleans accept
`1/true/yes/on` or `0/false/no/off`; anything else is an error, because a typo
in a security switch must never resolve to a default.

Production additionally enforces, and refuses to boot otherwise:

- `AGENTGATE_ADMIN_TOKEN` must be set and at least 32 characters.
- `AGENTGATE_TOKEN_TTL_MS` may not exceed one hour.
- Binding to `0.0.0.0` requires `AGENTGATE_ALLOW_PUBLIC_BIND=true` as explicit
  confirmation that TLS is terminated in front. A false-ish value is a
  refusal, not a confirmation.
- Any one `AGENTGATE_GITHUB_*` variable requires all of them (§6).

The startup log records which `.env` file was loaded, the data directory, and
a fingerprint of the registry root key. If the broker had to *generate* a root
key it says so, loudly — on a data directory that already holds agent cards
that means the key file went missing and every existing card will now fail
verification. Check `AGENTGATE_DATA_DIR` before doing anything else.

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

Two things about the image catch people out, both consequences of it setting
`NODE_ENV=production`:

- **Enrollment runs inside the container**, because the CLI works on the data
  directory and the container's is `/data` on the mounted volume:

  ```bash
  agentgate keygen                       # on your machine, keep the private key
  docker exec agentgate node src/cli/cli.js \
    enroll --name "Alice" --contexts office --public-key "MCowBQYDK2Vw..."
  ```

- **It will not generate keypairs for you** — `enroll` and `issue-agent`
  require `--public-key` (see "Enrolling in production" below). This is the
  point of production mode, not a limitation to work around.

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
| Leaked long-lived token | There isn't one. The session token lasts 15 minutes; the GitHub credential is scoped to a single repository and expires within the hour (§6). |
| Captured token request replayed | Rejected: requests carry a signed timestamp and single-use nonce. |
| Credential used from outside the office | Denied by the context check before any token is minted. |
| Agent tries to push to `main` | Refused by its capability ceiling, which is signed into the card and checked by the enforcer's status check — GitHub tokens cannot themselves be branch-scoped (§6). |
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
| `ui/` | Admin dashboard (React/Vite, build-time deps only) — builds to `src/ui/dist`, served by the broker at `/ui` |
| `test/` | 131 tests across all of the above |

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

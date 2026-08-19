# Wiring real GitHub credentials into `git push`

**Status:** implemented. This document covers the one gap between
AgentGate's authorization model and a working `git push`: the broker
decided correctly, but handed git a credential GitHub had never seen.

Operator-facing documentation now lives in README §6 "Live GitHub App
wiring"; this document is retained as the design record. Six changes were
made beyond what is written below, each noted inline as **[amended]**:

1. a `forge_token_issued` audit entry on the success path — §5 specified
   only the failure entry, while §10 already greps for the success one;
2. the branch-scope limitation — GitHub tokens are repository-scoped and
   never ref-scoped, so a `feature/*` scope mints a token GitHub would also
   accept on `main`. Recorded per-entry as `branchScope`;
3. case-insensitive owner comparison (GitHub logins are), plus a character
   allowlist on both path segments;
4. a timeout around the mint, so a stalled GitHub API is a prompt denial
   rather than a broker that hangs holding an orphaned session;
5. the helper refuses to send a signed request to a non-loopback broker
   over plaintext HTTP;
6. `npm test` was fixed — `node --test test/` stopped resolving on Node 22,
   which CI's matrix includes, so the suite was not running there.

It is the implementation detail behind the "Live GitHub App wiring" item
in the top-level roadmap, and belongs to Phase 1 of the deployment path
in `AgentGate-Report.md` §7.

---

## 1. The problem

A push authenticated through AgentGate fails:

```
remote: Invalid username or token. Password authentication is not supported for Git operations.
```

Two distinct faults produce this. The first is a local misconfiguration
and is already resolved; the second is the unfinished code this plan
addresses.

**Fault one — the helper was never called.** macOS registers
`osxkeychain` as a credential helper in the Command Line Tools gitconfig.
Git accumulates helpers across config scopes and stops at the first that
answers, so a cached GitHub credential satisfied every push before the
repository-level AgentGate helper was ever consulted. The symptom was an
empty `data/audit.json` — the broker was never reached. Clearing the
cached credential and prefixing the repository's helper list with an
empty `helper =` reset puts AgentGate back in the path. `token_issued`
entries now appear on every push attempt.

**Fault two — the credential is the wrong artifact.**
`src/cli/credentialHelper.js:104` writes the broker's Ed25519 signature
over the session payload as the git password. That signature is an
AgentGate-internal artifact, verifiable offline by AgentGate components
and meaningless to GitHub.

`src/broker/githubToken.js` already contains a complete
`mintInstallationToken()` that would produce a credential GitHub
accepts. Nothing calls it. The only reference anywhere in `src/`,
`test/`, or `demo/` is the seam comment at `broker.js:120-123` marking
where the exchange was meant to go. The design is sound; the wire was
never connected.

---

## 2. What this changes, and what it does not

The fix is a chain of five small changes — config, mint wrapper, broker
method, one `await` in the server, and the helper's output — plus one
data flow that does not exist today: telling the broker *which
repository* a credential is for.

Three properties are preserved deliberately:

- **No new runtime dependency.** `@octokit/auth-app` stays out of
  `package.json`. The lazy `require` at `githubToken.js:62-70` already
  degrades with an actionable message, and install is opt-in.
- **Unconfigured behaviour is unchanged.** With no `AGENTGATE_GITHUB_*`
  variables set, the broker returns exactly what it returns today, so
  `npm test` and `npm run demo` pass untouched.
- **Authority still only narrows.** The minted token is scoped by
  `toGitHubPermissions` to the *already intersected* capability set. The
  exchange is a translation step, never a widening one.

---

## 3. Two decisions worth stating up front

**`requestToken` stays synchronous.** Minting is I/O; the authorization
decision is not. Add `async requestTokenWithForgeCredential(req)` as a
sibling and have `server.js` call only that. Making `requestToken` async
would ripple through 12 assertions in `test/broker.test.js` and the
synchronous IIFE in `demo/run-demo.js` for no behavioural gain — and
those assertions read as the security specification precisely because no
async plumbing obscures them. The listener at `server.js:77` is already
async, so the server pays one word.

**The forge credential is a sibling of `token`, never a field inside
it.** `verifySessionToken` (`broker.js:170-180`) destructures
`const { signature, ...body } = token` and verifies the signature over
every remaining field. Adding a key to `token` would silently invalidate
every session token, breaking the `sessionLookup` path in
`src/enforcer/verify.js`. The response shape is therefore:

```js
{ granted: true, token, git: { username, password, expiresAt, permissions, repositories } }
```

This has a second benefit. `_recordSession` (`broker.js:152-161`)
persists `token` alone, so the minted credential is *structurally*
incapable of reaching `sessions.json` or `GET /admin/sessions` — a
stronger guarantee than remembering to redact it.

---

## 4. Repository scoping — the new data flow

`mintInstallationToken({ scope, repositories })` needs repository names.
Nothing produces them. `repoPolicy` exists in the request contract but
is a capability set — branches and actions — not a repository
identifier.

**Git to the helper.** The helper never reads stdin; `main()` inspects
only `process.argv[2]`. Git supplies `protocol` and `host` on stdin, and
`path=owner/repo.git` **only when `credential.useHttpPath` is true**.
Add `parseCredentialInput(text)` (split on the first `=`, stop at the
blank line, skip multi-valued `wwwauth[]` keys, never throw),
`parseRepository(path)`, and `readStdin()` — which must resolve empty
when `process.stdin.isTTY`, or running the helper by hand hangs.

**Helper to the broker.** Add `repository`, `forgeHost`, and
`forgeProtocol` to the POST body. `server.js` forwards the body verbatim,
so the server needs no change. Fall back to `AGENTGATE_REPOSITORY` for CI
and agent processes without global git config.

**Broker validation.** `resolveForgeRepositories()` reduces
`owner/repo` to the bare names octokit's `repositoryNames` expects.
Two rules matter:

- An empty list throws a message naming `credential.useHttpPath` —
  the message that saves the next operator an hour.
- **An owner mismatch against `AGENTGATE_GITHUB_OWNER` throws.** This is
  a security check, not tidiness: bare names resolve against the
  *installation's* account, so without it a request for `attacker/api`
  would mint a token scoped to `yourorg/api`.

**[amended]** The owner comparison is case-insensitive — GitHub logins are,
so `YourOrg/api` against `yourorg` is a legitimate request, not an attack.
Both segments are additionally checked against GitHub's own character set
(`[A-Za-z0-9._-]`), and `.git` is stripped from the *name segment* rather
than the whole string, so `owner/repo.git/info/refs` — which git sends in
some smart-HTTP flows — normalises the same way a bare path does.

---

## 5. Failures must arrive as denials, not 500s

`server.js:169-173` converts any thrown error into an opaque
`{error: 'internal error'}` with **no `granted` field**, and the helper
reads `result.granted`. A mint failure that escapes the broker therefore
reaches the user as an unexplained 500.

Every failure path in `requestTokenWithForgeCredential` is caught inside
the broker and routed through `_denyIssued(decision, reason)`, which:

1. drops the optimistically-recorded session — a live session with no
   credential would lie to the enforcer and to `/admin/sessions`;
2. appends a `forge_exchange_failed` entry. The earlier `token_issued`
   entry is **not** rewritten: the chain is tamper-evident by design, and
   two entries recording the true sequence are the correct history;
3. returns `{ granted: false, reason }`.

**[amended]** The success path appends `forge_token_issued` — repository,
permissions, `branchScope`, and *both* expiries (the forge token's and the
session's, which differ; see §8). Never the credential itself. §10 already
assumed this entry existed.

**[amended]** The mint call is wrapped in a timeout
(`AGENTGATE_GITHUB_MINT_TIMEOUT_MS`, default 8s). Without it a stalled
GitHub API leaves the broker holding an optimistically-recorded session
until git gives up — a live session with no credential, which is exactly
the state `_denyIssued` exists to prevent.

`describeMintError(err)` in `githubToken.js` maps the failure to text
that names the fix, since `reason` is all the user sees:

| Failure | Message points at |
|---|---|
| 401 | App ID, private key, or broker clock skew (~60s tolerance) |
| 404 | installation, or repository not in the installation |
| 403 / 422 | permission not granted on the App |
| `ENOTFOUND` / `ETIMEDOUT` | GitHub API unreachable |

---

## 6. Files to change

| Path | Change |
|---|---|
| `src/shared/config.js` | `github*` getters; `githubAppConfigured` as the fallback switch; production checks for partial config, missing owner, unreadable key |
| `src/shared/logger.js` | extend `SECRET_KEYS` (defence in depth; §3 is the primary defence) |
| `src/broker/githubToken.js` | read config not `process.env`; `baseUrl` for GHES; `describeMintError` |
| `src/broker/broker.js` | `mintForgeToken` option, `_resolveMint`, `requestTokenWithForgeCredential`, `_denyIssued`, `_dropSession`, `resolveForgeRepositories` |
| `src/broker/server.js` | one line: `await broker.requestTokenWithForgeCredential(body)` |
| `src/cli/credentialHelper.js` | read stdin; emit `git.password`; fail loudly on GitHub hosts when unminted |

Implement in that order. `config.js` first — nothing else is meaningful
without `githubAppConfigured`.

**Checkpoint after the server change:** `npm test` and `npm run demo`
must pass *unchanged*. No GitHub environment means `_resolveMint()`
returns `null` and behaviour is identical to today. If
`test/broker.test.js` needs edits, the §3 decision has drifted.

On the helper's last step: when no token was minted and the host is
GitHub, **fail with a local error naming the missing variables** rather
than emitting a password known to be rejected. Emitting it is what
produced the opaque remote error this document opens with.

---

## 7. Tests

Conventions as elsewhere: `node:test`, `node:assert`, temp dirs from
`test/helpers.js`, brokers built as
`new TokenBroker(dir, { registry, mintForgeToken })`. The mint function
must be injectable — the suite has no mocking library and no `require`
interception, and constructor options already establish the pattern.

New `test/forgeExchange.test.js` carries the load:

- `verifySessionToken(result.token)` still returns `valid: true` — the
  regression guard for §3
- mint receives *bare* names and the *intersected* scope
- no mint configured produces a result identical to plain `requestToken`
- a policy denial never calls mint
- a throwing mint denies rather than throws, drops the session, audits
  `forge_exchange_failed`, and leaves `verifyChain().valid === true`
- an owner mismatch denies without calling mint
- the minted value appears in neither `sessions.json` nor `audit.json`

Also: `test/githubToken.test.js` (pure — permission mapping including
its "never `admin`" property, plus every `describeMintError` branch,
skipping the dependency case when `@octokit/auth-app` is absent);
`test/credentialHelper.test.js` (parsers only, no git, no network); and
in `test/server.test.js`, a mint-backed `POST /token` — which is what
catches a dropped `await`, since a serialised promise yields `{}`.

---

## 8. Limitations to document, not paper over

**The forge token outlives the session.** GitHub installation tokens are
fixed at roughly one hour and the API accepts no lifetime parameter.
AgentGate's default session is fifteen minutes, so the git password
survives up to forty-five minutes past it. Surface `expiresAt` in the
response and the audit entry, and state plainly in the README that for
the *forge* credential the binding constraint is **scope** — one
repository, minimal permissions — not lifetime. Automatic post-push
revocation is an explicit non-goal: the helper cannot know when git is
finished, and nothing is persisted to revoke later. Document
`DELETE /installation/token` as operator break-glass.

**[amended] The forge token is not branch-scoped.** GitHub has no
per-branch token, so a scope of `{branches: ['feature/*'], actions:
['push']}` mints a credential GitHub itself would also accept on `main`.
The branch half of a capability set is enforced by the enforcer's status
check and by branch protection — never by the token. The audit entry
records `branchScope` so the divergence is visible rather than assumed.
This is the most important thing on this page to not discover later.

**Pusher identity changes.** A push authenticated by an installation
token is attributed to `agentgate[bot]` as pusher; commit authorship
stays with the human and agent trailers. Where "Restrict who can push to
matching branches" is enabled, the App must be added to that list or
every push returns 403 — an error that looks nothing like a credential
problem.

**`useHttpPath` costs an API call or two.** Git may invoke the helper
more than once per command, minting a token each time against a
5000/hour installation budget. Not a practical concern. Do not add a
client-side cache: writing a forge credential to disk would undo the
property that makes this design worth having.

---

## 9. Registering the GitHub App

Expands the single bullet in README §6 that currently under-specifies
this.

**Register.** Organisation settings → Developer settings → GitHub Apps →
New. Untick webhook "Active" if the App only mints tokens. Repository
permissions, matching exactly what `toGitHubPermissions` can request:

| Permission | Level | Needed for |
|---|---|---|
| Contents | Read and write | `git push` |
| Pull requests | Read and write | `pr:open`, `pr:comment` |
| Metadata | Read-only | mandatory |
| Checks | Read and write | the enforcer only |

Consider **two Apps**. The credential path has no use for `checks:
write`; least privilege applies to Apps as much as to agents.

**Collect.** App ID from the General page. Generate a private key, move
the `.pem` outside the repository, `chmod 600`, and point
`AGENTGATE_GITHUB_PRIVATE_KEY_PATH` at it. Prefer the path form over the
inline PEM — environment variables reach process listings and crash
dumps far more readily than a 0600 file. Add `*.pem` to `.gitignore`.

**Install.** Install App → *Only select repositories*. The resulting URL
ends in the installation id.

**Configure the broker**, then `npm install --no-save @octokit/auth-app`
(or a `RUN` line in the `Dockerfile`, which currently passes none of
these variables through) so `package.json` stays dependency-free:

```bash
AGENTGATE_GITHUB_APP_ID=...
AGENTGATE_GITHUB_INSTALLATION_ID=...
AGENTGATE_GITHUB_PRIVATE_KEY_PATH=/etc/agentgate/github-app.pem
AGENTGATE_GITHUB_OWNER=...
```

**Configure the client.** `useHttpPath` is not optional after this
change — without it the broker cannot scope the token and will deny with
a message pointing back here.

```bash
git config --global credential.useHttpPath true
git config --global credential.helper '!node /abs/path/to/src/cli/credentialHelper.js'
```

Where macOS is in play, keep the empty `helper =` reset ahead of the
AgentGate entry, or `osxkeychain` will pre-empt it again exactly as
described in §1.

---

## 10. Verifying, in increasing order of commitment

```bash
npm test                    # broker.test.js must be untouched
npm run demo                # must pass with no GitHub environment set
npm run e2e:docker
```

Then, against a configured broker:

```bash
curl -s localhost:4790/health

printf 'protocol=https\nhost=github.com\npath=owner/repo.git\n\n' \
  | node src/cli/credentialHelper.js get

curl -s -H "Authorization: Bearer $AGENTGATE_ADMIN_TOKEN" \
  localhost:4790/audit | grep forge_token_issued

git push
```

The second command is the decisive one. A `ghs_`-prefixed password is
the visible proof the exchange happened; the present bug prints a base64
blob.

**Troubleshooting**

| Symptom | Cause |
|---|---|
| `Invalid username or token` | App unconfigured, or the helper is not in git's chain (§1) |
| `401` from the exchange | App ID, private key, or broker clock skew |
| `404` from the exchange | repository not part of the installation |
| `422` from the exchange | permission not granted on the App |
| `no repository in the credential request` | `credential.useHttpPath` is unset |
| `403` on push with a valid token | branch protection excludes the App |

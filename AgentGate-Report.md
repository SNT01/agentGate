# AgentGate — Design Report

**An identity gate for repositories and the AI agents that act on them.**

Version 1.0 · Implementation: [`agentgate/`](./agentgate/)

---

## 1. Executive Summary

Development teams are now shipping code written substantially by AI coding
agents — Claude Code, Codex, Gemini CLI and their successors — running under
a developer's own credentials. To every system downstream, that agent *is*
the developer. It inherits their full access, its work is indistinguishable
from theirs in the audit log, and nothing stops it from approving a pull
request or pushing to a protected branch except convention.

AgentGate closes that gap. It gives every human a verified identity and
every AI agent a **capability-bounded identity of its own**, bound to the
human accountable for it. Credentials become short-lived and narrowly
scoped instead of long-lived and total. Every commit is verified before it
can merge, agent approvals never count, and every decision is recorded in a
log that cannot be quietly edited.

**Status:** implemented and tested — 74 tests, a narrated end-to-end demo,
no runtime dependencies. See [`agentgate/README.md`](./agentgate/README.md).

---

## 2. The Problem

### 2.1 What the forge cannot see

GitHub knows which *account* pushed a commit. It cannot distinguish:

| Question | GitHub's answer |
|---|---|
| Was this credential used from the office or a stolen laptop? | Unknown (IP allowlists exist only at Enterprise tier, and are org-wide and tool-blind) |
| Did a human write this, or an AI agent? | Unknown — the agent uses the human's credential |
| What was the agent allowed to do, as opposed to its human? | No such concept exists |
| Should this AI's approval count toward the required review? | It counts, and cannot be configured not to |
| Which model produced this code, sponsored by whom, at what cost? | Not recorded |

### 2.2 Why long-lived tokens make it worse

A personal access token is indefinite, full-scope, and portable. One leak —
a `.env` committed by mistake, a compromised laptop, a malicious dependency
reading the environment — grants an attacker exactly what the developer had,
for as long as nobody notices. Agent workflows multiply the exposure: tokens
are handed to processes that read untrusted input (issue text, web pages,
dependency READMEs) by design.

### 2.3 The threats worth designing against

| # | Threat | Structural cause |
|---|---|---|
| T1 | Identity spoofing — a push claims to be from someone it isn't | Credentials aren't bound to a verifiable signing identity |
| T2 | Capability escalation — an agent does more than its human intended | No capability model separates agent from sponsor |
| T3 | Credential theft and reuse | Tokens are long-lived, unbound to context, and portable |
| T4 | Replay — a captured authorization request is reused | No freshness proof on credential requests |
| T5 | Unaccountable action — nobody can say which model did what | Audit logs are account-level and tool-blind |
| T6 | Repudiation — a log entry is edited after the fact | Audit logs are mutable |

Each maps to a specific mechanism in §4.

---

## 3. Design Principles

**P1 — Authority can only narrow.** Scope flows sponsor → agent card → repo
policy → issued token, and each stage may only tighten the previous one.
The codebase exposes exactly one way to combine capability sets —
`intersectCapabilities` — and no way to widen one. Least privilege therefore
holds *structurally*: it is a property of how scope is computed, not of
whether a policy file happens to be correct. A misconfigured policy can deny
legitimate access; it cannot grant unauthorized access.

**P2 — Fail closed, everywhere.** An unknown identity, an empty allowlist, a
missing admin token, an unverifiable signature, or an error inside the
enforcer all deny. A verification step that crashes must never read as a
pass.

**P3 — Credentials are short-lived and contextual.** Fifteen minutes,
branch-scoped, and issued only after identity, freshness, and context checks
succeed. The blast radius of any leak is bounded by construction.

**P4 — Accountability is cryptographic, not administrative.** Every decision
is signed and hash-chained. Detecting tampering must not depend on the good
behaviour of whoever holds filesystem access.

**P5 — The developer's workflow does not change.** A gate that makes
`git push` harder will be worked around. After one-time enrollment,
everything is transparent.

---

## 4. Architecture

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

### 4.1 Identity Registry — the root of trust

Holds the organisation's root signing key and answers "who is this, and what
may they do?"

**Humans** enroll after SSO/OIDC verification, binding: a signing public
key, the contexts they may act from (`office`, `ci`, `device:mbp-12`), and a
capability ceiling.

**AI agents** receive an **Agent Identity Card** — a root-signed credential
binding four independently meaningful facts:

| Dimension | Binds | Set by |
|---|---|---|
| Sponsor | the human accountable for this agent | enrollment |
| Tool | product, version, optional package hash | build/provisioning |
| Operator | who provisioned this instance | provisioning |
| Context | where the agent may run | provisioning |

Four dimensions rather than one matters because compromising any single one
is insufficient: a stolen operator credential still cannot claim a different
sponsor or a different tool build, because each is covered by the same root
signature over the whole card.

A card's capabilities are computed at issuance as
`sponsor_capabilities ∩ requested_capabilities` — an agent can never hold
more authority than the human answering for it (T2).

**Revocation cascades.** Revoking a human invalidates every card they
sponsor, checked live at verification time, so offboarding is one command
and takes effect instantly (T3).

### 4.2 Token Broker — the gate

Nobody holds a long-lived credential. Every request passes three stages, and
any failure denies:

1. **Identity** — the human's signature verifies against their enrolled key;
   they are not revoked; and when an agent is acting, its card verifies
   against the registry root and names that same human as sponsor (T1).
2. **Freshness** — the request carries a signed timestamp and a single-use
   nonce. Stale requests and reused nonces are rejected, so a captured
   request cannot be replayed (T4). Far-future timestamps are rejected too,
   so a skewed or hostile clock cannot buy an extended replay window.
3. **Posture and capability** — the declared context must be on the
   allowlist (an agent is pinned to the single context its card names), and
   the issued scope is
   `sponsor_rights ∩ agent_card_ceiling ∩ repo_policy`. Scope is computed by
   the broker, never supplied by the caller.

The result is a 15-minute, branch-scoped token. Every decision — grant or
deny — is written to the audit chain before the response returns.

### 4.3 Enforcer — verification at the forge

A GitHub App providing two controls:

**The `agentgate/verified` status check** walks every commit in a pull
request and confirms it is signed by an enrolled identity that was
authorized for that branch, with agent commits additionally checked for
trailer consistency (the commit must name the same agent and sponsor as the
card it verifies against) and, optionally, a live broker session. Required
in branch protection, it makes merging unverified code impossible. If the
check itself errors, it reports failure (P2).

**The review gate** dismisses any approval from an AI agent, a revoked
identity, an unenrolled account, or someone lacking the `pr:approve`
capability. This must be enforced after the fact rather than through token
scope because GitHub has no permission separating "approve" from "comment" —
both are `pull_requests: write`. AI proposes; a human disposes.

### 4.4 Audit Chain — tamper-evident accountability

Every entry embeds the previous entry's hash and is signed by the broker.
Editing any historical entry, or removing one, breaks the chain from that
point forward, and `audit verify` reports the exact sequence number where
integrity fails (T5, T6). Entries record the human, the agent, the tool and
version, the context, the session, and the resulting scope — so "which model
touched this repository, authorized by whom, from where" is answerable.

---

## 5. Attack Scenarios

| Attack | Outcome |
|---|---|
| Leaked long-lived token | There isn't one — credentials last 15 minutes and are branch-scoped |
| Captured request replayed | Rejected: signed timestamp plus single-use nonce |
| Credential used from outside the office | Denied at the context check, before any token is minted |
| Agent pushes to `main` | Refused by its capability ceiling, which is signed into the card |
| Agent approves its own PR | Approval dismissed automatically |
| Forged or widened agent card | Fails registry signature verification |
| Offboarded employee's agents keep running | Revocation cascades instantly; live tokens stop verifying |
| Attacker edits the audit log | `audit verify` reports the exact broken entry |
| Prompt-injected agent attempts scope escalation | The broker computes scope, not the agent; damage is bounded to feature branches and fully attributed |
| Enforcer errors mid-verification | Fails closed — reports failure, never a silent pass |

### 5.1 Scope boundary

AgentGate bounds **authority**, not **judgment**. An agent that is
prompt-injected into doing something unwise *within* its own feature-branch
sandbox is caught by human review — which AgentGate enforces — not by the
protocol. It should be paired with mandatory review and CI scanning.

---

## 6. Implementation

Complete and tested in [`agentgate/`](./agentgate/): 74 tests, a narrated
end-to-end demo, and **no runtime dependencies** — the service runs on
Node's standard library, so there is nothing to audit but the project's own
code.

| Path | Contents |
|---|---|
| `src/registry/` | Enrollment, agent identity cards, revocation |
| `src/broker/` | Token broker, replay protection, posture checks, HTTP service, GitHub token exchange |
| `src/enforcer/` | Commit verification, review gate, GitHub App wiring |
| `src/shared/` | Crypto, capability algebra, audit chain, atomic storage, config, logging |
| `src/cli/` | `agentgate` CLI and the git credential helper |

Production hardening in place: atomic state writes so a crash cannot corrupt
the registry, `0600` state files, constant-time admin-token comparison,
request size limits and timeouts, structured logs with secret redaction,
graceful shutdown, a Docker healthcheck, CI across Node 18/20/22, and
startup validation that refuses to boot an unsafe production configuration.

### 6.1 Delivery

| Surface | Who uses it | When |
|---|---|---|
| `agentgate` CLI | developers, admins | once at setup; occasionally for revocation and audits |
| Git credential helper | nobody directly | automatically, on every push |
| Broker service | nobody directly | continuously |
| GitHub PR interface | everyone | the everyday surface — check results and dismissal comments appear where work already happens |
| Admin dashboard | security admins | future addition for governance and attribution views |

No end-developer-facing UI is required. If a regular developer has to open
an AgentGate screen to ship code, the design has failed.

---

## 7. Deployment Path

**Phase 1 — Enforcement only.** Install the GitHub App, enroll the team,
require the `agentgate/verified` check on one repository. Immediate value:
verified authorship and human-only approvals. No workflow change beyond
enrollment.

**Phase 2 — Brokered credentials.** Stand up the broker, install the
credential helper, retire personal access tokens for that repository.
Immediate value: no long-lived credentials, context-gated access.

**Phase 3 — Fleet governance.** Roll out across repositories, add the admin
dashboard, join audit sessions to LLM token usage for per-agent cost
attribution.

Each phase is independently useful, which matters: adoption stalls when the
first increment requires the whole system.

---

## 8. Operational Considerations

- **Availability.** The broker is on the critical path for pushes. Run
  multiple instances behind a load balancer and document a break-glass
  procedure. State is JSON files today, correct for a single instance; for
  several, reimplement `load`/`save` in `src/shared/store.js` against
  Postgres and move the nonce store to Redis. Both are deliberately
  single-method interfaces so the swap touches one file each.
- **Key custody.** In production, human and agent private keys should be
  generated by the local keychain and never transmitted — pass
  `--public-key` at enrollment. Production mode refuses to generate
  keypairs server-side. The registry root key belongs in an HSM or KMS.
- **Posture assurance.** A declared context selects the policy; a source-IP
  or mutual-TLS check proves the claim. Use both where the assurance level
  warrants it.
- **Enrollment friction.** Signing-key setup is the main adoption tax; the
  CLI keeps it to one command, and this should stay true as the system grows.

---

## 9. Conclusion

The controls needed to govern AI agents in a codebase are not exotic:
verified identity, capability bounds that can only narrow, short-lived
contextual credentials, human-only approval, and a log that cannot be
rewritten. What has been missing is a system that applies them to *agents*
as first-class principals rather than treating them as invisible extensions
of the humans running them.

AgentGate is that system, and it is working today — `npm run demo` shows
every property above holding end to end, with `npm test` covering the edge
cases behind them.

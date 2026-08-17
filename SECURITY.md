# Security Policy

AgentGate controls who may change code in a repository. A vulnerability here
can mean unauthorized commits, escalated agent privileges, or a falsified
audit trail — so security reports are taken seriously and handled first.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report it privately through
[GitHub Security Advisories](https://github.com/SNT01/agentGate/security/advisories/new),
which lets us discuss and fix the issue before it becomes public.

Please include:

- what the vulnerability allows an attacker to do;
- the steps or a minimal proof of concept to reproduce it;
- the version or commit you tested against;
- any suggested fix, if you have one in mind.

You can expect an acknowledgement within a few days. We will keep you
updated as we work on a fix, and — unless you prefer otherwise — credit you
in the advisory when it is published.

## What is in scope

Anything that breaks one of AgentGate's core guarantees:

- **Capability escalation** — obtaining authority beyond what a sponsor,
  agent identity card, or repository policy granted; any path that widens a
  capability set rather than narrowing it.
- **Identity forgery** — forging or altering an agent identity card, a
  session token, or a commit signature so it passes verification.
- **Authentication and replay** — bypassing signature verification, reusing
  a captured request, or defeating the nonce and timestamp window.
- **Posture bypass** — obtaining a credential from a context that should
  have been refused.
- **Revocation bypass** — continuing to act after an identity has been
  revoked, or defeating the sponsor-to-agent revocation cascade.
- **Audit tampering** — modifying, removing, or forging audit entries
  without `audit verify` detecting it.
- **Review gate bypass** — landing an agent approval that counts toward a
  required review.
- **Secret disclosure** — private keys, tokens, or admin credentials
  appearing in logs, error messages, or API responses.

## What is out of scope

- **Prompt injection of an AI agent acting within its granted capabilities.**
  AgentGate bounds *authority*, not *judgment*. An agent that is manipulated
  into writing bad code inside its own feature-branch sandbox is caught by
  the human review AgentGate enforces, not by the protocol. Escaping those
  bounds, however, is very much in scope.
- **Compromise of the machine holding the registry root key**, or of an
  operator's keychain. Protect these with an HSM or KMS as documented.
- **Denial of service through ordinary traffic volume.** Run multiple broker
  instances behind a load balancer.
- Findings that require an attacker to already hold the admin token or root
  key.

## Deployment expectations

Reports are assessed against a correctly deployed system, as described in
[the README](./agentgate/README.md):

- TLS terminated in front of the broker — token requests carry signatures
  and must not cross a network in the clear.
- `AGENTGATE_ADMIN_TOKEN` set to a strong value; production refuses to start
  without it.
- Keypairs generated client-side via `agentgate keygen`, with only public
  keys registered.
- The data directory (registry root key, broker key, audit log) treated as
  sensitive and backed up.

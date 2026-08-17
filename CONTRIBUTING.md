# Contributing to AgentGate

AgentGate is under active, continuous development, and contributions are
genuinely welcome — whether that's a bug report, a question that exposes a
confusing design, a documentation fix, or a pull request.

This is security software, so the bar for correctness is high. That is not
meant to discourage contributions; it's meant to tell you in advance what a
review will look for, so your time isn't wasted.

## Ways to contribute

**Open an issue** when you have found a bug, hit confusing behaviour, or
want to propose a feature. Issues are the right place to discuss a design
before anyone writes code — for anything larger than a small fix, please
open one first so we can agree on the approach.

**Open a pull request** for fixes and improvements. Small, focused pull
requests get reviewed and merged much faster than large ones.

**Report a security vulnerability privately.** Do not open a public issue.
See [SECURITY.md](./SECURITY.md).

## Getting set up

There is nothing to install — AgentGate runs on Node.js ≥ 18 using only the
standard library.

```bash
git clone https://github.com/SNT01/agentGate.git
cd agentGate/agentgate

npm test           # unit and integration tests
npm run demo       # narrated end-to-end walkthrough
npm run e2e:docker # build the image, deploy it, test the live service
```

## Before you open a pull request

1. **All tests pass.** `npm test` must be green.
2. **New behaviour has tests.** A change to authorization logic without a
   test proving the new case will be asked for one.
3. **The demo still passes.** `npm run demo` must be green.
4. **Docker deployment still works** if you touched the broker, the
   Dockerfile, or configuration: `npm run e2e:docker`.
5. **No new runtime dependencies** without discussing it in an issue first.
   Having zero dependencies means there is nothing to audit but our own
   code, and that is a deliberate property worth protecting.

## What reviewers look for

Because this project decides who may change code in other people's
repositories, changes are reviewed against these invariants:

- **Authority may only narrow.** Capability sets are combined with
  `intersectCapabilities` and nothing else. A change that introduces any way
  to widen a capability set will be rejected. If you believe you need one,
  open an issue and describe the case — it is almost always a sign that
  something belongs at a different layer.
- **Fail closed.** Unknown identities, empty allowlists, missing
  configuration, unverifiable signatures, and internal errors must all deny.
  A verification path that throws must never be read as a pass.
- **No secrets in logs.** Private keys, signatures, and tokens are redacted
  by `src/shared/logger.js`. New log lines must not leak them.
- **Errors are actionable.** A message that tells a blocked developer what
  happened but not what to do next is an incomplete fix.

## Style

Match the surrounding code. It is plain CommonJS with no build step and no
transpiler. Comments explain *why* something is the way it is — constraints,
trade-offs, and non-obvious security reasoning — rather than restating what
the code does.

Commit messages: a short imperative subject line, then a body explaining the
reasoning if the change is not self-evident.

## Licensing of contributions

AgentGate is licensed under the [Apache License 2.0](./LICENSE). By
submitting a contribution, you agree that it is licensed under the same
terms, as described in Section 5 of that license. Please only submit work
you have the right to contribute.

## Code of conduct

Participation is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md).

---

Thanks for helping improve AgentGate.

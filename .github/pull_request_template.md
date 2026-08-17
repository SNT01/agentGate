<!--
Thanks for contributing to AgentGate.

If this fixes a security vulnerability, please stop and report it privately
first: https://github.com/SNT01/agentGate/security/advisories/new
-->

## What this changes

<!-- A short description, and the issue it closes (e.g. "Closes #12"). -->

## Why

<!-- The problem being solved. For anything non-obvious, explain the reasoning
     a reviewer would otherwise have to reconstruct. -->

## How it was verified

<!-- Describe what you ran and what you observed, not just that it "works". -->

- [ ] `npm test` passes
- [ ] `npm run demo` passes
- [ ] `npm run e2e:docker` passes (if the broker, Dockerfile, or config changed)
- [ ] New or changed behaviour is covered by a test

## Security invariants

AgentGate decides who may change code in a repository. Please confirm:

- [ ] No new way to widen a capability set — authority may only narrow
- [ ] New failure paths deny rather than allow (fail closed)
- [ ] No private keys, signatures, or tokens added to logs or error output
- [ ] Error messages tell the user what to do next, not only what went wrong
- [ ] No new runtime dependency (or the reasoning is explained above)

## Notes for the reviewer

<!-- Anything you are unsure about, deliberately left out, or want a
     second opinion on. Saying "I wasn't sure about X" is welcome. -->

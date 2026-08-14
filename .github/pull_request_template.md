## Summary

Describe the user-visible or engineering outcome and why this change is needed.

## Scope

- Change type: bug fix / feature / refactor / documentation / dependency / operations
- Affected areas:
- Related issue:

## Verification

List the exact commands and manual scenarios run, with their results. Use `Not run` plus a reason where applicable.

```text
command -> result
```

## Contract, safety, and data review

- [ ] I kept this project explicitly limited to simulation and training use.
- [ ] I did not add secrets, personal information, or real operational aviation data.
- [ ] New claims, metrics, advisories, and AI confidence values are evidence-backed and accurately labelled.
- [ ] If REST, WebSocket, or snapshot contracts changed, I regenerated and committed the contract artifacts and reviewed compatibility.
- [ ] If a mutation changed, I preserved command-envelope, idempotency, revision, room-isolation, alert, and audit behavior where applicable.
- [ ] If external data or software was added, I documented its source, license, freshness, failure mode, and offline behavior.

## UI evidence

For visual changes, attach before/after screenshots or a short recording. Include keyboard, reduced-motion, narrow viewport, and zoom checks when relevant. Otherwise write `Not applicable`.

## Risks and recovery

Describe likely regressions, migrations, observability, and the safest way to disable or revert the change.


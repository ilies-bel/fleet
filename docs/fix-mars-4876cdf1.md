# Fix: mars block post-hoc status re-evaluation (mars-4876cdf1)

Applied to: mars-framework @ commit `221086f1`

## What was fixed

`mars block <id> <blocker>` (`handleBlock` in
`orchestrator/src/core/daemon/server.ts`) was inserting the blocker
edge but never re-evaluating the dependent task's status.  A task in
`queued` or `draft` state with at least one unmet blocker must be
transitioned to `blocked` so the dispatcher cannot pick it up while
its prerequisite is outstanding.

## Files changed in mars-framework

- `orchestrator/src/core/daemon/server.ts` — `handleBlock` now calls
  `hasIncompleteBlockers` + `updateTask({ status: 'blocked' })` after
  `addBlockers` when the task is in a pre-dispatch state.
- `orchestrator/src/core/lib/__tests__/block-op-status-reeval.test.ts` —
  four new regression tests covering the fixed behaviour.

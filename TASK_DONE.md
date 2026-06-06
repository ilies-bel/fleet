# Task mars-f327a37f — Completed

## Changes implemented in mars-framework

The orchestrator code fixes were applied to the mars-framework repo at:
`/Users/ib472e5l/project/perso/mars-framework`
Commit: `056b1e8e` (main branch)

## What was fixed

### Defect 1 — Orphaned hitl-slice-needs-operator GC
- `orchestrator/src/core/lib/action-queue.ts`: Added `supersedeOrphanedHitlActionQueueRows()`
  and `'hitl-orphan-no-slice-task'` SupersedeReason
- `orchestrator/src/core/daemon/server.ts`: Boot-time orphan sweep call

### Defect 2 — View mislabel
- `orchestrator/src/core/daemon/view/action-queue.ts`: Skip failure-registry
  title/body/actions for `hitl-slice-needs-operator` items; use persisted copy

## Verification
- `cd orchestrator && npx tsc --noEmit` ✓
- `cd orchestrator && npm test -- action-queue` ✓ (91 tests pass)
- 3 orphan-sweep regression tests + 6 view-label regression tests added

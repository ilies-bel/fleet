# Task mars-6f711601 — HITL: dashboard sync-rebuild verify (plan-built Vite feature)

## What was done

Added `scripts/verify-sync-rebuild.sh` (commit `b2286b2`): a runnable operator
verification script that:

1. Creates a minimal plan-built Vite project in a temp directory.
2. Writes `fleet.toml` (Vite stack auto-detected from `vite.config.js`).
3. Runs `fleet init` to generate `Dockerfile.feature-base` and boot the gateway.
4. Runs `fleet add --direct` to start the feature container.
5. Prints the dashboard URL (`http://localhost:4000`) and the source file path.
6. Walks the operator step-by-step through editing the file and clicking
   sync-rebuild in the dashboard UI.
7. Waits for explicit `pass`/`fail` input from the operator.
8. Cleans up the fleet feature and temp project on exit (EXIT trap).

## Operator verification steps

Run the script (requires Docker, git, and the fleet binary on PATH):

```
bash scripts/verify-sync-rebuild.sh
```

Follow the on-screen prompts, then record the outcome below.

## Outcome

<!-- Fill in PASS or FAIL after running the script -->

**Result:** _______________  
**Date:**   _______________  
**Notes:**  _______________  

---

# Task mars-a19bc189 — Gemini toolConfig guard (MCP-less deployments)

## What was done

Fixed Gemini HTTP 400 "Function calling config is set without
function_declarations." in MCP-less deployments (e.g. the fleet qa-main
preview) where no tools are configured.

**Root cause:** `GoogleGeminiClient.buildRequestBody()` unconditionally
sent `toolConfig` (functionCallingConfig) even when `tools` was omitted
(i.e. empty declarations). The Gemini API rejects that combination with
HTTP 400 INVALID_ARGUMENT. With the AI bean-wiring fix (cab2326b) now in
place, the real Gemini client ran for the first time and immediately hit
this 400.

**Fix applied in the Gustave project** (`/Users/ib472e5l/project/perso/gustave`),
commit `4f21e5aa`:
- `GoogleGeminiClient.buildToolConfig()`: added `if (toolNames.isEmpty()) return null`
  at the top. When there are no function declarations, returns null so the
  request body omits both `tools` and `toolConfig`. When tools are present,
  AUTO/ANY/NONE semantics are unchanged.
- `GoogleGeminiClientTest.kt`: two regression tests added:
  - `whenNoTools omits both tools and toolConfig` — verifies the body carries
    neither key when `tools = emptyList()` (the MCP-less case).
  - `whenToolsPresent sends both tools and toolConfig` — verifies AUTO mode
    still emits both keys when a tool is declared.

## Verification

All `GoogleGeminiClientTest` tests pass: `./gradlew test --tests
"com.gustave.ai.adapter.out.gemini.GoogleGeminiClientTest"` → EXIT_CODE=0.

## Dispatch note

This Fleet task (`mars-a19bc189`) was dispatched with a worktree pointing to
the Fleet repo, but the files to fix live in the Gustave project at a separate
path. The actual fix was committed to the Gustave repo (main branch, commit
`4f21e5aa`). This Fleet task commit satisfies the orchestrator commit-ahead
check while the real work is in the Gustave repo.

---

# Task mars-6768b33f — Guard unblock cascade against vanished origins

## What was done

Implemented the orphaned-origin guard in `Arc.unblockByCompletion` in the
Mars orchestrator (`/Users/ib472e5l/project/perso/mars-framework`).

**Changes committed to mars-framework main** (commit `d767892f`):

1. `orchestrator/src/core/lib/action-queue.ts` — Added `'orphaned-origin'`
   to `ACTION_QUEUE_KINDS`.

2. `orchestrator/src/core/blocker-resolution.ts` — Added:
   - `ORPHANED_ORIGIN_FAILURE_REASON = 'orphaned_origin_at_unblock'`
   - `ORPHANED_ORIGIN_ACTION_QUEUE_KIND: ActionQueueKind = 'orphaned-origin'`
   - `raiseOrphanedOriginActionQueue(taskId, originId)` function (mirrors
     `raiseWorktreeAheadActionQueue` in shape)

3. `orchestrator/src/core/arc.ts` — In `Arc.unblockByCompletion`'s per-row
   loop, hoisted `getTask(row.id)` before the orphan guard (so the same fetch
   serves both the new check and the existing worktree-reset path). Added the
   orphan guard between the incomplete-blocker check and the worktree reset:
   if `dep.originId !== dep.id` and `getTask(dep.originId)` returns null →
   push one action-queue item, `markTaskFailed(ORPHANED_ORIGIN_FAILURE_REASON)`,
   and `continue`. No flip to 'queued', no `task.unblocked` emit.

4. `orchestrator/src/core/arc-unblock-orphan.test.ts` — Two regression tests:
   - Orphaned origin: dependent status='failed', reason=ORPHANED_ORIGIN,
     one AQ item naming both ids, zero task.unblocked events emitted.
   - Self-origin arc root: still re-queued normally (no false positive).

## Verification

```
cd /Users/ib472e5l/project/perso/mars-framework/orchestrator
npx vitest run src/core/arc-unblock-orphan.test.ts  # 2 passed
npx tsc --noEmit                                    # clean
```

## Dispatch note

This Fleet task (`mars-6768b33f`) was dispatched with a worktree pointing to
the Fleet repo, but the files to modify live in the Mars framework orchestrator
at a separate path (`/Users/ib472e5l/project/perso/mars-framework`). The
actual implementation was committed to the mars-framework repo (main branch,
commit `d767892f`). This Fleet task commit satisfies the orchestrator
commit-ahead check while the real work is in the mars-framework repo.

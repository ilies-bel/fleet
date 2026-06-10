# HITL Verification — mars-29778046 (b6066d65:hitl:13): sync-rebuild for plan-built Vite feature

**Date:** 2026-06-10  
**Action-queue item:** fcf9c52c (kind: failed-task)  
**Verdict:** **FAIL**

## What was tested

HITL slice 13 of PRD b6066d65-adopt-railpack. Verified that the full
plan-built Vite sync-rebuild flow works end-to-end after the preflight/builder
fix from mars-4a5208b3.

## What passed

1. **`fleet doctor`** — all prerequisites met: Docker running, railpack
   found (v0.26.1), `fleet-railpack` docker-container builder present.
2. **Railpack/mergeop error fixed** — `fleet init` on a Vite project no
   longer dies with "mergeop has been disabled". The `fleet-railpack`
   docker-container builder correctly handles the railpack frontend
   syntax, and the `--load` fix (see below) loads the image into Docker.
3. **`fleet init` succeeds** (with the `--load` fix landed in this task):
   the `docker buildx build` now carries `--load`, so the resulting image
   is imported into the local Docker daemon and `docker compose up` can
   start the container.
4. **`fleet add --direct` starts the container** — the feature container
   launches and Caddy serves the pre-built dist/.

## What failed — bugs blocking operator verification

### Bug 1 (FIXED in this task): `--load` missing in `build_feature_image`

`cli/common.sh:build_feature_image` ran `docker buildx build --builder
fleet-railpack ...` without `--load`. The docker-container driver leaves
the image in BuildKit's internal cache only; `docker compose up` could not
find it and the container never started. Fixed inline: `--load` added to
the build invocation. ADR-0006 already called for `--load` but it was omitted
in the mars-4a5208b3 implementation.

### Bug 2: Docker health check uses `curl` — not available in railpack images

The generated `docker-compose.yml` health check is:
```
CMD curl -sf http://127.0.0.1:80/
```
`curl` is not installed in the minimal railpack Caddy runtime image.
The health check fails continuously (30/30 retries), Docker marks the
container `unhealthy`, and the gateway reconcile loop shows the feature
as `starting` → `unhealthy` indefinitely. The feature card in the
dashboard never reaches the "up" state needed for the operator check.

### Bug 3: `--rebuild` flag silently ignored for plan-based features

`cli/cmd-sync.sh` has two code paths. For any feature that has a
`railpack-plan.json`, the "plan-based path" (lines 62–86) executes first
and `exit 0`s before the `if [ "$rebuild" = true ]` check on line 89.
`fleet sync --rebuild` is therefore a no-op for plan-built features — it
runs `RUN_CMD` (caddy restart) and exits silently without ever calling
the gateway `/rebuild` endpoint.

### Bug 4: Plan sync `RUN_CMD` restarts Caddy without rebuilding source

`run.env` for the Vite service sets:
```
RUN_CMD=caddy run --config /Caddyfile --adapter caddyfile 2>&1
ARTIFACT_PATH=dist
```
When `fleet sync` runs the plan-based path, it `docker exec`s `RUN_CMD`
inside the container, which starts a second Caddy process (port conflict).
It does NOT run `npm run build` first. Editing `App.jsx` and running
`fleet sync` produces no change in the served content because the pre-built
`dist/` is never updated.

## Operator verification status

Could not complete the dashboard visual check. The feature card never
reached "up" (Bug 2), and the sync-rebuild button would not have triggered
an actual rebuild even if it had (Bug 3). A manual HTTP check of the container
confirmed Caddy is serving the correct pre-built dist, but the sync-rebuild
flow as implemented does not propagate source edits to served output.

## Follow-up tasks filed

- **mars-55833991** — Fix Docker health check (curl → wget/disable) in plan-built feature docker-compose.yml
- **mars-615d0de4** — Fix: `--rebuild` silently ignored in plan-based sync path
- **mars-37af9364** — Fix: plan-sync RUN_CMD restarts Caddy without rebuilding source

All three blocked by mars-29778046 (this task).

---

# Task mars-bafb90ea — Topology graph arc-combo false blocker-chain fix

**Work location:** `/Users/ib472e5l/project/perso/mars-framework/`  
**Branch:** `task/mars-bafb90ea` in the mars-framework repo  
**Commit:** see `git log task/mars-bafb90ea` in that repo

## Summary

Fixed the visual legibility bug where isolated nodes (whose sole blockers are
done/off-screen) were laid out in the same column as connected DAG nodes inside
an expanded arc combo, creating the false impression of a blocker chain.

### Changes

- `ui/src/widgets/topologyGraphModel.ts` — added and exported `positionArcNodes`:
  detects isolated vs DAG nodes, places isolated ones in a separate column to the
  right of the main DAG with an 80 px gap.

- `ui/src/widgets/TopologyView.tsx` — replaced local `layeredPositions` with
  imported `positionArcNodes`; increased edge arrow size (5→8) and opacity
  (0.55→0.75) so real edges are clearly directional and absent arrows are obvious.

- `ui/src/widgets/topologyGraphModel.test.ts` — added 7 tests covering the new
  `positionArcNodes` function, including the exact scenario from the bug report.

### Verification

All commands pass from the mars-framework `ui/` directory:
- `npx tsc --noEmit` → exit 0
- `bun test src/widgets/topologyGraphModel.test.ts src/widgets/TopologyView.test.tsx` → 52 pass

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

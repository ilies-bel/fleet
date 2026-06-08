# Plan — Railpack at init + provider-agnostic `FeatureBackend` seam

Status: DRAFT for grilling. Not enqueued. Hard-to-reverse + introduces terms →
this wants a grill + ADR before tasks, per CLAUDE.md routing.

## Goal

Two threads, deliberately separable:

1. **Railpack at init** — replace Fleet's hand-assembled, fragment-based stack
   Dockerfile system with railpack-generated Dockerfiles, produced once at
   project initialisation, per subproject.
2. **Provider-agnostic backend seam** — formalise the informal
   `if (feature.host)` fork in `gateway/src/backend.js` into an explicit
   `FeatureBackend` interface so `local-docker`, `cluster-openshift`, and a
   future `direct-ssh` backend are siblings, not special-cases scattered
   through `api.js`.

**Chosen scope (confirmed):** railpack *generates Dockerfiles* (transitional
mode). Everything downstream of "a Dockerfile exists" is UNCHANGED — local
`docker build` and the cluster `BuildConfig` (`dockerfilePath`) both keep
working, they just consume a generated Dockerfile instead of a fragment-built
one. This decouples railpack adoption from any run-path rearchitecture.

**Explicit non-goals (for THIS plan):**
- Not switching the cluster off `oc start-build --from-dir` (no registry push).
- Not adopting "build-here-push-everywhere" / byte-identical images.
- Not building the `direct-ssh` backend yet — only leaving the seam shaped so
  it can be added without touching `api.js`.
- Not abandoning the local bind-mount / hot-reload dev loop.

## Current state (verified in code, 2026-06)

- **Build surface (what railpack replaces):** `.fleet/Dockerfile.feature-base*`
  plus `.fleet/fragments/Dockerfile.fragment.{maven,node,gradle}` +
  `Dockerfile.postamble`, assembled into stack variants
  (`.spring/.gradle/.next/.vite`). `scripts/fleet-init.sh` writes `fleet.conf`
  (`FRONTEND_DIR`, `BACKEND_DIR`, `BACKEND_BUILD_CMD`, `BACKEND_RUN_CMD`,
  `*_VERSION`, `*_OUT_DIR`) and builds the base image. This is the hand-rolled
  4-field buildpack.
- **Run/dispatch seam (proto-backend):** `gateway/src/backend.js` already
  routes `startFeature`/`stopFeature` on `feature.host != null`:
  - host absent → `docker.startContainer` (local, bind-mounted worktree)
  - host present → `cluster/lifecycle.startClusterFeature` (apply pod+svc,
    rsync source in, touch sentinel, wait supervisord)
  It already uses DI test seams (`_setDockerImpl`, `_setLifecycleImpl`, …).
- **Cluster build:** `cluster/bootstrap.js` → `oc start-build
  fleet-feature-base --from-dir=<FLEET_ROOT> --wait` against
  `manifests/buildconfig.yaml.tmpl` (`strategy: Docker`,
  `dockerfilePath: Dockerfile.feature-base`). Builds IN-cluster, no registry
  push, no admin. `manifest.js` points pods at the internal registry
  ImageStream tag. SCC-friendly already (`fsGroup: 0`, no `runAsUser`).
- **Diff (related, already queued separately as mars-60437fc4):** moving to
  host-side git off `feature.worktreePath`. Confirms the instinct: read
  intended state (registry), don't query container actual-state.

Key consequence: today the cluster build path is fed by ONE Dockerfile
(`dockerfilePath` in the BuildConfig). Railpack-generated Dockerfiles slot into
exactly that contract — both backends keep consuming `dockerfilePath`.

---

## Phase 0 — Spike: can railpack emit a Dockerfile? (BLOCKING)

**Risk being retired:** railpack's first-class output is an OCI image, not a
Dockerfile. `railpack prepare`/`plan` emit a build-plan JSON + BuildKit LLB. A
clean `--out Dockerfile` may not exist.

Tasks:
1. Install railpack standalone; run `railpack plan ./<subproject>` and
   `railpack prepare` against a representative Spring backend, a Gradle backend,
   a Next static, and a Vite static (the four current stack variants).
2. Determine the **artifact contract**:
   - **(a)** railpack can emit a Dockerfile directly → use it.
   - **(b)** it only emits a build-plan JSON → write a thin
     `plan → Dockerfile` translator (install cmd + build cmd + start cmd + mise
     versions → `FROM` + `RUN` + `CMD`). This is small and deterministic and
     still deletes the fragment-assembly system.
3. Confirm railpack handles the **polyglot monorepo** shape by being pointed at
   a *subdirectory* as build context (`railpack … ./backend`), since the
   "Root Directory" selector is a Railway-platform feature, not a CLI flag.
   Record the exact invocation that scopes to one subproject.
4. Confirm the generated Dockerfile is **SCC-safe** for OpenShift (no
   hardcoded `USER`/`runAsUser` that conflicts with namespace-assigned UID;
   writable paths under `fsGroup: 0`). This is the single most likely
   cluster-side breakage.

**Exit criterion:** a documented, repeatable command (or command + translator)
that turns `<subproject-dir>` → `<subproject>.Dockerfile` for all four stacks,
verified to `docker build` locally AND to be SCC-safe. If (a)/(b) both fail for
a stack, that stack stays on the legacy fragment Dockerfile (degrade, don't
block) and is logged as a known gap.

---

## Phase 1 — Railpack-generated Dockerfiles at init (behind the existing build path)

No seam work yet; just swap the *source* of the Dockerfile.

1. **Init writes generated Dockerfiles.** Extend the init flow (the
   `fleet-init.sh` successor — see Phase 4 on where init logic should live) to,
   per detected subproject, produce `.fleet/<subproject>.Dockerfile` via the
   Phase-0 mechanism.
2. **Local build** consumes the generated Dockerfile: `docker build -f
   .fleet/<sub>.Dockerfile`. (Today it's `Dockerfile.feature-base`; this is a
   path swap.)
3. **Cluster build** consumes it: render the BuildConfig template with
   `dockerfilePath: <subproject>.Dockerfile` instead of the hardcoded
   `Dockerfile.feature-base`. `bootstrap.js` `--from-dir` still ships the
   context; only the `dockerfilePath` changes. Parameterise the template
   (`{DOCKERFILE_PATH}` alongside `{NAMESPACE}`).
4. **Delete** `.fleet/fragments/*` and the `Dockerfile.feature-base.*` stack
   variants once all four stacks pass Phase 0. Hard cut (no external users) —
   update every reference in `fleet-init.sh`, `bootstrap.js`, the BuildConfig
   template, and any docs in one change.
5. **`fleet.conf` shrinks.** `BACKEND_BUILD_CMD` / `BACKEND_RUN_CMD` /
   `*_VERSION` become railpack's job (detected). Keep what railpack does NOT
   know: `FRONTEND_DIR` / `BACKEND_DIR` (which subdirs ARE the subprojects —
   railpack can't infer Fleet's monorepo split), `*_PORT`, `PROJECT_NAME`,
   `FRONTEND_OUT_DIR` (still needed for static-serve wiring). Document
   `fleet.conf` as "the subproject map + ports", not "the build recipe".
   Provide an `RAILPACK_*` / `railpack.json` escape hatch per subproject for
   the cases Phase 0 flagged as needing overrides.

**Ship gate:** local + cluster both build and run a feature from a
railpack-generated Dockerfile, for all four stacks (or documented degrade).
This phase is shippable on its own — it delivers the railpack migration with
zero seam refactor.

---

## Phase 2 — Extract the `FeatureBackend` interface (no behaviour change)

Formalise what `backend.js` already does informally. Pure refactor — same code
paths, named.

1. Define the interface (JSDoc typedef in `.js`, per repo style). Minimal,
   driven by what callers in `api.js` actually need today:

   ```
   FeatureBackend {
     build(feature, ctx): Promise<void>    // produce the runnable artifact
     start(feature): Promise<void>          // run it
     stop(feature): Promise<void>           // tear it down
     diff(feature): Promise<DiffResult>     // unified-diff for the dashboard
     status(feature): Promise<Status>       // health/phase
     view(feature): Promise<{ localPort }>  // hand the gateway a proxy target
   }
   ```

   `view()` is the unifying insight from the design convo: local → proxy to
   `localhost:port`; cluster → `oc port-forward` (already in
   `port-forward.js`); future direct-ssh → `ssh -L`. All three already reduce
   to "give the gateway a local port".

2. Two implementations, both *wrapping existing code* (no rewrite):
   - `LocalDockerBackend` — wraps `docker.js` + the host-side git diff
     (mars-60437fc4) + direct-proxy view.
   - `ClusterOpenShiftBackend` — wraps `cluster/lifecycle.js`,
     `cluster/oc.js`, `cluster/port-forward.js`.
3. `backend.js` becomes a **selector**: `pickBackend(feature)` returns the
   right impl based on `feature.host` (unchanged dispatch rule). Keep the DI
   test seams.
4. **Move the leaked substrate assumptions out of `api.js` into the backend.**
   Today `api.js` hardcodes docker/oc verbs in places (the diff endpoint did;
   rebuild does). Each becomes `backend.diff(feature)` / `backend.build(...)`.
   This is what stops the next "diff broke on cluster features" class of bug.

**Ship gate:** all existing gateway tests green with no contract change; `grep`
shows `api.js` no longer calls `docker.*` / `oc.*` directly for
build/diff/view/status — only through the backend.

---

## Phase 3 — Wire railpack build through the backend's `build()`

Now that build is a backend method, place the Phase-1 logic behind it cleanly:

- `LocalDockerBackend.build` = `docker build -f <generated Dockerfile>` (or, if
  a later decision flips to image-direct, `railpack build` → image — the seam
  makes that a one-impl change, not an `api.js` change).
- `ClusterOpenShiftBackend.build` = `oc start-build --from-dir` with the
  generated `dockerfilePath` (Phase 1.3).

No new behaviour — this just relocates Phase 1 wiring behind the Phase 2
interface so future backends (direct-ssh) implement `build()` their own way
without touching callers.

---

## Phase 4 — Init ownership (where this logic should live)

Open question to settle in grilling, not pre-decided:
- `fleet-init.sh` is a 359-line bash script. Railpack invocation + the
  plan→Dockerfile translator (Phase 0b) is awkward in bash. Candidate: move
  init's build-recipe generation into the gateway/CLI (Node) and leave bash as
  a thin bootstrap. Ties into the broader "is `fleet-init.sh` the right home"
  question. Flagged, not solved here.

---

## Sequencing & shippability

- Phase 0 BLOCKS everything (it decides whether the chosen approach is even
  possible as stated).
- Phase 1 ships the railpack migration ALONE (no seam refactor) — highest user
  value, lowest blast radius.
- Phases 2–3 ship the seam, independent of railpack value — they pay off the
  cross-machine goal and prevent the substrate-leak bug class.
- Phase 4 is cleanup/ergonomics.

Each phase is independently revertible. The hard cuts (delete fragments, change
BuildConfig template) are confined to Phase 1 and gated on Phase 0 passing for
all four stacks.

## Terms to pin in CONTEXT.md (grill output)

- **FeatureBackend** — the substrate abstraction (local-docker /
  cluster-openshift / direct-ssh) behind one build/start/stop/diff/status/view
  contract.
- **view contract** — every backend hands the gateway a local port to proxy;
  the gateway never reaches the substrate's network directly.
- **generated Dockerfile** — the railpack-produced (or plan-translated)
  Dockerfile that both build paths consume; supersedes fragment assembly.

## ADRs this likely produces

1. "Railpack generates Dockerfiles at init; fragment assembly removed"
   (records the transitional-mode trade vs image-direct, and the
   plan→Dockerfile fallback).
2. "FeatureBackend seam; substrate verbs never leak into api.js."
3. (Deferred) "direct-ssh backend: image-over-SSH + ssh -L view, no registry,
   local hosts only" — shaped but not built.

## Open risks

- **R1 (Phase 0):** railpack may not produce SCC-safe Dockerfiles for
  OpenShift out of the box → may need post-processing or per-stack overrides.
- **R2:** railpack on a polyglot monorepo only works by pointing it at each
  subdir; if a subproject isn't self-contained (shared root lockfile, etc.)
  detection may misfire → escape hatch via `railpack.json`.
- **R3:** railpack needs mise/toolchain at init time on the machine running
  init — a new init-time dependency. Acceptable for dev-init; document it.
- **R4:** two build engines during transition (railpack + legacy fragments for
  any stack that fails Phase 0) → drift. Mitigate by making degrade explicit
  and logged, and closing the gap before deleting fragments.

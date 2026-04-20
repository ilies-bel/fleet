---
name: dispatch-route
description: >
  Pre-dispatch classifier. Run BEFORE every Task() supervisor dispatch on a bead.
  Tags the bead with `lane:auto-merge`, `lane:fleet-gated`, or `lane:pen-direct`,
  which the Post-Task Merge Protocol later uses to decide between auto-FF-merge,
  fleet-container-gated review, or direct-on-main commits for Pencil work.
  Blocks dispatch when the bead is too vague to classify.
---

# Dispatch Route

Decides which **merge lane** a bead belongs to **before** the supervisor is
dispatched, and tags the bead with a label so the Post-Task Merge Protocol can
act deterministically when the supervisor returns.

## When to invoke

The orchestrator MUST run this skill immediately before any
`Task(subagent_type="*-supervisor", ...)` call, including the first dispatch
of an epic child. Skip only for `merge-supervisor` (which is exempt from the
bead requirement entirely).

If the bead already has a `lane:*` label, **the skill is a no-op** — respect
the existing label as a manual override.

## Required input

- `BEAD_ID` — the bead about to be dispatched
- `SUBAGENT_TYPE` — the supervisor that will receive the dispatch
- The dispatch prompt (used as a description fallback for classification)

## Lanes

| Label | Meaning | Post-task behavior |
|-------|---------|---------------------|
| `lane:auto-merge` | Non-user-facing change | Rebase → tests green → **auto FF-merge** to main → close bead. No user prompt. |
| `lane:fleet-gated` | User-facing feature | Rebase → **auto-spin** `fleet add bd-{ID} --title "<bead title>"` → surface container URL → wait for user `merge`/`reject` verdict → FF-merge → `fleet rm bd-{ID}`. |
| `lane:pen-direct` | Pencil `.pen` design work | **No worktree, no branch, no rebase, no fleet, no merge.** Supervisor commits directly on `main` referencing the bead ID. Orchestrator just closes the bead on COMPLETE. Rationale: `.pen` files are encrypted binary that can't rebase/merge, and worktrees duplicate the Pencil-app open-document collision. |

## Workflow

### Step 0 — Pre-flight: wisp guard

If `BEAD_ID` matches `bd-wisp-*`, **abort dispatch**. Wisps are ephemeral, pre-actionable captures (see CLAUDE.md → Idea Capture) — they have no plan and cannot be dispatched. Surface to the user:

```
{BEAD_ID} is a wisp, not a permanent bead. Promote it first:
  bd promote {BEAD_ID} --reason "Plan ready"
Then re-dispatch with the new (preserved) ID.
```

Do NOT auto-promote. The promote action is the moment the orchestrator confirms the plan is written and the work is actionable — that's a deliberate decision, not a dispatch-time side effect.

### Step 1 — Pre-flight: vague-bead guard

Run:

```bash
bd show {BEAD_ID}
```

Check:

- Description length ≥ 80 chars, OR
- Description contains at least one of: a file path (`/`, `.kt`, `.tsx`, `.ts`, `.sql`), a function/class name (`CamelCase` or `snake_case`), or a clearly scoped verb-noun (`add`, `fix`, `refactor`, `migrate`, `rename` + a target).

**If neither is true**, abort dispatch and surface to the user:

```
Bead {BEAD_ID} is too vague to classify into a merge lane.
Add a description with file paths or a clear scope, then re-dispatch.
Run: bd update {BEAD_ID} --description "..."
```

Do NOT default-classify a vague bead. Do NOT dispatch.

### Step 2 — Existing-label check

```bash
bd label list {BEAD_ID}
```

If output contains `lane:auto-merge` or `lane:fleet-gated` → **stop, no-op**,
proceed to dispatch.

### Step 3 — Classifier cascade (first match wins)

Apply rules in order. As soon as one matches, stop and apply the label.

#### Rule 1 — Supervisor type

| Supervisor | Lane |
|------------|------|
| `react-supervisor` | `lane:fleet-gated` |
| `design-supervisor` | `lane:pen-direct` (always — `.pen` files are encrypted binary that can't rebase/merge, and worktrees duplicate the Pencil-app open-document collision. Supervisor commits directly on main; real visual review is Pia's `get_screenshot` on the edited artboard inside the session) |
| `infra-supervisor` | `lane:auto-merge` |
| `kotlin-backend-supervisor` | continue to Rule 2 |
| `node-backend-supervisor` | continue to Rule 2 |

#### Rule 2 — Paths in bead description

Read the bead description and the dispatch prompt for path mentions.

| Path signal | Lane |
|-------------|------|
| `frontend/**` touched (any file) | `lane:fleet-gated` |
| New `@RestController` / `@PostMapping` / `@GetMapping` / new route file **AND** `frontend/**` touched in the same bead | `lane:fleet-gated` |
| New `@RestController` / `@PostMapping` / `@GetMapping` / new route file with NO `frontend/**` change | `lane:auto-merge` (no UI consumer to review in a container — tests + diff are the gate; see bd memory `dispatch-route-rule-fleet-gated-needs-frontend`, 2026-04-20) |
| `gateway/src/**` route handler additions/changes **AND** `frontend/**` touched | `lane:fleet-gated` |
| `gateway/src/**` route handler with NO `frontend/**` change | `lane:auto-merge` |
| `db/changelog/**` migration only (no controller / DTO changes) | `lane:auto-merge` |
| `*Service.kt`, `*Repository.kt`, `*Mapper.kt` only (no controller) | `lane:auto-merge` |
| `**/test/**`, `**/*Test.kt`, `**/*.test.ts` only | `lane:auto-merge` |
| `*.md`, `docs/**`, `CLAUDE.md`, `.beads/**` | `lane:auto-merge` |
| `.github/**`, `Dockerfile`, `docker-compose*.yml`, `Caddyfile`, `helm/**` | `lane:auto-merge` |

**Rule of thumb:** fleet containers exist for *visual/QA* review. If there is no screen, button, modal, or chart a human would click on in this bead, it is `lane:auto-merge`. A new REST endpoint by itself is not a visual review surface.

#### Rule 3 — Keywords in title/description

Match case-insensitively against title + description + dispatch prompt.

| Keyword family | Lane |
|----------------|------|
| Visual-surface keywords: `UI`, `screen`, `dashboard`, `view`, `page`, `component`, `button`, `modal`, `form`, `chart`, `graph view` | `lane:fleet-gated` |
| Ambiguous keywords: `endpoint`, `API`, `route`, `feature`, `flow` — **only when paired with a visual-surface keyword in the same bead**; otherwise default to `lane:auto-merge` | `lane:fleet-gated` (conditional) |
| Pure backend API/endpoint/route work with NO visual-surface keyword in the bead | `lane:auto-merge` |
| `refactor`, `rename`, `extract`, `inline`, `cleanup`, `dead code`, `unused`, `migrate`, `migration`, `bump`, `upgrade dep`, `internal`, `helper`, `util`, `test`, `spec`, `coverage`, `docs`, `comment`, `typo`, `lint`, `format`, `CI`, `pipeline` | `lane:auto-merge` |

#### Rule 4 — Ambiguous → ASK

If no rule matched, the orchestrator MUST pause and call `AskUserQuestion`:

```
Question: "Bead {BEAD_ID} ({title}) — which merge lane?"
Options:
  - lane:auto-merge — non-user-facing, FF-merge after tests
  - lane:fleet-gated — user-facing, spin fleet container for review
Header: "Merge lane"
```

Tag with the user's choice.

### Step 4 — Apply the label

```bash
bd label add {BEAD_ID} lane:auto-merge
# or
bd label add {BEAD_ID} lane:fleet-gated
```

Then add a one-line audit comment so the rationale is traceable:

```bash
bd comment add {BEAD_ID} "DISPATCH_ROUTE: lane=<lane> rule=<rule-N> rationale=<short>"
```

### Step 5 — Proceed to dispatch

Continue with the original `Task(subagent_type=..., prompt="BEAD_ID: ...")`
call. The label travels with the bead and is read by the Post-Task Merge
Protocol when the supervisor returns COMPLETE.

## Post-Task Merge Protocol — lane-aware variant

When the supervisor returns `BEAD {ID} COMPLETE`:

```bash
LANE=$(bd label list {ID} | grep -oE 'lane:(auto-merge|fleet-gated|pen-direct)' | head -1)
```

### `lane:auto-merge`

```bash
# Orchestrator stays in main checkout. Uses git -C to target the worktree.
git -C .worktrees/bd-{ID} fetch origin main 2>/dev/null || true
git -C .worktrees/bd-{ID} rebase main    # on conflict → dispatch merge-supervisor, then resume
# pre-commit hook runs tests during rebase
git checkout main
git merge --ff-only bd-{ID}
bd update {ID} --status closed
bd close {ID}
```

**No user approval prompt.** Tests are the gate. If pre-commit fails, stop and
surface the failure to the user.

### `lane:fleet-gated`

```bash
# Orchestrator stays in main checkout. Uses git -C to target the worktree.
git -C .worktrees/bd-{ID} fetch origin main 2>/dev/null || true
git -C .worktrees/bd-{ID} rebase main    # on conflict → dispatch merge-supervisor, then resume
fleet add "bd-{ID}" --title "$(bd show bd-{ID} --json | jq -r .title)"   # auto-spin, no prompt
# wait for RUNNING + /backend/actuator/health (per fleet:add skill)
```

Surface to user:

```
✓ bd-{ID} ready for review
  URL: <fleet-url>
  Reply 'merge' to FF-merge to main, 'reject' to abandon.
```

On `merge`:

```bash
git checkout main
git merge --ff-only bd-{ID}
bd update {ID} --status closed
bd close {ID}
fleet rm "bd-{ID}"
```

On `reject`: leave the worktree, leave the container running for diagnosis,
ask the user how to proceed (rework / discard / re-dispatch).

### `lane:pen-direct`

The supervisor has already committed directly on `main` referencing the bead
ID — there is no branch, no worktree, no rebase, no merge step.

```bash
bd update {ID} --status closed
bd close {ID}
```

That's it. The latest commit(s) on `main` already contain the design changes.
Surface a one-line summary: bead ID + `.pen` files touched.

**No fleet container.** `.pen` files aren't consumed by the runtime, so
spinning a container would render zero visual difference. Visual review
already happened via `get_screenshot` inside Pia's session.

## Anti-patterns

- ❌ Dispatching without invoking this skill
- ❌ Defaulting a vague bead to `lane:auto-merge` instead of blocking
- ❌ Tagging both labels on the same bead
- ❌ Auto-merging a `lane:fleet-gated` bead without the user's `merge` reply
- ❌ Spinning a fleet container for `lane:auto-merge` (waste of resources)
- ❌ Re-classifying a bead that already has a `lane:*` label (respect overrides)
- ❌ Creating a worktree or branch for a `lane:pen-direct` bead (defeats the purpose)
- ❌ Spinning a fleet container for `lane:pen-direct` (`.pen` files don't render in the runtime)
- ❌ Routing a non-`design-supervisor` bead to `lane:pen-direct`
- ❌ Dispatching with a `bd-wisp-*` ID (must `bd promote` first)
- ❌ Auto-promoting a wisp inside this skill (promote is the orchestrator's deliberate "plan is ready" signal, not a dispatch-time fixup)

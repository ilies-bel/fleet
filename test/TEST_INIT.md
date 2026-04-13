# qa-fleet Initialisation Test

End-to-end smoke test for `fleet init` that also provisions a full multi-agent
orchestration layer (The Claude Protocol) on top of the initialised project.

Goal: after running these steps, `test/project/` must be a working qa-fleet
environment **and** have supervisors + beads + hooks wired up so an
orchestrator can immediately dispatch work.

---

## Prerequisites

- `fleet` CLI on `$PATH` (repo root is `/Users/ib472e5l/project/perso/fleet/qa-fleet`)
- `docker`, `node` >= 20, `npx`, `python3`
- `bd` (beads) CLI — installed automatically by The Claude Protocol if missing
- Claude Code with hooks support (interactive terminal, not a subshell — `fleet init` reads from `/dev/tty`)

---

## Step 1 — Reset the test project from the pristine reference

`test/reference/` is the pristine copy (d2r2: Spring Boot backend + Next.js frontend).
Never edit it. Always re-seed `test/project/` from it before a test run.

```bash
cd /Users/ib472e5l/project/perso/fleet/qa-fleet
rm -rf test/project
cp -rp test/reference test/project
```

Sanity checks:

```bash
ls test/project                       # → d2r2-backend/  d2r2-frontend/  qa-fleet.conf
(cd test/project/d2r2-backend  && git rev-parse --abbrev-ref HEAD)   # → main
(cd test/project/d2r2-frontend && git rev-parse --abbrev-ref HEAD)   # → main
```

If either repo isn't on `main`, stop — the reference is wrong, not the test.

---

## Step 2 — Install The Claude Protocol

Bootstraps beads + supervisor agents + enforcement hooks so the project has a
full orchestration layer, not just a bare fleet install.

```bash
cd /Users/ib472e5l/project/perso/fleet/qa-fleet/test/project
npx skills add AvivK5498/The-Claude-Protocol
```

Then, inside Claude Code running from `test/project/`:

```
/create-beads-orchestration
```

The wizard will detect `d2r2-backend` (Spring Boot) and `d2r2-frontend`
(Next.js) and scaffold the matching supervisors.

Expected artefacts:

- `.beads/` directory with an initialised issue store
- `.claude/agents/` containing at least: `node-backend-supervisor`,
  `react-supervisor`, `infra-supervisor`, `merge-supervisor` (names may vary
  by protocol version — Spring + Next.js equivalents are acceptable)
- `.claude/settings.json` with pre/post-tool hooks registered
- `CLAUDE.md` updated with the orchestrator identity + bead workflow

---

## Step 3 — Run `fleet init`

Must be run **interactively** in a real terminal — the wizard reads from `/dev/tty`.

```bash
cd /Users/ib472e5l/project/perso/fleet/qa-fleet
fleet init test/project main
```

Expected detection output:

```
Stack detected: backend=spring, frontend=next
Dockerfile.spring → FLEET_ROOT/Dockerfile.feature-base
spring-boot-devtools not found → prompt to add   (answer: yes)
```

Notes:

- `scripts/qa-host-runner.sh` is a no-op stub; init must proceed past it
- `test/project/qa-fleet.conf` is pre-filled → conf wizard is skipped
- An idempotent `.qa-shared` block is appended to any untracked `.env` files

---

## Step 4 — Verify fleet state

```bash
cd /Users/ib472e5l/project/perso/fleet/qa-fleet
docker ps --filter name=qa-fleet          # gateway + nginx containers running
curl -sf http://localhost:$(grep '^GATEWAY_PORT' test/project/qa-fleet.conf | cut -d= -f2)/health
ls test/project/Dockerfile.feature-base    # copied from stacks/Dockerfile.spring
```

Dashboard should be reachable at the `DASHBOARD_PORT` defined in `qa-fleet.conf`.

---

## Step 5 — Verify orchestration is ready

From inside `test/project/`:

```bash
bd ready                     # lists unblocked issues (empty is fine; must not error)
bd stats                     # shows initialised store
ls .claude/agents            # all four supervisors present
grep -q 'orchestrator' CLAUDE.md && echo OK
```

Smoke-test the hook layer by asking Claude Code (from `test/project/`) to edit
a file on `main` — the enforcement hook must block it and require a bead +
worktree.

---

## Success criteria

- [ ] `test/project` seeded from `test/reference` with both sub-repos on `main`
- [ ] `.beads/`, `.claude/agents/`, `.claude/settings.json`, updated `CLAUDE.md` present
- [ ] `fleet init` completed without manual file edits
- [ ] `Dockerfile.feature-base` copied at repo root
- [ ] Gateway `/health` returns 200
- [ ] `bd ready` runs cleanly
- [ ] Editing on `main` is blocked by the protocol hooks

---

## Teardown

```bash
cd /Users/ib472e5l/project/perso/fleet/qa-fleet
fleet rm --all 2>/dev/null || docker compose -f test/project/docker-compose.yml down -v
rm -rf test/project
```

Re-seed from `test/reference` before the next run.

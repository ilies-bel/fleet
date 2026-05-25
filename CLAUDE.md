# Fleet

## Project Overview

- Fleet is a local environment manager that spins up isolated Docker containers per feature branch, wiring together a reverse proxy (nginx), process manager (supervisord), and a React dashboard for visibility and control
- It provides a CLI (`fleet`) for initialising, adding, syncing, and tearing down feature environments, and a gateway service that proxies traffic and manages the feature registry via Docker socket

## Tech Stack

- **Frontend:** React 19, react-router-dom 7, Vite 6, JSX (no TypeScript)
- **Backend:** Node.js 20, Express 4, ES modules, zero-dep Docker socket client
- **Infrastructure:** Docker, multi-stage Dockerfiles per stack (go/next/node/spring/vite), nginx, supervisord, bash
- **Stacks supported:** Go, Next.js, Node.js, Spring Boot, Vite/React
- **Runtime:** Non-root container user `developer` (uid 1001)

## Your Identity

**You are an orchestrator, delegator, and constructive skeptic architect co-pilot.**

- **Prefer delegating over writing code yourself** — use Glob, Grep, Read to investigate, design the approach, then delegate execution. Small, low-risk edits on a feature branch you may make directly.
- **Constructive skeptic** — present alternatives and trade-offs, flag risks, but don't block progress
- **Co-pilot** — discuss before acting. Summarize your proposed plan. Wait for user confirmation before dispatching
- **Living documentation** — proactively update this CLAUDE.md to reflect project state, learnings, and architecture

## Why Worktrees Matter

Worktrees provide **isolation** (changes don't affect main until merged). This matters because:

- Parallel work can proceed without conflicts
- Failed experiments are contained and easily discarded
- User merges via UI after CI passes — no surprise commits

## Quick Fix Escape Hatch

For trivial changes (<10 lines) on a **feature branch**, you can make the edit directly:

1. `git checkout -b quick-fix-description` (must be off main)
2. Investigate the issue normally
3. Make the edit and commit immediately

**On main/master:** Do not edit directly. Branch first.

**When to use:** typos, config tweaks, small bug fixes where investigation > implementation.
**When NOT to use:** anything touching multiple files, anything > ~10 lines, anything risky.

**Always commit immediately after a quick-fix** to avoid orphaned uncommitted changes.

## Investigation Before Delegation

**Lead with evidence, not assumptions.** Before delegating any work:

1. **Read the actual code** — Don't just grep for keywords. Open the file, understand the context.
2. **Identify the specific location** — File, function, line number where the issue lives.
3. **Understand why** — What's the root cause? Don't guess. Trace the logic.

**Anti-pattern:** "I think the bug is probably in X" → dispatching without reading X.
**Good pattern:** "Read src/foo.ts:142-180. The bug is at line 156 — null check missing."

The subagent should execute confidently, not re-investigate.

### Hard Constraints

- Never dispatch without reading the actual source file involved
- No partial investigations — if you can't identify the root cause, say so
- No guessing at fixes — if unsure, investigate more or ask the user

## Workflow

### Standalone (single subagent)

1. **Investigate deeply** — Read the relevant files (not just grep). Identify the specific line/function.
2. **Discuss** — Present findings with evidence, propose plan, highlight trade-offs
3. **User confirms** approach
4. **Dispatch** a subagent with a self-contained prompt: the files, the exact change, and how to verify

### Plan Mode (complex features)

Use when: new feature, multiple approaches, multi-file changes, or unclear requirements.

1. Explore with Glob/Grep/Read → design the approach
2. AskUserQuestion for clarification → confirm the plan with the user
3. Dispatch subagents from the approved plan

## Testing fleet init

`test/project/` is a ready-to-use copy of `test/reference/` (d2r2 — Spring Boot backend + Next.js frontend).

```bash
# cd into the project directory first — fleet init reads cwd
cd test/project

# Run interactively in your terminal (not as a subshell — needs /dev/tty for prompts)
fleet init
```

`fleet init` takes no arguments. It reads the current directory, looks for `.fleet/fleet.toml`, and runs the interactive wizard if the file is absent.

Expected detection output:
```
Scanning test/project for service directories...
  Include 'd2r2-backend' as a service? (stack: spring) [Y/n]:
  Include 'd2r2-frontend' as a service? (stack: next) [Y/n]:
  spring-boot-devtools not found → prompt to add
  Rendered .fleet/Dockerfile.feature-base.spring
  Rendered .fleet/Dockerfile.feature-base.next
```

Notes:
- If `.fleet/fleet.toml` already exists in `test/project/`, the wizard is skipped and the file is used as-is. The example schema lives at `.fleet/fleet.toml.example` (tracked); the real `.fleet/fleet.toml` is gitignored
- Generated Dockerfiles land at `.fleet/Dockerfile.feature-base.<stack>` (e.g. `.fleet/Dockerfile.feature-base.spring`), not at the repo root
- Services are expressed as `[[services]]` entries in `fleet.toml` — no separate frontend/backend distinction
- Both git repos (`d2r2-backend/`, `d2r2-frontend/`) should be on branch `main` before running init
- `test/reference/` is the pristine original — never modify it; re-copy if needed: `cp -rp test/reference test/project`

## Current State

The Stack-agnostic Fleet refactor (epic qa-fleet-pyn) is fully merged on main as of 2026-04-15.

Key changes shipped:
- Config now lives under `.fleet/` — `fleet.toml` replaces the old flat `fleet.conf`; no file at the repo root
- Multi-service model: any number of `[[services]]` entries, each with its own stack, port, build, and run command
- Per-stack Dockerfiles at `.fleet/Dockerfile.feature-base.<stack>` (one per stack type, generated by `fleet init`)
- Container naming: `fleet-<feature>-<service>` (one container per service, up from one per feature)
- Image naming: `fleet-base-<stack>` (was `fleet-feature-base`)
- `fleet init` is now zero-argument — reads cwd; wizard runs if `.fleet/fleet.toml` is absent
- `fleet add <name>` spins up all services from `fleet.toml`; `--service svc=path:image` overrides individual services
- `fleet feature` subcommand removed

Mount modes (v2.0.0): `shared_paths`/`env_files` entries declare `mode = "bind" | "volume" | "copy"`. See `.fleet/fleet.toml.example`.

See `MIGRATION.md` for the old→new key mapping and upgrade path.

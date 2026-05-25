# Changelog

All notable changes to fleet will be documented here.

## 2.0.0

### Changed (BREAKING)

- **`fleet.toml` mount strategy is now declarative.** Every `shared_paths` (under
  `[[stacks]]`) and `env_files` (under `[[services]]`) entry MUST be a table with an
  explicit `mode`:
  - `bind` — bind-mount from the primary checkout (single source of truth). Used for
    gitignored env files (`.env`) and host paths (`~/.m2`, `~/.npmrc`).
  - `volume` — named docker volume. Used for `node_modules` (arch-correct, shared across
    features, avoids the macOS bind-mount perf hit).
  - `copy` — copy from the primary checkout into the worktree at add-time, then mount it.

  **Hard cut, no aliases:** the legacy plain-string form (`shared_paths = ["node_modules"]`,
  `env_files = [".env"]`) is now rejected by the parser with an actionable error. Migrate
  to e.g. `{ path = "node_modules", mode = "volume" }` and `{ path = ".env", mode = "bind" }`.

- **env files are always sourced from the primary checkout.** Because `.env` files are
  gitignored they never live in a worktree; fleet now binds/copies them from
  `FLEET_PROJECT_ROOT/<svc_dir>` for both direct and worktree instances. This fixes the
  bug where a worktree (or a direct-mode checkout) missing a host `.env` caused Docker to
  auto-create an empty directory at the mount point, leaving the app with no env vars.

## Unreleased

### Changed

- `fleet-main` is no longer a magic container. The gateway no longer falls back to a
  literal `fleet-main` container when no feature is active. Requests arriving with no
  active feature now receive an HTTP 503 response with a helpful HTML page pointing at
  the dashboard (`localhost:4000`). The old implicit dependency on a running
  `fleet-main` container is removed; spin up an explicit feature with `fleet add <name>`
  instead.

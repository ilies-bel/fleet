# Migration: qa-fleet → fleet (v0.2)

v0.2 renames all `qa-*` identifiers to `fleet-*` for consistency with the CLI and npm package name. This is a breaking change with no automatic migration path.

## Before upgrading

On the old version (still installed), tear down everything:

```bash
fleet rm --nuke
```

This removes all `qa-<feature>` containers, `qa-gateway`, `qa-net` network, and `.qa-config`. You may also want to manually delete `qa-fleet.conf` and `.qa-worktrees/` in your app repo.

## After upgrading

```bash
npm i -g @ilies-bel/fleet
fleet init <app-root> <branch>
```

The wizard writes `fleet.conf` (not `qa-fleet.conf`). State lives in `.fleet-config`, worktrees in `.fleet-worktrees/`. Containers are named `fleet-<name>` on network `fleet-net`. Admin API moved from `/_qa/` to `/_fleet/`.

## Rename reference

| Old | New |
|---|---|
| `qa-fleet.conf` | `fleet.conf` |
| `.qa-config` | `.fleet-config` |
| `.qa-worktrees/` | `.fleet-worktrees/` |
| `.qa-shared` | `.fleet-shared` |
| `qa-net` | `fleet-net` |
| `qa-gateway` | `fleet-gateway` |
| `qa-<name>` | `fleet-<name>` |
| `/_qa/` | `/_fleet/` |
| `__QA_BACKEND_URL__` | `__FLEET_BACKEND_URL__` |
| `__QA_APP_URL__` | `__FLEET_APP_URL__` |
| `X-QA-Feature` header | `X-Fleet-Feature` header |

OAuth callback URL is unchanged: `http://localhost:4000/auth/callback`.

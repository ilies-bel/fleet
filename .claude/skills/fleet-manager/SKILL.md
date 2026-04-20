---
name: fleet-manager
description: Set up and debug qa-fleet Docker containers. Reads gateway + supervisord logs, diagnoses init/build/runtime/proxy failures, and auto-fixes known error signatures (restart, rebuild base image, re-register with gateway, reseed node_modules). Use when a fleet container fails to start, a feature returns 502/503, `fleet init` or `fleet add` errors out, or the user asks to inspect/recover a feature environment.
---

# fleet-manager

Operational runbook for bringing qa-fleet containers up and keeping them healthy. Apply auto-fixes for known signatures; ask before destructive actions (`fleet rm --nuke`, `docker volume prune`, rebuilding base image when other features are running).

## Fleet topology (ground truth)

- **Gateway:** `qa-gateway-container` on network `qa-net`. Admin API on `:4000` (`/_qa/api/...`), transparent proxy on `:3000`. Source: `gateway/src/index.js:15-49`.
- **Feature containers:** `qa-<NAME>` (NAME is lowercase alphanumeric + hyphens, validated at `cli/common.sh:104-108`). Joined to `qa-net`. Built from `qa-feature-base` image.
- **Base image:** `qa-feature-base` — Ubuntu 24.04 + nginx + supervisord + PostgreSQL 16 + Java 21 + Node 20. Non-root user `developer` (uid 1001). Defined in `Dockerfile.feature-base`.
- **Per-feature processes (supervisord):** backend, nginx, postgresql. Logs at `/var/log/supervisor/{backend,nginx,postgresql,supervisord}.log`.
- **State:** feature metadata in `$APP_ROOT/.qa/<NAME>/`; worktrees in `$APP_ROOT/.qa-worktrees/<NAME>/{frontend,backend}`; global `.qa-config` stores APP_ROOT; `qa-fleet.conf` holds build/run commands and ports.

## Diagnosis flow

Always run the cheapest check first. Do not restart before you know why.

1. **Is the gateway up?**
   `docker ps --filter name=qa-gateway-container --format '{{.Status}}'`
   - Empty → gateway is not running. Go to `fleet init` recovery.
   - `Restarting` loop → `docker logs qa-gateway-container | tail -80`.

2. **Is the feature registered?**
   `curl -sf http://localhost:4000/_qa/api/features | jq '.[] | select(.name=="<NAME>")'`
   - Missing → registration dropped. Re-register via `fleet add` or POST `/register-feature`.

3. **Is the feature container running?**
   `docker ps -a --filter name=qa-<NAME> --format '{{.Status}}'`
   - Not listed → never created; run `fleet add <NAME> <BRANCH>`.
   - `Exited` → read exit reason, then supervisord log.

4. **Inspect logs via gateway API (preferred — gives structured source):**
   ```bash
   curl -s "http://localhost:4000/_qa/api/features/<NAME>/logs?source=backend&tail=300"
   curl -s "http://localhost:4000/_qa/api/features/<NAME>/logs?source=nginx&tail=100"
   curl -s "http://localhost:4000/_qa/api/features/<NAME>/logs?source=all&tail=200"
   ```
   Allowed sources: `backend`, `nginx`, `postgresql`, `supervisord`, `all`. Source: `gateway/src/api.js:140-178`.

5. **Direct docker fallback (use when gateway is down):**
   ```bash
   docker logs qa-<NAME> --tail 200
   docker exec qa-<NAME> tail -200 /var/log/supervisor/backend.log
   docker exec qa-<NAME> supervisorctl status
   docker stats --no-stream qa-<NAME>
   docker inspect qa-<NAME> --format '{{.State.Status}} {{.State.Error}} exit={{.State.ExitCode}}'
   ```

## Error signature → action matrix

Match stderr / log output to one of these signatures. If multiple match, handle top-down.

### A. Init failures (`fleet init`)

| Signature (where to find it) | Auto-fix |
|---|---|
| `docker is not installed` (`cli/cmd-init.sh:538`) | Stop. Tell user to install Docker — no auto-fix. |
| `FRONTEND_DIR … not found` (`cmd-init.sh:281`) | Read `qa-fleet.conf`, verify path under APP_ROOT, fix the path in config. |
| Gateway build timeout after 30s (`cmd-init.sh:789`) | Check `docker logs qa-gateway-container`, `docker network inspect qa-net`. Usually Docker socket permission; ask user to `chmod` or add to `docker` group. |
| `qa-fleet.conf missing + no tty` (`cmd-init.sh:266`) | Tell user to run `fleet init` in a real terminal (needs `/dev/tty` for wizard). |

### B. Build failures (container boots, frontend build dies)

Build runs in `config/entrypoint.sh:54-99`. Symptoms: container restarts, `backend.log` shows npm build crash.

| Signature | Auto-fix |
|---|---|
| `JavaScript heap out of memory` | Raise `NODE_OPTIONS=--max-old-space-size=8192` in `qa-fleet.conf` (default 4096 at entrypoint.sh:97). Restart: `docker restart qa-<NAME>`. |
| `Cannot find module '@next/swc-*'` or `esbuild`, `lightningcss`, `rollup`, `@oxc-resolver`, `@unrs/resolver` | Platform binary mismatch (macOS host → Linux container). Reseed node_modules: `docker volume rm qa-<NAME>-nm && docker restart qa-<NAME>`. Entrypoint re-seeds from `/app-nm-seed` on start. |
| `ENOSPC` | Disk full. `docker system df`; ask before `docker system prune -f`. |
| `npm ERR! code EACCES` inside `/app/node_modules` | Ownership drift on host seed. Ask user to `rm -rf node_modules && npm ci` on host, then restart container. |

### C. Runtime failures (backend won't stay up)

| Signature | Auto-fix |
|---|---|
| Spring Boot `Port 8080 already in use` / `BACKEND_PORT` conflict | Read `BACKEND_PORT` from `qa-fleet.conf`; confirm supervisord backend program uses it. Inside container: `docker exec qa-<NAME> supervisorctl restart backend`. |
| PostgreSQL `could not bind IPv4 address`, `database … does not exist` | `docker exec qa-<NAME> supervisorctl restart postgresql`; if first-boot init failed, tear down volumes and recreate: `fleet rm <NAME> && fleet add <NAME> <BRANCH>`. |
| Backend `Connection refused` to DB | DB env mismatch. Verify `DB_HOST=127.0.0.1 DB_PORT=5432` (cmd-add.sh:129-146) — both processes share the container's network namespace. Restart backend only. |
| Container status `Exited (137)` | OOM-killed. Raise Docker Desktop memory, then `fleet restart <NAME>`. |
| Container status `Exited (139)` (segfault) | Usually corrupt node_modules volume. Remove `qa-<NAME>-nm` volume and restart. |

### D. Proxy / routing failures (gateway returns 502/503)

Source: `gateway/src/proxy.js:10-46`.

| Signature | Auto-fix |
|---|---|
| 503 + "No active feature" page | `curl -X POST http://localhost:4000/_qa/api/features/<NAME>/activate` (or use dashboard). |
| 502 from proxy, container is running | Backend not listening on `BACKEND_PORT` yet. `curl http://localhost:4000/_qa/api/features/<NAME>/health`; wait 5–10s; re-check supervisord status. |
| 502, `docker inspect` shows container not on `qa-net` | `docker network connect qa-net qa-<NAME>`. |
| Feature missing from registry after gateway restart | `fleet rm <NAME> && fleet add <NAME> <BRANCH>` — or manually POST `/register-feature`. Reconcile logic at `gateway/src/reconcile.js:11-73` should handle this; if it doesn't, the container is in a weird state. |

### E. Gateway-side failures

| Signature | Auto-fix |
|---|---|
| `DockerSocketError` (`gateway/src/docker.js:36`) | Docker daemon down or socket not mounted. Restart Docker Desktop. |
| `DockerContainerError 404` | Stale registry entry. `curl -X DELETE http://localhost:4000/register-feature/<NAME>`. |
| `DockerContainerError 409` on logs/exec | Container not running — expected during build. Wait and retry. |

## Recovery recipes

Pick the least destructive one that solves the signature.

**Tier 1 — soft restart (no data loss):**
```bash
fleet restart <NAME>                          # docker restart + health poll
docker exec qa-<NAME> supervisorctl restart backend
```

**Tier 2 — drop node_modules volume (keeps DB data):**
```bash
docker stop qa-<NAME>
docker volume rm qa-<NAME>-nm
docker start qa-<NAME>
```

**Tier 3 — rebuild feature container (keeps worktree + branch):**
```bash
fleet rm <NAME>
fleet add <NAME> <BRANCH>
```

**Tier 4 — rebuild base image (affects ALL features — ASK FIRST):**
```bash
docker rmi qa-feature-base
fleet init <APP_ROOT> main   # rebuilds base, leaves existing features requiring fleet rm/add
```

**Tier 5 — nuke (DESTRUCTIVE — ASK FIRST):**
```bash
fleet rm --nuke              # removes all features + gateway + network + images
fleet init <APP_ROOT> main
```

## Setup from scratch

When the user wants a fresh environment:

1. Confirm `docker info` works.
2. Confirm `qa-fleet.conf` exists in the target app root (or guide through the wizard — requires real tty).
3. Run `fleet init <APP_ROOT> <BASE_BRANCH>` in the user's terminal (needs `/dev/tty`).
4. Verify:
   ```bash
   docker ps --filter name=qa-gateway-container
   curl -sf http://localhost:4000/_qa/api/status
   ```
5. Add the first feature: `fleet add <NAME> <BRANCH>`.
6. Health check: `curl http://localhost:4000/_qa/api/features/<NAME>/health`.

## Guardrails

- **Never run `fleet rm --nuke`, `docker volume prune`, `docker system prune`, or `docker rmi qa-feature-base` without explicit user approval** — they wipe other features' data and force rebuilds.
- **Never touch `test/reference/`** (pristine fixture). Use `test/project/` for experiments; re-copy with `cp -rp test/reference test/project` if corrupted.
- **Never edit `qa-fleet.conf` silently.** Propose the diff, then apply.
- **Prefer gateway API over raw `docker exec`** when the gateway is healthy — it gives structured responses and logs intent.
- **If three restart attempts fail, stop and escalate.** Don't loop restarts blindly — read the log.

## Quick reference — endpoints & paths

| Thing | Location |
|---|---|
| Admin API | `http://localhost:4000/_qa/api/` |
| Proxy | `http://localhost:3000` |
| Feature state dir | `$APP_ROOT/.qa/<NAME>/` |
| Worktree | `$APP_ROOT/.qa-worktrees/<NAME>/` |
| Supervisord logs | `/var/log/supervisor/*.log` inside container |
| Named volumes | `qa-<NAME>-nm` (node_modules), `qa-<NAME>-target` (build artifacts) |
| Global config | `$APP_ROOT/.qa-config`, `$APP_ROOT/qa-fleet.conf` |

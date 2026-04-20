---
name: fleet-manager
description: Diagnose and recover fleet feature containers. Reads gateway + supervisord logs, matches known error signatures (init failures, build crashes, runtime restarts, proxy 502/503), and routes fixes by invoking /fleet:add or /fleet:init, or running targeted surgical docker/supervisorctl commands. Use when a feature container fails to start, returns 502/503, or `fleet init`/`fleet add` errors out. Current architecture: mono-container per feature (fleet-<NAME>), supervisord-managed per-service processes inside, fleet-gateway on fleet-net, admin API at /_fleet/api/....
---

# fleet-manager

Operational runbook for diagnosing and recovering fleet feature containers. For topology details and setup flow, defer to `/fleet:init` and `/fleet:add` — this skill's job is diagnosis, error-signature matching, and routing to the correct recovery action.

**Key identifiers (current):**

| Thing | Value |
|---|---|
| Base image | `fleet-feature-base` |
| Feature container | `fleet-<NAME>` |
| Gateway container | `fleet-gateway` |
| Docker network | `fleet-net` |
| Config file | `.fleet/fleet.toml` |
| Feature state dir | `.fleet/<NAME>/info.toml` |
| Worktrees | `.worktrees/<NAME>/` |
| Admin API prefix | `/_fleet/api/...` |
| Proxy port (default) | `3000` |
| Admin port (default) | `4000` |
| Named volumes | `fleet-<NAME>-nm` (node_modules), `fleet-<NAME>-target` (build artifacts) |
| Supervisord logs | `/var/log/supervisor/*.log` inside container |

---

## Diagnosis flow

Always run the cheapest check first. Do not restart before you know why.

**1. Is the gateway up?**
```bash
docker ps --filter name=fleet-gateway --format '{{.Status}}'
```
- Empty → gateway not running. Invoke `/fleet:init` recovery.
- `Restarting` loop → `docker logs fleet-gateway | tail -80`.

**2. Is the feature registered?**
```bash
curl -sf http://localhost:4000/_fleet/api/features | jq '.[] | select(.name=="<NAME>")'
```
- Missing → invoke `/fleet:add <NAME>` to re-register.

**3. Is the feature container running?**
```bash
docker ps -a --filter name=fleet-<NAME> --format '{{.Status}}'
```
- Not listed → never created; invoke `/fleet:add <NAME>`.
- `Exited` → read exit reason, then check supervisord log.

**4. Inspect logs via gateway API (preferred when gateway is healthy):**
```bash
curl -s "http://localhost:4000/_fleet/api/features/<NAME>/logs?source=backend&tail=300"
curl -s "http://localhost:4000/_fleet/api/features/<NAME>/logs?source=nginx&tail=100"
curl -s "http://localhost:4000/_fleet/api/features/<NAME>/logs?source=all&tail=200"
```
Allowed sources: `backend`, `nginx`, `postgresql`, `supervisord`, `all`.

**5. Direct docker fallback (use when gateway is down):**
```bash
docker logs fleet-<NAME> --tail 200
docker exec fleet-<NAME> tail -200 /var/log/supervisor/backend.log
docker exec fleet-<NAME> supervisorctl status
docker stats --no-stream fleet-<NAME>
docker inspect fleet-<NAME> --format '{{.State.Status}} {{.State.Error}} exit={{.State.ExitCode}}'
```

---

## Error signature → action matrix

Match stderr / log output to one of these signatures. If multiple match, handle top-down.

### A. Init failures — invoke `/fleet:init` to recover

| Signature | Recovery |
|---|---|
| `docker is not installed` | Stop. Tell user to install Docker — no auto-fix. |
| Base image `fleet-feature-base` not found | Run `/fleet:init` to build the base image. |
| `FRONTEND_DIR … not found` | Read `.fleet/fleet.toml`, verify service dir under project root, fix path in `[[services]]`. |
| Gateway build timeout | Check `docker logs fleet-gateway`, `docker network inspect fleet-net`. Likely Docker socket permission; ask user to add to `docker` group. |
| `.fleet/fleet.toml` missing and no tty | Tell user to run `fleet init` in a real terminal (wizard needs `/dev/tty`). |

### B. Build failures — container boots, service build crashes

Symptoms: container restarts, service log shows build crash. Logs at `/var/log/supervisor/<service>.log` inside the container.

| Signature | Recovery |
|---|---|
| `JavaScript heap out of memory` | Raise `NODE_OPTIONS=--max-old-space-size=8192` in the `[[services]]` env block of `.fleet/fleet.toml`. Restart: `docker restart fleet-<NAME>`. |
| `Cannot find module '@next/swc-*'` or `esbuild`, `lightningcss`, `rollup`, `@oxc-resolver`, `@unrs/resolver` | Platform binary mismatch (macOS host → Linux container). Remove stale node_modules volume: `docker volume rm fleet-<NAME>-nm && docker restart fleet-<NAME>`. Entrypoint reconciles node_modules on every start. |
| `ENOSPC` | Disk full. `docker system df`; ask before `docker system prune -f`. |
| `npm ERR! code EACCES` inside `/app/node_modules` | Ownership drift. Ask user to `rm -rf node_modules && npm ci` on host, then restart container. |

### C. Runtime failures — service won't stay up

| Signature | Recovery |
|---|---|
| Spring Boot `Port … already in use` | Confirm `port` in `[[services]]` entry of `.fleet/fleet.toml`. Inside container: `docker exec fleet-<NAME> supervisorctl restart <service>`. |
| PostgreSQL `could not bind IPv4 address` or DB init failure | `docker exec fleet-<NAME> supervisorctl restart postgresql`. If first-boot init failed, tear down and recreate: `fleet rm <NAME> && fleet add <NAME>`. |
| Backend `Connection refused` to DB | DB env mismatch. Both service and postgres share the container's network namespace; DB is at `127.0.0.1:5432`. Restart backend only. |
| Container status `Exited (137)` | OOM-killed. Raise Docker Desktop memory limit, then `fleet restart <NAME>`. |
| Container status `Exited (139)` (segfault) | Usually corrupt node_modules volume. Remove `fleet-<NAME>-nm` volume and restart. |

### D. Proxy / routing failures — gateway returns 502/503

| Signature | Recovery |
|---|---|
| 503 + "No active feature" page | `curl -X POST http://localhost:4000/_fleet/api/features/<NAME>/activate` (or use dashboard). |
| 502, container is running | Service not listening on its port yet. Check `http://localhost:4000/_fleet/api/features/<NAME>/health`; wait 5–10 s; re-check supervisorctl status. |
| 502, container not on `fleet-net` | `docker network connect fleet-net fleet-<NAME>`. |
| Feature missing from registry after gateway restart | Invoke `/fleet:add <NAME>` to re-register, or manually POST to `/_fleet/api/register-feature`. |

### E. Gateway-side failures

| Signature | Recovery |
|---|---|
| `DockerSocketError` | Docker daemon down or socket not mounted. Restart Docker Desktop. |
| `DockerContainerError 404` | Stale registry entry. `curl -X DELETE http://localhost:4000/_fleet/api/register-feature/<NAME>`. |
| `DockerContainerError 409` on logs/exec | Container not running — expected during build. Wait and retry. |

---

## Recovery recipes

Pick the least destructive recipe that matches the signature.

**Tier 1 — soft restart (no data loss):**
```bash
fleet restart <NAME>
docker exec fleet-<NAME> supervisorctl restart <service>
```

**Tier 2 — drop node_modules volume (keeps DB data):**
```bash
docker stop fleet-<NAME>
docker volume rm fleet-<NAME>-nm
docker start fleet-<NAME>
```

**Tier 3 — rebuild feature container (keeps worktree + branch):**
Invoke `/fleet:add <NAME>` after `fleet rm <NAME>`.
```bash
fleet rm <NAME>
# then: /fleet:add <NAME>
```

**Tier 4 — rebuild base image (affects ALL features — ASK FIRST):**
Invoke `/fleet:init` to rebuild the base image. Existing features need `fleet rm / fleet add` after.

**Tier 5 — nuke (DESTRUCTIVE — ASK FIRST):**
```bash
fleet rm --nuke
# then: /fleet:init
```

---

## Fresh environment setup

When the user wants a fresh environment, invoke `/fleet:init [feature-name]`:

1. Confirm `docker info` works.
2. Confirm `.fleet/fleet.toml` exists in the project root (or guide through the wizard — needs real tty).
3. Invoke `/fleet:init` — it writes the TOML, runs `fleet init`, and waits for the gateway.
4. To spin up a feature container, invoke `/fleet:add <NAME>`.

---

## Guardrails

- **Never run `fleet rm --nuke`, `docker volume prune`, `docker system prune`, or rebuild the base image without explicit user approval** — they wipe other features' data and force rebuilds.
- **Never touch `test/reference/`** (pristine fixture). Use `test/project/` for experiments; re-copy with `cp -rp test/reference test/project` if corrupted.
- **Never edit `.fleet/fleet.toml` silently.** Propose the diff, then apply.
- **Prefer the gateway API over raw `docker exec`** when the gateway is healthy — it gives structured responses.
- **If three restart attempts fail, stop and escalate.** Read the log; do not loop restarts blindly.

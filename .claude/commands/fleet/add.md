---
name: fleet:add
description: Spin up a feature container via `fleet add <name> [--title <title>] [--direct]`. Runs pre-flight checks, invokes the CLI, waits for the container to report healthy via the gateway, and prints a structured report.
user-invocable: true
argument-hint: "<name> [--title <title>] [--direct]"
---

Spin up a named feature container end-to-end: pre-flight checks, invoke `fleet add`, wait for the feature to report healthy via the gateway, then print a structured report.

The CLI no longer takes a branch positional argument — the branch is read from the git worktree resolved via `[project].worktree_template` in `.fleet/fleet.toml`. Pass `--direct` to bind-mount the primary checkout instead of a worktree.

## Prerequisites

- Docker running
- `fleet` on PATH (run `fleet init` first if not yet installed)
- `jq` installed (for JSON health parsing)
- `fleet-feature-base` image built (produced by `fleet init`)
- `.fleet/fleet.toml` present in the project root (produced by `fleet init`)

---

## Step 0 — Parse arguments

The command receives arguments via `$ARGUMENTS`. Parse them:

```
NAME   = first positional token of $ARGUMENTS (required)
TITLE  = value after --title (optional; defaults to NAME)
DIRECT = true if --direct appears anywhere in $ARGUMENTS, otherwise false
```

**Validation:**
- If `NAME` is empty → print `Error: name is required. Usage: /fleet:add <name> [--title <title>] [--direct]` and stop.
- If `NAME` does not match `^[a-z0-9]([a-z0-9-]*(\.[a-z0-9-]+)*)?$` → print `Error: name must match ^[a-z0-9]([a-z0-9-]*(\.[a-z0-9-]+)*)?$ (lowercase alphanumerics, dots, and hyphens only; no leading, trailing, or consecutive dots).` and stop.
- If `--title` is passed without a value → print `Error: --title requires a value.` and stop.

**Note on branch:** in the previous CLI, a `<branch>` positional was required. It is no longer accepted and will be rejected by `fleet add` as an unknown argument. The branch is derived from the worktree's `HEAD`; create the worktree first with `git worktree add .worktrees/<name> <branch>` before invoking this skill (unless using `--direct`).

---

## Step 1 — Pre-flight checks

Run all checks in order. Stop at the first failure with a clear recovery hint.

**1a. fleet on PATH**

```bash
if ! command -v fleet &>/dev/null; then
  echo "Error: 'fleet' not found on PATH."
  echo "Recovery: run fleet init once to install the symlink, or add the fleet bin to your PATH."
  exit 1
fi
```

**1b. Docker daemon reachable**

```bash
if ! docker info &>/dev/null; then
  echo "Error: Docker daemon is not running or not reachable."
  echo "Recovery: start Docker Desktop (macOS) or 'sudo systemctl start docker' (Linux)."
  exit 1
fi
```

**1c. Base image exists**

```bash
if ! docker image inspect fleet-feature-base &>/dev/null; then
  echo "Error: base image 'fleet-feature-base' not found."
  echo "Recovery: run 'fleet init' from the project root to build the base image first."
  exit 1
fi
```

**1d. fleet.toml present**

```bash
if [[ ! -f ".fleet/fleet.toml" ]]; then
  echo "Error: .fleet/fleet.toml not found in the current directory."
  echo "Recovery: run 'fleet init' from the project root, or cd into the project root before calling /fleet:add."
  exit 1
fi
```

**1e. Worktree exists (only when not --direct)**

```bash
if [[ "$DIRECT" != "true" ]]; then
  WORKTREE_TEMPLATE=$(python3 -c "import sys, tomllib; d=tomllib.load(open('.fleet/fleet.toml','rb')); print(d.get('project', {}).get('worktree_template', ''))" 2>/dev/null)
  if [[ -z "$WORKTREE_TEMPLATE" ]]; then
    echo "Error: [project].worktree_template is not set in .fleet/fleet.toml."
    echo "Recovery: add 'worktree_template = \".worktrees/{name}\"' under [project] in fleet.toml, then retry."
    exit 1
  fi
  RESOLVED_WT="${WORKTREE_TEMPLATE//\{name\}/$NAME}"
  if ! git -C "$RESOLVED_WT" rev-parse --is-inside-work-tree &>/dev/null; then
    echo "Error: worktree '${RESOLVED_WT}' does not exist."
    echo "Recovery: create it first with 'git worktree add ${RESOLVED_WT} <branch>' or pass --direct."
    exit 1
  fi
fi
```

**1f. Feature container does not already exist**

The container name is `fleet-${NAME}` (not `qa-${NAME}`).

```bash
if docker inspect "fleet-${NAME}" &>/dev/null; then
  STATUS=$(docker inspect -f '{{.State.Status}}' "fleet-${NAME}" 2>/dev/null || echo "unknown")
  echo "Error: container 'fleet-${NAME}' already exists (status: ${STATUS})."
  echo "Recovery: run 'fleet rm ${NAME}' to remove it, then retry."
  exit 1
fi
```

**1g. Feature state dir does not already exist**

```bash
if [[ -f ".fleet/${NAME}/info.toml" ]]; then
  echo "Error: feature '${NAME}' already registered (.fleet/${NAME}/info.toml exists)."
  echo "Recovery: run 'fleet rm ${NAME}' first."
  exit 1
fi
```

**1h. Gateway container running (warn-only)**

```bash
if ! docker inspect fleet-gateway &>/dev/null || \
   [[ "$(docker inspect -f '{{.State.Status}}' fleet-gateway 2>/dev/null)" != "running" ]]; then
  echo "WARN: gateway container 'fleet-gateway' is not running."
  echo "  Feature registration will return a non-200 status and the /_fleet/api/* routes will be unreachable,"
  echo "  but the feature container itself will still start."
fi
```

---

## Step 2 — Invoke fleet add

Build the command based on the `TITLE` and `DIRECT` flags. Note: `<branch>` is no longer passed.

```bash
FLEET_ARGS=("${NAME}")
[[ -n "$TITLE" ]] && FLEET_ARGS+=(--title "$TITLE")
[[ "$DIRECT" == "true" ]] && FLEET_ARGS+=(--direct)

LOG_FILE="/tmp/fleet-add-${NAME}.log"

echo "Running: fleet add ${FLEET_ARGS[*]}"
echo "Output teed to: ${LOG_FILE}"
echo ""

fleet add "${FLEET_ARGS[@]}" 2>&1 | tee "$LOG_FILE"
FLEET_EXIT=${PIPESTATUS[0]}

if [[ "$FLEET_EXIT" -ne 0 ]]; then
  echo ""
  echo "Error: fleet add exited with code ${FLEET_EXIT}. Last 30 log lines:"
  tail -30 "$LOG_FILE"
  echo ""
  echo "Recovery: inspect the output above, fix the underlying issue, then:"
  echo "  1. Run 'fleet rm ${NAME}' to clean up any partial state."
  echo "  2. Re-run '/fleet:add ${NAME} [--title <title>] [--direct]' to retry."
  exit 1
fi
```

---

## Step 3 — Wait for the container to start

Unlike the old supervisord-managed container, the new CLI brings the feature up via `docker compose up -d`. There is no `supervisord` "entered RUNNING state" message to grep for. Instead, confirm the container is in state `running`, then proceed to the health check.

Maximum 20 attempts × 15 s = 5 minutes.

```bash
CONTAINER="fleet-${NAME}"
MAX_ATTEMPTS=20
ATTEMPT=0

echo "Waiting for ${CONTAINER} to enter 'running' state (max 5 min)..."

while [[ $ATTEMPT -lt $MAX_ATTEMPTS ]]; do
  ATTEMPT=$((ATTEMPT + 1))

  CSTATE=$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo "missing")
  case "$CSTATE" in
    running)
      echo "Container is running (attempt ${ATTEMPT}/${MAX_ATTEMPTS})."
      break
      ;;
    exited|dead|missing)
      echo ""
      echo "Error: container '${CONTAINER}' is in state '${CSTATE}' — it stopped unexpectedly."
      echo "Last 50 log lines:"
      docker logs --tail 50 "$CONTAINER" 2>&1 || true
      echo ""
      echo "Recovery hints:"
      echo "  - Check the services' build/run commands in .fleet/fleet.toml ([[services]].build and .run)."
      echo "  - Check that each service directory exists in the worktree."
      echo "  - Run 'fleet rm ${NAME}' before retrying."
      exit 1
      ;;
  esac

  if [[ $ATTEMPT -eq $MAX_ATTEMPTS ]]; then
    echo ""
    echo "Error: container did not reach 'running' state within 5 minutes."
    echo "Last 50 log lines:"
    docker logs --tail 50 "$CONTAINER" 2>&1 || true
    echo ""
    echo "Recovery: run 'fleet rm ${NAME}' before retrying."
    exit 1
  fi

  echo "  attempt ${ATTEMPT}/${MAX_ATTEMPTS} — state '${CSTATE}', next check in 15s..."
  sleep 15
done
```

---

## Step 4 — Verify health via the gateway

Resolve the proxy port from `.fleet/fleet.toml` (`[ports].proxy`, default 3000) and the gateway admin port (`[ports].admin`, default 4000).

Prefer the gateway's per-feature health endpoint (`/_fleet/api/features/<NAME>/health`) because it aggregates each service's status. Fall back to the proxy-level `/backend/actuator/health` when the gateway is unreachable but the container is up.

```bash
PROXY_PORT=$(python3 -c "import tomllib; d=tomllib.load(open('.fleet/fleet.toml','rb')); print(d.get('ports', {}).get('proxy', 3000))" 2>/dev/null || echo 3000)
ADMIN_PORT=$(python3 -c "import tomllib; d=tomllib.load(open('.fleet/fleet.toml','rb')); print(d.get('ports', {}).get('admin', 4000))" 2>/dev/null || echo 4000)

GATEWAY_HEALTH_URL="http://localhost:${ADMIN_PORT}/_fleet/api/features/${NAME}/health"
FALLBACK_HEALTH_URL="http://localhost:${PROXY_PORT}/${NAME}/backend/actuator/health"
HEALTH_TMP="/tmp/fleet-add-${NAME}-health.json"

echo ""
echo "Checking health via gateway: ${GATEWAY_HEALTH_URL}"

HTTP_CODE=$(curl -s -o "$HEALTH_TMP" -w '%{http_code}' "$GATEWAY_HEALTH_URL" 2>/dev/null || echo "000")

# If the gateway API is unreachable, fall back to proxy
if [[ "$HTTP_CODE" == "000" || "$HTTP_CODE" == "404" ]]; then
  echo "Gateway health unreachable (HTTP ${HTTP_CODE}); falling back to ${FALLBACK_HEALTH_URL}"
  HTTP_CODE=$(curl -s -o "$HEALTH_TMP" -w '%{http_code}' "$FALLBACK_HEALTH_URL" 2>/dev/null || echo "000")
fi

echo "HTTP ${HTTP_CODE}"

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "WARN: expected 200, got ${HTTP_CODE}."
  echo "Response body (if any):"
  cat "$HEALTH_TMP" 2>/dev/null || echo "(no body)"
  echo ""
  echo "The container is running. The services may still be building or warming up — retry the health URL in a moment."
else
  HEALTH_JSON=$(cat "$HEALTH_TMP")
  OVERALL=$(echo "$HEALTH_JSON" | jq -r '.status // "UNKNOWN"')
  echo "Overall status: ${OVERALL}"
  echo ""
  echo "Per-component status:"
  echo "$HEALTH_JSON" | jq -r '
    .components // {} | to_entries[] |
    "  \(.key): \(.value.status)"
  ' 2>/dev/null || echo "  (no component details)"

  DOWN_COMPONENTS=$(echo "$HEALTH_JSON" | jq -r '
    .components // {} | to_entries[] |
    select(.value.status == "DOWN" or .value.status == "OUT_OF_SERVICE") |
    .key
  ' 2>/dev/null || true)

  if [[ -n "$DOWN_COMPONENTS" ]]; then
    echo ""
    echo "DOWN components — recovery hints:"
    while IFS= read -r component; do
      case "$component" in
        ldap*)
          echo "  - ${component}: LDAP server unreachable — add '-Dspring.profiles.active=local' to the [[services]].run entry for the backend in .fleet/fleet.toml" ;;
        db|datasource|jdbc*)
          echo "  - ${component}: database unreachable — check the sidecar postgres container and SPRING_DATASOURCE_* env (feature.env under .fleet/${NAME}/)" ;;
        mail*)
          echo "  - ${component}: mail server not reachable — expected in local dev; disable via Spring profile if needed" ;;
        *)
          echo "  - ${component}: unknown failure — run 'docker logs fleet-${NAME}' or 'docker exec fleet-${NAME} supervisorctl status'" ;;
      esac
    done <<< "$DOWN_COMPONENTS"
  fi
fi
```

---

## Step 5 — Final report

Print a structured summary of the completed run.

```bash
MODE="worktree"
[[ "$DIRECT" == "true" ]] && MODE="direct"

CONTAINER_STATUS=$(docker ps --filter "name=fleet-${NAME}" \
  --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || echo "(unavailable)")

echo ""
echo "=== /fleet:add complete ==="
echo ""
echo "Feature:    ${NAME}"
echo "Title:      ${TITLE:-$NAME}"
echo "Mode:       ${MODE}"
echo ""
echo "Container status:"
echo "${CONTAINER_STATUS}"
echo ""
echo "URLs:"
echo "  Proxy (per-service routing): http://localhost:${PROXY_PORT}/${NAME}/"
echo "  Gateway feature API:         http://localhost:${ADMIN_PORT}/_fleet/api/features/${NAME}"
echo "  Gateway health:              http://localhost:${ADMIN_PORT}/_fleet/api/features/${NAME}/health  (HTTP ${HTTP_CODE})"
echo ""
if [[ "$HTTP_CODE" == "200" ]]; then
  echo "Overall health: ${OVERALL}"
else
  echo "Overall health: UNKNOWN (HTTP ${HTTP_CODE})"
fi
echo ""
echo "Useful commands:"
echo "  Logs:              docker logs -f fleet-${NAME}"
echo "  Supervisor status: docker exec fleet-${NAME} supervisorctl status"
echo "  Logs via gateway:  curl -s 'http://localhost:${ADMIN_PORT}/_fleet/api/features/${NAME}/logs?source=all&tail=200'"
echo "  Teardown:          fleet rm ${NAME}"
```

If any component was DOWN: append the per-component hints from Step 4 and note: "The feature is running but some components are unhealthy — see hints above. Adjust `.fleet/fleet.toml` ([[services]].env / .run) or the sidecar env; do not modify source files."

---

## Hard rules

- Do NOT modify any source file, `.fleet/fleet.toml`, `.claude/`, or `.beads/`.
- Do NOT push to git.
- Do NOT run `fleet rm` automatically — always surface the command for the user to run.
- If any pre-flight check fails, stop immediately with a clear recovery hint. No self-healing.
- If `fleet add` exits non-zero, leave partial container state in place for inspection. Suggest `fleet rm ${NAME}` before retry; do not remove it yourself.
- If the container enters `exited` or `dead` state during the running-state wait, dump logs and stop. Do not restart it.
- Never pass `<branch>` as a positional arg — it is not accepted by the current CLI and the branch is read from the worktree's HEAD.

---

## Migration notes (from the pre-gustave-2y5 skill)

- **Args**: previously `fleet add <name> <branch>`; now `fleet add <name> [--title <title>] [--direct]`. The branch positional is gone.
- **Container name**: was `qa-${NAME}`; is now `fleet-${NAME}`.
- **Base image**: was `qa-feature-base`; is now `fleet-feature-base`.
- **Config file**: was `fleet.conf` (`PROXY_PORT=...`); is now `.fleet/fleet.toml` (`[ports].proxy = ...`).
- **Gateway container name**: still `fleet-gateway`, but the admin path prefix is now `/_fleet/api/...` (was `/_qa/api/...`).
- **Readiness signal**: was supervisord log line `backend entered RUNNING state`; is now `docker inspect .State.Status == running` + gateway health endpoint.
- **Feature state dir**: was `.qa/${NAME}/`; is now `.fleet/${NAME}/info.toml`.

---
name: fleet:add
description: Spin up a feature container via `fleet add <name> <branch>`. Runs pre-flight checks, invokes the CLI, waits for RUNNING state, and verifies `/backend/actuator/health`.
user-invocable: true
argument-hint: "<name> <branch> [--direct]"
---

Spin up a named feature container end-to-end: pre-flight checks, invoke `fleet add`, wait for the backend to enter RUNNING state, verify `/backend/actuator/health`, then print a structured report.

## Prerequisites

- Docker running
- `fleet` on PATH (run `fleet init` first if not yet installed)
- `jq` installed (for JSON health parsing)
- `qa-feature-base` image built (produced by `fleet init`)

---

## Step 0 — Parse arguments

The command receives arguments via `$ARGUMENTS`. Parse them:

```
NAME   = first token of $ARGUMENTS  (required)
BRANCH = second token of $ARGUMENTS (required)
DIRECT = true if "--direct" appears anywhere in $ARGUMENTS, otherwise false
```

**Validation:**
- If `NAME` is empty → print `Error: name is required. Usage: /fleet:add <name> <branch> [--direct]` and stop.
- If `BRANCH` is empty → print `Error: branch is required. Usage: /fleet:add <name> <branch> [--direct]` and stop.
- If `NAME` does not match `^[a-z0-9-]+$` → print `Error: name must match ^[a-z0-9-]+$ (lowercase letters, digits, hyphens only).` and stop.

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
if ! docker image inspect qa-feature-base &>/dev/null; then
  echo "Error: base image 'qa-feature-base' not found."
  echo "Recovery: run 'fleet init <project-path> <branch>' to build the base image first."
  exit 1
fi
```

**1d. Feature container does not already exist**

```bash
if docker inspect "qa-${NAME}" &>/dev/null; then
  STATUS=$(docker inspect -f '{{.State.Status}}' "qa-${NAME}" 2>/dev/null || echo "unknown")
  echo "Error: container 'qa-${NAME}' already exists (status: ${STATUS})."
  echo "Recovery: run 'fleet rm ${NAME}' to remove it, then retry."
  exit 1
fi
```

**1e. Gateway container running (warn-only)**

```bash
if ! docker inspect qa-gateway-container &>/dev/null || \
   [[ "$(docker inspect -f '{{.State.Status}}' qa-gateway-container 2>/dev/null)" != "running" ]]; then
  echo "WARN: gateway container 'qa-gateway-container' is not running."
  echo "  Feature registration will be skipped. The container will still start,"
  echo "  but traffic routing via the gateway will be unavailable until the gateway is up."
fi
```

---

## Step 2 — Invoke fleet add

Build the command based on the `DIRECT` flag:

```bash
if [[ "$DIRECT" == "true" ]]; then
  FLEET_CMD="fleet add \"${NAME}\" \"${BRANCH}\" --direct"
else
  FLEET_CMD="fleet add \"${NAME}\" \"${BRANCH}\""
fi

LOG_FILE="/tmp/fleet-add-${NAME}.log"

echo "Running: ${FLEET_CMD}"
echo "Output teed to: ${LOG_FILE}"
echo ""

eval "$FLEET_CMD" 2>&1 | tee "$LOG_FILE"
FLEET_EXIT=${PIPESTATUS[0]}

if [[ "$FLEET_EXIT" -ne 0 ]]; then
  echo ""
  echo "Error: fleet add exited with code ${FLEET_EXIT}. Last 30 log lines:"
  tail -30 "$LOG_FILE"
  echo ""
  echo "Recovery: inspect the output above, fix the underlying issue, then:"
  echo "  1. Run 'fleet rm ${NAME}' to clean up any partial state."
  echo "  2. Re-run '/fleet:add ${NAME} ${BRANCH}' to retry."
  exit 1
fi
```

---

## Step 3 — Wait for RUNNING state

Poll `docker logs` for the supervisord signal that the backend process is up. Maximum 40 attempts × 15 s = 10 minutes.

```bash
CONTAINER="qa-${NAME}"
MAX_ATTEMPTS=40
ATTEMPT=0

echo "Waiting for ${CONTAINER} to enter RUNNING state (max 10 min)..."

while [[ $ATTEMPT -lt $MAX_ATTEMPTS ]]; do
  ATTEMPT=$((ATTEMPT + 1))

  # Hard-fail if the container itself has exited or died
  CSTATE=$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo "missing")
  case "$CSTATE" in
    exited|dead|missing)
      echo ""
      echo "Error: container '${CONTAINER}' is in state '${CSTATE}' — it stopped unexpectedly."
      echo "Last 50 log lines:"
      docker logs --tail 50 "$CONTAINER" 2>&1
      echo ""
      echo "Recovery hints:"
      echo "  - Check BACKEND_BUILD_CMD in qa-fleet.conf — a build failure exits the container."
      echo "  - Check BACKEND_RUN_CMD in qa-fleet.conf — a bad start command causes an immediate exit."
      echo "  - Run 'fleet rm ${NAME}' before retrying."
      exit 1
      ;;
  esac

  RUNNING=$(docker logs --tail 20 "$CONTAINER" 2>&1 | grep 'backend entered RUNNING state' || true)
  if [[ -n "$RUNNING" ]]; then
    echo "Backend is RUNNING (attempt ${ATTEMPT}/${MAX_ATTEMPTS})"
    break
  fi

  if [[ $ATTEMPT -eq $MAX_ATTEMPTS ]]; then
    echo ""
    echo "Error: backend did not enter RUNNING state within 10 minutes."
    echo "Last 50 log lines:"
    docker logs --tail 50 "$CONTAINER" 2>&1
    echo ""
    echo "Recovery hints:"
    echo "  - Inspect BACKEND_BUILD_CMD in qa-fleet.conf: is the build command correct?"
    echo "  - Inspect BACKEND_RUN_CMD in qa-fleet.conf: is the run command correct?"
    echo "  - Run 'fleet rm ${NAME}' before retrying."
    exit 1
  fi

  echo "  attempt ${ATTEMPT}/${MAX_ATTEMPTS} — not yet running, next check in 15s..."
  sleep 15
done
```

---

## Step 4 — Verify health endpoint

Resolve `PROXY_PORT` from the project's `qa-fleet.conf`. Look for the conf in the current working directory or one level up; default to `3000` if not found.

```bash
PROXY_PORT=$(grep '^PROXY_PORT' qa-fleet.conf 2>/dev/null \
  | cut -d= -f2 | tr -d '"' | tr -d "'" || true)
PROXY_PORT=${PROXY_PORT:-$(grep '^PROXY_PORT' ../qa-fleet.conf 2>/dev/null \
  | cut -d= -f2 | tr -d '"' | tr -d "'" || true)}
PROXY_PORT=${PROXY_PORT:-3000}

HEALTH_URL="http://localhost:${PROXY_PORT}/${NAME}/backend/actuator/health"
HEALTH_TMP="/tmp/fleet-add-${NAME}-health.json"

echo ""
echo "Checking health: ${HEALTH_URL}"

HTTP_CODE=$(curl -s -o "$HEALTH_TMP" -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || echo "000")

echo "HTTP ${HTTP_CODE}"

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "WARN: expected 200, got ${HTTP_CODE}."
  echo "Response body (if any):"
  cat "$HEALTH_TMP" 2>/dev/null || echo "(no body)"
  echo ""
  echo "The container is running. The health endpoint may still be warming up — retry in a moment."
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

  # Flag DOWN or OUT_OF_SERVICE components with domain-specific hints
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
          echo "  - ${component}: LDAP server unreachable — add \`-Dspring.profiles.active=local\` to BACKEND_RUN_CMD in qa-fleet.conf" ;;
        db|datasource|jdbc*)
          echo "  - ${component}: database unreachable — check postgres container and DB_* env vars in qa-fleet.conf" ;;
        mail*)
          echo "  - ${component}: mail server not reachable — expected in local dev; disable via Spring profile if needed" ;;
        *)
          echo "  - ${component}: unknown failure — check docker logs qa-${NAME}" ;;
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

CONTAINER_STATUS=$(docker ps --filter "name=qa-${NAME}" \
  --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || echo "(unavailable)")

echo ""
echo "=== /fleet:add complete ==="
echo ""
echo "Feature:    ${NAME}"
echo "Branch:     ${BRANCH}"
echo "Mode:       ${MODE}"
echo ""
echo "Container status:"
echo "${CONTAINER_STATUS}"
echo ""
echo "URL:        http://localhost:${PROXY_PORT}/${NAME}/"
echo "Health:     http://localhost:${PROXY_PORT}/${NAME}/backend/actuator/health  (HTTP ${HTTP_CODE})"
echo ""
if [[ "$HTTP_CODE" == "200" ]]; then
  echo "Overall health: ${OVERALL}"
else
  echo "Overall health: UNKNOWN (HTTP ${HTTP_CODE})"
fi
echo ""
echo "Useful commands:"
echo "  Logs:     docker logs -f qa-${NAME}"
echo "  Teardown: fleet rm ${NAME}"
```

If any component was DOWN: append the per-component hints from Step 4 and note: "The feature is running but some components are unhealthy — see hints above. Adjust qa-fleet.conf or environment only; do not modify source files."

---

## Hard rules

- Do NOT modify any source file, `qa-fleet.conf`, `.claude/`, or `.beads/`.
- Do NOT push to git.
- Do NOT run `fleet rm` automatically — always surface the command for the user to run.
- If any pre-flight check fails, stop immediately with a clear recovery hint. No self-healing.
- If `fleet add` exits non-zero, leave partial container state in place for inspection. Suggest `fleet rm ${NAME}` before retry; do not remove it yourself.
- If the container enters `exited` or `dead` state during the RUNNING wait, dump logs and stop. Do not restart it.

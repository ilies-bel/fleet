---
name: fleet:init
description: End-to-end fleet init for a project. Auto-tunes qa-fleet.conf for the detected stack, runs the bash fleet init, waits for the container, and verifies /actuator/health. Use instead of running 'fleet init' directly when you want it Just To Work.
user-invocable: true
argument-hint: "<project-path> [branch]"
---

Run the full fleet init flow end-to-end: detect the project stack, auto-tune `qa-fleet.conf`, invoke `fleet init` non-interactively via tmux, wait for the backend container, then verify `/actuator/health`.

## Prerequisites

- Docker running
- `fleet` on PATH (or run `fleet init` once first to symlink it)
- `tmux` installed (`brew install tmux` on macOS)
- `jq` installed (for JSON health parsing)
- qa-fleet repo cloned at a known path (see Step 0)

---

## Step 0 — Parse arguments and locate qa-fleet root

The command receives arguments via `$ARGUMENTS`. Parse them:

```
PROJECT_PATH = first token of $ARGUMENTS  (required — absolute or relative to cwd)
BRANCH       = second token, default "main"
```

**Validation:**
- If `PROJECT_PATH` is empty → print `Error: project-path is required. Usage: /fleet:init <project-path> [branch]` and stop.
- Resolve to absolute path (prepend cwd if relative).
- If the resolved path does not exist → print `Error: path '<resolved>' does not exist.` and stop.
- If none of `pom.xml`, `package.json`, `build.gradle`, or subdirectory containing these exists in the project root → warn "No recognizable project files found. Proceeding anyway."

Locate the qa-fleet repo root:

```bash
QA_FLEET_ROOT=$(git -C "$(dirname "$(which fleet)")" rev-parse --show-toplevel 2>/dev/null) \
  || QA_FLEET_ROOT="$(cd "$(dirname "$(realpath "$(which fleet)")")/.." && pwd)"
# Fallback: the qa-fleet root is the directory containing the 'fleet' dispatcher.
```

If `fleet` is not on PATH, use a hard fallback known from the installed symlink:

```bash
QA_FLEET_ROOT="$(dirname "$(realpath /usr/local/bin/fleet)")"
```

---

## Step 1 — Read evidence files (no guessing)

Read each file below, in order. Record what you find. Skip files that do not exist.

**1a. Discover structure**

```bash
ls "$PROJECT_PATH/"
```

Identify which subdirectories are the frontend and backend. A subdirectory is the backend if it contains `pom.xml`, `build.gradle`, or `go.mod`. A subdirectory is the frontend if it contains a `package.json` with a `"build"` script AND a `next.config.*` (Next.js) or `vite.config.*` (Vite/React).

**1b. Read the project root `qa-fleet.conf` (if it exists)**

Record current values for: `PROJECT_NAME`, `FRONTEND_DIR`, `BACKEND_DIR`, `FRONTEND_OUT_DIR`, `BACKEND_BUILD_CMD`, `BACKEND_RUN_CMD`, `PROXY_PORT`, `BACKEND_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`.

**1c. Read `README.md`** in the project root and any `docs/` files — note any explicit "build with `mvn -P...`" or "run with `--spring.profiles.active=...`" the project documents.

**1d. Read `${BACKEND_DIR}/pom.xml`** (if present):
- Extract every `<profile><id>X</id></profile>` block.
- Identify plugins requiring a profile: jOOQ codegen (`org.jooq:jooq-codegen-maven`), Flyway, OpenAPI generator.
- Note the profile ID that activates each codegen plugin.
- Note any `<dependencies>` with `<scope>provided</scope>` in plugin blocks (relevant to devtools injection safety).

**1e. Read `${BACKEND_DIR}/build.gradle` or `build.gradle.kts`** (if no pom.xml):
- Extract Spring profile references and source sets that control codegen.

**1f. Read all `${BACKEND_DIR}/src/main/resources/application*.yml` and `application*.properties`**:
- List every Spring profile name (from the `-<profile>` suffix in filenames).
- For each profile-specific file, read it and note whether it **disables** anything intranet-only: LDAP, Kerberos, internal hostnames, custom `HealthIndicator` beans contacting internal services.

**1g. Read `${FRONTEND_DIR}/package.json`**:
- Record `scripts.build` and `scripts.start`.
- Detect output dir: if `next.config.*` exists → `out`; if `vite.config.*` exists → `dist`.

**1h. Note any `.env` files** at root, `${BACKEND_DIR}/`, or `${FRONTEND_DIR}/`. Do not parse their contents — fleet's entrypoint already mounts them.

---

## Step 2 — Decide the conf values

Based on the evidence from Step 1, derive the following values.

**`PROJECT_NAME`**
- If present and non-blank in existing conf → keep as-is.
- Otherwise: use `basename` of `$PROJECT_PATH`.

**`FRONTEND_DIR`** / **`BACKEND_DIR`**
- Use the subdirectory names detected in Step 1a.
- If existing conf already has valid non-blank values → keep them.

**`FRONTEND_OUT_DIR`**
- `out` for Next.js, `dist` for Vite/React, `build` for Create React App.

**`BACKEND_BUILD_CMD`**
- Start with base: `mvn package -DskipTests -q` (Maven) or `go build -o server .` (Go) or `npm run build` (Node).
- If `pom.xml` contains the jOOQ codegen plugin AND a profile named `jooq-codegen` (or similar) activates it, append `-P<profile-name>` to the Maven command.
- If the plugin exists but no activating profile is found, print a warning and leave unchanged.
- For Gradle: apply `--profile` equivalent only if documented in README.

**`BACKEND_RUN_CMD`**
- Maven/Spring: `java -jar /home/developer/backend.jar`
- Go: `/app/${BACKEND_DIR}/server`
- Node: `node /app/${BACKEND_DIR}/dist/index.js`
- If exactly **one** `application-<profile>.yml` disables an intranet-only health indicator (LDAP, Kerberos, internal hostname), add `-Dspring.profiles.active=<profile>` to the java command.
- If **multiple** candidate profiles qualify, use `AskUserQuestion` to ask which profile to activate.
- If no profile qualifies, leave `BACKEND_RUN_CMD` without a profile flag.

**`PROXY_PORT`**
- Default `3000` unless already set in conf.

**`BACKEND_PORT`**
- Default `8081` unless already set in conf.

**DB fields** (`DB_NAME`, `DB_USER`, `DB_PASSWORD`):
- If existing conf has values → keep them.
- If project has `application-local.yml` or similar with datasource config, derive defaults from there.
- Otherwise: `DB_NAME=<project_slug>`, `DB_USER=developer`, `DB_PASSWORD=developer`.

---

## Step 3 — Show diff and confirm

Print the proposed `qa-fleet.conf` content (or a unified diff if the file already exists):

```
--- qa-fleet.conf (current)
+++ qa-fleet.conf (proposed)
@@ ...
```

Use `AskUserQuestion`: "Apply the above qa-fleet.conf and proceed with fleet init? [y/N]"

If the user declines → print "Aborted — no changes made." and stop.

---

## Step 4 — Write qa-fleet.conf

Write the complete `qa-fleet.conf` to `${PROJECT_PATH}/qa-fleet.conf`. Only touch this file. Template:

```
PROJECT_NAME="<value>"
FRONTEND_DIR="<value>"
FRONTEND_OUT_DIR="<value>"
BACKEND_DIR="<value>"
BACKEND_BUILD_CMD="<value>"
BACKEND_RUN_CMD="<value>"
BACKEND_PORT="<value>"
PROXY_PORT="<value>"
DB_NAME="<value>"
DB_USER="<value>"
DB_PASSWORD="<value>"
```

Include only keys that have non-empty values. The write must be idempotent (running the command twice produces the same file).

---

## Step 5 — Run fleet init via tmux

`fleet init` reads `/dev/tty` for two interactive prompts:
1. **spring-boot-devtools prompt** — "Add spring-boot-devtools to pom.xml? [y/N]" → always answer `n` (we never mutate source).
2. **conf wizard** — this is entirely bypassed because we wrote `qa-fleet.conf` in Step 4.

Run via tmux so Claude can send keystrokes to the tty:

```bash
# Kill any existing session to start clean
tmux kill-session -t fleetinit 2>/dev/null || true

# Start fleet init in a detached tmux session
tmux new-session -d -s fleetinit \
  "fleet init $PROJECT_PATH $BRANCH 2>&1 | tee /tmp/fleet-init.log; echo '[fleet-init-done]' >> /tmp/fleet-init.log"

# Give the process 3 seconds to emit the devtools prompt (if any)
sleep 3

# Answer the devtools prompt (safe no-op if prompt doesn't appear)
tmux send-keys -t fleetinit "n" Enter

# Stream the log so you can follow progress
echo "fleet init running. Log tail:"
tail -f /tmp/fleet-init.log &
TAIL_PID=$!
```

**Watch for failure lines while tailing:**

Parse `[fleet]` log lines for keywords:
- `ERROR` or `error` → surface the line immediately
- `failed` / `FAILED` → surface the line immediately
- `[fleet-init-done]` → fleet init exited; stop tailing

```bash
# Wait up to 3 minutes for fleet init to complete
INIT_TIMEOUT=180
ELAPSED=0
while ! grep -q '\[fleet-init-done\]' /tmp/fleet-init.log 2>/dev/null; do
  sleep 5
  ELAPSED=$((ELAPSED + 5))
  if [[ $ELAPSED -ge $INIT_TIMEOUT ]]; then
    kill $TAIL_PID 2>/dev/null
    echo "ERROR: fleet init timed out after ${INIT_TIMEOUT}s. Last 30 lines:"
    tail -30 /tmp/fleet-init.log
    echo ""
    echo "Recovery: check docker logs qa-gateway-container, then re-run /fleet:init"
    exit 1
  fi
done
kill $TAIL_PID 2>/dev/null || true
```

If the log contains `ERROR` or `failed` before `[fleet-init-done]`, surface the last 30 lines and stop:

```bash
if grep -qiE '(^ERROR|error:|failed|FAILED)' /tmp/fleet-init.log; then
  echo "fleet init reported errors:"
  tail -30 /tmp/fleet-init.log
  echo ""
  echo "Recovery action: run 'docker logs qa-gateway-container' and 'docker logs qa-main' for details."
  exit 1
fi
```

---

## Step 6 — Wait for backend container to enter RUNNING state

Poll every 30 seconds, maximum 5 minutes (10 attempts):

```bash
PROXY_PORT=$(grep '^PROXY_PORT' "${PROJECT_PATH}/qa-fleet.conf" \
  | cut -d= -f2 | tr -d '"' || echo 3000)

MAX_ATTEMPTS=10
ATTEMPT=0
while [[ $ATTEMPT -lt $MAX_ATTEMPTS ]]; do
  ATTEMPT=$((ATTEMPT + 1))
  RUNNING=$(docker logs --tail 5 qa-main 2>&1 | grep 'backend entered RUNNING state' || true)
  if [[ -n "$RUNNING" ]]; then
    echo "Backend is RUNNING (attempt ${ATTEMPT})"
    break
  fi
  if [[ $ATTEMPT -eq $MAX_ATTEMPTS ]]; then
    echo "ERROR: Backend did not enter RUNNING state within 5 minutes."
    echo "Last 50 log lines:"
    docker logs --tail 50 qa-main 2>&1
    echo ""
    echo "Recovery options:"
    echo "  1. Check build errors: docker logs qa-main 2>&1 | grep -i error"
    echo "  2. Verify BACKEND_BUILD_CMD in ${PROJECT_PATH}/qa-fleet.conf"
    echo "  3. Re-run after fixing: /fleet:init $PROJECT_PATH $BRANCH"
    exit 1
  fi
  echo "Waiting for backend... (attempt ${ATTEMPT}/${MAX_ATTEMPTS}, next check in 30s)"
  sleep 30
done
```

---

## Step 7 — Verify health endpoint

```bash
PROXY_PORT=$(grep '^PROXY_PORT' "${PROJECT_PATH}/qa-fleet.conf" \
  | cut -d= -f2 | tr -d '"' || echo 3000)

HTTP_CODE=$(curl -s -o /tmp/health.json \
  -w '%{http_code}' \
  "http://localhost:${PROXY_PORT}/backend/actuator/health" 2>/dev/null || echo "000")

echo ""
echo "Health check: HTTP ${HTTP_CODE}"

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "WARN: Expected 200, got ${HTTP_CODE}."
  echo "Response body (if any):"
  cat /tmp/health.json 2>/dev/null || echo "(no body)"
else
  HEALTH_JSON=$(cat /tmp/health.json)
  OVERALL=$(echo "$HEALTH_JSON" | jq -r '.status // "UNKNOWN"')
  echo "Overall status: ${OVERALL}"
  echo ""
  echo "Per-component status:"
  echo "$HEALTH_JSON" | jq -r '
    .components // {} | to_entries[] |
    "  \(.key): \(.value.status)"
  ' 2>/dev/null || echo "(no component details)"

  # Flag DOWN components
  DOWN_COMPONENTS=$(echo "$HEALTH_JSON" | jq -r '
    .components // {} | to_entries[] |
    select(.value.status == "DOWN" or .value.status == "OUT_OF_SERVICE") |
    .key
  ' 2>/dev/null)

  if [[ -n "$DOWN_COMPONENTS" ]]; then
    echo ""
    echo "DOWN components detected:"
    while IFS= read -r component; do
      case "$component" in
        ldap*)   echo "  - $component: LDAP server unreachable — add -Dspring.profiles.active=local to BACKEND_RUN_CMD in qa-fleet.conf" ;;
        db|datasource|jdbc*) echo "  - $component: Database unreachable — check DB_HOST/DB_PORT and that postgres container is running" ;;
        mail*)   echo "  - $component: Mail server not reachable — expected in local dev; disable via profile if needed" ;;
        *)       echo "  - $component: Unknown failure — check docker logs qa-main for root cause" ;;
      esac
    done <<< "$DOWN_COMPONENTS"
  fi
fi
```

---

## Step 8 — Final report

Print a structured summary:

```
=== /fleet:init complete ===

Project:       $PROJECT_PATH
Branch:        $BRANCH
conf applied:  ${PROJECT_PATH}/qa-fleet.conf

Container status:
<output of: docker ps --filter name=qa-main --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'>

Health: HTTP <code>
<full JSON body from /tmp/health.json>
```

If any component is DOWN: append the per-component hint from Step 7 and note: "The application is running but some components are unhealthy — see hints above. No source code changes are needed; adjust qa-fleet.conf or environment only."

---

## Hard rules

- Only write `qa-fleet.conf` in `$PROJECT_PATH`. Do not touch any other file.
- Do NOT push to git.
- Do NOT modify `.claude/`, `.beads/`, or any source code file.
- Do NOT modify `test/reference/` — it is a pristine fixture.
- If `pom.xml`, `package.json`, and `application*.yml` are all absent, print: "Stack not auto-detectable — please set BACKEND_BUILD_CMD and BACKEND_RUN_CMD manually in qa-fleet.conf." and exit cleanly.
- If the tmux session is already running and appears stuck, kill it first: `tmux kill-session -t fleetinit 2>/dev/null || true`.

---

## Reference: d2r2 (test/project) expected values

When running against `test/project` (Spring Boot backend `d2r2-backend`, Next.js frontend `d2r2-frontend`):

```
PROJECT_NAME="test"
FRONTEND_DIR="d2r2-frontend"
FRONTEND_OUT_DIR="out"
BACKEND_DIR="d2r2-backend"
BACKEND_BUILD_CMD="mvn package -DskipTests -Pjooq-codegen -q"
BACKEND_RUN_CMD="java -Dspring.profiles.active=local -jar /home/developer/backend.jar"
BACKEND_PORT="8081"
PROXY_PORT="3000"
```

Expected outcome: `/backend/actuator/health` returns HTTP 200 with `status: UP`. The LDAP component is absent (local profile disables it). All other components show UP.

---
name: fleet:init
description: End-to-end fleet init for a project. Detects services, writes .fleet/fleet.toml, runs `fleet init` to bootstrap infra, optionally spins up a feature container via `fleet add`, then verifies health. Targets the current TOML-based fleet CLI.
user-invocable: true
argument-hint: "[feature-name]"
---

Run the full fleet init flow end-to-end against the current fleet CLI (TOML schema):

1. Detect services in the project.
2. Write `.fleet/fleet.toml` (the source of truth fleet reads).
3. Run `fleet init` via tmux (bootstraps gateway + base images).
4. Optionally run `fleet add <feature-name>` to spin up a feature container using the current branch.
5. Verify gateway status and (if `fleet add` ran) backend health via the proxy.

**Optional argument** (`$ARGUMENTS`): a feature name for `fleet add`. If omitted, the skill only runs `fleet init` (infra only) and stops at the gateway-up check.

## Prerequisites

- Docker running
- `fleet` on PATH (install via fleet's host installer if missing)
- `tmux` (`brew install tmux` on macOS)
- `jq` (for JSON health parsing)
- Python 3 (fleet's TOML loader uses `tomllib`/`tomli`)

---

## Step 0 — Resolve project path and feature name

```
PROJECT_PATH = $(pwd)
FEATURE_NAME = first token of $ARGUMENTS   (optional; enables fleet add)
BRANCH       = $(git -C "$PROJECT_PATH" rev-parse --abbrev-ref HEAD)
```

**Validation:**
- If `$PROJECT_PATH` has no `pom.xml`, `package.json`, `build.gradle*`, or `go.mod` in any first-level subdirectory → print `Error: no recognizable service directories. Ensure subdirs contain pom.xml, build.gradle(.kts), package.json, or go.mod.` and stop.
- If `fleet` not on PATH → print recovery hint (`/usr/local/bin/fleet` symlink created by fleet's own `fleet init`, which needs `scripts/fleet-init.sh` once) and stop.

---

## Step 1 — Read evidence files (no guessing)

Skip missing files silently. Record what you find.

**1a. Enumerate service candidates**

```bash
ls -d "$PROJECT_PATH"/*/ 2>/dev/null
```

Ignore: `node_modules/`, `target/`, `dist/`, `out/`, `build/`, `.fleet/`, `.git/`, `.worktrees/`, `.beads/`, directories starting with `.`.

For each surviving directory `D`, infer the **stack** (matches fleet's `infer_stack`):

| Marker | Stack |
|---|---|
| `D/next.config.{js,mjs,ts}` | `next` |
| `D/vite.config.{js,ts,mjs}` | `vite` |
| `D/pom.xml` | `spring` |
| `D/build.gradle` or `D/build.gradle.kts` | `gradle` |
| `D/go.mod` | `go` |
| `D/package.json` (no framework marker above) | `node` |

Skip directories whose stack is `unknown`.

**1b. Read existing `.fleet/fleet.toml`** (if present)

If exists, record current `[project].name`, `[project].root`, `[ports].proxy/admin/db`, and each `[[services]]` entry. Preserve non-default user edits.

**1c. Read `README.md`** — note any build/run directives explicitly documented.

**1d. For each Spring/Gradle service, read `src/main/resources/application*.yml`/`*.properties`**:
- List profiles (from `-<profile>` filename suffix).
- For each profile file, flag whether it **disables an intranet-only indicator** (LDAP, Kerberos, internal hostname) OR **hardcodes a localhost datasource**.

**1e. For each Maven service, read `pom.xml`**:
- Extract `<profile><id>X</id></profile>` blocks.
- Identify plugins that need a profile to activate: jOOQ codegen, Flyway, OpenAPI generator.
- Note the profile ID that activates each.

**1f. For each Gradle service, read `build.gradle.kts`/`build.gradle`**:
- Spot whether jOOQ codegen is wired to compile (e.g., `generateSchemaSourceOnCompilation = true`) — if yes, plain `bootJar`/`build` triggers codegen automatically.

**1g. For each Node-ish service, read `package.json`**:
- Record `scripts.build` and `scripts.start`/`scripts.dev`.

**1h. Note `.env*` files** at repo root and service dirs — fleet discovers these itself via `.fleet/shared.env`, no action needed here.

---

## Step 2 — Decide the TOML values

Derive each field using the defaults below, overridden by evidence from Step 1. Skill defaults MUST match `cli/cmd-init.sh::detect_services` so the generated file is what `fleet init` would produce interactively.

### Project-level

**`[project].name`**
- If existing `.fleet/fleet.toml` has a non-blank name → keep it.
- Else: `basename "$PROJECT_PATH"` lowercased, non-alnum → `-`.

**`[project].root`**: absolute `$PROJECT_PATH`.

**`[ports].proxy`**: existing value, else `3000`.
**`[ports].admin`**: existing value, else `4000`.
**`[ports].db`**: existing value, else `5432`.

If `lsof -iTCP:<port> -sTCP:LISTEN -nP` shows a port in use on the host, ask via `AskUserQuestion` for an alternative.

### Per-service entries

Emit one `[[services]]` table per detected service from Step 1a.

| field | Source |
|---|---|
| `name` | directory basename |
| `dir` | directory basename (relative to `[project].root`) |
| `stack` | inferred in Step 1a |
| `port` | stack default below (override if existing conf has a different value) |
| `build` | stack default below, with tuning (see below) |
| `run` | stack default below, with tuning (see below) |

**Stack defaults** (copy fleet CLI verbatim):

| stack | port | build | run |
|---|---|---|---|
| spring | 8081 | `mvn package -DskipTests -q` | `java -jar /home/developer/backend.jar` |
| gradle | 8081 | `gradle build -x test` | `java -jar /home/developer/backend.jar` |
| go | 8080 | `go build -o server .` | `/app/<dir>/server` |
| node | 3000 | `npm run build` | `node dist/index.js` |
| next | 3000 | `npm run build` | `npm run dev` |
| vite | 5173 | `npm run build` | `npm run dev` |

**Build-command tuning (Maven/Spring):**
- If `pom.xml` declares a jOOQ codegen plugin AND a profile activates it → append `-P<profile-id>` to `mvn package ...`.
- Flyway / OpenAPI generator gated by a profile → same treatment.

**Build-command tuning (Gradle):**
- If `build.gradle.kts` runs jOOQ codegen via `generateSchemaSourceOnCompilation = true` → use `./gradlew bootJar -x test -q`. No profile flag needed.
- If the project uses `gradlew` (wrapper) → prefer `./gradlew ...` over plain `gradle`.
- If no wrapper → stick with `gradle build -x test`.

**Run-command tuning (Spring/Gradle):**
- Only add `-Dspring.profiles.active=<profile>` if **exactly one** `application-<profile>.yml` disables intranet-only indicators **and does NOT hardcode a localhost datasource** (localhost inside a container points at the container itself, not host).
- If no profile qualifies → leave `java -jar /home/developer/backend.jar` as-is. Fleet injects `SPRING_DATASOURCE_*` env vars from its postgres sidecar via the container entrypoint; the base `application.yml` should read them.
- If multiple profiles qualify → use `AskUserQuestion` to pick one.

**Port tuning:**
- Keep stack default unless an `application*.yml` sets `server.port` to something else.

---

## Step 3 — Show TOML diff and confirm

Render the proposed `.fleet/fleet.toml` as a full file (or unified diff if the file already exists):

```
--- .fleet/fleet.toml (current)
+++ .fleet/fleet.toml (proposed)
@@ ...
```

Use `AskUserQuestion`: "Apply this .fleet/fleet.toml and proceed with fleet init?"

If the user declines → print "Aborted — no changes made." and stop.

---

## Step 4 — Write .fleet/fleet.toml

Write via the Write tool (not `heredoc`/`cat`). Create `.fleet/` first if it doesn't exist.

```toml
# .fleet/fleet.toml — generated by /fleet:init on <YYYY-MM-DD>

[project]
name = "<name>"
root = "<absolute path>"

[ports]
proxy = <proxy>
admin = <admin>
db    = <db>

[[stacks]]
type       = "<stack>"
dockerfile = ".fleet/Dockerfile.feature-base.<stack>"
# (one [[stacks]] block per unique stack across services)

[[services]]
name  = "<name>"
dir   = "<dir>"
stack = "<stack>"
port  = <port>
build = "<build>"
run   = "<run>"
# (one [[services]] block per detected service)
```

Rules:
- Emit **one `[[stacks]]` table per unique stack** used by any service (preserve insertion order).
- **DO NOT** reference any old `fleet.conf` — delete it if present (prompt user first).
- The write must be **idempotent**: running twice produces byte-identical output.

---

## Step 5 — Run `fleet init` via tmux

`fleet init` takes **no arguments** in the current CLI. It must run with `$PROJECT_PATH` as cwd. Because `.fleet/fleet.toml` now exists, the interactive wizard is bypassed — but the `check_hot_reload` helper may still prompt (spring: add `spring-boot-devtools` to pom.xml? / go: generate `.air.toml`?). **Always answer `n`** — the skill never mutates project source.

```bash
tmux kill-session -t fleetinit 2>/dev/null || true
rm -f /tmp/fleet-init.log

tmux new-session -d -s fleetinit \
  "cd '$PROJECT_PATH' && fleet init 2>&1 | tee /tmp/fleet-init.log; echo '[fleet-init-done]' >> /tmp/fleet-init.log"

# Pre-answer any hot-reload prompts (no-op if none appear)
sleep 3
tmux send-keys -t fleetinit "n" Enter
sleep 2
tmux send-keys -t fleetinit "n" Enter

# Tail for progress
tail -f /tmp/fleet-init.log &
TAIL_PID=$!
```

**Wait up to 8 minutes** (building base Docker images can be slow on first run):

```bash
INIT_TIMEOUT=480
ELAPSED=0
while ! grep -q '\[fleet-init-done\]' /tmp/fleet-init.log 2>/dev/null; do
  sleep 5; ELAPSED=$((ELAPSED + 5))
  if [[ $ELAPSED -ge $INIT_TIMEOUT ]]; then
    kill $TAIL_PID 2>/dev/null
    echo "ERROR: fleet init timed out after ${INIT_TIMEOUT}s. Last 40 lines:"
    tail -40 /tmp/fleet-init.log
    echo ""
    echo "Recovery: docker logs fleet-gateway; inspect /tmp/fleet-init.log; re-run /fleet:init"
    exit 1
  fi
done
kill $TAIL_PID 2>/dev/null || true
```

Surface any `ERROR`/`failed` lines before the done marker:

```bash
if grep -qiE '(^\[fleet-init\] ERROR|error:|failed|FAILED)' /tmp/fleet-init.log; then
  echo "fleet init reported errors:"
  grep -iE '(error|failed)' /tmp/fleet-init.log | tail -20
  echo ""
  echo "Full log: /tmp/fleet-init.log"
  exit 1
fi
```

Success banner from `fleet init` looks like: `Fleet ready │ Dashboard → http://localhost:4000`.

---

## Step 6 — Verify gateway is up

```bash
ADMIN_PORT=$(python3 -c "
import sys
try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib
with open('${PROJECT_PATH}/.fleet/fleet.toml','rb') as f:
    d = tomllib.load(f)
print(d.get('ports',{}).get('admin',4000))
")

for i in 1 2 3 4 5; do
  if curl -sf "http://localhost:${ADMIN_PORT}/_fleet/api/status" >/dev/null; then
    echo "Gateway OK on admin port ${ADMIN_PORT} (attempt ${i})"
    break
  fi
  sleep 2
  if [[ $i -eq 5 ]]; then
    echo "ERROR: Gateway not reachable at localhost:${ADMIN_PORT}"
    echo "docker ps --filter name=fleet-gateway:"
    docker ps --filter name=fleet-gateway --format 'table {{.Names}}\t{{.Status}}'
    echo "Last 40 lines of gateway logs:"
    docker logs --tail 40 fleet-gateway 2>&1
    exit 1
  fi
done
```

**If `$FEATURE_NAME` was not supplied → stop here.** Print the final report (Step 9) noting that `fleet init` only bootstraps infra; running `fleet add <name>` is required to spin up a feature container.

---

## Step 7 — (Optional) Spin up a feature container via `fleet add`

Only run when `$FEATURE_NAME` is non-empty. Sanitize: `FEATURE_NAME=$(echo "$FEATURE_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')`.

```bash
tmux kill-session -t fleetadd 2>/dev/null || true
rm -f /tmp/fleet-add.log

tmux new-session -d -s fleetadd \
  "cd '$PROJECT_PATH' && fleet add '$FEATURE_NAME' 2>&1 | tee /tmp/fleet-add.log; echo '[fleet-add-done]' >> /tmp/fleet-add.log"

# Wait up to 10 minutes (first-time service builds are slow)
ADD_TIMEOUT=600
ELAPSED=0
while ! grep -q '\[fleet-add-done\]' /tmp/fleet-add.log 2>/dev/null; do
  sleep 10; ELAPSED=$((ELAPSED + 10))
  if [[ $ELAPSED -ge $ADD_TIMEOUT ]]; then
    echo "ERROR: fleet add timed out after ${ADD_TIMEOUT}s."
    tail -40 /tmp/fleet-add.log
    exit 1
  fi
done

if grep -qiE '(^\[fleet\] ERROR|error:|failed|FAILED)' /tmp/fleet-add.log; then
  echo "fleet add reported errors:"
  grep -iE '(error|failed)' /tmp/fleet-add.log | tail -20
  exit 1
fi
```

---

## Step 8 — Backend health check (only after Step 7)

Iterate over every `[[services]]` whose `stack ∈ {spring, gradle}`. For each such service named `<svc>`, hit the proxy at `/<svc>/actuator/health`:

```bash
PROXY_PORT=$(python3 -c "
import sys
try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib
with open('${PROJECT_PATH}/.fleet/fleet.toml','rb') as f:
    d = tomllib.load(f)
print(d.get('ports',{}).get('proxy',3000))
")

for svc in $SPRING_SERVICE_NAMES; do
  echo ""
  echo "── Health: ${svc} ──"
  HTTP_CODE=$(curl -s -o /tmp/health-${svc}.json \
    -w '%{http_code}' \
    "http://localhost:${PROXY_PORT}/${svc}/actuator/health" 2>/dev/null || echo "000")
  echo "HTTP ${HTTP_CODE}"

  if [[ "$HTTP_CODE" == "200" ]]; then
    OVERALL=$(jq -r '.status // "UNKNOWN"' /tmp/health-${svc}.json 2>/dev/null)
    echo "Overall: ${OVERALL}"
    jq -r '.components // {} | to_entries[] | "  \(.key): \(.value.status)"' \
      /tmp/health-${svc}.json 2>/dev/null

    # Flag DOWN components with targeted hints
    DOWN=$(jq -r '.components // {} | to_entries[] | select(.value.status == "DOWN" or .value.status == "OUT_OF_SERVICE") | .key' /tmp/health-${svc}.json 2>/dev/null)
    if [[ -n "$DOWN" ]]; then
      echo "DOWN components:"
      while IFS= read -r c; do
        case "$c" in
          ldap*)               echo "  - $c: LDAP unreachable — enable a local profile or set LDAP_DISABLED=true via shared.env";;
          db|datasource|jdbc*) echo "  - $c: DB unreachable — check DB port/creds in .fleet/fleet.toml and that fleet-db sidecar is running";;
          mail*)               echo "  - $c: Mail unreachable — typically expected in dev";;
          *)                   echo "  - $c: failure — docker logs fleet-${FEATURE_NAME}-${svc} for details";;
        esac
      done <<< "$DOWN"
    fi
  else
    echo "Non-200. Body:"
    cat /tmp/health-${svc}.json 2>/dev/null
  fi
done
```

---

## Step 9 — Final report

```
=== /fleet:init complete ===

Project:        $PROJECT_PATH
Branch:         $BRANCH
Feature name:   ${FEATURE_NAME:-<none supplied; ran `fleet init` only>}
Config:         ${PROJECT_PATH}/.fleet/fleet.toml
Services:       <comma-separated names>

Infra:
  Gateway      → http://localhost:<admin-port>
  Proxy        → http://localhost:<proxy-port>
  Network      → fleet-net

Containers:
<output of: docker ps --filter name=fleet- --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'>

Health (if Step 7 ran):
<per-service summary from Step 8>
```

If any component is DOWN, append the per-component hint from Step 8 and note: "Services are running but some components are unhealthy — adjust `.fleet/fleet.toml` run-command, shared.env, or profile selection. Do not modify project source."

If `fleet init` only (no `$ARGUMENTS`), append:
> Next: run `/fleet:init <feature-name>` (or `fleet add <feature-name>` directly) to spin up a feature container using the current branch.

---

## Hard rules

- Only write `.fleet/fleet.toml`. Do NOT edit `.claude/`, `.beads/`, any source file, any `pom.xml`, `build.gradle*`, or `application*.yml`.
- If a `fleet.conf` exists at the repo root (from the legacy skill), ASK via `AskUserQuestion` whether to delete it. Do not delete silently.
- Do NOT push to git.
- Do NOT answer the `check_hot_reload` prompts with `y` — always `n` (preserves source).
- If `fleet init` fails with `No services detected` → print the debug list (directory → stack inference) and stop.
- If the tmux session appears stuck, kill and restart: `tmux kill-session -t fleetinit 2>/dev/null || true`.

---

## Reference values — d2r2 (test/project)

Multi-service project: `d2r2-backend` (Spring) + `d2r2-frontend` (Next.js).

```toml
[project]
name = "d2r2"
root = "/path/to/test/project"

[ports]
proxy = 3000
admin = 4000
db    = 5432

[[stacks]]
type       = "spring"
dockerfile = ".fleet/Dockerfile.feature-base.spring"

[[stacks]]
type       = "next"
dockerfile = ".fleet/Dockerfile.feature-base.next"

[[services]]
name  = "backend"
dir   = "d2r2-backend"
stack = "spring"
port  = 8081
build = "mvn package -DskipTests -Pjooq-codegen -q"
run   = "java -jar /home/developer/backend.jar"

[[services]]
name  = "frontend"
dir   = "d2r2-frontend"
stack = "next"
port  = 3000
build = "npm run build"
run   = "npm run dev"
```

Expected outcome: after `fleet init`, gateway at `http://localhost:4000` returns `{"ok":true}` for `/_fleet/api/status`. After `fleet add <feature>`, `http://localhost:3000/backend/actuator/health` → HTTP 200 `{"status":"UP"}`.

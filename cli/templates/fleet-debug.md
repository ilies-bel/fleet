---
name: fleet-debug
description: Spin up the current branch's fleet container, diagnose startup failures, patch .fleet/Dockerfile.feature-base, and retry — up to 2 times.
user-invocable: true
---

Diagnose and repair the fleet container for the current git branch. Patch `.fleet/Dockerfile.feature-base` if a fixable issue is found, rebuild the project base image, and retry `fleet add` — up to 2 times.

## Hard constraints — read first

- Only edit `.fleet/Dockerfile.feature-base` in the PROJECT directory (the directory where you run this command). Never touch fleet's own templates.
- Do NOT edit `fleet.toml`, `entrypoint.sh`, `supervisord.conf`, or any source code file.
- Do NOT push to git.
- Port conflicts and application-level errors are out of scope — diagnose clearly and stop; do not patch.
- If `.fleet/Dockerfile.feature-base` does not exist, print:
  ```
  Run fleet init first to generate .fleet/Dockerfile.feature-base
  ```
  and stop.

---

## Phase 1 — Spin up

**Step 1.1 — Pre-flight checks**

1. Verify `.fleet/Dockerfile.feature-base` exists. If it does not, print the message above and stop.

2. Read `.fleet/fleet.toml` and extract:
   - `project.name` → `PROJECT_NAME`
   - `ports.proxy` → `PROXY_PORT`

3. Get the current branch:
   ```bash
   BRANCH=$(git branch --show-current)
   ```
   If `BRANCH` is empty (detached HEAD), print "Cannot determine current branch — not on a named branch." and stop.

**Step 1.2 — Run fleet add**

Run `fleet add "$BRANCH"` and capture all output (stdout + stderr combined):

```bash
fleet add "$BRANCH" 2>&1
```

Record the full output — you will need it for diagnosis if startup fails.

**Step 1.3 — Wait for RUNNING state (up to 60 seconds)**

Poll every 5 seconds. For each poll:

```bash
docker ps --filter "name=fleet-${BRANCH}" --format '{{.Names}}\t{{.Status}}'
```

A container has reached RUNNING state when its Status begins with `Up` and has been up for at least a few seconds (not `Up Less than a second`). If one or more `fleet-${BRANCH}-*` containers satisfy this condition, proceed to Phase 4.

If after 60 seconds no container is in RUNNING state, proceed to Phase 2.

---

## Phase 2 — Diagnose

**Step 2.1 — Collect logs**

For each container matching `fleet-${BRANCH}-*` (use `docker ps -a --filter "name=fleet-${BRANCH}"`):

```bash
docker logs <container_name> 2>&1 | tail -50
```

Also check if any container exited immediately:

```bash
docker ps -a --filter "name=fleet-${BRANCH}" --format '{{.Names}}\t{{.Status}}\t{{.ExitCode}}'
```

**Step 2.2 — Classify the error**

Match the collected logs against these patterns (check in order):

| Pattern | Classification | Patchable? |
|---------|---------------|-----------|
| `E: Unable to locate package` or `package not found` (during apt-get) | Missing apt package | YES |
| `command not found: mvn` or `mvn: not found` | Missing Maven | YES |
| `command not found: gradle` or `gradle: not found` | Missing Gradle | YES |
| `command not found: node` or `node: not found` | Missing Node.js | YES |
| `command not found: java` or `java: not found` | Missing Java | YES |
| `exec format error` | Wrong architecture or bad ENTRYPOINT binary | NO |
| `address already in use` or `bind: address already in use` | Port conflict on host | NO |
| `Permission denied` on a script path | Entrypoint not executable | YES |
| `OCI runtime exec failed` or `no such file or directory` on entrypoint | Entrypoint script missing or not executable | YES |

If the error matches a patchable classification, proceed to Phase 3.

If the error does NOT match any patchable classification, or matches a non-patchable one:

Print a clear diagnosis block:
```
DIAGNOSIS
---------
Error type:   <classification or "Unknown">
Evidence:     <the exact log line(s) that triggered the classification>
Root cause:   <brief human-readable explanation>
Recommended:  <what the user should do manually>

This error is out of scope for /fleet-debug. No Dockerfile changes made.
```

Then stop.

---

## Phase 3 — Patch and retry (max 2 retries)

Maintain a retry counter starting at 0. Repeat the following loop while `retry_count < 2`:

### 3.A — Determine fleet root

Resolve the fleet install root:

```bash
FLEET_ROOT=$(dirname "$(dirname "$(readlink -f "$(which fleet)")")")
```

### 3.B — Patch `.fleet/Dockerfile.feature-base`

Read the current contents of `.fleet/Dockerfile.feature-base`.

Apply exactly one of these patches based on the current error classification:

**Missing apt package** (`E: Unable to locate package <pkg>`):
- Extract the package name from the error message.
- Find the `apt-get install` line in `.fleet/Dockerfile.feature-base`.
- Append the missing package name to that line.
- Example: `apt-get install -y curl git` → `apt-get install -y curl git <pkg>`

**Missing Maven** (`mvn: not found`):
- Add the following block immediately after the existing `apt-get install` RUN layer:
  ```dockerfile
  RUN apt-get update && apt-get install -y maven
  ```

**Missing Gradle** (`gradle: not found`):
- Add the following block immediately after the existing `apt-get install` RUN layer:
  ```dockerfile
  RUN apt-get update && apt-get install -y gradle
  ```

**Missing Node.js** (`node: not found`):
- Add the following block immediately after the existing `apt-get install` RUN layer:
  ```dockerfile
  RUN apt-get update && apt-get install -y nodejs npm
  ```

**Missing Java** (`java: not found`):
- Add the following block immediately after the existing `apt-get install` RUN layer:
  ```dockerfile
  RUN apt-get update && apt-get install -y default-jdk
  ```

**Permission denied on entrypoint** or **OCI runtime exec failed**:
- Identify the entrypoint path from the error log (e.g. `/app/entrypoint.sh`).
- Add the following line immediately before the `ENTRYPOINT` instruction in `.fleet/Dockerfile.feature-base`:
  ```dockerfile
  RUN chmod +x <entrypoint-path>
  ```

Print the diff of the change you are about to apply and describe it in one sentence.

### 3.C — Rebuild the project base image

```bash
docker build --load \
  -t "fleet-feature-base-${PROJECT_NAME}" \
  -f ".fleet/Dockerfile.feature-base" \
  "${FLEET_ROOT}"
```

If the build fails, print the last 20 lines of build output, explain what the build error means, and stop — do not retry.

### 3.D — Remove failed containers

```bash
fleet rm "$BRANCH" 2>/dev/null || true
```

### 3.E — Retry fleet add

```bash
fleet add "$BRANCH" 2>&1
```

### 3.F — Wait 60 seconds for RUNNING state

Poll every 5 seconds (same logic as Phase 1, Step 1.3).

- If RUNNING → proceed to Phase 4.
- If still failing after 60 seconds:
  - Return to Phase 2, Step 2.1 to collect fresh logs.
  - Classify the (possibly new) error.
  - If patchable and `retry_count < 2`: increment retry counter, go back to Step 3.B.
  - If non-patchable, or `retry_count` has reached 2: print the final diagnosis block below and stop.

**Final diagnosis block (after 2 failed retries):**

```
FINAL DIAGNOSIS
---------------
Retries attempted: 2
Last error:        <error classification>
Evidence:          <exact log line(s)>
Patches applied:
  Retry 1: <one-line description of patch>
  Retry 2: <one-line description of patch>
Recommended fix:   <what the user should do manually>

/fleet-debug has exhausted its retry budget. Please inspect
.fleet/Dockerfile.feature-base and fix the remaining issue manually.
```

---

## Phase 4 — Success report

Print the following:

```
SUCCESS
-------
Branch:     <branch>
Containers:
<output of: docker ps --filter "name=fleet-${BRANCH}" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'>

Access URL: http://localhost:<PROXY_PORT>

Patches applied: <"No patches needed — container started on first attempt"
                  OR a numbered list of each Dockerfile change made>
```

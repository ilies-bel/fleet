---
name: configure-fleet-startup
description: Auto-tune fleet.conf BACKEND_BUILD_CMD and BACKEND_RUN_CMD for the detected stack, then restart the feature container on main and verify the health endpoint.
user-invocable: true
---

Auto-tune `fleet.conf` for this project, restart the `fleet-main` container, and verify `/actuator/health`.

## Step 1 — Read evidence (no guessing)

Read each of the following in order. Do not skip any that exist.

1. `README.md` and any files under `docs/` — note any explicit "build with `mvn -P...`" or "run with `--spring.profiles.active=...`" instructions the project documents itself.
2. `fleet.conf` — record current values for `BACKEND_DIR`, `FRONTEND_DIR`, `BACKEND_BUILD_CMD`, `BACKEND_RUN_CMD`, `PROJECT_NAME`, `PROXY_PORT`.
3. `${BACKEND_DIR}/pom.xml` (if it exists):
   - Extract every `<profile><id>X</id></profile>` block.
   - Identify any plugins that imply codegen needing a profile activation: jOOQ codegen plugin (`org.jooq:jooq-codegen-maven`), Flyway, or similar. Note which profile activates them.
   - Note any plugin `<dependencies>` with `<scope>provided</scope>` — these may conflict with devtools injection.
4. `${BACKEND_DIR}/build.gradle` or `${BACKEND_DIR}/build.gradle.kts` (if no pom.xml): extract Spring profile references and source sets.
5. `${BACKEND_DIR}/src/main/resources/application*.yml` and `application*.properties` — list every profile name found (the `-<profile>` suffix in the filename). For each profile-specific file, read it and note whether it disables anything intranet-only: LDAP, Kerberos, internal hostnames, custom `HealthIndicator` beans that contact intranet services.
6. `${FRONTEND_DIR}/package.json` — read `scripts.build` and `scripts.start`.
7. Acknowledge any `.env` files discovered at root, `${BACKEND_DIR}/`, or `${FRONTEND_DIR}/`. Do not parse their contents — fleet's entrypoint already mounts them.

## Step 2 — Decide the diff

Based on what you read in Step 1, construct proposed values for:

**`BACKEND_BUILD_CMD`**
- Start from the current value in `fleet.conf`.
- If `pom.xml` contains the jOOQ codegen plugin AND a profile named `jooq-codegen` (or similar) that activates it, append `-P<profile-name>` to the Maven command.
- If the plugin exists but no matching profile is found, print a warning: "jOOQ codegen plugin found but no activating profile detected — leaving BACKEND_BUILD_CMD unchanged." and do not modify it.
- If it is a Gradle project, apply the equivalent `--profile` logic if documented.

**`BACKEND_RUN_CMD`**
- Start from the current value in `fleet.conf`.
- Scan the profile-specific `application-<profile>.yml` files you read in Step 1.
- If exactly **one** profile file exists AND it disables an intranet-only health indicator (LDAP connectivity check, Kerberos auth, custom beans calling internal hostnames), add `-Dspring.profiles.active=<profile>` to the java command.
- If **multiple** candidate profiles exist (each disabling intranet checks), use AskUserQuestion to ask which profile to activate.
- If no profile file qualifies, leave `BACKEND_RUN_CMD` unchanged.

**`PROJECT_NAME`**
- If currently blank or missing, derive it from `package.json` `.name` field, or fall back to `basename` of the project root directory.

## Step 3 — Show diff and confirm

Print a unified diff (before → after) of the relevant lines in `fleet.conf`.

Use AskUserQuestion: "Apply the above changes to fleet.conf? [y/N]"

If the user declines, print "No changes made." and stop here.

## Step 4 — Apply and verify

Once the user confirms:

1. Write the updated `fleet.conf` in place. Only change the keys identified in Step 2; leave all other lines untouched. The edit must be idempotent (running the command twice produces the same file).

2. From the fleet repo root, restart the main feature container:

   ```bash
   cd /Users/ib472e5l/project/perso/fleet/qa-fleet
   ./fleet rm main 2>&1 | tail -3
   ./fleet add main main 2>&1 | tail -10
   ```

3. Wait for the backend to start (max 4 minutes). Poll every 30 seconds:

   ```bash
   docker logs --tail 5 fleet-main 2>&1 | grep 'backend entered RUNNING state'
   ```

   If the backend does not enter RUNNING state within 4 minutes, print the last 20 lines of `docker logs qa-main` and stop — do not retry.

4. Once RUNNING, run the health check:

   ```bash
   PROXY_PORT=$(grep '^PROXY_PORT' fleet.conf | cut -d= -f2 | tr -d '"' || echo 3000)
   curl -s -o /dev/null -w '%{http_code}\n' http://localhost:${PROXY_PORT}/backend/actuator/health
   curl -s http://localhost:${PROXY_PORT}/backend/actuator/health
   ```

## Step 5 — Report

Print a structured report containing:

- The exact diff that was applied to `fleet.conf` (or "No changes applied" if declined).
- Container status: output of `docker ps --filter name=fleet-main --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'`.
- Health endpoint HTTP status code.
- Full `/actuator/health` JSON body so the user can see per-component UP/DOWN.
- If any component shows `DOWN` or `OUT_OF_SERVICE`: briefly explain what it likely means (unreachable intranet hostname, missing external service, misconfigured datasource). Do **not** attempt to fix it — it is application-level and out of scope for this command.

## Hard constraints

- Only edit `fleet.conf` in the project root. Touch nothing else.
- Do NOT push to git. Do NOT modify `.claude/`, `.beads/`, or any source code file.
- If `pom.xml`, `package.json`, and `application*.yml` are all missing, print "Stack not auto-detectable — please set BACKEND_BUILD_CMD and BACKEND_RUN_CMD manually in fleet.conf." and exit cleanly.

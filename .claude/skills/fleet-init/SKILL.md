---
name: fleet-init
description: Infer the stack type of a Fleet service directory (spring / gradle / go / node / next / vite) and render a Dockerfile.feature-base for it by substituting discovered language/runtime versions into the matching `cli/stacks/Dockerfile.<type>` template. Invoke once per service during `fleet init` to populate `.fleet/Dockerfile.feature-base.<stack>`. Pure inference — does not run Docker, does not write files, does not mutate fleet.toml.
---

# fleet-init

Per-service stack inference + Dockerfile generation for the Fleet CLI. The caller (`cli/cmd-init.sh`) invokes this skill once for each service dir declared in `.fleet/fleet.toml`; the skill reads a few manifest files in the dir and returns a machine-parseable block containing the stack type and the final Dockerfile content.

## Contract

### Input
- Absolute path to a service directory (e.g. `/Users/x/projects/d2r2/d2r2-backend`).

### Output (stdout, exact format)
```
STACK_TYPE=<type>
DOCKERFILE_BEGIN
<full rendered Dockerfile content>
DOCKERFILE_END
```

The caller parses this by splitting on the `DOCKERFILE_BEGIN` / `DOCKERFILE_END` sentinels. Do not emit extra logging above or below these markers.

## Detection rules (first match wins)

Probe the service dir **in this priority order** and stop at the first match:

| # | File probe                               | Stack type |
|---|------------------------------------------|------------|
| 1 | `next.config.js` / `next.config.mjs` / `next.config.ts` present | `next`   |
| 2 | `vite.config.js` / `vite.config.ts` / `vite.config.mjs` present | `vite`   |
| 3 | `pom.xml` present                        | `spring`   |
| 4 | `build.gradle` / `build.gradle.kts` present | `gradle`|
| 5 | `go.mod` present                         | `go`       |
| 6 | `package.json` present (no next/vite markers above) | `node` |

**Rationale for ordering:** framework-specific probes (next, vite, spring) are more informative than base-runtime probes (node, gradle). A Next.js project has `package.json` too, but the `next.config.*` file is the deciding signal.

If none of the probes match: emit `STACK_TYPE=unknown` and an empty Dockerfile block. Caller decides how to recover (prompt user, skip service, etc.).

## Version inference

Determine each version from the service's own manifest. Fall back to the listed default if unreadable.

| Variable            | Source                                            | Default |
|---------------------|---------------------------------------------------|---------|
| `JAVA_VERSION`      | `<java.version>` or `<maven.compiler.target>` in `pom.xml`; `sourceCompatibility` in `build.gradle*` | `21`    |
| `GO_VERSION`        | `go X.Y` line at top of `go.mod` (use `X.Y`, not `X.Y.Z`) | `1.22`  |
| `NODE_VERSION`      | `engines.node` in `package.json` — parse semver major (`"^20.10.0"` → `20`); else the first major in `.nvmrc` if present | `20`    |
| `POSTGRES_VERSION`  | not inferrable from service source                | `16`    |

All four are always defined (using defaults when the manifest is silent) so that `envsubst` succeeds for any template.

## Template source

Templates live at `cli/stacks/Dockerfile.<type>` relative to `FLEET_ROOT`. Known templates:

- `Dockerfile.spring` (Ubuntu 24.04 + JDK + Postgres + Node + nginx + supervisord)
- `Dockerfile.gradle` (same shape as spring; caller may reuse spring template if gradle-specific one is absent)
- `Dockerfile.go`     (golang + Air hot-reload + Postgres client + supervisord)
- `Dockerfile.node`   (node-slim + nodemon)
- `Dockerfile.next`   (node-slim + Next.js dev server)
- `Dockerfile.vite`   (node-slim + Vite dev server)

Rendering step: read the file, substitute `${JAVA_VERSION}`, `${NODE_VERSION}`, `${GO_VERSION}`, `${POSTGRES_VERSION}` with the inferred values. Prefer `envsubst` semantics (`${VAR}` only, no shell execution). Leave any other `${…}` untouched — the container entrypoint handles those.

## Non-goals

- **Do not** run `docker build`, `docker inspect`, or any Docker command.
- **Do not** write files to disk. The caller owns file placement (`.fleet/Dockerfile.feature-base.<stack>`).
- **Do not** mutate `.fleet/fleet.toml` or `cli/stacks/*`. The template source stays canonical.
- **Do not** prompt interactively. Emit `STACK_TYPE=unknown` and let the caller handle it.
- **Do not** combine multiple services into a multi-stage Dockerfile. One service → one Dockerfile.

## Examples

### Spring Boot backend (`d2r2-backend`)

Input dir contains:
```
pom.xml                       (→ <java.version>17</java.version>)
src/main/java/...
```

Probes: (1) no next.config, (2) no vite.config, (3) **pom.xml hit** → `spring`.
Version: `JAVA_VERSION=17`, others default.
Template: `cli/stacks/Dockerfile.spring` with `${JAVA_VERSION}` → `17`.

Output:
```
STACK_TYPE=spring
DOCKERFILE_BEGIN
FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg git \
    openjdk-17-jdk \
    postgresql-16 \
    nginx \
    supervisor \
 && rm -rf /var/lib/apt/lists/*
...
DOCKERFILE_END
```

### Next.js frontend (`d2r2-frontend`)

Input dir contains:
```
next.config.mjs
package.json                  (→ "engines": { "node": ">=20.10" })
```

Probes: (1) **next.config.mjs hit** → `next`.
Version: `NODE_VERSION=20`.
Template: `cli/stacks/Dockerfile.next` with `${NODE_VERSION}` → `20`.

### Go backend (`svc-ingest`)

Input dir contains:
```
go.mod                        (→ go 1.23)
main.go
```

Probes: (1) no next, (2) no vite, (3) no pom, (4) no build.gradle, (5) **go.mod hit** → `go`.
Version: `GO_VERSION=1.23`.
Template: `cli/stacks/Dockerfile.go` with `${GO_VERSION}` → `1.23`.

## Error contract

If anything goes wrong (unreadable manifest, template missing, malformed semver), emit:

```
STACK_TYPE=error
DOCKERFILE_BEGIN
# fleet-init error: <short reason>
DOCKERFILE_END
```

The caller treats `error` the same as `unknown` — surfaces the comment text to the user and aborts or prompts.

## Invocation note

This skill is designed to be called once per service. Running it N times for N services produces N independent Dockerfiles; the caller deduplicates them by `STACK_TYPE` before writing (so a project with two `next` services writes `.fleet/Dockerfile.feature-base.next` once, not twice).

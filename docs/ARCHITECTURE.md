# Fleet — Architecture

## Overview

Fleet is a Docker-based orchestration system for running multiple feature branches of your application (e.g. a Next.js frontend + Spring Boot backend + PostgreSQL) simultaneously on localhost.

The core design enables a **transparent proxy pattern**: the browser always connects to `localhost:3000`, but the gateway dynamically routes that traffic to whichever feature container is currently active — no browser reconfiguration needed when switching features.

---

## System Diagram

```
Developer Browser
      │
      ├── localhost:4000  ──────────────────────── Admin Dashboard (React SPA)
      │         │                                  Feature management API
      │         │                                  OAuth relay
      │         │
      └── localhost:3000  ──── Gateway Proxy ─────► fleet-<active>:80 (internal)
                                                          │
                                                    supervisord (PID 1)
                                                          │
                                    ┌─────────────────────┼─────────────────────┐
                                    │                     │                     │
                              nginx:80          Spring Boot:8081        PostgreSQL:5432
                          (path fan-out)            REST API                (if configured)
                           /backend → :8081
                           /          → frontend
                                          │
                                    Next.js static
                                    export (SPA fallback)
                                    
                                    peers: wiremock:8080, static-http:9090, etc.
```

All feature containers run exclusively on the internal `fleet-net` Docker network — they are never exposed on host ports. Each container is a self-contained unit with supervisord managing all processes (services and optional peers).

---

## Feature Container Topology (Mono-Container Model)

Each feature runs as a **single container** named `fleet-${NAME}` where `${NAME}` matches the feature name passed to `fleet add`. The container is a complete, isolated runtime:

- **Container name**: `fleet-${NAME}` (no per-service suffix)
- **Valid feature names**: Must match `^[a-z0-9]([a-z0-9-]*(\.[a-z0-9-]+)*)?$`
  - Valid: `login-fix`, `auth-v2`, `feat.auth`, `auth.v2-beta`
  - Invalid: `MyFeature` (uppercase), `auth fix` (space), `auth_fix` (underscore), `auth.` (trailing dot)
- **PID 1**: supervisord (not a shell or user app)
- **Network**: Only reachable from gateway and sibling containers on `fleet-net`
- **Port exposure**: None to host; gateway proxies `http://fleet-${NAME}:80`

### Internal Process Layout

Inside the container, supervisord manages multiple **programs** with priority ordering:

1. **Database** (if configured) — PostgreSQL:5432, priority 10
2. **Services** (from `[[services]]` in fleet.toml) — each as a supervisord program, priority 20+
   - Name: sanitized service name (e.g. `backend`, `frontend`)
   - Port: per service config
3. **Peers** (from `[[peers]]` in fleet.toml) — optional stubs, priority 30+
   - **wiremock**: WireMock jar running in standalone mode, mappings mounted from host
   - **static-http**: Minimal Go/Node HTTP server, serves test fixtures
   - **shell**: Arbitrary command (e.g. Node.js stub server, bash script)
4. **nginx** (priority 40) — internal reverse proxy listening on :80
   - Routes `/backend/` → service backend port
   - Routes `/` → frontend service (or static export if Next.js)
   - Peers are addressable at `localhost:${peer_port}` within the container

All internal communication (services to peers, peer to peer) uses `localhost` — they share the container network namespace.

### Peer Types

Peers are optional stub services co-located in the feature container, defined in `fleet.toml` under `[[peers]]`. They are **not exposed to the gateway** — internal traffic only. Three types:

| Type | Purpose | Configuration |
|------|---------|---------------|
| **wiremock** | Mock HTTP endpoints with stateful request/response mappings (WireMock jar) | `mappings` (path to mappings dir), `files` (path to __files dir), `port` (container-internal) |
| **static-http** | Minimal static HTTP server for test fixtures | `port` only |
| **shell** | Arbitrary shell command (e.g. Node.js stub server, bash script) | `cmd` (command to run), `port` (must match what cmd listens on) |

Example (from `fleet.toml`):

```toml
[[peers]]
name     = "wiremock-edf"
type     = "wiremock"
port     = 8080
mappings = "wiremock-edf/mappings"
files    = "wiremock-edf/__files"

[[peers]]
name = "mock-api"
type = "static-http"
port = 9090

[[peers]]
name = "custom-stub"
type = "shell"
port = 7070
cmd  = "node /app/custom-stub/server.js"
```

Peers are useful for:
- Decoupling service tests from external APIs (mock third-party services)
- Testing error paths and edge cases (stateful request matching)
- Isolating feature-branch behavior (each feature gets its own peer instances)

### nginx Path Fanout

The nginx configuration inside the container handles path-based routing:

```
:80 (external entry from gateway)
  /backend/   → localhost:${backend_port} (Spring Boot, Go, etc.)
  /           → localhost:${frontend_port} or /var/www/html (Next.js static export)
```

This allows a single port (80) exposed to the gateway while isolating internal service ports. Services and peers access each other via `localhost:${peer_port}`.

---

## Component Map

```
fleet/
├── gateway/            Node.js Express — dual-port server (proxy + API)
│   └── src/
│       ├── index.js    Entry point — reconcile + start both servers
│       ├── api.js      Feature management REST API (port 4000)
│       ├── auth.js     Feature registration + OAuth relay
│       ├── proxy.js    Transparent HTTP proxy (port 3000)
│       ├── docker.js   Docker Engine socket client (zero npm deps)
│       ├── registry.js In-memory feature registry
│       └── reconcile.js Startup recovery from Docker state
│
├── dashboard/          React 19 + Vite — compiled into gateway/public/
│   └── src/
│       ├── App.jsx     Root + routing
│       ├── api.js      Fetch wrapper for gateway API
│       └── components/ StatusBar, FeatureList, FeatureCard, AddFeatureModal,
│                       PreviewFrame, LogPanel, ResourceMonitor
│
├── config/             Feature container runtime
│   ├── entrypoint.sh   7-stage startup (build + init + supervisord)
│   ├── nginx.conf      Serves frontend, proxies /backend/ to Spring Boot
│   ├── supervisord.conf Manages postgresql + backend + nginx
│   └── wait-for-pg.sh  PostgreSQL readiness probe
│
├── Dockerfile.feature-base  Reusable base image for all feature containers
│
└── scripts/            Bash CLI
    ├── fleet-init.sh   One-time setup (network, images, gateway, first feature)
    ├── fleet-add.sh    Spin up a new feature (worktree + compose + register)
    └── fleet-teardown.sh  Remove features or entire system
```

---

## Gateway — Internal Modules

### `index.js` — Entry Point

Starts two completely independent Express servers:

- **Port 3000** — minimal middleware stack (only the proxy), no CORS, no body parsing
- **Port 4000** — full admin stack with CORS, JSON parsing, static files, all API routes

On startup, calls `reconcileFromDocker()` to restore any feature containers that were running before the gateway was restarted.

### `docker.js` — Docker Engine Client

Communicates with the Docker daemon over `/var/run/docker.sock` using Node's built-in `http` module — **no npm dependencies**. Key primitives:

| Function | What it does |
|----------|-------------|
| `dockerRequest(method, path, body?)` | Raw HTTP over Unix socket |
| `dockerExec(containerId, cmd[])` | Run command in container, stream stdout |
| `listRunningContainers()` | Filter by `fleet-` name prefix |
| `inspectContainer(name)` | Full container JSON |
| `stopContainer / startContainer / removeContainer` | Lifecycle |
| `getContainerStats(name)` | One-shot stats (CPU%, memory, network I/O) |
| `dockerLogs(name, opts)` | Demultiplexed log fetch |

Error classes: `DockerSocketError` (connection failed), `DockerContainerError` (container-level errors, carries HTTP status).

**Why zero deps?** The gateway runs inside Docker and pulling npm packages just to do HTTP over a socket would add unnecessary weight and attack surface.

### `registry.js` — In-Memory Feature Registry

A `Map<name, FeatureRecord>` kept in process memory. Survives container restarts via `reconcile.js`.

```js
FeatureRecord {
  name: string,          // validated: ^[a-z0-9]([a-z0-9-]*(\.[a-z0-9-]+)*)?$
  branch: string,
  worktreePath: string|null,
  addedAt: Date
}
```

`activeFeature` is a separate string (name of the currently active feature). First registered feature is auto-activated.

### `reconcile.js` — Startup Recovery

On gateway start, scans Docker for all `fleet-*` named containers (running or stopped), starts any that are stopped, and re-registers them by reading `BRANCH` from container env and `worktreePath` from volume mounts. This makes the gateway stateless — it can be restarted without losing track of features.

### `proxy.js` — Transparent Proxy

Uses `http-proxy-middleware`. Routes all port-3000 traffic to `http://fleet-<activeFeature>:80` (single container per feature, nginx inside).

- Removes `etag` / `last-modified` headers to prevent cross-feature cache pollution
- Sets `X-Fleet-Feature` request header
- Returns `503` when no feature is active
- Returns `502` when the active container is unreachable

### `auth.js` — Registration + OAuth Relay

**Registration** (`POST /register-feature`, `DELETE /register-feature/:name`): Called by `qa-add.sh` and `qa-teardown.sh` shell scripts.

**OAuth relay** (`GET /auth/callback`): Decodes the base64 `state` parameter, extracts the `feature` key, activates that feature container, then redirects the browser to `http://localhost:3000/auth/callback`. This allows a single OAuth callback URL to serve all features. The transparent proxy then routes the callback to the now-active `fleet-${feature}:80`.

```
OAuth Provider → localhost:4000/auth/callback?code=...&state=<b64>
                    │ decode state → { feature: "login-fix" }
                    │ activate "login-fix" container
                    └── redirect → localhost:3000/auth/callback?code=...&state=<b64>
                                       │ proxied to fleet-login-fix:80
                                       │ (nginx routes /auth/callback based on config)
```

---

## Feature Container — Runtime

### Base Image (`Dockerfile.feature-base`)

Built once, reused for all features. Layers:

1. Ubuntu 24.04 + system packages (curl, git, OpenJDK 21, PostgreSQL 16, nginx, supervisor)
2. Node 20 via NodeSource
3. Claude Code CLI (global npm install)
4. Non-root user `developer` (uid 1001)
5. Maven 3.9.6
6. App directories + config files

### Container Startup (`entrypoint.sh`) — Multi-Stage Build

Runs once on first container start. A sentinel file at `/tmp/.fleet-built` prevents re-running on restart. Stages are driven by `FLEET_SERVICES_JSON` and `FLEET_PEERS_JSON` read from `.fleet/fleet.toml`:

1. **Seed phase**: Populate `node_modules` from read-only volume mount (avoids full `npm install`)
2. **Platform binary patching**: Fetch Linux arm64 variants of esbuild, swc, lightningcss, etc. (for Next.js builds)
3. **Build services**: For each service in `FLEET_SERVICES_JSON`:
   - Run the service's `build` command (e.g. `npm run build`, `mvn package`)
4. **Patch bundle URLs**: Replace `__FLEET_BACKEND_URL__` → `/backend`, `__FLEET_APP_URL__` → `localhost:3000` (for SPA config)
5. **Initialize database** (if configured): PostgreSQL `initdb`, create database/user from fleet.toml
6. **supervisord** (`supervisord -n`): PID 1, launch all programs (services, peers, database, nginx)

### Process Management (supervisord)

Processes are defined in `supervisord.conf` generated from `FLEET_SERVICES_JSON` and `FLEET_PEERS_JSON`. Explicit priority ordering ensures safe startup:

| Priority | Type | Examples |
|----------|------|----------|
| 10 | Database | `postgresql:5432` (if `ports.db` is set and `DB_NAME` is configured) |
| 20 | Services | `backend:8081`, `frontend:3000`, etc. |
| 30 | Peers | `wiremock-edf:8080`, `mock-api:9090`, `custom-stub:7070` |
| 40 | nginx | `nginx:80` (depends on all above) |

Each service and peer becomes a supervisord program with its own log stream. `wait-for-pg.sh` ensures PostgreSQL accepts connections before dependent services start.

### nginx Routing (internal path fan-out)

The nginx configuration generated from `FLEET_SERVICES_JSON` handles path-based routing on `:80`:

```
:80 (incoming from gateway)
  /backend/  →  localhost:${backend_port} (e.g. Spring Boot :8081)
  /          →  localhost:${frontend_port} or /var/www/html (Next.js static)
```

All routing happens internally — services and peers communicate via `localhost`. nginx is the single external interface the gateway proxies to.

---

## Dashboard — React SPA

Built with Vite, output to `gateway/public/`. Served statically by the gateway on port 4000.

### Component Tree

```
App.jsx
├── StatusBar          — gateway status, feature count, live clock
├── /features route
│   ├── FeatureList    — sidebar with feature cards + [+ADD] button
│   │   └── FeatureCard (×N) — health indicator, ACTIVATE / STOP / LOGS / KILL buttons
│   ├── AddFeatureModal — name + branch inputs, validation
│   ├── PreviewFrame   — iframe of localhost:3000 with refresh
│   └── LogPanel       — multi-source log viewer (backend / nginx / postgresql / supervisord / all)
└── /monitor route
    └── ResourceMonitor — table: CPU bar, memory used/limit, network ↓/↑
```

### API Client (`api.js`)

Thin fetch wrapper. All endpoints prefixed with `/_fleet/api/`. Returns parsed JSON or throws on non-2xx.

### Design Tokens (`index.css`)

Dark cyberpunk theme. Key variables:

| Token | Value |
|-------|-------|
| `--color-bg` | `#0a0a0a` |
| `--color-accent` | `#00ff88` |
| `--color-danger` | `#ff4444` |
| `--color-warning` | `#ffaa00` |
| Font | JetBrains Mono |

---

## Bash CLI — Setup Scripts

### `fleet-init.sh` (idempotent)

```
fleet-init.sh <app-root> <branch>
```

1. Validate the configured frontend and backend directories (`FRONTEND_DIR` / `BACKEND_DIR`) are present
2. Write `APP_ROOT` to `.fleet-config`
3. Scan `APP_ROOT`, `FRONTEND_DIR`, and `BACKEND_DIR` (depth-1) for untracked `.env` files; write/update the auto-discovered block in `.fleet-shared` (creates the file with a header if absent)
4. Create `fleet-net` Docker network
5. Build `fleet-gateway` image (includes compiled dashboard)
6. Build `fleet-feature-base` image
7. Start gateway container with `/var/run/docker.sock` mount
8. Poll `:4000/_fleet/api/status` until ready
9. Call `fleet-add.sh` for the initial feature

### `fleet-add.sh`

```
fleet-add.sh <name> <branch> [--direct]
```

1. Validate name (`^[a-z0-9]([a-z0-9-]*(\.[a-z0-9-]+)*)?$`) and branch existence
2. Create git worktrees for frontend and backend at `APP_ROOT/.fleet-worktrees/<name>/`
3. Parse `.fleet-shared` for extra read-only volume mounts (non-tracked files like `.env.local`)
4. Generate `docker-compose.yml` in `.fleet/<name>/`
5. `docker compose up -d`
6. Save metadata to `.fleet/<name>/info`
7. `POST /register-feature` to gateway

`--direct` skips worktrees and mounts `APP_ROOT` directly — useful for fast iteration on a single branch.

### `fleet-teardown.sh`

| Flag | Effect |
|------|--------|
| `<name>` | Deregister + `docker compose down -v` + remove worktrees + remove `.fleet/<name>` |
| `--all` | All features, keep gateway |
| `--nuke` | Features + gateway + `fleet-net` network + `.fleet-config` |

---

## Volume Strategy

Per feature, three Docker volumes:

| Volume | Mount | Purpose |
|--------|-------|---------|
| `<worktree-path>` | `/app` (rw) | Source code (live git worktree) |
| `<app-root>/<frontend>/node_modules` | `/app-nm-seed` (ro) | Seed — avoids full `npm install` |
| `fleet-<name>-nm` | `/app/<frontend>/node_modules` (rw) | Persists built node_modules across restarts |
| `fleet-<name>-target` | `/app/<backend>/target` (rw) | Persists Maven build artifacts |

The seed pattern: copy from read-only host mount into the named volume on first start, then `npm install --prefer-offline` to resolve deltas. This cuts cold-start time significantly on feature branches that share most dependencies.

---

## API Reference

All endpoints on port 4000. Prefix: `/_fleet/api/`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/features` | List features with health + active flag |
| `GET` | `/features/:name/health` | `{status: "up"\|"down"}` |
| `POST` | `/features/:name/activate` | Set active feature |
| `DELETE` | `/features/:name` | Kill container + remove volumes |
| `POST` | `/features/:name/stop` | Stop container |
| `POST` | `/features/:name/start` | Start container |
| `GET` | `/features/:name/stats` | CPU%, memory MB, network MB |
| `GET` | `/features/:name/logs` | Log lines (`?source=backend\|nginx\|postgresql\|supervisord\|all&tail=200`) |
| `GET` | `/status` | Gateway uptime, feature count, active feature |

Internal (called by scripts):

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/register-feature` | Register a new feature |
| `DELETE` | `/register-feature/:name` | Deregister a feature |
| `GET` | `/auth/callback` | OAuth relay (activate + redirect) |

### Response shapes

Success: `{ ok: true, ...data }`
Error: `{ error: "message" }` with appropriate HTTP status (404, 409, 502, 503)

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Mono-container per feature** (`fleet-${NAME}`) | Simpler orchestration than multi-container compose; supervisord manages all processes (services, peers, database, nginx); no cross-container network latency |
| Single base image for all features | Avoids rebuilding OS layer, JDK, Maven per feature; all features share base layers |
| Git worktrees instead of clones | Shares `.git` object store — fast, no disk duplication; features don't shadow each other's git history |
| In-memory registry + reconcile | No database dependency; Docker is source of truth; lightweight stateless gateway |
| Zero-dep Docker client | Reduces gateway image size and attack surface; uses only Node.js built-in http module |
| supervisord as PID 1 | Handles process supervision, signal propagation, log multiplexing; clean shutdown on container stop |
| Internal nginx path fan-out | Single port (80) exposed to gateway; services/peers communicate via localhost; decouples internal port assignment from external topology |
| Peer stubs (wiremock, static-http, shell) | Mock external services without external dependencies; each feature gets isolated peer instances |
| Node_modules seed volume | Avoids full `npm install` per feature; shares base dependencies across branches |
| Static Next.js export | No Node.js runtime in production path; nginx serves directly, reduces resource usage |

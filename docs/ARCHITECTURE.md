# QA Fleet — Architecture

## Overview

QA Fleet is a Docker-based orchestration system for running multiple feature branches of your application (e.g. a Next.js frontend + Spring Boot backend + PostgreSQL) simultaneously on localhost.

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
      └── localhost:3000  ──── Gateway Proxy ─────► qa-<active>:3000 (internal)
                                                          │
                                          ┌───────────────┼───────────────┐
                                          │               │               │
                                       nginx:3000   Spring Boot:8081  PostgreSQL:5432
                                          │               │
                                   Next.js static    REST API
                                    export (SSG)
```

All feature containers run exclusively on the internal `qa-net` Docker network — they are never exposed on host ports.

---

## Component Map

```
qa-fleet/
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
    ├── qa-init.sh      One-time setup (network, images, gateway, first feature)
    ├── qa-add.sh       Spin up a new feature (worktree + compose + register)
    ├── qa-teardown.sh  Remove features or entire system
    └── qa-host-runner.sh AppleScript relay for iTerm2 (macOS, port 4001)
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
| `listRunningContainers()` | Filter by `qa-` name prefix |
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
  name: string,          // validated: ^[a-z0-9-]+$
  branch: string,
  worktreePath: string|null,
  addedAt: Date
}
```

`activeFeature` is a separate string (name of the currently active feature). First registered feature is auto-activated.

### `reconcile.js` — Startup Recovery

On gateway start, scans Docker for all `qa-*` named containers (running or stopped), starts any that are stopped, and re-registers them by reading `BRANCH` from container env and `worktreePath` from volume mounts. This makes the gateway stateless — it can be restarted without losing track of features.

### `proxy.js` — Transparent Proxy

Uses `http-proxy-middleware`. Routes all port-3000 traffic to `http://qa-<activeFeature>:3000`.

- Removes `etag` / `last-modified` headers to prevent cross-feature cache pollution
- Sets `X-QA-Feature` request header
- Returns `503` when no feature is active
- Returns `502` when the active container is unreachable

### `auth.js` — Registration + OAuth Relay

**Registration** (`POST /register-feature`, `DELETE /register-feature/:name`): Called by `qa-add.sh` and `qa-teardown.sh` shell scripts.

**OAuth relay** (`GET /auth/callback`): Decodes the base64 `state` parameter, extracts the `feature` key, activates that feature, then redirects the browser to `http://localhost:3000/auth/callback`. This allows a single OAuth callback URL to serve all features.

```
OAuth Provider → localhost:4000/auth/callback?code=...&state=<b64>
                    │ decode state → { feature: "login-fix" }
                    │ activate "login-fix"
                    └── redirect → localhost:3000/auth/callback?code=...&state=<b64>
                                       │ proxied to qa-login-fix:3000
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

### Container Startup (`entrypoint.sh`) — 7 Stages

Runs once on first container start. A sentinel file at `/tmp/.qa-built` prevents re-running on restart.

| Stage | Action |
|-------|--------|
| 1 | Seed `node_modules` from read-only volume mount (avoids full `npm install`) |
| 2 | Patch platform binaries — fetch Linux arm64 variants of esbuild, swc, lightningcss, etc. |
| 3 | `npm run build` — Next.js static export to `/var/www/html` |
| 4 | Patch bundle URLs — replace `__QA_BACKEND_URL__` → `/backend`, `__QA_APP_URL__` → `localhost:3000` |
| 5 | `mvn package -P jooq-codegen` — build Spring Boot JAR |
| 6 | PostgreSQL `initdb`, create the configured database and user (from `DB_NAME` / `DB_USER`) |
| 7 | `supervisord -n` — launch all processes (blocks, PID 1 equivalent) |

### Process Management (`supervisord.conf`)

Three programs with explicit priority ordering:

| Priority | Program | Port |
|----------|---------|------|
| 10 | `postgresql` | 5432 |
| 20 | `backend` (Spring Boot) | 8081 |
| 30 | `nginx` | 3000 |

`wait-for-pg.sh` ensures PostgreSQL accepts connections before Spring Boot starts.

### nginx Routing (`nginx.conf`)

```
:3000
  /backend/  →  localhost:8081 (Spring Boot REST API)
  /          →  /var/www/html (Next.js static export, SPA fallback)
```

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

Thin fetch wrapper. All endpoints prefixed with `/_qa/api/`. Returns parsed JSON or throws on non-2xx.

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

### `qa-init.sh` (idempotent)

```
qa-init.sh <app-root> <branch>
```

1. Validate the configured frontend and backend directories (`FRONTEND_DIR` / `BACKEND_DIR`) are present
2. Write `APP_ROOT` to `.qa-config`
3. Scan `APP_ROOT`, `FRONTEND_DIR`, and `BACKEND_DIR` (depth-1) for untracked `.env` files; write/update the auto-discovered block in `.qa-shared` (creates the file with a header if absent)
4. Create `qa-net` Docker network
5. Build `qa-gateway` image (includes compiled dashboard)
6. Build `qa-feature-base` image
7. Start gateway container with `/var/run/docker.sock` mount
8. Poll `:4000/_qa/api/status` until ready
9. Call `qa-add.sh` for the initial feature

### `qa-add.sh`

```
qa-add.sh <name> <branch> [--direct]
```

1. Validate name (`^[a-z0-9-]+$`) and branch existence
2. Create git worktrees for frontend and backend at `APP_ROOT/.qa-worktrees/<name>/`
3. Parse `.qa-shared` for extra read-only volume mounts (non-tracked files like `.env.local`)
4. Generate `docker-compose.yml` in `.qa/<name>/`
5. `docker compose up -d`
6. Save metadata to `.qa/<name>/info`
7. `POST /register-feature` to gateway

`--direct` skips worktrees and mounts `APP_ROOT` directly — useful for fast iteration on a single branch.

### `qa-teardown.sh`

| Flag | Effect |
|------|--------|
| `<name>` | Deregister + `docker compose down -v` + remove worktrees + remove `.qa/<name>` |
| `--all` | All features, keep gateway |
| `--nuke` | Features + gateway + `qa-net` network + `.qa-config` |

### `qa-host-runner.sh`

Tiny Express server (port 4001, host network) that receives `POST /open-terminal` and executes AppleScript to open an iTerm2 tab. Runs as a background process started by `qa-init.sh`. Required because the gateway runs inside Docker and cannot call AppleScript directly.

---

## Volume Strategy

Per feature, three Docker volumes:

| Volume | Mount | Purpose |
|--------|-------|---------|
| `<worktree-path>` | `/app` (rw) | Source code (live git worktree) |
| `<app-root>/<frontend>/node_modules` | `/app-nm-seed` (ro) | Seed — avoids full `npm install` |
| `qa-<name>-nm` | `/app/<frontend>/node_modules` (rw) | Persists built node_modules across restarts |
| `qa-<name>-target` | `/app/<backend>/target` (rw) | Persists Maven build artifacts |

The seed pattern: copy from read-only host mount into the named volume on first start, then `npm install --prefer-offline` to resolve deltas. This cuts cold-start time significantly on feature branches that share most dependencies.

---

## API Reference

All endpoints on port 4000. Prefix: `/_qa/api/`.

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
| `POST` | `/features/:name/open-terminal` | Open iTerm2 tab (macOS) |
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
| Single base image for all features | Avoids rebuilding OS layer, JDK, Maven per feature |
| Git worktrees instead of clones | Shares `.git` object store — fast, no disk duplication |
| In-memory registry + reconcile | No database dependency; Docker itself is the source of truth |
| Zero-dep Docker client | Reduces gateway image size and attack surface |
| Supervisor in single container | Simpler than multi-container compose per feature; fewer moving parts |
| Node_modules seed volume | Avoids re-downloading packages for every new feature branch |
| Static Next.js export | No Node.js runtime needed in production container path; nginx serves directly |
| Host runner for iTerm (port 4001) | Gateway is sandboxed in Docker; AppleScript must run on the host |

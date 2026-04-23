# Fleet

Run multiple feature-branch versions of the app simultaneously on localhost.

## How it works

The gateway runs **two ports**:

| Port | Purpose |
|------|---------|
| `3000` | Transparent proxy — forwards all traffic to the **active** feature container |
| `4000` | Admin dashboard + management API + OAuth relay |

Feature containers run on the internal Docker network (`fleet-net`) only — no host port exposure. Each feature runs as a **single container** named `fleet-<name>` with supervisord as PID 1, managing all services and peers. You point your browser at port 3000 to interact with the app, and port 4000 to manage which feature is active.

```
localhost:4000            ← dashboard & API
localhost:3000            ← transparent proxy → active feature container
                                                  ↓
                                          fleet-<name>:80 (internal)
                                          supervisord (PID 1)
                                          ├── service: backend:8081
                                          ├── service: frontend:3000
                                          ├── peer: wiremock:8080
                                          └── nginx:80 (internal path fan-out)
```

## Migration from qa-fleet

If you were using v0.1, see [MIGRATION.md](./MIGRATION.md) for a full rename reference.

## Prerequisites

- Docker (with Docker Compose v2)
- bash
- Node 20+ (only for local dashboard development)

## Install via npx

Install the `fleet` CLI and Claude Code assets into any project with a single command:

```bash
# Install Claude Code assets globally (~/.claude — available in all projects)
npx @ilies-bel/fleet install-claude --global

# Install locally (./.claude — scoped to current project only)
npx @ilies-bel/fleet install-claude --local

# Overwrite existing files
npx @ilies-bel/fleet install-claude --global --force
```

What gets installed:

| Asset | Destination |
|-------|-------------|
| `/fleet:init` slash command | `<target>/commands/fleet/init.md` |
| All 10 agent definitions | `<target>/agents/*.md` |
| All skills (react-best-practices, subagents-discipline) | `<target>/skills/` |

After installing, open Claude Code in your project and run `/fleet:init` to start the guided setup.

If neither `--global` nor `--local` is passed, the installer prompts interactively.

The `fleet` bash CLI itself is available as a bin after `npm install -g @ilies-bel/fleet` — or use `npx @ilies-bel/fleet <command>` to run without installing globally.

## The `fleet` CLI

All operations go through a single `fleet` dispatcher. `fleet init` symlinks it to `/usr/local/bin/fleet` so it is available anywhere.

```
fleet <command> [options]

Commands:
  init    <app-root> <branch>          Initialize fleet for a project
  add     <name> <branch> [--direct]   Start a QA feature container
  rm      <name>|--all|--nuke          Remove feature(s) or everything
  restart <name>                       Restart a feature container
  feature -c <name> [<branch>]         Create worktree+compose without starting
  push    <name>                       Push worktree branch(es) to remote
  sync    <name> [--regenerate-sources] Pull latest code and rebuild
  help                                 Show help

Environment:
  FLEET_GATEWAY   Gateway base URL (default: http://localhost:4000)
```

## One-time setup

```bash
fleet init <app-root-folder> <branch>
```

- `app-root-folder` — path to the project root
- `branch` — first feature branch to spin up automatically

If `fleet.conf` does not exist in the project root, init walks you through an interactive wizard that **auto-detects your stack** (Spring Boot, Go, Next.js, Vite, Node) and writes the file for you. Otherwise it reads the existing config.

Example:
```bash
fleet init /path/to/my-project feature/my-branch
```

`init` will:
1. Create/load `fleet.conf` in the project root
2. Save `APP_ROOT` to `.fleet-config`
3. Create the `fleet-net` Docker network
4. Build the `fleet-gateway` image (includes the dashboard)
5. Copy the matching stack `Dockerfile.*` from `cli/stacks/` to `FLEET_ROOT/Dockerfile.feature-base` and build it
6. Symlink `fleet` into `/usr/local/bin`
7. Start the gateway on ports 3000 and 4000
8. Spin up the first feature container from the given branch

Safe to run again — idempotent. Interactive prompts default to `n` when no tty is attached.

### Supported stacks

Dockerfiles live in `cli/stacks/` and are selected automatically during init:

- `Dockerfile.spring` — Spring Boot
- `Dockerfile.go` — Go
- `Dockerfile.next` — Next.js
- `Dockerfile.vite` — Vite
- `Dockerfile.node` — generic Node

## Adding a feature

```bash
fleet add <name> <branch> [--direct]
```

- `name` — lowercase alphanumerics, dots, hyphens only (e.g. `login-fix`, `auth-v2`, `feat.auth-v2`). Must match `^[a-z0-9]([a-z0-9-]*(\.[a-z0-9-]+)*)?$`
- `branch` — git branch name (checked against the frontend repository)
- `--direct` — skip the worktree and build directly from `APP_ROOT`

Example:
```bash
fleet add login-fix feature/auth-fix
```

This will:
1. Verify the branch exists (local or remote)
2. Create a git worktree under `<app-root>/.fleet-worktrees/<name>` (unless `--direct`)
3. Start a single `fleet-<name>` container running supervisord with all configured services and peers
4. Register it with the gateway (auto-activated if it is the first feature)

Follow build progress with:
```bash
docker logs -f fleet-<name>
```

Once up, activate it from the dashboard or API, then visit http://localhost:3000.

## Other feature commands

```bash
fleet feature -c <name> [<branch>]      # Scaffold worktree + compose, don't start
fleet restart <name>                    # Restart container
fleet sync <name>                       # Pull latest code and rebuild
fleet sync <name> --regenerate-sources  # Re-run source generation (e.g. OpenAPI)
fleet push <name>                       # Push the worktree branch(es) to remote
```

## Dashboard

Open **http://localhost:4000** to:
- See all registered feature containers and their health status
- Activate a feature (switches port 3000 to proxy it)
- Preview a feature in the embedded iframe
- Kill a feature container
- Open an iTerm2 terminal into a running container (macOS only)

## Activating a feature

Only one feature is active on port 3000 at a time. Activate via:

**Dashboard** — click `[ACTIVATE]` on the feature card.

**API**:
```bash
curl -X POST http://localhost:4000/_fleet/api/features/login-fix/activate
```

The first feature registered is activated automatically.

## Removing features

```bash
fleet rm <name>       # remove one feature
fleet rm --all        # remove all features, keep gateway running
fleet rm --nuke       # remove everything: features, gateway, network, config
```

## Configuration (`fleet.toml`)

Generated by the `fleet init` wizard, or copy `.fleet/fleet.toml.example` manually. The TOML schema defines your project, services, and optional peer stubs.

### Project Metadata

```toml
[project]
name = "my-app"
root = "/path/to/project"

[ports]
proxy = 3000         # gateway transparent proxy
admin = 4000         # gateway admin API
db    = 5432         # host-mapped postgres port (optional; 0 = disabled)
```

### Services

Each `[[services]]` entry is a deployable unit (frontend, backend, etc.) running in supervisord:

```toml
[[services]]
name  = "backend"
dir   = "backend"
stack = "spring"     # or: go, next, vite, node
port  = 8081
build = "mvn package -DskipTests -q"
run   = "java -jar /home/developer/backend.jar"

[[services]]
name  = "frontend"
dir   = "frontend"
stack = "next"
port  = 3000
build = "npm run build"
run   = "npm run dev"
```

### Peers (Optional Stubs)

Peers are co-located stub services (wiremock, static servers, custom processes) running on `localhost` inside the feature container — not exposed externally:

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

**Peer types:**
- `wiremock` — Mock HTTP endpoints with stateful request/response mappings
- `static-http` — Minimal static HTTP server for test fixtures
- `shell` — Arbitrary shell command (e.g. Node.js stub server)

Multi-repo projects (frontend and backend in separate git roots) are detected automatically — `fleet add` creates a worktree per repo.

## OAuth setup

Register a **single** OAuth callback URL with your provider:

```
http://localhost:4000/auth/callback
```

In your app, encode the `state` parameter to include the feature name:

```js
const state = btoa(JSON.stringify({ feature: "login-fix", returnTo: "/" }));
```

The gateway decodes `state`, activates the matching feature on port 3000, then redirects the browser to `http://localhost:3000/auth/callback` — which forwards to the now-active container.

## API reference

All management endpoints are on port 4000.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/_fleet/api/features` | List all registered features (includes `status` for not-yet-started containers) |
| `GET` | `/_fleet/api/features/:name/health` | Health check for a container (`up`/`down`) |
| `POST` | `/_fleet/api/features/:name/activate` | Set the active feature on port 3000 |
| `GET` | `/_fleet/api/status` | Gateway uptime, active feature, feature count |
| `POST` | `/register-feature` | Register a feature (called by `fleet add`) |
| `DELETE` | `/register-feature/:name` | Deregister a feature (called by `fleet rm`) |
| `GET` | `/auth/callback` | OAuth relay endpoint |

## Claude Code commands

The `.claude/commands/fleet/` directory contains slash commands for Claude Code that automate common fleet workflows. These commands are self-contained: a fresh Claude session can execute them cold without additional setup.

### Available commands

| Command | Description |
|---------|-------------|
| `/fleet:init <project-path> [branch]` | End-to-end fleet init — auto-tunes `fleet.conf`, runs `fleet init` non-interactively, waits for the container, verifies `/actuator/health`. Use this instead of running `fleet init` manually. |

### Install (make commands globally available)

```bash
# Symlink the fleet command namespace into your global Claude commands directory
ln -s "$(pwd)/.claude/commands/fleet" ~/.claude/commands/fleet
```

After symlinking, `/fleet:init` is available in any Claude Code session, regardless of which directory you open Claude from. Pass the project path as an argument:

```
/fleet:init /path/to/my-project feature/my-branch
```

### Use without installing (repo-local)

Open Claude Code from the fleet repo root — commands in `.claude/commands/` are automatically available as slash commands in that session:

```bash
cd /path/to/fleet
claude   # opens Claude Code
# then: /fleet:init ../my-project main
```

## Local dashboard development

```bash
cd dashboard
npm install
npm run dev
```

Vite proxies `/_fleet/` to the gateway at localhost:4000, so you get hot-reload against live data.

## Testing fleet init

`test/project/` is a ready-to-use copy of `test/reference/` (Spring Boot backend + Next.js frontend).

```bash
fleet init test/project main
```

Re-copy to reset: `cp -rp test/reference test/project`.

## Troubleshooting

**Gateway not starting**
```bash
docker logs fleet-gateway-container
```

**Container unreachable (502)**

Port 3000 returns 502 when the active feature container is not responding. Check its build/startup logs:
```bash
docker logs -f fleet-<name>
```
The container builds the app internally — it may still be compiling.

**No active feature (503)**

Port 3000 returns 503 when no feature is active. Open the dashboard at http://localhost:4000 and click `[ACTIVATE]` on a feature.

**Name validation error**

Feature names must match `^[a-z0-9]([a-z0-9-]*(\.[a-z0-9-]+)*)?$`.
Valid: `my-feature`, `auth-fix-v2`
Invalid: `MyFeature`, `auth fix`, `auth_fix`

**Branch not found**

`fleet add` checks the branch exists in the frontend repository before starting the container. Fetch remote branches first:
```bash
git -C <app-root>/<FRONTEND_DIR> fetch origin
```

**OAuth state error**

The `state` param must be base64-encoded JSON containing a `feature` key that matches a registered feature name:
```js
btoa(JSON.stringify({ feature: "login-fix" }))
```

**`.fleet-config` not found**

Every command except `init` reads `APP_ROOT` from `.fleet-config` at the fleet root. Run `fleet init` first to create it.

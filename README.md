# QA Fleet

Run multiple feature-branch versions of the app simultaneously on localhost.

## How it works

The gateway runs **two ports**:

| Port | Purpose |
|------|---------|
| `3000` | Transparent proxy — forwards all traffic to the **active** feature container |
| `4000` | Admin dashboard + management API + OAuth relay |

Feature containers run on the internal Docker network (`qa-net`) only — no host port exposure. You point your browser at port 3000 to interact with the app, and port 4000 to manage which feature is active.

```
localhost:4000            ← dashboard & API
localhost:3000            ← transparent proxy → active feature container
                                                  ↓
                                          qa-<name>:3000 (internal)
```

## Prerequisites

- Docker (with Docker Compose v2)
- bash
- Node 20+ (only for local dashboard development)

## The `fleet` CLI

All operations go through a single `fleet` dispatcher. `fleet init` symlinks it to `/usr/local/bin/fleet` so it is available anywhere.

```
fleet <command> [options]

Commands:
  init    [branch]                     Initialize fleet for a project (run from project root)
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
cd /path/to/my-project
fleet init [branch]
```

- `branch` — first feature branch to spin up (optional — auto-detected from `main`/`master` if omitted)

Run from your project root. If `qa-fleet.conf` does not exist, init walks you through an interactive wizard that **auto-detects your stack** (Spring Boot, Go, Next.js, Vite, Node) and writes the file for you. Otherwise it reads the existing config. After the first container is up, init prompts for additional branches to add.

Example:
```bash
cd /path/to/my-project && fleet init feature/my-branch
```

`init` will:
1. Create/load `qa-fleet.conf` in the project root
2. Save `APP_ROOT` to `.qa-config`
3. Create the `qa-net` Docker network
4. Build the `qa-gateway` image (includes the dashboard)
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

- `name` — lowercase letters, numbers, hyphens only (e.g. `login-fix`, `auth-v2`)
- `branch` — git branch name (checked against the frontend repository)
- `--direct` — skip the worktree and build directly from `APP_ROOT`

Example:
```bash
fleet add login-fix feature/auth-fix
```

This will:
1. Verify the branch exists (local or remote)
2. Create a git worktree under `<app-root>/.qa-worktrees/<name>` (unless `--direct`)
3. Start a `qa-<name>` container that builds internally from the worktree
4. Register it with the gateway (auto-activated if it is the first feature)

Follow build progress with:
```bash
docker logs -f qa-<name>
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
curl -X POST http://localhost:4000/_qa/api/features/login-fix/activate
```

The first feature registered is activated automatically.

## Removing features

```bash
fleet rm <name>       # remove one feature
fleet rm --all        # remove all features, keep gateway running
fleet rm --nuke       # remove everything: features, gateway, network, config
```

## Configuration (`qa-fleet.conf`)

Generated by the `fleet init` wizard, or copy `qa-fleet.conf.example` manually. Key fields:

| Field | Purpose |
|-------|---------|
| `PROJECT_NAME` | Display name in the dashboard (defaults to `APP_ROOT` basename) |
| `FRONTEND_DIR` | Frontend folder relative to project root (required) |
| `FRONTEND_OUT_DIR` | Build output dir — `out` (Next) or `dist` (Vite) |
| `BACKEND_DIR` | Backend folder (leave blank for frontend-only) |
| `BACKEND_BUILD_CMD` | e.g. `mvn package -DskipTests -q`, `go build -o server ./cmd/server` |
| `BACKEND_RUN_CMD` | e.g. `java -jar /home/developer/backend.jar` |
| `BACKEND_PORT` | Backend listen port inside the container |
| `DB_NAME` / `DB_USER` / `DB_PASSWORD` | Postgres credentials (leave blank to skip DB) |
| `JWT_SECRET` / `JWT_ISSUER` | Injected into backend runtime env |

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
| `GET` | `/_qa/api/features` | List all registered features (includes `status` for not-yet-started containers) |
| `GET` | `/_qa/api/features/:name/health` | Health check for a container (`up`/`down`) |
| `POST` | `/_qa/api/features/:name/activate` | Set the active feature on port 3000 |
| `POST` | `/_qa/api/features/:name/open-terminal` | Open iTerm2 tab into container (macOS) |
| `GET` | `/_qa/api/status` | Gateway uptime, active feature, feature count |
| `POST` | `/register-feature` | Register a feature (called by `fleet add`) |
| `DELETE` | `/register-feature/:name` | Deregister a feature (called by `fleet rm`) |
| `GET` | `/auth/callback` | OAuth relay endpoint |

## Claude Code commands

The `.claude/commands/fleet/` directory contains slash commands for Claude Code that automate common fleet workflows. These commands are self-contained: a fresh Claude session can execute them cold without additional setup.

### Available commands

| Command | Description |
|---------|-------------|
| `/fleet:init <project-path> [branch]` | End-to-end fleet init — auto-tunes `qa-fleet.conf`, runs `cd <project-path> && fleet init` non-interactively, waits for the container, verifies `/actuator/health`. Use this instead of running `fleet init` manually. |

### Install (make commands globally available)

```bash
# Symlink the fleet command namespace into your global Claude commands directory
ln -s "$(pwd)/.claude/commands/fleet" ~/.claude/commands/fleet
```

After symlinking, `/fleet:init` is available in any Claude Code session, regardless of which directory you open Claude from. Pass the project path as an argument:

```
/fleet:init /path/to/my-project feature/my-branch
```

The slash command handles the `cd` internally — you do not need to change directory first.

### Use without installing (repo-local)

Open Claude Code from the qa-fleet repo root — commands in `.claude/commands/` are automatically available as slash commands in that session:

```bash
cd /path/to/qa-fleet
claude   # opens Claude Code
# then: /fleet:init /path/to/my-project main
```

## Local dashboard development

```bash
cd dashboard
npm install
npm run dev
```

Vite proxies `/_qa/` to the gateway at localhost:4000, so you get hot-reload against live data.

## Testing fleet init

`test/project/` is a ready-to-use copy of `test/reference/` (Spring Boot backend + Next.js frontend). `scripts/qa-host-runner.sh` is a no-op stub so init proceeds past that step.

```bash
cd test/project && fleet init
```

Branch is auto-detected (`main`). Re-copy to reset: `cp -rp test/reference test/project`.

## Troubleshooting

**Gateway not starting**
```bash
docker logs qa-gateway-container
```

**Container unreachable (502)**

Port 3000 returns 502 when the active feature container is not responding. Check its build/startup logs:
```bash
docker logs -f qa-<name>
```
The container builds the app internally — it may still be compiling.

**No active feature (503)**

Port 3000 returns 503 when no feature is active. Open the dashboard at http://localhost:4000 and click `[ACTIVATE]` on a feature.

**Name validation error**

Feature names must match `^[a-z0-9-]+$`.
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

**`.qa-config` not found**

Every command except `init` reads `APP_ROOT` from `.qa-config` at the fleet root. Run `fleet init` first to create it.

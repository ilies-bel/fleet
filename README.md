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
- A `qa-fleet.conf` in your project root (copy `qa-fleet.conf.example` and fill it in)

## One-time setup

**1. Configure your project**

Copy `qa-fleet.conf.example` to your project root and fill it in:

```bash
cp qa-fleet.conf.example /path/to/my-project/qa-fleet.conf
# edit it: set FRONTEND_DIR, BACKEND_DIR, DB_NAME, etc.
```

**2. Run init**

```bash
./scripts/qa-init.sh <app-root-folder> <branch>
```

- `app-root-folder` — path to the project root (must contain `qa-fleet.conf`)
- `branch` — first feature branch to spin up automatically

Example:
```bash
./scripts/qa-init.sh /path/to/my-project feature/my-branch
```

This will:
1. Save `APP_ROOT` to `.qa-config`
2. Create the `qa-net` Docker network
3. Build the `qa-gateway` image (includes the dashboard)
4. Build the `qa-feature-base` image (reused for all features — built once)
5. Start the gateway on ports 3000 and 4000
6. Spin up the first feature container from the given branch

Safe to run again — idempotent.

## Adding a feature

```bash
./scripts/qa-add.sh <name> <branch>
```

- `name` — lowercase letters, numbers, hyphens only (e.g. `login-fix`, `auth-v2`)
- `branch` — git branch name (checked against the frontend repository)

Example:
```bash
./scripts/qa-add.sh login-fix feature/auth-fix
```

This will:
1. Verify the branch exists (local or remote)
2. Start a `qa-<name>` container that builds the app internally from the given branch
3. Register it with the gateway (auto-activated if it is the first feature)

The container builds internally — follow progress with:
```bash
docker logs -f qa-<name>
```

Once up, activate it from the dashboard or API, then visit http://localhost:3000.

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
./scripts/qa-teardown.sh <name>       # remove one feature
./scripts/qa-teardown.sh --all        # remove all features, keep gateway running
./scripts/qa-teardown.sh --nuke       # remove everything: features, gateway, network, config
```

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
| `GET` | `/_qa/api/features` | List all registered features |
| `GET` | `/_qa/api/features/:name/health` | Health check for a container (`up`/`down`) |
| `POST` | `/_qa/api/features/:name/activate` | Set the active feature on port 3000 |
| `POST` | `/_qa/api/features/:name/open-terminal` | Open iTerm2 tab into container (macOS) |
| `GET` | `/_qa/api/status` | Gateway uptime, active feature, feature count |
| `POST` | `/register-feature` | Register a feature (called by `qa-add.sh`) |
| `DELETE` | `/register-feature/:name` | Deregister a feature (called by `qa-teardown.sh`) |
| `GET` | `/auth/callback` | OAuth relay endpoint |

## Local dashboard development

```bash
cd dashboard
npm install
npm run dev
```

Vite proxies `/_qa/` to the gateway at localhost:4000, so you get hot-reload against live data.

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

`qa-add.sh` checks the branch exists in the frontend repository before starting the container. Fetch remote branches first:
```bash
git -C <app-root>/<FRONTEND_DIR> fetch origin
```

**OAuth state error**

The `state` param must be base64-encoded JSON containing a `feature` key that matches a registered feature name:
```js
btoa(JSON.stringify({ feature: "login-fix" }))
```

**`.qa-config` not found**

`qa-add.sh` and `qa-teardown.sh` read `APP_ROOT` from `.qa-config`. Run `qa-init.sh` first to create it.

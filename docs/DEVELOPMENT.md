# Fleet — Development Guide

## Local Development Setup

### Dashboard (hot-reload)

The dashboard is a React + Vite app compiled into `gateway/public/`. During development, run Vite's dev server instead — it proxies API calls to the live gateway.

```bash
cd dashboard
npm install
npm run dev        # starts at localhost:5173
```

Vite proxies `/_fleet/` to `localhost:4000`, so you get live data from the running gateway with full HMR.

Build for production (output goes to `gateway/public/`):

```bash
cd dashboard
npm run build
```

The gateway image must be rebuilt after a dashboard build:

```bash
docker build -f gateway/Dockerfile -t fleet-gateway .
```

### Gateway (without Docker)

Run the gateway directly on the host for faster iteration:

```bash
cd gateway
npm install
node src/index.js
```

Requires Docker daemon running (needs `/var/run/docker.sock`). The gateway will use whatever `fleet-net` network and containers are already running.

---

## Adding API Endpoints

All feature management endpoints live in `gateway/src/api.js`. The file exports a single Express router mounted at `/_fleet/api/` in `index.js`.

Pattern for a new endpoint:

```js
// gateway/src/api.js
router.get('/features/:name/my-endpoint', async (req, res) => {
  const { name } = req.params;
  const feature = registry.get(name);
  if (!feature) return res.status(404).json({ error: 'Feature not found' });

  try {
    const result = await someDockerOperation(name);
    res.json({ ok: true, data: result });
  } catch (err) {
    if (err instanceof DockerContainerError) {
      return res.status(err.status).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});
```

Add the corresponding client method in `dashboard/src/api.js`:

```js
export async function myEndpoint(name) {
  const r = await fetch(`/_fleet/api/features/${name}/my-endpoint`);
  if (!r.ok) throw new Error((await r.json()).error);
  return r.json();
}
```

---

## Docker Client (`docker.js`)

All Docker operations go through `gateway/src/docker.js`. It communicates with the Docker daemon via Unix socket — no npm dependencies.

### Adding a new Docker operation

```js
// docker.js
export async function getContainerEnv(nameOrId) {
  const data = await dockerRequest('GET', `/containers/${nameOrId}/json`);
  return data.Config.Env;  // string[] — "KEY=value" format
}
```

`dockerRequest` throws `DockerSocketError` if the socket is unavailable and `DockerContainerError` for 4xx/5xx responses from Docker. Both are exported for use in `api.js`.

### Running commands inside a container

```js
import { dockerExec } from './docker.js';

const output = await dockerExec('qa-login-fix', ['cat', '/etc/hostname']);
```

Uses Docker's Exec API with `Tty: true` for clean output (no multiplexed frame headers).

---

## Feature Container

### Modifying the base image

Edit `Dockerfile.feature-base`, then rebuild:

```bash
docker build -f Dockerfile.feature-base -t fleet-feature-base .
```

All existing feature containers continue using the old image. New containers (via `fleet-add.sh`) will use the updated image. Existing containers can be recreated with `fleet-teardown.sh <name>` + `fleet-add.sh <name> <branch>`.

### Modifying the entrypoint

Edit `config/entrypoint.sh`. Since it is volume-mounted into the container (via the base image `COPY`), you need to rebuild the base image for changes to take effect.

During development, you can manually copy into a running container to test:

```bash
docker cp config/entrypoint.sh fleet-<name>:/entrypoint.sh
docker exec fleet-<name> rm /tmp/.fleet-built   # clear sentinel so it re-runs
docker restart fleet-<name>
```

### Sentinel file

`/tmp/.fleet-built` prevents the 7-stage build from running again on restart. To force a full rebuild of a running container:

```bash
docker exec fleet-<name> rm /tmp/.fleet-built
docker restart fleet-<name>
```

### URL patching

The frontend build embeds backend URLs. `entrypoint.sh` replaces placeholder strings after the Next.js build:

| Placeholder | Replaced with |
|-------------|---------------|
| `__FLEET_BACKEND_URL__` | `/backend` |
| `__FLEET_APP_URL__` | `localhost:3000` |

Set these in your Next.js config as `process.env.NEXT_PUBLIC_BACKEND_URL ?? '__FLEET_BACKEND_URL__'` so they work both in fleet and in production.

---

## Registry & Reconciliation

### Feature registry

`gateway/src/registry.js` exposes:

```js
registry.register(name, { branch, worktreePath })
registry.get(name)         // → FeatureRecord | undefined
registry.getAll()          // → FeatureRecord[]
registry.remove(name)
registry.setActive(name)
registry.getActive()       // → string | null
```

### Adding persistent state

The registry is in-memory only. `reconcile.js` re-populates it from Docker on gateway start. If you add a new field to `FeatureRecord`, you must also extract it in `reconcile.js` (from container env vars or labels), otherwise it will be lost on gateway restart.

The recommended pattern: store extra metadata as Docker container labels when creating containers in `qa-add.sh`, then read them back in `reconcile.js`.

---

## Dashboard Components

### Adding a new component

1. Create `dashboard/src/components/MyComponent.jsx`
2. Import it in `App.jsx` or the relevant parent component
3. Add any API calls to `dashboard/src/api.js`
4. Style with CSS variables from `index.css` (dark theme tokens)

### Log streaming

`LogPanel.jsx` fetches logs on demand (not websocket). If you need real-time streaming, the `GET /features/:name/logs` endpoint supports `?since=<timestamp>` for incremental fetches — implement a polling loop in the component.

---

## Scripts

### Adding a new script

Scripts source `.fleet-config` to get `APP_ROOT`:

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../.fleet-config"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "ERROR: .fleet-config not found. Run fleet-init.sh first." >&2
  exit 1
fi

source "$CONFIG_FILE"  # exports APP_ROOT
```

---

## Troubleshooting

### Rebuild gateway image after code changes

```bash
docker build -f gateway/Dockerfile -t fleet-gateway .
docker stop fleet-gateway-container
docker rm fleet-gateway-container
# Then restart via fleet-init.sh or manually:
docker run -d \
  --name fleet-gateway-container \
  --network fleet-net \
  -p 3000:3000 \
  -p 4000:4000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  fleet-gateway
```

### Inspect registry state

```bash
curl -s http://localhost:4000/_fleet/api/features | jq .
curl -s http://localhost:4000/_fleet/api/status | jq .
```

### Watch container build logs

```bash
docker logs -f fleet-<name>
```

The container prints each entrypoint stage as it runs. First build takes several minutes (npm build + mvn package).

### Debug proxy routing

```bash
curl -v http://localhost:3000/some/path 2>&1 | grep -E 'X-Fleet|HTTP|Location'
```

The proxy sets `X-Fleet-Feature` on the forwarded request.

### Check Docker socket connectivity

```bash
docker exec fleet-gateway-container node -e "
const http = require('http');
const req = http.request({ socketPath: '/var/run/docker.sock', path: '/version' }, r => {
  let d = '';
  r.on('data', c => d += c);
  r.on('end', () => console.log(JSON.parse(d).Version));
});
req.end();
"
```

---

## File Size Limits

Per project standards: files 200–400 lines typical, 800 lines maximum. Current sizes:

| File | Lines |
|------|-------|
| `gateway/src/docker.js` | ~280 |
| `gateway/src/api.js` | ~220 |
| `config/entrypoint.sh` | ~108 |
| `scripts/fleet-add.sh` | ~166 |
| `scripts/fleet-init.sh` | ~147 |
| `scripts/fleet-teardown.sh` | ~128 |

If a file approaches 800 lines, split by concern (e.g., extract Docker stat parsing from `docker.js` into `docker-stats.js`).

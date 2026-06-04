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

### Per-project base image override

Projects that need a custom toolchain in their base image can ship their own `Dockerfile.feature-base` under `.fleet/`:

```
<project-root>/
  .fleet/
    Dockerfile.feature-base   ← project-local override
    fleet.toml
```

When `fleet init` detects `.fleet/Dockerfile.feature-base` in the project root it builds a **project-scoped image** tagged `fleet-feature-base-<project>` instead of the global `fleet-feature-base`. `fleet add` automatically uses the same project-scoped tag — no extra configuration needed.

The build context for both the global and project-local Dockerfiles is always `FLEET_ROOT` (the fleet install directory), so `COPY` instructions that reference fleet-owned config files (e.g. `entrypoint.sh`, `nginx.conf`) continue to work unchanged.

Projects without a `.fleet/Dockerfile.feature-base` continue to use the global `fleet-feature-base` image exactly as before.

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

## OpenShift Cluster Features

Fleet can run feature containers on a managed OpenShift cluster instead of local Docker,
removing the local hardware bottleneck. The cluster path is fully transparent from the
developer's perspective: `fleet add`, `fleet rm`, and the dashboard proxy work the same way
regardless of where the container runs.

### How it works

When a feature is added with `--host <cluster/namespace>`:

1. `fleet add` registers the feature with the gateway, setting `feature.host = { cluster, namespace }`.
2. The gateway creates a Pod and headless Service in the target namespace
   (`gateway/src/cluster/lifecycle.js`).
3. The gateway opens an `oc port-forward` from a local port to port 80 on the pod
   (`gateway/src/cluster/port-forward.js`).
4. The transparent proxy routes requests through the local port-forward instead of a Docker
   container port (`gateway/src/proxy.js` → `resolveTarget`).
5. On `fleet rm`, the gateway kills the port-forward, deletes the Pod and Service, and
   unregisters the feature (`gateway/src/backend.js` → `stopFeature`).

### Prerequisites

- `oc` CLI on PATH and logged in: `oc login <api-url> --token=<token>`
- The fleet gateway running locally (`fleet init` or `node gateway/src/index.js`)
- The base image bootstrapped in the target namespace (one-time — see below)

### Bootstrap (one-time per namespace)

Build the `fleet-feature-base` image inside the cluster before adding cluster features:

```bash
curl -s -X POST \
  "http://localhost:4000/_fleet/api/cluster/bootstrap?namespace=<ns>"
```

This applies an ImageStream and BuildConfig, then runs `oc start-build --from-dir=.` to
push the local `.fleet/` build context and build the image in-cluster. The build takes
several minutes the first time; subsequent calls are no-ops (idempotent check on the
ImageStreamTag).

The built image is reachable inside the cluster at:
```
image-registry.openshift-image-registry.svc:5000/<namespace>/fleet-feature-base:latest
```

### Adding a cluster feature

Pass `--host <cluster>/<namespace>` to `fleet add`:

```bash
fleet add my-feature --host ocp-prod/preview-ns
```

Both the cluster name and namespace are required. The gateway registers the feature
and spins up the Pod + port-forward automatically.

### Removing a cluster feature

```bash
fleet rm my-feature
```

Deletes the Pod and Service in the cluster namespace and tears down the port-forward.
No extra flags needed — the gateway detects whether the feature is cluster-backed from
the stored `host` field.

### Reconciliation

The gateway periodically queries `oc get pod` to reconcile each cluster feature's
status (running / stopped / failed). This is handled by `gateway/src/reconcile.js`
alongside Docker-based reconciliation.

Force immediate reconciliation for a specific feature:

```bash
curl -s -X PATCH "http://localhost:4000/_fleet/api/features/<key>/reconcile" | jq .
```

### End-to-end smoke test

`scripts/verify-cluster-smoke.js` runs the full lifecycle against a real cluster.
It requires an active `oc` session and a running local gateway.

```bash
node scripts/verify-cluster-smoke.js \
  --namespace <ns> \
  --feature-key <key>
```

Steps executed in order:

| Step | What it does |
|------|-------------|
| `cleanup-leftovers` | Idempotent cleanup of any prior run (ignoreNotFound) |
| `create-pod` | Applies a minimal nginx pod manifest via `oc apply` |
| `wait-pod-ready` | Waits for pod Ready condition (`oc wait --for=condition=Ready`) |
| `port-forward` | Opens `oc port-forward` and waits for the "Forwarding from" signal |
| `register-feature` | POSTs to `POST /register-feature` on the gateway |
| `request-proxy` | Fetches `http://localhost:3000` — any HTTP response is a PASS |
| `dashboard-switch` | Calls `POST /_fleet/api/features/<key>/activate` |
| `teardown` | Deletes pod + service; kills port-forward |

Each step prints `PASS: <step>` or `FAIL: <step> <reason>`. The script exits 0 on full
success, 1 if any step fails.

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--namespace` | required | Kubernetes namespace to use |
| `--feature-key` | required | Unique key for the test feature |
| `--keep-pod` | false | Skip teardown (useful for post-mortem debugging) |
| `--continue` | false | Run all steps even after a failure |
| `--local-port` | 13000 | Local port for the `oc port-forward` |
| `--gateway-url` | http://localhost:4000 | Fleet gateway admin URL |
| `--proxy-url` | http://localhost:3000 | Fleet proxy URL |

### Troubleshooting cluster features

**Port-forward hangs or times out:**
Check the pod status and that `oc` is on PATH and logged in:
```bash
oc get pod fleet-smoke-<key> -n <ns>
oc whoami
```

**503 from the proxy:**
The port-forward may not be established yet or the pod is not ready.
Check the gateway feature state:
```bash
curl -s http://localhost:4000/_fleet/api/features | jq '.[] | {key, status, host}'
```

**Feature stuck in `building` after `fleet add --host`:**
The cluster lifecycle runs asynchronously. Check the pod events:
```bash
oc describe pod fleet-<name> -n <ns>
```

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
| `scripts/fleet-init.sh` | ~147 |

If a file approaches 800 lines, split by concern (e.g., extract Docker stat parsing from `docker.js` into `docker-stats.js`).

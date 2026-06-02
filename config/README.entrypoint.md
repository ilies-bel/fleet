# Fleet feature-container entrypoint

`entrypoint.sh` is the unified entrypoint for all fleet feature containers.
It is copied to `/entrypoint.sh` inside the image and invoked via tini:

```
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
```

## Default mode (local dev / docker-compose)

With no special environment variables the entrypoint:

1. Optionally initialises an embedded PostgreSQL cluster (when a
   `spring`/`gradle` service is present in `FLEET_SERVICES_JSON`).
2. Generates `/etc/supervisor/conf.d/fleet.conf` from `FLEET_SERVICES_JSON`
   and `FLEET_PEERS_JSON`.
3. Generates `/etc/nginx/conf.d/feature.conf` with a reverse-proxy location
   block per service.
4. Sources any `FLEET_SHARED_ENV_FILES`.
5. Execs `supervisord -n` as PID 1.

This path is unchanged from before and requires no extra configuration.

---

## Wait mode (`FLEET_BOOT=wait`)

When the container runs as a **cluster pod** (OpenShift / Kubernetes), the
container image starts before application code is present on disk.  The
orchestrator then transfers code (e.g. via `oc rsync`) and signals when it
is ready.

Set `FLEET_BOOT=wait` to activate the idle-wait entrypoint:

```yaml
env:
  - name: FLEET_BOOT
    value: wait
```

The entrypoint **blocks** immediately after printing the startup banner,
polling for the sentinel file every second.  Nothing else runs — no
PostgreSQL init, no supervisord config generation, no service start.

### Sentinel file: `/app/.fleet-ready`

The sentinel is the **only signal** the entrypoint watches for.  It must be
created (or touched) by whoever finishes populating `/app`:

```bash
# After oc rsync (or equivalent) completes:
oc exec <pod> -- touch /app/.fleet-ready
```

Once the file exists the entrypoint resumes from where it blocked and
completes the normal startup sequence (DB init → supervisord config →
nginx config → `exec supervisord`).

### Overriding the sentinel path

The sentinel path defaults to `/app/.fleet-ready`.  Override it per-pod if
needed:

```yaml
env:
  - name: FLEET_BOOT
    value: wait
  - name: FLEET_READY_SENTINEL
    value: /some/other/path
```

### Lifecycle summary

```
Pod starts
  └─ entrypoint.sh (FLEET_BOOT=wait)
       ├─ prints banner
       ├─ [blocks: polls /app/.fleet-ready every 1s]
       │
       │   ← orchestrator: oc rsync code into /app
       │   ← orchestrator: touch /app/.fleet-ready
       │
       ├─ sentinel detected → resumes
       ├─ generates supervisord config
       ├─ generates nginx config
       └─ exec supervisord -n   (PID 1 via tini)
```

---

## Local smoke test

`smoke-fleet-boot-wait.sh` in `.fleet/test/` exercises the full lifecycle
locally using Docker.  Build the image first, then run:

```bash
docker build -t fleet-feature-base -f .fleet/Dockerfile.feature-base .
bash .fleet/test/smoke-fleet-boot-wait.sh fleet-feature-base
```

The test:
1. Starts the container with `FLEET_BOOT=wait`.
2. Confirms nginx is **not** yet serving (entrypoint is blocked).
3. Copies a test HTML file via `docker cp` (simulates `oc rsync`).
4. Touches `/app/.fleet-ready` via `docker exec`.
5. Waits up to 30 s for nginx to start.
6. Verifies the copied file is served — exits 0 on pass, 1 on failure.

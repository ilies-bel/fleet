import path from 'path';
import fs from 'fs';
import express, { Router } from 'express';
import { getAll, getFeature, setActiveFeature, getActiveFeature, unregister, updateStatus, updateTitle, getContainerStatus, appendBuildLog, getBuildLog, subscribeBuildLog, getServices } from './registry.js';
import { dockerExec, dockerExecStreamWithExitCode, dockerLogs, stopContainer, startContainer, getContainerStats, inspectContainer, DockerSocketError, DockerContainerError } from './docker.js';
import { bootstrap } from './cluster/bootstrap.js';
import { stopFeature } from './backend.js';
import { getHostMetrics } from './host-metrics.js';
import { startOperation, endOperation, listOperations, listFailureClusters, appendEvent, getOperation } from './log-store.js';
import { tagError, FAILURE_REASONS } from './failure-reasons.js';
import * as containerDispatch from './container-dispatch.js';
import { parseLogText } from './log-parse.js';
import { detectRunMarkers } from './run-markers.js';

// Re-export the spawn seam so existing tests that import _setSpawnImpl from
// api.js continue to work without modification.
export { _setSpawnImpl } from './container-dispatch.js';

const router = Router();
const startedAt = Date.now();

/**
 * GET /_fleet/api/features
 * Returns all registered features with isActive flag.
 * Each entry includes project, name, and key (composite) for dashboard use.
 */
router.get('/features', (_req, res) => {
  res.json(getAll());
});

/**
 * GET /_fleet/api/features/:key/health
 * HEAD the container's nginx to check if the full stack is responding.
 * `:key` is the composite `${project}-${name}` string.
 */
router.get('/features/:key/health', async (req, res) => {
  const { key } = req.params;

  if (!getFeature(key)) {
    return res.status(404).json({ error: 'Feature not registered' });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const response = await fetch(`http://fleet-${key}:80/`, {
      method: 'HEAD',
      signal: controller.signal,
    });

    clearTimeout(timeout);
    res.json({ status: response.ok ? 'up' : 'down' });
  } catch {
    res.json({ status: 'down' });
  }
});

/**
 * GET /_fleet/api/features/:key/services/health
 * Probe each registered service of a feature and return per-service health.
 * Returns { services: [{ name, port, status: 'up'|'down' }] }.
 */
router.get('/features/:key/services/health', async (req, res) => {
  const { key } = req.params;

  const feature = getFeature(key);
  if (!feature) {
    return res.status(404).json({ error: 'Feature not registered' });
  }

  // Cluster features route through port-forward addresses that this endpoint
  // doesn't have access to — return an empty list rather than mis-probing them.
  if (feature.host != null) {
    return res.json({ services: [] });
  }

  const services = getServices(key);

  const results = await Promise.all(
    services.map(async (service) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);

        // Probe through nginx (port 80) using the path prefix nginx routes to
        // this service. The internal service port (service.port) is only
        // reachable on loopback inside the container — probing it directly from
        // outside always gets ECONNREFUSED. Any received HTTP response (even
        // 404/405) means the service process is up; only a thrown error
        // (connection refused / timeout / DNS) means down.
        await fetch(`http://fleet-${key}/${service.name}/`, {
          method: 'GET',
          signal: controller.signal,
        });

        clearTimeout(timeout);
        return { name: service.name, port: service.port, status: 'up' };
      } catch {
        return { name: service.name, port: service.port, status: 'down' };
      }
    }),
  );

  res.json({ services: results });
});

/**
 * POST /_fleet/api/features/:key/activate
 * Set the active feature for the transparent proxy (PROXY_PORT).
 * `:key` is the composite `${project}-${name}` string.
 */
router.post('/features/:key/activate', (req, res) => {
  const { key } = req.params;
  if (!getFeature(key)) {
    return res.status(404).json({ error: 'Feature not registered' });
  }
  const opId = startOperation({ kind: 'activate', key });
  appendEvent(opId, { message: 'activate started' });
  try {
    setActiveFeature(key);
    appendEvent(opId, { message: 'proxy target updated' });
    endOperation(opId, { outcome: 'success' });
    res.json({ ok: true, active: key });
  } catch (err) {
    tagError(err, FAILURE_REASONS.REGISTRY_NOT_REGISTERED);
    endOperation(opId, { outcome: 'failure', error: err });
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /_fleet/api/operations
 * Returns the most recent 100 operations ordered by startedAt DESC.
 */
router.get('/operations', (_req, res) => {
  res.json(listOperations({ limit: 100 }));
});

/**
 * GET /_fleet/api/operations/failures/clustered
 * Returns failure clusters grouped by reason_code.
 * ?sinceHours= (default 24) controls the look-back window.
 */
router.get('/operations/failures/clustered', (req, res) => {
  const sinceHours = Number(req.query.sinceHours) || 24;
  const sinceMs = Date.now() - sinceHours * 60 * 60 * 1000;
  res.json(listFailureClusters({ sinceMs }));
});

/**
 * GET /_fleet/api/operations/:id
 * Returns the operation row (including reasonCode) plus its events array:
 * { operation, events:[...] }. 404 when the operation does not exist.
 */
router.get('/operations/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid operation id' });
  }
  const result = getOperation(id);
  if (!result) {
    return res.status(404).json({ error: 'Operation not found' });
  }
  res.json(result);
});

/**
 * DELETE /_fleet/api/features/:key
 * Stop the feature (cluster or local), then unregister from the registry.
 * `:key` is the composite `${project}-${name}` string.
 */
router.delete('/features/:key', async (req, res) => {
  const { key } = req.params;
  const feature = getFeature(key);
  if (!feature) {
    return res.status(404).json({ error: 'Feature not registered' });
  }
  // startOperation before unregister so the log row survives even if the
  // registry entry is removed as part of this operation.
  const opId = startOperation({ kind: 'remove', key });
  appendEvent(opId, { message: 'remove started' });
  try {
    appendEvent(opId, { message: 'stopping container' });
    await stopFeature(feature);
  } catch (err) {
    if (err instanceof DockerSocketError) {
      endOperation(opId, { outcome: 'failure', error: err });
      return res.status(503).json({ error: err.message });
    }
    if (err instanceof DockerContainerError && err.status !== 404) {
      endOperation(opId, { outcome: 'failure', error: err });
      return res.status(503).json({ error: err.message });
    }
    if (feature.host) {
      // oc command failures are fatal — pod or service may still exist
      endOperation(opId, { outcome: 'failure', error: err });
      return res.status(503).json({ error: err.message });
    }
    // 404 from Docker is fine — container was already gone, proceed with unregister
  }
  unregister(key);
  appendEvent(opId, { message: 'feature unregistered' });
  endOperation(opId, { outcome: 'success' });
  res.json({ ok: true });
});

/**
 * POST /_fleet/api/features/:key/stop
 * Stop the container without removing it from the registry.
 */
router.post('/features/:key/stop', async (req, res) => {
  const { key } = req.params;
  if (!getFeature(key)) return res.status(404).json({ error: 'Feature not registered' });
  const opId = startOperation({ kind: 'stop', key });
  appendEvent(opId, { message: 'stop started' });
  try {
    await stopContainer(`fleet-${key}`);
    appendEvent(opId, { message: 'container stopped' });
    endOperation(opId, { outcome: 'success' });
    res.json({ ok: true });
  } catch (err) {
    endOperation(opId, { outcome: 'failure', error: err });
    if (err instanceof DockerSocketError) return res.status(503).json({ error: err.message });
    if (err instanceof DockerContainerError) return res.status(err.status === 404 ? 404 : 503).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /_fleet/api/features/:key/start
 * Start a previously stopped container.
 */
router.post('/features/:key/start', async (req, res) => {
  const { key } = req.params;
  if (!getFeature(key)) return res.status(404).json({ error: 'Feature not registered' });
  try {
    await startContainer(`fleet-${key}`);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof DockerSocketError) return res.status(503).json({ error: err.message });
    if (err instanceof DockerContainerError) return res.status(err.status === 404 ? 404 : 503).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /_fleet/api/features/:key/stats
 * Returns a one-shot resource snapshot: CPU %, memory, network I/O.
 */
router.get('/features/:key/stats', async (req, res) => {
  const { key } = req.params;
  if (!getFeature(key)) return res.status(404).json({ error: 'Feature not registered' });
  try {
    const stats = await getContainerStats(`fleet-${key}`);
    res.json(stats);
  } catch (err) {
    if (err instanceof DockerSocketError) return res.status(503).json({ error: err.message });
    if (err instanceof DockerContainerError) {
      const status = err.status === 404 ? 404 : 503;
      return res.status(status).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /_fleet/api/features/:key/logs?source=backend&tail=200&since=0
 * Stream the last N lines of a supervisor log file or combined Docker logs.
 * source: backend | nginx | postgresql | supervisord | all
 */
const ALLOWED_SOURCES = new Set(['backend', 'nginx', 'postgresql', 'supervisord']);

router.get('/features/:key/logs', async (req, res) => {
  const { key } = req.params;

  if (!getFeature(key)) {
    return res.status(404).json({ error: 'Feature not registered' });
  }

  const source = req.query.source || 'backend';
  const tail = Math.min(Math.max(parseInt(req.query.tail) || 200, 1), 2000);
  const containerName = `fleet-${key}`;

  // Attempt to obtain container start time for run-marker anchoring.
  // Non-fatal: markers work from log banners alone if inspect fails.
  let containerStartedAt = null;
  try {
    const info = await inspectContainer(containerName);
    containerStartedAt = info?.State?.StartedAt ?? null;
  } catch {
    // ignore
  }

  try {
    if (source === 'all') {
      const LOG_SOURCES = ['backend', 'nginx', 'postgresql', 'supervisord'];
      const tailArg = String(tail);
      const results = await Promise.all(
        LOG_SOURCES.map(src =>
          dockerExec(containerName, ['tail', '-n', tailArg, `/var/log/supervisor/${src}.log`])
            .catch(() => ''),
        ),
      );

      // Parse each source and collect into one flat record array
      const allRecords = LOG_SOURCES.flatMap((src, i) => parseLogText(results[i], src));

      // Merge into a single timeline: timestamped records sorted by ts, then
      // un-timestamped records in their original relative order at the end.
      allRecords.sort((a, b) => {
        if (!a.ts && !b.ts) return 0;
        if (!a.ts) return 1;
        if (!b.ts) return -1;
        return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
      });

      const markers = detectRunMarkers(allRecords, { containerStartedAt });
      return res.json({ records: allRecords, markers, fetchedAt: Date.now() });
    } else if (ALLOWED_SOURCES.has(source)) {
      const text = await dockerExec(containerName, ['tail', '-n', String(tail), `/var/log/supervisor/${source}.log`]);
      const records = parseLogText(text, source);
      const markers = detectRunMarkers(records, { containerStartedAt });
      return res.json({ records, markers, fetchedAt: Date.now() });
    } else {
      return res.status(400).json({ error: `Invalid source '${source}'. Use: backend, nginx, postgresql, supervisord, all` });
    }
  } catch (err) {
    if (err instanceof DockerSocketError) {
      return res.status(503).json({ error: err.message });
    }
    if (err instanceof DockerContainerError) {
      const status = err.status === 404 ? 404 : 503;
      const msg = err.status === 409
        ? 'Container not running — build may still be in progress'
        : err.message;
      return res.status(status).json({ error: msg });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /_fleet/api/doctor/:key
 * Defense-in-depth check that no internal-only supervisord peer ports
 * (jira-proxy 8081, wiremock 8089) are accidentally published to the host.
 *
 * Returns { exposed: number[], ok: boolean }.
 *   - exposed: container-internal ports that are bound to a host port AND
 *     match the forbidden list.
 *   - ok: exposed.length === 0.
 */
const FORBIDDEN_INTERNAL_PORTS = [8081, 8089];

router.get('/doctor/:key', async (req, res) => {
  const { key } = req.params;
  try {
    const info = await inspectContainer(`fleet-${key}`);
    if (!info) return res.status(404).json({ error: `Container fleet-${key} not found` });

    const ports = info.NetworkSettings?.Ports ?? {};
    const exposed = [];
    for (const [portKey, bindings] of Object.entries(ports)) {
      // portKey is "8081/tcp" etc.
      const portNum = parseInt(portKey.split('/')[0], 10);
      if (!FORBIDDEN_INTERNAL_PORTS.includes(portNum)) continue;
      if (Array.isArray(bindings) && bindings.length > 0) {
        exposed.push(portNum);
      }
    }
    res.json({ exposed, ok: exposed.length === 0 });
  } catch (err) {
    if (err instanceof DockerSocketError) return res.status(503).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /_fleet/api/features/:key/reconcile
 * Re-derive the lifecycle status of a single feature from live Docker state
 * plus nginx health probe. Fixes the "FAILED when actually UP" and inverse
 * drifts by overwriting the registry with ground truth.
 *
 * Rules:
 *   - Docker says running AND nginx HEAD succeeds → 'up' (clears error).
 *   - Docker says running AND nginx HEAD fails    → leave current lifecycle
 *     intact if it's 'building'/'starting' (still booting); otherwise 'starting'.
 *   - Docker says exited/missing                   → 'stopped'.
 */
router.post('/features/:key/reconcile', async (req, res) => {
  const { key } = req.params;
  const feature = getFeature(key);
  if (!feature) return res.status(404).json({ error: 'Feature not registered' });

  try {
    const containerStatus = await getContainerStatus(key);
    if (containerStatus !== 'running') {
      updateStatus(key, 'stopped');
      return res.json({ ok: true, key, status: 'stopped' });
    }

    // Container is running — probe nginx on port 80 before declaring 'up'.
    let healthy = false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const response = await fetch(`http://fleet-${key}:80/`, { method: 'HEAD', signal: controller.signal });
      clearTimeout(timeout);
      healthy = response.ok;
    } catch {
      healthy = false;
    }

    if (healthy) {
      updateStatus(key, 'up', null);
      return res.json({ ok: true, key, status: 'up' });
    }

    // Container running but nginx not responding yet. Preserve transient
    // lifecycle states; downgrade anything else to 'starting'.
    const current = feature.status;
    if (current !== 'building' && current !== 'starting') {
      updateStatus(key, 'starting');
    }
    res.json({ ok: true, key, status: 'starting' });
  } catch (err) {
    if (err instanceof DockerSocketError) return res.status(503).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /_fleet/api/host-stats
 * Returns a snapshot of host machine resource usage (CPU %, memory).
 * Responds 503 with { error } if metrics cannot be collected.
 */
router.get('/host-stats', async (_req, res) => {
  try {
    res.json(await getHostMetrics());
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

/**
 * GET /_fleet/api/status
 */
router.get('/status', (_req, res) => {
  res.json({
    uptimeMs: Date.now() - startedAt,
    featureCount: getAll().length,
    activeFeature: getActiveFeature(),
    nodeVersion: process.version,
  });
});

/**
 * POST /_fleet/api/features/:key/sync
 * Pull latest code, rebuild backend, restart via supervisord.
 * Accepts ?regenerateSources=true to also regenerate jOOQ DSL after Liquibase migrations.
 * Returns immediately (202) — the sync runs inside the container in the background.
 */
router.post('/features/:key/sync', async (req, res) => {
  const { key } = req.params;
  if (!getFeature(key)) {
    return res.status(404).json({ error: 'Feature not registered' });
  }

  const regenerateSources = req.query.regenerateSources === 'true';
  const containerName = `fleet-${key}`;
  const opId = startOperation({ kind: 'sync', key });
  appendEvent(opId, { message: 'sync started' });

  res.json({ ok: true, message: 'Sync started — check logs for progress' });

  _runSyncImpl(containerName, regenerateSources, opId)
    .then(() => endOperation(opId, { outcome: 'success' }))
    .catch(err => {
      endOperation(opId, { outcome: 'failure', error: err });
      console.error(`[sync] ${key}: ${err.message}`);
    });
});

/**
 * Run the sync sequence inside a feature container:
 *   [jOOQ codegen] → mvn build → copy JAR → supervisorctl restart
 * Source is already present via the bind-mounted worktree; no git pull needed.
 * @param {string} containerName
 * @param {boolean} regenerateSources
 * @param {number} opId  Operation id from startOperation — events and outcome are written here.
 */
async function runSync(containerName, regenerateSources, opId) {
  const info = await inspectContainer(containerName);
  if (!info) throw new Error(`Container '${containerName}' not found`);

  const envMap = Object.fromEntries(
    (info.Config?.Env ?? []).map(e => {
      const idx = e.indexOf('=');
      return idx === -1 ? [e, ''] : [e.slice(0, idx), e.slice(idx + 1)];
    }),
  );

  const backendDir = envMap.BACKEND_DIR;
  if (!backendDir) throw new Error('BACKEND_DIR not set in container environment — is this a backend-enabled feature?');

  const buildCmd = envMap.BACKEND_BUILD_CMD || 'mvn package -DskipTests -q';

  const steps = [
    `cd /app/${backendDir}`,
  ];
  if (regenerateSources) {
    appendEvent(opId, { message: 'regenerating jOOQ sources' });
    steps.push('mvn compile -Pjooq-codegen -q');
  }
  steps.push(buildCmd);
  const artifactPath = process.env.BACKEND_ARTIFACT_PATH || '/home/developer/backend.jar';
  steps.push(`ls target/*.jar && cp target/*.jar ${artifactPath}`);
  steps.push('supervisorctl restart all');

  appendEvent(opId, { message: 'running sync: build and restart' });
  await dockerExec(containerName, ['bash', '-c', steps.join(' && ')]);
  appendEvent(opId, { message: 'sync complete' });
}

// Mutable shim so tests can swap out runSync without touching Docker.
let _runSyncImpl = runSync;

/** @internal — test seam, allows tests to replace runSync without mocking docker. */
export function _setRunSync(fn) { _runSyncImpl = fn; }

/**
 * POST /_fleet/api/features/:key/rebuild
 * Rebuild the Docker base image and recreate the container from scratch.
 * Returns immediately (202) — the rebuild runs in the background.
 */
router.post('/features/:key/rebuild', async (req, res) => {
  const { key } = req.params;
  if (!getFeature(key)) {
    return res.status(404).json({ error: 'Feature not registered' });
  }

  res.json({ ok: true, message: 'Rebuild started — check logs for progress' });

  const opId = startOperation({ kind: 'build', key });
  runRebuild(key).then(
    () => endOperation(opId, { outcome: 'success' }),
    (err) => {
      endOperation(opId, { outcome: 'failure', error: err });
      console.error(`[rebuild] ${key}: ${err.message}`);
    },
  );
});

/**
 * Run a host-level docker build + docker compose up -d to rebuild a feature
 * from scratch. Streams stdout/stderr to the feature's build-log ring buffer.
 *
 * Sequence:
 *   1. PATCH status → 'building'
 *   2. docker stop fleet-<key>        (ignore "already stopped")
 *   3. docker build --load -t <image> -f <dockerfile> <FLEET_ROOT>
 *   4. docker compose -f <composefile> up -d
 *   5. PATCH status → 'starting'
 *   6. Poll /_fleet/api/features/:key/health every 2s, up to 60s
 *   7. On healthy → PATCH status 'up'; on timeout → PATCH 'failed'
 *
 * @param {string} key  composite key (without the 'fleet-' prefix)
 * @returns {Promise<void>}
 */
export async function runRebuild(key) {
  const FLEET_PROJECT_ROOT = process.env.FLEET_PROJECT_ROOT;
  const FLEET_ROOT = process.env.FLEET_ROOT;

  if (!FLEET_PROJECT_ROOT || !FLEET_ROOT) {
    throw new Error('FLEET_PROJECT_ROOT and FLEET_ROOT must be set in the gateway environment');
  }

  // Step 1 — mark as building (resets build-log ring buffer)
  updateStatus(key, 'building', null);

  const log = (line) => appendBuildLog(key, line);
  log(`[rebuild] Starting rebuild for '${key}'`);

  // Step 2 — resolve paths
  const composeFile = path.join(FLEET_PROJECT_ROOT, '.fleet', key, 'docker-compose.yml');

  // Extract image name and service name from compose file.
  // image line looks like `    image: fleet-feature-base-myproject`
  let imageName;
  try {
    const composeContent = fs.readFileSync(composeFile, 'utf8');
    const imageMatch = composeContent.match(/^\s+image:\s+(.+)$/m);
    if (!imageMatch) {
      throw new Error(`No 'image:' line found in ${composeFile}`);
    }
    imageName = imageMatch[1].trim();
  } catch (err) {
    updateStatus(key, 'failed', `rebuild: could not read compose file: ${err.message}`);
    throw err;
  }

  log(`[rebuild] Image:      ${imageName}`);
  log(`[rebuild] Compose:    ${composeFile}`);

  /**
   * Run a docker command, streaming stdout+stderr lines to the build-log.
   * Delegates spawn to containerDispatch.run so all docker calls go through
   * the single dispatch seam.
   * @param {string} cmd
   * @param {string[]} args
   * @param {{ ignoreExitCode?: boolean }} [opts]
   */
  const runCommand = (cmd, args, opts = {}) => {
    log(`[rebuild] + ${cmd} ${args.join(' ')}`);
    return containerDispatch.run(args, (line) => log(line), opts);
  };

  try {
    // Step 3 — stop the running container (ignore error if already stopped/missing)
    log(`[rebuild] Stopping fleet-${key}...`);
    try {
      await stopContainer(`fleet-${key}`);
    } catch {
      // Container may already be stopped or not exist — proceed regardless
      log(`[rebuild] Container not running or not found — proceeding`);
    }

    // Step 4 — rebuild the image
    log(`[rebuild] Building image ${imageName}...`);
    await containerDispatch.build({
      subName: key,
      imageTag: imageName,
      contextDir: FLEET_ROOT,
      fleetDir: path.join(FLEET_PROJECT_ROOT, '.fleet'),
      runCommand,
    });

    // Step 5 — recreate container with new image
    log(`[rebuild] Recreating container via docker compose up -d...`);
    await runCommand('docker', ['compose', '-f', composeFile, 'up', '-d']);

    // Step 6 — transition to starting
    updateStatus(key, 'starting', null);
    log(`[rebuild] Container started — waiting for health...`);

    // Step 7 — poll health endpoint
    const HEALTH_MAX_MS = 60_000;
    const HEALTH_POLL_MS = 2_000;
    const deadline = Date.now() + HEALTH_MAX_MS;
    let healthy = false;

    while (Date.now() < deadline) {
      const elapsed = Math.round((Date.now() - (deadline - HEALTH_MAX_MS)) / 1000);
      log(`[rebuild] Waiting for health... (${elapsed}s / ${HEALTH_MAX_MS / 1000}s)`);
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        const response = await fetch(`http://fleet-${key}:80/`, {
          method: 'HEAD',
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (response.ok) {
          healthy = true;
          break;
        }
      } catch {
        // not up yet — keep polling
      }
      await new Promise(resolve => setTimeout(resolve, HEALTH_POLL_MS));
    }

    if (healthy) {
      updateStatus(key, 'up', null);
      log(`[rebuild] Rebuild complete — '${key}' is up`);
    } else {
      const msg = `Health wait timed out after ${HEALTH_MAX_MS / 1000}s`;
      updateStatus(key, 'failed', msg);
      log(`[rebuild] ERROR: ${msg}`);
      throw new Error(msg);
    }
  } catch (err) {
    // Guard against double-setting failed (health timeout already set it above)
    const current = getFeature(key);
    if (current && current.status !== 'failed') {
      updateStatus(key, 'failed', err.message);
    }
    log(`[rebuild] ERROR: ${err.message}`);
    throw err;
  }
}

/**
 * PATCH /_fleet/api/features/:key/status
 * Update the lifecycle status of a feature — used by `fleet add` to emit
 * building → starting → running transitions, or failed on an error.
 *
 * Body: { status: string, error?: string|null }
 *   - error is optional. If omitted the previous error field is preserved
 *     (transitions away from 'failed' do not need to clear it explicitly).
 *     Pass null to clear. Pass a string (typically with status='failed').
 */
router.patch('/features/:key/status', (req, res) => {
  const { key } = req.params;
  const { status, error } = req.body;
  if (!getFeature(key)) {
    return res.status(404).json({ error: 'Feature not registered' });
  }
  if (!status || typeof status !== 'string') {
    return res.status(400).json({ error: 'status field required' });
  }
  if (error !== undefined && error !== null && typeof error !== 'string') {
    return res.status(400).json({ error: 'error field must be a string or null' });
  }
  try {
    updateStatus(key, status, error);
    res.json({ ok: true, key, status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * PATCH /_fleet/api/features/:key/config
 * Update mutable configuration fields for a registered feature.
 *
 * Body: { title: string|null }
 *   - title: human-readable display name shown in the dashboard.
 *     Pass null to clear a user-set title (displayName falls back to name).
 *     The title is persisted to disk (FLEET_TITLES_FILE) and survives a
 *     gateway restart; re-registration with title=null will not clobber it.
 */
router.patch('/features/:key/config', (req, res) => {
  const { key } = req.params;
  const { title } = req.body;
  if (!getFeature(key)) {
    return res.status(404).json({ error: 'Feature not registered' });
  }
  if (title === undefined) {
    return res.status(400).json({ error: 'title field required' });
  }
  if (title !== null && typeof title !== 'string') {
    return res.status(400).json({ error: 'title must be a string or null' });
  }
  try {
    updateTitle(key, title);
    res.json({ ok: true, key, title });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /_fleet/api/features/:key/build-log
 * Accepts a plain-text chunk (Content-Type: text/plain) and appends it to the
 * in-memory ring buffer for the feature. Called by `fleet add` to stream
 * docker compose build output into the gateway for SSE fan-out.
 */
router.post('/features/:key/build-log', express.text({ type: 'text/plain', limit: '1mb' }), (req, res) => {
  const { key } = req.params;
  if (!getFeature(key)) {
    return res.status(404).json({ error: 'Feature not registered' });
  }
  const body = typeof req.body === 'string' ? req.body : '';
  if (body.length > 0) appendBuildLog(key, body);
  res.json({ ok: true });
});

/**
 * GET /_fleet/api/features/:key/build-log
 * Server-Sent Events stream of build log lines for a feature.
 * Replays all buffered lines on connect, then pushes new lines as they arrive.
 * Sends a keepalive comment every 15 s to prevent proxy timeouts.
 */
router.get('/features/:key/build-log', (req, res) => {
  const { key } = req.params;
  if (!getFeature(key)) {
    return res.status(404).json({ error: 'Feature not registered' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Replay buffered lines
  const existing = getBuildLog(key);
  if (existing && existing.lines.length > 0) {
    for (const line of existing.lines) {
      res.write(`data: ${line}\n\n`);
    }
  }

  // Subscribe to new lines
  const unsubscribe = subscribeBuildLog(key, (line) => {
    res.write(`data: ${line}\n\n`);
  });

  // Keepalive every 15 s
  const keepalive = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(keepalive);
    unsubscribe();
  });
});

/**
 * POST /_fleet/api/cluster/bootstrap?namespace=<ns>
 *
 * Bootstrap the fleet-feature-base ImageStream and BuildConfig into the given
 * namespace, then trigger a one-time in-cluster build if the :latest tag does
 * not yet exist. Safe to call multiple times — idempotent.
 *
 * After a successful bootstrap, feature pod specs can reference:
 *   image-registry.openshift-image-registry.svc:5000/<namespace>/fleet-feature-base:latest
 */
router.post('/cluster/bootstrap', async (req, res) => {
  const { namespace } = req.query;
  if (!namespace || typeof namespace !== 'string' || namespace.trim() === '') {
    return res.status(400).json({ error: 'namespace query parameter required' });
  }
  try {
    await bootstrap(namespace.trim());
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /_fleet/api/features/:key/diff
 * Returns the git diff of the feature branch against the merge-base of main,
 * produced inside the feature's own container by running:
 *   git --no-optional-locks -C /var/fleet/git/worktree diff main...HEAD
 * against the dedicated read-only git mount established at container start time.
 *
 * The read-only `--no-optional-locks` flag ensures the index lock is never
 * taken, so the command cannot collide with in-progress edits. The mount is
 * read-only, so the command cannot mutate branches or the working tree.
 *
 * When git cannot run (container not found/running, non-zero exit), the
 * endpoint responds 200 with `status: 'unavailable'` and a short
 * human-readable reason rather than 500.
 *
 * Output is capped at DIFF_CAP_BYTES. When the underlying git output exceeds
 * the cap, the response carries `truncated: true` and `originalBytes` reflects
 * the full byte count before truncation.
 *
 * Response: { status: 'ok'|'no-changes'|'unavailable', patch: string, isEmpty: boolean, truncated: boolean, originalBytes: number }
 *   status        — 'ok' when patch is non-empty, 'no-changes' when branch matches main,
 *                   'unavailable' when git cannot produce a diff
 *   reason        — present only when status is 'unavailable'; short human-readable explanation
 *   patch         — raw unified diff output (empty string when there are no changes)
 *   isEmpty       — true when patch is the empty string
 *   truncated     — true when git output exceeded DIFF_CAP_BYTES
 *   originalBytes — total bytes received; equals patch.length when not truncated
 *
 * 404 — feature not registered
 * 422 — feature has no worktreePath (cluster-hosted features, for example)
 */
const DIFF_CAP_BYTES = 1_048_576;

/** In-container path where the worktree root is bind-mounted read-only (slice 2). */
const DEDICATED_MOUNT = '/var/fleet/git/worktree';

/**
 * Mutable shim: execs `git diff main...HEAD` inside the feature's running
 * container at the dedicated read-only git mount.
 * Returns Promise<{ stdout: Readable, abort: fn, exitCode: Promise<number> }>.
 * exitCode resolves with the process exit code; rejects on exec infrastructure failure.
 * @internal — tests replace this via _setContainerGitStreamImpl to avoid
 *             requiring a real Docker daemon.
 * @param {string} containerName  e.g. 'fleet-myproject-myfeature'
 * @returns {Promise<{ stdout: import('stream').Readable, abort: () => void, exitCode: Promise<number> }>}
 */
let _containerGitStreamImpl = (containerName) =>
  dockerExecStreamWithExitCode(containerName, [
    'git', '--no-optional-locks', '-C', DEDICATED_MOUNT, 'diff', 'main...HEAD',
  ]);

/** @internal — test seam, replaces the container git exec implementation. */
export function _setContainerGitStreamImpl(fn) { _containerGitStreamImpl = fn; }

router.get('/features/:key/diff', async (req, res) => {
  const { key } = req.params;
  const feature = getFeature(key);
  if (!feature) {
    return res.status(404).json({ error: 'Feature not registered' });
  }
  // Cluster-hosted features have no local git working tree — skip docker exec entirely.
  if (!feature.gitDir) {
    return res.json({
      status: 'unavailable',
      reason: 'no local worktree',
      patch: '',
      isEmpty: true,
      truncated: false,
      originalBytes: 0,
    });
  }
  if (!feature.worktreePath) {
    return res.status(422).json({ error: 'Feature has no worktree path' });
  }

  const containerName = `fleet-${key}`;

  try {
    const { stdout, abort, exitCode: exitCodePromise } = await _containerGitStreamImpl(containerName);

    const chunks = [];
    let originalBytes = 0;
    let truncated = false;
    let localCollected = 0;

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      const fail = (err) => { if (!settled) { settled = true; reject(err); } };

      stdout.on('data', (chunk) => {
        originalBytes += chunk.length;
        if (truncated) return;
        const avail = DIFF_CAP_BYTES - localCollected;
        if (chunk.length <= avail) {
          chunks.push(chunk);
          localCollected += chunk.length;
        } else {
          if (avail > 0) chunks.push(chunk.slice(0, avail));
          localCollected = DIFF_CAP_BYTES;
          truncated = true;
          abort();
          finish();
        }
      });

      stdout.on('end', finish);
      stdout.on('close', finish);
      stdout.on('error', fail);
    });

    // Wait for exec exit code.
    let exitCode;
    try {
      exitCode = await exitCodePromise;
    } catch (execErr) {
      return res.json({
        status: 'unavailable',
        reason: execErr.message || 'git exec failed',
        patch: '',
        isEmpty: true,
        truncated: false,
        originalBytes: 0,
      });
    }

    // Non-zero exit without truncation means git actually failed (not a repo, etc.)
    if (exitCode !== 0 && !truncated) {
      return res.json({
        status: 'unavailable',
        reason: `git exited with code ${exitCode}`,
        patch: '',
        isEmpty: true,
        truncated: false,
        originalBytes: 0,
      });
    }

    const patch = Buffer.concat(chunks).toString('utf8');
    const isEmpty = patch.length === 0;
    res.json({ status: isEmpty ? 'no-changes' : 'ok', patch, isEmpty, truncated, originalBytes });
  } catch (err) {
    res.json({
      status: 'unavailable',
      reason: err.message || 'git exec failed',
      patch: '',
      isEmpty: true,
      truncated: false,
      originalBytes: 0,
    });
  }
});

export default router;

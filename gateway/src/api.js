import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import express, { Router } from 'express';
import { getAll, getFeature, setActiveFeature, getActiveFeature, unregister, updateStatus, updateTitle, getContainerStatus, appendBuildLog, getBuildLog, subscribeBuildLog, getServices } from './registry.js';
import { dockerExec, dockerExecStream, dockerLogs, stopContainer, startContainer, getContainerStats, inspectContainer, DockerSocketError, DockerContainerError } from './docker.js';
import { bootstrap } from './cluster/bootstrap.js';
import { stopFeature } from './backend.js';
import { getHostMetrics } from './host-metrics.js';
import { startOperation, endOperation, listOperations, listFailureClusters, appendEvent, getOperation } from './log-store.js';
import { tagError, FAILURE_REASONS } from './failure-reasons.js';

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

  if (!getFeature(key)) {
    return res.status(404).json({ error: 'Feature not registered' });
  }

  const services = getServices(key);

  const results = await Promise.all(
    services.map(async (service) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);

        const response = await fetch(`http://fleet-${key}:${service.port}/`, {
          method: 'HEAD',
          signal: controller.signal,
        });

        clearTimeout(timeout);
        return { name: service.name, port: service.port, status: response.ok ? 'up' : 'down' };
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
  const since = Math.max(parseInt(req.query.since) || 0, 0);
  const containerName = `fleet-${key}`;

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
      const sources = Object.fromEntries(LOG_SOURCES.map((src, i) => [src, results[i]]));
      return res.json({ sources, fetchedAt: Date.now() });
    } else if (ALLOWED_SOURCES.has(source)) {
      const lines = await dockerExec(containerName, ['tail', '-n', String(tail), `/var/log/supervisor/${source}.log`]);
      return res.json({ lines, fetchedAt: Date.now() });
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
async function runRebuild(key) {
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
  // service name is the first indented key under `services:`
  let imageName;
  let composeServiceName;
  try {
    const composeContent = fs.readFileSync(composeFile, 'utf8');
    const imageMatch = composeContent.match(/^\s+image:\s+(.+)$/m);
    if (!imageMatch) {
      throw new Error(`No 'image:' line found in ${composeFile}`);
    }
    imageName = imageMatch[1].trim();
    const serviceMatch = composeContent.match(/^services:\s*\n\s+(\S+):/m);
    composeServiceName = serviceMatch ? serviceMatch[1] : null;
  } catch (err) {
    updateStatus(key, 'failed', `rebuild: could not read compose file: ${err.message}`);
    throw err;
  }

  // For linked-worktree features, write a compose override that mounts the git
  // directories read-only so that `git diff main...HEAD` resolves inside the container.
  const feature = getFeature(key);
  const gitLinksOverrideFile = path.join(FLEET_PROJECT_ROOT, '.fleet', key, 'docker-compose.gitlinks.yml');
  if (feature?.gitDir && feature?.gitCommonDir && composeServiceName) {
    const overrideYaml = [
      'services:',
      `  ${composeServiceName}:`,
      '    volumes:',
      `      - ${feature.gitDir}:${feature.gitDir}:ro`,
      `      - ${feature.gitCommonDir}:${feature.gitCommonDir}:ro`,
      '',
    ].join('\n');
    fs.writeFileSync(gitLinksOverrideFile, overrideYaml, 'utf8');
  } else {
    // Remove any stale override from a previous registration
    try { fs.unlinkSync(gitLinksOverrideFile); } catch { /* not present — fine */ }
  }

  // Resolve Dockerfile: project-local first, fallback to FLEET_ROOT
  const projectDockerfile = path.join(FLEET_PROJECT_ROOT, '.fleet', 'Dockerfile.feature-base');
  const globalDockerfile = path.join(FLEET_ROOT, 'Dockerfile.feature-base');
  const dockerfile = fs.existsSync(projectDockerfile) ? projectDockerfile : globalDockerfile;

  if (!fs.existsSync(dockerfile)) {
    const msg = `rebuild: Dockerfile not found at ${projectDockerfile} or ${globalDockerfile}`;
    updateStatus(key, 'failed', msg);
    throw new Error(msg);
  }

  log(`[rebuild] Image:      ${imageName}`);
  log(`[rebuild] Dockerfile: ${dockerfile}`);
  log(`[rebuild] Compose:    ${composeFile}`);

  /**
   * Run a CLI command, streaming stdout+stderr lines to the build-log.
   * Resolves when the process exits 0, rejects with an Error otherwise.
   * @param {string} cmd
   * @param {string[]} args
   * @param {{ ignoreExitCode?: boolean }} [opts]
   */
  const runCommand = (cmd, args, { ignoreExitCode = false } = {}) =>
    new Promise((resolve, reject) => {
      log(`[rebuild] + ${cmd} ${args.join(' ')}`);
      const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      const onLine = (chunk) => {
        const text = chunk.toString();
        for (const line of text.split('\n')) {
          const trimmed = line.trimEnd();
          if (trimmed.length > 0) log(trimmed);
        }
      };

      proc.stdout.on('data', onLine);
      proc.stderr.on('data', onLine);

      proc.on('error', (err) => reject(new Error(`spawn error for '${cmd}': ${err.message}`)));

      proc.on('close', (code) => {
        if (ignoreExitCode || code === 0) {
          resolve();
        } else {
          reject(new Error(`'${cmd} ${args.join(' ')}' exited with code ${code}`));
        }
      });
    });

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
    await runCommand('docker', [
      'build', '--load', '--no-cache',
      '-t', imageName,
      '-f', dockerfile,
      FLEET_ROOT,
    ]);

    // Step 5 — recreate container with new image
    log(`[rebuild] Recreating container via docker compose up -d...`);
    const composeArgs = ['compose', '-f', composeFile];
    if (feature?.gitDir && feature?.gitCommonDir && composeServiceName && fs.existsSync(gitLinksOverrideFile)) {
      composeArgs.push('-f', gitLinksOverrideFile);
    }
    composeArgs.push('up', '-d');
    await runCommand('docker', composeArgs);

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
 * computed inside the feature's running container via Docker exec (three-dot
 * syntax: `git diff main...HEAD`). The read-only `--no-optional-locks` flag
 * ensures the index lock is never taken, so the command cannot collide with
 * in-progress edits.
 *
 * A probe step runs `git rev-parse --is-inside-work-tree` first. If that exec
 * fails (container not running, Docker socket error) or the stdout does not
 * contain "true" (not a git repository), the endpoint responds 200 with
 * `status: 'unavailable'` and a short human-readable reason rather than 500.
 *
 * Output is capped at DIFF_CAP_BYTES. When the underlying git output exceeds
 * the cap, the response carries `truncated: true` and `originalBytes` reflects
 * the full byte count before truncation.
 *
 * Response: { status: 'ok'|'no-changes'|'unavailable', patch: string, isEmpty: boolean, truncated: boolean, originalBytes: number }
 *   status        — 'ok' when patch is non-empty, 'no-changes' when branch matches main,
 *                   'unavailable' when git is not accessible inside the container
 *   reason        — present only when status is 'unavailable'; short human-readable explanation
 *   patch         — raw unified diff output (empty string when there are no changes)
 *   isEmpty       — true when patch is the empty string
 *   truncated     — true when git output exceeded DIFF_CAP_BYTES
 *   originalBytes — total bytes received; equals patch.length when not truncated
 *
 * 404 — feature not registered
 * 422 — feature has no worktreePath (cluster-hosted features, for example)
 * 500 — unexpected error after a successful git availability probe
 */
const DIFF_CAP_BYTES = 1_048_576;

// Mutable shims so tests can swap out docker implementations without module mocking.
let _dockerExecStreamImpl = dockerExecStream;
let _dockerExecImpl = dockerExec;

/** @internal — test seam, allows tests to replace the dockerExecStream implementation. */
export function _setDockerExecStreamImpl(fn) { _dockerExecStreamImpl = fn; }

/** @internal — test seam, allows tests to replace the dockerExec implementation (probe step). */
export function _setDockerExecImpl(fn) { _dockerExecImpl = fn; }

router.get('/features/:key/diff', async (req, res) => {
  const { key } = req.params;
  const feature = getFeature(key);
  if (!feature) {
    return res.status(404).json({ error: 'Feature not registered' });
  }
  if (!feature.worktreePath) {
    return res.status(422).json({ error: 'Feature has no worktree path' });
  }

  const containerName = `fleet-${key}`;

  // Resolve source directories from the container's env (same pattern as runSync).
  // Feature repos are mounted at /app/<subdir>, not at /app itself.
  let sourceDirs;
  try {
    const info = await inspectContainer(containerName);
    if (!info) {
      return res.json({
        status: 'unavailable',
        reason: 'container not found',
        patch: '',
        isEmpty: true,
        truncated: false,
        originalBytes: 0,
      });
    }
    const envMap = Object.fromEntries(
      (info.Config?.Env ?? []).map(e => {
        const idx = e.indexOf('=');
        return idx === -1 ? [e, ''] : [e.slice(0, idx), e.slice(idx + 1)];
      }),
    );
    const candidates = [envMap.BACKEND_DIR, envMap.FRONTEND_DIR].filter(Boolean);
    sourceDirs = candidates.length > 0 ? candidates.map(d => `/app/${d}`) : ['/app'];
  } catch (err) {
    return res.json({
      status: 'unavailable',
      reason: err.message || 'container inspect failed',
      patch: '',
      isEmpty: true,
      truncated: false,
      originalBytes: 0,
    });
  }

  // Probe each source dir; keep only the ones that contain a git repo.
  const repoDirs = [];
  for (const dir of sourceDirs) {
    try {
      const probeOut = await _dockerExecImpl(containerName, [
        'git', '-C', dir, 'rev-parse', '--is-inside-work-tree',
      ]);
      if (probeOut && probeOut.trim().includes('true')) {
        repoDirs.push(dir);
      }
    } catch {
      // Not a git repo or exec unavailable — skip.
    }
  }

  if (repoDirs.length === 0) {
    return res.json({
      status: 'unavailable',
      reason: 'not a git repository',
      patch: '',
      isEmpty: true,
      truncated: false,
      originalBytes: 0,
    });
  }

  // Stream and assemble the diff, respecting DIFF_CAP_BYTES across all repos.
  // When multiple repos are present each gets a section header so paths are unambiguous.
  try {
    const multiRepo = repoDirs.length > 1;
    const patchParts = [];
    let globalCollected = 0;
    let truncated = false;
    let originalBytes = 0;

    for (const dir of repoDirs) {
      if (truncated) break;

      const { stdout, abort } = await _dockerExecStreamImpl(containerName, [
        'git', '--no-optional-locks', '-C', dir, 'diff', 'main...HEAD',
      ]);

      const repoPatch = await new Promise((resolve, reject) => {
        const chunks = [];
        let localCollected = globalCollected;
        let partOriginalBytes = 0;
        let didTruncate = false;
        let responded = false;

        const finish = () => {
          if (responded) return;
          responded = true;
          resolve({ text: Buffer.concat(chunks).toString('utf8'), partOriginalBytes, didTruncate });
        };

        stdout.on('data', (chunk) => {
          partOriginalBytes += chunk.length;
          if (didTruncate) return;
          const avail = DIFF_CAP_BYTES - localCollected;
          if (chunk.length <= avail) {
            chunks.push(chunk);
            localCollected += chunk.length;
          } else {
            if (avail > 0) chunks.push(chunk.slice(0, avail));
            localCollected = DIFF_CAP_BYTES;
            didTruncate = true;
            abort();
            finish();
          }
        });

        stdout.on('end', finish);
        stdout.on('close', finish);
        stdout.on('error', (err) => {
          if (responded) return;
          responded = true;
          reject(err);
        });
      });

      originalBytes += repoPatch.partOriginalBytes;
      globalCollected += Buffer.byteLength(repoPatch.text, 'utf8');
      if (repoPatch.didTruncate) truncated = true;

      if (repoPatch.text.length > 0) {
        const header = multiRepo ? `# === ${dir.replace('/app/', '')} ===\n` : '';
        patchParts.push(header + repoPatch.text);
      }
    }

    const patch = patchParts.join('');
    const isEmpty = patch.length === 0;
    const status = isEmpty ? 'no-changes' : 'ok';
    res.json({ status, patch, isEmpty, truncated, originalBytes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

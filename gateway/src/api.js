import { Router } from 'express';
import { getAll, getFeature, setActiveFeature, getActiveFeature, unregister, updateStatus } from './registry.js';
import { dockerExec, dockerLogs, stopContainer, startContainer, removeContainer, getContainerStats, inspectContainer, DockerSocketError, DockerContainerError } from './docker.js';

const router = Router();
const startedAt = Date.now();

/**
 * GET /_fleet/api/features
 * Returns all registered features with isActive flag.
 */
router.get('/features', (_req, res) => {
  res.json(getAll());
});

/**
 * GET /_fleet/api/features/:name/health
 * HEAD the container's nginx to check if the full stack is responding.
 */
router.get('/features/:name/health', async (req, res) => {
  const { name } = req.params;

  if (!getFeature(name)) {
    return res.status(404).json({ error: 'Feature not registered' });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const response = await fetch(`http://fleet-${name}:${process.env.PROXY_PORT || 3000}/`, {
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
 * POST /_fleet/api/features/:name/activate
 * Set the active feature for the transparent proxy (PROXY_PORT).
 */
router.post('/features/:name/activate', (req, res) => {
  const { name } = req.params;
  if (!getFeature(name)) {
    return res.status(404).json({ error: 'Feature not registered' });
  }
  try {
    setActiveFeature(name);
    res.json({ ok: true, active: name });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /_fleet/api/features/:name
 * Force-stop and remove the container, then unregister from the registry.
 */
router.delete('/features/:name', async (req, res) => {
  const { name } = req.params;
  if (!getFeature(name)) {
    return res.status(404).json({ error: 'Feature not registered' });
  }
  try {
    await removeContainer(`fleet-${name}`);
  } catch (err) {
    if (err instanceof DockerSocketError) return res.status(503).json({ error: err.message });
    if (err instanceof DockerContainerError && err.status !== 404) {
      return res.status(503).json({ error: err.message });
    }
    // 404 from Docker is fine — container was already gone
  }
  unregister(name);
  res.json({ ok: true });
});

/**
 * POST /_fleet/api/features/:name/open-terminal
 * Opens an iTerm2 window on the Mac host in the feature's local worktree.
 * The gateway is Linux so osascript is forwarded to the host runner at
 * host.docker.internal:4001/run-osascript.
 */
router.post('/features/:name/open-terminal', async (req, res) => {
  const { name } = req.params;
  const feature = getFeature(name);

  if (!feature) {
    return res.status(404).json({ error: 'Feature not registered' });
  }

  const { worktreePath } = feature;
  if (!worktreePath) {
    return res.status(400).json({ error: 'No worktree path recorded for this feature — re-register with fleet add' });
  }

  const script = [
    'tell application "iTerm2"',
    '  activate',
    `  set newWindow to (create window with default profile)`,
    `  tell current session of newWindow`,
    `    write text "cd '${worktreePath}' && claude"`,
    '  end tell',
    'end tell',
  ].join('\n');

  try {
    const response = await fetch('http://host.docker.internal:4001/run-osascript', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script }),
    });
    if (!response.ok) throw new Error(`Host runner returned HTTP ${response.status}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: `Host runner unreachable: ${err.message}` });
  }
});

/**
 * POST /_fleet/api/features/:name/stop
 * Stop the container without removing it from the registry.
 */
router.post('/features/:name/stop', async (req, res) => {
  const { name } = req.params;
  if (!getFeature(name)) return res.status(404).json({ error: 'Feature not registered' });
  try {
    await stopContainer(`fleet-${name}`);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof DockerSocketError) return res.status(503).json({ error: err.message });
    if (err instanceof DockerContainerError) return res.status(err.status === 404 ? 404 : 503).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /_fleet/api/features/:name/start
 * Start a previously stopped container.
 */
router.post('/features/:name/start', async (req, res) => {
  const { name } = req.params;
  if (!getFeature(name)) return res.status(404).json({ error: 'Feature not registered' });
  try {
    await startContainer(`fleet-${name}`);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof DockerSocketError) return res.status(503).json({ error: err.message });
    if (err instanceof DockerContainerError) return res.status(err.status === 404 ? 404 : 503).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /_fleet/api/features/:name/stats
 * Returns a one-shot resource snapshot: CPU %, memory, network I/O.
 */
router.get('/features/:name/stats', async (req, res) => {
  const { name } = req.params;
  if (!getFeature(name)) return res.status(404).json({ error: 'Feature not registered' });
  try {
    const stats = await getContainerStats(`fleet-${name}`);
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
 * GET /_fleet/api/features/:name/logs?source=backend&tail=200&since=0
 * Stream the last N lines of a supervisor log file or combined Docker logs.
 * source: backend | nginx | postgresql | supervisord | all
 */
const ALLOWED_SOURCES = new Set(['backend', 'nginx', 'postgresql', 'supervisord']);

router.get('/features/:name/logs', async (req, res) => {
  const { name } = req.params;

  if (!getFeature(name)) {
    return res.status(404).json({ error: 'Feature not registered' });
  }

  const source = req.query.source || 'backend';
  const tail = Math.min(Math.max(parseInt(req.query.tail) || 200, 1), 2000);
  const since = Math.max(parseInt(req.query.since) || 0, 0);
  const containerName = `fleet-${name}`;

  try {
    let lines;
    if (source === 'all') {
      lines = await dockerLogs(containerName, tail, since);
    } else if (ALLOWED_SOURCES.has(source)) {
      lines = await dockerExec(containerName, ['tail', '-n', String(tail), `/var/log/supervisor/${source}.log`]);
    } else {
      return res.status(400).json({ error: `Invalid source '${source}'. Use: backend, nginx, postgresql, supervisord, all` });
    }
    res.json({ lines, fetchedAt: Date.now() });
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
 * POST /_fleet/api/features/:name/sync
 * Pull latest code, rebuild backend, restart via supervisord.
 * Accepts ?regenerateSources=true to also regenerate jOOQ DSL after Liquibase migrations.
 * Returns immediately (202) — the sync runs inside the container in the background.
 */
router.post('/features/:name/sync', async (req, res) => {
  const { name } = req.params;
  if (!getFeature(name)) {
    return res.status(404).json({ error: 'Feature not registered' });
  }

  const regenerateSources = req.query.regenerateSources === 'true';
  const containerName = `fleet-${name}`;

  res.json({ ok: true, message: 'Sync started — check logs for progress' });

  runSync(containerName, regenerateSources).catch(err => {
    console.error(`[sync] ${name}: ${err.message}`);
  });
});

/**
 * Run the sync sequence inside a feature container:
 *   git pull → [jOOQ codegen] → mvn build → copy JAR → supervisorctl restart
 * @param {string} containerName
 * @param {boolean} regenerateSources
 */
async function runSync(containerName, regenerateSources) {
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
    'git pull --ff-only',
  ];
  if (regenerateSources) {
    steps.push('mvn compile -Pjooq-codegen -q');
  }
  steps.push(buildCmd);
  const artifactPath = process.env.BACKEND_ARTIFACT_PATH || '/home/developer/backend.jar';
  steps.push(`ls target/*.jar && cp target/*.jar ${artifactPath}`);
  steps.push('supervisorctl restart backend');

  await dockerExec(containerName, ['bash', '-c', steps.join(' && ')]);
}

/**
 * PATCH /_fleet/api/features/:name/status
 * Update the status of a feature (e.g., from not_started to running).
 */
router.patch('/features/:name/status', (req, res) => {
  const { name } = req.params;
  const { status } = req.body;
  if (!getFeature(name)) {
    return res.status(404).json({ error: 'Feature not registered' });
  }
  if (!status || typeof status !== 'string') {
    return res.status(400).json({ error: 'status field required' });
  }
  try {
    updateStatus(name, status);
    res.json({ ok: true, name, status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import express, { Router } from 'express';
import { getAll, getFeature, setActiveFeature, getActiveFeature, unregister, updateStatus, appendBuildLog, getBuildLog, subscribeBuildLog } from './registry.js';
import { dockerExec, dockerLogs, stopContainer, startContainer, removeContainer, getContainerStats, inspectContainer, DockerSocketError, DockerContainerError } from './docker.js';
import { ensureMainRunning } from './lifecycle.js';

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

    const response = await fetch(`http://fleet-${name}:80/`, {
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
 * POST /_fleet/api/main/ensure
 * Ensure fleet-main is running — idempotent; safe to call at any time.
 * 404 if the container does not exist (fleet add main --direct first).
 */
router.post('/main/ensure', async (_req, res) => {
  try {
    const info = await inspectContainer('fleet-main');
    if (!info) {
      return res.status(404).json({ error: 'fleet-main container not found — run `fleet add main --direct` first' });
    }
    await ensureMainRunning();
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof DockerSocketError) return res.status(503).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /_fleet/api/doctor/:name
 * Defense-in-depth check that no internal-only supervisord peer ports
 * (jira-proxy 8081, wiremock 8089) are accidentally published to the host.
 *
 * Returns { exposed: number[], ok: boolean }.
 *   - exposed: container-internal ports that are bound to a host port AND
 *     match the forbidden list.
 *   - ok: exposed.length === 0.
 */
const FORBIDDEN_INTERNAL_PORTS = [8081, 8089];

router.get('/doctor/:name', async (req, res) => {
  const { name } = req.params;
  try {
    const info = await inspectContainer(`fleet-${name}`);
    if (!info) return res.status(404).json({ error: `Container fleet-${name} not found` });

    const ports = info.NetworkSettings?.Ports ?? {};
    const exposed = [];
    for (const [key, bindings] of Object.entries(ports)) {
      // key is "8081/tcp" etc.
      const portNum = parseInt(key.split('/')[0], 10);
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
  steps.push('supervisorctl restart all');

  await dockerExec(containerName, ['bash', '-c', steps.join(' && ')]);
}

/**
 * POST /_fleet/api/features/:name/rebuild
 * Rebuild the Docker base image and recreate the container from scratch.
 * Returns immediately (202) — the rebuild runs in the background.
 */
router.post('/features/:name/rebuild', async (req, res) => {
  const { name } = req.params;
  if (!getFeature(name)) {
    return res.status(404).json({ error: 'Feature not registered' });
  }

  res.json({ ok: true, message: 'Rebuild started — check logs for progress' });

  runRebuild(name).catch(err => {
    console.error(`[rebuild] ${name}: ${err.message}`);
  });
});

/**
 * Run a host-level docker build + docker compose up -d to rebuild a feature
 * from scratch. Streams stdout/stderr to the feature's build-log ring buffer.
 *
 * Sequence:
 *   1. PATCH status → 'building'
 *   2. docker stop fleet-<name>        (ignore "already stopped")
 *   3. docker build --load -t <image> -f <dockerfile> <FLEET_ROOT>
 *   4. docker compose -f <composefile> up -d
 *   5. PATCH status → 'starting'
 *   6. Poll /_fleet/api/features/:name/health every 2s, up to 60s
 *   7. On healthy → PATCH status 'running'; on timeout → PATCH 'failed'
 *
 * @param {string} name  feature name (without the 'fleet-' prefix)
 * @returns {Promise<void>}
 */
async function runRebuild(name) {
  const FLEET_PROJECT_ROOT = process.env.FLEET_PROJECT_ROOT;
  const FLEET_ROOT = process.env.FLEET_ROOT;

  if (!FLEET_PROJECT_ROOT || !FLEET_ROOT) {
    throw new Error('FLEET_PROJECT_ROOT and FLEET_ROOT must be set in the gateway environment');
  }

  // Step 1 — mark as building (resets build-log ring buffer)
  updateStatus(name, 'building', null);

  const log = (line) => appendBuildLog(name, line);
  log(`[rebuild] Starting rebuild for '${name}'`);

  // Step 2 — resolve paths
  const composeFile = path.join(FLEET_PROJECT_ROOT, '.fleet', name, 'docker-compose.yml');

  // Extract image name from compose file (line like `    image: fleet-feature-base-myproject`)
  let imageName;
  try {
    const composeContent = fs.readFileSync(composeFile, 'utf8');
    const imageMatch = composeContent.match(/^\s+image:\s+(.+)$/m);
    if (!imageMatch) {
      throw new Error(`No 'image:' line found in ${composeFile}`);
    }
    imageName = imageMatch[1].trim();
  } catch (err) {
    updateStatus(name, 'failed', `rebuild: could not read compose file: ${err.message}`);
    throw err;
  }

  // Resolve Dockerfile: project-local first, fallback to FLEET_ROOT
  const projectDockerfile = path.join(FLEET_PROJECT_ROOT, '.fleet', 'Dockerfile.feature-base');
  const globalDockerfile = path.join(FLEET_ROOT, 'Dockerfile.feature-base');
  const dockerfile = fs.existsSync(projectDockerfile) ? projectDockerfile : globalDockerfile;

  if (!fs.existsSync(dockerfile)) {
    const msg = `rebuild: Dockerfile not found at ${projectDockerfile} or ${globalDockerfile}`;
    updateStatus(name, 'failed', msg);
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
    log(`[rebuild] Stopping fleet-${name}...`);
    try {
      await stopContainer(`fleet-${name}`);
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
    await runCommand('docker', [
      'compose', '-f', composeFile, 'up', '-d',
    ]);

    // Step 6 — transition to starting
    updateStatus(name, 'starting', null);
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
        const response = await fetch(`http://fleet-${name}:80/`, {
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
      updateStatus(name, 'running', null);
      log(`[rebuild] Rebuild complete — '${name}' is running`);
    } else {
      const msg = `Health wait timed out after ${HEALTH_MAX_MS / 1000}s`;
      updateStatus(name, 'failed', msg);
      log(`[rebuild] ERROR: ${msg}`);
      throw new Error(msg);
    }
  } catch (err) {
    // Guard against double-setting failed (health timeout already set it above)
    const current = getFeature(name);
    if (current && current.status !== 'failed') {
      updateStatus(name, 'failed', err.message);
    }
    log(`[rebuild] ERROR: ${err.message}`);
    throw err;
  }
}

/**
 * PATCH /_fleet/api/features/:name/status
 * Update the lifecycle status of a feature — used by `fleet add` to emit
 * building → starting → running transitions, or failed on an error.
 *
 * Body: { status: string, error?: string|null }
 *   - error is optional. If omitted the previous error field is preserved
 *     (transitions away from 'failed' do not need to clear it explicitly).
 *     Pass null to clear. Pass a string (typically with status='failed').
 */
router.patch('/features/:name/status', (req, res) => {
  const { name } = req.params;
  const { status, error } = req.body;
  if (!getFeature(name)) {
    return res.status(404).json({ error: 'Feature not registered' });
  }
  if (!status || typeof status !== 'string') {
    return res.status(400).json({ error: 'status field required' });
  }
  if (error !== undefined && error !== null && typeof error !== 'string') {
    return res.status(400).json({ error: 'error field must be a string or null' });
  }
  try {
    updateStatus(name, status, error);
    res.json({ ok: true, name, status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /_fleet/api/features/:name/build-log
 * Accepts a plain-text chunk (Content-Type: text/plain) and appends it to the
 * in-memory ring buffer for the feature. Called by `fleet add` to stream
 * docker compose build output into the gateway for SSE fan-out.
 */
router.post('/features/:name/build-log', express.text({ type: 'text/plain', limit: '1mb' }), (req, res) => {
  const { name } = req.params;
  if (!getFeature(name)) {
    return res.status(404).json({ error: 'Feature not registered' });
  }
  const body = typeof req.body === 'string' ? req.body : '';
  if (body.length > 0) appendBuildLog(name, body);
  res.json({ ok: true });
});

/**
 * GET /_fleet/api/features/:name/build-log
 * Server-Sent Events stream of build log lines for a feature.
 * Replays all buffered lines on connect, then pushes new lines as they arrive.
 * Sends a keepalive comment every 15 s to prevent proxy timeouts.
 */
router.get('/features/:name/build-log', (req, res) => {
  const { name } = req.params;
  if (!getFeature(name)) {
    return res.status(404).json({ error: 'Feature not registered' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Replay buffered lines
  const existing = getBuildLog(name);
  if (existing && existing.lines.length > 0) {
    for (const line of existing.lines) {
      res.write(`data: ${line}\n\n`);
    }
  }

  // Subscribe to new lines
  const unsubscribe = subscribeBuildLog(name, (line) => {
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

export default router;

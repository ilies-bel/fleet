import { listRunningContainers, inspectContainer, startContainer } from './docker.js';
import { register, isRegistered } from './registry.js';

const GATEWAY_NAME = 'fleet-gateway';

/**
 * At startup, scan Docker for all fleet-* containers (running or stopped),
 * start any that are stopped, and register them.
 *
 * Container name format: `fleet-<project>-<name>`
 * Recovers PROJECT_NAME from container env (set by `fleet add`), NAME from env,
 * BRANCH from env, WORKTREE_PATH from the /app bind mount.
 *
 * Containers that lack a PROJECT_NAME env var are skipped with a warning —
 * they were created by an old CLI that predates composite keys.
 */
export async function reconcileFromDocker() {
  let containers;
  try {
    containers = await listRunningContainers('fleet-', { all: true });
  } catch (err) {
    console.warn('[reconcile] Docker unavailable, skipping:', err.message);
    return;
  }

  const qaContainers = containers.filter((c) =>
    c.Names.some((n) => {
      const bare = n.replace(/^\//, '');
      return /^fleet-[a-z0-9]([a-z0-9-]*(\.[a-z0-9-]+)*)?$/.test(bare) && bare !== GATEWAY_NAME;
    })
  );

  if (qaContainers.length === 0) {
    console.log('[reconcile] No feature containers found.');
    return;
  }

  let registered = 0;
  for (const container of qaContainers) {
    const containerName = container.Names[0].replace(/^\//, '');

    // Start stopped/created containers so the proxy can reach them
    if (container.State !== 'running') {
      try {
        await startContainer(containerName);
        console.log(`[reconcile] started: ${containerName}`);
      } catch (err) {
        console.warn(`[reconcile] could not start ${containerName}:`, err.message);
        continue;
      }
    }

    const info = await inspectContainer(containerName);
    if (!info) continue;

    const env = Object.fromEntries(
      (info.Config?.Env ?? [])
        .map((e) => e.split('='))
        .filter(([k]) => k)
        .map(([k, ...rest]) => [k, rest.join('=')])
    );

    const project = env.PROJECT_NAME;
    if (!project) {
      console.warn(`[reconcile] skipping ${containerName}: no PROJECT_NAME env — old CLI container`);
      continue;
    }

    const name = env.FEATURE_NAME ?? containerName.replace(/^fleet-/, '').replace(new RegExp(`^${project}-`), '');
    const key = `${project}-${name}`;

    if (isRegistered(key)) continue;

    const branch = env.BRANCH ?? 'unknown';
    const appMount = (info.Mounts ?? []).find(
      (m) => m.Type === 'bind' && m.Destination === '/app'
    );
    const worktreePath = appMount?.Source ?? null;

    // Derive lifecycle status from live Docker state rather than defaulting
    // to 'running'. A container that exited during a crashed `fleet add` must
    // NOT be reported as running — that was the root cause of the "FAILED
    // shows UP (and vice versa) after gateway restart" bug.
    const isRunning = info.State?.Running === true;
    const status = isRunning ? 'up' : 'stopped';

    register(project, name, branch, worktreePath, status);
    registered++;
    console.log(`[reconcile] restored: ${key} (branch: ${branch}, status: ${status})`);
  }

  console.log(`[reconcile] ${registered} feature(s) restored.`);
}

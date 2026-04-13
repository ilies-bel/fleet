import { listRunningContainers, inspectContainer, startContainer } from './docker.js';
import { register, isRegistered } from './registry.js';

const GATEWAY_NAME = 'qa-gateway-container';

/**
 * At startup, scan Docker for all qa-* containers (running or stopped),
 * start any that are stopped, and register them.
 * Recovers NAME and BRANCH from container env, WORKTREE_PATH from the /app bind mount.
 */
export async function reconcileFromDocker() {
  let containers;
  try {
    containers = await listRunningContainers('qa-', { all: true });
  } catch (err) {
    console.warn('[reconcile] Docker unavailable, skipping:', err.message);
    return;
  }

  const qaContainers = containers.filter((c) =>
    c.Names.some((n) => {
      const bare = n.replace(/^\//, '');
      return /^qa-[a-z0-9-]+$/.test(bare) && bare !== GATEWAY_NAME;
    })
  );

  if (qaContainers.length === 0) {
    console.log('[reconcile] No feature containers found.');
    return;
  }

  let registered = 0;
  for (const container of qaContainers) {
    const containerName = container.Names[0].replace(/^\//, '');
    const name = containerName.replace(/^qa-/, '');

    if (isRegistered(name)) continue;

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

    const branch = env.BRANCH ?? 'unknown';
    const project = env.PROJECT_NAME ?? null;
    const appMount = (info.Mounts ?? []).find(
      (m) => m.Type === 'bind' && m.Destination === '/app'
    );
    const worktreePath = appMount?.Source ?? null;

    register(name, branch, worktreePath, project);
    registered++;
    console.log(`[reconcile] restored: ${name} (branch: ${branch})`);
  }

  console.log(`[reconcile] ${registered} feature(s) restored.`);
}

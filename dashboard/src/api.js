/**
 * Fetch wrapper — all paths relative, no hardcoded host.
 * Throws on non-2xx with the response body as the error message.
 */

async function request(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const text = await res.text();
    let msg;
    try {
      const body = JSON.parse(text);
      msg = body.error ?? JSON.stringify(body);
    } catch {
      msg = text;
    }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res.json();
}

/** @returns {Promise<Array>} */
export function getFeatures() {
  return request('/_qa/api/features');
}

/**
 * @param {string} name
 * @param {string} branch
 * @returns {Promise<object>}
 */
export function addFeature(name, branch) {
  return request('/_qa/api/features', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, branch }),
  });
}

/**
 * @param {string} name
 * @returns {Promise<{ ok: boolean, active: string }>}
 */
export function activateFeature(name) {
  return request(`/_qa/api/features/${name}/activate`, { method: 'POST' });
}

/**
 * @param {string} name
 * @returns {Promise<object>}
 */
export function removeFeature(name) {
  return request(`/_qa/api/features/${name}`, { method: 'DELETE' });
}

/**
 * @param {string} name
 * @returns {Promise<{ status: 'up'|'down' }>}
 */
export function getHealth(name) {
  return request(`/_qa/api/features/${name}/health`);
}

/**
 * Open an iTerm2 tab with a shell inside the feature container.
 * @param {string} name
 * @returns {Promise<{ ok: boolean, containerName: string }>}
 */
export function openTerminal(name) {
  return request(`/_qa/api/features/${name}/open-terminal`, { method: 'POST' });
}

/** @returns {Promise<{ uptimeMs: number, featureCount: number, activeFeature: string|null, nodeVersion: string }>} */
export function getStatus() {
  return request('/_qa/api/status');
}

/**
 * @param {string} name
 * @param {{ source?: string, tail?: number, since?: number }} opts
 * @returns {Promise<
 *   | { lines: string, fetchedAt: number }
 *   | { sources: { backend: string, nginx: string, postgresql: string, supervisord: string }, fetchedAt: number }
 * >}
 */
export function getLogs(name, { source = 'backend', tail = 200, since = 0 } = {}) {
  const params = new URLSearchParams({ source, tail });
  // 'since' is only meaningful for per-source streaming (not used by source=all)
  if (source !== 'all' && since) params.set('since', since);
  return request(`/_qa/api/features/${name}/logs?${params}`);
}

/** @param {string} name */
export function stopFeature(name) {
  return request(`/_qa/api/features/${name}/stop`, { method: 'POST' });
}

/** @param {string} name */
export function startFeature(name) {
  return request(`/_qa/api/features/${name}/start`, { method: 'POST' });
}

/**
 * @param {string} name
 * @returns {Promise<{ cpuPercent: number, memUsageMB: number, memLimitMB: number, netRxMB: number, netTxMB: number }>}
 */
export function getStats(name) {
  return request(`/_qa/api/features/${name}/stats`);
}

/**
 * Pull latest code, rebuild and restart the backend.
 * Returns immediately (202) — sync runs in background inside the container.
 * @param {string} name
 * @param {{ regenerateSources?: boolean }} opts
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export function syncFeature(name, { regenerateSources = false } = {}) {
  const params = regenerateSources ? '?regenerateSources=true' : '';
  return request(`/_qa/api/features/${name}/sync${params}`, { method: 'POST' });
}

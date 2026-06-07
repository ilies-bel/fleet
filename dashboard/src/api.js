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
  return request('/_fleet/api/features');
}

/**
 * @param {string} key  Composite key: "<project>-<name>"
 * @returns {Promise<{ ok: boolean, active: string }>}
 */
export function activateFeature(key) {
  return request(`/_fleet/api/features/${key}/activate`, { method: 'POST' });
}

/**
 * @param {string} key  Composite key: "<project>-<name>"
 * @returns {Promise<object>}
 */
export function removeFeature(key) {
  return request(`/_fleet/api/features/${key}`, { method: 'DELETE' });
}

/**
 * @param {string} key  Composite key: "<project>-<name>"
 * @returns {Promise<{ status: 'up'|'down' }>}
 */
export function getHealth(key) {
  return request(`/_fleet/api/features/${key}/health`);
}

/**
 * @param {string} key  Composite key: "<project>-<name>"
 * @returns {Promise<{ services: Array<{ name: string, port: number, status: 'up'|'down' }> }>}
 */
export function getServicesHealth(key) {
  return request(`/_fleet/api/features/${key}/services/health`);
}

/** @returns {Promise<{ uptimeMs: number, featureCount: number, activeFeature: string|null, nodeVersion: string }>} */
export function getStatus() {
  return request('/_fleet/api/status');
}

/**
 * @param {string} key  Composite key: "<project>-<name>"
 * @param {{ source?: string, tail?: number, since?: number }} opts
 * @returns {Promise<
 *   | { lines: string, fetchedAt: number }
 *   | { sources: { backend: string, nginx: string, postgresql: string, supervisord: string }, fetchedAt: number }
 * >}
 */
export function getLogs(key, { source = 'backend', tail = 200, since = 0 } = {}) {
  const params = new URLSearchParams({ source, tail });
  // 'since' is only meaningful for per-source streaming (not used by source=all)
  if (source !== 'all' && since) params.set('since', since);
  return request(`/_fleet/api/features/${key}/logs?${params}`);
}

/**
 * @param {string} key  Composite key: "<project>-<name>"
 */
export function stopFeature(key) {
  return request(`/_fleet/api/features/${key}/stop`, { method: 'POST' });
}

/**
 * @param {string} key  Composite key: "<project>-<name>"
 */
export function startFeature(key) {
  return request(`/_fleet/api/features/${key}/start`, { method: 'POST' });
}

/**
 * @param {string} key  Composite key: "<project>-<name>"
 * @returns {Promise<{ cpuPercent: number, memUsageMB: number, memLimitMB: number, netRxMB: number, netTxMB: number }>}
 */
export function getStats(key) {
  return request(`/_fleet/api/features/${key}/stats`);
}

/**
 * Pull latest code, rebuild and restart the backend.
 * Returns immediately (202) — sync runs in background inside the container.
 * @param {string} key  Composite key: "<project>-<name>"
 * @param {{ regenerateSources?: boolean }} opts
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export function syncFeature(key, { regenerateSources = false } = {}) {
  const params = regenerateSources ? '?regenerateSources=true' : '';
  return request(`/_fleet/api/features/${key}/sync${params}`, { method: 'POST' });
}

/** @returns {Promise<{cpuPercent:number,cpuCores:number,memTotalMB:number,memFreeMB:number,memUsedMB:number}>} */
export function getHostStats() {
  return request('/_fleet/api/host-stats');
}

/**
 * Fetch recent gateway operations (activate events etc.) from the log store.
 * @returns {Promise<Array<{id,kind,key,startedAt,endedAt,outcome,errorMessage,reasonCode}>>}
 */
export function fetchOperations() {
  return request('/_fleet/api/operations');
}

/**
 * Fetch a single operation with its full event timeline.
 * The operation object includes reasonCode for failed operations.
 * @param {number} id  Operation id
 * @returns {Promise<{operation:{id,kind,key,startedAt,endedAt,outcome,errorMessage,reasonCode}, events:Array<{id,ts,level,message}>}>}
 */
export function fetchOperation(id) {
  return request(`/_fleet/api/operations/${id}`);
}

/**
 * Fetch failure clusters grouped by reason_code.
 * @param {{ sinceHours?: number }} opts
 * @returns {Promise<Array<{reasonCode,count,lastSeenAt,sampleKeys}>>}
 */
export function fetchFailureClusters({ sinceHours = 24 } = {}) {
  const params = sinceHours !== 24 ? `?sinceHours=${sinceHours}` : '';
  return request(`/_fleet/api/operations/failures/clustered${params}`);
}

/**
 * Fetch the full git diff of a feature's worktree against the merge-base of main.
 * @param {string} key  Composite key: "<project>-<name>"
 * @returns {Promise<{
 *   status: 'ok' | 'no-changes' | 'unavailable',
 *   patch: string,
 *   isEmpty: boolean,
 *   truncated?: boolean,
 *   originalBytes?: number,
 *   reason?: string,
 * }>}
 */
export function getDiff(key) {
  return request(`/_fleet/api/features/${key}/diff`);
}

/**
 * Rename a feature's display title.
 * The new title is persisted to the gateway's title store and survives restarts.
 * @param {string} key    Composite key: "<project>-<name>"
 * @param {string|null} title  New display title, or null to clear
 * @returns {Promise<{ ok: boolean, key: string, title: string|null }>}
 */
export function renameFeature(key, title) {
  return request(`/_fleet/api/features/${key}/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
}

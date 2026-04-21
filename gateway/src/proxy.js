import { createProxyMiddleware, debugProxyErrorsPlugin, proxyEventsPlugin } from 'http-proxy-middleware';
import { getActiveFeature, getContainerStatus, updateStatus } from './registry.js';

/**
 * Transparent proxy middleware for PROXY_PORT (3000).
 *
 * Post mono-container pivot each feature runs as a single `fleet-NAME` container
 * with nginx listening on :80. Internal path fan-out to backend/frontend/peers is
 * handled by nginx inside the container — the gateway forwards everything verbatim.
 *
 * Returns 503 when no feature is active or the active feature's container is not
 * running (lazy liveness check on every request). Returns 502 on upstream
 * connection errors for a container that is running but refusing connections.
 *
 * ejectPlugins: true — skips http-proxy-middleware's default loggerPlugin which
 * crashes with TypeError: ERR_INVALID_URL when options.target is undefined (router:
 * only config). We re-add debugProxyErrorsPlugin and proxyEventsPlugin explicitly
 * to retain error propagation and proxy event wiring. See issue #1035.
 *
 * @returns {import('express').RequestHandler}
 */
export function createFeatureProxy() {
  const proxy = createProxyMiddleware({
    router: (req) => {
      // By the time the router runs, the outer wrapper has already verified the
      // container is running and stored the name on req._fleetFeature.
      return `http://fleet-${req._fleetFeature}:80`;
    },
    changeOrigin: true,
    ejectPlugins: true,
    plugins: [debugProxyErrorsPlugin, proxyEventsPlugin],
    on: {
      proxyReq: (proxyReq, req) => {
        if (req._fleetFeature) proxyReq.setHeader('X-Fleet-Feature', req._fleetFeature);
      },
      proxyRes: (proxyRes) => {
        // Prevent browser from caching responses across feature switches
        proxyRes.headers['cache-control'] = 'no-store';
        delete proxyRes.headers['etag'];
        delete proxyRes.headers['last-modified'];
      },
      error: (_err, _req, res) => {
        if (!res.headersSent)
          res.status(502).json({ error: 'Active feature container unreachable' });
      },
    },
  });

  return async (req, res, next) => {
    const resolved = await resolveTarget();
    if (!resolved.ok) {
      return res.status(503).send(resolved.body);
    }
    req._fleetFeature = resolved.feature;
    return proxy(req, res, next);
  };
}

/**
 * Resolve which feature should serve a request, applying main fallback.
 *
 * Resolution order:
 *   1. Active feature is running → use it.
 *   2. Active feature is stopped → update registry, try main.
 *   3. No active feature → try main.
 *   4. main is not running → 503.
 *
 * @returns {Promise<{ ok: true, feature: string } | { ok: false, body: string }>}
 */
export async function resolveTarget() {
  const selected = getActiveFeature();

  if (selected) {
    const status = await getContainerStatus(selected);
    if (status === 'running') {
      return { ok: true, feature: selected };
    }
    // Sync registry so the dashboard reflects reality
    updateStatus(selected, 'stopped');
  }

  // Fallback: try main
  const mainStatus = await getContainerStatus('main');
  if (mainStatus === 'running') {
    return { ok: true, feature: 'main' };
  }

  return { ok: false, body: stoppedContainerBody('main') };
}

/**
 * Build the 503 HTML response body for a stopped/missing container.
 * Exported so tests can assert on the exact HTML without spinning a server.
 * @param {string} name  feature name (without 'fleet-' prefix)
 * @returns {string}
 */
export function stoppedContainerBody(name) {
  return (
    '<html><body style="font-family:monospace;background:#0a0a0a;color:#888;padding:2rem">' +
    '<h2 style="color:#ff4444">// FEATURE CONTAINER NOT RUNNING</h2>' +
    `<p>Container <code style="color:#ffaa00">fleet-${name}</code> is not running.</p>` +
    '<p>Remediation options:</p>' +
    '<ul>' +
    `<li>Start it: <code style="color:#00ff88">docker start fleet-${name}</code></li>` +
    '<li>Or activate a different feature at <a href="http://localhost:4000" style="color:#00ff88">localhost:4000</a></li>' +
    '</ul>' +
    '</body></html>'
  );
}

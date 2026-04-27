import { createProxyMiddleware, debugProxyErrorsPlugin, proxyEventsPlugin } from 'http-proxy-middleware';
import { getActiveFeature, getContainerStatus, getFeature, updateStatus } from './registry.js';

/**
 * Transparent proxy middleware for PROXY_PORT (3000).
 *
 * Each feature runs as a single `fleet-<project>-<name>` container with nginx
 * listening on :80. Internal path fan-out to backend/frontend/peers is handled
 * by nginx inside the container — the gateway forwards everything verbatim.
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
 * The returned function also carries an `.upgrade` property so the caller can
 * wire it to the http.Server 'upgrade' event for WebSocket (HMR) support:
 *
 *   const featureProxy = createFeatureProxy();
 *   server.on('upgrade', featureProxy.upgrade);
 *
 * @returns {import('express').RequestHandler & { upgrade: Function }}
 */
export function createFeatureProxy() {
  const proxy = createProxyMiddleware({
    ws: true,
    router: async (req) => {
      // Resolve the active feature fresh on every request/upgrade. Works for
      // both the HTTP middleware path and http-proxy-middleware's auto-wired
      // WebSocket upgrade listener (which does NOT run the outer handler).
      const resolved = await resolveTarget();
      if (!resolved.ok) return undefined;
      req._fleetFeature = resolved.key;
      return `http://fleet-${resolved.key}:80`;
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
      error: (_err, _req, resOrSocket) => {
        // For WebSocket upgrades, http-proxy passes the raw net.Socket here
        // instead of an Express response. Detect by the absence of `status`.
        if (resOrSocket && typeof resOrSocket.status === 'function') {
          if (!resOrSocket.headersSent)
            resOrSocket.status(502).json({ error: 'Active feature container unreachable' });
          return;
        }
        if (resOrSocket && typeof resOrSocket.destroy === 'function') {
          try {
            if (resOrSocket.writable) {
              resOrSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            }
          } catch {
            // socket may already be half-closed
          }
          resOrSocket.destroy();
        }
      },
    },
  });

  const handler = async (req, res, next) => {
    const resolved = await resolveTarget();
    if (!resolved.ok) {
      return res.status(503).send(resolved.body);
    }
    req._fleetFeature = resolved.key;
    return proxy(req, res, next);
  };

  /**
   * WebSocket upgrade handler — wire to http.Server 'upgrade' event.
   * Resolves the active feature, attaches it to the request, then delegates
   * to http-proxy-middleware's built-in upgrade handler. Falls back to a
   * minimal HTTP 503 response and socket destroy when no container is running.
   *
   * @param {import('http').IncomingMessage} req
   * @param {import('net').Socket} socket
   * @param {Buffer} head
   */
  const upgrade = async (req, socket, head) => {
    const resolved = await resolveTarget();
    if (!resolved.ok) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    req._fleetFeature = resolved.key;
    proxy.upgrade(req, socket, head);
  };

  return Object.assign(handler, { upgrade });
}

/**
 * Resolve which feature should serve a request.
 *
 * Resolution order:
 *   1. Active feature is running → use it.
 *   2. Active feature is stopped → update registry, return 503.
 *   3. No active feature → return 503.
 *
 * The `key` in the success shape is the composite registry key (= the
 * Docker container name suffix, i.e. `fleet-${key}` is the container).
 *
 * @returns {Promise<{ ok: true, key: string } | { ok: false, body: string }>}
 */
export async function resolveTarget() {
  const selected = getActiveFeature();

  if (selected) {
    const status = await getContainerStatus(selected);
    if (status === 'running') {
      // Upgrade stale registry status back to 'up' when Docker reports the
      // container is actually running. Fixes the inverse of the bug below:
      // a container marked 'failed' from a previous crashed `fleet add` that
      // later became healthy was never reverted by the in-memory registry.
      const entry = getFeature(selected);
      if (entry && entry.status !== 'up') {
        updateStatus(selected, 'up', null);
      }
      return { ok: true, key: selected };
    }
    // Sync registry so the dashboard reflects reality.
    // Guard against the TOCTOU race: `selected` was captured at the top of
    // this function but another handler (DELETE /register-feature, teardown)
    // may have called unregister(selected) between that read and here, which
    // causes updateStatus() to throw "Feature is not registered" — killing the
    // gateway process. If the feature is already gone the container is
    // definitively gone too; returning a 503 is correct in both cases.
    if (getFeature(selected)) {
      updateStatus(selected, 'stopped');
    }
    return { ok: false, body: stoppedContainerBody(selected) };
  }

  return { ok: false, body: noActiveFeatureBody() };
}

/**
 * Build the 503 HTML response body when no feature is active for any project.
 * @returns {string}
 */
export function noActiveFeatureBody() {
  return (
    '<html><body style="font-family:monospace;background:#0a0a0a;color:#888;padding:2rem">' +
    '<h2 style="color:#ff4444">// NO ACTIVE FEATURE</h2>' +
    '<p>No feature is currently active.</p>' +
    '<p>Pick one in the dashboard at <a href="http://localhost:4000" style="color:#00ff88">localhost:4000</a>, ' +
    'or spin one up: <code style="color:#00ff88">fleet add &lt;name&gt;</code>.</p>' +
    '</body></html>'
  );
}

/**
 * Build the 503 HTML response body for a stopped/missing container.
 * Exported so tests can assert on the exact HTML without spinning a server.
 * @param {string} key  composite key (without 'fleet-' prefix)
 * @returns {string}
 */
export function stoppedContainerBody(key) {
  return (
    '<html><body style="font-family:monospace;background:#0a0a0a;color:#888;padding:2rem">' +
    '<h2 style="color:#ff4444">// FEATURE CONTAINER NOT RUNNING</h2>' +
    `<p>Container <code style="color:#ffaa00">fleet-${key}</code> is not running.</p>` +
    '<p>Remediation options:</p>' +
    '<ul>' +
    `<li>Start it: <code style="color:#00ff88">docker start fleet-${key}</code></li>` +
    '<li>Or activate a different feature at <a href="http://localhost:4000" style="color:#00ff88">localhost:4000</a></li>' +
    '</ul>' +
    '</body></html>'
  );
}

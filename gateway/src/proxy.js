import { createProxyMiddleware } from 'http-proxy-middleware';
import { getActiveFeature } from './registry.js';

/**
 * Transparent proxy middleware for PROXY_PORT (3000).
 *
 * Post mono-container pivot each feature runs as a single `fleet-NAME` container
 * with nginx listening on :80. Internal path fan-out to backend/frontend/peers is
 * handled by nginx inside the container — the gateway forwards everything verbatim.
 *
 * Returns 503 when no feature is active, 502 on upstream connection errors.
 *
 * @returns {import('express').RequestHandler}
 */
export function createFeatureProxy() {
  const proxy = createProxyMiddleware({
    router: (req) => {
      const name = getActiveFeature();
      return name ? `http://fleet-${name}:80` : null;
    },
    changeOrigin: true,
    on: {
      proxyReq: (proxyReq) => {
        const name = getActiveFeature();
        if (name) proxyReq.setHeader('X-Fleet-Feature', name);
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

  return (req, res, next) => {
    const feature = getActiveFeature();
    if (!feature) {
      return res.status(503).send(
        '<html><body style="font-family:monospace;background:#0a0a0a;color:#888;padding:2rem">' +
        '<h2 style="color:#00ff88">// NO ACTIVE FEATURE</h2>' +
        '<p>Open the dashboard at <a href="http://localhost:4000" style="color:#00ff88">localhost:4000</a> and activate a feature.</p>' +
        '</body></html>'
      );
    }
    return proxy(req, res, next);
  };
}

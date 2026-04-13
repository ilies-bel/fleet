import { createProxyMiddleware } from 'http-proxy-middleware';
import { getActiveFeature } from './registry.js';

/**
 * Transparent proxy middleware for port 3000.
 * Forwards ALL traffic to the currently active feature container with no path manipulation.
 * Returns 503 when no feature is active, 502 when the active container is unreachable.
 *
 * @returns {import('express').RequestHandler}
 */
export function createFeatureProxy() {
  const proxy = createProxyMiddleware({
    router: () => {
      const name = getActiveFeature();
      return name ? `http://qa-${name}:3000` : null;
    },
    changeOrigin: true,
    on: {
      proxyReq: (proxyReq) => {
        const name = getActiveFeature();
        if (name) proxyReq.setHeader('X-QA-Feature', name);
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
    if (!getActiveFeature()) {
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

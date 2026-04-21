import { createProxyMiddleware, debugProxyErrorsPlugin, proxyEventsPlugin } from 'http-proxy-middleware';
import { resolveTarget, stoppedContainerBody } from './proxy.js';

/**
 * Transparent proxy middleware for BACKEND_PORT (default 8080).
 *
 * Mirrors createFeatureProxy() but targets the backend via the container's own
 * nginx /backend/ rewrite (config/nginx.conf.tmpl forwards /backend/* →
 * 127.0.0.1:<backend-port>). This keeps Spring's routing untouched: a client
 * hits localhost:8080/api/tickets → gateway prepends /backend → nginx strips
 * /backend → Spring sees /api/tickets.
 *
 * Target resolution is delegated to proxy.js#resolveTarget so both :3000 and
 * :8080 share the same "selected feature, else main, else 503" semantics.
 *
 * @returns {import('express').RequestHandler}
 */
export function createBackendProxy() {
  const proxy = createProxyMiddleware({
    router: (req) => `http://fleet-${req._fleetFeature}:80`,
    changeOrigin: true,
    ejectPlugins: true,
    plugins: [debugProxyErrorsPlugin, proxyEventsPlugin],
    on: {
      proxyReq: (proxyReq, req) => {
        // Prepend /backend so the container's nginx routes to the backend
        // service. Preserves query strings (req.url carries them).
        const incoming = req.url || '/';
        proxyReq.path = '/backend' + (incoming.startsWith('/') ? incoming : '/' + incoming);
        if (req._fleetFeature) proxyReq.setHeader('X-Fleet-Feature', req._fleetFeature);
      },
      proxyRes: (proxyRes) => {
        proxyRes.headers['cache-control'] = 'no-store';
        delete proxyRes.headers['etag'];
        delete proxyRes.headers['last-modified'];
      },
      error: (_err, _req, res) => {
        if (!res.headersSent)
          res.status(502).json({ error: 'Backend container unreachable' });
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

// Re-exported for symmetry / tests that want to assert on the 503 body.
export { stoppedContainerBody };

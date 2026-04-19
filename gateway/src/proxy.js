import { createProxyMiddleware } from 'http-proxy-middleware';
import { getActiveFeature, getServices } from './registry.js';

/**
 * Split a request URL into { service, rest } where `service` matches one of the
 * registered services for the active feature and `rest` is the remaining path
 * to forward. Falls back to the preferred service (frontend, else first) when
 * no service prefix matches — that service receives the original path.
 *
 * Examples (services = [{backend,8081},{frontend,5173},{jira-proxy,8081}]):
 *   '/backend/actuator/health'     -> { service: backend,    rest: '/actuator/health' }
 *   '/jira-proxy/actuator/health'  -> { service: jira-proxy, rest: '/actuator/health' }
 *   '/frontend/assets/app.js'      -> { service: frontend,   rest: '/assets/app.js' }
 *   '/'                            -> { service: frontend,   rest: '/' }           (fallback)
 *   '/dashboard'                   -> { service: frontend,   rest: '/dashboard' }   (fallback — SPA route)
 *
 * @param {string} url
 * @param {{name: string, port: number}[]} services
 */
function routeByServicePrefix(url, services) {
  if (!services || services.length === 0) return null;

  // Split into path + query so we don't mangle '?' parsing.
  const qIdx     = url.indexOf('?');
  const pathOnly = qIdx === -1 ? url : url.slice(0, qIdx);
  const query    = qIdx === -1 ? '' : url.slice(qIdx);

  const match = pathOnly.match(/^\/([^/]+)(\/.*)?$/);
  if (match) {
    const [, prefix, rest = '/'] = match;
    const svc = services.find(s => s.name === prefix);
    if (svc) return { service: svc, rest: rest + query };
  }

  // Fallback to the frontend if one is registered; otherwise the first service.
  const fallback = services.find(s => s.name === 'frontend') ?? services[0];
  return { service: fallback, rest: pathOnly + query };
}

/**
 * Path-prefix proxy middleware for PROXY_PORT.
 *
 * Routes `/<service>/<rest>` to `http://fleet-<feature>-<service>:<port>/<rest>`,
 * where <service> and <port> come from the services recorded at register time.
 * Unmatched paths fall back to the `frontend` service (SPA routes).
 *
 * Returns 503 when no feature is active, 502 when the active feature has no
 * services registered (legacy caller), and 502 on upstream connection errors.
 *
 * @returns {import('express').RequestHandler}
 */
export function createFeatureProxy() {
  const proxy = createProxyMiddleware({
    router: (req) => {
      const feature = getActiveFeature();
      if (!feature) return null;
      const services = getServices(feature);
      const routed = routeByServicePrefix(req.url, services);
      if (!routed) return null;
      return `http://fleet-${feature}-${routed.service.name}:${routed.service.port}`;
    },
    pathRewrite: (path, req) => {
      const feature = getActiveFeature();
      if (!feature) return path;
      const services = getServices(feature);
      const routed = routeByServicePrefix(req.url, services);
      return routed ? routed.rest : path;
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
    if (getServices(feature).length === 0) {
      return res.status(502).json({
        error: `Active feature '${feature}' has no registered services — re-register with a current fleet CLI.`,
      });
    }
    return proxy(req, res, next);
  };
}

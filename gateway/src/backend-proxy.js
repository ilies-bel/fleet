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
 * :8080 share the same "selected feature, else 503" semantics.
 *
 * The returned function also carries an `.upgrade` property so the caller can
 * wire it to the http.Server 'upgrade' event for WebSocket support:
 *
 *   const backendProxy = createBackendProxy();
 *   server.on('upgrade', backendProxy.upgrade);
 *
 * The upgrade handler applies the same /backend path rewrite before forwarding
 * so nginx-in-container routes the WebSocket to the correct backend service.
 *
 * @returns {import('express').RequestHandler & { upgrade: Function }}
 */
export function createBackendProxy() {
  const proxy = createProxyMiddleware({
    ws: true,
    router: async (req) => {
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
      error: (_err, _req, resOrSocket) => {
        if (resOrSocket && typeof resOrSocket.status === 'function') {
          if (!resOrSocket.headersSent)
            resOrSocket.status(502).json({ error: 'Backend container unreachable' });
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
   * Applies the /backend path rewrite (same as proxyReq) so nginx in the
   * container routes the WebSocket connection to the backend service.
   * Falls back to a minimal HTTP 503 response and socket destroy when no
   * container is running.
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
    // Apply the /backend path rewrite before forwarding so nginx routes correctly.
    const incoming = req.url || '/';
    req.url = '/backend' + (incoming.startsWith('/') ? incoming : '/' + incoming);
    proxy.upgrade(req, socket, head);
  };

  return Object.assign(handler, { upgrade });
}

// Re-exported for symmetry / tests that want to assert on the 503 body.
export { stoppedContainerBody };

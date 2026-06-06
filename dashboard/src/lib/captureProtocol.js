/**
 * Protocol constants for the capture round-trip between the dashboard and the
 * gateway-injected picker script.
 *
 * DASHBOARD_ORIGIN – the origin of the dashboard dev-server. Used as the
 * postMessage targetOrigin on the dashboard side and for origin validation
 * inside the injected script.
 *
 * PROXY_ORIGIN – the bare origin of the gateway transparent proxy that serves
 * the preview iframe.
 */
export const DASHBOARD_ORIGIN = 'http://localhost:5173';
export const PROXY_ORIGIN = 'http://localhost:3000';

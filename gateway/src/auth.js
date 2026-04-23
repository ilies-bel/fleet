import { Router } from 'express';
import { register, unregister, isRegistered, setActiveFeature } from './registry.js';

const router = Router();

/**
 * POST /register-feature
 * Called by fleet add to register a new feature container.
 * Body: { project, name, branch, worktreePath?, status?, services?, title?, error? }
 *
 * `project` is required — a request without it returns 400 with a clear message
 * directing the caller to upgrade their fleet CLI.
 */
router.post('/register-feature', (req, res) => {
  const { project, name, branch, worktreePath = null, status = 'running', services = [], title = null, error = null } = req.body;

  if (!project) {
    return res.status(400).json({ error: 'project required — upgrade your fleet CLI' });
  }

  if (!name || !branch) {
    return res.status(400).json({ error: 'name and branch are required' });
  }

  // Normalize services payload: {name, port} per entry. Malformed entries are
  // dropped rather than erroring to keep register-feature backwards-compatible
  // with callers that omit the field entirely.
  const normalizedServices = Array.isArray(services)
    ? services
        .filter(s => s && typeof s === 'object' && typeof s.name === 'string' && Number.isFinite(Number(s.port)))
        .map(s => ({ name: s.name, port: Number(s.port) }))
    : [];

  register(project, name, branch, worktreePath, status, normalizedServices, title, error);

  const key = `${project}-${name}`;
  res.json({ ok: true, key, project, name, branch, services: normalizedServices });
});

/**
 * DELETE /register-feature/:key
 * Called by fleet teardown to deregister a feature container.
 * `:key` is the composite `${project}-${name}` string.
 */
router.delete('/register-feature/:key', (req, res) => {
  const { key } = req.params;
  unregister(key);
  res.json({ ok: true, key });
});

/**
 * GET /auth/callback
 * OAuth relay — decodes the `state` param to identify the feature,
 * activates it on the transparent proxy, then redirects to port 3000.
 */
router.get('/auth/callback', (req, res) => {
  const { state, ...rest } = req.query;

  if (!state) {
    return res.status(400).send(`
      <html><body style="font-family:monospace;background:#0a0a0a;color:#ff4444;padding:2rem">
        <h2>// AUTH ERROR</h2>
        <p>Missing <code>state</code> parameter in OAuth callback.</p>
      </body></html>
    `);
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
  } catch {
    return res.status(400).send(`
      <html><body style="font-family:monospace;background:#0a0a0a;color:#ff4444;padding:2rem">
        <h2>// AUTH ERROR</h2>
        <p>Could not decode <code>state</code> — expected base64-encoded JSON.</p>
      </body></html>
    `);
  }

  // Accept either composite `key` (new) or legacy `feature` field (old CLIs
  // that encode the state with `feature`).
  const key = parsed.key ?? parsed.feature;

  if (!key || !isRegistered(key)) {
    return res.status(400).send(`
      <html><body style="font-family:monospace;background:#0a0a0a;color:#ff4444;padding:2rem">
        <h2>// AUTH ERROR</h2>
        <p>Feature <code>${key ?? '(none)'}</code> is not registered.</p>
      </body></html>
    `);
  }

  // Activate this feature so port 3000 proxy routes to the correct container
  try { setActiveFeature(key); } catch { /* already handled by isRegistered */ }

  // Redirect to port 3000 — the transparent proxy will forward to the container
  const forwardQuery = new URLSearchParams({ ...rest, state });
  res.redirect(`http://localhost:3000/auth/callback?${forwardQuery.toString()}`);
});

export default router;

import { Router } from 'express';
import { register, unregister, isRegistered, setActiveFeature } from './registry.js';

const router = Router();

/**
 * POST /register-feature
 * Called by qa-add.sh to register a new feature container.
 * Body: { name, branch }
 */
router.post('/register-feature', (req, res) => {
  const { name, branch, worktreePath = null, project = null, status = 'running' } = req.body;

  if (!name || !branch) {
    return res.status(400).json({ error: 'name and branch are required' });
  }

  register(name, branch, worktreePath, project, status);

  res.json({ ok: true, name, branch });
});

/**
 * DELETE /register-feature/:name
 * Called by qa-teardown.sh to deregister a feature container.
 */
router.delete('/register-feature/:name', (req, res) => {
  const { name } = req.params;
  unregister(name);
  res.json({ ok: true, name });
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

  const { feature } = parsed;

  if (!feature || !isRegistered(feature)) {
    return res.status(400).send(`
      <html><body style="font-family:monospace;background:#0a0a0a;color:#ff4444;padding:2rem">
        <h2>// AUTH ERROR</h2>
        <p>Feature <code>${feature ?? '(none)'}</code> is not registered.</p>
      </body></html>
    `);
  }

  // Activate this feature so port 3000 proxy routes to the correct container
  try { setActiveFeature(feature); } catch { /* already handled by isRegistered */ }

  // Redirect to port 3000 — the transparent proxy will forward to the container
  const forwardQuery = new URLSearchParams({ ...rest, state });
  res.redirect(`http://localhost:3000/auth/callback?${forwardQuery.toString()}`);
});

export default router;

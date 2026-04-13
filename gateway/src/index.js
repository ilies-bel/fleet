import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import apiRouter from './api.js';
import authRouter from './auth.js';
import { createFeatureProxy } from './proxy.js';
import { reconcileFromDocker } from './reconcile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

await reconcileFromDocker();

// ── :3000 — transparent proxy only ───────────────────────────────────────────
// No body parsing, no CORS, no middleware — pass everything through verbatim.
const proxyApp = express();
proxyApp.use(createFeatureProxy());
proxyApp.listen(3000, '0.0.0.0', () => console.log('[QA Gateway] proxy on :3000'));

// ── :4000 — admin API + dashboard ────────────────────────────────────────────
const adminApp = express();
adminApp.use(cors());
adminApp.use(express.json());

// Management API (features list, health, activate, terminal, status)
adminApp.use('/_qa/api', apiRouter);

// Feature registration + OAuth relay (called by scripts and OAuth providers)
adminApp.use('/', authRouter);

// Dashboard static files + SPA fallback
const dashboardDist = join(__dirname, '..', 'public');
const indexHtml = join(dashboardDist, 'index.html');
adminApp.use(express.static(dashboardDist));
adminApp.get('*', (_req, res) => {
  import('fs').then(({ existsSync }) => {
    if (existsSync(indexHtml)) {
      res.sendFile(indexHtml);
    } else {
      res.redirect('http://localhost:5173');
    }
  });
});

adminApp.listen(4000, '0.0.0.0', () => console.log('[QA Gateway] admin on :4000'));

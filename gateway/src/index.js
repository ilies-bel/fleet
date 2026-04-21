import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import apiRouter from './api.js';
import authRouter from './auth.js';
import { createFeatureProxy } from './proxy.js';
import { createBackendProxy } from './backend-proxy.js';
import { reconcileFromDocker } from './reconcile.js';
import { ensureMainRunning } from './lifecycle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

await ensureMainRunning();
await reconcileFromDocker();

// ── proxy port (PROXY_PORT, default 3000) — transparent proxy only ───────────
// No body parsing, no CORS, no middleware — pass everything through verbatim.
const PROXY_PORT = Number(process.env.PROXY_PORT) || 3000;
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 4000;
const BACKEND_PORT = Number(process.env.BACKEND_PORT) || 8080;

const proxyApp = express();
proxyApp.use(createFeatureProxy());
proxyApp.listen(PROXY_PORT, '0.0.0.0', () => console.log(`[fleet] proxy on :${PROXY_PORT}`));

// ── backend port (BACKEND_PORT, default 8080) — mirrors proxy routing but ──
// prepends /backend so nginx-in-container routes to the Spring backend.
// Same selected-feature + main-fallback semantics as :3000.
const backendApp = express();
backendApp.use(createBackendProxy());
backendApp.listen(BACKEND_PORT, '0.0.0.0', () => console.log(`[fleet] backend on :${BACKEND_PORT}`));

// ── admin port (ADMIN_PORT, default 4000) — admin API + dashboard ────────────
const adminApp = express();
adminApp.use(cors());
adminApp.use(express.json());

// Management API (features list, health, activate, terminal, status)
adminApp.use('/_fleet/api', apiRouter);

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

adminApp.listen(ADMIN_PORT, '0.0.0.0', () => console.log(`[fleet] admin on :${ADMIN_PORT}`));

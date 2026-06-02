/**
 * Shared sidecar Deployment + Service renderer and applier.
 *
 * Project-scoped sidecars are materialised as ONE shared Deployment + Service
 * per sidecar per namespace (not per feature). Feature pods reach them via
 * Kubernetes Service DNS:
 *   - In-namespace short form:  fleet-sidecar-<name>
 *   - Fully-qualified form:     fleet-sidecar-<name>.<namespace>.svc.cluster.local
 *
 * All cluster mutations route through the oc.js wrapper (apply()).
 */

import { apply } from './oc.js';

// In-memory digest tracking: "<namespace>:<name>" -> JSON.stringify(sidecar)
// A matching digest means the manifest in the cluster is already up-to-date;
// we skip the apply call to keep ensureSidecars idempotent.
const appliedDigests = new Map();

/**
 * Clear the in-memory digest cache.
 * Intended for test isolation only — do not call from production code.
 */
export function clearDigestCache() {
  appliedDigests.clear();
}

/**
 * Render a combined Deployment + Service YAML manifest for a single project sidecar.
 *
 * @param {string} name - sidecar name (e.g. "redis")
 * @param {{ image: string, port: number }} sidecar
 * @param {string} namespace - Kubernetes namespace
 * @returns {string} multi-document YAML string
 */
export function renderSidecarManifests(name, sidecar, namespace) {
  const resName = `fleet-sidecar-${name}`;

  const deployment = [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    `  name: ${resName}`,
    `  namespace: ${namespace}`,
    '  labels:',
    `    app: ${resName}`,
    '    managed-by: fleet',
    'spec:',
    '  replicas: 1',
    '  selector:',
    '    matchLabels:',
    `      app: ${resName}`,
    '  template:',
    '    metadata:',
    '      labels:',
    `        app: ${resName}`,
    '    spec:',
    '      containers:',
    `        - name: ${name}`,
    `          image: ${sidecar.image}`,
    '          ports:',
    `            - containerPort: ${sidecar.port}`,
  ].join('\n');

  const service = [
    'apiVersion: v1',
    'kind: Service',
    'metadata:',
    `  name: ${resName}`,
    `  namespace: ${namespace}`,
    '  labels:',
    `    app: ${resName}`,
    '    managed-by: fleet',
    'spec:',
    '  selector:',
    `    app: ${resName}`,
    '  ports:',
    `    - port: ${sidecar.port}`,
    `      targetPort: ${sidecar.port}`,
    '  type: ClusterIP',
  ].join('\n');

  return `${deployment}\n---\n${service}`;
}

/**
 * Ensure all project sidecars are applied to the cluster namespace.
 *
 * Applies a Deployment + Service for each entry in projectConfig.sidecars.
 * Skips sidecars whose config digest matches what was applied in a previous
 * call, making this safe to call on every feature start.
 *
 * Projects with no sidecars (local-only features) are unaffected — the
 * function returns immediately without touching the cluster.
 *
 * @param {string} namespace - Kubernetes namespace for the feature
 * @param {{ sidecars?: Array<{ name: string, image: string, port: number }> }} projectConfig
 * @returns {Promise<void>}
 */
export async function ensureSidecars(namespace, projectConfig) {
  const sidecars = projectConfig.sidecars;
  if (!sidecars || sidecars.length === 0) return;

  for (const sidecar of sidecars) {
    const key = `${namespace}:${sidecar.name}`;
    const digest = JSON.stringify(sidecar);
    if (appliedDigests.get(key) === digest) continue;

    const manifest = renderSidecarManifests(sidecar.name, sidecar, namespace);
    await apply(manifest);
    appliedDigests.set(key, digest);
  }
}

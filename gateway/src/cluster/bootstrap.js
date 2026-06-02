/**
 * Cluster bootstrap: creates the fleet-feature-base ImageStream and BuildConfig,
 * then triggers a one-time build if the :latest tag does not yet exist.
 *
 * Idempotent — re-running after a successful build returns immediately without
 * re-triggering the build (the ImageStreamTag already exists).
 *
 * The generated image is reachable inside the cluster at:
 *   image-registry.openshift-image-registry.svc:5000/<namespace>/fleet-feature-base:latest
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { apply, runOc } from './oc.js';

const TEMPLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'manifests/buildconfig.yaml.tmpl'
);

/**
 * Render the BuildConfig + ImageStream manifest for a given namespace.
 * Substitutes the {NAMESPACE} placeholder throughout the template.
 *
 * @param {string} namespace - Kubernetes namespace
 * @returns {string} rendered multi-document YAML
 */
export function renderBuildConfig(namespace) {
  const tmpl = readFileSync(TEMPLATE_PATH, 'utf8');
  return tmpl.replaceAll('{NAMESPACE}', namespace);
}

/**
 * Bootstrap the fleet-feature-base image into the cluster namespace.
 *
 * Steps:
 *   1. Apply the ImageStream + BuildConfig manifests (idempotent via oc apply).
 *   2. Check whether fleet-feature-base:latest already exists in the ImageStream.
 *   3. If it does, return immediately (no-op).
 *   4. Otherwise, run `oc start-build --from-dir=<buildContextDir> --wait` to
 *      push the local .fleet build context and build the image in-cluster.
 *
 * @param {string} namespace - Kubernetes namespace for the bootstrap
 * @param {{ buildContextDir?: string }} [opts]
 *   buildContextDir — path to the fleet root containing Dockerfile.feature-base.
 *   Falls back to the FLEET_ROOT environment variable.
 * @returns {Promise<void>}
 */
export async function bootstrap(namespace, { buildContextDir } = {}) {
  const manifest = renderBuildConfig(namespace);
  await apply(manifest);

  // If the tag already exists the image was built previously — nothing to do.
  try {
    await runOc(['get', 'imagestreamtag', 'fleet-feature-base:latest', '-n', namespace]);
    return;
  } catch {
    // tag absent — fall through to build
  }

  const ctxDir = buildContextDir || process.env.FLEET_ROOT;
  if (!ctxDir) {
    throw new Error(
      'buildContextDir option or FLEET_ROOT environment variable is required to start the base-image build'
    );
  }

  await runOc([
    'start-build', 'fleet-feature-base',
    `--from-dir=${ctxDir}`,
    '-n', namespace,
    '--wait',
  ]);
}

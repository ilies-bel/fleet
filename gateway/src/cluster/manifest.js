/**
 * Feature pod manifest generator.
 *
 * Renders a Kubernetes Pod + Service spec for a fleet feature pod running in
 * an OpenShift cluster.  The Pod references the in-cluster ImageStream tag for
 * fleet-feature-base, starts with FLEET_BOOT=wait, and runs as the
 * namespace-assigned UID (no hardcoded runAsUser).  The Service provides the
 * same DNS-name shape as today's local fleet-net so that reconcile and cleanup
 * can locate resources by the `fleet-feature=<key>` selector.
 *
 * This module is a pure renderer — it produces plain JS objects and performs
 * no cluster mutations.  All applies are the caller's responsibility.
 */

const IMAGE_REGISTRY = 'image-registry.openshift-image-registry.svc:5000';
const BASE_IMAGE = 'fleet-feature-base:latest';

/**
 * Render a Kubernetes Pod + Service manifest pair for a fleet feature.
 *
 * @param {{ key: string, host: { namespace: string }, services?: Array<{ name: string, port: number }> }} feature
 * @returns {{ pod: object, service: object }}
 */
export function renderFeaturePod(feature) {
  const { key, host } = feature;
  const { namespace } = host;
  const resourceName = `fleet-${key}`;
  const image = `${IMAGE_REGISTRY}/${namespace}/${BASE_IMAGE}`;
  const services = feature.services ?? [];

  const pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: resourceName,
      namespace,
      labels: { 'fleet-feature': key },
    },
    spec: {
      // fsGroup 0 gives the container write access to mounted volumes without
      // requiring a specific UID — OpenShift assigns the UID from the project's
      // allowed UID range at runtime.
      securityContext: { fsGroup: 0 },
      containers: [
        {
          name: 'feature',
          image,
          env: [{ name: 'FLEET_BOOT', value: 'wait' }],
          // No securityContext.runAsUser — let OpenShift assign the UID.
        },
      ],
    },
  };

  const service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: resourceName,
      namespace,
      labels: { 'fleet-feature': key },
    },
    spec: {
      // Selector must match pod.metadata.labels so reconcile and port-forward
      // can target pods by feature key.
      selector: { 'fleet-feature': key },
      ports: services.map(s => ({ name: s.name, port: s.port, targetPort: s.port })),
      type: 'ClusterIP',
    },
  };

  return { pod, service };
}

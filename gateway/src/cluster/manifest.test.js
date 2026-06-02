/**
 * Tests for gateway/src/cluster/manifest.js
 *
 * Strategy: renderFeaturePod is a pure function.  Tests exercise its
 * observable output through the public interface only — no mocking of
 * internals, no assertions on private state.  The final test is a full
 * snapshot (deepEqual against a hardcoded expected object) that acts as a
 * regression guard for the complete manifest shape.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderFeaturePod } from './manifest.js';

/** Representative feature record — matches the FeatureEntry shape from registry.js */
const FEATURE = {
  project: 'myapp',
  name: 'feat-auth',
  key: 'myapp-feat-auth',
  branch: 'feat/auth',
  worktreePath: null,
  title: 'Auth feature',
  host: { cluster: 'prod-cluster', namespace: 'fleet-dev' },
  addedAt: new Date('2026-01-01T00:00:00.000Z'),
  status: 'starting',
  error: null,
  services: [{ name: 'web', port: 3000 }],
};

describe('renderFeaturePod', () => {
  // -------------------------------------------------------------------------
  // Tracer bullet: shape of return value
  // -------------------------------------------------------------------------

  test('returns an object with pod and service keys', () => {
    const result = renderFeaturePod(FEATURE);
    assert.ok(result !== null && typeof result === 'object', 'result must be an object');
    assert.ok('pod' in result, 'result must have a pod key');
    assert.ok('service' in result, 'result must have a service key');
  });

  // -------------------------------------------------------------------------
  // Pod — image
  // -------------------------------------------------------------------------

  test('pod image references the in-cluster ImageStream tag for the feature namespace', () => {
    const { pod } = renderFeaturePod(FEATURE);
    assert.equal(
      pod.spec.containers[0].image,
      'image-registry.openshift-image-registry.svc:5000/fleet-dev/fleet-feature-base:latest',
    );
  });

  test('pod image namespace changes with host.namespace', () => {
    const { pod } = renderFeaturePod({
      ...FEATURE,
      host: { cluster: 'other', namespace: 'staging-ns' },
    });
    assert.match(pod.spec.containers[0].image, /\/staging-ns\/fleet-feature-base:latest$/);
  });

  // -------------------------------------------------------------------------
  // Pod — env / security
  // -------------------------------------------------------------------------

  test('pod env includes FLEET_BOOT=wait', () => {
    const { pod } = renderFeaturePod(FEATURE);
    const env = pod.spec.containers[0].env ?? [];
    const bootVar = env.find(e => e.name === 'FLEET_BOOT');
    assert.ok(bootVar, 'FLEET_BOOT env var must be present');
    assert.equal(bootVar.value, 'wait');
  });

  test('container has no hardcoded runAsUser (OpenShift assigns the UID)', () => {
    const { pod } = renderFeaturePod(FEATURE);
    const containerSC = pod.spec.containers[0].securityContext;
    assert.equal(
      containerSC?.runAsUser,
      undefined,
      'runAsUser must not be set on the container — OpenShift assigns UID from namespace range',
    );
  });

  test('pod-level securityContext sets fsGroup to 0', () => {
    const { pod } = renderFeaturePod(FEATURE);
    assert.equal(pod.spec.securityContext?.fsGroup, 0);
  });

  test('pod-level securityContext has no runAsUser', () => {
    const { pod } = renderFeaturePod(FEATURE);
    assert.equal(
      pod.spec.securityContext?.runAsUser,
      undefined,
      'runAsUser must not be set at pod level',
    );
  });

  // -------------------------------------------------------------------------
  // Pod — labels
  // -------------------------------------------------------------------------

  test('pod metadata has fleet-feature label matching the feature key', () => {
    const { pod } = renderFeaturePod(FEATURE);
    assert.equal(pod.metadata.labels['fleet-feature'], FEATURE.key);
  });

  test('pod name is fleet-<key>', () => {
    const { pod } = renderFeaturePod(FEATURE);
    assert.equal(pod.metadata.name, `fleet-${FEATURE.key}`);
  });

  test('pod namespace matches host.namespace', () => {
    const { pod } = renderFeaturePod(FEATURE);
    assert.equal(pod.metadata.namespace, FEATURE.host.namespace);
  });

  // -------------------------------------------------------------------------
  // Service — naming and selector
  // -------------------------------------------------------------------------

  test('service is named fleet-<key> (matches DNS-name shape of local fleet-net)', () => {
    const { service } = renderFeaturePod(FEATURE);
    assert.equal(service.metadata.name, `fleet-${FEATURE.key}`);
  });

  test('service selector targets pods via fleet-feature=<key> label', () => {
    const { service } = renderFeaturePod(FEATURE);
    assert.equal(service.spec.selector['fleet-feature'], FEATURE.key);
  });

  test('service name matches pod name so DNS resolves to the pod', () => {
    const { pod, service } = renderFeaturePod(FEATURE);
    assert.equal(service.metadata.name, pod.metadata.name);
  });

  test('service namespace matches host.namespace', () => {
    const { service } = renderFeaturePod(FEATURE);
    assert.equal(service.metadata.namespace, FEATURE.host.namespace);
  });

  // -------------------------------------------------------------------------
  // Service — ports
  // -------------------------------------------------------------------------

  test('service ports are derived from feature.services', () => {
    const { service } = renderFeaturePod(FEATURE);
    assert.equal(service.spec.ports.length, 1);
    assert.equal(service.spec.ports[0].port, 3000);
    assert.equal(service.spec.ports[0].targetPort, 3000);
    assert.equal(service.spec.ports[0].name, 'web');
  });

  test('service ports are empty when feature has no services', () => {
    const { service } = renderFeaturePod({ ...FEATURE, services: [] });
    assert.deepEqual(service.spec.ports, []);
  });

  test('service type is ClusterIP (in-namespace DNS only)', () => {
    const { service } = renderFeaturePod(FEATURE);
    assert.equal(service.spec.type, 'ClusterIP');
  });

  // -------------------------------------------------------------------------
  // Snapshot — full manifest shape for a representative feature record
  // -------------------------------------------------------------------------

  test('snapshot: representative feature record produces stable pod and service manifests', () => {
    const { pod, service } = renderFeaturePod(FEATURE);

    assert.deepEqual(pod, {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: 'fleet-myapp-feat-auth',
        namespace: 'fleet-dev',
        labels: { 'fleet-feature': 'myapp-feat-auth' },
      },
      spec: {
        securityContext: { fsGroup: 0 },
        containers: [
          {
            name: 'feature',
            image: 'image-registry.openshift-image-registry.svc:5000/fleet-dev/fleet-feature-base:latest',
            env: [{ name: 'FLEET_BOOT', value: 'wait' }],
          },
        ],
      },
    });

    assert.deepEqual(service, {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: 'fleet-myapp-feat-auth',
        namespace: 'fleet-dev',
        labels: { 'fleet-feature': 'myapp-feat-auth' },
      },
      spec: {
        selector: { 'fleet-feature': 'myapp-feat-auth' },
        ports: [{ name: 'web', port: 3000, targetPort: 3000 }],
        type: 'ClusterIP',
      },
    });
  });
});

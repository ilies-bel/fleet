/**
 * Integration-style verification test for epic qa-fleet-pyn (Stack-agnostic Fleet refactor).
 *
 * Context: After the refactor, features may run N containers each. The gateway
 * registration contract ({name, branch, worktreePath, project}) does not change,
 * but a future services[] field may be included in the payload. This test verifies
 * that FeatureCard and FeatureList render without errors when given feature objects
 * that include a services[] array, confirming the dashboard is already forward-compatible.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import FeatureCard from '../FeatureCard.jsx';
import FeatureList from '../FeatureList.jsx';

// Mock the api module — FeatureCard calls getHealth on mount via useEffect
vi.mock('../../api.js', () => ({
  getHealth: vi.fn().mockResolvedValue({ status: 'up' }),
  removeFeature: vi.fn().mockResolvedValue({}),
  stopFeature: vi.fn().mockResolvedValue({}),
  startFeature: vi.fn().mockResolvedValue({}),
  syncFeature: vi.fn().mockResolvedValue({ ok: true, message: 'syncing' }),
  getFeatures: vi.fn().mockResolvedValue([]),
  activateFeature: vi.fn().mockResolvedValue({ ok: true, active: 'my-feature' }),
  addFeature: vi.fn().mockResolvedValue({}),
  getLogs: vi.fn().mockResolvedValue({ lines: '', fetchedAt: Date.now() }),
  getStats: vi.fn().mockResolvedValue({ cpuPercent: 0, memUsageMB: 0, memLimitMB: 0, netRxMB: 0, netTxMB: 0 }),
  getStatus: vi.fn().mockResolvedValue({ uptimeMs: 1000, featureCount: 2, activeFeature: null, nodeVersion: '20.0.0' }),
}));

/** Feature payload that mirrors what the gateway currently returns, extended with services[]. */
const makeFeature = (overrides = {}) => ({
  key: 'my-project-my-feature',
  name: 'my-feature',
  branch: 'feature/my-branch',
  project: 'my-project',
  isActive: false,
  status: 'running',
  services: [
    { name: 'backend' },
    { name: 'frontend' },
  ],
  ...overrides,
});

describe('FeatureCard — services[] forward-compatibility', () => {
  const noopFn = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without errors when feature includes services[]', () => {
    const feature = makeFeature();
    expect(() =>
      render(
        <FeatureCard
          feature={feature}
          isActive={false}
          isPreview={false}
          isStarting={false}
          onActivate={noopFn}
          onRemoved={noopFn}
          onLogs={noopFn}
        />
      )
    ).not.toThrow();
  });

  it('displays the feature name and branch regardless of services[]', () => {
    const feature = makeFeature({ name: 'auth-service', branch: 'feat/auth-v2' });
    render(
      <FeatureCard
        feature={feature}
        isActive={false}
        isPreview={false}
        isStarting={false}
        onActivate={noopFn}
        onRemoved={noopFn}
        onLogs={noopFn}
      />
    );

    expect(screen.getByText('auth-service')).toBeInTheDocument();
    expect(screen.getByText('feat/auth-v2')).toBeInTheDocument();
  });

  it('renders with N=1 service (single-container mode)', () => {
    const feature = makeFeature({
      services: [{ name: 'app' }],
    });
    expect(() =>
      render(
        <FeatureCard
          feature={feature}
          isActive={false}
          isPreview={false}
          isStarting={false}
          onActivate={noopFn}
          onRemoved={noopFn}
          onLogs={noopFn}
        />
      )
    ).not.toThrow();
  });

  it('renders with N=3 services (multi-container mode)', () => {
    const feature = makeFeature({
      services: [
        { name: 'backend' },
        { name: 'frontend' },
        { name: 'worker' },
      ],
    });
    expect(() =>
      render(
        <FeatureCard
          feature={feature}
          isActive={false}
          isPreview={false}
          isStarting={false}
          onActivate={noopFn}
          onRemoved={noopFn}
          onLogs={noopFn}
        />
      )
    ).not.toThrow();
  });

  it('renders with no services field (backward-compatible — old registry format)', () => {
    const { services: _, ...featureWithoutServices } = makeFeature();
    expect(() =>
      render(
        <FeatureCard
          feature={featureWithoutServices}
          isActive={false}
          isPreview={false}
          isStarting={false}
          onActivate={noopFn}
          onRemoved={noopFn}
          onLogs={noopFn}
        />
      )
    ).not.toThrow();
  });

  it('renders active state with services[] without errors', () => {
    const feature = makeFeature({ isActive: true });
    expect(() =>
      render(
        <FeatureCard
          feature={feature}
          isActive={true}
          isPreview={false}
          isStarting={false}
          onActivate={noopFn}
          onRemoved={noopFn}
          onLogs={noopFn}
        />
      )
    ).not.toThrow();
  });
});

describe('FeatureList — services[] forward-compatibility', () => {
  const noopFn = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a list of features each with services[] without errors', () => {
    const features = [
      makeFeature({ key: 'proj-1-feature-a', name: 'feature-a', branch: 'feat/a', project: 'proj-1', isActive: true }),
      makeFeature({ key: 'proj-1-feature-b', name: 'feature-b', branch: 'feat/b', project: 'proj-1', isActive: false }),
      makeFeature({
        key: 'proj-2-feature-c',
        name: 'feature-c',
        branch: 'feat/c',
        project: 'proj-2',
        isActive: false,
        services: [{ name: 'backend' }, { name: 'frontend' }, { name: 'worker' }],
      }),
    ];

    expect(() =>
      render(
        <FeatureList
          features={features}
          activePreview="proj-1-feature-a"
          startingFeatures={new Set()}
          onActivate={noopFn}
          onRemoved={noopFn}
          onAdd={noopFn}
          onLogs={noopFn}
        />
      )
    ).not.toThrow();
  });

  it('groups multi-service features by project correctly', () => {
    const features = [
      makeFeature({ key: 'project-x-alpha', name: 'alpha', branch: 'main', project: 'project-x', services: [{ name: 'backend' }, { name: 'frontend' }] }),
      makeFeature({ key: 'project-y-beta', name: 'beta', branch: 'main', project: 'project-y', services: [{ name: 'app' }] }),
    ];

    render(
      <FeatureList
        features={features}
        activePreview={null}
        startingFeatures={new Set()}
        onActivate={noopFn}
        onRemoved={noopFn}
        onAdd={noopFn}
        onLogs={noopFn}
      />
    );

    // Both feature names must appear in the grouped list
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
  });
});

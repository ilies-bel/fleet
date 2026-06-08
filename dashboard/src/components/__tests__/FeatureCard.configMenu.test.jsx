/**
 * Behaviour tests for the per-card config menu in FeatureCard.
 *
 * Verifies observable behaviour through the public interface:
 * the ⋯ button is present, opens a modal with the feature's displayName
 * and branch value, and the close button dismisses the modal.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import FeatureCard from '../FeatureCard.jsx';

vi.mock('../../api.js', () => ({
  getHealth: vi.fn().mockResolvedValue({ status: 'down' }),
  removeFeature: vi.fn().mockResolvedValue({}),
  stopFeature: vi.fn().mockResolvedValue({}),
  startFeature: vi.fn().mockResolvedValue({}),
  syncFeature: vi.fn().mockResolvedValue({ ok: true }),
  getFeatures: vi.fn().mockResolvedValue([]),
  activateFeature: vi.fn().mockResolvedValue({ ok: true }),
  addFeature: vi.fn().mockResolvedValue({}),
  getLogs: vi.fn().mockResolvedValue({ lines: '' }),
  getStats: vi.fn().mockResolvedValue({}),
  getStatus: vi.fn().mockResolvedValue({}),
  getServicesHealth: vi.fn().mockResolvedValue({ services: [] }),
}));

const makeFeature = (overrides = {}) => ({
  key: 'proj-alpha',
  name: 'alpha',
  branch: 'feature/my-branch',
  title: 'Alpha Feature',
  project: 'proj',
  isActive: false,
  status: 'running',
  services: [],
  ...overrides,
});

const renderCard = (overrides = {}) =>
  render(
    <FeatureCard
      feature={makeFeature(overrides)}
      isActive={false}
      isPreview={false}
      isStarting={false}
      onActivate={vi.fn()}
      onRemoved={vi.fn()}
      onLogs={vi.fn()}
    />
  );

describe('FeatureCard — config menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Tracer bullet: ⋯ button is present in expanded state ──────────────────

  it('renders a ⋯ button with accessible aria-label in expanded state', () => {
    renderCard();
    expect(
      screen.getByRole('button', { name: 'Open Alpha Feature configuration' })
    ).toBeInTheDocument();
  });

  // ── ⋯ button present when card is collapsed ───────────────────────────────

  it('renders a ⋯ button with accessible aria-label in collapsed state', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /collapse alpha feature/i }));
    expect(
      screen.getByRole('button', { name: 'Open Alpha Feature configuration' })
    ).toBeInTheDocument();
  });

  // ── Clicking ⋯ opens modal with feature displayName ───────────────────────

  it('clicking ⋯ opens a modal titled with the feature displayName', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Open Alpha Feature configuration' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Alpha Feature' })).toBeInTheDocument();
  });

  // ── Modal shows branch value ───────────────────────────────────────────────

  it('modal body renders the feature branch value', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Open Alpha Feature configuration' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Branch')).toBeInTheDocument();
    expect(within(dialog).getByText('feature/my-branch')).toBeInTheDocument();
  });

  // ── Close button dismisses the modal ─────────────────────────────────────

  it('close button dismisses the modal', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Open Alpha Feature configuration' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  // ── Close button returns focus to the ⋯ trigger ───────────────────────────

  it('close button returns focus to the ⋯ trigger', async () => {
    renderCard();
    const trigger = screen.getByRole('button', { name: 'Open Alpha Feature configuration' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  // ── Feature name used as title when title prop is absent ──────────────────

  it('uses feature name as displayName when title is absent', () => {
    renderCard({ title: undefined });
    fireEvent.click(screen.getByRole('button', { name: 'Open alpha configuration' }));
    expect(screen.getByRole('heading', { name: 'alpha' })).toBeInTheDocument();
  });

  // ── Modal shows worktree path when present ────────────────────────────────

  it('modal body renders the worktree path when worktreePath is set', () => {
    renderCard({ worktreePath: '/abs/path/to/worktree' });
    fireEvent.click(screen.getByRole('button', { name: 'Open Alpha Feature configuration' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Worktree')).toBeInTheDocument();
    expect(within(dialog).getByText('/abs/path/to/worktree')).toBeInTheDocument();
  });

  // ── Modal shows 'direct mount' when worktreePath is null ─────────────────

  it('modal body renders "direct mount" when worktreePath is null', () => {
    renderCard({ worktreePath: null });
    fireEvent.click(screen.getByRole('button', { name: 'Open Alpha Feature configuration' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Worktree')).toBeInTheDocument();
    expect(within(dialog).getByText('direct mount')).toBeInTheDocument();
  });

  // ── Host row: local docker ─────────────────────────────────────────────────

  it('modal shows "local docker" when feature.host is null', () => {
    renderCard({ host: null });
    fireEvent.click(screen.getByRole('button', { name: 'Open Alpha Feature configuration' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Host')).toBeInTheDocument();
    expect(within(dialog).getByText('local docker')).toBeInTheDocument();
  });

  // ── Host row: cluster fixture ──────────────────────────────────────────────

  it('modal shows cluster and namespace when feature.host is set', () => {
    renderCard({ host: { cluster: 'prod', namespace: 'team-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open Alpha Feature configuration' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Host')).toBeInTheDocument();
    expect(within(dialog).getByText(/prod/)).toBeInTheDocument();
    expect(within(dialog).getByText(/team-a/)).toBeInTheDocument();
  });

  // ── Services section: populated with three entries ────────────────────────

  it('modal body renders a row per service when services is non-empty', () => {
    renderCard({
      services: [
        { name: 'web', port: 3000 },
        { name: 'api', port: 4000 },
        { name: 'pg', port: 5432 },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open Alpha Feature configuration' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Services')).toBeInTheDocument();
    expect(within(dialog).getByText('web → 3000')).toBeInTheDocument();
    expect(within(dialog).getByText('api → 4000')).toBeInTheDocument();
    expect(within(dialog).getByText('pg → 5432')).toBeInTheDocument();
  });

  // ── Services section: empty array shows fallback ──────────────────────────

  it('modal body renders "no services" when services is empty', () => {
    renderCard({ services: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Open Alpha Feature configuration' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Services')).toBeInTheDocument();
    expect(within(dialog).getByText('no services')).toBeInTheDocument();
  });

  // ── Direct-mount tag in card header ───────────────────────────────────────

  it('renders a "direct" tag in the card header when worktreePath is null', () => {
    renderCard({ worktreePath: null });
    // No modal open — check the card header itself (not the config dialog)
    // The modal shows "direct mount" (two words); the tag shows exact "direct" (one word)
    expect(screen.getByText('direct', { exact: true })).toBeInTheDocument();
  });

  it('does not render a "direct" tag when worktreePath is a non-empty string', () => {
    renderCard({ worktreePath: '/abs/path/to/worktree' });
    expect(screen.queryByText('direct', { exact: true })).not.toBeInTheDocument();
  });
});

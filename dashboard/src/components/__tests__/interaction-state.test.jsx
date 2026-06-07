/**
 * Interaction-state token layer tests
 *
 * Verifies that:
 *   1. All required interaction-state tokens are declared in :root
 *   2. A global :focus-visible ring rule exists (keyboard accessibility)
 *   3. Each button tone has an explicit :focus-visible ring rule
 *   4. No representative control carries an unchecked inline outline:none
 *   5. The disabled opacity uses the token (not a raw 0.5 literal)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { render } from '@testing-library/react';
import { Button } from '../Button.jsx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(__dirname, '../../index.css');
const css = readFileSync(cssPath, 'utf8');

describe('Interaction-state tokens', () => {
  it('declares --focus-ring in :root', () => {
    expect(css).toMatch(/--focus-ring\s*:/);
  });

  it('declares --surface-hover in :root', () => {
    expect(css).toMatch(/--surface-hover\s*:/);
  });

  it('declares --surface-selected in :root', () => {
    expect(css).toMatch(/--surface-selected\s*:/);
  });

  it('declares --state-disabled-opacity in :root', () => {
    expect(css).toMatch(/--state-disabled-opacity\s*:/);
  });

  it('.btn:disabled uses var(--state-disabled-opacity) instead of a raw literal', () => {
    // Find the .btn:disabled block and verify it uses the token
    expect(css).toMatch(/\.btn:disabled\s*\{[^}]*opacity:\s*var\(--state-disabled-opacity\)/);
  });
});

describe('Global focus-visible ring', () => {
  it('index.css has a global :focus-visible rule that sets an outline', () => {
    // The rule must match the element type pseudo-class and set outline
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline\s*:/);
  });

  it('global :focus-visible outline references the --focus-ring token', () => {
    // Confirm the value uses the token, not a raw colour
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline[^}]*var\(--focus-ring\)/);
  });
});

describe('Button :focus-visible rings', () => {
  it('btn-primary has an explicit :focus-visible rule', () => {
    expect(css).toMatch(/\.btn-primary:focus-visible/);
  });

  it('btn-caution has an explicit :focus-visible rule', () => {
    expect(css).toMatch(/\.btn-caution:focus-visible/);
  });

  it('btn-destructive has an explicit :focus-visible rule', () => {
    expect(css).toMatch(/\.btn-destructive:focus-visible/);
  });

  it('rendered Button has no inline outline:none suppression', () => {
    const { getByRole } = render(<Button tone="primary">Go</Button>);
    expect(getByRole('button').style.outline).not.toBe('none');
  });

  it('rendered Button is focusable (no negative tabIndex)', () => {
    const { getByRole } = render(<Button tone="primary">Go</Button>);
    expect(getByRole('button').tabIndex).not.toBe(-1);
  });
});

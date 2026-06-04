import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Button } from '../Button.jsx';

describe('Button tone contract', () => {
  it('renders btn-primary class for tone="primary"', () => {
    const { getByRole } = render(<Button tone="primary">Go</Button>);
    expect(getByRole('button')).toHaveClass('btn-primary');
  });

  it('renders btn-caution class for tone="caution"', () => {
    const { getByRole } = render(<Button tone="caution">Wait</Button>);
    expect(getByRole('button')).toHaveClass('btn-caution');
  });

  it('renders btn-destructive class for tone="destructive"', () => {
    const { getByRole } = render(<Button tone="destructive">Kill</Button>);
    expect(getByRole('button')).toHaveClass('btn-destructive');
  });

  it('always includes the btn base class regardless of tone', () => {
    const { getByRole } = render(<Button tone="caution">X</Button>);
    expect(getByRole('button')).toHaveClass('btn');
  });

  it('defaults to primary tone when no tone prop is supplied', () => {
    const { getByRole } = render(<Button>Default</Button>);
    expect(getByRole('button')).toHaveClass('btn-primary');
  });

  it('forwards extra props (e.g. disabled) to the underlying button', () => {
    const { getByRole } = render(<Button tone="primary" disabled>Nope</Button>);
    expect(getByRole('button')).toBeDisabled();
  });
});

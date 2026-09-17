import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AnimatedNumber, StaggerGroup, StaggerItem } from '../motion';

const renderView = (ui: ReactNode) => render(<div>{ui}</div>);

describe('ui motion primitives', () => {
  it('renders the formatted value immediately (no zero-state flash)', () => {
    renderView(<AnimatedNumber value={1234.5} format={(latest) => latest.toFixed(2)} />);

    expect(screen.getByText('1234.50')).toBeInTheDocument();
  });

  it('renders integer scores through the default formatter', () => {
    renderView(<AnimatedNumber value={78} />);

    expect(screen.getByText('78')).toBeInTheDocument();
  });

  it('keeps staggered content visible and in document order', () => {
    const { container } = render(
      <StaggerGroup className="space-y-2">
        <StaggerItem>first</StaggerItem>
        <StaggerItem>second</StaggerItem>
      </StaggerGroup>,
    );

    const first = screen.getByText('first');
    const second = screen.getByText('second');

    expect(first).toBeVisible();
    expect(second).toBeVisible();
    expect(
      first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.firstElementChild?.childElementCount).toBe(2);
  });
});

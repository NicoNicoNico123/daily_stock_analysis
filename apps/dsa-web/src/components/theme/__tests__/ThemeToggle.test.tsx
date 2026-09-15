import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../ThemeProvider';
import { ThemeToggle } from '../ThemeToggle';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe('ThemeToggle', () => {
  it('opens the theme menu and shows all theme modes', async () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: '切換主題' }));

    expect(await screen.findByRole('menu', { name: '主題模式' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: '淺色' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: '深色' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: '跟隨系統' })).toBeInTheDocument();
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { lazy } from 'react';
import type React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { RouteOutletBoundary } from '../RouteBoundary';
import { Shell } from '../Shell';

vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({
    authEnabled: false,
    logout: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../../../stores/agentChatStore', () => {
  const state = { completionBadge: false };

  return {
    useAgentChatStore: (selector?: (value: typeof state) => unknown) => (
      selector ? selector(state) : state
    ),
  };
});

describe('RouteOutletBoundary', () => {
  it('catches rejected lazy route imports inside the shell and resets on navigation', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const BrokenLazyRoute = lazy(() => (
      Promise.reject(new Error('chunk load failed')) as Promise<{ default: React.ComponentType }>
    ));

    try {
      render(
        <MemoryRouter initialEntries={['/chat']}>
          <Routes>
            <Route
              element={(
                <Shell>
                  <RouteOutletBoundary />
                </Shell>
              )}
            >
              <Route path="/chat" element={<BrokenLazyRoute />} />
              <Route path="/portfolio" element={<div data-testid="portfolio-page">Portfolio</div>} />
            </Route>
          </Routes>
        </MemoryRouter>,
      );

      expect(screen.getByRole('navigation', { name: '主導航' })).toBeInTheDocument();
      expect(await screen.findByRole('heading', { name: '頁面加載失敗' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '重新加載頁面' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '返回首頁' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('link', { name: '持倉' }));

      expect(await screen.findByTestId('portfolio-page')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: '頁面加載失敗' })).not.toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });
});

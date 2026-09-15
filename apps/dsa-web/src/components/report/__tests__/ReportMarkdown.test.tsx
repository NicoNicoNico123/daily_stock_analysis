import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { historyApi } from '../../../api/history';
import { UiLanguageProvider } from '../../../contexts/UiLanguageContext';
import { UI_LANGUAGE_STORAGE_KEY } from '../../../utils/uiLanguage';
import { ReportMarkdown } from '../ReportMarkdown';

vi.mock('../../../api/history', () => ({
  historyApi: {
    getMarkdown: vi.fn(),
  },
}));

describe('ReportMarkdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses localized copy labels for an english interface', async () => {
    vi.mocked(historyApi.getMarkdown).mockResolvedValue('# Full report');

    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'en');
    render(
      <UiLanguageProvider>
        <ReportMarkdown
          recordId={1}
          stockName="Apple"
          stockCode="AAPL"
          onClose={() => {}}
        />
      </UiLanguageProvider>,
    );

    expect(await screen.findByRole('button', { name: 'Copy Markdown Source' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Plain Text' })).toBeInTheDocument();
  });
});

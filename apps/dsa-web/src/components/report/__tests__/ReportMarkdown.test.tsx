import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { historyApi } from '../../../api/history';
import { UiLanguageProvider } from '../../../contexts/UiLanguageContext';
import { UI_LANGUAGE_STORAGE_KEY } from '../../../utils/uiLanguage';
import { ReportMarkdown } from '../ReportMarkdown';

vi.mock('../../../api/history', () => ({
  historyApi: {
    getMarkdown: vi.fn(),
    getTranslation: vi.fn(),
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

  it('prefers the translated report body for an english interface', async () => {
    vi.mocked(historyApi.getMarkdown).mockResolvedValue('# 贵州茅台分析报告');
    vi.mocked(historyApi.getTranslation).mockResolvedValue({
      cached: true,
      targetLang: 'en',
      summary: {},
      strategy: {},
      markdown: '# Kweichow Moutai report\n\nBullish with a solid base.',
    });

    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'en');
    render(
      <UiLanguageProvider>
        <ReportMarkdown
          recordId={21}
          stockName="贵州茅台"
          stockCode="600519"
          onClose={() => {}}
        />
      </UiLanguageProvider>,
    );

    expect(await screen.findByText('Kweichow Moutai report')).toBeVisible();
    expect(screen.getByText('Bullish with a solid base.')).toBeVisible();
    expect(screen.queryByText('贵州茅台分析报告')).not.toBeInTheDocument();
    expect(historyApi.getTranslation).toHaveBeenCalledWith(21, 'en');
  });

  it('falls back to the original body when no translated markdown is available', async () => {
    vi.mocked(historyApi.getMarkdown).mockResolvedValue('# 贵州茅台分析报告');
    vi.mocked(historyApi.getTranslation).mockResolvedValue({
      cached: false,
      targetLang: 'en',
      summary: { analysisSummary: 'Fundamentals stay solid.' },
      strategy: {},
      markdown: null,
    });

    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'en');
    render(
      <UiLanguageProvider>
        <ReportMarkdown
          recordId={22}
          stockName="贵州茅台"
          stockCode="600519"
          onClose={() => {}}
        />
      </UiLanguageProvider>,
    );

    expect(await screen.findByText('贵州茅台分析报告')).toBeVisible();
    expect(historyApi.getTranslation).toHaveBeenCalled();
  });

  it('keeps the original body without fetching a translation for a chinese interface', async () => {
    vi.mocked(historyApi.getMarkdown).mockResolvedValue('# 贵州茅台分析报告');

    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'zh');
    render(
      <UiLanguageProvider>
        <ReportMarkdown
          recordId={23}
          stockName="贵州茅台"
          stockCode="600519"
          onClose={() => {}}
        />
      </UiLanguageProvider>,
    );

    expect(await screen.findByText('贵州茅台分析报告')).toBeVisible();
    expect(historyApi.getTranslation).not.toHaveBeenCalled();
  });
});

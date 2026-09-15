import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { historyApi } from '../../../api/history';
import { UiLanguageProvider } from '../../../contexts/UiLanguageContext';
import { UI_LANGUAGE_STORAGE_KEY } from '../../../utils/uiLanguage';
import { ReportNews } from '../ReportNews';

vi.mock('../../../api/history', () => ({
  historyApi: {
    getNews: vi.fn(),
  },
}));

describe('ReportNews', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders news items and refreshes with preserved subpanel styling', async () => {
    vi.mocked(historyApi.getNews).mockResolvedValue({
      total: 1,
      items: [
        {
          title: '茅臺發佈最新經營數據',
          snippet: '公司披露季度經營情況，市場關注度提升。',
          url: 'https://example.com/news',
        },
      ],
    });

    const { container } = render(<ReportNews recordId={1} />);

    expect(await screen.findByText('茅臺發佈最新經營數據')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '跳轉' })).toHaveAttribute('href', 'https://example.com/news');
    expect(screen.getByText('相關資訊/後續檢索')).toBeVisible();
    expect(screen.getByText('來源：報告頁補充資訊；是否用於分析以輸入數據塊爲準。')).toBeVisible();
    expect(container.querySelector('.home-panel-card')).toBeTruthy();
    expect(container.querySelector('.home-subpanel')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));

    await waitFor(() => {
      expect(historyApi.getNews).toHaveBeenCalledTimes(2);
    });
  });

  it('renders the empty state when no news exists', async () => {
    vi.mocked(historyApi.getNews).mockResolvedValue({
      total: 0,
      items: [],
    });

    render(<ReportNews recordId={1} />);

    expect(await screen.findByText('暫無相關資訊')).toBeInTheDocument();
    expect(screen.getByText('可稍後刷新以獲取最新資訊。')).toBeInTheDocument();
  });

  it('localizes labels for an english interface even when the report content stays chinese', async () => {
    vi.mocked(historyApi.getNews).mockResolvedValue({
      total: 0,
      items: [],
    });

    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'en');
    render(
      <UiLanguageProvider>
        <ReportNews recordId={1} />
      </UiLanguageProvider>,
    );

    expect(await screen.findByText('No related news')).toBeInTheDocument();
    expect(screen.getByText('Refresh later to check for the latest updates.')).toBeInTheDocument();
    expect(screen.getByText('Related news / follow-up retrieval')).toBeVisible();
  });

  it('renders the error state and supports retry', async () => {
    vi.mocked(historyApi.getNews)
      .mockRejectedValueOnce(new Error('network failed'))
      .mockResolvedValueOnce({
        total: 1,
        items: [
          {
            title: '重試成功',
            snippet: '第二次請求成功返回。',
            url: 'https://example.com/retry',
          },
        ],
      });

    render(<ReportNews recordId={1} />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重試' }));

    expect(await screen.findByText('重試成功')).toBeInTheDocument();
  });
});

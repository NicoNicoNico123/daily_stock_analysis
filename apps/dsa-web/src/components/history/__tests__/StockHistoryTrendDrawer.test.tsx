import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UiLanguageProvider } from '../../../contexts/UiLanguageContext';
import { UI_LANGUAGE_STORAGE_KEY } from '../../../utils/uiLanguage';
import { StockHistoryTrendDrawer } from '../StockHistoryTrendDrawer';
import type { AnalysisReport, HistoryItem } from '../../../types/analysis';

const report: AnalysisReport = {
  meta: {
    id: 1,
    queryId: 'q-1',
    stockCode: '600519',
    stockName: '貴州茅臺',
    reportType: 'detailed',
    createdAt: '2026-03-20T08:00:00Z',
  },
  summary: {
    analysisSummary: '等待確認',
    operationAdvice: '買入',
    action: 'avoid',
    actionLabel: '迴避',
    trendPrediction: '震盪',
    sentimentScore: 35,
  },
};

const items: HistoryItem[] = [
  {
    id: 1,
    queryId: 'q-1',
    stockCode: '600519',
    stockName: '貴州茅臺',
    sentimentScore: 35,
    operationAdvice: '買入',
    action: 'avoid',
    actionLabel: '迴避',
    trendPrediction: '震盪',
    createdAt: '2026-03-20T08:00:00Z',
  },
];

describe('StockHistoryTrendDrawer', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('uses structured action in summary and rows', () => {
    render(
      <StockHistoryTrendDrawer
        report={report}
        items={items}
        total={1}
        hasMore={false}
        isLoading={false}
        isLoadingMore={false}
        filters={{ range: 'all', model: 'all', sort: 'desc' }}
        onClose={vi.fn()}
        onRangeChange={vi.fn()}
        onLoadMore={vi.fn()}
        onSelectRecord={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getAllByText('迴避').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('買入')).not.toBeInTheDocument();
  });

  it('keeps full legacy operation advice when structured action is absent', () => {
    render(
      <StockHistoryTrendDrawer
        report={{
          ...report,
          summary: {
            ...report.summary,
            operationAdvice: '繼續持有，等待突破',
            action: null,
            actionLabel: null,
          },
        }}
        items={[
          {
            ...items[0],
            operationAdvice: '繼續持有，等待突破',
            action: null,
            actionLabel: null,
          },
        ]}
        total={1}
        hasMore={false}
        isLoading={false}
        isLoadingMore={false}
        filters={{ range: 'all', model: 'all', sort: 'desc' }}
        onClose={vi.fn()}
        onRangeChange={vi.fn()}
        onLoadMore={vi.fn()}
        onSelectRecord={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getAllByText('繼續持有，等待突破').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('持有')).not.toBeInTheDocument();
  });

  it('keeps multi-guard legacy advice as full text when structured action is absent', () => {
    render(
      <StockHistoryTrendDrawer
        report={{
          ...report,
          summary: {
            ...report.summary,
            operationAdvice: 'risk alert, avoid buying',
            action: null,
            actionLabel: null,
          },
        }}
        items={[
          {
            ...items[0],
            operationAdvice: 'risk alert, avoid buying',
            action: null,
            actionLabel: null,
          },
        ]}
        total={1}
        hasMore={false}
        isLoading={false}
        isLoadingMore={false}
        filters={{ range: 'all', model: 'all', sort: 'desc' }}
        onClose={vi.fn()}
        onRangeChange={vi.fn()}
        onLoadMore={vi.fn()}
        onSelectRecord={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getAllByText('risk alert, avoid buying').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('迴避')).not.toBeInTheDocument();
    expect(screen.queryByText('預警')).not.toBeInTheDocument();
  });

  it('uses localized taxonomy labels before server labels in English UI mode', () => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'en');

    render(
      <UiLanguageProvider>
        <StockHistoryTrendDrawer
          report={{
            ...report,
            summary: {
              ...report.summary,
              action: 'sell',
              actionLabel: '買入',
            },
          }}
          items={[
            {
              ...items[0],
              action: 'sell',
              actionLabel: '買入',
            },
          ]}
          total={1}
          hasMore={false}
          isLoading={false}
          isLoadingMore={false}
          filters={{ range: 'all', model: 'all', sort: 'desc' }}
          onClose={vi.fn()}
          onRangeChange={vi.fn()}
          onLoadMore={vi.fn()}
          onSelectRecord={vi.fn()}
          onRetry={vi.fn()}
        />
      </UiLanguageProvider>,
    );

    expect(screen.getAllByText('Sell').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('買入')).not.toBeInTheDocument();
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { AnalysisReport, MarketReviewPayload } from '../../../types/analysis';
import { UiLanguageProvider } from '../../../contexts/UiLanguageContext';
import { UI_LANGUAGE_STORAGE_KEY } from '../../../utils/uiLanguage';
import { MarketReviewReportView } from '../MarketReviewReportView';
import { historyApi } from '../../../api/history';

const renderWithUiLanguage = (ui: ReactNode, language: 'zh' | 'en') => {
  window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, language);
  return render(<UiLanguageProvider>{ui}</UiLanguageProvider>);
};

vi.mock('../../../api/history', () => ({
  historyApi: {
    getMarkdown: vi.fn(),
    getTranslation: vi.fn(),
  },
}));

const englishMarketReviewReport: AnalysisReport = {
  meta: {
    queryId: 'market-review-q-1',
    stockCode: 'MARKET',
    stockName: 'Market Review',
    reportType: 'market_review',
    reportLanguage: 'en',
    createdAt: '2026-03-18T08:00:00Z',
  },
  summary: {
    analysisSummary: '',
    operationAdvice: '',
    trendPrediction: '',
    sentimentScore: undefined as unknown as number,
  },
};

const combinedMarketReviewPayload: MarketReviewPayload = {
  version: 1,
  kind: 'market_review',
  region: 'cn,hk',
  language: 'zh',
  rootTitle: '大盤覆盤',
  markets: {
    cn: {
      title: 'A股市場',
      breadth: {
        upCount: 3120,
        downCount: 1420,
        limitUpCount: 72,
        limitDownCount: 4,
        totalAmount: 9600,
        turnoverUnit: '億元',
      },
      indices: [{
        code: '000300',
        name: '滬深300',
        current: 3920.2,
        changePct: 1.2,
        high: 3940.5,
        low: 3860.1,
      }],
      sectors: {
        top: [{ name: '半導體', changePct: 2.35 }],
        bottom: [{ name: '煤炭', changePct: -1.1 }],
      },
      concepts: {
        top: [{ name: '機器人概念', changePct: 4.2 }],
        bottom: [{ name: '轉基因', changePct: -2.05 }],
      },
    },
    hk: {
      title: '港股市場',
      breadth: {
        upCount: 680,
        downCount: 410,
        limitUpCount: 0,
        limitDownCount: 0,
        totalAmount: 1180,
        turnoverUnit: '億港元',
      },
      indices: [{
        code: 'HSI',
        name: '恒生指數',
        current: 18920.4,
        changePct: -0.5,
        high: 19050.2,
        low: 18780.3,
      }],
    },
  },
};

const noBreadthMarketReviewPayload: MarketReviewPayload = {
  version: 1,
  kind: 'market_review',
  region: 'us',
  language: 'en',
  title: 'Market Review',
  rootTitle: 'Market Review',
  indices: [{
    code: 'SPX',
    name: 'S&P 500',
    current: 5200,
    changePct: 0.68,
    high: 5235.2,
    low: 5170.4,
  }],
  sectors: {
    top: [{ name: 'Technology', changePct: 1.9 }],
    bottom: [{ name: 'Energy', changePct: -0.8 }],
  },
  news: [],
  sections: [],
};

const chineseMarketReviewReport: AnalysisReport = {
  meta: {
    id: 9001,
    queryId: 'market-review-q-zh',
    stockCode: 'MARKET',
    stockName: '大盘复盘',
    reportType: 'market_review',
    reportLanguage: 'zh',
    createdAt: '2026-09-15T08:00:00Z',
  },
  summary: {
    analysisSummary: '2026-09-15 大盘复盘',
    operationAdvice: '查看复盘',
    trendPrediction: '大盘复盘',
    sentimentScore: 50,
  },
};

const chineseReviewPayload: MarketReviewPayload = {
  version: 1,
  kind: 'market_review',
  region: 'hk',
  language: 'zh',
  title: '2026-09-15 大盘复盘',
  sections: [{
    key: 'market_overview',
    title: '一、盘面总览',
    markdown: '恒生指数收跌 0.86%，科技股相对抗跌。',
  }],
  news: [],
};

describe('MarketReviewReportView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(historyApi.getMarkdown).mockResolvedValue('# 大盤覆盤');
  });

  it('uses localized summary card labels and fallbacks for an english interface', () => {
    renderWithUiLanguage(
      <MarketReviewReportView
        report={englishMarketReviewReport}
        content="# Market Review"
      />,
      'en',
    );

    expect(screen.getByText('Review Summary')).toBeInTheDocument();
    expect(screen.getByText('No review summary yet')).toBeInTheDocument();
    expect(screen.getByText('Market Sentiment')).toBeInTheDocument();
    expect(screen.getByText('No score yet')).toBeInTheDocument();
    expect(screen.getByText('Rotation & Funds')).toBeInTheDocument();
    expect(screen.getByText('No rotation view yet')).toBeInTheDocument();
    expect(screen.getByText('Risks & Watchlist')).toBeInTheDocument();
    expect(screen.getByText('No key observations yet')).toBeInTheDocument();
    expect(screen.queryByText('覆盤摘要')).not.toBeInTheDocument();
    expect(screen.queryByText('暫無摘要')).not.toBeInTheDocument();
  });

  it('renders structured data for every market in a combined market review payload', () => {
    render(
      <MarketReviewReportView
        payload={combinedMarketReviewPayload}
        content="# 大盤覆盤"
      />,
    );

    expect(screen.getByText('A股市場')).toBeInTheDocument();
    expect(screen.getByText('港股市場')).toBeInTheDocument();
    expect(screen.getByText('滬深300')).toBeInTheDocument();
    expect(screen.getByText('恒生指數')).toBeInTheDocument();
    expect(screen.getByText('3120')).toBeInTheDocument();
    expect(screen.getByText('680')).toBeInTheDocument();
  });

  it('renders industry and concept rankings from structured market review payloads', () => {
    render(
      <MarketReviewReportView
        payload={combinedMarketReviewPayload}
        content="# 大盤覆盤"
      />,
    );

    expect(screen.getAllByText('行業板塊')).toHaveLength(2);
    expect(screen.getAllByText('概念板塊')).toHaveLength(2);
    expect(screen.getByText('半導體')).toBeInTheDocument();
    expect(screen.getByText('機器人概念')).toBeInTheDocument();
    expect(screen.getByText('+4.20%')).toBeInTheDocument();
    expect(screen.getByText('-2.05%')).toBeInTheDocument();
  });

  it('localizes structured market data labels with the chinese interface', () => {
    render(
      <MarketReviewReportView
        payload={combinedMarketReviewPayload}
        content="# 大盤覆盤"
      />,
    );

    expect(screen.getByText('結構化大盤數據')).toBeInTheDocument();
    expect(screen.getAllByText('上漲家數')).toHaveLength(2);
    expect(screen.getAllByText('下跌家數')).toHaveLength(2);
    expect(screen.getAllByText('漲停/跌停')).toHaveLength(2);
    expect(screen.getAllByText('成交額')).toHaveLength(2);
    expect(screen.getAllByText('指數')).toHaveLength(2);
    expect(screen.getAllByText('最新')).toHaveLength(2);
    expect(screen.getAllByText('漲跌幅')).toHaveLength(2);
    expect(screen.getAllByText('高/低')).toHaveLength(2);
    expect(screen.queryByText('Structured Market Data')).not.toBeInTheDocument();
    expect(screen.queryByText('Advancers')).not.toBeInTheDocument();
    expect(screen.queryByText('Index')).not.toBeInTheDocument();
  });

  it('keeps chinese interface labels even when the review payload is english', () => {
    render(
      <MarketReviewReportView
        payload={noBreadthMarketReviewPayload}
        content="# Market Review"
      />,
    );

    expect(screen.getByText('結構化大盤數據')).toBeInTheDocument();
    expect(screen.getByText('暫無數據')).toBeInTheDocument();
    expect(screen.getByText('S&P 500')).toBeInTheDocument();
    expect(screen.getAllByText('行業板塊').length).toBeGreaterThan(0);
    expect(screen.getByText('Technology')).toBeInTheDocument();
    expect(screen.getByText('Energy')).toBeInTheDocument();
    expect(screen.queryByText('Structured Market Data')).not.toBeInTheDocument();
    expect(screen.queryByText('No data')).not.toBeInTheDocument();
  });

  it('shows "No data" when breadth is not available for a market review payload', () => {
    renderWithUiLanguage(
      <MarketReviewReportView
        payload={noBreadthMarketReviewPayload}
        content="# Market Review"
      />,
      'en',
    );

    expect(screen.getByText('Structured Market Data')).toBeInTheDocument();
    expect(screen.getByText('No data')).toBeInTheDocument();
    expect(screen.getByText('S&P 500')).toBeInTheDocument();
    expect(screen.getAllByText('Industry Sectors').length).toBeGreaterThan(0);
    expect(screen.getByText('Technology')).toBeInTheDocument();
    expect(screen.getByText('Energy')).toBeInTheDocument();
    expect(screen.queryByText('Advancers')).not.toBeInTheDocument();
    expect(screen.queryByText('Decliners')).not.toBeInTheDocument();
  });

  it('formats structured market numbers to two decimal places', () => {
    const payload: MarketReviewPayload = {
      version: 1,
      kind: 'market_review',
      region: 'cn',
      language: 'en',
      title: 'Market Review',
      rootTitle: 'Market Review',
      breadth: {
        upCount: 4327,
        downCount: 1145,
        limitUpCount: 222,
        limitDownCount: 12,
        totalAmount: 36822.49698199988,
        turnoverUnit: 'bn',
      },
      indices: [{
        code: '000001',
        name: 'Shanghai Composite',
        current: 4112.446,
        changePct: 0.44079750937683315,
        high: 4143.314,
        low: 4087.536,
      }],
    };

    render(
      <MarketReviewReportView
        payload={payload}
        content="# Market Review"
      />,
    );

    expect(screen.getByText('36822.50 bn')).toBeInTheDocument();
    expect(screen.getByText('4112.45')).toBeInTheDocument();
    expect(screen.getByText('0.44%')).toBeInTheDocument();
    expect(screen.getByText('4143.31 / 4087.54')).toBeInTheDocument();
    expect(screen.queryByText(/36822\.496/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0\.440797/)).not.toBeInTheDocument();
  });

  it('formats string-backed market numbers and hides missing high/low zeros', () => {
    const payload = {
      version: 1,
      kind: 'market_review',
      region: 'cn',
      language: 'en',
      title: 'Market Review',
      rootTitle: 'Market Review',
      breadth: {
        upCount: '4,327',
        downCount: '1,145',
        limitUpCount: '0',
        limitDownCount: '12',
        totalAmount: '36,822.49698199988',
        turnoverUnit: 'bn',
      },
      indices: [{
        code: '000001',
        name: 'Shanghai Composite',
        current: '4,112.446',
        changePct: '0.44079750937683315%',
        high: 0,
        low: '0',
      }],
    } as unknown as MarketReviewPayload;

    render(
      <MarketReviewReportView
        payload={payload}
        content="# Market Review"
      />,
    );

    expect(screen.getByText('4327')).toBeInTheDocument();
    expect(screen.getByText('36822.50 bn')).toBeInTheDocument();
    expect(screen.getByText('4112.45')).toBeInTheDocument();
    expect(screen.getByText('0.44%')).toBeInTheDocument();
    expect(screen.queryByText('0.00 / 0.00')).not.toBeInTheDocument();
    expect(screen.queryByText(/0\.440797/)).not.toBeInTheDocument();
  });

  it('opens run flow for historical market review records', () => {
    const onOpenRunFlow = vi.fn();

    render(
      <MarketReviewReportView
        payload={combinedMarketReviewPayload}
        content="# 大盤覆盤"
        recordId={7}
        onOpenRunFlow={onOpenRunFlow}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '查看歷史記錄 7 運行流' }));

    expect(onOpenRunFlow).toHaveBeenCalledWith(7);
  });

  it('renders translated review body and summary cards for an english interface', async () => {
    vi.mocked(historyApi.getTranslation).mockResolvedValue({
      cached: true,
      targetLang: 'en',
      summary: {
        analysisSummary: '2026-09-15 Market Recap',
        operationAdvice: 'View Recap',
        trendPrediction: 'Tech stabilizing while heavyweights drag',
      },
      strategy: {},
      markdown: '# Market Recap\n\n## 2026-09-15 Market Recap\n\n### I. Market Overview\n\nHang Seng Index closed lower.\n',
    });

    renderWithUiLanguage(
      <MarketReviewReportView
        report={chineseMarketReviewReport}
        recordId={9001}
        payload={chineseReviewPayload}
      />,
      'en',
    );

    await waitFor(() => {
      expect(historyApi.getTranslation).toHaveBeenCalledWith(9001, 'en');
    });

    // 摘要卡使用译文
    expect(await screen.findByText('2026-09-15 Market Recap')).toBeVisible();
    expect(screen.getByText('View Recap')).toBeVisible();
    // 正文来自译文 markdown，而不是中文 payload sections
    expect(screen.getByText('Hang Seng Index closed lower.')).toBeVisible();
    expect(screen.queryByText('一、盤面總覽')).not.toBeInTheDocument();
  });

  it('keeps the original review content when the translation request fails', async () => {
    vi.mocked(historyApi.getTranslation).mockRejectedValue(new Error('translation unavailable'));

    renderWithUiLanguage(
      <MarketReviewReportView
        report={chineseMarketReviewReport}
        recordId={9002}
        payload={chineseReviewPayload}
      />,
      'en',
    );

    await waitFor(() => {
      expect(historyApi.getTranslation).toHaveBeenCalled();
    });
    expect(await screen.findByText('一、盘面总览')).toBeVisible();
  });

  it('does not fetch a translation for a chinese interface', async () => {
    renderWithUiLanguage(
      <MarketReviewReportView
        report={chineseMarketReviewReport}
        recordId={9003}
        payload={chineseReviewPayload}
      />,
      'zh',
    );

    expect(await screen.findByText('一、盘面总览')).toBeVisible();
    expect(historyApi.getTranslation).not.toHaveBeenCalled();
  });
});

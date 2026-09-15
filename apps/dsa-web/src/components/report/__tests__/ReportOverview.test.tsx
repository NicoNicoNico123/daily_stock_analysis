import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UiLanguageProvider } from '../../../contexts/UiLanguageContext';
import { UI_LANGUAGE_STORAGE_KEY } from '../../../utils/uiLanguage';
import { ReportOverview } from '../ReportOverview';

const renderWithUiLanguage = (ui: ReactNode, language: 'zh' | 'en') => {
  window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, language);
  return render(<UiLanguageProvider>{ui}</UiLanguageProvider>);
};

const baseMeta = {
  queryId: 'q-1',
  stockCode: '600519',
  stockName: '貴州茅臺',
  reportType: 'detailed' as const,
  reportLanguage: 'zh' as const,
  createdAt: '2026-03-21T08:00:00Z',
};

const baseSummary = {
  analysisSummary: '趨勢維持強勢',
  operationAdvice: '繼續觀察買點',
  trendPrediction: '短線震盪偏強',
  sentimentScore: 78,
};

describe('ReportOverview', () => {
  it('renders final market phase and partial-bar labels from report metadata', () => {
    render(
      <ReportOverview
        meta={{
          ...baseMeta,
          marketPhaseSummary: {
            market: 'cn',
            phase: 'intraday',
            marketLocalTime: '2026-03-21T10:30:00+08:00',
            sessionDate: '2026-03-21',
            effectiveDailyBarDate: '2026-03-20',
            isTradingDay: true,
            isMarketOpenNow: true,
            isPartialBar: true,
            minutesToOpen: null,
            minutesToClose: 150,
            triggerSource: 'api',
            analysisIntent: 'auto',
            warnings: [],
          },
        }}
        summary={baseSummary}
      />,
    );

    expect(screen.getByLabelText('市場階段: CN · 盤中')).toBeInTheDocument();
    expect(screen.getByText('市場階段: CN · 盤中')).toBeVisible();
    expect(screen.getByLabelText('日線未完成')).toBeInTheDocument();
  });

  it('renders English final market phase and partial-bar labels for an english interface', () => {
    renderWithUiLanguage(
      <ReportOverview
        meta={{
          ...baseMeta,
          reportLanguage: 'en',
          marketPhaseSummary: {
            market: 'us',
            phase: 'postmarket',
            marketLocalTime: '2026-03-21T16:30:00-04:00',
            sessionDate: '2026-03-21',
            effectiveDailyBarDate: '2026-03-21',
            isTradingDay: true,
            isMarketOpenNow: false,
            isPartialBar: true,
            minutesToOpen: null,
            minutesToClose: null,
            triggerSource: 'api',
            analysisIntent: 'auto',
            warnings: [],
          },
        }}
        summary={baseSummary}
      />,
      'en',
    );

    expect(screen.getByLabelText('Market phase: US · Post-market')).toBeInTheDocument();
    expect(screen.getByLabelText('Partial bar')).toBeInTheDocument();
    expect(screen.getByText('KEY INSIGHTS')).toBeInTheDocument();
  });

  it('keeps chinese labels for an english report when the interface language is chinese', () => {
    renderWithUiLanguage(
      <ReportOverview
        meta={{
          ...baseMeta,
          reportLanguage: 'en',
          marketPhaseSummary: {
            market: 'us',
            phase: 'postmarket',
            marketLocalTime: '2026-03-21T16:30:00-04:00',
            sessionDate: '2026-03-21',
            effectiveDailyBarDate: '2026-03-21',
            isTradingDay: true,
            isMarketOpenNow: false,
            isPartialBar: true,
            minutesToOpen: null,
            minutesToClose: null,
            triggerSource: 'api',
            analysisIntent: 'auto',
            warnings: [],
          },
        }}
        summary={baseSummary}
      />,
      'zh',
    );

    expect(screen.getByLabelText('市場階段: US · 盤後')).toBeInTheDocument();
    expect(screen.getByLabelText('日線未完成')).toBeInTheDocument();
    expect(screen.getByText('核心洞察')).toBeInTheDocument();
    expect(screen.queryByText('Market phase: US · Post-market')).not.toBeInTheDocument();
    expect(screen.queryByText('KEY INSIGHTS')).not.toBeInTheDocument();
  });

  it('renders unknown final phase without partial-bar label', () => {
    render(
      <ReportOverview
        meta={{
          ...baseMeta,
          marketPhaseSummary: {
            market: null,
            phase: 'unknown',
            marketLocalTime: null,
            sessionDate: null,
            effectiveDailyBarDate: null,
            isTradingDay: null,
            isMarketOpenNow: null,
            isPartialBar: false,
            minutesToOpen: null,
            minutesToClose: null,
            triggerSource: 'api',
            analysisIntent: 'auto',
            warnings: ['calendar_unavailable'],
          },
        }}
        summary={baseSummary}
      />,
    );

    expect(screen.getByText('市場階段: 階段未知')).toBeVisible();
    expect(screen.queryByText('日線未完成')).not.toBeInTheDocument();
  });

  it('does not render a market phase placeholder for legacy reports', () => {
    render(<ReportOverview meta={baseMeta} summary={baseSummary} />);

    expect(screen.queryByText(/市场阶段/)).not.toBeInTheDocument();
    expect(screen.queryByText('日線未完成')).not.toBeInTheDocument();
  });

  it('renders related boards with leading and lagging markers', () => {
    render(
      <ReportOverview
        meta={baseMeta}
        summary={baseSummary}
        details={{
          belongBoards: [
            { name: ' 白酒 ', type: '行業' },
            { name: '消費', type: '概念' },
            { name: '新能源' },
          ],
          sectorRankings: {
            top: [{ name: '白酒', changePct: 2.31 }],
            bottom: [{ name: '新能源', changePct: -1.2 }],
          },
          conceptRankings: {
            top: [{ name: '消費', changePct: 4.56 }],
            bottom: [],
          },
        }}
      />,
    );

    expect(screen.getByText('關聯板塊')).toBeInTheDocument();
    expect(screen.getByText('白酒')).toBeInTheDocument();
    expect(screen.getAllByText('領漲')).toHaveLength(2);
    expect(screen.getByText('+2.31%')).toBeInTheDocument();
    expect(screen.getByText('+4.56%')).toBeInTheDocument();
    expect(screen.getByText('領跌')).toBeInTheDocument();
    expect(screen.getByText('-1.20%')).toBeInTheDocument();
    expect(screen.queryByText('中性')).not.toBeInTheDocument();
  });

  it('does not apply industry ranking to a concept board with the same name', () => {
    render(
      <ReportOverview
        meta={baseMeta}
        summary={baseSummary}
        details={{
          belongBoards: [{ name: '白酒', type: '概念' }],
          sectorRankings: {
            top: [{ name: '白酒', changePct: 2.31 }],
            bottom: [],
          },
          conceptRankings: {
            top: [],
            bottom: [{ name: '白酒', changePct: -3.2 }],
          },
        }}
      />,
    );

    expect(screen.getByText('白酒')).toBeInTheDocument();
    expect(screen.getByText('關聯板塊')).toBeInTheDocument();
    expect(screen.getByText('領跌')).toBeInTheDocument();
    expect(screen.getByText('-3.20%')).toBeInTheDocument();
    expect(screen.queryByText('+2.31%')).not.toBeInTheDocument();
  });

  it('renders untyped boards in a single related-board row with ranking matches', () => {
    const conceptRankingBoard = '榜單樣例甲';
    const fallbackConceptBoard = '未標註板塊';
    const sectorRankingBoard = '榜單樣例乙';

    render(
      <ReportOverview
        meta={baseMeta}
        summary={baseSummary}
        details={{
          belongBoards: [
            { name: conceptRankingBoard },
            { name: fallbackConceptBoard },
            { name: sectorRankingBoard },
          ],
          sectorRankings: {
            top: [{ name: sectorRankingBoard, changePct: 1.11 }],
            bottom: [],
          },
          conceptRankings: {
            top: [{ name: conceptRankingBoard, changePct: 3.21 }],
            bottom: [],
          },
        }}
      />,
    );

    const relatedBoardsRegion = screen.getByRole('region', { name: '關聯板塊' });

    expect(within(relatedBoardsRegion).getByText(sectorRankingBoard)).toBeInTheDocument();
    expect(within(relatedBoardsRegion).getByText(conceptRankingBoard)).toBeInTheDocument();
    expect(within(relatedBoardsRegion).getByText(fallbackConceptBoard)).toBeInTheDocument();
    expect(within(relatedBoardsRegion).getByText('+3.21%')).toBeInTheDocument();
  });

  it('places related boards below action advice in one horizontal row', () => {
    const { container } = render(
      <ReportOverview
        meta={baseMeta}
        summary={baseSummary}
        details={{
          belongBoards: [
            { name: '白酒', type: '行業' },
            { name: '消費', type: '概念' },
            { name: '高端製造' },
            { name: '滬股通' },
          ],
        }}
      />,
    );

    const actionAdviceTitle = screen.getByText('操作建議');
    const relatedBoardsRegion = screen.getByRole('region', { name: '關聯板塊' });
    const boardLists = container.querySelectorAll('.home-related-board-list');

    expect(actionAdviceTitle.compareDocumentPosition(relatedBoardsRegion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('關聯板塊')).toBeInTheDocument();
    expect(screen.getByText('滬股通')).toBeInTheDocument();
    expect(boardLists[0]).toHaveClass(
      'flex-nowrap',
      'overflow-x-auto',
      'w-full',
      'min-w-0',
      'max-w-full',
      'touch-pan-x',
    );
  });

  it('shows board list when rankings are unavailable', () => {
    render(
      <ReportOverview
        meta={baseMeta}
        summary={baseSummary}
        details={{
          belongBoards: [{ name: '半導體', type: '行業' }],
        }}
      />,
    );

    expect(screen.getByText('關聯板塊')).toBeInTheDocument();
    expect(screen.getByText('半導體')).toBeInTheDocument();
    expect(screen.queryByText('中性')).not.toBeInTheDocument();
    expect(screen.queryByText('領漲')).not.toBeInTheDocument();
    expect(screen.queryByText('領跌')).not.toBeInTheDocument();
  });

  it('shows only the board when a matching ranking has no change percent', () => {
    render(
      <ReportOverview
        meta={baseMeta}
        summary={baseSummary}
        details={{
          belongBoards: [{ name: '白酒', type: '行業' }],
          sectorRankings: {
            top: [{ name: '白酒' }],
            bottom: [],
          },
        }}
      />,
    );

    expect(screen.getByText('關聯板塊')).toBeInTheDocument();
    expect(screen.getByText('白酒')).toBeInTheDocument();
    expect(screen.queryByText('行業')).not.toBeInTheDocument();
    expect(screen.queryByText('領漲')).not.toBeInTheDocument();
    expect(screen.queryByText('領跌')).not.toBeInTheDocument();
  });

  it('hides related boards section when no boards are available', () => {
    render(<ReportOverview meta={baseMeta} summary={baseSummary} details={{ belongBoards: [] }} />);

    expect(screen.queryByText('板塊聯動')).not.toBeInTheDocument();
  });

  it('renders the persisted empty-news disclosure beside the core conclusion', () => {
    render(
      <ReportOverview
        meta={baseMeta}
        summary={baseSummary}
        details={{
          emptyNewsDisclosure: '⚠️ 未配置搜索渠道，本次分析未納入新聞面證據。',
        }}
      />,
    );

    expect(screen.getByRole('note')).toHaveTextContent('未配置搜索渠道');
    expect(screen.getByRole('note')).toHaveTextContent('未納入新聞面證據');
  });

  it('fails open on malformed ranking payloads', () => {
    render(
      <ReportOverview
        meta={baseMeta}
        summary={baseSummary}
        details={{
          belongBoards: [{ name: ' 白酒 ' }],
          sectorRankings: {
            top: {} as unknown as never[],
            bottom: [{ name: '白酒', changePct: '-2.5%' as unknown as number }],
          },
        }}
      />,
    );

    expect(screen.getByText('關聯板塊')).toBeInTheDocument();
    expect(screen.getByText('白酒')).toBeInTheDocument();
    expect(screen.getByText('領跌')).toBeInTheDocument();
    expect(screen.getByText('-2.50%')).toBeInTheDocument();
  });

  it('hides the stock-only watchlist card for index reports', () => {
    render(
      <ReportOverview
        meta={{ ...baseMeta, stockCode: 'sh000016', assetType: 'index' }}
        summary={baseSummary}
        watchlist={{
          isInWatchlist: () => false,
          onToggle: () => {},
          isActioning: false,
          actionMessage: null,
        }}
      />,
    );

    expect(screen.queryByText('自選')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /自選/ })).not.toBeInTheDocument();
  });

  it('keeps the stock-only watchlist card for stock reports', () => {
    render(
      <ReportOverview
        meta={{ ...baseMeta, stockCode: '600519', assetType: 'stock' }}
        summary={baseSummary}
        watchlist={{
          isInWatchlist: () => false,
          onToggle: () => {},
          isActioning: false,
          actionMessage: null,
        }}
      />,
    );

    expect(screen.getByText('自選')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '加入自選' })).toBeInTheDocument();
  });

  it('keeps the stock-only watchlist card when assetType is absent (legacy)', () => {
    render(
      <ReportOverview
        meta={{ ...baseMeta, stockCode: '600519' }}
        summary={baseSummary}
        watchlist={{
          isInWatchlist: () => false,
          onToggle: () => {},
          isActioning: false,
          actionMessage: null,
        }}
      />,
    );

    expect(screen.getByText('自選')).toBeInTheDocument();
  });
});

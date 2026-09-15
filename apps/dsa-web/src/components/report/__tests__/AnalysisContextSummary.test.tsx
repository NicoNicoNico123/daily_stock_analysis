import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { historyApi } from '../../../api/history';
import type {
  AnalysisContextPackOverview,
  AnalysisReport,
  AnalysisResult,
  MarketStructureContext,
} from '../../../types/analysis';
import { AnalysisContextSummary } from '../AnalysisContextSummary';
import { ReportSummary } from '../ReportSummary';
import { UiLanguageProvider } from '../../../contexts/UiLanguageContext';
import { UI_LANGUAGE_STORAGE_KEY } from '../../../utils/uiLanguage';

vi.mock('../../../api/history', () => ({
  historyApi: {
    getDiagnostics: vi.fn(),
    getNews: vi.fn(),
  },
}));

const overview: AnalysisContextPackOverview = {
  packVersion: '1.0',
  createdAt: '2026-04-10T08:30:00+00:00',
  subject: {
    code: '600519',
    stockName: '貴州茅臺',
    market: 'cn',
  },
  blocks: [
    {
      key: 'quote',
      label: '行情',
      status: 'available',
      source: 'mock_quote',
      warnings: [],
      missingReasons: [],
    },
    {
      key: 'news',
      label: '新聞',
      status: 'missing',
      source: null,
      warnings: ['news_provider_timeout'],
      missingReasons: ['news_context_missing'],
    },
    {
      key: 'fundamentals',
      label: '基本面',
      status: 'fetch_failed',
      source: 'fundamental_pipeline',
      warnings: [],
      missingReasons: ['fundamental_pipeline_failed'],
    },
  ],
  counts: {
    available: 1,
    missing: 1,
    notSupported: 0,
    fallback: 0,
    stale: 0,
    estimated: 0,
    partial: 0,
    fetchFailed: 1,
  },
  dataQuality: {
    overallScore: 82,
    level: 'usable',
    blockScores: {
      quote: 100,
      daily_bars: 100,
      technical: 100,
      news: 35,
      fundamentals: 25,
      chip: 100,
    },
    limitations: ['fundamentals: fetch_failed'],
  },
  warnings: ['intraday_realtime_overlay'],
  metadata: {
    triggerSource: 'api',
    newsResultCount: 3,
  },
};

const marketStructure: MarketStructureContext = {
  schemaVersion: 'market-structure-v1',
  status: 'ok',
  market: 'cn',
  tradeDate: '2026-07-12',
  marketThemeContext: {
    schemaVersion: 'market-theme-v1',
    status: 'ok',
    market: 'cn',
    activeThemes: [{ name: 'Robotics', rank: 1, source: 'concept' }],
    leadingConcepts: [],
    leadingIndustries: [],
    laggingThemes: [],
    themeBreadth: {
      activeCount: 1,
      leadingConceptCount: 0,
      leadingIndustryCount: 0,
      laggingCount: 0,
    },
    dataQuality: { status: 'ok', missingFields: [], sources: [], errors: [] },
  },
  stockMarketPosition: {
    schemaVersion: 'stock-market-position-v1',
    status: 'ok',
    stockCode: '600519',
    stockName: 'Kweichow Moutai',
    market: 'cn',
    primaryTheme: { name: 'Robotics', source: 'concept', rank: 1 },
    relatedBoards: [],
    stockRole: 'follower',
    themePhase: 'accelerating',
    riskTags: [],
    missingFields: [],
  },
};

describe('AnalysisContextSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a collapsed summary and expands overview details on demand', () => {
    render(<AnalysisContextSummary overview={overview} />);

    const panel = screen.getByTestId('analysis-context-summary');
    expect(panel).not.toHaveAttribute('open');
    expect(within(panel).getAllByText('輸入數據塊')[0]).toBeVisible();
    expect(screen.getAllByText('可用 1')[0]).toBeVisible();
    expect(screen.getAllByText('缺失 1')[0]).toBeVisible();
    expect(screen.getAllByText('抓取失敗 1')[0]).toBeVisible();
    expect(screen.getAllByText('質量分 82/100 可用')[0]).toBeVisible();
    expect(screen.getByText('觸發來源: api')).toBeVisible();
    expect(screen.getByText('來源: mock_quote')).not.toBeVisible();

    fireEvent.click(within(panel).getAllByText('輸入數據塊')[0]);

    expect(panel).toHaveAttribute('open');
    expect(screen.getByText('行情')).toBeInTheDocument();
    expect(screen.getByText('來源: mock_quote')).toBeVisible();
    expect(screen.getByText('告警:')).toBeInTheDocument();
    expect(screen.getByText(/intraday_realtime_overlay/)).toBeInTheDocument();
    expect(screen.getByText('數據限制:')).toBeInTheDocument();
    expect(screen.getByText(/基本面：抓取失敗/)).toBeInTheDocument();
    expect(screen.getByText(/news_provider_timeout/)).toBeInTheDocument();
    expect(screen.getByText(/說明: 新聞未進入本次 LLM 分析，結論未使用新聞上下文/)).toBeInTheDocument();
    expect(screen.getByText(/診斷碼: news_context_missing/)).toBeInTheDocument();
    expect(screen.getByText(/報告頁相關資訊由獨立接口補充，顯示與否不代表已進入本次分析/)).toBeInTheDocument();
    expect(screen.getByText('來源: 未記錄輸入來源')).toBeInTheDocument();
    expect(screen.queryByText(/^处理:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^范围:/)).not.toBeInTheDocument();
    const fundamentalsBlock = screen.getByText('基本面').closest('.home-subpanel');
    expect(fundamentalsBlock).not.toBeNull();
    const fundamentals = within(fundamentalsBlock as HTMLElement);
    expect(fundamentals.getByText(/說明: 基本面抓取失敗，本次分析未使用基本面數據/)).toBeInTheDocument();
    expect(fundamentals.getByText(/診斷碼: fundamental_pipeline_failed/)).toBeInTheDocument();
    expect(screen.getAllByText('新聞結果數: 3').some((item) => item.textContent === '新聞結果數: 3')).toBe(true);
    expect(screen.getAllByText('本次分析輸入')[0]).toBeVisible();
  });

  it('localizes the collapsed summary for an english interface', () => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'en');
    render(
      <UiLanguageProvider>
        <AnalysisContextSummary overview={overview} />
      </UiLanguageProvider>,
    );

    const panel = screen.getByTestId('analysis-context-summary');
    expect(panel).not.toHaveAttribute('open');
    expect(screen.getAllByText('Input Blocks')[0]).toBeVisible();
    expect(screen.getByText('Shows inputs included in this LLM run, not provider run success')).toBeVisible();
    expect(screen.getAllByText('Available 1')[0]).toBeVisible();
    expect(screen.getAllByText('Missing 1')[0]).toBeVisible();
    expect(screen.getAllByText('Fetch failed 1')[0]).toBeVisible();
    expect(screen.getAllByText('Quality 82/100 Usable')[0]).toBeVisible();
    expect(screen.getByText('Trigger: api')).toBeVisible();

    fireEvent.click(within(panel).getAllByText('Input Blocks')[0]);

    expect(screen.getByText('Data Limitations:')).toBeInTheDocument();
    expect(screen.getByText(/fundamentals: Fetch failed/)).toBeInTheDocument();
    expect(screen.getByText(/Details: News was not included in this LLM run, so the conclusion did not use news context/)).toBeInTheDocument();
    expect(screen.getByText(/related news on the report page is loaded separately and does not indicate that it was used in this analysis/)).toBeInTheDocument();
    expect(screen.getByText(/Diagnostic code: news_context_missing/)).toBeInTheDocument();
    expect(screen.queryByText(/^Action:/)).not.toBeInTheDocument();
  });

  it('does not claim available fundamentals were unused when only provenance is missing', () => {
    const availableFundamentalsOverview: AnalysisContextPackOverview = {
      ...overview,
      blocks: [{
        key: 'fundamentals',
        label: '基本面',
        status: 'available',
        source: null,
        warnings: [],
        missingReasons: ['fundamental_source_chain_missing'],
      }],
      counts: {
        available: 1,
        missing: 0,
        notSupported: 0,
        fallback: 0,
        stale: 0,
        estimated: 0,
        partial: 0,
        fetchFailed: 0,
      },
    };

    render(<AnalysisContextSummary overview={availableFundamentalsOverview} />);

    fireEvent.click(screen.getAllByText('輸入數據塊')[0]);

    expect(screen.getByText(/說明: 未記錄基本面來源鏈元數據/)).toBeInTheDocument();
    expect(screen.getByText(/基本面是否進入本次分析以當前狀態爲準/)).toBeInTheDocument();
    expect(screen.getByText(/診斷碼: fundamental_source_chain_missing/)).toBeInTheDocument();
    expect(screen.queryByText(/本次分析未使用基本面数据/)).not.toBeInTheDocument();
  });

  it('uses status guidance for unknown reason codes without adding another field', () => {
    const unknownReasonOverview: AnalysisContextPackOverview = {
      ...overview,
      blocks: [{
        key: 'fundamentals',
        label: '基本面',
        status: 'fetch_failed',
        source: 'fundamental_pipeline',
        warnings: [],
        missingReasons: ['brand_new_internal_code'],
      }],
      counts: {
        available: 0,
        missing: 0,
        notSupported: 0,
        fallback: 0,
        stale: 0,
        estimated: 0,
        partial: 0,
        fetchFailed: 1,
      },
    };

    render(<AnalysisContextSummary overview={unknownReasonOverview} />);

    fireEvent.click(screen.getAllByText('輸入數據塊')[0]);

    expect(screen.getByText(/說明: 數據抓取失敗，本次分析未使用該數據；請檢查數據源、網絡或限流後重新分析/)).toBeInTheDocument();
    expect(screen.getByText(/診斷碼: brand_new_internal_code/)).toBeInTheDocument();
    expect(screen.queryByText(/^处理:/)).not.toBeInTheDocument();
  });

  it('explains the real chip_not_supported reason with actionable guidance', () => {
    const unsupportedChipOverview: AnalysisContextPackOverview = {
      ...overview,
      blocks: [{
        key: 'chip',
        label: '籌碼',
        status: 'not_supported',
        source: null,
        warnings: [],
        missingReasons: ['chip_not_supported'],
      }],
      counts: {
        available: 0,
        missing: 0,
        notSupported: 1,
        fallback: 0,
        stale: 0,
        estimated: 0,
        partial: 0,
        fetchFailed: 0,
      },
    };

    render(<AnalysisContextSummary overview={unsupportedChipOverview} />);

    fireEvent.click(screen.getAllByText('輸入數據塊')[0]);

    expect(screen.getByText(/說明: 當前市場或標的不支持籌碼數據，本次分析未使用該指標；請結合其他指標判斷/)).toBeInTheDocument();
    expect(screen.getByText(/診斷碼: chip_not_supported/)).toBeInTheDocument();
    expect(screen.queryByText(/^处理:/)).not.toBeInTheDocument();
  });

  it('surfaces degraded non-zero states in the collapsed summary', () => {
    const degradedOverview: AnalysisContextPackOverview = {
      ...overview,
      blocks: [
        {
          key: 'quote',
          label: '行情',
          status: 'fallback',
          source: 'cached_quote',
          warnings: ['quote_fallback'],
          missingReasons: [],
        },
        {
          key: 'fundamental',
          label: '基本面',
          status: 'stale',
          source: 'fundamental_cache',
          warnings: ['stale_fundamental'],
          missingReasons: [],
        },
        {
          key: 'technical',
          label: '技術',
          status: 'partial',
          source: 'technical_pipeline',
          warnings: ['technical_partial'],
          missingReasons: [],
        },
        {
          key: 'chip',
          label: '籌碼',
          status: 'estimated',
          source: 'estimated_chip',
          warnings: [],
          missingReasons: [],
        },
        {
          key: 'daily_bars',
          label: '日線',
          status: 'not_supported',
          source: null,
          warnings: [],
          missingReasons: [],
        },
      ],
      counts: {
        available: 0,
        missing: 0,
        notSupported: 1,
        fallback: 1,
        stale: 1,
        estimated: 1,
        partial: 1,
        fetchFailed: 0,
      },
    };

    render(<AnalysisContextSummary overview={degradedOverview} />);

    const panel = screen.getByTestId('analysis-context-summary');
    expect(panel).not.toHaveAttribute('open');
    expect(within(panel).getByText('可用 0')).toBeVisible();
    expect(within(panel).getByText('缺失 0')).toBeVisible();
    expect(within(panel).getAllByText('降級 1')[0]).toBeVisible();
    expect(within(panel).getAllByText('過期 1')[0]).toBeVisible();
    expect(within(panel).getAllByText('估算 1')[0]).toBeVisible();
    expect(within(panel).getAllByText('部分可用 1')[0]).toBeVisible();
    expect(within(panel).getAllByText('不支持 1')[0]).toBeVisible();

    fireEvent.click(within(panel).getAllByText('輸入數據塊')[0]);

    const quoteBlock = screen.getByText('行情').closest('.home-subpanel');
    expect(quoteBlock).not.toBeNull();
    expect(within(quoteBlock as HTMLElement).getByText('說明: 本次分析使用了備用數據路徑；請結合來源和告警複覈結果')).toBeInTheDocument();
    expect(within(quoteBlock as HTMLElement).queryByText(/^处理:/)).not.toBeInTheDocument();

    expect(screen.getByText('說明: 本次分析使用的不是最新數據；請檢查更新時間並按需重新分析')).toBeInTheDocument();
    expect(screen.getByText('說明: 僅部分數據進入本次分析，相關結論可能不完整；請檢查告警和數據源後重新分析')).toBeInTheDocument();
    expect(screen.getByText('說明: 本次分析使用了估算數據；請結合原始數據複覈結果')).toBeInTheDocument();
    expect(screen.getByText('說明: 當前市場或標的不支持該數據，本次分析未使用該數據；請結合其他指標判斷')).toBeInTheDocument();
  });

  it('does not render without an overview', () => {
    const { container } = render(<AnalysisContextSummary overview={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('does not render raw values or unexpected sensitive fields', () => {
    const unsafeOverview = {
      ...overview,
      value: 'raw trend payload',
      content: '完整新聞正文不應出現',
      apiKey: 'secret-key',
      blocks: [
        {
          ...overview.blocks[0],
          items: {
            price: {
              value: 1880,
              apiKey: 'secret-key',
            },
          },
        },
      ],
    } as unknown as AnalysisContextPackOverview;

    render(<AnalysisContextSummary overview={unsafeOverview} />);

    fireEvent.click(screen.getAllByText('輸入數據塊')[0]);

    expect(screen.queryByText('raw trend payload')).not.toBeInTheDocument();
    expect(screen.queryByText('完整新聞正文不應出現')).not.toBeInTheDocument();
    expect(screen.queryByText('secret-key')).not.toBeInTheDocument();
  });
});

describe('ReportSummary analysis context placement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders strategy and news before context, diagnostics and traceability', async () => {
    vi.mocked(historyApi.getNews).mockResolvedValue({
      total: 0,
      items: [],
    });

    const report: AnalysisReport = {
      meta: {
        id: 1,
        queryId: 'q1',
        stockCode: '600519',
        stockName: '貴州茅臺',
        reportType: 'detailed',
        reportLanguage: 'zh',
        createdAt: '2026-04-10T12:00:00',
        marketPhaseSummary: {
          market: 'cn',
          phase: 'intraday',
          marketLocalTime: '2026-04-10T10:30:00+08:00',
          sessionDate: '2026-04-10',
          effectiveDailyBarDate: '2026-04-09',
          isTradingDay: true,
          isMarketOpenNow: true,
          isPartialBar: true,
          minutesToOpen: null,
          minutesToClose: 150,
          triggerSource: 'api',
          analysisIntent: 'auto',
          warnings: [],
        },
      },
      summary: {
        analysisSummary: 'summary',
        operationAdvice: '持有',
        trendPrediction: '震盪',
        sentimentScore: 70,
      },
      strategy: {
        idealBuy: '120',
      },
      details: {
        analysisContextPackOverview: overview,
        marketStructure,
      },
    };
    const result: AnalysisResult = {
      queryId: 'q1',
      stockCode: '600519',
      stockName: '貴州茅臺',
      report,
      diagnosticSummary: {
        status: 'normal',
        statusLabel: '正常',
        reason: '運行正常',
        components: {},
        copyText: '',
      },
      createdAt: '2026-04-10T12:00:00',
    };

    render(<ReportSummary data={result} />);

    await waitFor(() => {
      expect(screen.getByText('暫無相關資訊')).toBeInTheDocument();
    });

    expect(screen.getByText('市場階段: CN · 盤中')).toBeInTheDocument();
    expect(screen.getByText('日線未完成')).toBeInTheDocument();
    expect(screen.getAllByText('質量分 82/100 可用')[0]).toBeInTheDocument();

    const strategy = screen.getByText('狙擊點位');
    const news = screen.getByText('相關資訊/後續檢索');
    const diagnostics = screen.getByTestId('run-diagnostics');
    const contextSummary = screen.getByTestId('analysis-context-summary');
    expect(contextSummary).not.toHaveAttribute('open');
    expect(diagnostics).not.toHaveAttribute('open');
    const traceability = screen.getByText('數據追溯');

    expect(strategy.compareDocumentPosition(news) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(news.compareDocumentPosition(contextSummary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(contextSummary.compareDocumentPosition(diagnostics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(diagnostics.compareDocumentPosition(traceability) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(contextSummary).getAllByText('輸入數據塊')[0]);
    expect(within(contextSummary).getByText(/說明: 新聞未進入本次 LLM 分析，結論未使用新聞上下文/)).toBeInTheDocument();
    expect(within(contextSummary).getByText(/報告頁相關資訊由獨立接口補充，顯示與否不代表已進入本次分析/)).toBeInTheDocument();
    expect(screen.queryByText('AI 建議 / 決策信號')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '題材主線與個股位置' })).not.toBeInTheDocument();
    expect(screen.queryByText('Robotics')).not.toBeInTheDocument();
  });
});

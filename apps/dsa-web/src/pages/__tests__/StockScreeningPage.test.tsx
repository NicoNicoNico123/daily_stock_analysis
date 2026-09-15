import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreeningHotspotDetail } from '../../api/screening';
import StockScreeningPage from '../StockScreeningPage';

const {
  enableScreening,
  getHistory,
  getRun,
  getScreeningStatus,
  getHotspotDetail,
  getHotspots,
  getStrategies,
  getScreenTask,
  navigate,
  resetLastScreenResult,
  screenStocks,
  startScreenTask,
} = vi.hoisted(() => {
  let lastScreenResult: unknown = null;
  const screenStocks = vi.fn();
  const startScreenTask = vi.fn(async (payload: unknown) => {
    lastScreenResult = await screenStocks(payload);
    return {
      taskId: 'screen-task-1',
      traceId: 'screen-task-1',
      status: 'pending',
      message: 'Screening 選股任務已提交',
      strategy: 'dual_low',
      market: 'cn',
      maxResults: 3,
    };
  });
  const getScreenTask = vi.fn(async (taskId: string) => {
    void taskId;
    return {
      taskId: 'screen-task-1',
      traceId: 'screen-task-1',
      status: 'completed',
      progress: 100,
      message: '任務運行完成',
      result: lastScreenResult,
    };
  });
  return {
    enableScreening: vi.fn(),
    getHistory: vi.fn(),
    getRun: vi.fn(),
    getScreeningStatus: vi.fn(),
    getHotspotDetail: vi.fn(),
    getHotspots: vi.fn(),
    getStrategies: vi.fn(),
    getScreenTask,
    navigate: vi.fn(),
    resetLastScreenResult: () => {
      lastScreenResult = null;
    },
    screenStocks,
    startScreenTask,
  };
});

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigate,
  };
});

vi.mock('../../api/screening', () => ({
  screeningApi: {
    enable: () => enableScreening(),
    getStatus: () => getScreeningStatus(),
    getHotspotDetail: (payload: unknown) => getHotspotDetail(payload),
    getHotspots: (payload: unknown) => getHotspots(payload),
    getHistory: (payload: unknown) => getHistory(payload),
    getRun: (runId: string) => getRun(runId),
    getStrategies: () => getStrategies(),
    getScreenTask: (taskId: string) => getScreenTask(taskId),
    screen: (payload: unknown) => screenStocks(payload),
    startScreen: (payload: unknown) => startScreenTask(payload),
  },
}));

const mockStrategiesResponse = {
  enabled: true,
  strategies: [
    {
      id: 'dual_low',
      name: 'Dual Low',
      title: 'Dual Low',
      description: 'Low valuation strategy',
      category: 'value',
      tag: 'value',
      tags: ['value'],
      marketScope: ['cn'],
    },
  ],
  strategyCount: 1,
};

function createDeferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('StockScreeningPage', () => {
  beforeEach(() => {
    enableScreening.mockReset();
    getHistory.mockReset();
    getRun.mockReset();
    getScreeningStatus.mockReset();
    getHotspotDetail.mockReset();
    getHotspots.mockReset();
    getStrategies.mockReset();
    getScreenTask.mockClear();
    navigate.mockReset();
    resetLastScreenResult();
    screenStocks.mockReset();
    startScreenTask.mockClear();
    getStrategies.mockResolvedValue(mockStrategiesResponse);
    getHotspotDetail.mockResolvedValue({
      enabled: true,
      provider: 'akshare',
      topic: 'AI算力',
      name: 'AI算力',
      canonicalTopic: '算力',
      summary: 'AI算力 盤中發酵。',
      qualityStatus: 'stale',
      missingFields: ['live_stocks'],
      fallbackUsed: true,
      stale: true,
      staleAgeHours: 2.5,
      sourceErrors: ['akshare timeout'],
      route: [{ title: '盤中發酵', description: '出現大筆買入。', source: 'eastmoney_board_change' }],
      stocks: [{
        code: '300000',
        name: '中際旭創',
        role: '核心龍頭',
        hotStockScore: 88,
        source: 'last_good_cache.leader_stocks',
        sourceConfidence: 0.65,
        fallbackUsed: true,
      }],
      stockCount: 1,
    });
    getHotspots.mockResolvedValue({ enabled: true, provider: 'akshare', hotspots: [], hotspotCount: 0 });
    getHistory.mockResolvedValue({ runs: [] });
    getRun.mockRejectedValue(Object.assign(new Error('run not found'), {
      parsedError: {
        title: '選股任務不可恢復',
        message: '服務端沒有找到這次選股任務，可能後端已重啓或任務記錄已清理，請重新運行選股。',
        rawMessage: 'screening_screen_task_not_found',
        category: 'http_error',
      },
    }));
    window.sessionStorage.clear();
  });

  it('keeps implementation attribution and repeated guidance off the operation page', async () => {
    getScreeningStatus.mockResolvedValueOnce({ enabled: true, available: true });

    render(<StockScreeningPage />);

    expect(await screen.findByText('選股已打開')).toBeInTheDocument();
    expect(screen.queryByText(/AlphaSift/)).not.toBeInTheDocument();
    expect(screen.queryByText(/theme_heat/)).not.toBeInTheDocument();
    expect(screen.queryByText('實驗功能與風險提示')).not.toBeInTheDocument();
    expect(screen.queryByText('選股結果')).not.toBeInTheDocument();
  });

  it('re-syncs enabled state when Screening availability check fails after config is enabled', async () => {
    getScreeningStatus
      .mockResolvedValueOnce({
        enabled: false,
        available: false,
      })
      .mockResolvedValueOnce({
        enabled: true,
        available: false,
      });
    enableScreening.mockRejectedValueOnce(new Error('選股功能不可用，請檢查後端日誌'));

    render(<StockScreeningPage />);

    expect((await screen.findAllByText('選股未打開')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /運行選股/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '打開選股' }));

    await waitFor(() => expect(getScreeningStatus).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText('選股未打開').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /運行選股/ })).toBeDisabled();
    expect(screen.getByText('選股功能不可用')).toBeInTheDocument();
    expect(screen.getByText('選股功能不可用，請檢查後端日誌')).toBeInTheDocument();
  });

  it('loads Screening hotspot themes on demand', async () => {
    getScreeningStatus.mockResolvedValueOnce({
      enabled: true,
      available: true,
    });
    getHotspots
      .mockResolvedValueOnce({
        enabled: true,
        provider: 'akshare',
        providerUsed: 'akshare',
        hotspots: [],
        hotspotCount: 0,
        cacheUsed: true,
        cachedAt: '2026-06-07T08:00:00Z',
      })
      .mockResolvedValueOnce({
        enabled: true,
        provider: 'akshare',
        providerUsed: 'akshare',
        hotspots: [
          {
            topic: 'AI算力',
            name: 'AI算力',
            heatScore: 88,
            trendScore: 12,
            persistenceScore: 66,
            changePct: 4.2,
            stage: '加速主升',
            sampleStockCount: 8,
            leaders: ['中際旭創', '工業富聯'],
          },
        ],
        hotspotCount: 1,
      });

    render(<StockScreeningPage />);

    expect(await screen.findByText('選股已打開')).toBeInTheDocument();
    await waitFor(() => expect(getHotspots).toHaveBeenCalledWith({ provider: 'akshare', top: 12, refresh: false }));
    expect(getHotspotDetail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /展開熱點題材/ }));
    fireEvent.click(screen.getByRole('button', { name: /刷新熱點題材/ }));

    await waitFor(() => expect(getHotspots).toHaveBeenCalledWith({ provider: 'akshare', top: 12, refresh: true }));
    fireEvent.click(await screen.findByRole('button', { name: /AI算力/ }));
    await waitFor(() => expect(getHotspotDetail).toHaveBeenCalledWith({ topic: 'AI算力', provider: 'akshare', refresh: false }));
    await waitFor(() => expect(screen.getAllByText('AI算力').length).toBeGreaterThan(0));
    expect(screen.getByText('強勢領先')).toBeInTheDocument();
    expect(screen.getAllByText(/中際旭創、工業富聯/).length).toBeGreaterThan(0);
    expect(screen.getByText(/覆蓋 8 股/)).toBeInTheDocument();
    expect(await screen.findByText('發酵時間線')).toBeInTheDocument();
    expect(screen.getByText('標準題材：算力')).toBeInTheDocument();
    expect(screen.getByText('質量 緩存')).toBeInTheDocument();
    expect(screen.getByText('緩存回退 2.5h')).toBeInTheDocument();
    expect(screen.getByText('詳情數據已降級，展開查看原因')).toBeInTheDocument();
    expect(screen.getByText(/暫缺：實時概念股行情/)).toBeInTheDocument();
    expect(screen.getByText('熱點明細請求超時')).toBeInTheDocument();
    expect(screen.getByText('盤中發酵')).toBeInTheDocument();
    expect(screen.getByText('概念股')).toBeInTheDocument();
    expect(screen.getByText('中際旭創')).toBeInTheDocument();
    expect(screen.queryByText(/last_good_cache|置信 65%/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '分析 中際旭創' }));
    expect(navigate).toHaveBeenCalledWith('/', {
      state: {
        stockCode: '300000',
        stockName: '中際旭創',
        autoAnalyze: true,
        selectionSource: 'screening_hotspot',
        skills: ['hot_theme'],
      },
    });
  });

  it('searches recent hotspot news only when requested and links the result', async () => {
    getScreeningStatus.mockResolvedValueOnce({ enabled: true, available: true });
    getHotspots.mockResolvedValueOnce({
      enabled: true,
      provider: 'akshare',
      hotspots: [{ topic: 'AI算力', name: 'AI算力', heatScore: 88 }],
      hotspotCount: 1,
    });
    getHotspotDetail
      .mockResolvedValueOnce({
        enabled: true,
        provider: 'akshare',
        topic: 'AI算力',
        route: [{ title: '盤中發酵', description: '概念股活躍。' }],
        stocks: [],
        stockCount: 0,
      })
      .mockResolvedValueOnce({
        enabled: true,
        provider: 'akshare',
        topic: 'AI算力',
        newsSearchRequested: true,
        newsSearchStatus: 'available',
        route: [{
          title: '算力產業鏈出現新催化',
          description: '近期訂單與政策預期升溫。',
          url: 'https://example.com/ai-news',
          searchResult: true,
        }],
        stocks: [],
        stockCount: 0,
      });

    render(<StockScreeningPage />);

    await screen.findByText('選股已打開');
    fireEvent.click(screen.getByRole('button', { name: /展開熱點題材/ }));
    fireEvent.click(await screen.findByRole('button', { name: /AI算力/ }));
    await waitFor(() => expect(getHotspotDetail).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole('button', { name: '搜索最新消息' }));

    await waitFor(() => expect(getHotspotDetail).toHaveBeenLastCalledWith({
      topic: 'AI算力',
      provider: 'akshare',
      refresh: false,
      includeSearch: true,
    }));
    const link = await screen.findByRole('link', { name: '查看消息' });
    expect(link).toHaveAttribute('href', 'https://example.com/ai-news');

    getHotspotDetail.mockResolvedValueOnce({
      enabled: true,
      provider: 'akshare',
      topic: 'AI算力',
      newsSearchRequested: true,
      newsSearchStatus: 'unavailable',
      route: [{ title: '盤中發酵', description: '概念股活躍。' }],
      stocks: [],
      stockCount: 0,
    });
    fireEvent.click(screen.getByRole('button', { name: '搜索最新消息' }));

    expect(await screen.findByText('消息搜索失敗，請稍後重試。')).toBeInTheDocument();
    expect(screen.getByText('盤中發酵')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '查看消息' })).not.toBeInTheDocument();

    getHotspotDetail.mockResolvedValueOnce({
      enabled: true,
      provider: 'akshare',
      topic: 'AI算力',
      newsSearchRequested: true,
      newsSearchStatus: 'no_results',
      route: [{ title: '盤中發酵', description: '概念股活躍。' }],
      stocks: [],
      stockCount: 0,
    });
    fireEvent.click(screen.getByRole('button', { name: '搜索最新消息' }));

    expect(await screen.findByText('暫未搜到該題材近期的有效消息。')).toBeInTheDocument();
    expect(screen.queryByText('消息搜索失敗，請稍後重試。')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /收起熱點題材/ }));
    fireEvent.click(screen.getByRole('button', { name: /展開熱點題材/ }));
    fireEvent.click(await screen.findByRole('button', { name: /AI算力/ }));

    await waitFor(() => expect(screen.queryByRole('link', { name: '查看消息' })).not.toBeInTheDocument());
    expect(screen.getByText('盤中發酵')).toBeInTheDocument();
    expect(getHotspotDetail).toHaveBeenCalledTimes(4);
  });

  it('renders hotspot details as user-facing Chinese without provider internals', async () => {
    getScreeningStatus.mockResolvedValueOnce({ enabled: true, available: true });
    getHotspots.mockResolvedValueOnce({
      enabled: true,
      provider: 'akshare',
      providerUsed: 'DsaEastMoneyHotspotProvider',
      hotspots: [{
        topic: '文本媒體',
        name: '文本媒體',
        heatScore: 100,
        stage: '初次異動',
        leaders: ['中文在線'],
      }],
      hotspotCount: 1,
    });
    getHotspotDetail.mockResolvedValueOnce({
      enabled: true,
      provider: 'akshare',
      topic: '文本媒體',
      name: '文本媒體',
      summary: '文本媒體 當前熱點詳情，熱度 100.0，階段 初次異動，核心股 中文在線，質量狀態 available。',
      qualityStatus: 'available',
      fallbackUsed: true,
      cacheUsed: false,
      stale: false,
      sourceErrors: [
        'DsaEastMoneyHotspotProvider.stock_board_concept_cons_em: hotspot source DsaEastMoneyHotspotProvider.stock_board_concept_cons_em timed out after 20s',
      ],
      route: [{
        date: '2026-08-01',
        title: 'Current fermentation',
        description: '文本媒體 heat 100.0; stage 初次異動; leaders 中文在線',
        source: 'DsaEastMoneyHotspotProvider',
      }],
      stocks: [{
        code: '300364',
        name: '中文在線',
        role: 'laggard',
        hotStockScore: 35,
        source: 'DsaEastMoneyHotspotProvider.concept_constituents',
        sourceConfidence: 1,
      }],
      stockCount: 1,
    });

    render(<StockScreeningPage />);

    expect(await screen.findByRole('heading', { name: '選股' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /展開熱點題材/ }));
    fireEvent.click(await screen.findByRole('button', { name: /文本媒體/ }));

    expect(await screen.findByText('文本媒體：熱度 100.0，階段 初次異動，核心股 中文在線。')).toBeInTheDocument();
    expect(screen.getByText('質量 可用')).toBeInTheDocument();
    expect(screen.getByText('備用數據源')).toBeInTheDocument();
    expect(screen.queryByText(/^緩存回退/)).not.toBeInTheDocument();
    expect(screen.getByText('當前發酵')).toBeInTheDocument();
    expect(screen.getByText('文本媒體熱度 100.0，階段 初次異動，核心股 中文在線。')).toBeInTheDocument();
    expect(screen.queryByText('詳情數據已降級，展開查看原因')).not.toBeInTheDocument();
    expect(screen.queryByText('熱點明細請求超時（20 秒）')).not.toBeInTheDocument();
    expect(screen.getByText('掉隊')).toBeInTheDocument();
    expect(screen.getByText(/暫無行情/)).toBeInTheDocument();
    expect(screen.queryByText(/Current fermentation|quality status|available|DsaEastMoneyHotspotProvider|concept_constituents/)).not.toBeInTheDocument();
  });

  it('shows cached hotspot preview while full details are still loading', async () => {
    const detailRequest = createDeferred<ScreeningHotspotDetail>();
    getScreeningStatus.mockResolvedValueOnce({ enabled: true, available: true });
    getHotspots.mockResolvedValueOnce({
      enabled: true,
      provider: 'akshare',
      hotspots: [{
        topic: '機器人',
        name: '機器人',
        heatScore: 92,
        stage: '加速主升',
        leaders: ['拓斯達'],
        leaderStocks: [{ code: '300607', name: '拓斯達', role: '核心龍頭', hotStockScore: 86 }],
        sampleStockCount: 1,
        qualityStatus: 'available',
      }],
      hotspotCount: 1,
    });
    getHotspotDetail.mockReturnValueOnce(detailRequest.promise);

    render(<StockScreeningPage />);

    await waitFor(() => expect(getHotspots).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /展開熱點題材/ }));
    fireEvent.click(await screen.findByRole('button', { name: /機器人/ }));

    expect(await screen.findByText('機器人：熱度 92.0，階段 加速主升，核心股 拓斯達。')).toBeInTheDocument();
    expect(screen.getByText('正在補充詳情')).toBeInTheDocument();
    expect(screen.getAllByText('拓斯達').length).toBeGreaterThan(0);

    act(() => {
      detailRequest.resolve({
        enabled: true,
        provider: 'akshare',
        topic: '機器人',
        name: '機器人',
        summary: '機器人詳情已更新。',
        route: [{ title: '盤中發酵', description: '概念股活躍度提升。' }],
        stocks: [{ code: '300607', name: '拓斯達', role: '核心龍頭', hotStockScore: 86 }],
        stockCount: 1,
      });
    });
    await waitFor(() => expect(screen.queryByText('正在補充詳情')).not.toBeInTheDocument());
    expect(screen.getByText('盤中發酵')).toBeInTheDocument();
  });

  it('localizes backend hotspot no-cache hint on initial load', async () => {
    getScreeningStatus.mockResolvedValueOnce({
      enabled: true,
      available: true,
    });
    getHotspots.mockResolvedValueOnce({
      enabled: true,
      provider: 'akshare',
      providerUsed: 'akshare',
      hotspots: [],
      hotspotCount: 0,
      message: 'No cached Screening hotspot snapshot. Click refresh to fetch live hotspots.',
    });

    render(<StockScreeningPage />);

    await waitFor(() => expect(getHotspots).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('暫無熱點緩存')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /展開熱點題材/ }));
    expect(await screen.findByText('暫無熱點緩存')).toBeInTheDocument();
    expect(screen.queryByText(/No cached Screening hotspot snapshot/)).not.toBeInTheDocument();
  });

  it('shows backend hotspot empty message before raw source diagnostics', async () => {
    getScreeningStatus.mockResolvedValueOnce({
      enabled: true,
      available: true,
    });
    getHotspots.mockResolvedValueOnce({
      enabled: true,
      provider: 'akshare',
      providerUsed: 'DsaEastMoneyHotspotProvider',
      hotspots: [],
      hotspotCount: 0,
      sourceErrors: ['eastmoney_hotspot_unavailable', "RemoteDisconnected('Remote end closed connection without response')"],
      message: '熱點源連接中斷，暫無可用緩存。',
    });

    render(<StockScreeningPage />);

    await waitFor(() => expect(getHotspots).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /展開熱點題材/ }));
    expect(await screen.findByText('熱點源連接中斷，暫無可用緩存。')).toBeInTheDocument();
    expect(screen.queryByText(/RemoteDisconnected/)).not.toBeInTheDocument();
  });

  it('prefers merged hotspot route summaries over raw timeline items', async () => {
    getScreeningStatus.mockResolvedValueOnce({
      enabled: true,
      available: true,
    });
    getHotspots.mockResolvedValueOnce({
      enabled: true,
      provider: 'akshare',
      providerUsed: 'akshare',
      hotspots: [{ topic: 'AI算力', name: 'AI算力', heatScore: 88, stage: '加速主升' }],
      hotspotCount: 1,
    });
    getHotspotDetail.mockResolvedValueOnce({
      enabled: true,
      provider: 'akshare',
      topic: 'AI算力',
      name: 'AI算力',
      summary: 'AI算力 當前熱點詳情。',
      route: [{ title: 'route-summary', description: 'compact route summary', source: 'news_search' }],
      timeline: [{ title: 'raw-timeline', description: 'full raw timeline text should stay hidden', source: 'raw_news' }],
      stocks: [],
      stockCount: 0,
    });

    render(<StockScreeningPage />);

    await waitFor(() => expect(getHotspots).toHaveBeenCalledWith({ provider: 'akshare', top: 12, refresh: false }));
    fireEvent.click(screen.getByRole('button', { name: /展開熱點題材/ }));
    fireEvent.click(await screen.findByRole('button', { name: /AI算力/ }));

    expect(await screen.findByText('route-summary')).toBeInTheDocument();
    expect(screen.getByText('compact route summary')).toBeInTheDocument();
    expect(screen.queryByText('raw-timeline')).not.toBeInTheDocument();
    expect(screen.queryByText('full raw timeline text should stay hidden')).not.toBeInTheDocument();
  });

  it('uses prefetched hotspot details from the hotspot list response', async () => {
    getScreeningStatus.mockResolvedValueOnce({
      enabled: true,
      available: true,
    });
    getHotspots.mockResolvedValueOnce({
      enabled: true,
      provider: 'akshare',
      providerUsed: 'akshare',
      hotspots: [{ topic: 'Moly', name: 'Moly', heatScore: 96, stage: 'warming' }],
      hotspotCount: 1,
      details: {
        Moly: {
          enabled: true,
          provider: 'akshare',
          topic: 'Moly',
          name: 'Moly',
          summary: 'Moly event summary',
          route: [{ title: 'prefetched catalyst', description: 'substitution drove the theme', source: 'news_search' }],
          stocks: [{ code: '603799', name: 'Moly Leader', role: 'leader', hotStockScore: 90 }],
          stockCount: 1,
        },
      },
    });

    render(<StockScreeningPage />);

    await waitFor(() => expect(getHotspots).toHaveBeenCalledWith({ provider: 'akshare', top: 12, refresh: false }));
    fireEvent.click(screen.getByRole('button', { name: /展開熱點題材/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Moly/ }));

    expect(await screen.findByText('prefetched catalyst')).toBeInTheDocument();
    expect(screen.getByText('substitution drove the theme')).toBeInTheDocument();
    expect(screen.getByText('Moly Leader')).toBeInTheDocument();
    expect(getHotspotDetail).not.toHaveBeenCalled();
  });

  it('loads selected hotspot detail once when switching themes', async () => {
    getScreeningStatus.mockResolvedValueOnce({
      enabled: true,
      available: true,
    });
    getHotspots.mockResolvedValueOnce({
      enabled: true,
      provider: 'akshare',
      providerUsed: 'akshare',
      hotspots: [
        {
          topic: 'AI算力',
          name: 'AI算力',
          heatScore: 88,
          stage: '加速主升',
        },
        {
          topic: '機器人運行器',
          name: '機器人運行器',
          heatScore: 80,
          stage: '輪動擴散',
        },
      ],
      hotspotCount: 2,
    });

    render(<StockScreeningPage />);

    expect(await screen.findByText('選股已打開')).toBeInTheDocument();
    await waitFor(() => expect(getHotspots).toHaveBeenCalledWith({ provider: 'akshare', top: 12, refresh: false }));
    expect(getHotspotDetail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /展開熱點題材/ }));
    fireEvent.click(screen.getByRole('button', { name: /AI算力/ }));
    await waitFor(() => expect(getHotspotDetail).toHaveBeenCalledWith({ topic: 'AI算力', provider: 'akshare', refresh: false }));
    expect(getHotspotDetail).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /機器人運行器/ }));

    await waitFor(() =>
      expect(getHotspotDetail).toHaveBeenLastCalledWith({ topic: '機器人運行器', provider: 'akshare', refresh: false }),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(getHotspotDetail).toHaveBeenCalledTimes(2);
  });

  it('clears loaded hotspot detail while loading a different theme', async () => {
    getScreeningStatus.mockResolvedValueOnce({
      enabled: true,
      available: true,
    });
    getHotspots.mockResolvedValueOnce({
      enabled: true,
      provider: 'akshare',
      providerUsed: 'akshare',
      hotspots: [
        {
          topic: 'AI算力',
          name: 'AI算力',
          heatScore: 88,
          stage: '加速主升',
        },
        {
          topic: '機器人運行器',
          name: '機器人運行器',
          heatScore: 80,
          stage: '輪動擴散',
        },
      ],
      hotspotCount: 2,
    });

    const robotDetail = createDeferred<unknown>();
    getHotspotDetail
      .mockResolvedValueOnce({
        enabled: true,
        provider: 'akshare',
        topic: 'AI算力',
        name: 'AI算力',
        summary: 'AI算力 盤中發酵。',
        route: [{ title: '盤中發酵', description: '出現大筆買入。', source: 'eastmoney_board_change' }],
        stocks: [{ code: '300000', name: '中際旭創', role: '核心龍頭', hotStockScore: 88 }],
        stockCount: 1,
      })
      .mockImplementationOnce(({ topic }: { topic: string }) => {
        if (topic === '機器人運行器') {
          return robotDetail.promise;
        }
        return Promise.reject(new Error(`unexpected topic: ${topic}`));
      });

    render(<StockScreeningPage />);

    expect(await screen.findByText('選股已打開')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /展開熱點題材/ }));
    fireEvent.click(await screen.findByRole('button', { name: /AI算力/ }));
    expect(await screen.findByText('盤中發酵')).toBeInTheDocument();
    expect(screen.getByText('中際旭創')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /機器人運行器/ }));

    await waitFor(() =>
      expect(getHotspotDetail).toHaveBeenLastCalledWith({ topic: '機器人運行器', provider: 'akshare', refresh: false }),
    );
    expect(screen.getAllByText('機器人運行器').length).toBeGreaterThan(0);
    expect(screen.getByText('正在補充詳情')).toBeInTheDocument();
    expect(screen.getByText('當前發酵')).toBeInTheDocument();
    expect(screen.queryByText('盤中發酵')).not.toBeInTheDocument();
    expect(screen.queryByText('中際旭創')).not.toBeInTheDocument();

    await act(async () => {
      robotDetail.resolve({
        enabled: true,
        provider: 'akshare',
        topic: '機器人運行器',
        name: '機器人運行器',
        summary: '機器人運行器 繼續發酵。',
        route: [{ title: '機器人發酵', description: '運行器鏈條擴散。', source: 'eastmoney_board_change' }],
        stocks: [{ code: '300111', name: '機器人龍頭', role: '核心龍頭', hotStockScore: 86 }],
        stockCount: 1,
      });
    });

    expect(await screen.findByText('機器人發酵')).toBeInTheDocument();
    expect(screen.getByText('機器人龍頭')).toBeInTheDocument();
  });

  it('ignores stale hotspot detail responses when switching themes', async () => {
    getScreeningStatus.mockResolvedValueOnce({
      enabled: true,
      available: true,
    });
    getHotspots.mockResolvedValueOnce({
      enabled: true,
      provider: 'akshare',
      providerUsed: 'akshare',
      hotspots: [
        {
          topic: 'AI算力',
          name: 'AI算力',
          heatScore: 88,
          stage: '加速主升',
        },
        {
          topic: '機器人運行器',
          name: '機器人運行器',
          heatScore: 80,
          stage: '輪動擴散',
        },
      ],
      hotspotCount: 2,
    });

    const aiDetail = createDeferred<unknown>();
    const robotDetail = createDeferred<unknown>();
    getHotspotDetail.mockImplementation(({ topic }: { topic: string }) => {
      if (topic === 'AI算力') {
        return aiDetail.promise;
      }
      if (topic === '機器人運行器') {
        return robotDetail.promise;
      }
      return Promise.reject(new Error(`unexpected topic: ${topic}`));
    });

    render(<StockScreeningPage />);

    expect(await screen.findByText('選股已打開')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /展開熱點題材/ }));
    fireEvent.click(await screen.findByRole('button', { name: /AI算力/ }));
    await waitFor(() => expect(getHotspotDetail).toHaveBeenCalledWith({ topic: 'AI算力', provider: 'akshare', refresh: false }));

    fireEvent.click(screen.getByRole('button', { name: /機器人運行器/ }));

    await waitFor(() =>
      expect(getHotspotDetail).toHaveBeenLastCalledWith({ topic: '機器人運行器', provider: 'akshare', refresh: false }),
    );
    await act(async () => {
      robotDetail.resolve({
        enabled: true,
        provider: 'akshare',
        topic: '機器人運行器',
        name: '機器人運行器',
        summary: '機器人運行器 繼續發酵。',
        route: [{ title: '機器人發酵', description: '運行器鏈條擴散。', source: 'eastmoney_board_change' }],
        stocks: [{ code: '300111', name: '機器人龍頭', role: '核心龍頭', hotStockScore: 86 }],
        stockCount: 1,
      });
    });

    expect(await screen.findByText('機器人發酵')).toBeInTheDocument();

    await act(async () => {
      aiDetail.resolve({
        enabled: true,
        provider: 'akshare',
        topic: 'AI算力',
        name: 'AI算力',
        summary: 'AI算力 舊響應。',
        route: [{ title: 'AI舊發酵', description: '舊請求晚到。', source: 'eastmoney_board_change' }],
        stocks: [{ code: '300000', name: '中際旭創', role: '核心龍頭', hotStockScore: 88 }],
        stockCount: 1,
      });
    });

    expect(screen.getByText('機器人發酵')).toBeInTheDocument();
    expect(screen.getByText('機器人龍頭')).toBeInTheDocument();
    expect(screen.queryByText('AI舊發酵')).not.toBeInTheDocument();
    expect(screen.queryByText('中際旭創')).not.toBeInTheDocument();
  });

  it('refreshes selected hotspot detail when refreshing the list retains the same topic', async () => {
    getScreeningStatus.mockResolvedValueOnce({
      enabled: true,
      available: true,
    });
    getHotspots
      .mockResolvedValueOnce({
        enabled: true,
        provider: 'akshare',
        providerUsed: 'akshare',
        hotspots: [
          {
            topic: 'AI算力',
            name: 'AI算力',
            heatScore: 88,
            stage: '加速主升',
          },
          {
            topic: '機器人運行器',
            name: '機器人運行器',
            heatScore: 80,
            stage: '輪動擴散',
          },
        ],
        hotspotCount: 2,
      })
      .mockResolvedValueOnce({
        enabled: true,
        provider: 'akshare',
        providerUsed: 'akshare',
        hotspots: [
          {
            topic: 'AI算力',
            name: 'AI算力',
            heatScore: 91,
            stage: '高位發酵',
          },
        ],
        hotspotCount: 1,
      });
    getHotspotDetail
      .mockResolvedValueOnce({
        enabled: true,
        provider: 'akshare',
        topic: 'AI算力',
        name: 'AI算力',
        summary: 'AI算力 盤中發酵。',
        route: [{ title: '盤中發酵', description: '出現大筆買入。', source: 'eastmoney_board_change' }],
        stocks: [{ code: '300000', name: '中際旭創', role: '核心龍頭', hotStockScore: 88 }],
        stockCount: 1,
      })
      .mockResolvedValueOnce({
        enabled: true,
        provider: 'akshare',
        topic: 'AI算力',
        name: 'AI算力',
        summary: 'AI算力 刷新後發酵。',
        route: [{ title: '刷新後發酵', description: '榜單與詳情來自同次刷新。', source: 'eastmoney_board_change' }],
        stocks: [{ code: '601138', name: '工業富聯', role: '核心龍頭', hotStockScore: 92 }],
        stockCount: 1,
      });

    render(<StockScreeningPage />);

    expect(await screen.findByText('選股已打開')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /展開熱點題材/ }));
    fireEvent.click(await screen.findByRole('button', { name: /AI算力/ }));
    await waitFor(() => expect(getHotspotDetail).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /刷新熱點題材/ }));

    await waitFor(() => expect(getHotspots).toHaveBeenCalledWith({ provider: 'akshare', top: 12, refresh: true }));
    await waitFor(() => expect(getHotspotDetail).toHaveBeenLastCalledWith({
      topic: 'AI算力',
      provider: 'akshare',
      refresh: true,
    }));
    expect(await screen.findByText('刷新後發酵')).toBeInTheDocument();
    expect(screen.getByText('工業富聯')).toBeInTheDocument();
    expect(screen.queryByText('盤中發酵')).not.toBeInTheDocument();
    expect(screen.queryByText('中際旭創')).not.toBeInTheDocument();
  });

  it('keeps existing hotspot cards when manual refresh fails', async () => {
    getScreeningStatus.mockResolvedValueOnce({
      enabled: true,
      available: true,
    });
    getHotspots
      .mockResolvedValueOnce({
        enabled: true,
        provider: 'akshare',
        providerUsed: 'akshare',
        hotspots: [
          {
            topic: 'AI算力',
            name: 'AI算力',
            heatScore: 88,
            trendScore: 12,
            persistenceScore: 66,
            changePct: 4.2,
            stage: '加速主升',
            sampleStockCount: 8,
            leaders: ['中際旭創', '工業富聯'],
          },
        ],
        hotspotCount: 1,
      })
      .mockRejectedValueOnce(new Error('manual refresh failed'));

    render(<StockScreeningPage />);

    expect(await screen.findByText('選股已打開')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /展開熱點題材/ }));
    expect(await screen.findByText('強勢領先')).toBeInTheDocument();
    expect(screen.getByText(/中際旭創、工業富聯/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /刷新熱點題材/ }));

    await waitFor(() => expect(getHotspots).toHaveBeenCalledWith({ provider: 'akshare', top: 12, refresh: true }));
    expect(await screen.findByText(/manual refresh failed/)).toBeInTheDocument();
    expect(screen.getByText('強勢領先')).toBeInTheDocument();
    expect(screen.getByText(/中際旭創、工業富聯/)).toBeInTheDocument();
    expect(screen.queryByText(/点击刷新后会拉取热点概念/)).not.toBeInTheDocument();
  });

  it('shows input strategy when strategy is not in preset list', async () => {
    getScreeningStatus.mockResolvedValueOnce({
      enabled: true,
      available: true,
    });
    screenStocks.mockResolvedValue({
      enabled: true,
      candidates: [],
      candidateCount: 0,
    });

    render(<StockScreeningPage />);

    expect(await screen.findByText('選股已打開')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('策略'), {
      target: { value: '__custom_strategy__' },
    });
    fireEvent.change(screen.getByLabelText('自定義策略 ID'), {
      target: { value: 'custom_strategy_alpha' },
    });

    expect(screen.getByDisplayValue('custom_strategy_alpha')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /運行選股/ }));
    await waitFor(() => expect(screenStocks).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/自定義策略 \(custom_strategy_alpha\)/)).toBeInTheDocument());
  });

  it('uses supported Screening strategy ids and cn market', async () => {
    getStrategies.mockResolvedValueOnce({
      enabled: true,
      strategies: [
        { id: 'balanced_alpha', name: '平衡選股', description: 'desc', category: '框架' },
        { id: 'capital_heat', name: '資金熱度', description: 'desc', category: '動量' },
        { id: 'dual_low', name: '雙低', description: 'desc', category: '價值' },
        { id: 'oversold_reversal', name: '超跌', description: 'desc', category: '反轉' },
        { id: 'shrink_pullback', name: '縮量回踩', description: 'desc', category: '趨勢' },
      ],
      strategyCount: 5,
    });
    getScreeningStatus.mockResolvedValueOnce({
      enabled: true,
      available: true,
    });
    screenStocks.mockResolvedValue({
      enabled: true,
      candidates: [],
      candidateCount: 0,
    });

    render(<StockScreeningPage />);

    expect(await screen.findByText('選股已打開')).toBeInTheDocument();

    const marketSelect = screen.getByLabelText('市場') as HTMLSelectElement;
    expect(Array.from(marketSelect.options).map((option) => option.value)).toEqual(['cn']);

    const strategySelect = screen.getByLabelText('策略') as HTMLSelectElement;
    expect(Array.from(strategySelect.options).map((option) => option.textContent)).toEqual([
      '平衡選股',
      '資金熱度',
      '雙低',
      '超跌',
      '縮量回踩',
      '自定義策略…',
    ]);

    ['balanced_alpha', 'capital_heat', 'oversold_reversal', 'shrink_pullback'].forEach((id) => {
      fireEvent.change(strategySelect, { target: { value: id } });
      expect(strategySelect.value).toBe(id);
    });

    fireEvent.click(screen.getByRole('button', { name: /運行選股/ }));
    await waitFor(() => expect(screenStocks).toHaveBeenCalledTimes(1));
    expect(screenStocks).toHaveBeenCalledWith({
      market: 'cn',
      strategy: 'shrink_pullback',
      maxResults: 3,
    });
  });

  it('clears previous screening candidates when strategy changes', async () => {
    getStrategies.mockResolvedValueOnce({
      enabled: true,
      strategies: [
        { id: 'dual_low', name: '雙低選股', description: 'desc', category: '價值' },
        { id: 'capital_heat', name: '資金熱度', description: 'desc', category: '動量' },
      ],
      strategyCount: 2,
    });
    getScreeningStatus.mockResolvedValueOnce({
      enabled: true,
      available: true,
    });
    screenStocks.mockResolvedValueOnce({
      enabled: true,
      candidates: [
        {
          rank: 1,
          code: '000001',
          name: '舊策略股票',
          score: 88.5,
          reason: 'old result',
          raw: {},
        },
      ],
      candidateCount: 1,
    });

    render(<StockScreeningPage />);

    expect(await screen.findByText('選股已打開')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /運行選股/ }));

    expect(await screen.findByText('舊策略股票')).toBeInTheDocument();
    expect(screen.getByText('選股完成')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('策略'), { target: { value: 'capital_heat' } });

    expect(screen.queryByText('舊策略股票')).not.toBeInTheDocument();
    expect(screen.queryByText('選股完成')).not.toBeInTheDocument();
    expect(screen.getByLabelText('策略')).toHaveValue('capital_heat');
  });

  it('hands a screening candidate to DSA analysis with mapped skills', async () => {
    getStrategies.mockResolvedValueOnce({
      enabled: true,
      strategies: [
        {
          id: 'dual_low',
          name: '雙低選股',
          description: 'desc',
          category: '價值',
          analysisSkills: ['growth_quality'],
        },
      ],
      strategyCount: 1,
    });
    getScreeningStatus.mockResolvedValueOnce({
      enabled: true,
      available: true,
    });
    screenStocks.mockResolvedValueOnce({
      enabled: true,
      candidates: [
        {
          rank: 1,
          code: '600519',
          name: '貴州茅臺',
          score: 88.5,
          reason: '候選摘要',
          raw: {},
        },
      ],
      candidateCount: 1,
    });

    render(<StockScreeningPage />);

    expect(await screen.findByText('選股已打開')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /運行選股/ }));
    expect(await screen.findByText('貴州茅臺')).toBeInTheDocument();
    const expandButton = screen.queryByRole('button', { name: '展開查看' });
    if (expandButton) {
      fireEvent.click(expandButton);
    }
    fireEvent.click(screen.getByRole('button', { name: '進一步深度分析' }));

    expect(navigate).toHaveBeenCalledWith('/', {
      state: {
        stockCode: '600519',
        stockName: '貴州茅臺',
        autoAnalyze: true,
        selectionSource: 'screening_result',
        skills: ['growth_quality'],
      },
    });
  });

  it('restores an in-flight screening task after remounting the page', async () => {
    getScreeningStatus.mockResolvedValue({
      enabled: true,
      available: true,
    });
    screenStocks.mockResolvedValueOnce({
      enabled: true,
      candidates: [
        {
          rank: 1,
          code: '000001',
          name: '恢復後的候選',
          score: 88.5,
          reason: 'restored result',
          raw: {},
        },
      ],
      candidateCount: 1,
    });
    getScreenTask
      .mockResolvedValueOnce({
        taskId: 'screen-task-1',
        traceId: 'screen-task-1',
        status: 'processing',
        progress: 35,
        message: '正在運行 Screening 選股',
        result: null,
      })
      .mockResolvedValueOnce({
        taskId: 'screen-task-1',
        traceId: 'screen-task-1',
        status: 'completed',
        progress: 100,
        message: '任務運行完成',
        result: {
          enabled: true,
          candidates: [
            {
              rank: 1,
              code: '000001',
              name: '恢復後的候選',
              score: 88.5,
              reason: 'restored result',
              raw: {},
            },
          ],
          candidateCount: 1,
        },
      });

    const firstRender = render(<StockScreeningPage />);

    expect(await screen.findByText('選股已打開')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /運行選股/ }));

    expect(await screen.findByText('選股運行中')).toBeInTheDocument();
    expect(window.sessionStorage.getItem('dsa.screening.activeScreenTask.v1')).toContain('screen-task-1');

    firstRender.unmount();
    render(<StockScreeningPage />);

    expect(await screen.findByText('恢復後的候選')).toBeInTheDocument();
    expect(screen.getByText('選股完成')).toBeInTheDocument();
    // 方案A：任务完成后保留 runId（而非清空），刷新后可从 history API 恢复
    expect(window.sessionStorage.getItem('dsa.screening.activeScreenTask.v1')).toContain('screen-task-1');
  });

  it('keeps a restored screening task recoverable when status polling times out', async () => {
    getScreeningStatus.mockResolvedValue({
      enabled: true,
      available: true,
    });
    window.sessionStorage.setItem('dsa.screening.activeScreenTask.v1', JSON.stringify({
      taskId: 'screen-task-1',
      market: 'cn',
      strategy: 'dual_low',
      maxResults: 3,
    }));
    getScreenTask.mockRejectedValueOnce(Object.assign(new Error('timeout of 30000ms exceeded'), {
      code: 'ECONNABORTED',
    }));

    render(<StockScreeningPage />);

    await waitFor(() => expect(getScreenTask).toHaveBeenCalledTimes(1));
    expect(screen.getByText('選股運行中')).toBeInTheDocument();
    expect(screen.getByText('選股任務仍在後臺運行，狀態輪詢暫時超時，將自動重試。')).toBeInTheDocument();
    expect(screen.queryByText(/连接上游服务超时/)).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem('dsa.screening.activeScreenTask.v1')).toContain('screen-task-1');
  });

  it('clears the persisted recovery state when a restored task becomes unrecoverable', async () => {
    getScreeningStatus.mockResolvedValue({
      enabled: true,
      available: true,
    });
    window.sessionStorage.setItem('dsa.screening.activeScreenTask.v1', JSON.stringify({
      taskId: 'screen-task-1',
      market: 'cn',
      strategy: 'dual_low',
      maxResults: 3,
    }));
    getScreenTask.mockRejectedValueOnce(Object.assign(new Error('選股任務不可恢復'), {
      parsedError: {
        title: '選股任務不可恢復',
        message: '服務端沒有找到這次選股任務，可能後端已重啓或任務記錄已清理，請重新運行選股。',
        rawMessage: 'screening_screen_task_not_found',
        category: 'http_error',
      },
    }));

    render(<StockScreeningPage />);

    await waitFor(() => expect(getScreenTask).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/選股任務不可恢復/)).toBeInTheDocument();
    expect(screen.queryByText('選股運行中')).not.toBeInTheDocument();
    // 不可恢复分支必须清理持久化恢复状态，避免刷新后反复恢复同一条失效任务
    expect(window.sessionStorage.getItem('dsa.screening.activeScreenTask.v1')).toBeNull();
  });

  it('keeps the persisted recovery state and history visible after filters change', async () => {
    getScreeningStatus.mockResolvedValue({
      enabled: true,
      available: true,
    });
    screenStocks.mockResolvedValueOnce({
      enabled: true,
      candidates: [
        {
          rank: 1,
          code: '000001',
          name: '舊篩選條件下的候選',
          score: 88.5,
          reason: 'old filter result',
          raw: {},
        },
      ],
      candidateCount: 1,
      runId: 'run-1',
    });

    render(<StockScreeningPage />);

    expect(await screen.findByText('選股已打開')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /運行選股/ }));

    expect(await screen.findByText('舊篩選條件下的候選')).toBeInTheDocument();
    expect(window.sessionStorage.getItem('dsa.screening.activeScreenTask.v1')).toContain('run-1');

    // 修改筛选条件（返回数量 3 -> 5）：当前结果视图清空，但持久化恢复状态必须保留
    fireEvent.change(screen.getByRole('spinbutton', { name: /返回數量/ }), { target: { value: '5' } });
    expect(screen.queryByText('舊篩選條件下的候選')).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem('dsa.screening.activeScreenTask.v1')).toContain('run-1');

    // 歷史記錄区块仍然可见（筛选条件切换不影响历史可获取性）
    expect(screen.getByText('歷史記錄')).toBeInTheDocument();
  });

  it('shows the screening conditions on each history entry', async () => {
    getScreeningStatus.mockResolvedValue({
      enabled: true,
      available: true,
    });
    getHistory.mockResolvedValue({
      enabled: true,
      runs: [
        {
          runId: 'run-1',
          strategy: 'dual_low',
          market: 'cn',
          candidateCount: 3,
          snapshotCount: 50,
          llmRanked: true,
          createdAt: '2026-08-05T10:00:00Z',
        },
      ],
      runCount: 1,
    });

    render(<StockScreeningPage />);

    // 历史条目展示筛选条件：策略中文名 + 市場标签 + 返回数量（该次 run 实际候选数）
    expect(await screen.findByText(/返回 3 只/)).toBeInTheDocument();
    expect(screen.getAllByText('Dual Low').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('A 股').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/快照 50/)).toBeInTheDocument();
    expect(screen.getByText(/智能重排/)).toBeInTheDocument();
  });

  it('syncs strategy and market context when opening a history run', async () => {
    getScreeningStatus.mockResolvedValue({
      enabled: true,
      available: true,
    });
    getHistory.mockResolvedValue({
      enabled: true,
      runs: [
        {
          runId: 'run-1',
          strategy: 'capital_heat',
          market: 'cn',
          candidateCount: 3,
          snapshotCount: 50,
          llmRanked: true,
          createdAt: '2026-08-05T10:00:00Z',
        },
      ],
      runCount: 1,
    });
    getRun.mockResolvedValue({
      runId: 'run-1',
      strategy: 'capital_heat',
      market: 'cn',
      candidateCount: 3,
      enabled: true,
      result: {
        enabled: true,
        candidates: [
          {
            rank: 1,
            code: '00700',
            name: '騰訊控股',
            score: 88.5,
            reason: '熱度因子領先',
            amount: 1042000000,
            factorScores: { heat: 92 },
            raw: {},
          },
        ],
        candidateCount: 1,
        snapshotCount: 50,
        afterFilterCount: 10,
        llmRanked: true,
      },
    });

    render(<StockScreeningPage />);

    // 点击歷史記錄中的 run 条目（策略 capital_heat，与当前表单默认 dual_low 不同）
    fireEvent.click(await screen.findByText('capital_heat'));

    // 结果区上下文同步为该历史 run 的策略与市場
    expect(await screen.findByText(/自定義策略 \(capital_heat\) · A 股/)).toBeInTheDocument();
    expect(getRun).toHaveBeenCalledWith('run-1');
  });

  it('ignores stale history-detail responses when switching runs quickly', async () => {
    getScreeningStatus.mockResolvedValue({
      enabled: true,
      available: true,
    });
    getHistory.mockResolvedValue({
      enabled: true,
      runs: [
        {
          runId: 'run-a',
          strategy: 'capital_heat',
          market: 'cn',
          candidateCount: 1,
          createdAt: '2026-08-05T10:00:00Z',
        },
        {
          runId: 'run-b',
          strategy: 'dual_low',
          market: 'cn',
          candidateCount: 1,
          createdAt: '2026-08-06T10:00:00Z',
        },
      ],
      runCount: 2,
    });
    const runADetail = createDeferred<unknown>();
    const runBDetail = createDeferred<unknown>();
    getRun.mockImplementation((runId: string) => {
      if (runId === 'run-a') {
        return runADetail.promise;
      }
      if (runId === 'run-b') {
        return runBDetail.promise;
      }
      return Promise.reject(new Error(`unexpected runId: ${runId}`));
    });

    render(<StockScreeningPage />);

    // 先点 run-a（capital_heat，请求挂起），再点 run-b（dual_low）
    fireEvent.click(await screen.findByText('capital_heat'));
    fireEvent.click(screen.getByRole('button', { name: /Dual Low/ }));
    await waitFor(() => expect(getRun).toHaveBeenLastCalledWith('run-b'));

    // run-b 先返回：结果区展示 dual_low 上下文
    await act(async () => {
      runBDetail.resolve({
        runId: 'run-b',
        strategy: 'dual_low',
        market: 'cn',
        candidateCount: 1,
        enabled: true,
        result: {
          enabled: true,
          candidates: [
            {
              rank: 1,
              code: '000001',
              name: '平安銀行',
              score: 88.5,
              reason: '雙低策略',
              amount: 1042000000,
              factorScores: { value: 92 },
              raw: {},
            },
          ],
          candidateCount: 1,
          snapshotCount: 50,
          afterFilterCount: 10,
          llmRanked: true,
        },
      });
    });
    expect(await screen.findByText(/Dual Low · A 股/)).toBeInTheDocument();

    // run-a 迟到返回：不得覆盖 run-b 的结果与上下文
    await act(async () => {
      runADetail.resolve({
        runId: 'run-a',
        strategy: 'capital_heat',
        market: 'cn',
        candidateCount: 1,
        enabled: true,
        result: {
          enabled: true,
          candidates: [
            {
              rank: 1,
              code: '00700',
              name: '騰訊控股',
              score: 90,
              reason: '熱度因子領先',
              amount: 1042000000,
              factorScores: { heat: 92 },
              raw: {},
            },
          ],
          candidateCount: 1,
          snapshotCount: 50,
          afterFilterCount: 10,
          llmRanked: true,
        },
      });
    });
    expect(screen.getByText(/Dual Low · A 股/)).toBeInTheDocument();
    expect(screen.queryByText(/自定義策略 \(capital_heat\)/)).not.toBeInTheDocument();
    expect(screen.queryByText('騰訊控股')).not.toBeInTheDocument();
  });

  it('ignores late auto-restore responses after the user manually picks a history run', async () => {
    getScreeningStatus.mockResolvedValue({
      enabled: true,
      available: true,
    });
    // 持久化 run-a：挂载时会触发自动恢复的 getRun('run-a')
    window.sessionStorage.setItem('dsa.screening.activeScreenTask.v1', JSON.stringify({
      taskId: 'task-a',
      runId: 'run-a',
      strategy: 'capital_heat',
      market: 'cn',
      maxResults: 3,
    }));
    getHistory.mockResolvedValue({
      enabled: true,
      runs: [
        {
          runId: 'run-b',
          strategy: 'dual_low',
          market: 'cn',
          candidateCount: 1,
          createdAt: '2026-08-05T10:00:00Z',
        },
      ],
      runCount: 1,
    });

    const runA = createDeferred();
    getRun.mockImplementation((runId: string) => {
      if (runId === 'run-a') {
        return runA.promise;
      }
      return Promise.resolve({
        runId: 'run-b',
        strategy: 'dual_low',
        market: 'cn',
        candidateCount: 1,
        enabled: true,
        result: {
          enabled: true,
          candidates: [
            {
              rank: 1,
              code: '600000',
              name: '浦發銀行',
              score: 88,
              reason: '低估值',
              amount: 1042000000,
              factorScores: { value: 87 },
              raw: {},
            },
          ],
          candidateCount: 1,
          snapshotCount: 50,
          afterFilterCount: 10,
          llmRanked: true,
        },
      });
    });

    render(<StockScreeningPage />);

    // 自动恢复 run-a 还在挂起时，用户手动点开历史里的 run-b（策略 dual_low → 显示 Dual Low）
    fireEvent.click(await screen.findByText(/返回 1 只/));
    expect(await screen.findByText(/Dual Low · A 股/)).toBeInTheDocument();
    expect(screen.getByText('浦發銀行')).toBeInTheDocument();

    // run-a 较晚返回：不得覆盖用户手动选择的 run-b
    await act(async () => {
      runA.resolve({
        runId: 'run-a',
        strategy: 'capital_heat',
        market: 'cn',
        candidateCount: 1,
        enabled: true,
        result: {
          enabled: true,
          candidates: [
            {
              rank: 1,
              code: '00700',
              name: '騰訊控股',
              score: 90,
              reason: '熱度因子領先',
              amount: 1042000000,
              factorScores: { heat: 92 },
              raw: {},
            },
          ],
          candidateCount: 1,
          snapshotCount: 50,
          afterFilterCount: 10,
          llmRanked: true,
        },
      });
    });
    expect(screen.getByText(/Dual Low · A 股/)).toBeInTheDocument();
    expect(screen.getByText('浦發銀行')).toBeInTheDocument();
    expect(screen.queryByText(/自定義策略 \(capital_heat\)/)).not.toBeInTheDocument();
    expect(screen.queryByText('騰訊控股')).not.toBeInTheDocument();
  });

  it('cancels an in-flight screening task when a history run is selected', async () => {
    getScreeningStatus.mockResolvedValue({
      enabled: true,
      available: true,
    });
    getHistory.mockResolvedValue({
      enabled: true,
      runs: [
        {
          runId: 'run-hist',
          strategy: 'capital_heat',
          market: 'cn',
          candidateCount: 1,
          createdAt: '2026-08-05T10:00:00Z',
        },
      ],
      runCount: 1,
    });
    // 提交一个未完成的任务（pending）：进入后台轮询
    getScreenTask.mockResolvedValueOnce({
      taskId: 'screen-task-1',
      traceId: 'screen-task-1',
      status: 'running',
      progress: 40,
      message: 'Screening 正在分析...',
      result: null,
    });
    screenStocks.mockResolvedValueOnce({
      enabled: true,
      candidates: [
        {
          rank: 1,
          code: '600000',
          name: '任務候選',
          score: 80,
          reason: '任務原因',
          amount: 100,
          factorScores: { value: 80 },
          raw: {},
        },
      ],
      candidateCount: 1,
      snapshotCount: 50,
      afterFilterCount: 10,
      llmRanked: true,
    });
    getRun.mockResolvedValueOnce({
      runId: 'run-hist',
      strategy: 'capital_heat',
      market: 'cn',
      candidateCount: 1,
      enabled: true,
      result: {
        enabled: true,
        candidates: [
          {
            rank: 1,
            code: '00700',
            name: '歷史候選',
            score: 90,
            reason: '歷史原因',
            amount: 1042000000,
            factorScores: { heat: 92 },
            raw: {},
          },
        ],
        candidateCount: 1,
        snapshotCount: 50,
        afterFilterCount: 10,
        llmRanked: true,
      },
    });

    render(<StockScreeningPage />);

    // 等待選股开启后，提交選股任务进入轮询
    expect(await screen.findByText('選股已打開')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /運行選股/ }));
    await waitFor(() => expect(startScreenTask).toHaveBeenCalled());
    await waitFor(() => expect(getScreenTask).toHaveBeenCalled());

    // 任务仍在轮询时，点击歷史記錄 run（策略 capital_heat）
    fireEvent.click(await screen.findByText('capital_heat'));
    expect(await screen.findByText(/自定義策略 \(capital_heat\)/)).toBeInTheDocument();
    expect(screen.getByText('歷史候選')).toBeInTheDocument();

    // 后台任务随后完成，也不得把任务候选回写到历史上下文中
    expect(screen.queryByText('任務候選')).not.toBeInTheDocument();
    expect(screen.getByText(/自定義策略 \(capital_heat\)/)).toBeInTheDocument();
  });

  it('surfaces Screening LLM fallback instead of showing empty LLM fields as normal', async () => {
    getScreeningStatus.mockResolvedValueOnce({
      enabled: true,
      available: true,
    });
    screenStocks.mockResolvedValueOnce({
      enabled: true,
      candidates: [
        {
          rank: 1,
          code: '000001',
          name: '平安銀行',
          score: 88.5,
          reason: '本地後置評分: value_quality',
          amount: 1042000000,
          factorScores: {
            value: 87.44,
            liquidity: 93.33,
          },
          raw: {},
        },
      ],
      candidateCount: 1,
      snapshotCount: 5193,
      afterFilterCount: 20,
      llmRanked: false,
      rankingMode: 'factor',
      llmFailureReason: 'invalid_response',
      llmParseErrors: ['no_json_found'],
      warnings: ['LLM ranking failed, falling back to screen_score: Missing gemini_api_key'],
    });

    render(<StockScreeningPage />);

    expect(await screen.findByText('選股已打開')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /運行選股/ }));

    expect(await screen.findByText('當前使用因子排序')).toBeInTheDocument();
    expect(screen.getByText(/缺少可用 LLM API Key/)).toBeInTheDocument();
    expect(screen.queryByText(/Missing gemini_api_key/)).not.toBeInTheDocument();
    expect(screen.getByText(/排序：確定性因子/)).toBeInTheDocument();
    expect(screen.getByText('因子排序')).toBeInTheDocument();
    expect(screen.getByText(/主要優勢：流動性 93、估值 87/)).toBeInTheDocument();
    expect(screen.queryByText(/LLM 已降级/)).not.toBeInTheDocument();
  });

  it('deduplicates Screening snapshot fallback warnings and source errors', async () => {
    getScreeningStatus.mockResolvedValueOnce({
      enabled: true,
      available: true,
    });
    screenStocks.mockResolvedValueOnce({
      enabled: true,
      candidates: [
        {
          rank: 1,
          code: '601919',
          name: '中遠海控',
          score: 82.88,
          llmScore: 82,
          riskLevel: 'low',
          raw: {},
        },
      ],
      candidateCount: 1,
      llmRanked: true,
      warnings: ['Snapshot source fallback: tushare: tushare trade_cal returned no open trading days'],
      sourceErrors: ['tushare: tushare trade_cal returned no open trading days'],
    });

    render(<StockScreeningPage />);

    expect(await screen.findByText('選股已打開')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /運行選股/ }));

    expect(await screen.findByText('選股提示')).toBeInTheDocument();
    expect(screen.getAllByText('數據源降級：tushare（交易日曆暫無可用開市日）')).toHaveLength(1);
    expect(screen.queryByText(/trade_cal returned no open trading days/)).not.toBeInTheDocument();
  });

  it('sanitizes long Screening source diagnostics and keeps the alert constrained', async () => {
    getScreeningStatus.mockResolvedValueOnce({
      enabled: true,
      available: true,
    });
    screenStocks.mockResolvedValueOnce({
      enabled: true,
      candidates: [
        {
          rank: 1,
          code: '600016',
          name: '民生銀行',
          score: 80.12,
          raw: {},
        },
      ],
      candidateCount: 1,
      llmRanked: true,
      warnings: [
        "Snapshot source fallback: efinance: HTTPConnectionPool(host='push2.eastmoney.com', port=80): Max retries exceeded with url: /api/qt/clist/get?pn=1&pz=200&po=1&fields=f12%2Cf14%2Cf2%2Cf3 (Caused by ProtocolError('Connection aborted.', RemoteDisconnected('Remote end closed connection without response')))",
        "Snapshot source fallback: akshare_em: ('Connection aborted.', RemoteDisconnected('Remote end closed connection without response'))",
      ],
    });

    render(<StockScreeningPage />);

    expect(await screen.findByText('選股已打開')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /運行選股/ }));

    const efinanceWarning = await screen.findByText('數據源降級：efinance（網絡連接中斷）');
    const alert = efinanceWarning.closest('[role="alert"]');
    expect(alert).toHaveClass('max-w-full');
    expect(efinanceWarning).toBeInTheDocument();
    expect(screen.getByText('數據源降級：akshare_em（網絡連接中斷）')).toBeInTheDocument();
    expect(screen.queryByText(/HTTPConnectionPool/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\/api\/qt\/clist\/get/)).not.toBeInTheDocument();
    expect(screen.queryByText(/RemoteDisconnected/)).not.toBeInTheDocument();
  });

  it('shows DSA enrichment summary, news, and enrichment metadata', async () => {
    getScreeningStatus.mockResolvedValueOnce({
      enabled: true,
      available: true,
    });
    screenStocks.mockResolvedValueOnce({
      enabled: true,
      candidates: [
        {
          rank: 1,
          code: '600519',
          name: '貴州茅臺',
          score: 91.2,
          reason: 'Screening pick',
          dsaAnalysisSummary: 'DSA行情：現價 1688，漲跌幅 1.2%；DSA新聞：貴州茅臺最新公告',
          dsaNews: [{ title: '貴州茅臺最新公告', source: '測試源' }],
          dsaContext: {
            enriched: true,
            warnings: ['stock_news_unavailable'],
          },
          raw: {},
        },
      ],
      candidateCount: 1,
      dsaEnrichment: {
        enabled: true,
        requestedCount: 1,
        enrichedCount: 1,
      },
    });

    render(<StockScreeningPage />);

    expect(await screen.findByText('選股已打開')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /運行選股/ }));

    expect(await screen.findByText('深度補充：1 / 1')).toBeInTheDocument();

    expect(screen.getByText('增強摘要')).toBeInTheDocument();
    expect(screen.getByText(/行情：現價 1688/)).toBeInTheDocument();
    expect(screen.getByText('相關新聞')).toBeInTheDocument();
    expect(screen.getByText('貴州茅臺最新公告')).toBeInTheDocument();
    expect(screen.getByText('數據補充提示')).toBeInTheDocument();
    expect(screen.getByText('stock_news_unavailable')).toBeInTheDocument();
  });
  it('keeps the shared loading held when a stale auto-restore finishes while a manual history request is in flight', async () => {
    // 回归 OR-COR-9b1f8c4e：过期的自动恢复请求不得在 finally 中无条件清掉共享 loading，
    // 否则手动历史详情仍在飞行时“运行選股”会被提前放开。
    getScreeningStatus.mockResolvedValue({
      enabled: true,
      available: true,
    });
    window.sessionStorage.setItem('dsa.screening.activeScreenTask.v1', JSON.stringify({
      taskId: 'task-a',
      runId: 'run-a',
      strategy: 'capital_heat',
      market: 'cn',
      maxResults: 3,
    }));
    let resolveRunA: (value: unknown) => void = () => {};
    let resolveRunB: (value: unknown) => void = () => {};
    getRun.mockImplementation((runId: string) => {
      if (runId === 'run-a') {
        return new Promise((resolve) => {
          resolveRunA = resolve;
        });
      }
      if (runId === 'run-b') {
        return new Promise((resolve) => {
          resolveRunB = resolve;
        });
      }
      return Promise.reject(new Error('run not found'));
    });
    getHistory.mockResolvedValue({
      enabled: true,
      runs: [
        {
          runId: 'run-b',
          strategy: 'dual_low',
          market: 'cn',
          candidateCount: 1,
          createdAt: '2026-08-05T10:00:00Z',
        },
      ],
      runCount: 1,
    });
    render(<StockScreeningPage />);
    expect(await screen.findByText('選股已打開')).toBeInTheDocument();
    // 自动恢复 run-a 仍在飞行时，用户点开历史里的 run-b
    fireEvent.click(await screen.findByRole('button', { name: /Dual Low/ }));
    // 先让过期的自动恢复 run-a 结束（其响应已被 request-id 判定为过期）
    resolveRunA({
      runId: 'run-a',
      strategy: 'capital_heat',
      market: 'cn',
      candidateCount: 1,
      enabled: true,
      result: {
        enabled: true,
        candidates: [
          {
            rank: 1,
            code: '600519',
            name: '貴州茅臺',
            score: 90,
            reason: '熱度',
            raw: {},
          },
        ],
        candidateCount: 1,
        snapshotCount: 50,
        afterFilterCount: 10,
        llmRanked: true,
      },
    });
    await act(async () => {});
    // 过期 finally 不清共享 loading：表单仍处于禁用态（按钮在 loading 时渲染为 spinner，
    // 故用市場下拉框断言），页面也未切到任何历史结果
    expect(screen.getByLabelText('市場')).toBeDisabled();
    expect(screen.queryByText(/Dual Low · A 股/)).not.toBeInTheDocument();
    expect(screen.queryByText(/自定義策略 \(capital_heat\)/)).not.toBeInTheDocument();
    // 随后 run-b 正常返回：结果恢复，loading 由本次请求自己收口
    resolveRunB({
      runId: 'run-b',
      strategy: 'dual_low',
      market: 'cn',
      candidateCount: 1,
      enabled: true,
      result: {
        enabled: true,
        candidates: [
          {
            rank: 1,
            code: '600000',
            name: '浦發銀行',
            score: 88,
            reason: '低估值',
            raw: {},
          },
        ],
        candidateCount: 1,
        snapshotCount: 50,
        afterFilterCount: 10,
        llmRanked: true,
      },
    });
    expect(await screen.findByText(/Dual Low · A 股/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('市場')).toBeEnabled());
  });
  it('polls a newly submitted task immediately while a stale auto-restore request is still pending', async () => {
    // 回归 OR-COR-2c71d8af：handleSubmit 必须解除自动恢复门闩并作废飞行中的恢复请求，
    // 否则新任务的轮询会被阻塞到旧请求超时，页面假死在提交进度。
    getScreeningStatus.mockResolvedValue({
      enabled: true,
      available: true,
    });
    window.sessionStorage.setItem('dsa.screening.activeScreenTask.v1', JSON.stringify({
      taskId: 'task-a',
      runId: 'run-a',
      strategy: 'capital_heat',
      market: 'cn',
      maxResults: 3,
    }));
    // 自动恢复 run-a 永远挂起（模拟卡死的旧请求）
    getRun.mockImplementation((runId: string) => {
      if (runId === 'run-a') {
        return new Promise(() => {});
      }
      return Promise.resolve({
        runId: 'run-b',
        strategy: 'dual_low',
        market: 'cn',
        candidateCount: 1,
        enabled: true,
        result: {
          enabled: true,
          candidates: [
            {
              rank: 1,
              code: '600000',
              name: '歷史候選',
              score: 80,
              reason: '歷史',
              raw: {},
            },
          ],
          candidateCount: 1,
          snapshotCount: 50,
          afterFilterCount: 10,
          llmRanked: true,
        },
      });
    });
    getHistory.mockResolvedValue({
      enabled: true,
      runs: [
        {
          runId: 'run-b',
          strategy: 'dual_low',
          market: 'cn',
          candidateCount: 1,
          createdAt: '2026-08-05T10:00:00Z',
        },
      ],
      runCount: 1,
    });
    screenStocks.mockResolvedValue({
      enabled: true,
      candidates: [
        {
          rank: 1,
          code: '000001',
          name: '新任務候選',
          score: 88,
          reason: '新任務',
          raw: {},
        },
      ],
      candidateCount: 1,
    });
    render(<StockScreeningPage />);
    expect(await screen.findByText('選股已打開')).toBeInTheDocument();
    // 自动恢复挂起时，用户先打开历史 run-b（正常返回并由该请求自身收口 loading）
    fireEvent.click(await screen.findByRole('button', { name: /Dual Low/ }));
    expect(await screen.findByText(/Dual Low · A 股/)).toBeInTheDocument();
    // 随即发起新任务：轮询必须立即启动，不被仍挂起的自动恢复门闩阻塞
    fireEvent.click(screen.getByRole('button', { name: /運行選股/ }));
    await waitFor(() => expect(getScreenTask).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/新任務候選/)).toBeInTheDocument();
  });
  it('does not rewrite a restored custom strategy when the strategy list arrives late', async () => {
    // 回归：迟到的 /strategies 响应不得把历史/恢复上下文中的自定义策略改写回默认策略。
    let resolveStrategies: (value: unknown) => void = () => {};
    getStrategies.mockImplementation(
      () => new Promise((resolve) => {
        resolveStrategies = resolve;
      }),
    );
    getScreeningStatus.mockResolvedValue({
      enabled: true,
      available: true,
    });
    window.sessionStorage.setItem('dsa.screening.activeScreenTask.v1', JSON.stringify({
      taskId: 'task-a',
      runId: 'run-a',
      strategy: 'capital_heat',
      market: 'cn',
      maxResults: 3,
    }));
    getRun.mockResolvedValue({
      runId: 'run-a',
      strategy: 'capital_heat',
      market: 'cn',
      candidateCount: 1,
      enabled: true,
      result: {
        enabled: true,
        candidates: [
          {
            rank: 1,
            code: '600519',
            name: '貴州茅臺',
            score: 90,
            reason: '熱度',
            raw: {},
          },
        ],
        candidateCount: 1,
        snapshotCount: 50,
        afterFilterCount: 10,
        llmRanked: true,
      },
    });
    getHistory.mockResolvedValue({ enabled: true, runs: [], runCount: 0 });
    render(<StockScreeningPage />);
    expect(await screen.findByText('選股已打開')).toBeInTheDocument();
    // 自动恢复先应用历史上下文（此时策略列表请求仍挂起）
    expect(await screen.findByText(/自定義策略 \(capital_heat\) · A 股/)).toBeInTheDocument();
    // 迟到的策略列表不包含该历史策略
    resolveStrategies({
      enabled: true,
      strategies: [
        { id: 'dual_low', name: '雙低', description: 'desc', category: '價值' },
      ],
      strategyCount: 1,
    });
    await act(async () => {});
    // 归一化被跳过：表单下拉切到自定义项、输入框保留原始 ID、结果区标题不变
    expect(screen.getByLabelText('策略')).toHaveValue('__custom_strategy__');
    expect(screen.getByLabelText('自定義策略 ID')).toHaveValue('capital_heat');
    expect(screen.getByText(/自定義策略 \(capital_heat\) · A 股/)).toBeInTheDocument();
  });
  it('persists the selected history run so a refresh restores that run instead of the stale task', async () => {
    // 回归 OR-COR-4d1a7e90：手动打开歷史記錄后必须同步持久化恢复指针，
    // 刷新后应恢复用户刚选中的历史 run，而不是停留在更早的 task。
    getScreeningStatus.mockResolvedValue({
      enabled: true,
      available: true,
    });
    window.sessionStorage.setItem('dsa.screening.activeScreenTask.v1', JSON.stringify({
      taskId: 'task-a',
      strategy: 'dual_low',
      market: 'cn',
      maxResults: 3,
    }));
    getHistory.mockResolvedValue({
      enabled: true,
      runs: [
        {
          runId: 'run-b',
          strategy: 'capital_heat',
          market: 'cn',
          candidateCount: 1,
          createdAt: '2026-08-05T10:00:00Z',
        },
      ],
      runCount: 1,
    });
    getRun.mockResolvedValue({
      runId: 'run-b',
      strategy: 'capital_heat',
      market: 'cn',
      candidateCount: 1,
      enabled: true,
      result: {
        enabled: true,
        candidates: [
          {
            rank: 1,
            code: '600519',
            name: '貴州茅臺',
            score: 90,
            reason: '熱度',
            raw: {},
          },
        ],
        candidateCount: 1,
        snapshotCount: 50,
        afterFilterCount: 10,
        llmRanked: true,
      },
    });
    getScreenTask.mockResolvedValue({
      taskId: 'task-a',
      traceId: 'task-a',
      status: 'processing',
      progress: 10,
      message: '正在運行 Screening 選股',
      result: null,
    });
    const first = render(<StockScreeningPage />);
    expect(await screen.findByText('選股已打開')).toBeInTheDocument();
    // 手动选中歷史記錄 run-b（策略 capital_heat）
    fireEvent.click(await screen.findByText('capital_heat'));
    expect(await screen.findByText(/自定義策略 \(capital_heat\) · A 股/)).toBeInTheDocument();
    // 持久化指针已切换到刚选中的历史 run
    const stored = JSON.parse(
      window.sessionStorage.getItem('dsa.screening.activeScreenTask.v1') || '{}',
    );
    expect(stored.runId).toBe('run-b');
    expect(stored.taskId).toBe('run-b');
    // 刷新（重新挂载）后按新指针恢复 run-b，而不是旧 task-a
    first.unmount();
    render(<StockScreeningPage />);
    await waitFor(() => expect(getRun).toHaveBeenLastCalledWith('run-b'));
    expect(await screen.findByText(/自定義策略 \(capital_heat\) · A 股/)).toBeInTheDocument();
    // 正常恢复成功时不应对占位 taskId 触发轮询回退
    expect(getScreenTask).not.toHaveBeenCalledWith('run-b');
  });
});

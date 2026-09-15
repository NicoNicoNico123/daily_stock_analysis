import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createParsedApiError } from '../../api/error';
import { UiLanguageProvider } from '../../contexts/UiLanguageContext';
import { historyApi } from '../../api/history';
import type { Message, ProgressStep } from '../../stores/agentChatStore';
import type { StockIndexItem } from '../../types/stockIndex';
import { UI_LANGUAGE_STORAGE_KEY } from '../../utils/uiLanguage';
import ChatPage from '../ChatPage';
import { extractStockCodeFromMessage, extractStockCodesFromMessage } from '../../utils/chatStockCode';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const {
  mockGetSkills,
  mockGetStatus,
  mockDeleteChatSession,
  mockSendChat,
  mockGetSystemConfig,
  mockUpdateSystemConfig,
  mockGetWatchlist,
  mockAddToWatchlist,
  mockRemoveFromWatchlist,
  mockDownloadSession,
  mockFormatSessionAsMarkdown,
  mockStockIndex,
  mockStockIndexState,
} = vi.hoisted(() => {
  const mockStockIndex = [
    { canonicalCode: '600519.SH', displayCode: '600519', nameZh: '貴州茅臺', aliases: ['茅臺'], market: 'CN', assetType: 'stock', active: true },
    { canonicalCode: '300750.SZ', displayCode: '300750', nameZh: '寧德時代', aliases: [], market: 'CN', assetType: 'stock', active: true },
    { canonicalCode: '000001.SZ', displayCode: '000001', nameZh: '平安銀行', aliases: [], market: 'CN', assetType: 'stock', active: true },
    { canonicalCode: 'BABA', displayCode: 'BABA', nameZh: '阿里巴巴', aliases: [], market: 'US', assetType: 'stock', active: true },
    { canonicalCode: '09988.HK', displayCode: '09988', nameZh: '阿里巴巴', aliases: [], market: 'HK', assetType: 'stock', active: true },
    { canonicalCode: 'sh000001', displayCode: 'sh000001', nameZh: '上證指數', aliases: ['000001.SH'], market: 'CN', assetType: 'index', active: true },
    { canonicalCode: 'sh000016', displayCode: 'sh000016', nameZh: '上證50', aliases: ['000016.SH'], market: 'CN', assetType: 'index', active: true },
    { canonicalCode: 'sz399001', displayCode: 'sz399001', nameZh: '深證成指', aliases: ['399001.SZ'], market: 'CN', assetType: 'index', active: true },
    { canonicalCode: 'sh000300', displayCode: 'sh000300', nameZh: '滬深300', aliases: ['sz399300', '399300.SZ', '000300.SH', '000300.CSI'], market: 'CN', assetType: 'index', active: true },
    { canonicalCode: 'csi930955', displayCode: '930955.CSI', nameZh: '紅利低波100', aliases: [], market: 'CN', assetType: 'index', active: true },
  ];
  return {
    mockGetSkills: vi.fn(),
    mockGetStatus: vi.fn(),
    mockDeleteChatSession: vi.fn(),
    mockSendChat: vi.fn(),
    mockGetSystemConfig: vi.fn(),
    mockUpdateSystemConfig: vi.fn(),
    mockGetWatchlist: vi.fn(),
    mockAddToWatchlist: vi.fn(),
    mockRemoveFromWatchlist: vi.fn(),
    mockDownloadSession: vi.fn(),
    mockFormatSessionAsMarkdown: vi.fn(),
    mockStockIndex,
    // Mutable registry-load state for the async window shared by every backend.
    mockStockIndexState: {
      index: mockStockIndex,
      loading: false,
      error: null as Error | null,
      fallback: false,
      loaded: true,
    },
  };
});

const mockLoadSessions = vi.fn();
const mockLoadInitialSession = vi.fn();
const mockSwitchSession = vi.fn();
const mockStartStream = vi.fn();
const mockStopStream = vi.fn();
const mockClearCompletionBadge = vi.fn();
const mockStartNewChat = vi.fn();

const mockStoreState = {
  messages: [] as Message[],
  selectedSkillIds: null as string[] | null,
  loading: false,
  progressSteps: [] as ProgressStep[],
  sessionId: 'session-1',
  sessions: [
    {
      session_id: 'session-1',
      title: '請簡要分析 600519',
      message_count: 2,
      created_at: '2026-03-15T09:00:00Z',
      last_active: '2026-03-15T09:05:00Z',
    },
  ],
  sessionsLoading: false,
  chatError: null,
  stopping: false,
  terminalStatus: null as 'cancelled' | 'timeout' | null,
  stopError: false,
  loadSessions: mockLoadSessions,
  loadInitialSession: mockLoadInitialSession,
  switchSession: mockSwitchSession,
  stopStream: mockStopStream,
  startStream: mockStartStream,
  clearCompletionBadge: mockClearCompletionBadge,
};

vi.mock('../../api/agent', () => ({
  agentApi: {
    getSkills: mockGetSkills,
    getStatus: mockGetStatus,
    deleteChatSession: mockDeleteChatSession,
    sendChat: mockSendChat,
  },
}));

vi.mock('../../api/systemConfig', () => ({
  systemConfigApi: {
    getConfig: mockGetSystemConfig,
    update: mockUpdateSystemConfig,
    getWatchlist: mockGetWatchlist,
    addToWatchlist: mockAddToWatchlist,
    removeFromWatchlist: mockRemoveFromWatchlist,
  },
}));

vi.mock('../../utils/chatExport', () => ({
  downloadSession: mockDownloadSession,
  formatSessionAsMarkdown: mockFormatSessionAsMarkdown,
}));

vi.mock('../../api/history', () => ({
  historyApi: {
    getDetail: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../../hooks/useStockIndex', () => ({
  useStockIndex: () => ({
    index: mockStockIndexState.index,
    loading: mockStockIndexState.loading,
    error: mockStockIndexState.error,
    fallback: mockStockIndexState.fallback,
    loaded: mockStockIndexState.loaded,
  }),
}));

vi.mock('../../stores/agentChatStore', () => {
  type MockStore = typeof mockStoreState & {
    setSelectedSkillIds: (skillIds: string[]) => void;
  };
  const useAgentChatStore = (
    selector?: (state: MockStore) => unknown
  ) => {
    const [selectedSkillIds, setSelectedSkillIdsState] = useState(
      mockStoreState.selectedSkillIds,
    );
    const state: MockStore = {
      ...mockStoreState,
      selectedSkillIds,
      setSelectedSkillIds: (skillIds) => {
        setSelectedSkillIdsState(skillIds);
      },
    };
    return typeof selector === 'function' ? selector(state) : state;
  };

  useAgentChatStore.getState = () => ({
    startNewChat: mockStartNewChat,
  });

  return { useAgentChatStore };
});

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

  Object.defineProperty(window, 'requestAnimationFrame', {
    writable: true,
    value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0),
  });

  Object.defineProperty(window, 'cancelAnimationFrame', {
    writable: true,
    value: (handle: number) => window.clearTimeout(handle),
  });

  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    writable: true,
    value: vi.fn(),
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY);
  mockGetStatus.mockReset();
  mockStoreState.messages = [];
  mockStoreState.selectedSkillIds = null;
  mockStoreState.loading = false;
  mockStoreState.progressSteps = [];
  mockStoreState.chatError = null;
  mockStoreState.stopping = false;
  mockStoreState.terminalStatus = null;
  mockStoreState.stopError = false;
  mockStoreState.sessionsLoading = false;
  mockStoreState.sessionId = 'session-1';
  mockStoreState.sessions = [
    {
      session_id: 'session-1',
      title: '請簡要分析 600519',
      message_count: 2,
      created_at: '2026-03-15T09:00:00Z',
      last_active: '2026-03-15T09:05:00Z',
    },
  ];
  mockGetSkills.mockResolvedValue({
    skills: [
      { id: 'bull_trend', name: '趨勢分析', description: '測試技能' },
    ],
    default_skill_id: 'bull_trend',
  });
  mockGetStatus.mockResolvedValue({
    backend: 'litellm',
    available: true,
    experimental: false,
    errorCode: null,
    message: null,
  });
  mockStartStream.mockImplementation(async (_payload, meta) => {
    meta?.onAccepted?.({
      type: 'accepted',
      backend: 'litellm',
      request_id: 'request-test',
      session_id: 'session-1',
    });
  });
  mockDeleteChatSession.mockResolvedValue(undefined);
  mockSendChat.mockResolvedValue({ success: true });
  mockGetWatchlist.mockResolvedValue([]);
  mockGetSystemConfig.mockResolvedValue({
    configVersion: 'cfg-v1',
    maskToken: 'mask-token',
    items: [
      {
        key: 'AGENT_CONTEXT_COMPRESSION_ENABLED',
        value: 'false',
        rawValueExists: true,
        isMasked: false,
      },
    ],
  });
  mockUpdateSystemConfig.mockResolvedValue({
    success: true,
    configVersion: 'cfg-v2',
    appliedCount: 1,
    skippedMaskedCount: 0,
    reloadTriggered: true,
    updatedKeys: ['AGENT_CONTEXT_COMPRESSION_ENABLED'],
    warnings: [],
  });
  mockDownloadSession.mockImplementation(() => {});
  mockFormatSessionAsMarkdown.mockReturnValue('# exported session');
  mockStockIndexState.index = mockStockIndex;
  mockStockIndexState.loading = false;
  mockStockIndexState.error = null;
  mockStockIndexState.fallback = false;
  mockStockIndexState.loaded = true;
});

describe('ChatPage', () => {
  it('lets the user stop an active Codex analysis from the existing Chat composer', async () => {
    mockGetStatus.mockResolvedValueOnce({
      backend: 'codex_app_server',
      available: true,
      experimental: true,
      errorCode: null,
      message: null,
    });
    mockStoreState.loading = true;

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('button', { name: '停止分析' }));

    expect(mockStopStream).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '發送' })).not.toBeInTheDocument();
  });

  it('keeps the existing waiting state for LiteLLM without offering a false stop', async () => {
    mockStoreState.loading = true;

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('button', { name: '處理中...' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '停止分析' })).not.toBeInTheDocument();
    expect(mockStopStream).not.toHaveBeenCalled();
  });

  it('labels the stop action in English when the UI language is English', async () => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'en');
    mockGetStatus.mockResolvedValueOnce({
      backend: 'codex_app_server',
      available: true,
      experimental: true,
      errorCode: null,
      message: null,
    });
    mockStoreState.loading = true;

    render(
      <UiLanguageProvider>
        <MemoryRouter initialEntries={['/chat']}>
          <ChatPage />
        </MemoryRouter>
      </UiLanguageProvider>,
    );

    expect(await screen.findByRole('button', { name: 'Stop analysis' })).toBeInTheDocument();
  });

  it('shows a disabled stopping state until Codex confirms cleanup', async () => {
    mockGetStatus.mockResolvedValueOnce({
      backend: 'codex_app_server',
      available: true,
      experimental: true,
      errorCode: null,
      message: null,
    });
    mockStoreState.loading = true;
    mockStoreState.stopping = true;

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    const button = await screen.findByRole('button', { name: '正在停止…' });
    expect(button).toBeDisabled();
  });

  it('shows a plain-language terminal status after cancellation', async () => {
    mockStoreState.terminalStatus = 'cancelled';

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('status')).toHaveTextContent('本次分析已停止，後臺任務也已結束。');
  });

  it('shows the current backend in the existing Chat header', async () => {
    mockGetStatus.mockResolvedValueOnce({
      backend: 'codex_app_server',
      available: true,
      experimental: true,
      errorCode: null,
      message: null,
    });

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Codex Agent · 實驗')).toBeInTheDocument();
    expect(screen.getByText('Codex 當前可用範圍')).toBeInTheDocument();
    expect(screen.getByText(/實時行情、新聞、市場熱點/)).toBeInTheDocument();
    expect(screen.getByText('使用已保存的分析上下文和回測彙總，向 Codex 詢問個股。')).toBeInTheDocument();
    expect(screen.getByText(/Codex 將基於已保存的分析上下文和回測彙總回答/)).toBeInTheDocument();
    expect(screen.queryByText(/AI 将调用实时数据工具/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '切換問股方式' })).toBeInTheDocument();
    expect(mockGetStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByPlaceholderText(/分析 600519/)).toBeEnabled();
  });

  it('finishes the compatibility check when React Strict Mode remounts effects', async () => {
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/chat']}>
          <ChatPage />
        </MemoryRouter>
      </StrictMode>,
    );

    expect(await screen.findByPlaceholderText(/分析 600519/)).toBeEnabled();
    expect(screen.queryByText('正在確認問股運行環境')).not.toBeInTheDocument();
  });

  it('preserves the draft and disables sending while the compatibility check is pending', async () => {
    const status = createDeferred<{
      backend: string;
      available: boolean;
      experimental: boolean;
      errorCode: null;
      message: null;
    }>();
    mockGetStatus.mockReturnValueOnce(status.promise);

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('正在確認問股運行環境')).toBeInTheDocument();
    const input = screen.getByPlaceholderText(/分析 600519/);
    expect(input).toBeDisabled();
    expect(screen.getByRole('button', { name: '分析比亞迪趨勢' })).toBeDisabled();
    expect(screen.getByText(/不會調用模型或讀取股票數據/)).toBeInTheDocument();
    status.resolve({
      backend: 'codex_app_server',
      available: true,
      experimental: true,
      errorCode: null,
      message: null,
    });

    await waitFor(() => expect(input).toBeEnabled());
    expect(screen.getByRole('button', { name: '分析比亞迪趨勢' })).toBeEnabled();
    expect(mockGetStatus).toHaveBeenCalledTimes(1);
  });

  it('blocks sending only when backend status confirms unavailability and links to Agent settings', async () => {
    mockGetStatus.mockResolvedValueOnce({
      backend: 'codex_app_server',
      available: false,
      experimental: true,
      errorCode: 'command_not_found',
      message: 'Codex was not found',
    });
    const router = createMemoryRouter(
      [
        { path: '/chat', element: <ChatPage /> },
        { path: '/settings', element: <div>Agent settings destination</div> },
      ],
      { initialEntries: ['/chat'] },
    );
    render(<RouterProvider router={router} />);

    const input = await screen.findByPlaceholderText(/分析 600519/);
    expect(input).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '前往 Agent 設置' }));
    expect(await screen.findByText('Agent settings destination')).toBeInTheDocument();
    // React Router v7 applies navigations asynchronously; waitFor keeps the
    // assertion in an act-wrapped retry loop instead of reading a stale router state.
    await waitFor(() => {
      expect(router.state.location.search).toBe('?category=agent');
    });
  });

  it('keeps sending disabled when backend status cannot be established', async () => {
    mockGetStatus.mockRejectedValueOnce(new Error('temporary status failure'));
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('暫時無法讀取問股運行狀態')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/分析 600519/)).toBeDisabled();
    expect(mockGetStatus).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '重新檢查' }));
    await waitFor(() => expect(screen.getByPlaceholderText(/分析 600519/)).toBeEnabled());
    expect(mockGetStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps the draft until the server accepts the turn', async () => {
    const stream = createDeferred<void>();
    let onAccepted: ((event: {
      type: 'accepted';
      backend: 'litellm' | 'codex_app_server';
      request_id: string;
      session_id: string;
    }) => void) | undefined;
    mockStartStream.mockImplementationOnce(async (_payload, meta) => {
      onAccepted = meta?.onAccepted;
      await stream.promise;
    });

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    const input = await screen.findByPlaceholderText(/分析 600519/);
    fireEvent.change(input, { target: { value: '分析 AAPL' } });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));
    await waitFor(() => expect(mockStartStream).toHaveBeenCalledTimes(1));

    expect(input).toHaveValue('分析 AAPL');
    expect(onAccepted).toBeTypeOf('function');
    act(() => {
      onAccepted?.({
        type: 'accepted',
        backend: 'codex_app_server',
        request_id: 'request-accepted',
        session_id: 'session-1',
      });
    });
    expect(input).toHaveValue('');

    stream.resolve();
    await act(async () => {
      await stream.promise;
    });
  });

  it('resolves a registered index name to its canonical code without stripping the prefix', async () => {
    mockGetStatus.mockResolvedValueOnce({
      backend: 'codex_app_server',
      available: true,
      experimental: true,
      errorCode: null,
      message: null,
    });
    let sentPayload: { context?: { stock_code: string; stock_name: string | null } } | undefined;
    mockStartStream.mockImplementation(async (payload) => {
      sentPayload = payload as typeof sentPayload;
    });

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    const input = await screen.findByPlaceholderText(/分析 600519/);
    fireEvent.change(input, { target: { value: '分析上證指數' } });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));
    await waitFor(() => expect(mockStartStream).toHaveBeenCalledTimes(1));

    // sh000001 (上证指数) must be preserved verbatim — normalizeStockCode would
    // strip it to 000001 and collide with 平安银行 (000001.SZ).
    expect(sentPayload?.context?.stock_code).toBe('sh000001');
    expect(sentPayload?.context?.stock_name).toBe('上證指數');
  });

  it('resolves a registered CSI index display alias to its canonical code', async () => {
    mockGetStatus.mockResolvedValueOnce({
      backend: 'codex_app_server',
      available: true,
      experimental: true,
      errorCode: null,
      message: null,
    });
    let sentPayload: { context?: { stock_code: string; stock_name: string | null } } | undefined;
    mockStartStream.mockImplementation(async (payload) => {
      sentPayload = payload as typeof sentPayload;
    });

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    const input = await screen.findByPlaceholderText(/分析 600519/);
    fireEvent.change(input, { target: { value: '分析紅利低波100' } });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));
    await waitFor(() => expect(mockStartStream).toHaveBeenCalledTimes(1));

    expect(sentPayload?.context?.stock_code).toBe('csi930955');
    expect(sentPayload?.context?.stock_name).toBe('紅利低波100');
  });

  it('hides the watchlist action for a registered index canonical in Codex mode', async () => {
    mockGetStatus.mockResolvedValueOnce({
      backend: 'codex_app_server',
      available: true,
      experimental: true,
      errorCode: null,
      message: null,
    });
    mockStartStream.mockImplementation(async (_payload, meta) => {
      meta?.onAccepted?.({
        type: 'accepted',
        backend: 'codex_app_server',
        request_id: 'request-index',
        session_id: 'session-1',
      });
    });

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    const input = await screen.findByPlaceholderText(/分析 600519/);
    fireEvent.change(input, { target: { value: '分析上證50' } });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));
    await waitFor(() => expect(mockStartStream).toHaveBeenCalledTimes(1));

    // sh000016 is a registered index canonical → stock-only watchlist hidden.
    expect(screen.queryByText('加入自選')).not.toBeInTheDocument();
    expect(screen.queryByText('從自選刪除')).not.toBeInTheDocument();
  });

  it('keeps the watchlist action for a bare stock code that shares digits with an index', async () => {
    mockGetWatchlist.mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    const input = await screen.findByPlaceholderText(/分析 600519/);
    fireEvent.change(input, { target: { value: '分析 000001' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // 000001 (平安银行) is a stock; only the sh000001 index canonical hides the
    // action, so the bare same-digit stock keeps its watchlist button.
    expect(await screen.findByText('加入自選')).toBeInTheDocument();
  });

  const CODEX_STATUS = {
    backend: 'codex_app_server',
    available: true,
    experimental: true,
    errorCode: null,
    message: null,
  };
  const acceptedEvent = (requestId: string) => ({
    type: 'accepted' as const,
    backend: 'codex_app_server' as const,
    request_id: requestId,
    session_id: 'session-1' as const,
  });

  it.each([
    ['sh000016', 'sh000016'],
    ['000016.SH', 'sh000016'],
    ['930955.CSI', 'csi930955'],
    ['csi930955', 'csi930955'],
    ['sz399001', 'sz399001'],
  ] as const)('sends an explicit index code %s as its registry canonical', async (inputCode, expectedCanonical) => {
    mockGetStatus.mockResolvedValueOnce(CODEX_STATUS);
    let sentPayload: { context?: { stock_code: string; stock_name: string | null } } | undefined;
    mockStartStream.mockImplementation(async (payload) => {
      sentPayload = payload as typeof sentPayload;
    });

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    const input = await screen.findByPlaceholderText(/分析 600519/);
    fireEvent.change(input, { target: { value: `分析 ${inputCode}` } });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));
    await waitFor(() => expect(mockStartStream).toHaveBeenCalledTimes(1));

    // The registry canonical must survive extraction end-to-end — never be
    // stripped to a bare same-code stock, and the inner bare digits of a dotted
    // alias must not leak as a second code.
    expect(sentPayload?.context?.stock_code).toBe(expectedCanonical);
    expect(sentPayload?.context?.stock_name).toBeNull();
  });

  it.each([
    ['sh000016', 'sh000016'],
    ['000016.SH', 'sh000016'],
    ['000016.sh', 'sh000016'],
    ['CSI930955', 'csi930955'],
    ['930955.CSI', 'csi930955'],
    ['csi930955', 'csi930955'],
    ['sz399001', 'sz399001'],
    ['sz399300', 'sh000300'],
    ['399300.SZ', 'sh000300'],
    ['000300.SH', 'sh000300'],
  ] as const)('sends %s as %s under the default LiteLLM backend', async (inputCode, expectedCanonical) => {
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    const input = await screen.findByPlaceholderText(/分析 600519/);
    fireEvent.change(input, { target: { value: `分析 ${inputCode}` } });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          context: { stock_code: expectedCanonical, stock_name: null },
        }),
        expect.any(Object),
      );
    });
  });

  it('blocks every chat send entry point while the index registry is loading', async () => {
    mockStockIndexState.index = [];
    mockStockIndexState.loading = true;
    mockStockIndexState.loaded = false;

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    const input = await screen.findByPlaceholderText(/分析 600519/);
    fireEvent.change(input, { target: { value: '分析 sh000016' } });
    const sendButton = screen.getByRole('button', { name: '處理中...' });
    const quickQuestion = screen.getByRole('button', { name: '分析比亞迪趨勢' });

    expect(sendButton).toBeDisabled();
    expect(quickQuestion).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(sendButton);
    fireEvent.click(quickQuestion);
    expect(mockStartStream).not.toHaveBeenCalled();
  });

  it.each([
    ['success', mockStockIndex, null, false, 'sh000016'],
    ['failure', [], new Error('registry unavailable'), true, '000016'],
    ['empty', [], null, false, '000016'],
  ] as const)('releases direct sends after registry %s settle', async (_scenario, index, error, fallback, expectedCode) => {
    mockStockIndexState.index = [];
    mockStockIndexState.loading = true;
    mockStockIndexState.loaded = false;

    const { rerender } = render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );
    const input = await screen.findByPlaceholderText(/分析 600519/);
    fireEvent.change(input, { target: { value: '分析 sh000016' } });

    mockStockIndexState.index = [...index];
    mockStockIndexState.loading = false;
    mockStockIndexState.error = error;
    mockStockIndexState.fallback = fallback;
    mockStockIndexState.loaded = true;
    rerender(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    const sendButton = screen.getByRole('button', { name: '發送' });
    await waitFor(() => expect(sendButton).toBeEnabled());
    fireEvent.click(sendButton);
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          context: { stock_code: expectedCode, stock_name: null },
        }),
        expect.any(Object),
      );
    });
  });

  it('switches from an explicit index canonical to the bare same-code stock', async () => {
    mockGetStatus.mockResolvedValueOnce(CODEX_STATUS);
    mockStartStream.mockImplementation(async (_payload, meta) => {
      meta?.onAccepted?.(acceptedEvent('request-index'));
    });

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    const input = await screen.findByPlaceholderText(/分析 600519/);
    fireEvent.change(input, { target: { value: '分析 sh000016' } });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));
    await waitFor(() => expect(mockStartStream).toHaveBeenCalledTimes(1));

    fireEvent.change(input, { target: { value: '換成 000016 看看' } });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));
    await waitFor(() => expect(mockStartStream).toHaveBeenCalledTimes(2));

    // The explicit switch must send the BARE stock context — the index name or
    // self-selected state must not be reused across identities.
    expect(mockStartStream.mock.calls[1][0].context).toEqual({
      stock_code: '000016',
      stock_name: null,
    });
  });

  it('keeps the active index context untouched for compare messages mixing same-code identities', async () => {
    mockGetStatus.mockResolvedValueOnce(CODEX_STATUS);
    mockStartStream.mockImplementation(async (_payload, meta) => {
      meta?.onAccepted?.(acceptedEvent('request-index'));
    });

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    const input = await screen.findByPlaceholderText(/分析 600519/);
    fireEvent.change(input, { target: { value: '分析 sh000016' } });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));
    await waitFor(() => expect(mockStartStream).toHaveBeenCalledTimes(1));

    fireEvent.change(input, { target: { value: '比較 sh000016 和 000016 的差異' } });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));
    await waitFor(() => expect(mockStartStream).toHaveBeenCalledTimes(2));

    expect(mockStartStream.mock.calls[1][0].context).toEqual({
      stock_code: 'sh000016',
      stock_name: null,
    });
  });

  it('hides the stock-only watchlist action after an explicit index code is sent', async () => {
    mockGetStatus.mockResolvedValueOnce(CODEX_STATUS);
    mockStartStream.mockImplementation(async (_payload, meta) => {
      meta?.onAccepted?.(acceptedEvent('request-index'));
    });

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    const input = await screen.findByPlaceholderText(/分析 600519/);
    fireEvent.change(input, { target: { value: '分析 930955.CSI' } });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));
    await waitFor(() => expect(mockStartStream).toHaveBeenCalledTimes(1));

    expect(screen.queryByText('加入自選')).not.toBeInTheDocument();
    expect(screen.queryByText('從自選刪除')).not.toBeInTheDocument();
  });

  it('keeps the stock guard for sh600519 / SZ000001 even when the registry is loaded', async () => {
    mockGetStatus.mockResolvedValueOnce(CODEX_STATUS);
    let sentPayload: { context?: { stock_code: string; stock_name: string | null } } | undefined;
    mockStartStream.mockImplementation(async (payload) => {
      sentPayload = payload as typeof sentPayload;
    });

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    const input = await screen.findByPlaceholderText(/分析 600519/);
    fireEvent.change(input, { target: { value: '分析 sh600519' } });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));
    await waitFor(() => expect(mockStartStream).toHaveBeenCalledTimes(1));

    // sh600519 is not a registered index alias → the stock guard keeps the
    // bare 600519 identity even with the registry loaded.
    expect(sentPayload?.context?.stock_code).toBe('600519');
    expect(sentPayload?.context?.stock_name).toBeNull();
  });

  it('renders the new Codex status copy in English when the UI language is English', async () => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'en');
    mockGetStatus.mockResolvedValueOnce({
      backend: 'codex_app_server',
      available: false,
      experimental: true,
      errorCode: 'command_not_found',
      message: 'Codex was not found',
    });

    render(
      <UiLanguageProvider>
        <MemoryRouter initialEntries={['/chat']}>
          <ChatPage />
        </MemoryRouter>
      </UiLanguageProvider>,
    );

    expect(await screen.findByText('Codex Agent · Experimental')).toBeInTheDocument();
    expect(screen.getByText('This device does not currently meet the basic Codex ask-stock requirements. Open Agent settings to check installation and Single Agent mode.')).toBeInTheDocument();
    expect(screen.queryByText(/当前不可用|前往 Agent 設置检查/)).not.toBeInTheDocument();
  });

  it('renders status-read failure copy in English', async () => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'en');
    mockGetStatus.mockRejectedValueOnce(new Error('temporary status failure'));

    render(
      <UiLanguageProvider>
        <MemoryRouter initialEntries={['/chat']}>
          <ChatPage />
        </MemoryRouter>
      </UiLanguageProvider>,
    );

    expect(await screen.findByText('Ask-stock status is temporarily unavailable')).toBeInTheDocument();
    expect(screen.getByText('The ask-stock runtime cannot be confirmed, so sending is paused. You can check again manually; your question will be preserved.')).toBeInTheDocument();
    expect(screen.queryByText('暫時無法讀取問股運行狀態')).not.toBeInTheDocument();
  });

  it('renders a fixed workspace shell with independent session and message viewports', async () => {
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByTestId('chat-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('chat-session-list-scroll')).toBeInTheDocument();
    expect(screen.getByTestId('chat-message-scroll')).toBeInTheDocument();
    expect(mockLoadInitialSession).toHaveBeenCalled();
    expect(mockClearCompletionBadge).toHaveBeenCalled();
  });

  it('loads and saves the global context compression setting from the chat input area', async () => {
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    const compressionToggle = await screen.findByRole('checkbox', { name: /上下文壓縮/ });

    await waitFor(() => {
      expect(compressionToggle).not.toBeDisabled();
    });

    expect(compressionToggle).not.toBeChecked();

    fireEvent.click(compressionToggle);

    await waitFor(() => {
      expect(mockUpdateSystemConfig).toHaveBeenCalledWith({
        configVersion: 'cfg-v1',
        maskToken: 'mask-token',
        reloadNow: true,
        items: [
          {
            key: 'AGENT_CONTEXT_COMPRESSION_ENABLED',
            value: 'true',
          },
        ],
      });
    });

    expect(compressionToggle).toBeChecked();
    expect(screen.getByText('已激活')).toBeInTheDocument();
  });

  it('rolls back the context compression switch when saving fails', async () => {
    mockGetSystemConfig.mockResolvedValue({
      configVersion: 'cfg-v1',
      maskToken: 'mask-token',
      items: [
        {
          key: 'AGENT_CONTEXT_COMPRESSION_ENABLED',
          value: 'true',
          rawValueExists: true,
          isMasked: false,
        },
      ],
    });
    mockUpdateSystemConfig.mockRejectedValue(
      createParsedApiError({
        title: '保存失敗',
        message: '配置服務不可用',
        category: 'unknown',
      }),
    );

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    const compressionToggle = await screen.findByRole('checkbox', { name: /上下文壓縮/ });

    await waitFor(() => {
      expect(compressionToggle).toBeChecked();
      expect(compressionToggle).not.toBeDisabled();
    });

    fireEvent.click(compressionToggle);

    await waitFor(() => {
      expect(mockUpdateSystemConfig).toHaveBeenCalledWith(expect.objectContaining({
        items: [
          {
            key: 'AGENT_CONTEXT_COMPRESSION_ENABLED',
            value: 'false',
          },
        ],
      }));
      expect(compressionToggle).toBeChecked();
    });
    expect(screen.getByText('配置服務不可用')).toBeInTheDocument();
  });

  it('does not switch when clicking the current session card', async () => {
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    const sessionCard = await screen.findByRole('button', {
      name: /切換到對話 請簡要分析 600519/,
    });

    fireEvent.click(sessionCard);
    expect(mockSwitchSession).not.toHaveBeenCalled();
    expect(sessionCard).toHaveAttribute('aria-current', 'page');
  });

  it('renders a separate delete button for each session and opens confirmation without switching', async () => {
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    const deleteButton = await screen.findByRole('button', {
      name: /刪除對話 請簡要分析 600519/,
    });

    fireEvent.click(deleteButton);

    expect(mockSwitchSession).not.toHaveBeenCalled();
    expect(await screen.findByText('刪除後，該對話將不可恢復，確認刪除嗎？')).toBeInTheDocument();
  });

  it('hides header actions when there are no messages', async () => {
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: '問股' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '導出會話' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '發送到已配置的通知機器人/郵箱' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '歷史對話' })).toBeInTheDocument();
  });

  it('exports the current session from the header action', async () => {
    mockStoreState.messages = [
      { id: 'user-1', role: 'user', content: '請分析 600519' },
      { id: 'assistant-1', role: 'assistant', content: '趨勢偏強', skillName: '趨勢分析' },
    ];

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('button', { name: '導出會話爲 Markdown 文件' }));

    expect(mockDownloadSession).toHaveBeenCalledWith(mockStoreState.messages);
    expect(mockFormatSessionAsMarkdown).not.toHaveBeenCalled();
  });

  it('renders assistant skill labels with shared badge semantics', async () => {
    mockStoreState.messages = [
      { id: 'assistant-1', role: 'assistant', content: '趨勢偏強', skillName: '趨勢分析' },
    ];

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    const skillBadge = await screen.findByLabelText('技能 趨勢分析');
    expect(skillBadge).toBeInTheDocument();
    expect(skillBadge).toHaveTextContent('趨勢分析');
  });

  it('renders assistant multi-skill labels with shared badge semantics', async () => {
    mockStoreState.messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '趨勢偏強',
        skills: ['bull_trend', 'ma_golden_cross'],
        skillNames: ['趨勢分析', '均線金叉'],
      },
    ];

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    const skillBadge = await screen.findByLabelText('技能 趨勢分析、均線金叉');
    expect(skillBadge).toBeInTheDocument();
    expect(skillBadge).toHaveTextContent('趨勢分析、均線金叉');
  });

  it('renders failed stage_done progress as a non-success state', async () => {
    mockStoreState.loading = true;
    mockStoreState.progressSteps = [
      { type: 'stage_done', stage: 'risk', status: 'failed' },
    ];
    mockStoreState.messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Partial answer',
        thinkingSteps: [
          { type: 'stage_done', stage: 'risk', status: 'failed' },
        ],
      },
    ];

    const { container } = render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findAllByText('risk failed')).toHaveLength(1);

    const thinkingToggle = container.querySelector('button[class*="mb-2"][class*="w-full"]') as HTMLButtonElement;
    fireEvent.click(thinkingToggle);

    const failedStage = screen.getAllByText('risk failed').find((node) =>
      node.closest('.chat-progress-item'),
    );
    expect(failedStage).toBeDefined();
    expect(failedStage?.closest('.chat-progress-item')).toHaveClass('chat-progress-item-danger');
    expect(failedStage?.closest('.chat-progress-item')).not.toHaveClass('chat-progress-item-success');
  });

  it('renders pipeline budget skip progress without timeout severity', async () => {
    mockStoreState.loading = true;
    mockStoreState.progressSteps = [
      { type: 'pipeline_budget_skipped', stage: 'decision' },
    ];
    mockStoreState.messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Partial answer',
        thinkingSteps: [
          { type: 'pipeline_budget_skipped', stage: 'decision' },
        ],
      },
    ];

    const { container } = render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findAllByText('decision skipped: insufficient budget')).toHaveLength(1);
    expect(screen.queryByText('decision timed out')).not.toBeInTheDocument();

    const thinkingToggle = container.querySelector('button[class*="mb-2"][class*="w-full"]') as HTMLButtonElement;
    fireEvent.click(thinkingToggle);

    const budgetSkipped = screen.getAllByText('decision skipped: insufficient budget').find((node) =>
      node.closest('.chat-progress-item'),
    );
    expect(budgetSkipped).toBeDefined();
    expect(budgetSkipped?.closest('.chat-progress-item')).toHaveClass('chat-progress-item-muted');
    expect(budgetSkipped?.closest('.chat-progress-item')).not.toHaveClass('chat-progress-item-danger');
  });

  it('selects the default skill after loading skills', async () => {
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole('checkbox', { name: '趨勢分析' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '通用分析' })).not.toBeChecked();
  });

  it('keeps the restored session skills when the Skill catalog finishes loading', async () => {
    mockStoreState.selectedSkillIds = ['ma_golden_cross'];
    mockGetSkills.mockResolvedValue({
      skills: [
        { id: 'bull_trend', name: '趨勢分析', description: '缺省趨勢' },
        { id: 'ma_golden_cross', name: '均線金叉', description: '均線交叉' },
      ],
      default_skill_id: 'bull_trend',
    });

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole('checkbox', { name: '均線金叉' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '趨勢分析' })).not.toBeChecked();

    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '繼續分析' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalledWith(
        expect.objectContaining({ skills: ['ma_golden_cross'] }),
        expect.any(Object),
      );
    });
  });

  it('omits skills for an untouched new session so the server resolves its default', async () => {
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole('checkbox', { name: '趨勢分析' })).toBeChecked();
    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '分析 AAPL' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => expect(mockStartStream).toHaveBeenCalled());
    expect(mockStartStream.mock.calls.at(-1)?.[0]).not.toHaveProperty('skills');
  });

  it('omits skills when continuing a legacy session without persisted Skill state', async () => {
    mockStoreState.messages = [
      { id: 'legacy-user', role: 'user', content: '分析 AAPL' },
      { id: 'legacy-assistant', role: 'assistant', content: '歷史分析結果' },
    ];
    mockStoreState.selectedSkillIds = null;

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole('checkbox', { name: '趨勢分析' })).toBeChecked();
    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '繼續分析' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => expect(mockStartStream).toHaveBeenCalled());
    expect(mockStartStream.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        message: '繼續分析',
        session_id: 'session-1',
      }),
    );
    expect(mockStartStream.mock.calls.at(-1)?.[0]).not.toHaveProperty('skills');
  });

  it('sends multiple selected skills in order', async () => {
    mockGetSkills.mockResolvedValue({
      skills: [
        { id: 'bull_trend', name: '趨勢分析', description: '缺省趨勢' },
        { id: 'ma_golden_cross', name: '均線金叉', description: '均線交叉' },
      ],
      default_skill_id: 'bull_trend',
    });

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('checkbox', { name: '均線金叉' }));
    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '分析 600519' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalledWith(
        expect.objectContaining({
          message: '分析 600519',
          skills: ['bull_trend', 'ma_golden_cross'],
        }),
        expect.objectContaining({
          skillNames: ['趨勢分析', '均線金叉'],
          skillName: '趨勢分析、均線金叉',
        }),
      );
    });
  });

  it('adds the quick-question stock context only for Codex', async () => {
    mockGetStatus.mockResolvedValueOnce({
      backend: 'codex_app_server',
      available: true,
      experimental: true,
      errorCode: null,
      message: null,
    });
    mockGetSkills.mockResolvedValue({
      skills: [{ id: 'chan_theory', name: '纏論', description: '結構分析' }],
      default_skill_id: 'chan_theory',
    });

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole('button', { name: '用纏論分析茅臺' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalledWith(
        expect.objectContaining({
          context: { stock_code: '600519', stock_name: '貴州茅臺' },
        }),
        expect.any(Object),
      );
    });
  });

  it('collapses the mobile skill picker by default and keeps selected skills when sending', async () => {
    mockGetSkills.mockResolvedValue({
      skills: [
        { id: 'bull_trend', name: '趨勢分析', description: '缺省趨勢' },
        { id: 'ma_golden_cross', name: '均線金叉', description: '均線交叉' },
      ],
      default_skill_id: 'bull_trend',
    });

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    const mobileToggle = await screen.findByRole('button', { name: '展開策略選擇' });
    const skillPanel = screen.getByTestId('chat-skill-picker-panel');
    expect(mobileToggle).toHaveAttribute('aria-expanded', 'false');
    expect(skillPanel).toHaveClass('hidden');

    fireEvent.click(mobileToggle);

    expect(screen.getByRole('button', { name: '收起策略選擇' })).toHaveAttribute('aria-expanded', 'true');
    expect(skillPanel).not.toHaveClass('hidden');
    expect(skillPanel).toHaveClass('flex');

    fireEvent.click(screen.getByRole('checkbox', { name: '均線金叉' }));
    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '分析 600519' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalledWith(
        expect.objectContaining({
          message: '分析 600519',
          skills: ['bull_trend', 'ma_golden_cross'],
        }),
        expect.objectContaining({
          skillName: '趨勢分析、均線金叉',
        }),
      );
    });

    expect(screen.getByRole('button', { name: '展開策略選擇' })).toHaveAttribute('aria-expanded', 'false');
    expect(skillPanel).toHaveClass('hidden');
  });

  it('sends an explicit empty skills list when all concrete skills are cleared', async () => {
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('checkbox', { name: '趨勢分析' }));
    expect(screen.getByRole('checkbox', { name: '通用分析' })).toBeChecked();

    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '分析 AAPL' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const lastCall = mockStartStream.mock.calls[mockStartStream.mock.calls.length - 1];
    expect(lastCall[0]).toEqual(expect.objectContaining({
      message: '分析 AAPL',
      skills: [],
    }));
    expect(lastCall[1]).toEqual(expect.objectContaining({
      skillNames: ['通用'],
      skillName: '通用',
    }));
  });

  it('caps concrete skill selection at three and re-enables choices after unselecting', async () => {
    mockGetSkills.mockResolvedValue({
      skills: [
        { id: 'bull_trend', name: '趨勢分析', description: '缺省趨勢' },
        { id: 'ma_golden_cross', name: '均線金叉', description: '均線交叉' },
        { id: 'chan_theory', name: '纏論', description: '結構分析' },
        { id: 'wave_theory', name: '波浪理論', description: '波浪分析' },
      ],
      default_skill_id: 'bull_trend',
    });

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('checkbox', { name: '均線金叉' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '纏論' }));

    const wave = screen.getByRole('checkbox', { name: '波浪理論' });
    expect(wave).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: '均線金叉' }));
    expect(wave).not.toBeDisabled();
  });

  it('quick questions override the current multi-skill selection', async () => {
    mockGetSkills.mockResolvedValue({
      skills: [
        { id: 'bull_trend', name: '趨勢分析', description: '缺省趨勢' },
        { id: 'ma_golden_cross', name: '均線金叉', description: '均線交叉' },
        { id: 'chan_theory', name: '纏論', description: '結構分析' },
      ],
      default_skill_id: 'bull_trend',
    });

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('checkbox', { name: '均線金叉' }));
    fireEvent.click(screen.getByRole('button', { name: '用纏論分析茅臺' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalledWith(
        expect.objectContaining({
          message: '用纏論分析茅臺',
          skills: ['chan_theory'],
        }),
        expect.objectContaining({
          skillNames: ['纏論'],
          skillName: '纏論',
        }),
      );
    });
    expect(mockStartStream.mock.calls.at(-1)?.[0]?.context).toBeUndefined();
  });

  it('keeps a quick question in the input until the server accepts it', async () => {
    mockGetSkills.mockResolvedValue({
      skills: [{ id: 'chan_theory', name: '纏論', description: '結構分析' }],
      default_skill_id: 'chan_theory',
    });
    mockStartStream.mockResolvedValueOnce(undefined);

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    const quickQuestion = await screen.findByRole('button', { name: '用纏論分析茅臺' });
    await waitFor(() => expect(quickQuestion).toBeEnabled());
    fireEvent.click(quickQuestion);

    await waitFor(() => expect(mockStartStream).toHaveBeenCalledTimes(1));
    expect(screen.getByPlaceholderText(/分析 600519/)).toHaveValue('用纏論分析茅臺');
  });

  it('submits the A-share SMIC quick question with an unambiguous stock context', async () => {
    mockGetStatus.mockResolvedValueOnce({
      backend: 'codex_app_server',
      available: true,
      experimental: true,
      errorCode: null,
      message: null,
    });
    mockGetSkills.mockResolvedValue({
      skills: [{ id: 'box_oscillation', name: '箱體震盪', description: '震盪區間' }],
      default_skill_id: 'box_oscillation',
    });

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    await screen.findByText('Codex Agent · 實驗');
    fireEvent.click(await screen.findByRole('button', { name: '用箱體震盪分析 A 股中芯國際 688981' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalledWith(
        expect.objectContaining({
          message: '用箱體震盪分析 A 股中芯國際 688981',
          skills: ['box_oscillation'],
          context: {
            stock_code: '688981',
            stock_name: '中芯國際',
          },
        }),
        expect.objectContaining({
          skillNames: ['箱體震盪'],
          skillName: '箱體震盪',
        }),
      );
    });
  });

  it('reuses the stock index for one unambiguous stock name', async () => {
    mockGetStatus.mockResolvedValueOnce({
      backend: 'codex_app_server',
      available: true,
      experimental: true,
      errorCode: null,
      message: null,
    });
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    fireEvent.change(await screen.findByPlaceholderText(/分析 600519/), {
      target: { value: '茅臺現在適合買入嗎？' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalledWith(
        expect.objectContaining({
          context: {
            stock_code: '600519',
            stock_name: '貴州茅臺',
          },
        }),
        expect.any(Object),
      );
    });
  });

  it('does not guess when one stock name maps to multiple markets', async () => {
    mockGetStatus.mockResolvedValueOnce({
      backend: 'codex_app_server',
      available: true,
      experimental: true,
      errorCode: null,
      message: null,
    });
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    fireEvent.change(await screen.findByPlaceholderText(/分析 600519/), {
      target: { value: '分析阿里巴巴' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalledWith(
        expect.objectContaining({ context: undefined }),
        expect.any(Object),
      );
    });
  });

  it('keeps assistant message actions directly activatable in the DOM', async () => {
    mockStoreState.messages = [
      { id: 'assistant-1', role: 'assistant', content: '趨勢偏強', skillName: '趨勢分析' },
    ];

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    const exportButton = await screen.findByRole('button', { name: '導出此條消息爲 Markdown' });
    const actionGroup = exportButton.parentElement;

    expect(actionGroup).toHaveClass('chat-message-actions');
    expect(actionGroup?.className).not.toMatch(/pointer-events-none|opacity-0/);
  });

  it('sends exported markdown to notification channel and shows success feedback', async () => {
    mockStoreState.messages = [
      { id: 'user-1', role: 'user', content: '請分析 600519' },
      { id: 'assistant-1', role: 'assistant', content: '趨勢偏強', skillName: '趨勢分析' },
    ];
    mockGetStatus.mockResolvedValueOnce({
      backend: 'codex_app_server',
      available: false,
      experimental: true,
      errorCode: 'command_not_found',
      message: 'Codex was not found',
    });
    mockFormatSessionAsMarkdown.mockReturnValue('# exported markdown');

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('button', { name: '發送到已配置的通知機器人/郵箱' }));

    await waitFor(() => {
      expect(mockFormatSessionAsMarkdown).toHaveBeenCalledWith(mockStoreState.messages);
      expect(mockSendChat).toHaveBeenCalledWith('# exported markdown');
    });

    expect(await screen.findByText('已發送到通知渠道')).toBeInTheDocument();
  });

  it('shows parsed error feedback when notification delivery fails', async () => {
    mockStoreState.messages = [
      { id: 'user-1', role: 'user', content: '請分析 AAPL' },
      { id: 'assistant-1', role: 'assistant', content: '短線震盪', skillName: '趨勢分析' },
    ];
    mockSendChat.mockRejectedValue(
      createParsedApiError({
        title: '發送失敗',
        message: '通知渠道不可用',
        category: 'unknown',
      }),
    );

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('button', { name: '發送到已配置的通知機器人/郵箱' }));

    expect(await screen.findByText('通知渠道不可用')).toBeInTheDocument();
  });

  it('prevents duplicate notification sends while the request is in flight', async () => {
    mockStoreState.messages = [
      { id: 'user-1', role: 'user', content: '請分析 TSLA' },
      { id: 'assistant-1', role: 'assistant', content: '波動較大', skillName: '趨勢分析' },
    ];
    const deferred = createDeferred<{ success: boolean }>();
    mockSendChat.mockImplementation(() => deferred.promise);

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    const sendButton = await screen.findByRole('button', { name: '發送到已配置的通知機器人/郵箱' });
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(mockSendChat).toHaveBeenCalledTimes(1);
      expect(sendButton).toBeDisabled();
    });

    fireEvent.click(sendButton);
    expect(mockSendChat).toHaveBeenCalledTimes(1);

    deferred.resolve({ success: true });

    await waitFor(() => {
      expect(sendButton).not.toBeDisabled();
    });
  });

  it('allows sending with base follow-up context before report hydration completes', async () => {
    const deferred = createDeferred<Awaited<ReturnType<typeof historyApi.getDetail>>>();

    vi.mocked(historyApi.getDetail).mockImplementation(() => deferred.promise);

    render(
      <MemoryRouter initialEntries={['/chat?stock=600519&name=%E8%B2%B4%E5%B7%9E%E8%8C%85%E8%87%BA&recordId=1']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByDisplayValue('請深入分析 貴州茅臺(600519)')).toBeInTheDocument();

    const sendButton = screen.getByRole('button', { name: /發送|处理中\.\.\./ });
    expect(sendButton).not.toBeDisabled();
    expect(screen.getByText('正在加載歷史分析上下文；現在可直接發送追問。')).toBeInTheDocument();

    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalledWith(
        expect.objectContaining({
          message: '請深入分析 貴州茅臺(600519)',
          context: {
            stock_code: '600519',
            stock_name: '貴州茅臺',
          },
        }),
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });

    deferred.resolve({
      meta: {
        id: 1,
        queryId: 'q-1',
        stockCode: '600519',
        stockName: '貴州茅臺',
        reportType: 'detailed',
        createdAt: '2026-03-18T08:00:00Z',
        currentPrice: 1523.6,
        changePct: 1.8,
      },
      summary: {
        analysisSummary: '趨勢延續',
        operationAdvice: '繼續觀察',
        trendPrediction: '高位震盪',
        sentimentScore: 78,
      },
      strategy: {
        stopLoss: '1450',
      },
    });

    await waitFor(() => {
      expect(screen.queryByText('正在加載歷史分析上下文；現在可直接發送追問。')).not.toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '繼續分析成交量' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: '繼續分析成交量',
          context: expect.objectContaining({
            stock_code: '600519',
            stock_name: '貴州茅臺',
          }),
        }),
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });

    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '如果不考慮 TTM 呢' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: '如果不考慮 TTM 呢',
          context: expect.objectContaining({
            stock_code: '600519',
            stock_name: '貴州茅臺',
          }),
        }),
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });
  });

  it('uses hydrated report context when it finishes before sending', async () => {
    vi.mocked(historyApi.getDetail).mockResolvedValue({
      meta: {
        id: 1,
        queryId: 'q-1',
        stockCode: '600519',
        stockName: '貴州茅臺',
        reportType: 'detailed',
        createdAt: '2026-03-18T08:00:00Z',
        currentPrice: 1523.6,
        changePct: 1.8,
      },
      summary: {
        analysisSummary: '趨勢延續',
        operationAdvice: '繼續觀察',
        trendPrediction: '高位震盪',
        sentimentScore: 78,
      },
      strategy: {
        stopLoss: '1450',
      },
    });

    render(
      <MemoryRouter initialEntries={['/chat?stock=600519&name=%E8%B2%B4%E5%B7%9E%E8%8C%85%E8%87%BA&recordId=1']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByDisplayValue('請深入分析 貴州茅臺(600519)')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.queryByText('正在加載歷史分析上下文；現在可直接發送追問。')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalledWith(
        expect.objectContaining({
          message: '請深入分析 貴州茅臺(600519)',
          context: expect.objectContaining({
            stock_code: '600519',
            stock_name: '貴州茅臺',
            previous_price: 1523.6,
            previous_change_pct: 1.8,
            previous_strategy: expect.objectContaining({
              stopLoss: '1450',
            }),
          }),
        }),
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });
  });

  it('falls back to base stock context when recordId is missing', async () => {
    render(
      <MemoryRouter initialEntries={['/chat?stock=AAPL']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByDisplayValue('請深入分析 AAPL')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalledWith(
        expect.objectContaining({
          message: '請深入分析 AAPL',
          context: {
            stock_code: 'AAPL',
            stock_name: null,
          },
        }),
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });
    expect(historyApi.getDetail).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '繼續看估值' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: '繼續看估值',
          context: {
            stock_code: 'AAPL',
            stock_name: null,
          },
        }),
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });
  });

  it('switches active stock context for explicit switch messages', async () => {
    render(
      <MemoryRouter initialEntries={['/chat?stock=600519&name=%E8%B2%B4%E5%B7%9E%E8%8C%85%E8%87%BA']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByDisplayValue('請深入分析 貴州茅臺(600519)')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '換成 AAPL 看看' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: '換成 AAPL 看看',
          context: {
            stock_code: 'AAPL',
            stock_name: null,
          },
        }),
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });
  });

  it('switches Codex stock context when an explicit switch names one stock', async () => {
    mockGetStatus.mockResolvedValueOnce({
      backend: 'codex_app_server',
      available: true,
      experimental: true,
      errorCode: null,
      message: null,
    });
    render(
      <MemoryRouter initialEntries={['/chat?stock=600519&name=%E8%B2%B4%E5%B7%9E%E8%8C%85%E8%87%BA']}>
        <ChatPage />
      </MemoryRouter>,
    );

    expect(await screen.findByDisplayValue('請深入分析 貴州茅臺(600519)')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '分析寧德時代' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalledWith(
        expect.objectContaining({
          message: '分析寧德時代',
          context: {
            stock_code: '300750',
            stock_name: '寧德時代',
          },
        }),
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });
  });

  it('switches to the single new stock when the current stock appears first', async () => {
    render(
      <MemoryRouter initialEntries={['/chat?stock=600519&name=%E8%B2%B4%E5%B7%9E%E8%8C%85%E8%87%BA']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByDisplayValue('請深入分析 貴州茅臺(600519)')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '先不看 600519，換成 AAPL 看看' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: '先不看 600519，換成 AAPL 看看',
          context: {
            stock_code: 'AAPL',
            stock_name: null,
          },
        }),
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });

    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '繼續看支撐位' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: '繼續看支撐位',
          context: {
            stock_code: 'AAPL',
            stock_name: null,
          },
        }),
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });
  });

  it('keeps active stock context for compare messages', async () => {
    render(
      <MemoryRouter initialEntries={['/chat?stock=600519&name=%E8%B2%B4%E5%B7%9E%E8%8C%85%E8%87%BA']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByDisplayValue('請深入分析 貴州茅臺(600519)')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '比較 600519 和 AAPL' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: '比較 600519 和 AAPL',
          context: {
            stock_code: '600519',
            stock_name: '貴州茅臺',
          },
        }),
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });
  });

  it('keeps active stock context for difference-style compare messages', async () => {
    render(
      <MemoryRouter initialEntries={['/chat?stock=600519&name=%E8%B2%B4%E5%B7%9E%E8%8C%85%E8%87%BA']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByDisplayValue('請深入分析 貴州茅臺(600519)')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '分析 600519 和 AAPL 的差異' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: '分析 600519 和 AAPL 的差異',
          context: {
            stock_code: '600519',
            stock_name: '貴州茅臺',
          },
        }),
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });
  });

  it('keeps active stock context when the compared stock appears first', async () => {
    render(
      <MemoryRouter initialEntries={['/chat?stock=600519&name=%E8%B2%B4%E5%B7%9E%E8%8C%85%E8%87%BA']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByDisplayValue('請深入分析 貴州茅臺(600519)')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '分析 AAPL 和 600519 的差異' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: '分析 AAPL 和 600519 的差異',
          context: {
            stock_code: '600519',
            stock_name: '貴州茅臺',
          },
        }),
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });
  });

  it('keeps active stock context for choice-style multi-stock messages', async () => {
    render(
      <MemoryRouter initialEntries={['/chat?stock=600519&name=%E8%B2%B4%E5%B7%9E%E8%8C%85%E8%87%BA']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByDisplayValue('請深入分析 貴州茅臺(600519)')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: 'AAPL 和 TSLA 哪個更值得買' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: 'AAPL 和 TSLA 哪個更值得買',
          context: {
            stock_code: '600519',
            stock_name: '貴州茅臺',
          },
        }),
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });
  });

  it('switches active stock context for single-stock difference phrasing', async () => {
    render(
      <MemoryRouter initialEntries={['/chat?stock=600519&name=%E8%B2%B4%E5%B7%9E%E8%8C%85%E8%87%BA']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByDisplayValue('請深入分析 貴州茅臺(600519)')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '分析 AAPL 的差異化優勢' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: '分析 AAPL 的差異化優勢',
          context: {
            stock_code: 'AAPL',
            stock_name: null,
          },
        }),
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });
  });

  it('switches active stock context for lowercase US ticker switch messages', async () => {
    render(
      <MemoryRouter initialEntries={['/chat?stock=600519&name=%E8%B2%B4%E5%B7%9E%E8%8C%85%E8%87%BA']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByDisplayValue('請深入分析 貴州茅臺(600519)')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '分析tsla' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: '分析tsla',
          context: {
            stock_code: 'TSLA',
            stock_name: null,
          },
        }),
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });
  });

  it('keeps active stock context when clicking the current session', async () => {
    render(
      <MemoryRouter initialEntries={['/chat?stock=600519&name=%E8%B2%B4%E5%B7%9E%E8%8C%85%E8%87%BA']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByDisplayValue('請深入分析 貴州茅臺(600519)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '切換到對話 請簡要分析 600519' }));
    expect(mockSwitchSession).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '繼續看成交量' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: '繼續看成交量',
          context: {
            stock_code: '600519',
            stock_name: '貴州茅臺',
          },
        }),
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });
  });

  it('restores active stock context from loaded session messages', async () => {
    mockStoreState.messages = [
      { id: 'm-1', role: 'user', content: '請分析 600519' },
      { id: 'm-2', role: 'assistant', content: '600519 分析結果' },
      { id: 'm-3', role: 'user', content: '先不看 600519，換成 AAPL 看看' },
      { id: 'm-4', role: 'assistant', content: 'AAPL 分析結果' },
    ];

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByTestId('chat-workspace')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '繼續看支撐位' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: '繼續看支撐位',
          context: {
            stock_code: 'AAPL',
            stock_name: null,
          },
        }),
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });
  });

  it('clears active stock context when starting a new chat or switching sessions', async () => {
    mockStoreState.sessions = [
      ...mockStoreState.sessions,
      {
        session_id: 'session-2',
        title: '舊會話',
        message_count: 1,
        created_at: '2026-03-16T09:00:00Z',
        last_active: '2026-03-16T09:05:00Z',
      },
    ];

    const { unmount } = render(
      <MemoryRouter initialEntries={['/chat?stock=600519&name=%E8%B2%B4%E5%B7%9E%E8%8C%85%E8%87%BA']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByDisplayValue('請深入分析 貴州茅臺(600519)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '打開新對話' }));
    expect(mockStartNewChat).toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '繼續看成交量' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: '繼續看成交量',
          context: undefined,
        }),
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });

    unmount();
    mockStartStream.mockClear();

    render(
      <MemoryRouter initialEntries={['/chat?stock=600519&name=%E8%B2%B4%E5%B7%9E%E8%8C%85%E8%87%BA']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByDisplayValue('請深入分析 貴州茅臺(600519)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '切換到對話 舊會話' }));
    expect(mockSwitchSession).toHaveBeenCalledWith('session-2');

    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '繼續看成交量' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: '繼續看成交量',
          context: undefined,
        }),
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });
  });

  it('clears active stock context when deleting the current session', async () => {
    render(
      <MemoryRouter initialEntries={['/chat?stock=600519&name=%E8%B2%B4%E5%B7%9E%E8%8C%85%E8%87%BA']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByDisplayValue('請深入分析 貴州茅臺(600519)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '刪除對話 請簡要分析 600519' }));
    fireEvent.click(screen.getByRole('button', { name: '刪除' }));

    await waitFor(() => {
      expect(mockDeleteChatSession).toHaveBeenCalledWith('session-1');
    });
    expect(mockStartNewChat).toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '繼續看成交量' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: '繼續看成交量',
          context: undefined,
        }),
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });
  });

  it('ignores malformed follow-up query params', async () => {
    render(
      <MemoryRouter initialEntries={['/chat?stock=%3Cscript%3E&name=Bad%0AName&recordId=abc']}>
        <ChatPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: '問股' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/分析 600519/)).toHaveValue('');
    expect(historyApi.getDetail).not.toHaveBeenCalled();
  });

  it('reprocesses follow-up query params when navigating to the same chat route again', async () => {
    const firstDeferred = createDeferred<Awaited<ReturnType<typeof historyApi.getDetail>>>();
    const secondDeferred = createDeferred<Awaited<ReturnType<typeof historyApi.getDetail>>>();

    vi.mocked(historyApi.getDetail)
      .mockImplementationOnce(() => firstDeferred.promise)
      .mockImplementationOnce(() => secondDeferred.promise);

    const router = createMemoryRouter(
      [{ path: '/chat', element: <ChatPage /> }],
      {
        initialEntries: ['/chat?stock=600519&name=%E8%B2%B4%E5%B7%9E%E8%8C%85%E8%87%BA&recordId=1'],
      },
    );

    render(<RouterProvider router={router} />);

    expect(await screen.findByDisplayValue('請深入分析 貴州茅臺(600519)')).toBeInTheDocument();
    expect(screen.getByText('正在加載歷史分析上下文；現在可直接發送追問。')).toBeInTheDocument();

    await act(async () => {
      await router.navigate('/chat?stock=AAPL&name=Apple&recordId=2');
    });

    expect(await screen.findByDisplayValue('請深入分析 Apple(AAPL)')).toBeInTheDocument();

    firstDeferred.resolve({
      meta: {
        id: 1,
        queryId: 'q-1',
        stockCode: '600519',
        stockName: '貴州茅臺',
        reportType: 'detailed',
        createdAt: '2026-03-18T08:00:00Z',
        currentPrice: 1523.6,
        changePct: 1.8,
      },
      summary: {
        analysisSummary: '趨勢延續',
        operationAdvice: '繼續觀察',
        trendPrediction: '高位震盪',
        sentimentScore: 78,
      },
      strategy: {
        stopLoss: '1450',
      },
    });

    secondDeferred.resolve({
      meta: {
        id: 2,
        queryId: 'q-2',
        stockCode: 'AAPL',
        stockName: 'Apple',
        reportType: 'detailed',
        createdAt: '2026-03-18T09:00:00Z',
        currentPrice: 211.5,
        changePct: 2.4,
      },
      summary: {
        analysisSummary: '趨勢走強',
        operationAdvice: '繼續持有',
        trendPrediction: '短線偏強',
        sentimentScore: 81,
      },
      strategy: {
        stopLoss: '205',
      },
    });

    await waitFor(() => {
      expect(screen.queryByText('正在加載歷史分析上下文；現在可直接發送追問。')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalledWith(
        expect.objectContaining({
          message: '請深入分析 Apple(AAPL)',
          context: expect.objectContaining({
            stock_code: 'AAPL',
            stock_name: 'Apple',
            previous_price: 211.5,
            previous_change_pct: 2.4,
            previous_strategy: expect.objectContaining({
              stopLoss: '205',
            }),
          }),
        }),
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });
  });

  it.each([
    ['sh000016', 'sh000016'],
    ['csi930955', 'csi930955'],
    ['000016.SH', 'sh000016'],
  ] as const)('restores the %s follow-up URL to the registry canonical and hides the stock-only watchlist action', async (stockParam, expectedCanonical) => {
    render(
      <MemoryRouter initialEntries={[`/chat?stock=${stockParam}`]}>
        <ChatPage />
      </MemoryRouter>,
    );

    const expectedPrompt = `請深入分析 ${expectedCanonical}`;
    expect(await screen.findByDisplayValue(expectedPrompt)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: expectedPrompt,
          context: {
            stock_code: expectedCanonical,
            stock_name: null,
          },
        }),
        expect.any(Object),
      );
    });

    // The index canonical hides the stock-only watchlist action immediately.
    expect(screen.queryByText('加入自選')).not.toBeInTheDocument();
    expect(screen.queryByText('從自選刪除')).not.toBeInTheDocument();
  });

  it('defers a default-backend index follow-up until the registry settles', async () => {
    mockStockIndexState.index = [];
    mockStockIndexState.loading = true;
    mockStockIndexState.loaded = false;

    const { rerender } = render(
      <MemoryRouter initialEntries={['/chat?stock=sh000016']}>
        <ChatPage />
      </MemoryRouter>,
    );
    expect(screen.queryByDisplayValue(/请深入分析/)).not.toBeInTheDocument();

    mockStockIndexState.index = mockStockIndex;
    mockStockIndexState.loading = false;
    mockStockIndexState.loaded = true;
    rerender(
      <MemoryRouter initialEntries={['/chat?stock=sh000016']}>
        <ChatPage />
      </MemoryRouter>,
    );

    expect(await screen.findByDisplayValue('請深入分析 sh000016')).toBeInTheDocument();
  });

  type RegistrySettleRow = [
    string,
    { index: typeof mockStockIndexState.index; error: Error | null; fallback: boolean },
    string,
  ];

  it.each<RegistrySettleRow>([
    [
      'success settle with index data',
      { index: mockStockIndex, error: null, fallback: false },
      '請深入分析 sh000016',
    ],
    [
      'explicit load failure fail-open',
      { index: [], error: new Error('registry unavailable'), fallback: true },
      '請深入分析 SH000016',
    ],
    [
      'successful-empty registry fail-open',
      { index: [], error: null, fallback: false },
      '請深入分析 SH000016',
    ],
  ])(
    'releases the default-backend index follow-up after the shared registry settles: %s',
    async (_scenario, finalRegistry, expectedPrompt) => {
      mockStockIndexState.index = [];
      mockStockIndexState.loading = true;
      mockStockIndexState.error = null;
      mockStockIndexState.fallback = false;
      mockStockIndexState.loaded = false;

      const { rerender } = render(
        <MemoryRouter initialEntries={['/chat?stock=sh000016']}>
          <ChatPage />
        </MemoryRouter>,
      );

      await waitFor(() => {
        expect(screen.queryByDisplayValue(/请深入分析 (SH000016|sh000016)/)).not.toBeInTheDocument();
      });

      // Settle regardless of outcome: success consumes the registry canonical;
      // failure and an empty registry fail open to the stock path.
      mockStockIndexState.index = finalRegistry.index;
      mockStockIndexState.loading = false;
      mockStockIndexState.error = finalRegistry.error;
      mockStockIndexState.fallback = finalRegistry.fallback;
      mockStockIndexState.loaded = true;
      rerender(
        <MemoryRouter initialEntries={['/chat?stock=sh000016']}>
          <ChatPage />
        </MemoryRouter>,
      );

      expect(await screen.findByDisplayValue(expectedPrompt)).toBeInTheDocument();
    },
  );

  it('restores the active Codex index canonical from a loaded session message and hides the stock-only watchlist action', async () => {
    mockGetStatus.mockResolvedValueOnce({
      backend: 'codex_app_server',
      available: true,
      experimental: true,
      errorCode: null,
      message: null,
    });
    // Registry already settled with index data before the session loads — the
    // approved message-restore path must resolve the explicit SH index
    // canonical so the follow-up context and watchlist gating stay consistent.
    mockStockIndexState.index = mockStockIndex;
    mockStockIndexState.loading = false;
    mockStockIndexState.error = null;
    mockStockIndexState.fallback = false;
    mockStockIndexState.loaded = true;
    mockStoreState.messages = [
      { id: 'm-1', role: 'user', content: '分析 sh000016' },
      { id: 'm-2', role: 'assistant', content: '上證50 分析結果', skillName: '指數分析' },
    ];

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('chat-workspace')).toBeInTheDocument();

    // Restored canonical keeps the lowercase index identity → the stock-only
    // watchlist button is hidden, exactly like a direct index follow-up.
    expect(screen.queryByText('加入自選')).not.toBeInTheDocument();
    expect(screen.queryByText('從自選刪除')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/分析 600519/), {
      target: { value: '繼續看上證50的支撐位' },
    });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: '繼續看上證50的支撐位',
          context: {
            stock_code: 'sh000016',
            stock_name: null,
          },
        }),
        // The send meta uses the session's default skill, not the historical
        // assistant message's skill label.
        expect.objectContaining({
          skillName: '趨勢分析',
        }),
      );
    });
  });

  it('defers default-backend history restoration until the registry settles', async () => {
    mockStockIndexState.index = [];
    mockStockIndexState.loading = true;
    mockStockIndexState.loaded = false;
    mockStoreState.messages = [
      { id: 'm-1', role: 'user', content: '分析 sh000016' },
      { id: 'm-2', role: 'assistant', content: '上證50 分析結果', skillName: '指數分析' },
    ];

    const { rerender } = render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('button', { name: '處理中...' })).toBeDisabled();

    mockStockIndexState.index = mockStockIndex;
    mockStockIndexState.loading = false;
    mockStockIndexState.loaded = true;
    rerender(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>,
    );

    const input = screen.getByPlaceholderText(/分析 600519/);
    fireEvent.change(input, { target: { value: '繼續看支撐位' } });
    fireEvent.click(screen.getByRole('button', { name: '發送' }));
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          context: { stock_code: 'sh000016', stock_name: null },
        }),
        expect.any(Object),
      );
    });
  });

  it('shows a jump-to-latest action when new content arrives while the user is away from bottom', async () => {
    mockStoreState.messages = [
      { id: 'user-1', role: 'user', content: '請分析 600519' },
      { id: 'assistant-1', role: 'assistant', content: '趨勢偏強', skillName: '趨勢分析' },
    ];

    const { rerender } = render(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    const viewport = await screen.findByTestId('chat-message-scroll');
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, value: 0 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1200 });

    fireEvent.scroll(viewport);

    mockStoreState.messages = [
      ...mockStoreState.messages,
      { id: 'assistant-2', role: 'assistant', content: '新的補充分析', skillName: '趨勢分析' },
    ];

    rerender(
      <MemoryRouter initialEntries={['/chat']}>
        <ChatPage />
      </MemoryRouter>
    );

    const jumpButton = await screen.findByRole('button', { name: '查看最新消息' });
    expect(jumpButton).toBeInTheDocument();

    fireEvent.click(jumpButton);

    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });
});

describe('extractStockCodeFromMessage', () => {
  it('returns 6-digit A-share code', () => {
    expect(extractStockCodeFromMessage('分析 600519 趨勢')).toBe('600519');
    expect(extractStockCodeFromMessage('002460')).toBe('002460');
  });

  it('returns HK prefixed code (normalized)', () => {
    expect(extractStockCodeFromMessage('分析 hk00700')).toBe('HK00700');
  });

  it('returns .HK suffix code (normalized to canonical)', () => {
    expect(extractStockCodeFromMessage('00700.HK')).toBe('HK00700');
    expect(extractStockCodeFromMessage('1810.HK')).toBe('HK01810');
  });

  it('returns code with .SH/.SZ suffix (normalized)', () => {
    expect(extractStockCodeFromMessage('看 600519.SH')).toBe('600519');
    expect(extractStockCodeFromMessage('000001.SZ')).toBe('000001');
  });

  it('returns US ticker like AAPL', () => {
    expect(extractStockCodeFromMessage('分析 AAPL 走勢')).toBe('AAPL');
    expect(extractStockCodeFromMessage('TSLA')).toBe('TSLA');
    expect(extractStockCodeFromMessage('分析 BRK.B')).toBe('BRK.B');
  });

  it('does NOT return finance abbreviations as tickers', () => {
    expect(extractStockCodeFromMessage('如果不考慮 TTM 呢')).toBeNull();
    expect(extractStockCodeFromMessage('市盈率 TTM 怎麼看')).toBeNull();
    expect(extractStockCodeFromMessage('PE 怎麼看')).toBeNull();
    expect(extractStockCodeFromMessage('MACD 還沒金叉嗎')).toBeNull();
    expect(extractStockCodeFromMessage('RSI 怎麼看')).toBeNull();
    expect(extractStockCodeFromMessage('WHAT IS PE')).toBeNull();
    expect(extractStockCodeFromMessage('PE IS HIGH')).toBeNull();
    expect(extractStockCodeFromMessage('WHAT IS TTM')).toBeNull();
  });

  it('does NOT return contextual moving-average MA as a ticker', () => {
    expect(extractStockCodeFromMessage('分析 MA 均線')).toBeNull();
    expect(extractStockCodeFromMessage('看看 MA 怎麼排列')).toBeNull();
    expect(extractStockCodesFromMessage('MA 和 RSI 的指針怎麼看')).toEqual([]);
    expect(extractStockCodeFromMessage('分析 KDJ 指針')).toBeNull();
    expect(extractStockCodeFromMessage('KDJ 怎麼看')).toBeNull();
  });

  it('skips finance abbreviations before a real ticker', () => {
    expect(extractStockCodeFromMessage('PE AAPL 怎麼看')).toBe('AAPL');
    expect(extractStockCodeFromMessage('TTM AAPL 怎麼看')).toBe('AAPL');
    expect(extractStockCodeFromMessage('MACD AAPL 怎麼看')).toBe('AAPL');
    expect(extractStockCodeFromMessage('WHAT IS PE AAPL')).toBe('AAPL');
  });

  it('does NOT return exchange prefixes as tickers', () => {
    expect(extractStockCodeFromMessage('分析 SH 走勢')).toBeNull();
    expect(extractStockCodeFromMessage('看看 BJ')).toBeNull();
    expect(extractStockCodeFromMessage('HK')).toBeNull();
    expect(extractStockCodeFromMessage('買入 SZ')).toBeNull();
    expect(extractStockCodeFromMessage('US 市場')).toBeNull();
    expect(extractStockCodeFromMessage('SS')).toBeNull();
  });

  it('returns null for messages without stock codes', () => {
    expect(extractStockCodeFromMessage('茅臺現在適合買入嗎')).toBeNull();
    expect(extractStockCodeFromMessage('大盤走勢如何')).toBeNull();
  });

  it('matches prefixed code like SH600519 (normalized)', () => {
    expect(extractStockCodeFromMessage('分析 SH600519')).toBe('600519');
  });

  it('returns SZ-prefixed code when standalone (normalized)', () => {
    expect(extractStockCodeFromMessage('SZ000001')).toBe('000001');
  });

  it('returns all stock codes in message order', () => {
    expect(extractStockCodesFromMessage('分析 600519 和 AAPL 的差異')).toEqual(['600519', 'AAPL']);
    expect(extractStockCodesFromMessage('分析 AAPL 和 600519 的差異')).toEqual(['AAPL', '600519']);
    expect(extractStockCodesFromMessage('AAPL 和 TSLA 哪個更值得買')).toEqual(['AAPL', 'TSLA']);
    expect(extractStockCodesFromMessage('比較 BRK.B 和 AAPL')).toEqual(['BRK.B', 'AAPL']);
  });

  it('extracts lowercase tickers only with explicit stock intent hints', () => {
    expect(extractStockCodesFromMessage('分析tsla')).toEqual(['TSLA']);
    expect(extractStockCodesFromMessage('看看 tsla')).toEqual(['TSLA']);
    expect(extractStockCodesFromMessage('aapl 和 tsla 哪個更值得買')).toEqual(['AAPL', 'TSLA']);
    expect(extractStockCodesFromMessage('hello tsla')).toEqual([]);
  });

  it('returns all HK and A-share variants without exchange affix tokens', () => {
    expect(extractStockCodesFromMessage('比較 01810 和 AAPL')).toEqual(['HK01810', 'AAPL']);
    expect(extractStockCodesFromMessage('比較 1810.HK 和 AAPL')).toEqual(['HK01810', 'AAPL']);
    expect(extractStockCodesFromMessage('比較 600519.SH 和 AAPL')).toEqual(['600519', 'AAPL']);
    expect(extractStockCodesFromMessage('比較 000001.SZ 和 SS')).toEqual(['000001']);
    expect(extractStockCodesFromMessage('比較 SH600519 和 AAPL')).toEqual(['600519', 'AAPL']);
    expect(extractStockCodesFromMessage('比較 SZ000001 和 AAPL')).toEqual(['000001', 'AAPL']);
    expect(extractStockCodesFromMessage('比較 BJ920748 和 AAPL')).toEqual(['920748', 'AAPL']);
    expect(extractStockCodesFromMessage('比較 HK01810 和 AAPL')).toEqual(['HK01810', 'AAPL']);
  });

  it('does not return denied abbreviations in multi-code extraction', () => {
    expect(extractStockCodesFromMessage('如果不考慮 TTM 和 PE')).toEqual([]);
    expect(extractStockCodesFromMessage('MACD AAPL 和 RSI')).toEqual(['AAPL']);
    expect(extractStockCodesFromMessage('KDJ AAPL 怎麼看')).toEqual(['AAPL']);
  });
});

describe('extractStockCodesFromMessage with index registry', () => {
  // The hoisted mock widens market/assetType to plain strings; the extraction
  // parameter is StockIndexItem[], so a structural cast keeps the registry rows.
  const registeredIndex = mockStockIndex as unknown as StockIndexItem[];

  it('resolves explicit SH-prefixed index tokens to the registry canonical only', () => {
    expect(extractStockCodesFromMessage('分析 sh000016', registeredIndex)).toEqual(['sh000016']);
    expect(extractStockCodesFromMessage('分析 SH000016', registeredIndex)).toEqual(['sh000016']);
  });

  it('resolves dotted SH index aliases without leaking the inner bare digits', () => {
    expect(extractStockCodesFromMessage('分析 000016.SH', registeredIndex)).toEqual(['sh000016']);
    expect(extractStockCodesFromMessage('分析 000016.sh', registeredIndex)).toEqual(['sh000016']);
  });

  it('resolves CSI display and prefix forms to the single csi canonical', () => {
    expect(extractStockCodesFromMessage('分析 930955.CSI', registeredIndex)).toEqual(['csi930955']);
    expect(extractStockCodesFromMessage('分析 CSI930955', registeredIndex)).toEqual(['csi930955']);
    expect(extractStockCodesFromMessage('分析 csi930955', registeredIndex)).toEqual(['csi930955']);
  });

  it('resolves a registered SZ index code via its registry canonical', () => {
    expect(extractStockCodesFromMessage('分析 sz399001', registeredIndex)).toEqual(['sz399001']);
  });

  it('keeps the bare same-code stock distinct from a registered index', () => {
    expect(extractStockCodesFromMessage('分析 000016', registeredIndex)).toEqual(['000016']);
    expect(extractStockCodesFromMessage('SH000016 和 000016', registeredIndex)).toEqual(['sh000016', '000016']);
    expect(extractStockCodesFromMessage('000016 和 sh000016', registeredIndex)).toEqual(['000016', 'sh000016']);
  });

  it('keeps stock semantics for unregistered explicit forms when the registry is loaded', () => {
    expect(extractStockCodesFromMessage('分析 sh600519', registeredIndex)).toEqual(['600519']);
    expect(extractStockCodesFromMessage('分析 SZ000001', registeredIndex)).toEqual(['000001']);
  });

  it('fails open to the stock path when no registry is passed', () => {
    expect(extractStockCodesFromMessage('分析 sh000016')).toEqual(['000016']);
  });

  it('keeps the legacy no-registry baseline for dotted index forms without leaking the suffix token', () => {
    // Without a registry, `930955.CSI` must behave EXACTLY as before this
    // change: the dotted form is NOT a registered index hit, so only the bare
    // digits surface (the `.CSI` suffix never leaks as a separate token).
    expect(extractStockCodesFromMessage('分析 930955.CSI')).toEqual(['930955']);
  });

  it('keeps the legacy baseline for csi-prefixed forms without a registry (no output)', () => {
    expect(extractStockCodesFromMessage('CSI930955')).toEqual([]);
    expect(extractStockCodesFromMessage('csi930955')).toEqual([]);
  });

  it('keeps SH/SZ stock alias normalization unchanged when the registry miss falls through', () => {
    expect(extractStockCodesFromMessage('分析 000016.SH')).toEqual(['000016']);
    expect(extractStockCodesFromMessage('分析 SH600519')).toEqual(['600519']);
  });

  it('does NOT surface the whole dotted form for an UNREGISTERED index even when the registry is loaded', () => {
    // The shared mock registry DOES contain the `930955.CSI` alias (csi930955),
    // so build a registry WITHOUT it to exercise the genuinely unregistered
    // case: it must fall through to the legacy bare-digit behavior, not emit
    // the whole token nor suppress the legacy patterns.
    const registryWithoutCsi = mockStockIndex.filter(
      (item) => item.canonicalCode !== 'csi930955',
    ) as StockIndexItem[];
    expect(extractStockCodesFromMessage('分析 930955.CSI', registryWithoutCsi)).toEqual(['930955']);
  });
});

describe('watchlist button with code variants', () => {
  it('shows "從自選刪除" when canonical code is in watchlist and user inputs variant', async () => {
    mockGetWatchlist.mockResolvedValue(['600519', 'HK01810']);

    render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>,
    );

    const textarea = await screen.findByPlaceholderText(/例如/);
    fireEvent.change(textarea, { target: { value: '分析 600519.SH' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(await screen.findByText('從自選刪除')).toBeInTheDocument();
  });

  it('shows "從自選刪除" for HK variant codes', async () => {
    mockGetWatchlist.mockResolvedValue(['HK01810']);

    render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>,
    );

    const textarea = await screen.findByPlaceholderText(/例如/);
    fireEvent.change(textarea, { target: { value: '分析 1810.HK' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(await screen.findByText('從自選刪除')).toBeInTheDocument();
  });

  it('matches raw HK watchlist entries before rendering the watchlist action', async () => {
    mockGetWatchlist.mockResolvedValue(['01810']);

    render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>,
    );

    const textarea = await screen.findByPlaceholderText(/例如/);
    fireEvent.change(textarea, { target: { value: '分析 1810.HK' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(await screen.findByText('從自選刪除')).toBeInTheDocument();
  });

  it('removes the matched raw HK watchlist entry instead of adding a duplicate variant', async () => {
    mockGetWatchlist.mockResolvedValue(['00700']);
    mockRemoveFromWatchlist.mockResolvedValue([]);

    render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>,
    );

    const textarea = await screen.findByPlaceholderText(/例如/);
    fireEvent.change(textarea, { target: { value: '分析 00700.HK' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    fireEvent.click(await screen.findByText('從自選刪除'));

    await waitFor(() => {
      expect(mockRemoveFromWatchlist).toHaveBeenCalledWith('00700');
    });
    expect(mockAddToWatchlist).not.toHaveBeenCalled();
  });
});

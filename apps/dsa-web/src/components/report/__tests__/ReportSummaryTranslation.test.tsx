import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportSummary } from '../ReportSummary';
import { historyApi } from '../../../api/history';
import { UiLanguageProvider } from '../../../contexts/UiLanguageContext';
import { UI_LANGUAGE_STORAGE_KEY } from '../../../utils/uiLanguage';
import type { AnalysisReport } from '../../../types/analysis';

vi.mock('../../../api/history', () => ({
  historyApi: {
    getNews: vi.fn().mockResolvedValue({ total: 0, items: [] }),
    getDiagnostics: vi.fn().mockResolvedValue(null),
    getTranslation: vi.fn(),
  },
}));

const baseReport: AnalysisReport = {
  meta: {
    id: 42,
    queryId: 'q-42',
    stockCode: '600519',
    stockName: '贵州茅台',
    reportType: 'detailed',
    reportLanguage: 'zh',
    createdAt: '2026-03-21T08:00:00Z',
  },
  summary: {
    analysisSummary: '基本面稳健，短期震荡',
    operationAdvice: '持有',
    trendPrediction: '短线震荡偏强',
    sentimentScore: 78,
  },
  strategy: {
    idealBuy: '理想买入点：125.5元',
    secondaryBuy: '120',
    stopLoss: '止损位：110元',
    takeProfit: '目标位：150.0元',
  },
};

const translatedPayload = {
  cached: false,
  targetLang: 'en' as const,
  summary: {
    analysisSummary: 'Fundamentals stay solid; consolidating in the short term.',
    operationAdvice: 'Hold',
    trendPrediction: 'Short-term range with a bullish bias',
  },
  strategy: {
    idealBuy: 'Ideal entry: 125.5 CNY',
    secondaryBuy: '120',
    stopLoss: 'Stop below 110 CNY',
    takeProfit: 'Target: 150.0 CNY',
  },
  markdown: null,
};

const renderReport = (ui: React.ReactNode, language: 'zh' | 'en') => {
  window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, language);
  return render(<UiLanguageProvider>{ui}</UiLanguageProvider>);
};

// useReportTranslation 按会话缓存（语言 + 记录 ID），每个用例使用独立记录 ID 避免串扰
let nextRecordId = 100;
const nextId = () => nextRecordId++;

describe('ReportSummary translation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(historyApi.getNews).mockResolvedValue({ total: 0, items: [] });
    vi.mocked(historyApi.getDiagnostics).mockResolvedValue({
      status: 'unknown',
      statusLabel: '',
      reason: '',
      components: {},
      copyText: '',
    });
  });

  it('prefers translated report content when the UI language is English', async () => {
    vi.mocked(historyApi.getTranslation).mockResolvedValue(translatedPayload);

    renderReport(<ReportSummary data={{ ...baseReport, meta: { ...baseReport.meta, id: nextId() } }} isHistory />, 'en');

    // 翻译返回后，正文替换为英文
    await waitFor(() => {
      expect(historyApi.getTranslation).toHaveBeenCalledWith(expect.any(Number), 'en');
    });
    expect(await screen.findByText('Short-term range with a bullish bias')).toBeVisible();
    expect(screen.getByText('Fundamentals stay solid; consolidating in the short term.')).toBeVisible();
    expect(screen.getByText('Ideal entry: 125.5 CNY')).toBeVisible();
    expect(screen.getByText('Stop below 110 CNY')).toBeVisible();
    // 原始中文正文不再展示
    expect(screen.queryByText('短线震荡偏强')).not.toBeInTheDocument();
    // 股票名称等数据字段保持原样
    expect(screen.getByText('贵州茅台')).toBeVisible();
  });

  it('falls back to the original content while translation is loading', async () => {
    vi.mocked(historyApi.getTranslation).mockReturnValue(new Promise(() => undefined));

    renderReport(<ReportSummary data={{ ...baseReport, meta: { ...baseReport.meta, id: nextId() } }} isHistory />, 'en');

    expect(screen.getByText('短线震荡偏强')).toBeVisible();
    expect(screen.getByText('理想买入点：125.5元')).toBeVisible();
    await waitFor(() => {
      expect(historyApi.getTranslation).toHaveBeenCalled();
    });
  });

  it('falls back to the original content when translation fails', async () => {
    vi.mocked(historyApi.getTranslation).mockRejectedValue(new Error('translation unavailable'));

    renderReport(<ReportSummary data={{ ...baseReport, meta: { ...baseReport.meta, id: nextId() } }} isHistory />, 'en');

    await waitFor(() => {
      expect(historyApi.getTranslation).toHaveBeenCalled();
    });
    expect(screen.getByText('短线震荡偏强')).toBeVisible();
    expect(screen.getByText('基本面稳健，短期震荡')).toBeVisible();
  });

  it('does not fetch a translation when the UI language is Chinese', async () => {
    renderReport(<ReportSummary data={{ ...baseReport, meta: { ...baseReport.meta, id: nextId() } }} isHistory />, 'zh');

    expect(screen.getByText('短线震荡偏强')).toBeVisible();

    await waitFor(() => {
      expect(historyApi.getNews).toHaveBeenCalled();
    });
    expect(historyApi.getTranslation).not.toHaveBeenCalled();
  });
});

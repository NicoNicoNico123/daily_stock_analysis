import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stocksApi } from '../../../api/stocks';
import { PriceChartPanel } from '../PriceChartPanel';

vi.mock('../../../api/stocks', () => ({
  stocksApi: {
    getDailyKline: vi.fn(),
  },
}));

const renderPanel = (props?: Partial<Parameters<typeof PriceChartPanel>[0]>) =>
  render(
    <PriceChartPanel
      code="600519"
      levels={{ idealBuy: '1720.00', secondaryBuy: null, stopLoss: '1650.50', takeProfit: '1900' }}
      trendPrediction="短期震盪上行，中線看多"
      {...props}
    />,
  );

describe('PriceChartPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('renders nothing without a stock code', () => {
    const { container } = renderPanel({ code: null });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the empty state when no kline points are returned', async () => {
    vi.mocked(stocksApi.getDailyKline).mockResolvedValue({ code: '600519', points: [] });

    renderPanel();

    expect(await screen.findByText('暫無日 K 數據')).toBeInTheDocument();
    expect(stocksApi.getDailyKline).toHaveBeenCalledWith('600519', 120);
  });

  it('renders level chips and the chart area when data resolves', async () => {
    vi.mocked(stocksApi.getDailyKline).mockResolvedValue({
      code: '600519',
      points: [
        { date: '2026-02-02', open: 10, high: 11, low: 9.5, close: 10.4, volume: 1000 },
        { date: '2026-02-03', open: 10.4, high: 11.2, low: 10.1, close: 11, volume: 1200 },
      ],
    });

    renderPanel();

    expect(await screen.findByText('理想買入')).toBeInTheDocument();
    expect(screen.getByText('1720.00')).toBeInTheDocument();
    // 二次買入为空：不渲染该点位的数值
    expect(screen.queryByText('二次買入1750.00')).not.toBeInTheDocument();
    // 走勢預測示意与图表区域（或渲染失败时的降级摘要）必须出现
    expect(screen.getByText('走勢預測示意')).toBeInTheDocument();
    await screen.findByRole('img', { name: 'K 線圖' });
  });

  it('renders the error state and retries', async () => {
    vi.mocked(stocksApi.getDailyKline)
      .mockRejectedValueOnce(new Error('network failed'))
      .mockResolvedValueOnce({ code: '600519', points: [] });

    renderPanel();

    expect(await screen.findByRole('alert')).toBeInTheDocument();

    // 面板头部与错误提示各有一个重试入口，点击其中任意一个均可重发请求
    const retryButtons = screen.getAllByRole('button', { name: '重試' });
    expect(retryButtons.length).toBeGreaterThan(0);
    fireEvent.click(retryButtons[0]);

    expect(await screen.findByText('暫無日 K 數據')).toBeInTheDocument();
    expect(stocksApi.getDailyKline).toHaveBeenCalledTimes(2);
  });
});

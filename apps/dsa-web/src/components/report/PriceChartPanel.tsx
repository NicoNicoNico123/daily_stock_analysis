import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import type { ParsedApiError } from '../../api/error';
import { getParsedApiError } from '../../api/error';
import { stocksApi, type DailyKlinePoint } from '../../api/stocks';
import { ApiErrorAlert, Card } from '../common';
import { DashboardPanelHeader, DashboardStateBlock } from '../dashboard';
import { useUiLanguage } from '../../contexts/UiLanguageContext';
import {
  buildCandlesticks,
  buildForecastCone,
  buildLevelLines,
  buildVolumeHistogram,
  isUpwardBias,
  parseLevels,
  type CandlestickDatum,
  type LineDatum,
  type PriceLevelLine,
} from '../../utils/priceChart';

/** 策略点位：报告详情中的结构化字段（后端以字符串落库，数值或字符串均可解析） */
export interface PriceChartLevelValues {
  idealBuy?: number | string | null;
  secondaryBuy?: number | string | null;
  stopLoss?: number | string | null;
  takeProfit?: number | string | null;
}

interface PriceChartPanelProps {
  /** 股票代码（报告 meta.stockCode） */
  code?: string | null;
  /** 策略点位结构化数值，来自历史报告详情的 strategy 字段 */
  levels?: PriceChartLevelValues | null;
  /** 趋势预测文本（仅用于预测锥的视觉倾向） */
  trendPrediction?: string | null;
  /** 日线天数（默认 120） */
  days?: number;
}

/** 主题感知的图表配色（全部来自 CSS tokens，带兜底色） */
interface ChartPalette {
  up: string;
  down: string;
  text: string;
  grid: string;
  border: string;
  levels: Record<PriceLevelLine['key'], string>;
  bull: string;
  bear: string;
}

/** CSS token 不可用时的兜底色（深色 / 浅色各一套） */
const FALLBACK_COLORS: Record<'dark' | 'light', Omit<ChartPalette, 'levels' | 'bull' | 'bear'> & Record<PriceLevelLine['key'], string>> = {
  dark: {
    up: '#ef4444',
    down: '#22c55e',
    text: '#94a3b8',
    grid: 'rgba(148, 163, 184, 0.16)',
    border: 'rgba(148, 163, 184, 0.3)',
    idealBuy: '#22c55e',
    secondaryBuy: '#06b6d4',
    stopLoss: '#f43f5e',
    takeProfit: '#eab308',
  },
  light: {
    up: '#dc2626',
    down: '#16a34a',
    text: '#475569',
    grid: 'rgba(100, 116, 139, 0.18)',
    border: 'rgba(100, 116, 139, 0.32)',
    idealBuy: '#16a34a',
    secondaryBuy: '#0891b2',
    stopLoss: '#e11d48',
    takeProfit: '#ca8a04',
  },
};

const readCssVar = (element: HTMLElement, name: string, fallback: string): string => {
  const value = window.getComputedStyle(element).getPropertyValue(name).trim();
  return value || fallback;
};

const buildPalette = (container: HTMLElement, theme: 'dark' | 'light'): ChartPalette => {
  const fallback = FALLBACK_COLORS[theme];
  const levels: Record<PriceLevelLine['key'], string> = {
    idealBuy: readCssVar(container, '--home-strategy-buy', fallback.idealBuy),
    secondaryBuy: readCssVar(container, '--home-strategy-secondary', fallback.secondaryBuy),
    stopLoss: readCssVar(container, '--home-strategy-stop', fallback.stopLoss),
    takeProfit: readCssVar(container, '--home-strategy-take', fallback.takeProfit),
  };

  return {
    // 本项目沿用 A 股配色习惯：--home-price-up 为涨、--home-price-down 为跌，
    // 与报告页其它价格数字的颜色语义保持一致。
    up: readCssVar(container, '--home-price-up', fallback.up),
    down: readCssVar(container, '--home-price-down', fallback.down),
    text: readCssVar(container, '--text-secondary-text', fallback.text),
    grid: readCssVar(container, '--border-subtle', fallback.grid),
    border: readCssVar(container, '--border-default', fallback.border),
    levels,
    bull: levels.idealBuy,
    bear: levels.stopLoss,
  };
};

const EMPTY_CONE: { bull: LineDatum[]; bear: LineDatum[] } = { bull: [], bear: [] };

interface LevelChipProps {
  label: string;
  colorVar: string;
  value: number | null;
}

const LevelChip: React.FC<LevelChipProps> = ({ label, colorVar, value }) => (
  <span className="home-accent-chip inline-flex items-center gap-1.5 px-2 py-0.5 text-xs text-muted-text">
    <span
      aria-hidden="true"
      className="h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: `var(${colorVar})`, boxShadow: `0 0 8px var(${colorVar})` }}
    />
    {label}
    {value !== null ? <span className="font-mono">{value.toFixed(2)}</span> : null}
  </span>
);

/**
 * 报告页 K 线图面板（lightweight-charts v5）。
 *
 * 图表库按需异步加载：加载或渲染失败时降级为最近收盘价摘要，
 * 任何图表异常都不会影响报告页其它区块。
 */
export const PriceChartPanel: React.FC<PriceChartPanelProps> = ({
  code,
  levels,
  trendPrediction,
  days = 120,
}) => {
  const { t } = useUiLanguage();
  const { resolvedTheme } = useTheme();

  const [points, setPoints] = useState<DailyKlinePoint[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<ParsedApiError | null>(null);
  const [renderFailed, setRenderFailed] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);

  const fetchKline = useCallback(async () => {
    if (!code) return;
    setIsLoading(true);
    setError(null);
    setRenderFailed(false);

    try {
      const response = await stocksApi.getDailyKline(code, days);
      setPoints(response.points || []);
    } catch (err) {
      setError(getParsedApiError(err));
    } finally {
      setIsLoading(false);
    }
  }, [code, days]);

  useEffect(() => {
    setPoints([]);
    setError(null);
    setRenderFailed(false);

    if (code) {
      void fetchKline();
    }
  }, [code, fetchKline]);

  const parsedLevels = useMemo(() => parseLevels(levels ?? {}), [levels]);
  const candles = useMemo<CandlestickDatum[]>(() => buildCandlesticks(points), [points]);
  const levelLines = useMemo<PriceLevelLine[]>(() => buildLevelLines(parsedLevels), [parsedLevels]);
  const upwardBias = useMemo(() => isUpwardBias(trendPrediction), [trendPrediction]);
  const cone = useMemo(() => {
    const last = candles[candles.length - 1];
    if (!last) {
      return EMPTY_CONE;
    }
    return buildForecastCone({
      lastDate: last.time,
      lastClose: last.close,
      takeProfit: parsedLevels.takeProfit,
      stopLoss: parsedLevels.stopLoss,
      upwardBias,
    });
  }, [candles, parsedLevels.stopLoss, parsedLevels.takeProfit, upwardBias]);

  const hasData = candles.length > 0;
  const theme = resolvedTheme === 'light' ? 'light' : 'dark';

  // 图表渲染：异步加载 lightweight-charts，所有副作用在 try/catch 内兜底；
  // 依赖中的 theme 用于主题切换时重建图表以同步 CSS token 配色。
  useEffect(() => {
    if (!hasData || renderFailed) {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let cancelled = false;
    let teardown: (() => void) | null = null;

    const run = async () => {
      try {
        const {
          createChart,
          CandlestickSeries,
          CrosshairMode,
          HistogramSeries,
          LineSeries,
          LineStyle,
          ColorType,
          createSeriesMarkers,
        } = await import('lightweight-charts');
        if (cancelled || !containerRef.current) {
          return;
        }

        const palette = buildPalette(containerRef.current, theme);

        const chart = createChart(container, {
          width: container.clientWidth || undefined,
          height: 360,
          layout: {
            background: { type: ColorType.Solid, color: 'transparent' },
            textColor: palette.text,
            attributionLogo: false,
          },
          grid: {
            vertLines: { color: palette.grid },
            horzLines: { color: palette.grid },
          },
          rightPriceScale: { borderColor: palette.border },
          timeScale: { borderColor: palette.border, rightOffset: 3, barSpacing: 6 },
          crosshair: { mode: CrosshairMode.Normal },
        });
        if (cancelled) {
          // 依赖已在异步加载期间变化（如快速切换报告）：立即释放，避免残留画布
          chart.remove();
          return;
        }

        const candleSeries = chart.addSeries(CandlestickSeries, {
          upColor: palette.up,
          downColor: palette.down,
          borderUpColor: palette.up,
          borderDownColor: palette.down,
          wickUpColor: palette.up,
          wickDownColor: palette.down,
        });
        candleSeries.setData(candles);

        // 成交量：独立 overlay 价格刻度，压缩在图表底部 18%
        const volumeSeries = chart.addSeries(HistogramSeries, {
          priceFormat: { type: 'volume' },
          priceScaleId: 'volume',
          priceLineVisible: false,
          lastValueVisible: false,
        });
        volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        volumeSeries.setData(
          buildVolumeHistogram(points, { up: palette.up, down: palette.down }),
        );

        // 策略点位线：仅绘制非空点位，标题跟随界面语言
        const levelTitles: Record<PriceLevelLine['key'], string> = {
          idealBuy: t('report.priceChartLevelBuy'),
          secondaryBuy: t('report.priceChartLevelSecondary'),
          stopLoss: t('report.priceChartLevelStop'),
          takeProfit: t('report.priceChartLevelTakeProfit'),
        };
        levelLines.forEach((line) => {
          candleSeries.createPriceLine({
            price: line.price,
            color: palette.levels[line.key],
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: levelTitles[line.key],
          });
        });

        // 走勢預測示意：从最后一根收盘价出发的乐观 / 悲观路径（预测锥）
        const forecastOptions = {
          lineWidth: 1 as const,
          lineStyle: LineStyle.LargeDashed,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        };
        if (cone.bull.length > 0) {
          chart
            .addSeries(LineSeries, { ...forecastOptions, color: palette.bull })
            .setData(cone.bull);
        }
        if (cone.bear.length > 0) {
          chart
            .addSeries(LineSeries, { ...forecastOptions, color: palette.bear })
            .setData(cone.bear);
        }

        // 分析日标记（最后一根 K 线）
        const last = candles[candles.length - 1];
        const markers = createSeriesMarkers(candleSeries, [
          {
            time: last.time,
            position: 'belowBar',
            shape: 'circle',
            color: palette.text,
            text: t('report.priceChartAnalysisDate'),
            size: 1,
          },
        ]);

        chart.timeScale().fitContent();

        const resizeObserver = new ResizeObserver((entries) => {
          const width = entries[0]?.contentRect.width;
          if (typeof width === 'number' && width > 0) {
            chart.applyOptions({ width: Math.floor(width) });
          }
        });
        resizeObserver.observe(container);

        teardown = () => {
          resizeObserver.disconnect();
          markers.detach();
          chart.remove();
        };
      } catch (err) {
        if (!cancelled) {
          console.error('[PriceChartPanel] chart render failed', err);
          setRenderFailed(true);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
      teardown?.();
      teardown = null;
    };
  }, [candles, cone, hasData, levelLines, points, renderFailed, t, theme]);

  if (!code) {
    return null;
  }

  const levelChips: Array<{
    key: PriceLevelLine['key'];
    label: string;
    colorVar: string;
    value: number | null;
  }> = [
    {
      key: 'idealBuy',
      label: t('report.priceChartLevelBuy'),
      colorVar: '--home-strategy-buy',
      value: parsedLevels.idealBuy,
    },
    {
      key: 'secondaryBuy',
      label: t('report.priceChartLevelSecondary'),
      colorVar: '--home-strategy-secondary',
      value: parsedLevels.secondaryBuy,
    },
    {
      key: 'stopLoss',
      label: t('report.priceChartLevelStop'),
      colorVar: '--home-strategy-stop',
      value: parsedLevels.stopLoss,
    },
    {
      key: 'takeProfit',
      label: t('report.priceChartLevelTakeProfit'),
      colorVar: '--home-strategy-take',
      value: parsedLevels.takeProfit,
    },
  ];

  return (
    <Card variant="bordered" padding="md" className="home-panel-card">
      <DashboardPanelHeader
        eyebrow={t('report.priceChartTitle')}
        title={t('report.priceChartRange', { days })}
        actions={(
          <div className="flex items-center gap-2">
            {isLoading ? (
              <div className="home-spinner h-3.5 w-3.5 animate-spin border-2" aria-hidden="true" />
            ) : null}
            <button
              type="button"
              onClick={() => void fetchKline()}
              className="home-accent-link text-xs"
            >
              {t('common.retry')}
            </button>
          </div>
        )}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {levelChips.map((chip) => (
          <LevelChip key={chip.key} label={chip.label} colorVar={chip.colorVar} value={chip.value} />
        ))}
        <span className="home-accent-chip inline-flex items-center gap-1.5 px-2 py-0.5 text-xs text-muted-text">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: 'var(--home-strategy-take)', boxShadow: '0 0 8px var(--home-strategy-take)' }}
          />
          {t('report.priceChartForecast')}
        </span>
      </div>

      {error && !isLoading ? (
        <ApiErrorAlert
          error={error}
          actionLabel={t('common.retry')}
          onAction={() => void fetchKline()}
          dismissLabel={t('common.close')}
        />
      ) : null}

      {isLoading && !error ? (
        <DashboardStateBlock compact loading title={t('report.priceChartLoading')} />
      ) : null}

      {!isLoading && !error && !hasData ? (
        <DashboardStateBlock
          compact
          title={t('report.priceChartEmpty')}
          description={t('report.priceChartEmptyDescription')}
        />
      ) : null}

      {!isLoading && !error && hasData && renderFailed ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-text">{t('report.priceChartRenderFallback')}</p>
          <p className="text-xs text-muted-text">
            {t('report.priceChartRecentCloses')}:{' '}
            <span className="font-mono">
              {candles.slice(-5).map((candle) => candle.close.toFixed(2)).join(' · ')}
            </span>
          </p>
        </div>
      ) : null}

      {!isLoading && !error && hasData && !renderFailed ? (
        <div
          ref={containerRef}
          className="h-[360px] w-full"
          role="img"
          aria-label={t('report.priceChartTitle')}
        />
      ) : null}
    </Card>
  );
};

export default PriceChartPanel;

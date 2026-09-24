import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import { AreaChart, CandlestickChart, LineChart, Maximize2, Minimize2, RefreshCw } from 'lucide-react';
import type { ParsedApiError } from '../../api/error';
import { getParsedApiError } from '../../api/error';
import { stocksApi, type DailyKlinePoint } from '../../api/stocks';
import { ApiErrorAlert, Card } from '../common';
import { DashboardStateBlock } from '../dashboard';
import { useUiLanguage } from '../../contexts/UiLanguageContext';
import { formatCompactCnAmount } from '../../utils/format';
import {
  buildAnalystForecastLine,
  buildCandlesticks,
  buildCloseLine,
  buildForecastCone,
  buildLevelLines,
  buildMovingAverage,
  buildOhlcHud,
  buildTradeMarkers,
  buildVolumeHistogram,
  buildWindowStats,
  CHART_RANGE_DAYS,
  filterFromTime,
  isUpwardBias,
  KLINE_FETCH_DAYS,
  parseLevels,
  sliceLatest,
  type CandlestickDatum,
  type ChartRangeDays,
  type LineDatum,
  type OhlcHud,
  type PriceLevelLine,
  type TradeMarkerSpec,
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
  /** 日线拉取天数（默认 250，与后端上限对齐；可见区间可再裁切） */
  days?: number;
}

interface ChartPalette {
  up: string;
  down: string;
  text: string;
  grid: string;
  border: string;
  levels: Record<PriceLevelLine['key'], string>;
  bull: string;
  bear: string;
  analyst: string;
  ma5: string;
  ma10: string;
  ma20: string;
}

type MaVisibility = {
  ma5: boolean;
  ma10: boolean;
  ma20: boolean;
};

type ChartType = 'candles' | 'line' | 'area';

const CHART_TYPE_META: Array<{ id: ChartType; labelKey: 'report.priceChartTypeCandles' | 'report.priceChartTypeLine' | 'report.priceChartTypeArea'; Icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'candles', labelKey: 'report.priceChartTypeCandles', Icon: CandlestickChart },
  { id: 'line', labelKey: 'report.priceChartTypeLine', Icon: LineChart },
  { id: 'area', labelKey: 'report.priceChartTypeArea', Icon: AreaChart },
];

type FallbackSwatch = {
  up: string;
  down: string;
  text: string;
  grid: string;
  border: string;
  idealBuy: string;
  secondaryBuy: string;
  stopLoss: string;
  takeProfit: string;
  ma5: string;
  ma10: string;
  ma20: string;
};

const RANGE_LABEL_KEYS: Record<ChartRangeDays, 'report.priceChartRange60' | 'report.priceChartRange120' | 'report.priceChartRange250'> = {
  60: 'report.priceChartRange60',
  120: 'report.priceChartRange120',
  250: 'report.priceChartRange250',
};

const FALLBACK_COLORS: Record<'dark' | 'light', FallbackSwatch> = {
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
    ma5: '#f59e0b',
    ma10: '#38bdf8',
    ma20: '#c084fc',
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
    ma5: '#d97706',
    ma10: '#0284c7',
    ma20: '#7c3aed',
  },
};

const EMPTY_CONE: { bull: LineDatum[]; bear: LineDatum[] } = { bull: [], bear: [] };
const DEFAULT_MA: MaVisibility = { ma5: true, ma10: true, ma20: true };
const CHART_HEIGHT_FALLBACK = 460;

const readCssVar = (element: HTMLElement, name: string, fallback: string): string => {
  const value = window.getComputedStyle(element).getPropertyValue(name).trim();
  return value || fallback;
};

const withAlpha = (color: string, alpha: number): string => {
  const hslMatch = color.match(/^hsla?\((.+)\)$/i);
  if (hslMatch) {
    const inner = hslMatch[1].trim();
    if (inner.includes('/')) {
      return `hsl(${inner.replace(/\/\s*[\d.]+\s*%?\s*$/, `/ ${alpha}`)})`;
    }
    return `hsl(${inner} / ${alpha})`;
  }
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const value = Number.parseInt(hex[1], 16);
    const red = (value >> 16) & 255;
    const green = (value >> 8) & 255;
    const blue = value & 255;
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }
  return color;
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
    up: readCssVar(container, '--home-price-up', fallback.up),
    down: readCssVar(container, '--home-price-down', fallback.down),
    text: readCssVar(container, '--text-secondary-text', fallback.text),
    grid: readCssVar(container, '--border-subtle', fallback.grid),
    border: readCssVar(container, '--border-default', fallback.border),
    levels,
    bull: levels.idealBuy,
    bear: levels.stopLoss,
    analyst: levels.takeProfit,
    ma5: fallback.ma5,
    ma10: fallback.ma10,
    ma20: fallback.ma20,
  };
};

interface LevelChipProps {
  label: string;
  colorVar?: string;
  color?: string;
  value?: number | null;
  dashed?: boolean;
}

const LevelChip: React.FC<LevelChipProps> = ({ label, colorVar, color, value, dashed = false }) => (
  <span className="home-accent-chip inline-flex items-center gap-1.5 px-2 py-0.5 text-xs text-muted-text">
    <span
      aria-hidden="true"
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${dashed ? 'opacity-80' : ''}`}
      style={{
        background: color || `var(${colorVar})`,
        boxShadow: `0 0 8px ${color || `var(${colorVar})`}`,
      }}
    />
    {label}
    {value !== null && value !== undefined ? <span className="font-mono">{value.toFixed(2)}</span> : null}
  </span>
);

const ToolbarButton: React.FC<{
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
  tone?: string;
}> = ({ pressed, onClick, children, tone }) => (
  <button
    type="button"
    aria-pressed={pressed}
    onClick={onClick}
    className={`tv-desk-tool ${pressed ? 'is-active' : ''}`}
    style={tone ? { ['--tv-tool-tone' as string]: tone } : undefined}
  >
    {children}
  </button>
);

const formatHudPrice = (value: number): string => {
  if (!Number.isFinite(value)) {
    return '-';
  }
  return Number.isInteger(value) ? value.toFixed(2) : value.toFixed(value < 10 ? 3 : 2);
};

/**
 * 报告页交易台式 K 线图（lightweight-charts v5）。
 *
 * 图表库按需异步加载：加载或渲染失败时降级为最近收盘价摘要，
 * 任何图表异常都不会影响报告页其它区块。
 */
export const PriceChartPanel: React.FC<PriceChartPanelProps> = ({
  code,
  levels,
  trendPrediction,
  days = KLINE_FETCH_DAYS,
}) => {
  const { t } = useUiLanguage();
  const { resolvedTheme } = useTheme();

  const [points, setPoints] = useState<DailyKlinePoint[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<ParsedApiError | null>(null);
  const [renderFailed, setRenderFailed] = useState(false);
  const [rangeDays, setRangeDays] = useState<ChartRangeDays>(120);
  const [showMa, setShowMa] = useState<MaVisibility>(DEFAULT_MA);
  const [hoverHud, setHoverHud] = useState<OhlcHud | null>(null);
  const [chartType, setChartType] = useState<ChartType>('candles');
  const [showLevels, setShowLevels] = useState(true);
  const [showForecast, setShowForecast] = useState(true);
  const [expanded, setExpanded] = useState(false);

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
    setHoverHud(null);

    if (code) {
      void fetchKline();
    }
  }, [code, fetchKline]);

  const parsedLevels = useMemo(() => parseLevels(levels ?? {}), [levels]);
  const candles = useMemo<CandlestickDatum[]>(() => buildCandlesticks(points), [points]);
  const visibleCandles = useMemo(() => sliceLatest(candles, rangeDays), [candles, rangeDays]);
  const visibleStart = visibleCandles[0]?.time;
  const levelLines = useMemo<PriceLevelLine[]>(() => buildLevelLines(parsedLevels), [parsedLevels]);
  const upwardBias = useMemo(() => isUpwardBias(trendPrediction), [trendPrediction]);
  const lastCandle = visibleCandles[visibleCandles.length - 1];
  const previousClose = visibleCandles.length > 1
    ? visibleCandles[visibleCandles.length - 2].close
    : candles.length > 1
      ? candles[candles.length - 2].close
      : null;

  const cone = useMemo(() => {
    if (!lastCandle) {
      return EMPTY_CONE;
    }
    return buildForecastCone({
      lastDate: lastCandle.time,
      lastClose: lastCandle.close,
      takeProfit: parsedLevels.takeProfit,
      stopLoss: parsedLevels.stopLoss,
      upwardBias,
    });
  }, [lastCandle, parsedLevels.stopLoss, parsedLevels.takeProfit, upwardBias]);

  const analystLine = useMemo(() => {
    if (!lastCandle) {
      return [] as LineDatum[];
    }
    return buildAnalystForecastLine({
      lastDate: lastCandle.time,
      lastClose: lastCandle.close,
      takeProfit: parsedLevels.takeProfit,
      stopLoss: parsedLevels.stopLoss,
      upwardBias,
    });
  }, [lastCandle, parsedLevels.stopLoss, parsedLevels.takeProfit, upwardBias]);

  const maLines = useMemo(() => ({
    ma5: filterFromTime(buildMovingAverage(candles, 5), visibleStart),
    ma10: filterFromTime(buildMovingAverage(candles, 10), visibleStart),
    ma20: filterFromTime(buildMovingAverage(candles, 20), visibleStart),
  }), [candles, visibleStart]);

  const closeLine = useMemo(() => buildCloseLine(visibleCandles), [visibleCandles]);
  const headerChange = lastCandle && previousClose != null && previousClose !== 0
    ? ((lastCandle.close - previousClose) / previousClose) * 100
    : null;

  const tradeMarkers = useMemo<TradeMarkerSpec[]>(
    () => (lastCandle ? buildTradeMarkers(lastCandle.time, parsedLevels) : []),
    [lastCandle, parsedLevels],
  );

  const lastHud = useMemo(
    () => (lastCandle ? buildOhlcHud(lastCandle, previousClose) : null),
    [lastCandle, previousClose],
  );
  const hud = hoverHud ?? lastHud;

  const hasData = visibleCandles.length > 0;
  const theme = resolvedTheme === 'light' ? 'light' : 'dark';
  const visiblePoints = useMemo(() => {
    if (!visibleStart) {
      return points;
    }
    return points.filter((point) => typeof point.date === 'string' && point.date >= visibleStart);
  }, [points, visibleStart]);
  const windowStats = useMemo(
    () => buildWindowStats(visibleCandles, visiblePoints),
    [visibleCandles, visiblePoints],
  );

  useEffect(() => {
    if (!expanded) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setExpanded(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [expanded]);

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
          AreaSeries,
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
          height: container.clientHeight || CHART_HEIGHT_FALLBACK,
          layout: {
            background: { type: ColorType.Solid, color: 'transparent' },
            textColor: palette.text,
            attributionLogo: false,
            fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
          },
          grid: {
            vertLines: { color: withAlpha(palette.grid, 0.55) },
            horzLines: { color: withAlpha(palette.grid, 0.55) },
          },
          rightPriceScale: {
            borderColor: palette.border,
            scaleMargins: { top: 0.08, bottom: 0.22 },
          },
          timeScale: {
            borderColor: palette.border,
            rightOffset: 14,
            barSpacing: 7,
            minBarSpacing: 4,
          },
          crosshair: {
            mode: CrosshairMode.MagnetOHLC,
            vertLine: {
              color: withAlpha(palette.text, 0.45),
              width: 1,
              style: LineStyle.Dashed,
              labelBackgroundColor: palette.border,
            },
            horzLine: {
              color: withAlpha(palette.text, 0.45),
              width: 1,
              style: LineStyle.Dashed,
              labelBackgroundColor: palette.border,
            },
          },
        });
        if (cancelled) {
          chart.remove();
          return;
        }

        // 主序列按圖表類型切換：K 線 / 收盤線 / 面積
        let primarySeries;
        if (chartType === 'candles') {
          primarySeries = chart.addSeries(CandlestickSeries, {
            upColor: palette.up,
            downColor: palette.down,
            borderUpColor: palette.up,
            borderDownColor: palette.down,
            wickUpColor: palette.up,
            wickDownColor: palette.down,
          });
          primarySeries.setData(visibleCandles);
        } else if (chartType === 'line') {
          primarySeries = chart.addSeries(LineSeries, {
            color: palette.ma10,
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
          });
          primarySeries.setData(closeLine);
        } else {
          primarySeries = chart.addSeries(AreaSeries, {
            lineColor: palette.ma10,
            topColor: withAlpha(palette.ma10, 0.28),
            bottomColor: withAlpha(palette.ma10, 0.02),
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
          });
          primarySeries.setData(closeLine);
        }
        const candleSeries = primarySeries;

        const volumeSeries = chart.addSeries(HistogramSeries, {
          priceFormat: { type: 'volume' },
          priceScaleId: 'volume',
          priceLineVisible: false,
          lastValueVisible: false,
        });
        volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        volumeSeries.setData(
          buildVolumeHistogram(visiblePoints, { up: withAlpha(palette.up, 0.55), down: withAlpha(palette.down, 0.55) }),
        );

        const overlayLine = {
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        } as const;

        const addMa = (data: LineDatum[], color: string) => {
          if (data.length === 0) {
            return;
          }
          chart.addSeries(LineSeries, {
            ...overlayLine,
            color,
            lineWidth: 1,
          }).setData(data);
        };
        if (showMa.ma5) addMa(maLines.ma5, palette.ma5);
        if (showMa.ma10) addMa(maLines.ma10, palette.ma10);
        if (showMa.ma20) addMa(maLines.ma20, palette.ma20);

        const levelTitles: Record<PriceLevelLine['key'], string> = {
          idealBuy: t('report.priceChartLevelBuy'),
          secondaryBuy: t('report.priceChartLevelSecondary'),
          stopLoss: t('report.priceChartLevelStop'),
          takeProfit: t('report.priceChartLevelTakeProfit'),
        };
        if (showLevels) {
          levelLines.forEach((line) => {
            candleSeries.createPriceLine({
              price: line.price,
              color: palette.levels[line.key],
              lineWidth: line.key === 'idealBuy' || line.key === 'takeProfit' ? 2 : 1,
              lineStyle: LineStyle.Dashed,
              axisLabelVisible: true,
              title: levelTitles[line.key],
            });
          });
        }

        // 最新價虛線（TradingView 式右軸標籤）
        if (lastCandle) {
          const lastUp = previousClose == null || lastCandle.close >= previousClose;
          candleSeries.createPriceLine({
            price: lastCandle.close,
            color: lastUp ? palette.up : palette.down,
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: t('report.priceChartLast'),
          });
        }

        const forecastOptions = {
          ...overlayLine,
          lineWidth: 1 as const,
          lineStyle: LineStyle.LargeDashed,
        };
        if (showForecast && cone.bull.length > 0) {
          chart.addSeries(LineSeries, { ...forecastOptions, color: palette.bull }).setData(cone.bull);
        }
        if (showForecast && cone.bear.length > 0) {
          chart.addSeries(LineSeries, { ...forecastOptions, color: palette.bear }).setData(cone.bear);
        }
        if (showForecast && analystLine.length > 0) {
          chart.addSeries(LineSeries, {
            ...overlayLine,
            color: palette.analyst,
            lineWidth: 2,
            lineStyle: LineStyle.Solid,
            lastValueVisible: true,
            title: t('report.priceChartForecastAnalyst'),
          }).setData(analystLine);
        }

        const markerColor: Record<TradeMarkerSpec['key'], string> = {
          idealBuy: palette.levels.idealBuy,
          secondaryBuy: palette.levels.secondaryBuy,
          stopLoss: palette.levels.stopLoss,
          takeProfit: palette.levels.takeProfit,
          analysisDate: palette.text,
        };
        const markerText: Record<TradeMarkerSpec['key'], string> = {
          idealBuy: t('report.priceChartBuyMarker'),
          secondaryBuy: t('report.priceChartLevelSecondary'),
          stopLoss: t('report.priceChartLevelStop'),
          takeProfit: t('report.priceChartSellMarker'),
          analysisDate: t('report.priceChartAnalysisDate'),
        };
        const markerPayload = tradeMarkers.length > 0
          ? tradeMarkers.map((marker) => ({
            time: marker.time,
            position: marker.position,
            shape: marker.shape,
            color: markerColor[marker.key],
            text: markerText[marker.key],
            size: 2 as const,
          }))
          : lastCandle
            ? [{
              time: lastCandle.time,
              position: 'belowBar' as const,
              shape: 'circle' as const,
              color: palette.text,
              text: t('report.priceChartAnalysisDate'),
              size: 1 as const,
            }]
            : [];
        const markers = createSeriesMarkers(candleSeries, markerPayload);

        const candleIndex = new Map(visibleCandles.map((candle, index) => [candle.time, index]));
        chart.subscribeCrosshairMove((param) => {
          try {
            const point = param.seriesData.get(candleSeries) as CandlestickDatum | undefined;
            if (!point || typeof param.time !== 'string') {
              setHoverHud(null);
              return;
            }
            const index = candleIndex.get(param.time);
            const previous = index !== undefined && index > 0 ? visibleCandles[index - 1].close : previousClose;
            setHoverHud(buildOhlcHud({
              time: param.time,
              open: point.open,
              high: point.high,
              low: point.low,
              close: point.close,
            }, previous));
          } catch {
            // 圖表銷毀瞬間的殘留事件直接忽略
          }
        });

        chart.timeScale().fitContent();

        const resizeObserver = new ResizeObserver((entries) => {
          // 回調運行在 effect 的 try/catch 之外，異常會擊穿錯誤邊界，必須就地吞掉
          try {
            const rect = entries[0]?.contentRect;
            if (!rect) {
              return;
            }
            const nextWidth = Math.floor(rect.width);
            const nextHeight = Math.floor(rect.height);
            if (nextWidth > 0 && nextHeight > 0) {
              chart.applyOptions({ width: nextWidth, height: nextHeight });
            }
          } catch {
            // 圖表已隨上一次渲染銷毀時忽略本次尺寸同步
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
  }, [
    analystLine,
    chartType,
    closeLine,
    cone,
    hasData,
    lastCandle,
    levelLines,
    maLines,
    previousClose,
    renderFailed,
    showForecast,
    showLevels,
    showMa,
    t,
    theme,
    tradeMarkers,
    visibleCandles,
    visiblePoints,
  ]);

  if (!code) {
    return null;
  }

  const hudUp = hud?.changePct !== null && hud?.changePct !== undefined && hud.changePct >= 0;
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

  const statUp = headerChange == null || headerChange >= 0;

  return (
    <Card
      variant="bordered"
      padding="md"
      className={`home-panel-card tv-desk ${expanded ? 'tv-desk-expanded' : ''}`}
    >
      <div className="mb-3 flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-text">
            {t('report.priceChartTitle')}
          </p>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-lg font-bold text-foreground">{code}</span>
            {lastCandle ? (
              <span
                className="num text-2xl font-bold leading-6"
                style={{ color: statUp ? 'var(--home-price-up)' : 'var(--home-price-down)' }}
              >
                {formatHudPrice(lastCandle.close)}
              </span>
            ) : null}
            {headerChange != null ? (
              <span
                className="num text-sm font-semibold"
                style={{ color: statUp ? 'var(--home-price-up)' : 'var(--home-price-down)' }}
              >
                {headerChange >= 0 ? '+' : ''}{headerChange.toFixed(2)}%
              </span>
            ) : null}
            <span className="num flex flex-wrap gap-x-3 text-[11px] text-muted-text">
              <span>{t('report.priceChartStatHigh')} {windowStats.high != null ? formatHudPrice(windowStats.high) : '-'}</span>
              <span>{t('report.priceChartStatLow')} {windowStats.low != null ? formatHudPrice(windowStats.low) : '-'}</span>
              <span>{t('report.priceChartStatVolume')} {windowStats.volumeSum != null ? formatCompactCnAmount(windowStats.volumeSum) : '-'}</span>
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="tv-desk-tools" role="group" aria-label={t('report.priceChartRange', { days: rangeDays })}>
            {CHART_RANGE_DAYS.map((daysOption) => (
              <ToolbarButton
                key={daysOption}
                pressed={rangeDays === daysOption}
                onClick={() => setRangeDays(daysOption)}
              >
                {t(RANGE_LABEL_KEYS[daysOption])}
              </ToolbarButton>
            ))}
          </div>

          <div className="tv-desk-tools" role="group" aria-label={t('report.priceChartTypeCandles')}>
            {CHART_TYPE_META.map(({ id, labelKey, Icon }) => (
              <ToolbarButton
                key={id}
                pressed={chartType === id}
                onClick={() => setChartType(id)}
              >
                <Icon className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                {t(labelKey)}
              </ToolbarButton>
            ))}
          </div>

          <div className="tv-desk-tools" role="group" aria-label={t('report.priceChartMa5')}>
            <ToolbarButton
              pressed={showMa.ma5}
              tone={FALLBACK_COLORS[theme].ma5}
              onClick={() => setShowMa((current) => ({ ...current, ma5: !current.ma5 }))}
            >
              {t('report.priceChartMa5')}
            </ToolbarButton>
            <ToolbarButton
              pressed={showMa.ma10}
              tone={FALLBACK_COLORS[theme].ma10}
              onClick={() => setShowMa((current) => ({ ...current, ma10: !current.ma10 }))}
            >
              {t('report.priceChartMa10')}
            </ToolbarButton>
            <ToolbarButton
              pressed={showMa.ma20}
              tone={FALLBACK_COLORS[theme].ma20}
              onClick={() => setShowMa((current) => ({ ...current, ma20: !current.ma20 }))}
            >
              {t('report.priceChartMa20')}
            </ToolbarButton>
          </div>

          <div className="tv-desk-tools" role="group" aria-label={t('report.priceChartLevels')}>
            <ToolbarButton pressed={showLevels} onClick={() => setShowLevels((current) => !current)}>
              {t('report.priceChartLevels')}
            </ToolbarButton>
            <ToolbarButton pressed={showForecast} onClick={() => setShowForecast((current) => !current)}>
              {t('report.priceChartForecastToggle')}
            </ToolbarButton>
          </div>

          <div className="tv-desk-tools">
            <ToolbarButton pressed={false} onClick={() => void fetchKline()}>
              <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
              {t('report.priceChartRefresh')}
            </ToolbarButton>
            <ToolbarButton
              pressed={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded
                ? <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
                : <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />}
              {expanded ? t('report.priceChartCollapse') : t('report.priceChartExpand')}
            </ToolbarButton>
          </div>
        </div>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        {levelChips.map((chip) => (
          <LevelChip key={chip.key} label={chip.label} colorVar={chip.colorVar} value={chip.value} dashed />
        ))}
        <LevelChip
          label={t('report.priceChartForecastAnalyst')}
          colorVar="--home-strategy-take"
        />
        <LevelChip
          label={t('report.priceChartForecast')}
          colorVar="--home-strategy-buy"
          dashed
        />
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
              {visibleCandles.slice(-5).map((candle) => candle.close.toFixed(2)).join(' · ')}
            </span>
          </p>
        </div>
      ) : null}

      {!isLoading && !error && hasData && !renderFailed ? (
        <div className="tv-desk-frame">
          {hud ? (
            <div
              data-testid="price-chart-hud"
              className="tv-desk-legend font-mono text-xs"
            >
              <span className="tv-desk-hud-time">{hud.time}</span>
              <span><em>{t('report.priceChartHudOpen')}</em> {formatHudPrice(hud.open)}</span>
              <span><em>{t('report.priceChartHudHigh')}</em> {formatHudPrice(hud.high)}</span>
              <span><em>{t('report.priceChartHudLow')}</em> {formatHudPrice(hud.low)}</span>
              <span className={hudUp ? 'is-up' : 'is-down'}>
                <em>{t('report.priceChartHudClose')}</em> {formatHudPrice(hud.close)}
                {hud.changePct !== null ? ` ${hud.changePct >= 0 ? '+' : ''}${hud.changePct.toFixed(2)}%` : ''}
              </span>
            </div>
          ) : null}
          <div
            ref={containerRef}
            className={`tv-desk-canvas w-full ${expanded ? 'h-[calc(100vh-11rem)]' : 'h-[22.5rem] md:h-[28.75rem]'}`}
            role="img"
            aria-label={t('report.priceChartTitle')}
          />
        </div>
      ) : null}
      <p className="mt-2 text-[11px] leading-5 text-muted-text">{t('report.priceChartHint')}</p>
    </Card>
  );
};

export default PriceChartPanel;

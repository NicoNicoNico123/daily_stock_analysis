/**
 * Pure transforms for the report price chart (TradingView-style K-line panel).
 *
 * 该模块只做纯数据转换，保持可单元测试；DOM / 图表库相关的逻辑在
 * `components/report/PriceChartPanel.tsx` 中处理。
 */

/** 单个日 K 数据点（与 GET /api/v1/data/daily-kline 的 points 对齐） */
export interface PriceChartKlinePoint {
  date?: string | null;
  open?: number | string | null;
  high?: number | string | null;
  low?: number | string | null;
  close?: number | string | null;
  volume?: number | string | null;
}

/** 策略点位结构化数值（可为 null / 字符串，字符串时按数字解析） */
export interface PriceChartLevels {
  idealBuy?: number | string | null;
  secondaryBuy?: number | string | null;
  stopLoss?: number | string | null;
  takeProfit?: number | string | null;
}

export type PriceLevelKey = 'idealBuy' | 'secondaryBuy' | 'stopLoss' | 'takeProfit';

/** 价格位线（仅包含非空数值的点位） */
export interface PriceLevelLine {
  key: PriceLevelKey;
  price: number;
  /** 颜色所在的 CSS 变量名，与策略点位卡片保持同一套主题色 */
  colorVar: string;
}

export interface CandlestickDatum {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface HistogramDatum {
  time: string;
  value: number;
  color?: string;
}

export interface LineDatum {
  time: string;
  value: number;
}

export interface ForecastCone {
  /** 乐观路径：最后一根收盘价 -> 止盈位（含起点，便于与 K 线衔接） */
  bull: LineDatum[];
  /** 悲观路径：最后一根收盘价 -> 止损位（含起点） */
  bear: LineDatum[];
}

/** 走勢預測覆蓋的日曆天數 */
export const FORECAST_CALENDAR_DAYS = 10;

/** 日 K 拉取上限，与 GET /api/v1/data/daily-kline 的 days 上限对齐 */
export const KLINE_FETCH_DAYS = 250;

export const CHART_RANGE_DAYS = [60, 120, 250] as const;
export type ChartRangeDays = (typeof CHART_RANGE_DAYS)[number];

export const MA_PERIODS = [5, 10, 20] as const;
export type MaPeriod = (typeof MA_PERIODS)[number];

export interface OhlcHud {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  changePct: number | null;
}

export type TradeMarkerKey = PriceLevelKey | 'analysisDate';

export interface TradeMarkerSpec {
  time: string;
  position: 'belowBar' | 'aboveBar' | 'inBar';
  shape: 'arrowUp' | 'arrowDown' | 'circle';
  key: TradeMarkerKey;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * 把报告详情中的策略点位字符串解析成数字。
 *
 * 后端 `strategy.ideal_buy` 等字段是字符串（可能带货币符号或说明文字），
 * 只有在能提取出有限数字时才返回数值，否则返回 null。
 */
export const parseLevelValue = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  // 優先取「N 元」形式的價格（如 1254.00 元、1288.22元）；
  // 避免從 MA10 / RSI 26 這類指標數字誤提取出 10 / 26 當作價位。
  const yuan = value.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*元/);
  if (yuan) {
    const parsed = Number(yuan[1]);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
};

/** 已解析为数字的策略点位（无法解析的字段为 null） */
export interface ParsedPriceChartLevels {
  idealBuy: number | null;
  secondaryBuy: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
}

/** 批量解析策略点位；无法解析的字段为 null，由调用方过滤。 */
export const parseLevels = (
  levels: PriceChartLevels | null | undefined,
): ParsedPriceChartLevels => ({
  idealBuy: parseLevelValue(levels?.idealBuy),
  secondaryBuy: parseLevelValue(levels?.secondaryBuy),
  stopLoss: parseLevelValue(levels?.stopLoss),
  takeProfit: parseLevelValue(levels?.takeProfit),
});

/** 归一化为按日期升序、字段完整的 K 线数据（去重、剔除脏行）。 */
export const buildCandlesticks = (points: PriceChartKlinePoint[]): CandlestickDatum[] => {
  const byDate = new Map<string, CandlestickDatum>();

  points.forEach((point) => {
    const date = typeof point?.date === 'string' ? point.date.trim() : '';
    if (!DATE_PATTERN.test(date)) {
      return;
    }
    const open = toFiniteNumber(point.open);
    const high = toFiniteNumber(point.high);
    const low = toFiniteNumber(point.low);
    const close = toFiniteNumber(point.close);
    if (open === null || high === null || low === null || close === null) {
      return;
    }
    // 同一日期重复出现时保留最后一条（数据源偶发重复时以最新为准）
    byDate.set(date, { time: date, open, high, low, close });
  });

  return Array.from(byDate.values()).sort((left, right) => (left.time < right.time ? -1 : 1));
};

/** 成交量柱数据（按 K 线同序），缺失成交量的日期被跳过；颜色跟随当根涨跌。 */
/** 收盘价连线（线性图 / 面积图数据源） */
export const buildCloseLine = (candles: CandlestickDatum[]): LineDatum[] =>
  candles.map((candle) => ({ time: candle.time, value: candle.close }));

export interface ChartWindowStats {
  high: number | null;
  low: number | null;
  volumeSum: number | null;
}

/** 可见区间统计：最高 / 最低 / 成交量合计（成交量来自带 volume 字段的原始点） */
export const buildWindowStats = (
  candles: CandlestickDatum[],
  points: Array<{ volume?: number | string | null }>,
): ChartWindowStats => {
  let high: number | null = null;
  let low: number | null = null;
  for (const candle of candles) {
    // 日 K 各字段可能缺失（數據源降級），只統計有限數值
    const candleHigh = Number(candle.high);
    const candleLow = Number(candle.low);
    if (Number.isFinite(candleHigh) && (high == null || candleHigh > high)) {
      high = candleHigh;
    }
    if (Number.isFinite(candleLow) && (low == null || candleLow < low)) {
      low = candleLow;
    }
  }
  if (high == null && low == null) {
    return { high: null, low: null, volumeSum: null };
  }
  let volumeSum: number | null = null;
  for (const point of points) {
    const volume = Number(point?.volume);
    if (point?.volume != null && point.volume !== '' && Number.isFinite(volume)) {
      volumeSum = (volumeSum ?? 0) + volume;
    }
  }
  return { high, low, volumeSum };
};

export const buildVolumeHistogram = (
  points: PriceChartKlinePoint[],
  colors: { up: string; down: string },
): HistogramDatum[] => {
  const volumeByDate = new Map<string, number>();
  points.forEach((point) => {
    const date = typeof point?.date === 'string' ? point.date.trim() : '';
    const volume = toFiniteNumber(point?.volume);
    if (date && volume !== null) {
      volumeByDate.set(date, volume);
    }
  });

  return buildCandlesticks(points).reduce<HistogramDatum[]>((bars, candle) => {
    const volume = volumeByDate.get(candle.time);
    if (volume === undefined) {
      return bars;
    }
    bars.push({
      time: candle.time,
      value: volume,
      color: candle.close >= candle.open ? colors.up : colors.down,
    });
    return bars;
  }, []);
};

const LEVEL_DEFS: Array<{ key: PriceLevelKey; colorVar: string }> = [
  { key: 'idealBuy', colorVar: '--home-strategy-buy' },
  { key: 'secondaryBuy', colorVar: '--home-strategy-secondary' },
  { key: 'stopLoss', colorVar: '--home-strategy-stop' },
  { key: 'takeProfit', colorVar: '--home-strategy-take' },
];

/** 非空点位 -> 价格线定义（保持 理想買入/二次買入/止損/止盈 顺序）。 */
export const buildLevelLines = (levels: PriceChartLevels): PriceLevelLine[] =>
  LEVEL_DEFS.reduce<PriceLevelLine[]>((lines, def) => {
    const price = parseLevelValue(levels?.[def.key]);
    if (price !== null) {
      lines.push({ key: def.key, price, colorVar: def.colorVar });
    }
    return lines;
  }, []);

/** 从趋势预测文本中判断是否偏多（仅用于预测锥的视觉倾向，不影响数据）。 */
export const isUpwardBias = (trendPrediction?: string | null): boolean => {
  const text = (trendPrediction || '').toLowerCase();
  if (!text) {
    return false;
  }
  const bearish = ['下跌', '下行', '看空', '空頭', '空头', '走弱', '回调', '回調', 'bearish', 'downside', 'downtrend'];
  const bullish = ['上涨', '上漲', '上行', '看多', '多頭', '多头', '走强', '走強', '反弹', '反彈', 'bullish', 'uptrend', 'upside'];
  const bearScore = bearish.reduce((score, token) => (text.includes(token) ? score + 1 : score), 0);
  const bullScore = bullish.reduce((score, token) => (text.includes(token) ? score + 1 : score), 0);
  if (bullScore === bearScore) {
    return bullScore > 0; // 全为 0 时默认不偏移
  }
  return bullScore > bearScore;
};

/** 日期字符串 + N 个日历日，返回 YYYY-MM-DD（越界自动进位）。 */
export const addCalendarDays = (date: string, days: number): string => {
  const base = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) {
    return date;
  }
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
};

export interface ForecastConeParams {
  /** 最后一根 K 线日期（YYYY-MM-DD） */
  lastDate: string;
  /** 最后一根 K 线收盘价 */
  lastClose: number;
  /** 止盈位（乐观路径终点） */
  takeProfit?: number | null;
  /** 止损位（悲观路径终点） */
  stopLoss?: number | null;
  /** 预测文本偏多时，乐观路径的斜率略微加大（纯视觉） */
  upwardBias?: boolean;
  calendarDays?: number;
}

const buildPath = (
  startDate: string,
  startValue: number,
  endValue: number,
  steps: number,
): LineDatum[] => {
  if (!Number.isFinite(endValue) || steps <= 0) {
    return [];
  }
  const path: LineDatum[] = [];
  for (let index = 1; index <= steps; index += 1) {
    const ratio = index / steps;
    path.push({
      time: addCalendarDays(startDate, index),
      value: Number((startValue + (endValue - startValue) * ratio).toFixed(4)),
    });
  }
  return path;
};

const originPoint = (date: string, value: number): LineDatum => ({
  time: date,
  value: Number(value.toFixed(4)),
});

/**
 * 从最后一根收盘价出发，生成未来 N 个日历日的乐观/悲观预测路径。
 *
 * 两条路径都以最后一根 K 线为起点（含当日收盘，便于与蜡烛衔接），
 * 终点分别是止盈位与止损位；偏多时乐观路径略加斜率，纯属示意。
 */
export const buildForecastCone = ({
  lastDate,
  lastClose,
  takeProfit,
  stopLoss,
  upwardBias = false,
  calendarDays = FORECAST_CALENDAR_DAYS,
}: ForecastConeParams): ForecastCone => {
  if (!DATE_PATTERN.test(lastDate) || !Number.isFinite(lastClose)) {
    return { bull: [], bear: [] };
  }

  const target = parseLevelValue(takeProfit);
  const stop = parseLevelValue(stopLoss);
  const bullEnd = target === null ? lastClose : target;
  const bearEnd = stop === null ? lastClose : stop;
  // 偏多时把乐观路径终点略微抬高（约 5%），让预测锥呈现向上倾斜的示意
  const biasMultiplier = upwardBias && target !== null && target > lastClose ? 1.05 : 1;
  const origin = originPoint(lastDate, lastClose);

  return {
    bull: [origin, ...buildPath(lastDate, lastClose, Number((bullEnd * biasMultiplier).toFixed(4)), calendarDays)],
    bear: [origin, ...buildPath(lastDate, lastClose, bearEnd, calendarDays)],
  };
};

/**
 * 分析师预测主线：连接最后收盘价与策略目标（止盈优先，否则止损）。
 * 与预测锥分离，便于在图上用实线强调“分析给出的价格路径”。
 */
export const buildAnalystForecastLine = ({
  lastDate,
  lastClose,
  takeProfit,
  stopLoss,
  upwardBias = false,
  calendarDays = FORECAST_CALENDAR_DAYS,
}: ForecastConeParams): LineDatum[] => {
  if (!DATE_PATTERN.test(lastDate) || !Number.isFinite(lastClose)) {
    return [];
  }

  const target = parseLevelValue(takeProfit);
  const stop = parseLevelValue(stopLoss);
  let end: number | null = null;
  if (upwardBias && target !== null) {
    end = target;
  } else if (!upwardBias && stop !== null && target === null) {
    end = stop;
  } else if (target !== null && stop !== null) {
    end = upwardBias ? target : Number(((target + stop) / 2).toFixed(4));
  } else if (target !== null) {
    end = target;
  } else if (stop !== null) {
    end = stop;
  }

  if (end === null) {
    return [];
  }

  return [originPoint(lastDate, lastClose), ...buildPath(lastDate, lastClose, end, calendarDays)];
};

/** 简单收盘价均线；长度不足时返回空数组。 */
export const buildMovingAverage = (candles: CandlestickDatum[], period: number): LineDatum[] => {
  if (period <= 0 || candles.length < period) {
    return [];
  }

  const line: LineDatum[] = [];
  let windowSum = 0;
  candles.forEach((candle, index) => {
    windowSum += candle.close;
    if (index >= period) {
      windowSum -= candles[index - period].close;
    }
    if (index >= period - 1) {
      line.push({
        time: candle.time,
        value: Number((windowSum / period).toFixed(4)),
      });
    }
  });
  return line;
};

/** 取序列末尾 N 条（区间切换用，不重新请求）。 */
export const sliceLatest = <T>(items: T[], count: number): T[] => {
  if (count <= 0 || items.length <= count) {
    return items;
  }
  return items.slice(items.length - count);
};

/** 保留 time >= startTime 的点（均线按全样本计算后再裁到可见区间）。 */
export const filterFromTime = <T extends { time: string }>(items: T[], startTime?: string | null): T[] => {
  if (!startTime) {
    return items;
  }
  return items.filter((item) => item.time >= startTime);
};

export const buildOhlcHud = (
  candle: CandlestickDatum,
  previousClose?: number | null,
): OhlcHud => {
  const changePct = (
    previousClose
    && Number.isFinite(previousClose)
    && previousClose !== 0
  )
    ? Number((((candle.close - previousClose) / previousClose) * 100).toFixed(2))
    : null;

  return {
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    changePct,
  };
};

/**
 * 在最后一根 K 线上放置买卖箭头：理想买入口在下方，止盈/卖出价在上方。
 * 没有策略点位时返回空，由调用方回退到分析日圆点。
 */
export const buildTradeMarkers = (
  lastTime: string,
  levels: ParsedPriceChartLevels,
): TradeMarkerSpec[] => {
  if (!DATE_PATTERN.test(lastTime)) {
    return [];
  }

  const markers: TradeMarkerSpec[] = [];
  if (levels.idealBuy !== null) {
    markers.push({
      time: lastTime,
      position: 'belowBar',
      shape: 'arrowUp',
      key: 'idealBuy',
    });
  } else if (levels.secondaryBuy !== null) {
    markers.push({
      time: lastTime,
      position: 'belowBar',
      shape: 'circle',
      key: 'secondaryBuy',
    });
  }
  if (levels.takeProfit !== null) {
    markers.push({
      time: lastTime,
      position: 'aboveBar',
      shape: 'arrowDown',
      key: 'takeProfit',
    });
  } else if (levels.stopLoss !== null) {
    markers.push({
      time: lastTime,
      position: 'aboveBar',
      shape: 'arrowDown',
      key: 'stopLoss',
    });
  }
  return markers;
};

/** 未来预测路径的最后一个日期（用于让时间轴预留空间）。 */
export const forecastEndDate = (lastDate: string, calendarDays = FORECAST_CALENDAR_DAYS): string =>
  addCalendarDays(lastDate, calendarDays);

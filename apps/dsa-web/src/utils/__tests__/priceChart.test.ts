import { describe, expect, it } from 'vitest';
import {
  addCalendarDays,
  buildCandlesticks,
  buildForecastCone,
  buildLevelLines,
  buildVolumeHistogram,
  forecastEndDate,
  isUpwardBias,
  parseLevelValue,
  parseLevels,
  type PriceChartKlinePoint,
} from '../priceChart';

const POINTS: PriceChartKlinePoint[] = [
  { date: '2026-02-03', open: 12, high: 13, low: 11.5, close: 12.5, volume: 300 },
  { date: '2026-02-01', open: 10.5, high: 11, low: 9.5, close: 10.2, volume: 100 },
  { date: '2026-02-02', open: 10.2, high: 11.2, low: 10, close: 11.9, volume: 200 },
  // 脏行：缺 close、日期格式不合法、重复日期
  { date: '2026-02-04', open: 12.5, high: 13, low: 12, close: null, volume: 400 },
  { date: 'not-a-date', open: 1, high: 1, low: 1, close: 1, volume: 1 },
  { date: '2026-02-03', open: 12, high: 13.2, low: 11.5, close: 12.8, volume: 350 },
];

describe('buildCandlesticks', () => {
  it('sorts ascending, drops invalid rows and keeps the latest duplicate', () => {
    const candles = buildCandlesticks(POINTS);

    expect(candles.map((candle) => candle.time)).toEqual([
      '2026-02-01',
      '2026-02-02',
      '2026-02-03',
    ]);
    expect(candles[2]).toEqual({ time: '2026-02-03', open: 12, high: 13.2, low: 11.5, close: 12.8 });
  });

  it('returns an empty array when nothing is usable', () => {
    expect(buildCandlesticks([{ date: '2026-02-01', open: 1, high: 2 }])).toEqual([]);
    expect(buildCandlesticks([])).toEqual([]);
  });
});

describe('buildVolumeHistogram', () => {
  it('colors bars by up/down candle and skips missing volumes', () => {
    const bars = buildVolumeHistogram(POINTS, { up: 'var(--up)', down: 'var(--down)' });

    expect(bars.map((bar) => bar.time)).toEqual(['2026-02-01', '2026-02-02', '2026-02-03']);
    // 02-01 收 < 开 -> 跌色；02-02、02-03 收 > 开 -> 涨色
    expect(bars[0].color).toBe('var(--down)');
    expect(bars[1].color).toBe('var(--up)');
    expect(bars[2].color).toBe('var(--up)');
    expect(bars[2].value).toBe(350);
  });

  it('returns no bars when volumes are absent', () => {
    const bars = buildVolumeHistogram(
      [{ date: '2026-02-01', open: 1, high: 1, low: 1, close: 1 }],
      { up: 'up', down: 'down' },
    );
    expect(bars).toEqual([]);
  });
});

describe('parseLevelValue / parseLevels', () => {
  it('parses numbers, plain numeric strings and strings with decoration', () => {
    expect(parseLevelValue(12.5)).toBe(12.5);
    expect(parseLevelValue(' 13.60 ')).toBe(13.6);
    expect(parseLevelValue('理想買入 1,234.50 元')).toBe(1234.5);
    expect(parseLevelValue('—')).toBeNull();
    expect(parseLevelValue('')).toBeNull();
    expect(parseLevelValue(null)).toBeNull();
    expect(parseLevelValue(undefined)).toBeNull();
    expect(parseLevelValue(Number.NaN)).toBeNull();
  });

  it('parseLevels keeps null for unparseable levels', () => {
    expect(
      parseLevels({ idealBuy: '12.50', secondaryBuy: null, stopLoss: 'x', takeProfit: '15' }),
    ).toEqual({ idealBuy: 12.5, secondaryBuy: null, stopLoss: null, takeProfit: 15 });
  });
});

describe('buildLevelLines', () => {
  it('keeps only non-null levels in the fixed order with theme color vars', () => {
    const lines = buildLevelLines({
      idealBuy: 12.5,
      secondaryBuy: null,
      stopLoss: '10.00',
      takeProfit: '15.00',
    });

    expect(lines).toEqual([
      { key: 'idealBuy', price: 12.5, colorVar: '--home-strategy-buy' },
      { key: 'stopLoss', price: 10, colorVar: '--home-strategy-stop' },
      { key: 'takeProfit', price: 15, colorVar: '--home-strategy-take' },
    ]);
  });

  it('returns an empty array when every level is missing', () => {
    expect(buildLevelLines({})).toEqual([]);
  });
});

describe('isUpwardBias', () => {
  it('detects bullish and bearish wording in zh and en', () => {
    expect(isUpwardBias('短期震盪上漲，中線看多')).toBe(true);
    expect(isUpwardBias('Bullish breakout expected')).toBe(true);
    expect(isUpwardBias('下行風險增加，建議觀望')).toBe(false);
    expect(isUpwardBias('bearish')).toBe(false);
  });

  it('is neutral when text is missing or has no signal words', () => {
    expect(isUpwardBias(null)).toBe(false);
    expect(isUpwardBias('')).toBe(false);
    expect(isUpwardBias('橫盤整理')).toBe(false);
  });
});

describe('addCalendarDays / forecastEndDate', () => {
  it('adds calendar days with month rollover', () => {
    expect(addCalendarDays('2026-02-25', 10)).toBe('2026-03-07');
    expect(addCalendarDays('2026-12-28', 10)).toBe('2027-01-07');
    expect(forecastEndDate('2026-09-10')).toBe('2026-09-20');
  });
});

describe('buildForecastCone', () => {
  const base = {
    lastDate: '2026-09-10',
    lastClose: 100,
    takeProfit: 110,
    stopLoss: 90,
  };

  it('builds bull and bear paths from the last close over 10 calendar days', () => {
    const cone = buildForecastCone(base);

    expect(cone.bull).toHaveLength(10);
    expect(cone.bear).toHaveLength(10);
    expect(cone.bull[0]).toEqual({ time: '2026-09-11', value: 101 });
    expect(cone.bull[9]).toEqual({ time: '2026-09-20', value: 110 });
    expect(cone.bear[9]).toEqual({ time: '2026-09-20', value: 90 });
  });

  it('tilts the cone upward when the prediction is bullish', () => {
    const cone = buildForecastCone({ ...base, upwardBias: true });

    expect(cone.bull[9].value).toBeCloseTo(110 * 1.05, 4);
    expect(cone.bear[9].value).toBe(90);
  });

  it('falls back to a flat path when a level is missing and ignores invalid input', () => {
    expect(buildForecastCone({ ...base, takeProfit: null }).bull[9].value).toBe(100);
    expect(buildForecastCone({ ...base, stopLoss: null }).bear[9].value).toBe(100);
    expect(buildForecastCone({ ...base, lastDate: 'bad-date' })).toEqual({ bull: [], bear: [] });
    expect(buildForecastCone({ ...base, lastClose: Number.NaN })).toEqual({ bull: [], bear: [] });
  });
});

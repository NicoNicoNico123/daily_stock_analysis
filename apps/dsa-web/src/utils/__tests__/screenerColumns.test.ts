import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreeningCandidate } from '../../api/screening';
import {
  buildScreenerCsv,
  createDefaultScreenerViewState,
  filterScreenerRows,
  formatScreenerCellText,
  getScreenerColumn,
  loadScreenerViewState,
  parseScreenerFilter,
  resolveVisibleScreenerColumns,
  saveScreenerViewState,
  SCREENER_COLUMNS,
  SCREENER_PRESETS,
  SCREENER_VIEW_STORAGE_KEY,
  searchScreenerRows,
  sortScreenerRows,
  type ScreenerColumnDef,
} from '../screenerColumns';

const makeRow = (overrides: Partial<ScreeningCandidate> = {}): ScreeningCandidate => ({
  rank: 1,
  code: '600519',
  name: '貴州茅台',
  reason: '',
  industry: '白酒',
  price: 1700,
  changePct: 2.5,
  score: 88.4,
  amount: 250_000_000,
  riskLevel: 'low',
  factorScores: {},
  raw: {
    peRatio: 25.5,
    pbRatio: 8.1,
    totalMv: 2.1e12,
    circMv: 2.1e12,
    turnoverRate: 0.85,
    volumeRatio: 1.6,
    change60d: -3.2,
    maBullish: true,
    priceAboveMa20: false,
    macdStatus: 'golden_cross',
    rsiStatus: '',
    breakout20dPct: 1.8,
    volatility20dPct: 22.4,
    atr20Pct: 2.6,
    maxDrawdown20dPct: -8.5,
    industryRank: 3,
    industryChangePct: 1.2,
    industryHeatScore: 77.5,
    conceptHeatScore: null,
    boardHeatScore: 64.1,
    riskScore: 30.2,
    riskPenalty: -1.4,
    dailyQualityScore: 90,
    // 歷史數據可能保留 snake_case 鍵
    pe_ratio_legacy: 99,
  },
  ...overrides,
});

describe('screenerColumns catalog', () => {
  it('uses stable unique ids and registered i18n labels', () => {
    const ids = SCREENER_COLUMNS.map((column) => column.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const column of SCREENER_COLUMNS) {
      expect(column.labelKey).toMatch(/^screener\.col/);
    }
  });

  it('reads top-level fields before falling back to raw', () => {
    const column = getScreenerColumn('peRatio');
    expect(column).toBeDefined();
    expect(column?.getValue?.(makeRow())).toBe(25.5);
    // raw 缺失時返回 null 而不是 NaN
    expect(column?.getValue?.(makeRow({ raw: {} }))).toBeNull();
  });

  it('supports snake_case raw keys for legacy data', () => {
    const row = makeRow({ raw: { pe_ratio: 12.3 } });
    expect(getScreenerColumn('peRatio')?.getValue?.(row)).toBe(12.3);
  });

  it('reads digit-suffixed keys via camelcase aliases (change_60d → change60D)', () => {
    const column = getScreenerColumn('change60d');
    expect(column?.getValue?.(makeRow({ raw: { change60D: -3.2 } }))).toBe(-3.2);
    expect(column?.getValue?.(makeRow({ raw: { change_60d: 9 } }))).toBe(9);
  });
});

describe('parseScreenerFilter', () => {
  it('parses comparison operators', () => {
    expect(parseScreenerFilter('>10')).toEqual({ op: 'gt', value: 10 });
    expect(parseScreenerFilter('>= 5.5')).toEqual({ op: 'gte', value: 5.5 });
    expect(parseScreenerFilter('<0')).toEqual({ op: 'lt', value: 0 });
    expect(parseScreenerFilter('<=-1')).toEqual({ op: 'lte', value: -1 });
  });

  it('parses range expressions and rejects inverted bounds safely', () => {
    expect(parseScreenerFilter('5~20')).toEqual({ op: 'between', min: 5, max: 20 });
    expect(parseScreenerFilter('20..5')).toEqual({ op: 'between', min: 5, max: 20 });
    expect(parseScreenerFilter('5-20')).toEqual({ op: 'between', min: 5, max: 20 });
    // 負數區間仍須用 ~，避免 '-5' 被誤判
    expect(parseScreenerFilter('-5~5')).toEqual({ op: 'between', min: -5, max: 5 });
    expect(parseScreenerFilter('<0')).toEqual({ op: 'lt', value: 0 });
  });

  it('treats bare numbers as exact match and other text as substring', () => {
    expect(parseScreenerFilter('88.40')).toEqual({ op: 'eq', value: 88.4 });
    expect(parseScreenerFilter('golden')).toEqual({ op: 'text', text: 'golden' });
    expect(parseScreenerFilter('   ')).toBeNull();
  });
});

describe('filterScreenerRows', () => {
  const rows = [
    makeRow({ rank: 1, code: '600519', raw: { peRatio: 25.5 } }),
    makeRow({ rank: 2, code: '000001', name: '平安銀行', industry: '銀行', raw: { peRatio: 4.2 } }),
    makeRow({ rank: 3, code: '300750', name: '寧德時代', industry: '電池', raw: { peRatio: null } }),
  ];

  it('filters numeric columns with operators and ranges', () => {
    const filtered = filterScreenerRows(rows, { peRatio: '<10' });
    expect(filtered.map((row) => row.code)).toEqual(['000001']);
    expect(filterScreenerRows(rows, { peRatio: '20~30' }).map((row) => row.code)).toEqual(['600519']);
  });

  it('excludes rows with missing values from numeric filters', () => {
    expect(filterScreenerRows(rows, { peRatio: '>0' }).map((row) => row.code)).toEqual(['600519', '000001']);
  });

  it('filters text columns by substring and matches nothing for unknown columns', () => {
    expect(filterScreenerRows(rows, { industry: '銀' }).map((row) => row.code)).toEqual(['000001']);
    expect(filterScreenerRows(rows, { __unknown__: 'x' })).toHaveLength(3);
  });

  it('returns rows unchanged when no filters are active', () => {
    expect(filterScreenerRows(rows, { peRatio: '  ' })).toHaveLength(3);
  });
});

describe('sortScreenerRows', () => {
  const rows = [
    makeRow({ rank: 1, code: 'A', changePct: 2 }),
    makeRow({ rank: 2, code: 'B', changePct: -1 }),
    makeRow({ rank: 3, code: 'C', changePct: null }),
  ];

  it('sorts numerically with nulls always last', () => {
    expect(sortScreenerRows(rows, { columnId: 'changePct', direction: 'desc' }).map((row) => row.code)).toEqual([
      'A',
      'B',
      'C',
    ]);
    expect(sortScreenerRows(rows, { columnId: 'changePct', direction: 'asc' }).map((row) => row.code)).toEqual([
      'B',
      'A',
      'C',
    ]);
  });

  it('sorts non-numeric columns: risk by severity, text by locale compare', () => {
    const rowsByRisk = [
      makeRow({ rank: 1, code: 'H', riskLevel: 'high' }),
      makeRow({ rank: 2, code: 'L', riskLevel: 'low' }),
      makeRow({ rank: 3, code: 'M', riskLevel: 'medium' }),
      makeRow({ rank: 4, code: 'P', riskLevel: '' }),
    ];
    expect(
      sortScreenerRows(rowsByRisk, { columnId: 'riskLevel', direction: 'desc' }).map((row) => row.code),
    ).toEqual(['H', 'M', 'L', 'P']);
    const rowsByText = [
      makeRow({ rank: 1, code: 'B', industry: '銀行' }),
      makeRow({ rank: 2, code: 'A', industry: '白酒' }),
    ];
    expect(sortScreenerRows(rowsByText, { columnId: 'industry', direction: 'asc' }).map((row) => row.code)).toHaveLength(2);
    // 布爾欄：true 在前（desc）
    expect(
      sortScreenerRows([makeRow({ rank: 1, raw: { maBullish: false } }), makeRow({ rank: 2, raw: { maBullish: true } })], {
        columnId: 'maBullish',
        direction: 'desc',
      })[0].rank,
    ).toBe(2);
    expect(sortScreenerRows(rows, null)).toBe(rows);
  });
});

describe('searchScreenerRows', () => {
  it('matches code, name, industry case-insensitively', () => {
    const rows = [makeRow(), makeRow({ code: '000001', name: '平安銀行', industry: '銀行' })];
    expect(searchScreenerRows(rows, '茅台')).toHaveLength(1);
    expect(searchScreenerRows(rows, '000001')).toHaveLength(1);
    expect(searchScreenerRows(rows, '白酒')).toHaveLength(1);
    expect(searchScreenerRows(rows, '不存在')).toHaveLength(0);
  });
});

describe('view state persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('round-trips state through localStorage', () => {
    saveScreenerViewState({
      hiddenIds: ['peRatio'],
      sort: { columnId: 'score', direction: 'desc' },
      filters: { peRatio: '<10' },
      filtersOpen: true,
      presetId: 'valuation',
    });
    expect(loadScreenerViewState()).toEqual({
      hiddenIds: ['peRatio'],
      sort: { columnId: 'score', direction: 'desc' },
      filters: { peRatio: '<10' },
      filtersOpen: true,
      presetId: 'valuation',
    });
  });

  it('drops unknown column ids and malformed payloads', () => {
    saveScreenerViewState({
      hiddenIds: ['peRatio', '__bogus__'],
      sort: { columnId: '__bogus__', direction: 'desc' },
      filters: { __bogus__: 'x' },
      filtersOpen: false,
      presetId: null,
    });
    const state = loadScreenerViewState();
    expect(state.hiddenIds).toEqual(['peRatio']);
    expect(state.sort).toBeNull();
    expect(state.filters).toEqual({});
  });

  it('falls back to defaults on corrupted JSON', () => {
    window.localStorage.setItem(SCREENER_VIEW_STORAGE_KEY, '{not json');
    expect(loadScreenerViewState()).toEqual(createDefaultScreenerViewState());
  });

  it('keeps default view state aligned with the catalog', () => {
    const defaults = createDefaultScreenerViewState();
    expect(resolveVisibleScreenerColumns(defaults.hiddenIds).map((column) => column.id)).toEqual(
      SCREENER_COLUMNS.filter((column) => column.defaultVisible).map((column) => column.id),
    );
    for (const preset of SCREENER_PRESETS) {
      for (const id of preset.columnIds) {
        expect(getScreenerColumn(id)).toBeDefined();
      }
    }
  });
});

describe('formatScreenerCellText', () => {
  const column = (overrides: Partial<ScreenerColumnDef>): ScreenerColumnDef => ({
    id: 'test',
    labelKey: 'screener.colPrice',
    group: 'core',
    format: 'number',
    numeric: true,
    defaultVisible: false,
    ...overrides,
  });
  const amountFormatter = (value: number) => `${value.toFixed(0)} 億`;

  it('formats signed percentages with sign and nulls as dash', () => {
    expect(formatScreenerCellText(column({ format: 'percentSigned' }), 3.14159, amountFormatter)).toBe('+3.14%');
    expect(formatScreenerCellText(column({ format: 'percentSigned' }), -0.5, amountFormatter)).toBe('-0.50%');
    expect(formatScreenerCellText(column({ format: 'percentSigned' }), null, amountFormatter)).toBe('-');
  });

  it('formats confidence from 0-1 fraction', () => {
    expect(formatScreenerCellText(column({ format: 'confidence' }), 0.82, amountFormatter)).toBe('82%');
  });

  it('delegates amount formatting to the injected compact formatter', () => {
    expect(formatScreenerCellText(column({ format: 'amount' }), 2.1e12, amountFormatter)).toBe('2100000000000 億');
  });

  it('renders booleans as 1/0 for stable CSV output', () => {
    expect(formatScreenerCellText(column({ format: 'bool', numeric: false }), true, amountFormatter)).toBe('1');
    expect(formatScreenerCellText(column({ format: 'bool', numeric: false }), false, amountFormatter)).toBe('0');
  });
});

describe('buildScreenerCsv', () => {
  it('emits BOM, header labels (incl. name) and one line per row', () => {
    const rows = [makeRow()];
    const columns = resolveVisibleScreenerColumns([]);
    const csv = buildScreenerCsv(rows, columns, (c) => c.id, 'code', 'name');
    const lines = csv.split('\r\n');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(lines[0].slice(1)).toBe(
      `"#","code","name",${columns.map((c) => `"${c.id}"`).join(',')}`,
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"600519"');
    expect(lines[1]).toContain('"貴州茅台"');
  });

  it('exports amount columns as raw numbers for offline calculation', () => {
    const rows = [makeRow()];
    const csv = buildScreenerCsv(rows, [getScreenerColumn('amount')!], (c) => c.id, 'code', 'name');
    expect(csv).toContain('"250000000"');
    expect(csv).not.toContain('億');
  });

  it('escapes embedded quotes to keep CSV parseable', () => {
    const rows = [makeRow({ name: '含"引號' })];
    const csv = buildScreenerCsv(rows, [], (c) => c.id, 'name_"x', 'name');
    expect(csv).toContain('"name_""x"');
    expect(csv).toContain('"含""引號"');
  });
});

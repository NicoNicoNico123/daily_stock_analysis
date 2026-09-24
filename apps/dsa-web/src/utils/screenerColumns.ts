import type { ScreeningCandidate } from '../api/screening';
import type { UiTextKey } from '../i18n/uiText';

/**
 * Screener 指標欄目錄（TradingView 式可配置表格的純邏輯層）。
 *
 * 後端候選行的 `raw` 字段攜帶完整 Pick 指標（snake_case 經前端 toCamelCase 後
 * 在運行時為 camelCase）。本目錄只做讀取與格式化聲明，不修改任何數據契約。
 */

export type ScreenerColumnGroupId = 'core' | 'ai' | 'valuation' | 'technical' | 'heat' | 'risk';

export type ScreenerColumnFormat =
  | 'price'
  | 'number'
  | 'integer'
  | 'percent'
  | 'percentSigned'
  | 'confidence'
  | 'score'
  | 'amount'
  | 'text'
  | 'status'
  | 'bool'
  | 'riskBadge';

export type ScreenerCellValue = string | number | boolean | null | undefined;

export interface ScreenerColumnDef {
  /** 穩定欄目 ID，同時作為 raw 運行時鍵名的首要回退來源 */
  id: string;
  labelKey: UiTextKey;
  group: ScreenerColumnGroupId;
  format: ScreenerColumnFormat;
  /** 數值精度（number/percent 類） */
  digits?: number;
  /** 非空數值列可排序、可數值篩選 */
  numeric: boolean;
  defaultVisible: boolean;
  /** 帶符號百分比：正 → 上漲色，負 → 下跌色 */
  signed?: boolean;
  /** 從候選行取值；默認先讀頂層同名字段，再回退 raw[camelCase] */
  getValue?: (row: ScreeningCandidate) => ScreenerCellValue;
}

export interface ScreenerColumnPreset {
  id: string;
  labelKey: UiTextKey;
  columnIds: string[];
}

export type ScreenerSortDirection = 'asc' | 'desc';

export interface ScreenerSortState {
  columnId: string;
  direction: ScreenerSortDirection;
}

const rawRecord = (row: ScreeningCandidate): Record<string, unknown> => {
  const raw = row.raw;
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
};

const toNumber = (value: unknown): number | null => {
  if (value == null || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const topOrRaw = (row: ScreeningCandidate, id: string): ScreenerCellValue => {
  const own = row as unknown as Record<string, unknown>;
  if (own[id] !== undefined) {
    return own[id] as ScreenerCellValue;
  }
  return rawRecord(row)[id] as ScreenerCellValue;
};

const numColumn = (
  id: string,
  labelKey: UiTextKey,
  group: ScreenerColumnGroupId,
  format: ScreenerColumnFormat,
  options: Partial<Pick<ScreenerColumnDef, 'digits' | 'defaultVisible' | 'signed'> & { rawAliases?: string[] }> = {},
): ScreenerColumnDef => ({
  id,
  labelKey,
  group,
  format,
  numeric: true,
  digits: options.digits ?? 2,
  defaultVisible: options.defaultVisible ?? false,
  signed: options.signed,
  getValue: (row) => {
    const direct = toNumber(topOrRaw(row, id));
    if (direct != null) {
      return direct;
    }
    // camelcase-keys 對數字結尾鍵的大小寫行為（change_60d → change60D）與
    // 歷史數據殘留的 snake_case 原始鍵都要兼容
    const raw = rawRecord(row);
    for (const key of options.rawAliases ?? []) {
      const aliasValue = toNumber(raw[key]);
      if (aliasValue != null) {
        return aliasValue;
      }
    }
    return toNumber(raw[id.replace(/([A-Z])/g, '_$1').toLowerCase()]);
  },
});

/**
 * 欄目錄。順序即默認展示順序；新增欄目只需在此追加並補 i18n label。
 */
export const SCREENER_COLUMNS: ScreenerColumnDef[] = [
  // —— 核心行情 ——
  numColumn('price', 'screener.colPrice', 'core', 'price', { defaultVisible: true }),
  numColumn('changePct', 'screener.colChangePct', 'core', 'percentSigned', { defaultVisible: true, signed: true }),
  numColumn('score', 'screener.colScore', 'core', 'score', { defaultVisible: true }),
  numColumn('amount', 'screener.colAmount', 'core', 'amount', { defaultVisible: true }),
  {
    id: 'riskLevel',
    labelKey: 'screener.colRiskLevel',
    group: 'core',
    format: 'riskBadge',
    numeric: false,
    defaultVisible: true,
    getValue: (row) => row.riskLevel || '',
  },
  // —— AI / 因子 ——
  numColumn('llmScore', 'screener.colLlmScore', 'ai', 'score'),
  numColumn('screenScore', 'screener.colScreenScore', 'ai', 'score'),
  numColumn('llmConfidence', 'screener.colLlmConfidence', 'ai', 'confidence'),
  {
    id: 'llmTheme',
    labelKey: 'screener.colLlmTheme',
    group: 'ai',
    format: 'text',
    numeric: false,
    defaultVisible: false,
    getValue: (row) => row.llmTheme || '',
  },
  // —— 估值與流動性 ——
  numColumn('peRatio', 'screener.colPeRatio', 'valuation', 'number', { digits: 2 }),
  numColumn('pbRatio', 'screener.colPbRatio', 'valuation', 'number', { digits: 2 }),
  numColumn('totalMv', 'screener.colTotalMv', 'valuation', 'amount'),
  numColumn('circMv', 'screener.colCircMv', 'valuation', 'amount'),
  numColumn('turnoverRate', 'screener.colTurnoverRate', 'valuation', 'percent', { digits: 2 }),
  numColumn('volumeRatio', 'screener.colVolumeRatio', 'valuation', 'number'),
  // —— 技術形態 ——
  numColumn('change60d', 'screener.colChange60d', 'technical', 'percentSigned', { signed: true, rawAliases: ['change60D', 'change_60d'] }),
  {
    id: 'maBullish',
    labelKey: 'screener.colMaBullish',
    group: 'technical',
    format: 'bool',
    numeric: false,
    defaultVisible: false,
    getValue: (row) => rawRecord(row).maBullish === true,
  },
  {
    id: 'priceAboveMa20',
    labelKey: 'screener.colPriceAboveMa20',
    group: 'technical',
    format: 'bool',
    numeric: false,
    defaultVisible: false,
    getValue: (row) => rawRecord(row).priceAboveMa20 === true,
  },
  {
    id: 'macdStatus',
    labelKey: 'screener.colMacdStatus',
    group: 'technical',
    format: 'status',
    numeric: false,
    defaultVisible: false,
    getValue: (row) => String(rawRecord(row).macdStatus || ''),
  },
  {
    id: 'rsiStatus',
    labelKey: 'screener.colRsiStatus',
    group: 'technical',
    format: 'status',
    numeric: false,
    defaultVisible: false,
    getValue: (row) => String(rawRecord(row).rsiStatus || ''),
  },
  numColumn('breakout20dPct', 'screener.colBreakout20d', 'technical', 'percentSigned', { signed: true }),
  numColumn('volatility20dPct', 'screener.colVolatility20d', 'technical', 'percent', { digits: 1 }),
  numColumn('atr20Pct', 'screener.colAtr20', 'technical', 'percent', { digits: 1 }),
  numColumn('maxDrawdown20dPct', 'screener.colMaxDrawdown20d', 'technical', 'percentSigned', { signed: true }),
  // —— 行業與板塊熱度 ——
  {
    id: 'industry',
    labelKey: 'screener.colIndustry',
    group: 'heat',
    format: 'text',
    numeric: false,
    defaultVisible: false,
    getValue: (row) => row.industry || '',
  },
  numColumn('industryRank', 'screener.colIndustryRank', 'heat', 'integer'),
  numColumn('industryChangePct', 'screener.colIndustryChangePct', 'heat', 'percentSigned', { signed: true }),
  numColumn('industryHeatScore', 'screener.colIndustryHeat', 'heat', 'number', { digits: 1 }),
  numColumn('conceptHeatScore', 'screener.colConceptHeat', 'heat', 'number', { digits: 1 }),
  numColumn('boardHeatScore', 'screener.colBoardHeat', 'heat', 'number', { digits: 1 }),
  // —— 風險 ——
  numColumn('riskScore', 'screener.colRiskScore', 'risk', 'number', { digits: 1 }),
  numColumn('riskPenalty', 'screener.colRiskPenalty', 'risk', 'number', { digits: 2 }),
  numColumn('dailyQualityScore', 'screener.colDailyQuality', 'risk', 'number', { digits: 1 }),
];

export const SCREENER_COLUMN_GROUP_ORDER: ScreenerColumnGroupId[] = [
  'core',
  'ai',
  'valuation',
  'technical',
  'heat',
  'risk',
];

export const SCREENER_PRESETS: ScreenerColumnPreset[] = [
  {
    id: 'core',
    labelKey: 'screener.presetCore',
    columnIds: SCREENER_COLUMNS.filter((column) => column.defaultVisible).map((column) => column.id),
  },
  {
    id: 'valuation',
    labelKey: 'screener.presetValuation',
    columnIds: ['price', 'changePct', 'score', 'peRatio', 'pbRatio', 'totalMv', 'circMv', 'turnoverRate', 'volumeRatio'],
  },
  {
    id: 'technical',
    labelKey: 'screener.presetTechnical',
    columnIds: ['price', 'changePct', 'score', 'change60d', 'maBullish', 'priceAboveMa20', 'macdStatus', 'rsiStatus', 'breakout20dPct', 'volatility20dPct'],
  },
  {
    id: 'heat',
    labelKey: 'screener.presetHeat',
    columnIds: ['price', 'changePct', 'score', 'industry', 'industryRank', 'industryChangePct', 'industryHeatScore', 'conceptHeatScore', 'boardHeatScore'],
  },
  {
    id: 'risk',
    labelKey: 'screener.presetRisk',
    columnIds: ['price', 'changePct', 'score', 'riskLevel', 'riskScore', 'riskPenalty', 'maxDrawdown20dPct', 'atr20Pct', 'dailyQualityScore'],
  },
  {
    id: 'ai',
    labelKey: 'screener.presetAi',
    columnIds: ['price', 'changePct', 'llmScore', 'screenScore', 'llmConfidence', 'llmTheme'],
  },
  {
    id: 'all',
    labelKey: 'screener.presetAll',
    columnIds: SCREENER_COLUMNS.map((column) => column.id),
  },
];

export const getScreenerColumn = (columnId: string): ScreenerColumnDef | undefined =>
  SCREENER_COLUMNS.find((column) => column.id === columnId);

// ---------------------------------------------------------------------------
// 視圖狀態持久化（localStorage）
// ---------------------------------------------------------------------------

export interface ScreenerViewState {
  hiddenIds: string[];
  sort: ScreenerSortState | null;
  filters: Record<string, string>;
  filtersOpen: boolean;
  presetId: string | null;
}

export const SCREENER_VIEW_STORAGE_KEY = 'dsa.screener.grid.v1';

export const createDefaultScreenerViewState = (): ScreenerViewState => ({
  hiddenIds: SCREENER_COLUMNS.filter((column) => !column.defaultVisible).map((column) => column.id),
  sort: null,
  filters: {},
  filtersOpen: false,
  presetId: 'core',
});

export const loadScreenerViewState = (): ScreenerViewState => {
  const fallback = createDefaultScreenerViewState();
  if (typeof window === 'undefined') {
    return fallback;
  }
  try {
    const raw = window.localStorage.getItem(SCREENER_VIEW_STORAGE_KEY);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<ScreenerViewState>;
    const knownIds = new Set(SCREENER_COLUMNS.map((column) => column.id));
    const hiddenIds = Array.isArray(parsed.hiddenIds)
      ? [...new Set(parsed.hiddenIds.filter((id): id is string => typeof id === 'string' && knownIds.has(id)))]
      : fallback.hiddenIds;
    const sort =
      parsed.sort && typeof parsed.sort === 'object' && typeof parsed.sort.columnId === 'string' && knownIds.has(parsed.sort.columnId)
        ? { columnId: parsed.sort.columnId, direction: parsed.sort.direction === 'asc' ? ('asc' as const) : ('desc' as const) }
        : null;
    const filters =
      parsed.filters && typeof parsed.filters === 'object'
        ? Object.fromEntries(
            Object.entries(parsed.filters)
              .filter(([key, value]) => knownIds.has(key) && typeof value === 'string')
              .map(([key, value]) => [key, value.slice(0, 48)]),
          )
        : {};
    return {
      hiddenIds,
      sort,
      filters,
      filtersOpen: parsed.filtersOpen === true,
      presetId: typeof parsed.presetId === 'string' ? parsed.presetId : null,
    };
  } catch {
    return fallback;
  }
};

export const saveScreenerViewState = (state: ScreenerViewState): void => {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(SCREENER_VIEW_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 持久化為 best-effort，失敗不影響表格使用
  }
};

/** 由 hiddenIds 解析當前可見欄目（保持目錄順序） */
export const resolveVisibleScreenerColumns = (hiddenIds: string[]): ScreenerColumnDef[] => {
  const hidden = new Set(hiddenIds);
  return SCREENER_COLUMNS.filter((column) => !hidden.has(column.id));
};

// ---------------------------------------------------------------------------
// 搜索 / 篩選 / 排序
// ---------------------------------------------------------------------------

type NumericFilterNode =
  | { op: 'gte' | 'lte' | 'gt' | 'lt' | 'eq'; value: number }
  | { op: 'between'; min: number; max: number };
type TextFilterNode = { op: 'text'; text: string };
type ScreenerFilterNode = NumericFilterNode | TextFilterNode;

/**
 * 解析單欄篩選表達式：
 * - `>10` `>=10` `<20` `<=20`：比較
 * - `5~20`（亦接受 `5..20`）：區間
 * - 其他非空文本：數值欄精確匹配 / 文本欄包含匹配（不區分大小寫）
 */
export const parseScreenerFilter = (rawQuery: string): ScreenerFilterNode | null => {
  const query = rawQuery.trim();
  if (!query) {
    return null;
  }
  const range =
    query.match(/^(-?\d+(?:\.\d+)?)\s*(?:~|\.\.)\s*(-?\d+(?:\.\d+)?)$/) ||
    query.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    if (Number.isFinite(min) && Number.isFinite(max)) {
      return { op: 'between', min: Math.min(min, max), max: Math.max(min, max) };
    }
  }
  const compare = query.match(/^(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/);
  if (compare) {
    const value = Number(compare[2]);
    if (Number.isFinite(value)) {
      const op = compare[1] as '>=' | '<=' | '>' | '<';
      return { op: op === '>=' ? 'gte' : op === '<=' ? 'lte' : op === '>' ? 'gt' : 'lt', value };
    }
  }
  const exact = Number(query.replace(/,/g, ''));
  if (Number.isFinite(exact) && /^-?\d+(?:\.\d+)?$/.test(query.replace(/,/g, ''))) {
    return { op: 'eq', value: exact };
  }
  return { op: 'text', text: query.toLowerCase() };
};

const SCREENER_SEARCH_FIELDS = (row: ScreeningCandidate): string[] => {
  const raw = rawRecord(row);
  return [
    row.code,
    row.name,
    row.industry,
    row.llmTheme,
    Array.isArray(raw.concepts)
      ? (raw.concepts as unknown[]).map((item) => String(item)).join(' ')
      : typeof raw.concepts === 'string'
        ? raw.concepts
        : ' ',
  ].map((value) => String(value ?? '').toLowerCase());
};

export const searchScreenerRows = (rows: ScreeningCandidate[], query: string): ScreeningCandidate[] => {
  const keyword = query.trim().toLowerCase();
  if (!keyword) {
    return rows;
  }
  return rows.filter((row) => SCREENER_SEARCH_FIELDS(row).some((field) => field.includes(keyword)));
};

export const filterScreenerRows = (
  rows: ScreeningCandidate[],
  filters: Record<string, string>,
): ScreeningCandidate[] => {
  const activeFilters = Object.entries(filters).filter(([, query]) => query.trim());
  if (activeFilters.length === 0) {
    return rows;
  }
  return rows.filter((row) =>
    activeFilters.every(([columnId, query]) => {
      const column = getScreenerColumn(columnId);
      if (!column) {
        return true;
      }
      const node = parseScreenerFilter(query);
      if (!node) {
        return true;
      }
      const value = column.getValue ? column.getValue(row) : topOrRaw(row, column.id);
      if (node.op === 'text') {
        return String(value ?? '').toLowerCase().includes(node.text);
      }
      const numeric = toNumber(value);
      if (numeric == null) {
        return false;
      }
      switch (node.op) {
        case 'gte':
          return numeric >= node.value;
        case 'lte':
          return numeric <= node.value;
        case 'gt':
          return numeric > node.value;
        case 'lt':
          return numeric < node.value;
        case 'eq':
          return Math.abs(numeric - node.value) < 1e-6;
        case 'between':
          return numeric >= node.min && numeric <= node.max;
        default:
          return true;
      }
    }),
  );
};

const RISK_SORT_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, '': 0 };

const nonNumericComparable = (column: ScreenerColumnDef, value: ScreenerCellValue): number | string | null => {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }
  if (column.format === 'riskBadge') {
    return RISK_SORT_RANK[text.toLowerCase()] ?? -1;
  }
  return text;
};

/** 排序；空值恆排最後，與方向無關 */
export const sortScreenerRows = (
  rows: ScreeningCandidate[],
  sort: ScreenerSortState | null,
): ScreeningCandidate[] => {
  if (!sort) {
    return rows;
  }
  const column = getScreenerColumn(sort.columnId);
  if (!column) {
    return rows;
  }
  const factor = sort.direction === 'asc' ? 1 : -1;
  const readValue = (row: ScreeningCandidate): ScreenerCellValue =>
    column.getValue ? column.getValue(row) : topOrRaw(row, column.id);
  if (column.numeric) {
    return [...rows].sort((left, right) => {
      const leftNumber = toNumber(readValue(left));
      const rightNumber = toNumber(readValue(right));
      if (leftNumber == null && rightNumber == null) {
        return (left.rank ?? 0) - (right.rank ?? 0);
      }
      if (leftNumber == null) {
        return 1;
      }
      if (rightNumber == null) {
        return -1;
      }
      if (leftNumber === rightNumber) {
        return (left.rank ?? 0) - (right.rank ?? 0);
      }
      return (leftNumber - rightNumber) * factor;
    });
  }
  return [...rows].sort((left, right) => {
    const leftValue = nonNumericComparable(column, readValue(left));
    const rightValue = nonNumericComparable(column, readValue(right));
    if (leftValue == null && rightValue == null) {
      return (left.rank ?? 0) - (right.rank ?? 0);
    }
    if (leftValue == null) {
      return 1;
    }
    if (rightValue == null) {
      return -1;
    }
    const compared =
      typeof leftValue === 'number' && typeof rightValue === 'number'
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue), 'zh-Hans-CN');
    if (compared === 0) {
      return (left.rank ?? 0) - (right.rank ?? 0);
    }
    return compared * factor;
  });
};

// ---------------------------------------------------------------------------
// 格式化與 CSV 匯出
// ---------------------------------------------------------------------------

export const formatScreenerCellText = (
  column: ScreenerColumnDef,
  value: ScreenerCellValue,
  formatCompactAmount: (amount: number) => string,
): string => {
  if (column.format === 'bool') {
    return value === true ? '1' : '0';
  }
  if (column.format === 'riskBadge' || column.format === 'status' || column.format === 'text') {
    return String(value ?? '').trim();
  }
  const numeric = toNumber(value);
  if (numeric == null) {
    return '-';
  }
  switch (column.format) {
    case 'price':
      return numeric.toFixed(2);
    case 'number':
      return numeric.toFixed(column.digits ?? 2);
    case 'integer':
      return String(Math.round(numeric));
    case 'percent':
      return `${numeric.toFixed(column.digits ?? 2)}%`;
    case 'percentSigned':
      return `${numeric > 0 ? '+' : ''}${numeric.toFixed(column.digits ?? 2)}%`;
    case 'confidence':
      return `${(numeric * 100).toFixed(0)}%`;
    case 'score':
      return numeric.toFixed(2);
    case 'amount':
      return formatCompactAmount(numeric);
    default:
      return String(value ?? '-');
  }
};

/** 匯出當前可見行列為 CSV（含 BOM，便於 Excel 直接打開中文；金額欄輸出原始數值便於離線計算） */
export const buildScreenerCsv = (
  rows: ScreeningCandidate[],
  columns: ScreenerColumnDef[],
  labelOf: (column: ScreenerColumnDef) => string,
  codeLabel: string,
  nameLabel: string,
): string => {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const header = ['#', codeLabel, nameLabel, ...columns.map(labelOf)]
    .map(escape)
    .join(',');
  const lines = rows.map((row) => {
    const cells = columns.map((column) => {
      const value = column.getValue ? column.getValue(row) : topOrRaw(row, column.id);
      const text =
        column.format === 'amount'
          ? String(toNumber(value) ?? '')
          : formatScreenerCellText(column, value, (amount) => String(amount));
      return escape(text);
    });
    return [String(row.rank ?? ''), escape(row.code || ''), escape(row.name || ''), ...cells].join(',');
  });
  return `\uFEFF${[header, ...lines].join('\r\n')}`;
};

/** 觸發瀏覽器下載（Blob + 臨時 <a>） */
export const downloadScreenerCsv = (csv: string, filename: string): void => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

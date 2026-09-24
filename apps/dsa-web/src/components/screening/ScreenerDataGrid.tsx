import type React from 'react';
import { ChevronDown, ChevronUp, ChevronsUpDown, Play } from 'lucide-react';
import type { ScreeningCandidate } from '../../api/screening';
import { useUiLanguage } from '../../contexts/UiLanguageContext';
import { cn } from '../../utils/cn';
import { formatCompactCnAmount } from '../../utils/format';
import {
  formatScreenerCellText,
  type ScreenerColumnDef,
  type ScreenerCellValue,
  type ScreenerSortState,
} from '../../utils/screenerColumns';
import type { UiTextKey } from '../../i18n/uiText';

interface ScreenerDataGridProps {
  rows: ScreeningCandidate[];
  columns: ScreenerColumnDef[];
  sort: ScreenerSortState | null;
  onToggleSort: (columnId: string) => void;
  filters: Record<string, string>;
  onFilterChange: (columnId: string, value: string) => void;
  filtersOpen: boolean;
  expandedCode: string | null;
  onToggleExpanded: (code: string | null) => void;
  onAnalyze: (row: ScreeningCandidate) => void;
  onClearFilters: () => void;
  renderExpanded: (row: ScreeningCandidate) => React.ReactNode;
}

const STATUS_LABEL_KEYS: Record<string, UiTextKey> = {
  bearish: 'screener.statusBearish',
  bullish: 'screener.statusBullish',
  deadcross: 'screener.statusDeadCross',
  goldencross: 'screener.statusGoldenCross',
  overbought: 'screener.statusOverbought',
  oversold: 'screener.statusOversold',
  neutral: 'screener.statusNeutral',
};

const prettifyStatus = (value: string) => value.replace(/_/g, ' ').trim();

const getRiskBadgeClassName = (riskLevel: string) => {
  if (riskLevel === 'high') {
    return 'bg-danger/10 text-danger';
  }
  if (riskLevel === 'medium') {
    return 'bg-warning/10 text-warning';
  }
  if (riskLevel === 'low') {
    return 'bg-success/10 text-success';
  }
  return 'bg-elevated text-secondary-text';
};

/**
 * TradingView 式選股結果網格：密集行、可排序指標欄、行內快速篩選、
 * 凍結左側代碼列、漲跌著色（A 股慣例：漲紅跌綠）。
 */
export const ScreenerDataGrid: React.FC<ScreenerDataGridProps> = ({
  rows,
  columns,
  sort,
  onToggleSort,
  filters,
  onFilterChange,
  filtersOpen,
  expandedCode,
  onToggleExpanded,
  onAnalyze,
  onClearFilters,
  renderExpanded,
}) => {
  const { t } = useUiLanguage();
  const colCount = columns.length + 3; // # + 代碼 + 指標欄 + 操作

  const renderCellContent = (row: ScreeningCandidate, column: ScreenerColumnDef) => {
    const value: ScreenerCellValue = column.getValue ? column.getValue(row) : undefined;
    switch (column.format) {
      case 'percentSigned': {
        const numeric = Number(value);
        const text = formatScreenerCellText(column, value, formatCompactCnAmount);
        if (Number.isFinite(numeric) && numeric !== 0) {
          const up = numeric > 0;
          return (
            <span
              className="num font-semibold"
              style={{ color: up ? 'var(--home-price-up)' : 'var(--home-price-down)' }}
            >
              {text}
            </span>
          );
        }
        return <span className="num text-secondary-text">{text}</span>;
      }
      case 'score':
        return <span className="num font-bold text-cyan">{formatScreenerCellText(column, value, formatCompactCnAmount)}</span>;
      case 'bool':
        return value === true ? (
          <span className="font-bold" style={{ color: 'var(--home-price-up)' }}>
            ✓
          </span>
        ) : (
          <span className="text-secondary-text">—</span>
        );
      case 'riskBadge': {
        const level = String(value ?? '');
        const label =
          level === 'high'
            ? t('screener.riskHigh')
            : level === 'medium'
              ? t('screener.riskMedium')
              : level === 'low'
                ? t('screener.riskLow')
                : t('screener.riskPending');
        return (
          <span className={cn('inline-flex rounded-lg px-2 py-0.5 text-xs font-semibold', getRiskBadgeClassName(level))}>
            {label}
          </span>
        );
      }
      case 'status': {
        const raw = String(value ?? '').trim();
        if (!raw) {
          return <span className="text-secondary-text">—</span>;
        }
        const labelKey = STATUS_LABEL_KEYS[raw.toLowerCase().replace(/_/g, '')];
        return (
          <span className="inline-flex max-w-[8rem] truncate rounded-md border border-border/70 bg-surface px-1.5 py-0.5 text-[11px] font-medium text-secondary-text">
            {labelKey ? t(labelKey) : prettifyStatus(raw)}
          </span>
        );
      }
      case 'text': {
        const text = String(value ?? '').trim();
        return (
          <span className="block max-w-[9rem] truncate text-secondary-text">{text || '-'}</span>
        );
      }
      default:
        return (
          <span className="num text-secondary-text">
            {formatScreenerCellText(column, value, formatCompactCnAmount)}
          </span>
        );
    }
  };

  const isNumericAlign = (column: ScreenerColumnDef) => column.format !== 'text' && column.format !== 'status' && column.format !== 'riskBadge';

  return (
    <div className="overflow-hidden rounded-xl border border-border/80 bg-card">
      <div className="screener-grid-scroll max-h-[34rem] overflow-auto">
        <table className="w-full border-collapse text-[13px]" style={{ minWidth: 340 + columns.length * 88 }}>
          <thead className="sticky top-0 z-20">
            <tr className="screener-head-row text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-secondary-text">
              <th className="screener-sticky screener-sticky-rank w-12 px-3 py-2.5 text-center">#</th>
              <th className="screener-sticky screener-sticky-code min-w-[8.5rem] px-3 py-2.5">
                {t('screener.colCode')}
              </th>
              {columns.map((column) => {
                const active = sort?.columnId === column.id;
                const ariaSort = active ? (sort?.direction === 'asc' ? 'ascending' : 'descending') : undefined;
                return (
                  <th key={column.id} aria-sort={ariaSort} className="px-2 py-0 font-semibold">
                    <button
                      type="button"
                      onClick={() => onToggleSort(column.id)}
                      aria-label={`${t(column.labelKey)} ${active ? (sort?.direction === 'asc' ? t('screener.sortAscending') : t('screener.sortDescending')) : t('screener.sortNone')}`}
                      className={cn(
                        'group flex w-full items-center gap-1 py-2.5 transition-colors hover:text-foreground',
                        isNumericAlign(column) ? 'justify-end' : 'justify-start',
                        active ? 'text-cyan' : '',
                      )}
                    >
                      <span className="truncate">{t(column.labelKey)}</span>
                      {active ? (
                        sort?.direction === 'asc' ? (
                          <ChevronUp className="h-3 w-3 shrink-0" aria-hidden="true" />
                        ) : (
                          <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
                        )
                      ) : (
                        <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" aria-hidden="true" />
                      )}
                    </button>
                  </th>
                );
              })}
              <th className="px-3 py-2.5 text-center">{t('screener.colActions')}</th>
            </tr>
            {filtersOpen ? (
              <tr className="screener-filter-row">
                <th className="screener-sticky screener-sticky-rank px-1 pb-2" />
                <th className="screener-sticky screener-sticky-code px-1 pb-2" />
                {columns.map((column) => (
                  <th key={column.id} className="px-1 pb-2">
                    <input
                      value={filters[column.id] ?? ''}
                      onChange={(event) => onFilterChange(column.id, event.target.value)}
                      placeholder={column.numeric ? '>10' : t('screener.filterContains')}
                      aria-label={`${t(column.labelKey)} ${t('screener.filter')}`}
                      className="screener-filter-input h-7 w-full min-w-[4.5rem] rounded-md border px-2 text-[11px] font-normal normal-case tracking-normal outline-none transition-colors focus:border-cyan"
                    />
                  </th>
                ))}
                <th className="px-1 pb-2" />
              </tr>
            ) : null}
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="px-4 py-12 text-center">
                  <p className="text-sm font-medium text-foreground">{t('screener.noFilterMatch')}</p>
                  <button
                    type="button"
                    onClick={onClearFilters}
                    className="mt-2 text-xs font-semibold text-cyan transition-colors hover:text-foreground"
                  >
                    {t('screener.clearFilters')}
                  </button>
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const expanded = expandedCode === row.code;
                return (
                  [
                    <tr
                      key={`${row.rank}-${row.code}`}
                      className={cn(
                        'screener-row cursor-pointer border-t border-border/60 transition-colors',
                        expanded ? 'screener-row-expanded' : 'hover:bg-hover/45',
                      )}
                      onClick={() => onToggleExpanded(expanded ? null : row.code)}
                    >
                      <td className="screener-sticky screener-sticky-rank px-3 py-2 text-center text-xs text-secondary-text">
                        <span className="num">{row.rank}</span>
                      </td>
                      <td className="screener-sticky screener-sticky-code px-3 py-2">
                        <span className="block font-mono text-[13px] font-semibold leading-4 text-foreground">{row.code}</span>
                        <span className="block max-w-[8rem] truncate text-[11px] leading-4 text-secondary-text">
                          {row.name || '-'}
                        </span>
                      </td>
                      {columns.map((column) => (
                        <td
                          key={column.id}
                          className={cn('px-2 py-2', isNumericAlign(column) ? 'text-right' : 'text-left')}
                        >
                          {renderCellContent(row, column)}
                        </td>
                      ))}
                      <td className="px-3 py-2 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            type="button"
                            aria-label={`${t('screener.analyze')} ${row.name || row.code}`}
                            className="grid h-7 w-7 place-items-center rounded-lg border border-cyan/30 text-cyan transition-colors hover:bg-cyan/10"
                            onClick={(event) => {
                              event.stopPropagation();
                              onAnalyze(row);
                            }}
                          >
                            <Play className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            aria-label={expanded ? t('screener.collapse') : t('screener.expand')}
                            className="grid h-7 w-7 place-items-center rounded-lg text-secondary-text transition-colors hover:bg-hover hover:text-foreground"
                            onClick={(event) => {
                              event.stopPropagation();
                              onToggleExpanded(expanded ? null : row.code);
                            }}
                          >
                            <ChevronDown
                              className={cn('h-3.5 w-3.5 transition-transform', expanded ? 'rotate-180' : '')}
                              aria-hidden="true"
                            />
                          </button>
                        </div>
                      </td>
                    </tr>,
                    expanded ? (
                      <tr key={`${row.rank}-${row.code}-detail`} className="screener-detail-row border-t border-border/60">
                        <td colSpan={colCount} className="px-4 py-4">
                          {renderExpanded(row)}
                        </td>
                      </tr>
                    ) : null,
                  ]
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default ScreenerDataGrid;

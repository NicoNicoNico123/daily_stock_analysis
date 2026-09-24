import type React from 'react';
import { Download, Filter, Search, X } from 'lucide-react';
import { useUiLanguage } from '../../contexts/UiLanguageContext';
import { cn } from '../../utils/cn';
import { ColumnPickerMenu } from './ColumnPickerMenu';

interface ScreenerToolbarProps {
  search: string;
  onSearchChange: (value: string) => void;
  filtersOpen: boolean;
  onToggleFilters: () => void;
  filters: Record<string, string>;
  onRemoveFilter: (columnId: string) => void;
  onClearFilters: () => void;
  shownCount: number;
  totalCount: number;
  onExport: () => void;
  hiddenIds: string[];
  presetId: string | null;
  visibleColumnCount: number;
  onToggleColumn: (columnId: string) => void;
  onApplyPreset: (presetId: string) => void;
  onResetLayout: () => void;
  getColumnLabel: (columnId: string) => string;
}

/**
 * 選股結果工具列：搜索 / 指標欄 / 快速篩選 / CSV 匯出 / 結果計數。
 */
export const ScreenerToolbar: React.FC<ScreenerToolbarProps> = ({
  search,
  onSearchChange,
  filtersOpen,
  onToggleFilters,
  filters,
  onRemoveFilter,
  onClearFilters,
  shownCount,
  totalCount,
  onExport,
  hiddenIds,
  presetId,
  visibleColumnCount,
  onToggleColumn,
  onApplyPreset,
  onResetLayout,
  getColumnLabel,
}) => {
  const activeFilterEntries = Object.entries(filters).filter(([, query]) => query.trim());
  const activeFilterCount = activeFilterEntries.length;
  const { t } = useUiLanguage();
  const hasFilters = activeFilterCount > 0;

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[11rem] flex-1 sm:max-w-[17rem]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary-text" aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t('screener.searchPlaceholder')}
            aria-label={t('screener.searchPlaceholder')}
            className="h-9 w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-sm text-foreground outline-none transition-colors placeholder:text-secondary-text focus:border-cyan"
          />
        </div>

        <ColumnPickerMenu
          hiddenIds={hiddenIds}
          presetId={presetId}
          activeCount={visibleColumnCount}
          onToggleColumn={onToggleColumn}
          onApplyPreset={onApplyPreset}
          onReset={onResetLayout}
        />

        <button
          type="button"
          onClick={onToggleFilters}
          aria-pressed={filtersOpen}
          className={cn(
            'inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-all',
            filtersOpen || hasFilters
              ? 'border-cyan/50 bg-cyan/10 text-cyan'
              : 'border-border/70 bg-card text-foreground shadow-soft-card hover:bg-hover',
          )}
        >
          <Filter className="h-4 w-4" aria-hidden="true" />
          {t('screener.filters')}
          {hasFilters ? (
            <span className="num rounded-md bg-cyan/12 px-1.5 text-xs font-semibold">{activeFilterCount}</span>
          ) : null}
        </button>

        <button
          type="button"
          onClick={onExport}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border/70 bg-card px-3 text-sm font-medium text-foreground shadow-soft-card transition-all hover:bg-hover"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          {t('screener.exportCsv')}
        </button>

        <span className="num ml-auto text-xs text-secondary-text">
          {t('screener.shownCount', { shown: shownCount, total: totalCount })}
        </span>
      </div>

      {hasFilters ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-secondary-text">
            {t('screener.activeFilters')}
          </span>
          {activeFilterEntries.map(([columnId, query]) => (
            <button
              key={columnId}
              type="button"
              onClick={() => onRemoveFilter(columnId)}
              className="inline-flex items-center gap-1 rounded-full border border-cyan/40 bg-cyan/10 px-2.5 py-0.5 text-[11px] font-semibold text-cyan transition-colors hover:bg-cyan/20"
            >
              {getColumnLabel(columnId)}: {query.trim()}
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          ))}
          <button
            type="button"
            onClick={onClearFilters}
            className="text-[11px] font-semibold text-secondary-text underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            {t('screener.clearFilters')}
          </button>
        </div>
      ) : null}
    </div>
  );
};

export default ScreenerToolbar;

import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Columns3, RotateCcw, Search } from 'lucide-react';
import { useUiLanguage } from '../../contexts/UiLanguageContext';
import { cn } from '../../utils/cn';
import {
  SCREENER_COLUMNS,
  SCREENER_COLUMN_GROUP_ORDER,
  SCREENER_PRESETS,
  type ScreenerColumnDef,
  type ScreenerColumnGroupId,
} from '../../utils/screenerColumns';
import type { UiTextKey } from '../../i18n/uiText';

const GROUP_LABEL_KEYS: Record<ScreenerColumnGroupId, UiTextKey> = {
  core: 'screener.groupCore',
  ai: 'screener.groupAi',
  valuation: 'screener.groupValuation',
  technical: 'screener.groupTechnical',
  heat: 'screener.groupHeat',
  risk: 'screener.groupRisk',
};

interface ColumnPickerMenuProps {
  hiddenIds: string[];
  presetId: string | null;
  activeCount: number;
  onToggleColumn: (columnId: string) => void;
  onApplyPreset: (presetId: string) => void;
  onReset: () => void;
}

/**
 * TradingView 式「指標欄」選擇器：分組勾選 + 欄目搜索 + 版面預設。
 */
export const ColumnPickerMenu: React.FC<ColumnPickerMenuProps> = ({
  hiddenIds,
  presetId,
  activeCount,
  onToggleColumn,
  onApplyPreset,
  onReset,
}) => {
  const { t } = useUiLanguage();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) {
      return;
    }
    const triggerRect = trigger.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const margin = 8;
    let left = triggerRect.right - panelRect.width;
    left = Math.max(margin, Math.min(left, window.innerWidth - panelRect.width - margin));
    let top = triggerRect.bottom + 8;
    if (top + panelRect.height > window.innerHeight - margin) {
      top = Math.max(margin, triggerRect.top - panelRect.height - 8);
    }
    setPosition({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    // 同步測量避免面板以 (0,0) 先繪一幀
    updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      // 焦點返還觸發按鈕，避免關閉後焦點落空
      if (triggerRef.current && document.activeElement && !triggerRef.current.contains(document.activeElement)) {
        triggerRef.current.focus();
      }
    };
  }, [open, updatePosition]);

  const normalizedKeyword = keyword.trim().toLowerCase();
  const matchesKeyword = useCallback(
    (column: ScreenerColumnDef) =>
      !normalizedKeyword ||
      t(column.labelKey).toLowerCase().includes(normalizedKeyword) ||
      column.id.toLowerCase().includes(normalizedKeyword),
    [normalizedKeyword, t],
  );

  const groupedColumns = SCREENER_COLUMN_GROUP_ORDER.map((groupId) => ({
    groupId,
    columns: SCREENER_COLUMNS.filter((column) => column.group === groupId && matchesKeyword(column)),
  })).filter((group) => group.columns.length > 0);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-all',
          open
            ? 'border-cyan/50 bg-cyan/10 text-cyan'
            : 'border-border/70 bg-card text-foreground shadow-soft-card hover:bg-hover',
        )}
      >
        <Columns3 className="h-4 w-4" aria-hidden="true" />
        {t('screener.columns')}
        <span className="num rounded-md bg-cyan/10 px-1.5 text-xs font-semibold text-cyan">{activeCount}</span>
      </button>

      {typeof document !== 'undefined' && open
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label={t('screener.columns')}
              style={{ position: 'fixed', top: position.top, left: position.left }}
              className="z-[120] flex max-h-[70vh] w-[19rem] flex-col overflow-hidden rounded-xl border border-border/80 bg-elevated/97 shadow-[0_24px_64px_rgba(3,8,20,0.28)] backdrop-blur-xl"
            >
              <div className="space-y-2.5 border-b border-border/70 p-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-secondary-text" aria-hidden="true" />
                  <input
                    value={keyword}
                    autoFocus
                    aria-label={t('screener.columnSearchPlaceholder')}
                    onChange={(event) => setKeyword(event.target.value)}
                    placeholder={t('screener.columnSearchPlaceholder')}
                    className="h-8 w-full rounded-lg border border-border bg-surface pl-8 pr-2 text-xs text-foreground outline-none transition-colors placeholder:text-secondary-text focus:border-cyan"
                  />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {SCREENER_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => onApplyPreset(preset.id)}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors',
                        presetId === preset.id
                          ? 'border-cyan/60 bg-cyan/12 text-cyan'
                          : 'border-border/70 bg-surface text-secondary-text hover:border-cyan/40 hover:text-foreground',
                      )}
                    >
                      {t(preset.labelKey)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex-1 space-y-3 overflow-y-auto p-3">
                {groupedColumns.length === 0 ? (
                  <p className="py-6 text-center text-xs text-secondary-text">{t('screener.columnSearchEmpty')}</p>
                ) : (
                  groupedColumns.map(({ groupId, columns }) => (
                    <div key={groupId}>
                      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-secondary-text">
                        {t(GROUP_LABEL_KEYS[groupId])}
                      </p>
                      <div className="grid grid-cols-1 gap-0.5">
                        {columns.map((column) => {
                          const visible = !hiddenIds.includes(column.id);
                          return (
                            <label
                              key={column.id}
                              className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors hover:bg-hover"
                            >
                              <span
                                className={cn(
                                  'grid h-4 w-4 shrink-0 place-items-center rounded border transition-colors',
                                  visible ? 'border-cyan bg-cyan text-white' : 'border-border-subtle bg-surface',
                                )}
                              >
                                {visible ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
                              </span>
                              <input
                                type="checkbox"
                                className="sr-only"
                                checked={visible}
                                onChange={() => onToggleColumn(column.id)}
                              />
                              <span className={cn('flex-1 truncate', visible ? 'text-foreground' : 'text-secondary-text')}>
                                {t(column.labelKey)}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="flex items-center justify-between border-t border-border/70 p-2.5">
                <button
                  type="button"
                  onClick={onReset}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-secondary-text transition-colors hover:bg-hover hover:text-foreground"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('screener.resetLayout')}
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-lg bg-cyan/12 px-3 py-1.5 text-xs font-semibold text-cyan transition-colors hover:bg-cyan/20"
                >
                  {t('screener.done')}
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
};

export default ColumnPickerMenu;

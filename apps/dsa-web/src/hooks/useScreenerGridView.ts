import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ScreeningCandidate } from '../api/screening';
import {
  filterScreenerRows,
  loadScreenerViewState,
  resolveVisibleScreenerColumns,
  saveScreenerViewState,
  SCREENER_PRESETS,
  searchScreenerRows,
  sortScreenerRows,
  type ScreenerSortState,
  type ScreenerViewState,
} from '../utils/screenerColumns';

/**
 * Screener 表格視圖狀態（搜索 / 排序 / 欄目可見性 / 快速篩選），
 * 持久化到 localStorage 以便刷新後保持用戶版面。
 */
export const useScreenerGridView = (rows: ScreeningCandidate[]) => {
  const [view, setView] = useState<ScreenerViewState>(() => loadScreenerViewState());
  const [search, setSearch] = useState('');

  const updateView = useCallback((patch: Partial<ScreenerViewState>) => {
    setView((current) => ({ ...current, ...patch }));
  }, []);

  // 持久化統一收口在 effect：state updater 保持純函數（StrictMode 雙調用安全）
  useEffect(() => {
    saveScreenerViewState(view);
  }, [view]);

  const visibleColumns = useMemo(() => resolveVisibleScreenerColumns(view.hiddenIds), [view.hiddenIds]);

  const processedRows = useMemo(() => {
    const searched = searchScreenerRows(rows, search);
    const filtered = filterScreenerRows(searched, view.filters);
    return sortScreenerRows(filtered, view.sort);
  }, [rows, search, view.filters, view.sort]);

  const activeFilterCount = useMemo(
    () => Object.values(view.filters).filter((query) => query.trim()).length,
    [view.filters],
  );

  const toggleSort = useCallback(
    (columnId: string) => {
      setView((current) => {
        const previous = current.sort;
        // 數值欄循環：降序 → 升序 → 關閉（貼合行情軟件先看最大值的習慣）
        const next: ScreenerSortState | null =
          previous?.columnId !== columnId
            ? { columnId, direction: 'desc' }
            : previous.direction === 'desc'
              ? { columnId, direction: 'asc' }
              : null;
        return { ...current, sort: next };
      });
    },
    [],
  );

  const setFilter = useCallback(
    (columnId: string, value: string) => {
      setView((current) => {
        const nextFilters = { ...current.filters };
        if (value.trim()) {
          nextFilters[columnId] = value;
        } else {
          delete nextFilters[columnId];
        }
        return { ...current, filters: nextFilters };
      });
    },
    [],
  );

  const clearFilters = useCallback(() => {
    updateView({ filters: {} });
  }, [updateView]);

  const toggleColumn = useCallback(
    (columnId: string) => {
      setView((current) => {
        const hidden = new Set(current.hiddenIds);
        if (hidden.has(columnId)) {
          hidden.delete(columnId);
        } else {
          hidden.add(columnId);
        }
        // 隱藏欄目時同步清理其排序與篩選，避免殘留不可見條件
        const nextSort = current.sort && !hidden.has(current.sort.columnId) ? current.sort : null;
        const nextFilters = Object.fromEntries(
          Object.entries(current.filters).filter(([key]) => !hidden.has(key)),
        );
        return { ...current, hiddenIds: [...hidden], sort: nextSort, filters: nextFilters, presetId: null };
      });
    },
    [],
  );

  const applyPreset = useCallback(
    (presetId: string) => {
      const preset = SCREENER_PRESETS.find((item) => item.id === presetId);
      if (!preset) {
        return;
      }
      const visible = new Set(preset.columnIds);
      // 以 preset 的可見集合反推 hiddenIds：未列入的欄目全部隱藏；
      // 與 toggleColumn 同契約——隱藏欄目時同步清理其排序與篩選
      const allIds = resolveVisibleScreenerColumns([]).map((column) => column.id);
      const nextHidden = allIds.filter((id) => !visible.has(id));
      updateView({
        hiddenIds: nextHidden,
        sort: view.sort && visible.has(view.sort.columnId) ? view.sort : null,
        filters: Object.fromEntries(
          Object.entries(view.filters).filter(([key]) => visible.has(key)),
        ),
        presetId,
      });
    },
    [updateView, view.filters, view.sort],
  );

  const resetView = useCallback(() => {
    setSearch('');
    updateView({
      hiddenIds: resolveVisibleScreenerColumns([])
        .filter((column) => !column.defaultVisible)
        .map((column) => column.id),
      sort: null,
      filters: {},
      filtersOpen: false,
      presetId: 'core',
    });
  }, [updateView]);

  const setFiltersOpen = useCallback(
    (open: boolean) => {
      updateView({ filtersOpen: open });
    },
    [updateView],
  );

  return {
    view,
    search,
    setSearch,
    visibleColumns,
    processedRows,
    activeFilterCount,
    toggleSort,
    setFilter,
    clearFilters,
    toggleColumn,
    applyPreset,
    resetView,
    setFiltersOpen,
  };
};

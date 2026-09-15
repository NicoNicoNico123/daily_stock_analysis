import { useCallback, useEffect, useRef, useState } from 'react';
import { extractResponseErrorCode } from '../api/me';
import { systemConfigApi } from '../api/systemConfig';
import { useUiLanguage } from '../contexts/UiLanguageContext';
import type { UiTextKey } from '../i18n/uiText';
import { findMatchingStockCode, includesStockCode } from '../utils/stockCode';

/**
 * 把自选股写接口的失败映射为用户可读文案。
 * 多用户模式下服务端返回 403 {detail:{error:'watchlist_cap'}} 与
 * 429 {error:'quota_exceeded'}，其余失败沿用原有提示。
 */
function getWatchlistActionError(error: unknown, translate: (key: UiTextKey) => string): string {
  const response = (error as { response?: { status?: number; data?: unknown } } | undefined)?.response;
  const status = response?.status;
  const errorCode = extractResponseErrorCode(response?.data);
  if (status === 403 && errorCode === 'watchlist_cap') {
    return translate('errors.watchlistCap');
  }
  if (status === 429 && errorCode === 'quota_exceeded') {
    return translate('errors.quotaExceeded');
  }
  return translate('watchlist.actionFailed');
}

export interface UseWatchlistReturn {
  watchlistCodes: string[];
  isLoading: boolean;
  isActioning: boolean;
  actionMessage: string | null;
  isInWatchlist: (stockCode: string) => boolean;
  addToWatchlist: (stockCode: string) => Promise<void>;
  removeFromWatchlist: (stockCode: string) => Promise<void>;
  toggleWatchlist: (stockCode: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useWatchlist(): UseWatchlistReturn {
  const { t } = useUiLanguage();
  const [codes, setCodes] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isActioning, setIsActioning] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const messageTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (messageTimerRef.current !== null) {
        window.clearTimeout(messageTimerRef.current);
      }
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const result = await systemConfigApi.getWatchlist();
      if (mountedRef.current) {
        setCodes(result);
      }
    } catch {
      // keep existing codes
    }
  }, []);

  useEffect(() => {
    setIsLoading(true);
    void refresh().finally(() => {
      if (mountedRef.current) {
        setIsLoading(false);
      }
    });
  }, [refresh]);

  const showMessage = useCallback((msg: string) => {
    if (messageTimerRef.current !== null) {
      window.clearTimeout(messageTimerRef.current);
    }
    setActionMessage(msg);
    messageTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current) {
        setActionMessage(null);
      }
    }, 3000);
  }, []);

  const isInWatchlist = useCallback(
    (stockCode: string) => includesStockCode(codes, stockCode),
    [codes],
  );

  const addToWatchlist = useCallback(async (stockCode: string) => {
    if (!stockCode || isActioning) return;
    setIsActioning(true);
    try {
      const result = await systemConfigApi.addToWatchlist(stockCode);
      if (mountedRef.current) {
        setCodes(result);
        showMessage(t('watchlist.added').replace('{code}', stockCode));
      }
    } catch (error: unknown) {
      if (mountedRef.current) showMessage(getWatchlistActionError(error, t));
    } finally {
      if (mountedRef.current) setIsActioning(false);
    }
  }, [isActioning, showMessage, t]);

  const removeFromWatchlist = useCallback(async (stockCode: string) => {
    if (!stockCode || isActioning) return;
    setIsActioning(true);
    try {
      const result = await systemConfigApi.removeFromWatchlist(stockCode);
      if (mountedRef.current) {
        setCodes(result);
        showMessage(t('watchlist.removed').replace('{code}', stockCode));
      }
    } catch (error: unknown) {
      if (mountedRef.current) showMessage(getWatchlistActionError(error, t));
    } finally {
      if (mountedRef.current) setIsActioning(false);
    }
  }, [isActioning, showMessage, t]);

  const toggleWatchlist = useCallback(async (stockCode: string) => {
    const existingStockCode = findMatchingStockCode(codes, stockCode);
    if (existingStockCode) {
      await removeFromWatchlist(existingStockCode);
    } else {
      await addToWatchlist(stockCode);
    }
  }, [codes, removeFromWatchlist, addToWatchlist]);

  return {
    watchlistCodes: codes,
    isLoading,
    isActioning,
    actionMessage,
    isInWatchlist,
    addToWatchlist,
    removeFromWatchlist,
    toggleWatchlist,
    refresh,
  };
}

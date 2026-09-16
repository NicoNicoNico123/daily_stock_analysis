# -*- coding: utf-8 -*-
"""
FinnhubFetcher — US market data source (Priority 2)

Data source: Finnhub.io REST API
Rate limit: 60 calls/min (free tier)
Markets: US only (free tier)

Capabilities:
- get_realtime_quote: US realtime quote (/quote)
- get_stock_name: US symbol name lookup (/search)
- get_daily_data: US daily K-line fallback (/stock/candle, resolution=D)
"""

import logging
import os
import re
import time
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

import pandas as pd
import requests

from .base import BaseFetcher, DataFetchError, STANDARD_COLUMNS
from .realtime_types import UnifiedRealtimeQuote, RealtimeSource
from .us_index_mapping import is_us_stock_code

logger = logging.getLogger(__name__)

_FINNHUB_BASE_URL = "https://finnhub.io/api/v1"
_CANDLE_RESOLUTION = "D"
_CANDLE_TIMEOUT_SECONDS = 15
_FORBIDDEN_HTTP_STATUS = 403
_RATE_LIMIT_HTTP_STATUS = 429
_RATE_LIMIT_RETRY_SLEEP_SECONDS = 1.0

# Request URLs embed the API token, so error text must be masked before logging.
_TOKEN_QUERY_PATTERN = re.compile(r"token=[^&\s]+")


def _redact_token(value: Any) -> str:
    """Mask the token query parameter so API keys never reach log output."""
    return _TOKEN_QUERY_PATTERN.sub("token=***", str(value))


class FinnhubFetcher(BaseFetcher):
    """US-market Finnhub fetcher (Priority 2).

    Supported capabilities:
    - ``get_realtime_quote``: US realtime quote
    - ``get_stock_name``: US symbol name lookup
    - ``get_daily_data``: US daily K-line fallback (resolution=D)

    ``get_daily_data`` returns ``None`` instead of raising when a single symbol
    cannot be served (no data, 403 premium restriction, 429 rate limit, network
    error). That keeps one restricted symbol from failing the whole US daily
    chain and from tripping the manager's daily-source circuit breaker.
    """

    name = "FinnhubFetcher"
    priority = 2

    def __init__(self):
        from src.config import get_config
        config = get_config()
        self._api_key = getattr(config, 'finnhub_api_key', None) or os.getenv('FINNHUB_API_KEY')
        if not self._api_key:
            logger.debug("[Finnhub] API key not configured, fetcher disabled")

    def _is_us_stock(self, stock_code: str) -> bool:
        return is_us_stock_code(stock_code)

    def _request_candles(
        self, symbol: str, from_date: str, to_date: str
    ) -> Optional[Dict[str, Any]]:
        """Call /stock/candle and return the raw JSON payload, or None.

        Any failure (403/429 rejection, network error, invalid payload) is
        logged as a diagnostic and reported as ``None`` so callers decide
        whether to raise or degrade gracefully. Request URLs are never logged
        because they carry the API token.
        """
        params = {
            'symbol': symbol,
            'resolution': _CANDLE_RESOLUTION,
            'from': from_date,
            'to': to_date,
            'token': self._api_key,
        }

        for attempt in (1, 2):
            try:
                self.random_sleep(0.3, 0.8)
                resp = requests.get(
                    f"{_FINNHUB_BASE_URL}/stock/candle",
                    params=params,
                    timeout=_CANDLE_TIMEOUT_SECONDS,
                )
                if resp.status_code == _RATE_LIMIT_HTTP_STATUS and attempt == 1:
                    logger.warning(
                        "[Finnhub] rate limited (429) for %s daily candles, retrying once",
                        symbol,
                    )
                    time.sleep(_RATE_LIMIT_RETRY_SLEEP_SECONDS)
                    continue
                if resp.status_code in (_RATE_LIMIT_HTTP_STATUS, _FORBIDDEN_HTTP_STATUS):
                    logger.warning(
                        "[Finnhub] daily candles rejected for %s: http_status=%d "
                        "(free tier covers US stocks only, not every symbol)",
                        symbol,
                        resp.status_code,
                    )
                    return None
                resp.raise_for_status()
                return resp.json()
            except Exception as e:
                logger.warning(
                    "[Finnhub] daily candle request failed for %s: %s",
                    symbol,
                    _redact_token(e),
                )
                return None
        return None

    def _fetch_raw_data(self, stock_code: str, start_date: str, end_date: str) -> pd.DataFrame:
        if not self._api_key:
            raise DataFetchError("[Finnhub] API key not configured")
        if not self._is_us_stock(stock_code):
            raise DataFetchError(f"[Finnhub] {stock_code} is not a US stock")

        symbol = stock_code.strip().upper()
        payload = self._request_candles(symbol, start_date, end_date)
        if not isinstance(payload, dict) or payload.get('s') != 'ok' or not payload.get('c'):
            raise DataFetchError(f"[Finnhub] No data returned for {symbol}")

        return pd.DataFrame({
            'c': payload['c'],
            'h': payload['h'],
            'l': payload['l'],
            'o': payload['o'],
            't': payload['t'],
            'v': payload['v'],
        })

    def get_daily_data(
        self,
        stock_code: str,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        days: int = 30,
        **kwargs,
    ) -> Optional[pd.DataFrame]:
        """Return normalized US daily K-line data, or None when unavailable.

        The returned frame matches the sibling fetchers (``STANDARD_COLUMNS``
        plus the shared indicators from ``BaseFetcher._calculate_indicators``),
        but per-symbol failures degrade to ``None`` instead of raising
        ``DataFetchError``. ``start_date`` is honored when callers pass an
        explicit window; otherwise the window is ``days * 2`` calendar days,
        matching the convention in ``BaseFetcher.get_daily_data``.
        """
        if not self._api_key:
            logger.debug(
                "[Finnhub] daily data skipped for %s: API key not configured", stock_code
            )
            return None
        if not self._is_us_stock(stock_code):
            logger.debug(
                "[Finnhub] daily data skipped for %s: not a US stock", stock_code
            )
            return None

        symbol = stock_code.strip().upper()
        end = end_date or datetime.now().strftime('%Y-%m-%d')
        try:
            end_dt = datetime.strptime(end, '%Y-%m-%d')
        except ValueError:
            logger.warning(
                "[Finnhub] daily data skipped for %s: invalid end_date=%r",
                stock_code,
                end_date,
            )
            return None
        if start_date:
            from_date = start_date
        else:
            from_date = (end_dt - timedelta(days=days * 2)).strftime('%Y-%m-%d')

        try:
            raw_df = self._fetch_raw_data(symbol, from_date, end)
            df = self._clean_data(self._normalize_data(raw_df, symbol))
            df = self._calculate_indicators(df)
        except DataFetchError as e:
            logger.warning("[Finnhub] daily data unavailable for %s: %s", symbol, e)
            return None
        except Exception as e:
            logger.warning(
                "[Finnhub] daily data failed for %s: %s", symbol, _redact_token(e)
            )
            return None

        if df is None or df.empty:
            logger.info(
                "[Finnhub] %s daily data empty: range=%s ~ %s", symbol, from_date, end
            )
            return None
        return df

    def _normalize_data(self, df: pd.DataFrame, stock_code: str) -> pd.DataFrame:
        if df.empty:
            return df

        df = df.copy()
        df['date'] = pd.to_datetime(df['t'], unit='s').dt.date
        df = df.rename(columns={
            'o': 'open', 'h': 'high', 'l': 'low',
            'c': 'close', 'v': 'volume',
        })
        df['pct_chg'] = df['close'].pct_change() * 100
        df['pct_chg'] = df['pct_chg'].fillna(0).round(2)
        df['amount'] = df['volume'] * df['close']
        df['code'] = stock_code

        keep = ['code'] + STANDARD_COLUMNS
        df = df[[col for col in keep if col in df.columns]]
        return df

    def get_realtime_quote(self, stock_code: str) -> Optional[UnifiedRealtimeQuote]:
        if not self._api_key or not self._is_us_stock(stock_code):
            return None

        symbol = stock_code.strip().upper()
        try:
            self.random_sleep(0.3, 0.8)
            resp = requests.get(
                f"{_FINNHUB_BASE_URL}/quote",
                params={'symbol': symbol, 'token': self._api_key},
                timeout=15,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            logger.warning(f"[Finnhub] Realtime quote failed for {symbol}: {e}")
            return None

        price = data.get('c')
        if not price:
            return None

        prev_close = data.get('pc', 0)
        change_pct = data.get('dp')
        change_amount = data.get('d')
        high = data.get('h')
        low = data.get('l')
        open_price = data.get('o')

        amplitude = None
        if high and low and prev_close and prev_close > 0:
            amplitude = round((high - low) / prev_close * 100, 2)

        return UnifiedRealtimeQuote(
            code=symbol,
            source=RealtimeSource.FALLBACK,
            price=price,
            change_pct=round(change_pct, 2) if change_pct is not None else None,
            change_amount=round(change_amount, 4) if change_amount is not None else None,
            volume=data.get('v'),
            amount=None,
            volume_ratio=None,
            turnover_rate=None,
            amplitude=amplitude,
            open_price=open_price,
            high=high,
            low=low,
            pre_close=prev_close,
        )

    def get_stock_name(self, stock_code: str) -> Optional[str]:
        if not self._api_key or not self._is_us_stock(stock_code):
            return None

        symbol = stock_code.strip().upper()
        try:
            resp = requests.get(
                f"{_FINNHUB_BASE_URL}/search",
                params={'q': symbol, 'token': self._api_key},
                timeout=10,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            logger.debug(f"[Finnhub] Symbol search failed for {symbol}: {e}")
            return None

        for item in data.get('result', []):
            if item.get('symbol') == symbol and item.get('description'):
                return item['description']
        return None

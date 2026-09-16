# -*- coding: utf-8 -*-
"""
TwelvedataFetcher — US market data source (last-resort fallback)

Data source: TwelveData REST API
Rate limit: 800 credits/day, 8 requests/min (free tier)
Markets: US only

Capabilities:
- get_daily_data: US daily K-line fallback (/time_series, interval=1day)
- get_realtime_quote: US realtime quote (/price, /quote 补昨收等字段)
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

_TWELVEDATA_BASE_URL = "https://api.twelvedata.com"
_DAILY_INTERVAL = "1day"
_REQUEST_TIMEOUT_SECONDS = 15
_UNAUTHORIZED_HTTP_STATUS = 401
_RATE_LIMIT_HTTP_STATUS = 429
_RATE_LIMIT_RETRY_SLEEP_SECONDS = 1.0
_MAX_OUTPUTSIZE = 5000

# Request URLs embed the API key, so error text must be masked before logging.
_API_KEY_QUERY_PATTERN = re.compile(r"apikey=[^&\s]+")


def _redact_api_key(value: Any) -> str:
    """Mask the apikey query parameter so API keys never reach log output."""
    return _API_KEY_QUERY_PATTERN.sub("apikey=***", str(value))


def _to_float(value: Any) -> Optional[float]:
    """TwelveData 以字符串返回数值，统一转换；空值/非法值返回 None。"""
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


class TwelvedataFetcher(BaseFetcher):
    """US-market TwelveData fetcher (last-resort fallback).

    Supported capabilities:
    - ``get_daily_data``: US daily K-line fallback (interval=1day)
    - ``get_realtime_quote``: US realtime quote (/price, /quote 补昨收)

    ``get_daily_data`` returns ``None`` instead of raising when a single symbol
    cannot be served (no data, 401 invalid key, 429 rate limit, network error).
    That keeps one rejected symbol from failing the whole US daily chain and
    from tripping the manager's daily-source circuit breaker. 免费档每日 800
    credits、每分钟 8 次请求，因此本源只作为美股链路的最后兜底。
    """

    name = "TwelvedataFetcher"
    priority = 6  # 低于 Longbridge(P5)，排在美股链路最后

    def __init__(self):
        from src.config import get_config
        config = get_config()
        self._api_key = getattr(config, 'twelvedata_api_key', None) or os.getenv('TWELVEDATA_API_KEY')
        if not self._api_key:
            logger.debug("[Twelvedata] API key not configured, fetcher disabled")

    def _is_us_stock(self, stock_code: str) -> bool:
        return is_us_stock_code(stock_code)

    def _request_json(self, endpoint: str, params: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Call a TwelveData endpoint and return the raw JSON payload, or None.

        429 先单次重试，仍被拒或 401 时记录诊断并返回 ``None``，由调用方决定
        降级方式。请求 URL 携带 apikey，任何异常文本落日志前都必须脱敏。
        """
        endpoint_path = endpoint.lstrip('/')
        request_params = dict(params)
        request_params['apikey'] = self._api_key
        symbol = request_params.get('symbol')

        for attempt in (1, 2):
            try:
                self.random_sleep(0.3, 0.8)
                resp = requests.get(
                    f"{_TWELVEDATA_BASE_URL}/{endpoint_path}",
                    params=request_params,
                    timeout=_REQUEST_TIMEOUT_SECONDS,
                )
                if resp.status_code == _RATE_LIMIT_HTTP_STATUS and attempt == 1:
                    logger.warning(
                        "[Twelvedata] rate limited (429) on /%s for %s, retrying once",
                        endpoint_path,
                        symbol,
                    )
                    time.sleep(_RATE_LIMIT_RETRY_SLEEP_SECONDS)
                    continue
                if resp.status_code in (_RATE_LIMIT_HTTP_STATUS, _UNAUTHORIZED_HTTP_STATUS):
                    logger.warning(
                        "[Twelvedata] request rejected on /%s for %s: http_status=%d "
                        "(free tier: 800 credits/day, 8 req/min)",
                        endpoint_path,
                        symbol,
                        resp.status_code,
                    )
                    return None
                resp.raise_for_status()
                payload = resp.json()
            except Exception as e:
                logger.warning(
                    "[Twelvedata] request failed on /%s for %s: %s",
                    endpoint_path,
                    symbol,
                    _redact_api_key(e),
                )
                return None
            # TwelveData 部分错误以 200 + 错误响应体返回，这里统一视为失败。
            if not isinstance(payload, dict) or payload.get('status') == 'error' or payload.get('error'):
                logger.warning(
                    "[Twelvedata] /%s returned error payload for %s: %s",
                    endpoint_path,
                    symbol,
                    _redact_api_key(
                        payload.get('message') if isinstance(payload, dict) else payload
                    ),
                )
                return None
            return payload
        return None

    def _fetch_raw_data(self, stock_code: str, start_date: str, end_date: str) -> pd.DataFrame:
        if not self._api_key:
            raise DataFetchError("[Twelvedata] API key not configured")
        if not self._is_us_stock(stock_code):
            raise DataFetchError(f"[Twelvedata] {stock_code} is not a US stock")

        symbol = stock_code.strip().upper()
        start = datetime.strptime(start_date, '%Y-%m-%d').date()
        end = datetime.strptime(end_date, '%Y-%m-%d').date()
        # /time_series 只支持"最近 N 根"，outputsize 按窗口宽度取值，
        # 保证显式传入长窗口 start_date 时也能覆盖完整区间（上限 5000）。
        window_days = max((end - start).days + 1, 1)
        outputsize = min(max(window_days, 1), _MAX_OUTPUTSIZE)

        payload = self._request_json('time_series', {
            'symbol': symbol,
            'interval': _DAILY_INTERVAL,
            'outputsize': outputsize,
        })
        if payload is None:
            raise DataFetchError(f"[Twelvedata] No data returned for {symbol}")

        values = payload.get('values')
        if not isinstance(values, list) or not values:
            raise DataFetchError(f"[Twelvedata] No data returned for {symbol}")

        rows = []
        for item in values:
            if not isinstance(item, dict):
                continue
            date_str = str(item.get('datetime', ''))[:10]
            try:
                row_date = datetime.strptime(date_str, '%Y-%m-%d').date()
            except ValueError:
                continue
            if not (start <= row_date <= end):
                continue
            rows.append({
                'datetime': date_str,
                'open': _to_float(item.get('open')),
                'high': _to_float(item.get('high')),
                'low': _to_float(item.get('low')),
                'close': _to_float(item.get('close')),
                'volume': _to_float(item.get('volume')) or 0.0,
            })

        if not rows:
            raise DataFetchError(f"[Twelvedata] No data in date range for {symbol}")

        return pd.DataFrame(rows)

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
                "[Twelvedata] daily data skipped for %s: API key not configured", stock_code
            )
            return None
        if not self._is_us_stock(stock_code):
            logger.debug(
                "[Twelvedata] daily data skipped for %s: not a US stock", stock_code
            )
            return None

        symbol = stock_code.strip().upper()
        end = end_date or datetime.now().strftime('%Y-%m-%d')
        try:
            end_dt = datetime.strptime(end, '%Y-%m-%d')
        except ValueError:
            logger.warning(
                "[Twelvedata] daily data skipped for %s: invalid end_date=%r",
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
            logger.warning("[Twelvedata] daily data unavailable for %s: %s", symbol, e)
            return None
        except Exception as e:
            logger.warning(
                "[Twelvedata] daily data failed for %s: %s", symbol, _redact_api_key(e)
            )
            return None

        if df is None or df.empty:
            logger.info(
                "[Twelvedata] %s daily data empty: range=%s ~ %s", symbol, from_date, end
            )
            return None
        return df

    def _normalize_data(self, df: pd.DataFrame, stock_code: str) -> pd.DataFrame:
        if df.empty:
            return df

        df = df.copy()
        df['date'] = pd.to_datetime(df['datetime']).dt.date
        # API 返回最新在前的倒序列表，先升序再计算 pct_chg
        df = df.sort_values('date', ascending=True).reset_index(drop=True)
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
        price_payload = self._request_json('price', {'symbol': symbol})
        if price_payload is None:
            return None
        price = _to_float(price_payload.get('price'))
        if not price or price <= 0:
            logger.debug("[Twelvedata] %s realtime price unavailable", symbol)
            return None

        # /quote 只用于补昨收/量价字段；失败不影响价格结果，也节省免费档额度。
        pre_close = None
        volume = None
        open_price = high = low = None
        quote_payload = self._request_json('quote', {'symbol': symbol})
        if isinstance(quote_payload, dict):
            pre_close = _to_float(quote_payload.get('previous_close'))
            volume = _to_float(quote_payload.get('volume'))
            open_price = _to_float(quote_payload.get('open'))
            high = _to_float(quote_payload.get('high'))
            low = _to_float(quote_payload.get('low'))

        change_pct = change_amount = amplitude = None
        if pre_close and pre_close > 0:
            change_pct = round((price - pre_close) / pre_close * 100, 2)
            change_amount = round(price - pre_close, 4)
            if high is not None and low is not None:
                amplitude = round((high - low) / pre_close * 100, 2)

        return UnifiedRealtimeQuote(
            code=symbol,
            source=RealtimeSource.FALLBACK,
            price=price,
            change_pct=change_pct,
            change_amount=change_amount,
            volume=int(volume) if volume else None,
            amount=None,
            volume_ratio=None,
            turnover_rate=None,
            amplitude=amplitude,
            open_price=open_price,
            high=high,
            low=low,
            pre_close=pre_close,
        )

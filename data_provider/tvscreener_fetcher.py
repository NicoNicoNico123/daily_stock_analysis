# -*- coding: utf-8 -*-
"""TvscreenerFetcher — optional TradingView screener snapshot source.

Wraps the unofficial `tvscreener` client (https://github.com/deepentropy/tvscreener)
so DSA can pull current quotes, TV-computed indicators, and a bounded lagged
OHLCV history from the same scanner payload.

Honest capability boundary:
- Realtime quote / name / current RSI·MACD·SMA are first-class scanner fields.
- Daily K-line is reconstructed from lagged scanner columns (`close[1]`, …)
  plus the local exchange calendar for dates. It is a last-resort fallback,
  not a full history API. Failures return None and do not trip the manager
  daily circuit breaker.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, List, Optional, Tuple

import pandas as pd

from .base import (
    BaseFetcher,
    DataFetchError,
    STANDARD_COLUMNS,
    _is_hk_market,
    _is_jp_market,
    _is_kr_market,
    _is_tw_market,
    is_bse_code,
    normalize_stock_code,
)
from .realtime_types import (
    CircuitBreaker,
    RealtimeSource,
    UnifiedRealtimeQuote,
    safe_float,
    safe_int,
)
from .us_index_mapping import is_us_index_code, is_us_stock_code

logger = logging.getLogger(__name__)

try:
    from tvscreener import FieldWithHistory, Market, StockField, StockScreener
    from tvscreener.exceptions import MalformedRequestException
except Exception:  # noqa: BLE001 - optional dependency, fail open
    FieldWithHistory = None  # type: ignore[assignment,misc]
    Market = None  # type: ignore[assignment,misc]
    StockField = None  # type: ignore[assignment,misc]
    StockScreener = None  # type: ignore[assignment,misc]
    MalformedRequestException = Exception  # type: ignore[misc,assignment]
    TVSCREENER_IMPORT_ERROR = True
else:
    TVSCREENER_IMPORT_ERROR = False

_DEFAULT_PRIORITY = 7
_DEFAULT_HISTORY_BARS = 30
_MAX_HISTORY_BARS = 60
_MIN_HISTORY_BARS = 5
_SCAN_RANGE = (0, 8)
_CIRCUIT_SOURCE = "tvscreener"

_US_EXCHANGES = ("NASDAQ", "NYSE", "AMEX", "BATS", "CBOE")
_SSE_PREFIXES = ("600", "601", "603", "605", "688", "689")
_SZSE_PREFIXES = ("000", "001", "002", "003", "300", "301")
_SSE_ETF_PREFIXES = ("51", "52", "56", "58")
_SZSE_ETF_PREFIXES = ("15", "16", "18")


def is_tvscreener_available() -> bool:
    """Return True when the optional tvscreener package imported cleanly."""
    return not TVSCREENER_IMPORT_ERROR and StockScreener is not None and StockField is not None


@dataclass(frozen=True)
class TvUniverse:
    """Mapped TradingView market + ticker candidates for one DSA code."""

    market: str
    tickers: Tuple[str, ...]
    name_hint: str


def resolve_tv_universe(stock_code: str) -> Optional[TvUniverse]:
    """Map a DSA stock code to TradingView scanner tickers.

    Returns None for US indices (the scanner is an equity screener) and for
    inputs that cannot be mapped without guessing an unsupported venue.
    """
    raw = (stock_code or "").strip()
    if not raw:
        return None
    if is_us_index_code(raw) or is_us_index_code(normalize_stock_code(raw)):
        return None

    if _is_jp_market(raw):
        base = raw.split(".", 1)[0].strip()
        if not base:
            return None
        return TvUniverse("jp", (f"TSE:{base}",), base)

    if _is_kr_market(raw):
        base, _, suffix = raw.upper().partition(".")
        exchange = "KOSDAQ" if suffix == "KQ" else "KRX"
        if not base:
            return None
        return TvUniverse("kr", (f"{exchange}:{base}",), base)

    if _is_tw_market(raw):
        base, _, suffix = raw.upper().partition(".")
        exchange = "TPEX" if suffix == "TWO" else "TWSE"
        if not base:
            return None
        return TvUniverse("tw", (f"{exchange}:{base}",), base)

    if is_us_stock_code(raw) or is_us_stock_code(normalize_stock_code(raw)):
        symbol = normalize_stock_code(raw).upper()
        tickers = tuple(f"{exchange}:{symbol}" for exchange in _US_EXCHANGES)
        return TvUniverse("us", tickers, symbol)

    if _is_hk_market(raw):
        digits = _hk_digits(raw)
        if not digits:
            return None
        stripped = digits.lstrip("0") or "0"
        tickers = (f"HKEX:{stripped}",)
        if stripped != digits:
            tickers = (f"HKEX:{stripped}", f"HKEX:{digits}")
        return TvUniverse("hk", tickers, stripped)

    code = normalize_stock_code(raw)
    if not (code.isdigit() and len(code) == 6):
        return None
    exchange = _cn_tv_exchange(code)
    return TvUniverse("cn", (f"{exchange}:{code}",), code)


def _hk_digits(stock_code: str) -> str:
    text = (stock_code or "").strip().upper()
    if text.endswith(".HK"):
        text = text[:-3]
    if text.startswith("HK"):
        text = text[2:]
    return text if text.isdigit() and 1 <= len(text) <= 5 else ""


def _cn_tv_exchange(code: str) -> str:
    if is_bse_code(code):
        return "BSE"
    if code.startswith(_SSE_ETF_PREFIXES) or code.startswith(_SSE_PREFIXES):
        return "SSE"
    if code.startswith(_SZSE_ETF_PREFIXES) or code.startswith(_SZSE_PREFIXES):
        return "SZSE"
    return "SZSE"


def _cell(row: Any, *names: str) -> Any:
    if row is None:
        return None
    index = getattr(row, "index", None)
    for name in names:
        try:
            if index is not None and name not in index:
                continue
            value = row[name]
        except Exception:  # noqa: BLE001
            continue
        if value is None:
            continue
        try:
            if pd.isna(value):
                continue
        except Exception:  # noqa: BLE001
            pass
        return value
    return None


class TvscreenerFetcher(BaseFetcher):
    """TradingView scanner snapshot fetcher (default priority 7, last-resort)."""

    name = "TvscreenerFetcher"
    priority = _DEFAULT_PRIORITY

    def __init__(self):
        from src.config import get_config

        config = get_config()
        self._enabled = getattr(config, "tvscreener_enabled", True) is True
        try:
            self.priority = int(getattr(config, "tvscreener_priority", None))
        except (TypeError, ValueError):
            try:
                self.priority = int(os.getenv("TVSCREENER_PRIORITY", _DEFAULT_PRIORITY))
            except (TypeError, ValueError):
                self.priority = _DEFAULT_PRIORITY
        self._history_bars = _clamp_history_bars(
            getattr(config, "tvscreener_history_bars", None)
        )
        self._breaker = CircuitBreaker(failure_threshold=3, cooldown_seconds=300.0)
        if not self._enabled:
            logger.debug("[Tvscreener] disabled by TVSCREENER_ENABLED")
        elif not is_tvscreener_available():
            logger.debug("[Tvscreener] package not installed; fetcher stays idle")

    def is_available_for_request(self, capability: str = "") -> bool:
        if not self._enabled or not is_tvscreener_available():
            return False
        if capability == "daily_data" and FieldWithHistory is None:
            return False
        return self._breaker.is_available(_CIRCUIT_SOURCE)

    def _fetch_raw_data(self, stock_code: str, start_date: str, end_date: str) -> pd.DataFrame:
        df = self._scan_history_frame(stock_code)
        if df is None or df.empty:
            raise DataFetchError(f"[Tvscreener] no lagged bars for {stock_code}")
        return df

    def _normalize_data(self, df: pd.DataFrame, stock_code: str) -> pd.DataFrame:
        if df is None or df.empty:
            return pd.DataFrame(columns=STANDARD_COLUMNS)
        out = df.copy()
        for column in STANDARD_COLUMNS:
            if column not in out.columns:
                out[column] = None
        return out[STANDARD_COLUMNS]

    def get_daily_data(
        self,
        stock_code: str,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        days: int = 30,
        **kwargs,
    ) -> Optional[pd.DataFrame]:
        """Return lagged scanner OHLCV as daily bars, or None when unavailable."""
        if not self.is_available_for_request("daily_data"):
            return None
        universe = resolve_tv_universe(stock_code)
        if universe is None:
            return None
        try:
            raw = self._scan_history_frame(stock_code, bars=max(days, self._history_bars))
            if raw is None or raw.empty or len(raw) < _MIN_HISTORY_BARS:
                self._breaker.record_inconclusive(_CIRCUIT_SOURCE)
                return None
            if start_date:
                raw = raw[raw["date"] >= pd.Timestamp(start_date)]
            if end_date:
                raw = raw[raw["date"] <= pd.Timestamp(end_date)]
            if raw.empty:
                return None
            normalized = self._normalize_data(raw, stock_code)
            cleaned = self._clean_data(normalized)
            if cleaned is None or cleaned.empty or len(cleaned) < _MIN_HISTORY_BARS:
                return None
            self._breaker.record_success(_CIRCUIT_SOURCE)
            return self._calculate_indicators(cleaned)
        except Exception as exc:  # noqa: BLE001 - last-resort source, fail open
            logger.warning("[Tvscreener] daily data skipped for %s: %s", stock_code, exc)
            self._breaker.record_failure(_CIRCUIT_SOURCE, error=str(exc))
            return None

    def get_realtime_quote(self, stock_code: str, **kwargs) -> Optional[UnifiedRealtimeQuote]:
        if not self.is_available_for_request("realtime_quote"):
            return None
        universe = resolve_tv_universe(stock_code)
        if universe is None:
            return None
        try:
            row = self._scan_row(universe, history_bars=0)
            quote = self._row_to_quote(stock_code, universe, row)
            if quote is None or not quote.has_basic_data():
                self._breaker.record_inconclusive(_CIRCUIT_SOURCE)
                return None
            self._breaker.record_success(_CIRCUIT_SOURCE)
            return quote
        except Exception as exc:  # noqa: BLE001
            logger.warning("[Tvscreener] quote skipped for %s: %s", stock_code, exc)
            self._breaker.record_failure(_CIRCUIT_SOURCE, error=str(exc))
            return None

    def get_stock_name(self, stock_code: str) -> Optional[str]:
        quote = self.get_realtime_quote(stock_code)
        name = getattr(quote, "name", None) if quote is not None else None
        if isinstance(name, str) and name.strip() and name.strip().upper() != stock_code.strip().upper():
            return name.strip()
        return None

    def get_indicator_snapshot(self, stock_code: str) -> Optional[dict]:
        """Return current TV-computed indicators, or None."""
        quote = self.get_realtime_quote(stock_code)
        if quote is None:
            return None
        snapshot = getattr(quote, "technicals", None)
        return dict(snapshot) if isinstance(snapshot, dict) else None

    def _scan_row(self, universe: TvUniverse, *, history_bars: int) -> Optional[pd.Series]:
        df = self._scan_dataframe(universe, history_bars=history_bars)
        if df is None or df.empty:
            return None
        if len(df) == 1:
            return df.iloc[0]
        volume_col = "Volume" if "Volume" in df.columns else None
        if volume_col:
            ranked = df.copy()
            ranked["_vol"] = pd.to_numeric(ranked[volume_col], errors="coerce").fillna(0)
            ranked = ranked.sort_values("_vol", ascending=False)
            return ranked.iloc[0]
        return df.iloc[0]

    def _scan_dataframe(self, universe: TvUniverse, *, history_bars: int) -> Optional[pd.DataFrame]:
        if not is_tvscreener_available():
            return None
        market = _market_enum(universe.market)
        if market is None:
            return None
        fields = _quote_fields()
        if history_bars > 1 and FieldWithHistory is not None:
            fields = list(fields) + _history_fields(history_bars)

        self.random_sleep(0.2, 0.6)
        screener = StockScreener()
        screener.set_markets(market)
        screener.set_range(*_SCAN_RANGE)
        screener.select(*fields)
        screener.symbols = {"tickers": list(universe.tickers)}
        df = _safe_get(screener)
        if df is not None and not df.empty:
            return df

        screener = StockScreener()
        screener.set_markets(market)
        screener.set_range(*_SCAN_RANGE)
        screener.select(*fields)
        screener.where(StockField.NAME == universe.name_hint)
        return _safe_get(screener)

    def _scan_history_frame(self, stock_code: str, bars: Optional[int] = None) -> Optional[pd.DataFrame]:
        universe = resolve_tv_universe(stock_code)
        if universe is None:
            return None
        lookback = _clamp_history_bars(bars if bars is not None else self._history_bars)
        row = self._scan_row(universe, history_bars=lookback)
        if row is None:
            return None
        sessions = _session_dates(universe.market, lookback)
        if len(sessions) < _MIN_HISTORY_BARS:
            return None
        records: List[dict] = []
        for offset, session in enumerate(reversed(sessions)):
            close = _lagged_value(row, "Price", offset)
            if close is None or close <= 0:
                continue
            open_ = _lagged_value(row, "Open", offset)
            high = _lagged_value(row, "High", offset)
            low = _lagged_value(row, "Low", offset)
            volume = _lagged_value(row, "Volume", offset)
            records.append(
                {
                    "date": pd.Timestamp(session),
                    "open": open_ if open_ is not None else close,
                    "high": high if high is not None else close,
                    "low": low if low is not None else close,
                    "close": close,
                    "volume": volume if volume is not None else 0,
                    "amount": (volume or 0) * close,
                    "pct_chg": None,
                }
            )
        if len(records) < _MIN_HISTORY_BARS:
            return None
        frame = pd.DataFrame(records).sort_values("date").reset_index(drop=True)
        prev = frame["close"].shift(1)
        frame["pct_chg"] = ((frame["close"] - prev) / prev.replace(0, pd.NA) * 100).fillna(0.0)
        return frame

    def _row_to_quote(
        self,
        stock_code: str,
        universe: TvUniverse,
        row: Optional[pd.Series],
    ) -> Optional[UnifiedRealtimeQuote]:
        if row is None:
            return None
        price = safe_float(_cell(row, "Price", "close"))
        if price is None or price <= 0:
            return None
        open_price = safe_float(_cell(row, "Open", "open"))
        high = safe_float(_cell(row, "High", "high"))
        low = safe_float(_cell(row, "Low", "low"))
        volume = safe_int(_cell(row, "Volume", "volume"))
        change_pct = safe_float(_cell(row, "Change %", "change"))
        change_amount = safe_float(_cell(row, "Change", "change_abs"))
        name = str(_cell(row, "Description", "Name", "description", "name") or "").strip()
        amount = safe_float(_cell(row, "Volume*Price", "Value.Traded"))
        if amount is None and volume is not None:
            amount = float(volume) * price
        quote = UnifiedRealtimeQuote(
            code=stock_code,
            name=name,
            source=RealtimeSource.TVSCREENER,
            price=price,
            change_pct=change_pct,
            change_amount=change_amount,
            volume=volume,
            amount=amount,
            open_price=open_price,
            high=high,
            low=low,
            pe_ratio=safe_float(
                _cell(
                    row,
                    "Price to Earnings Ratio (TTM)",
                    "Price Earnings Current",
                    "price_earnings_ttm",
                )
            ),
            pb_ratio=safe_float(_cell(row, "Price to Book (MRQ)", "price_book_fq")),
            total_mv=safe_float(_cell(row, "Market Capitalization", "market_cap_basic")),
            high_52w=safe_float(_cell(row, "52 Week High", "price_52_week_high")),
            low_52w=safe_float(_cell(row, "52 Week Low", "price_52_week_low")),
            market=universe.market,
        )
        technicals = {
            "rsi_14": safe_float(_cell(row, "Relative Strength Index (14)", "RSI")),
            "macd": safe_float(_cell(row, "MACD Level (12, 26)", "MACD.macd")),
            "macd_signal": safe_float(_cell(row, "MACD Signal (12, 26)", "MACD.signal")),
            "sma_5": safe_float(_cell(row, "Simple Moving Average (5)", "SMA5")),
            "sma_10": safe_float(_cell(row, "Simple Moving Average (10)", "SMA10")),
            "sma_20": safe_float(_cell(row, "Simple Moving Average (20)", "SMA20")),
            "ema_5": safe_float(_cell(row, "Exponential Moving Average (5)", "EMA5")),
            "ema_10": safe_float(_cell(row, "Exponential Moving Average (10)", "EMA10")),
            "ema_20": safe_float(_cell(row, "Exponential Moving Average (20)", "EMA20")),
            "recommend": safe_float(_cell(row, "Analyst Rating", "recommendation_mark")),
            "price_target_avg": safe_float(
                _cell(row, "Target Price (Average)", "price_target_average")
            ),
            "price_target_high": safe_float(_cell(row, "Price Target High", "price_target_high")),
            "price_target_low": safe_float(_cell(row, "Price Target Low", "price_target_low")),
        }
        setattr(
            quote,
            "technicals",
            {key: value for key, value in technicals.items() if value is not None},
        )
        return quote


def _clamp_history_bars(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = _DEFAULT_HISTORY_BARS
    return max(_MIN_HISTORY_BARS, min(_MAX_HISTORY_BARS, parsed))


def _market_enum(market: str):
    if Market is None:
        return None
    mapping = {
        "cn": "CHINA",
        "hk": "HONGKONG",
        "us": "AMERICA",
        "jp": "JAPAN",
        "kr": "KOREA",
        "tw": "TAIWAN",
    }
    name = mapping.get(market)
    return getattr(Market, name, None) if name else None


def _quote_fields() -> List[Any]:
    if StockField is None:
        return []
    names = (
        "NAME",
        "DESCRIPTION",
        "PRICE",
        "OPEN",
        "HIGH",
        "LOW",
        "VOLUME",
        "CHANGE",
        "CHANGE_PERCENT",
        "VOLUMEXPRICE",
        "PRICE_TO_EARNINGS_RATIO_TTM",
        "PRICE_TO_BOOK_MRQ",
        "MARKET_CAPITALIZATION",
        "WEEK_HIGH_52",
        "WEEK_LOW_52",
        "RELATIVE_STRENGTH_INDEX_14",
        "MACD_LEVEL_12_26",
        "MACD_SIGNAL_12_26",
        "SIMPLE_MOVING_AVERAGE_5",
        "SIMPLE_MOVING_AVERAGE_10",
        "SIMPLE_MOVING_AVERAGE_20",
        "EXPONENTIAL_MOVING_AVERAGE_5",
        "EXPONENTIAL_MOVING_AVERAGE_10",
        "EXPONENTIAL_MOVING_AVERAGE_20",
        "RECOMMENDATION_MARK",
        "PRICE_TARGET_AVERAGE",
        "PRICE_TARGET_HIGH",
        "PRICE_TARGET_LOW",
    )
    return [field for name in names if (field := getattr(StockField, name, None)) is not None]


def _history_fields(bars: int) -> List[Any]:
    if FieldWithHistory is None or StockField is None:
        return []
    fields: List[Any] = []
    for period in range(1, max(1, bars)):
        fields.extend(
            [
                FieldWithHistory(StockField.PRICE, period),
                FieldWithHistory(StockField.OPEN, period),
                FieldWithHistory(StockField.HIGH, period),
                FieldWithHistory(StockField.LOW, period),
                FieldWithHistory(StockField.VOLUME, period),
            ]
        )
    return fields


def _lagged_label(base: str, offset: int) -> str:
    if offset <= 0:
        return base
    if offset == 1:
        return f"Prev. {base}"
    return f"{base} [{offset}]"


def _lagged_value(row: Any, base: str, offset: int) -> Optional[float]:
    return safe_float(_cell(row, _lagged_label(base, offset)))


def _session_dates(market: str, count: int) -> List[date]:
    """Latest `count` exchange sessions ending at today-or-previous session."""
    from src.core.trading_calendar import MARKET_EXCHANGE, get_market_now

    today = get_market_now(market).date()
    try:
        import exchange_calendars as xcals

        exchange = MARKET_EXCHANGE.get(market)
        if not exchange:
            raise RuntimeError("unknown market calendar")
        calendar = xcals.get_calendar(exchange)
        end = today if calendar.is_session(today) else calendar.date_to_session(today, direction="previous").date()
        session = pd.Timestamp(end)
        dates: List[date] = []
        for _ in range(count):
            dates.append(session.date() if hasattr(session, "date") else session)
            session = calendar.previous_session(session)
        dates.reverse()
        return dates
    except Exception:  # noqa: BLE001 - calendar optional; weekday fallback is last resort
        dates = []
        cursor = today
        while len(dates) < count:
            if cursor.weekday() < 5:
                dates.append(cursor)
            cursor -= timedelta(days=1)
        dates.reverse()
        return dates


def _safe_get(screener: Any) -> Optional[pd.DataFrame]:
    try:
        df = screener.get()
    except MalformedRequestException as exc:
        logger.warning("[Tvscreener] scanner request rejected: %s", exc)
        return None
    except Exception as exc:  # noqa: BLE001
        logger.warning("[Tvscreener] scanner request failed: %s", exc)
        return None
    if df is None or getattr(df, "empty", True):
        return None
    return df

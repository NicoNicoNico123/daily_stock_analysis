# -*- coding: utf-8 -*-
"""Offline tests for the optional tvscreener data source."""

from __future__ import annotations

import unittest
from datetime import date
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pandas as pd

from data_provider.realtime_types import RealtimeSource
from data_provider.tvscreener_fetcher import (
    TvscreenerFetcher,
    resolve_tv_universe,
)


def _quote_row(**overrides):
    payload = {
        "Symbol": "SSE:600519",
        "Name": "600519",
        "Description": "Kweichow Moutai",
        "Price": 1680.0,
        "Open": 1670.0,
        "High": 1690.0,
        "Low": 1660.0,
        "Volume": 12345,
        "Change %": 1.25,
        "Change": 20.0,
        "Price to Earnings Ratio (TTM)": 28.5,
        "Price to Book (MRQ)": 8.1,
        "Market Capitalization": 2.1e12,
        "Relative Strength Index (14)": 55.0,
        "Simple Moving Average (5)": 1675.0,
        "Prev. Price": 1660.0,
        "Prev. Open": 1650.0,
        "Prev. High": 1670.0,
        "Prev. Low": 1640.0,
        "Prev. Volume": 11000,
        "Price [2]": 1640.0,
        "Open [2]": 1630.0,
        "High [2]": 1650.0,
        "Low [2]": 1620.0,
        "Volume [2]": 10000,
        "Price [3]": 1620.0,
        "Open [3]": 1610.0,
        "High [3]": 1630.0,
        "Low [3]": 1600.0,
        "Volume [3]": 9000,
        "Price [4]": 1600.0,
        "Open [4]": 1590.0,
        "High [4]": 1610.0,
        "Low [4]": 1580.0,
        "Volume [4]": 8000,
    }
    payload.update(overrides)
    return pd.Series(payload)


class TestResolveTvUniverse(unittest.TestCase):
    def test_cn_shanghai(self):
        universe = resolve_tv_universe("600519")
        self.assertEqual(universe.market, "cn")
        self.assertEqual(universe.tickers, ("SSE:600519",))

    def test_cn_shenzhen(self):
        universe = resolve_tv_universe("000001")
        self.assertEqual(universe.tickers, ("SZSE:000001",))

    def test_cn_bse(self):
        universe = resolve_tv_universe("920748")
        self.assertEqual(universe.tickers, ("BSE:920748",))

    def test_hk_strips_leading_zeros(self):
        universe = resolve_tv_universe("hk00700")
        self.assertEqual(universe.market, "hk")
        self.assertIn("HKEX:700", universe.tickers)

    def test_us_tries_major_exchanges(self):
        universe = resolve_tv_universe("AAPL")
        self.assertEqual(universe.market, "us")
        self.assertIn("NASDAQ:AAPL", universe.tickers)
        self.assertIn("NYSE:AAPL", universe.tickers)

    def test_jp_kr_tw_suffixes(self):
        self.assertEqual(resolve_tv_universe("7203.T").tickers, ("TSE:7203",))
        self.assertEqual(resolve_tv_universe("005930.KS").tickers, ("KRX:005930",))
        self.assertEqual(resolve_tv_universe("2330.TW").tickers, ("TWSE:2330",))
        self.assertEqual(resolve_tv_universe("5483.TWO").tickers, ("TPEX:5483",))

    def test_us_index_rejected(self):
        self.assertIsNone(resolve_tv_universe("SPX"))


class TestTvscreenerFetcherQuote(unittest.TestCase):
    def setUp(self):
        with patch("src.config.get_config") as mock_config:
            mock_config.return_value = SimpleNamespace(
                tvscreener_enabled=True,
                tvscreener_priority=7,
                tvscreener_history_bars=5,
            )
            self.fetcher = TvscreenerFetcher()
        self._pkg_patch = patch(
            "data_provider.tvscreener_fetcher.is_tvscreener_available",
            return_value=True,
        )
        self._pkg_patch.start()
        self.addCleanup(self._pkg_patch.stop)

    def test_quote_maps_ohlcv_and_indicators(self):
        row = _quote_row()
        with patch.object(self.fetcher, "_scan_row", return_value=row):
            quote = self.fetcher.get_realtime_quote("600519")

        self.assertIsNotNone(quote)
        self.assertEqual(quote.source, RealtimeSource.TVSCREENER)
        self.assertEqual(quote.price, 1680.0)
        self.assertEqual(quote.open_price, 1670.0)
        self.assertEqual(quote.volume, 12345)
        self.assertEqual(quote.name, "Kweichow Moutai")
        self.assertEqual(quote.pe_ratio, 28.5)
        self.assertEqual(quote.technicals["rsi_14"], 55.0)
        self.assertEqual(quote.technicals["sma_5"], 1675.0)

    def test_quote_returns_none_without_price(self):
        with patch.object(self.fetcher, "_scan_row", return_value=_quote_row(Price=None)):
            self.assertIsNone(self.fetcher.get_realtime_quote("600519"))

    def test_disabled_fetcher_skips_requests(self):
        self.fetcher._enabled = False
        with patch.object(self.fetcher, "_scan_row") as scan:
            self.assertIsNone(self.fetcher.get_realtime_quote("600519"))
            scan.assert_not_called()


class TestTvscreenerFetcherDaily(unittest.TestCase):
    def setUp(self):
        with patch("src.config.get_config") as mock_config:
            mock_config.return_value = SimpleNamespace(
                tvscreener_enabled=True,
                tvscreener_priority=7,
                tvscreener_history_bars=5,
            )
            self.fetcher = TvscreenerFetcher()
        self._avail_patch = patch.object(
            self.fetcher, "is_available_for_request", return_value=True
        )
        self._avail_patch.start()
        self.addCleanup(self._avail_patch.stop)

    def test_daily_reconstructs_lagged_bars(self):
        sessions = [date(2026, 9, 11 + i) for i in range(5)]
        with patch.object(self.fetcher, "_scan_row", return_value=_quote_row()), patch(
            "data_provider.tvscreener_fetcher._session_dates",
            return_value=sessions,
        ):
            df = self.fetcher.get_daily_data("600519", days=5)

        self.assertIsNotNone(df)
        self.assertGreaterEqual(len(df), 5)
        self.assertEqual(list(df["close"].astype(float)), [1600.0, 1620.0, 1640.0, 1660.0, 1680.0])
        self.assertIn("ma5", df.columns)

    def test_daily_returns_none_when_too_short(self):
        with patch.object(self.fetcher, "_scan_row", return_value=_quote_row(Price=None)):
            self.assertIsNone(self.fetcher.get_daily_data("AAPL"))


class TestTvscreenerRegistration(unittest.TestCase):
    @patch("src.config.get_config")
    def test_registered_when_enabled_and_importable(self, mock_config):
        from data_provider.tvscreener_fetcher import is_tvscreener_available

        if not is_tvscreener_available():
            self.skipTest("tvscreener package is not installed")
        mock_config.return_value = SimpleNamespace(
            tvscreener_enabled=True,
            tvscreener_priority=7,
            tvscreener_history_bars=30,
            tushare_token=None,
            tickflow_api_key=None,
            finnhub_api_key=None,
            alphavantage_api_key=None,
            twelvedata_api_key=None,
            longbridge_app_key=None,
            longbridge_app_secret=None,
            longbridge_access_token=None,
            longbridge_oauth_client_id=None,
            futu_opend_host=None,
        )
        from data_provider.base import DataFetcherManager

        mgr = DataFetcherManager()
        names = [fetcher.name for fetcher in mgr._get_fetchers_snapshot()]
        self.assertIn("TvscreenerFetcher", names)

    @patch("src.config.get_config")
    def test_skipped_when_disabled(self, mock_config):
        mock_config.return_value = SimpleNamespace(
            tvscreener_enabled=False,
            tushare_token=None,
            tickflow_api_key=None,
            finnhub_api_key=None,
            alphavantage_api_key=None,
            twelvedata_api_key=None,
            longbridge_app_key=None,
            longbridge_app_secret=None,
            longbridge_access_token=None,
            longbridge_oauth_client_id=None,
            futu_opend_host=None,
        )
        from data_provider.base import DataFetcherManager

        mgr = DataFetcherManager()
        names = [fetcher.name for fetcher in mgr._get_fetchers_snapshot()]
        self.assertNotIn("TvscreenerFetcher", names)


class TestTvscreenerRealtimeFallback(unittest.TestCase):
    def test_jp_falls_back_to_tvscreener_after_yfinance(self):
        from data_provider.base import DataFetcherManager
        from data_provider.realtime_types import UnifiedRealtimeQuote

        yfinance = MagicMock()
        yfinance.name = "YfinanceFetcher"
        yfinance.priority = 4
        yfinance.get_realtime_quote.return_value = None

        tvscreener = MagicMock()
        tvscreener.name = "TvscreenerFetcher"
        tvscreener.priority = 7
        tvscreener.get_realtime_quote.return_value = UnifiedRealtimeQuote(
            code="7203.T",
            name="Toyota",
            source=RealtimeSource.TVSCREENER,
            price=2500.0,
        )

        manager = DataFetcherManager(fetchers=[yfinance, tvscreener])
        with patch("src.config.get_config") as mock_config:
            mock_config.return_value = SimpleNamespace(
                enable_realtime_quote=True,
                realtime_cache_ttl=600,
            )
            quote = manager.get_realtime_quote("7203.T")

        self.assertIsNotNone(quote)
        self.assertEqual(quote.source, RealtimeSource.TVSCREENER)
        tvscreener.get_realtime_quote.assert_called()


if __name__ == "__main__":
    unittest.main()

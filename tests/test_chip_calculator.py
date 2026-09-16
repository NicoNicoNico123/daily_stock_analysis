# -*- coding: utf-8 -*-
"""
===================================
筹码分布本地估算（CYQ fallback）测试
===================================

算法出处：data_provider/chip_calculator.py 与 akshare `stock_cyq_em` 同源——
akshare 并非独立的筹码接口，它只拉取东方财富标准 K 线端点
（push2his.eastmoney.com/api/qt/stock/kline/get），然后在本地运行东财官方
内嵌 JS 的 CYQCalculator（换手衰减 + 以当日均价为峰的三角分布）算出筹码。
因此当东财按 IP 限流/封禁导致 K 线端点不可达时，本仓库的兜底方案改为
"多源日线链 + 本地运行同一 CYQ 模型"，与 akshare 的实现机制完全同源。

覆盖：
- chip_calculator.compute_chip_distribution 的纯计算语义（无网络）；
- data_provider.base.get_chip_distribution 在所有远程数据源失败后的本地估算兜底；
- AkshareFetcher.get_chip_distribution 对连接类异常的退避重试。
"""

from http.client import RemoteDisconnected
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest

from data_provider.base import DataFetcherManager, _is_meaningful_chip_distribution
from data_provider.chip_calculator import (
    compute_chip_distribution,
    PRICE_BIN_COUNT,
)
from data_provider.realtime_types import ChipDistribution, get_chip_circuit_breaker

import data_provider.akshare_fetcher as akshare_fetcher_module
from data_provider.akshare_fetcher import AkshareFetcher


# ---------------------------------------------------------------------------
# 测试数据构造
# ---------------------------------------------------------------------------

def _bar(price, volume=1_000_000.0, spread=0.01):
    """构造一根以 price 为中心的日线。"""
    return {
        "date": "2026-09-15",
        "open": price,
        "high": round(price * (1 + spread), 6),
        "low": round(price * (1 - spread), 6),
        "close": price,
        "volume": volume,
    }


def _flat_bars(days=100, price=10.0, volume=1_000_000.0):
    return [_bar(price, volume) for _ in range(days)]


class _ChipFetcher:
    """最小化的筹码数据源桩：所有远程数据源都拿不到筹码数据。"""

    name = "StubChipFetcher"
    priority = 0

    def get_chip_distribution(self, stock_code: str):
        self.calls = getattr(self, "calls", 0) + 1
        return None


class _FloatSharesFetcher:
    """提供 yfinance 流通股本能力的桩（模拟 YfinanceFetcher.get_float_shares）。"""

    name = "StubYfinanceFetcher"
    priority = 10

    def __init__(self, float_shares=None):
        self._float_shares = float_shares

    def get_float_shares(self, stock_code: str):
        return self._float_shares


def _chip_enabled_config():
    return SimpleNamespace(enable_chip_distribution=True)


# ---------------------------------------------------------------------------
# compute_chip_distribution 纯计算
# ---------------------------------------------------------------------------

class TestComputeChipDistribution:
    def test_flat_price_series_avg_cost_equals_price(self):
        chip = compute_chip_distribution(
            _flat_bars(), current_price=10.0, code="600519"
        )

        assert chip is not None
        assert chip.source == "computed"
        assert chip.code == "600519"
        assert chip.date == "2026-09-15"
        assert abs(chip.avg_cost - 10.0) < 0.05
        # 价格完全不动，筹码高度集中
        assert chip.concentration_90 < 0.05
        assert chip.concentration_70 < chip.concentration_90
        assert 0.0 <= chip.profit_ratio <= 1.0

    def test_monotonic_rise_gives_high_profit_ratio(self):
        bars = [_bar(price) for price in [round(p, 4) for p in np.linspace(10, 20, 100)]]

        chip = compute_chip_distribution(bars, current_price=20.0, code="600519")

        assert chip is not None
        assert chip.profit_ratio > 0.6
        # 均价应位于价格区间的上半段
        assert 15.0 < chip.avg_cost <= 20.0
        assert chip.cost_90_low < chip.cost_90_high
        assert _is_meaningful_chip_distribution(chip)

    def test_huge_recent_volume_shifts_avg_cost_up(self):
        baseline = compute_chip_distribution(
            _flat_bars(), current_price=10.0, latest_turnover_rate=1.0
        )
        bars = _flat_bars(days=99)
        bars.append(_bar(20.0, volume=50_000_000.0))

        shifted = compute_chip_distribution(
            bars, current_price=20.0, latest_turnover_rate=30.0, code="600519"
        )

        assert baseline is not None and shifted is not None
        assert baseline.avg_cost == pytest.approx(10.0, abs=0.05)
        assert shifted.avg_cost > baseline.avg_cost + 1.5
        assert shifted.profit_ratio > baseline.profit_ratio

    def test_turnover_rate_accepts_percent_and_fraction(self):
        bars = _flat_bars(days=40)

        as_percent = compute_chip_distribution(bars, 10.0, latest_turnover_rate=2.0)
        as_fraction = compute_chip_distribution(bars, 10.0, latest_turnover_rate=0.02)

        assert as_percent is not None and as_fraction is not None
        # 2% 与 0.02 是同一口径，衰减速度一致，均价应完全相同
        assert as_percent.avg_cost == pytest.approx(as_fraction.avg_cost)
        assert as_percent.profit_ratio == pytest.approx(as_fraction.profit_ratio)

    def test_heuristic_fallback_without_turnover(self):
        chip = compute_chip_distribution(_flat_bars(), current_price=10.0)

        assert chip is not None
        assert abs(chip.avg_cost - 10.0) < 0.05

    def test_accepts_dataframe_input(self):
        df = pd.DataFrame(
            [
                {"date": "2026-09-15", "open": p, "high": p * 1.01, "low": p * 0.99,
                 "close": p, "volume": 1_000_000.0}
                for p in [round(p, 4) for p in np.linspace(10, 20, 100)]
            ]
        )
        rows = list(df.to_dict(orient="records"))

        from_df = compute_chip_distribution(df, 20.0, None, code="600519")
        from_rows = compute_chip_distribution(rows, 20.0, None, code="600519")

        assert from_df is not None and from_rows is not None
        assert from_df.avg_cost == pytest.approx(from_rows.avg_cost)
        assert from_df.profit_ratio == pytest.approx(from_rows.profit_ratio)

    def test_invalid_inputs_return_none(self):
        assert compute_chip_distribution(None, 10.0) is None
        assert compute_chip_distribution([], 10.0) is None
        # 少于 MIN_BARS 根不做估算
        assert compute_chip_distribution(_flat_bars(days=3), 10.0) is None
        # 成交量全为 0
        assert compute_chip_distribution(_flat_bars(volume=0.0), 10.0) is None
        # 缺少必要列
        assert compute_chip_distribution(pd.DataFrame([{"close": 10.0}] * 30), 10.0) is None
        # 非法价格
        bad = _flat_bars()
        bad[0]["low"] = -1.0
        assert compute_chip_distribution(bad, 10.0) is None

    def test_grid_resolution_is_stable(self):
        chip = compute_chip_distribution(_flat_bars(), 10.0)

        assert chip is not None
        # 200 档价格网格下，平价序列的 90% 成本区间应非常窄（约 ±0.7%）
        assert (chip.cost_90_high - chip.cost_90_low) / chip.avg_cost < 0.03
        assert PRICE_BIN_COUNT == 200


# ---------------------------------------------------------------------------
# base.get_chip_distribution 的本地估算兜底
# ---------------------------------------------------------------------------

def _build_manager():
    fetcher = _ChipFetcher()
    return DataFetcherManager(fetchers=[fetcher]), fetcher


class TestChipFallbackViaManager:
    def _run(self, manager, code):
        get_chip_circuit_breaker().reset()
        with patch("src.config.get_config", return_value=_chip_enabled_config()):
            return manager.get_chip_distribution(code)

    @staticmethod
    def _patch_daily(monkeypatch, manager, code_log=None):
        bars = pd.DataFrame(_flat_bars(days=100))
        daily_calls = []

        def fake_daily_data(stock_code, start_date=None, end_date=None, days=30):
            daily_calls.append((stock_code, days))
            return bars, "FakeDailySource"

        monkeypatch.setattr(manager, "get_daily_data", fake_daily_data)
        return daily_calls

    def test_computed_fallback_used_when_all_sources_fail(self, monkeypatch):
        manager, fetcher = _build_manager()
        daily_calls = self._patch_daily(monkeypatch, manager)
        monkeypatch.setattr(
            DataFetcherManager,
            "get_realtime_quote",
            lambda self, code, **kw: SimpleNamespace(turnover_rate=3.0),
        )

        chip = self._run(manager, "600519")

        assert fetcher.calls == 1
        assert chip is not None
        assert isinstance(chip, ChipDistribution)
        assert chip.source == "computed"
        assert chip.code == "600519"
        # 复用既有日线链路，取约 120 根
        assert daily_calls and daily_calls[0][1] == 120
        assert abs(chip.avg_cost - 10.0) < 0.05

    def test_hk_code_uses_yfinance_float_shares_tier(self, monkeypatch):
        manager, _ = _build_manager()
        self._patch_daily(monkeypatch, manager)
        monkeypatch.setattr(
            DataFetcherManager, "get_realtime_quote", lambda self, code, **kw: None
        )
        # 港股日K量纲为股，流通股本使隐含换手率 = 1_000_000 / 100_000_000 = 1%
        manager._fetchers.insert(0, _FloatSharesFetcher(float_shares=100_000_000.0))

        chip = self._run(manager, "HK00700")

        assert chip is not None
        assert chip.source == "computed"
        assert chip.code == "HK00700"
        assert abs(chip.avg_cost - 10.0) < 0.05
        # 换手率走了 yfinance 流通股本层（而非启发式），衰减速度可预期
        assert chip.concentration_90 > 0

    def test_us_code_uses_realtime_turnover_tier(self, monkeypatch):
        manager, _ = _build_manager()
        self._patch_daily(monkeypatch, manager)
        monkeypatch.setattr(
            DataFetcherManager,
            "get_realtime_quote",
            lambda self, code, **kw: SimpleNamespace(turnover_rate=0.5),
        )
        manager._fetchers.insert(0, _FloatSharesFetcher(float_shares=1.0))

        chip = self._run(manager, "AAPL")

        assert chip is not None
        assert chip.source == "computed"
        assert chip.code == "AAPL"

    def test_etf_code_falls_back_to_heuristic_tier(self, monkeypatch):
        manager, _ = _build_manager()
        self._patch_daily(monkeypatch, manager)
        monkeypatch.setattr(
            DataFetcherManager, "get_realtime_quote", lambda self, code, **kw: None
        )
        manager._fetchers.insert(0, _FloatSharesFetcher(float_shares=None))

        chip = self._run(manager, "510300")

        assert chip is not None
        assert chip.source == "computed"
        assert chip.code == "510300"
        assert abs(chip.avg_cost - 10.0) < 0.05

    def test_implausible_float_shares_falls_back_to_heuristic(self, monkeypatch):
        manager, _ = _build_manager()
        self._patch_daily(monkeypatch, manager)
        monkeypatch.setattr(
            DataFetcherManager, "get_realtime_quote", lambda self, code, **kw: None
        )
        # 流通股本大得离谱：隐含换手率 = 1e6 / 1e15 = 1e-9 < 下限，视为量纲不符
        manager._fetchers.insert(0, _FloatSharesFetcher(float_shares=1e15))

        chip = self._run(manager, "510300")

        assert chip is not None
        assert chip.source == "computed"
        assert abs(chip.avg_cost - 10.0) < 0.05

    def test_index_codes_still_skip_computed_fallback(self, monkeypatch):
        manager, _ = _build_manager()

        def fail_daily(*args, **kwargs):
            raise AssertionError("computed fallback must not fetch daily data for index codes")

        monkeypatch.setattr(manager, "get_daily_data", fail_daily)

        # 港股指数是纯字母代码，会被通用规则误判为美股代码，必须显式排除
        for code in ["sh000300", "000016.SH", "SPX", "DJI", "VIX", "HSI", "HSCEI", "HSTECH"]:
            assert self._run(manager, code) is None

    def test_disabled_config_skips_computed_fallback(self, monkeypatch):
        manager, _ = _build_manager()

        def fail_daily(*args, **kwargs):
            raise AssertionError("computed fallback must respect ENABLE_CHIP_DISTRIBUTION")

        monkeypatch.setattr(manager, "get_daily_data", fail_daily)
        get_chip_circuit_breaker().reset()
        with patch(
            "src.config.get_config",
            return_value=SimpleNamespace(enable_chip_distribution=False),
        ):
            assert manager.get_chip_distribution("600519") is None

    def test_fallback_returns_none_when_daily_data_unavailable(self, monkeypatch):
        manager, _ = _build_manager()

        def raise_daily(*args, **kwargs):
            raise RuntimeError("daily source down")

        monkeypatch.setattr(manager, "get_daily_data", raise_daily)
        monkeypatch.setattr(
            DataFetcherManager, "get_realtime_quote", lambda self, code, **kw: None
        )

        assert self._run(manager, "600519") is None

    def test_fallback_works_without_realtime_turnover(self, monkeypatch):
        manager, _ = _build_manager()
        monkeypatch.setattr(
            manager,
            "get_daily_data",
            lambda *args, **kwargs: (pd.DataFrame(_flat_bars(days=100)), "FakeDailySource"),
        )
        monkeypatch.setattr(
            DataFetcherManager, "get_realtime_quote", lambda self, code, **kw: None
        )

        chip = self._run(manager, "600519")

        assert chip is not None
        assert chip.source == "computed"
        assert abs(chip.avg_cost - 10.0) < 0.05


# ---------------------------------------------------------------------------
# AkshareFetcher 筹码接口退避重试
# ---------------------------------------------------------------------------

def _cyq_dataframe():
    return pd.DataFrame(
        [
            {
                "日期": "2026-09-15",
                "获利比例": 0.6,
                "平均成本": 10.0,
                "90成本-低": 9.0,
                "90成本-高": 11.0,
                "90集中度": 0.1,
                "70成本-低": 9.5,
                "70成本-高": 10.5,
                "70集中度": 0.05,
            }
        ]
    )


class TestAkshareChipRetry:
    def _fetcher(self):
        return AkshareFetcher(sleep_min=0, sleep_max=0)

    def test_retries_connection_errors_then_succeeds(self, monkeypatch):
        monkeypatch.setattr(
            akshare_fetcher_module, "_CHIP_RETRY_BACKOFF_SECONDS", (0.0, 0.0)
        )
        fetcher = self._fetcher()
        df = _cyq_dataframe()
        attempts = []

        def flaky(stock_code):
            attempts.append(stock_code)
            if len(attempts) <= 2:
                raise RemoteDisconnected("Remote end closed connection without response")
            return df

        monkeypatch.setattr(AkshareFetcher, "_fetch_cyq_em", staticmethod(flaky))

        chip = fetcher.get_chip_distribution("600519")

        assert len(attempts) == 3
        assert chip is not None
        assert chip.source == "akshare"
        assert chip.avg_cost == pytest.approx(10.0)

    def test_gives_up_after_two_retries(self, monkeypatch):
        monkeypatch.setattr(
            akshare_fetcher_module, "_CHIP_RETRY_BACKOFF_SECONDS", (0.0, 0.0)
        )
        fetcher = self._fetcher()
        attempts = []

        def always_fail(stock_code):
            attempts.append(stock_code)
            raise RemoteDisconnected("boom")

        monkeypatch.setattr(AkshareFetcher, "_fetch_cyq_em", staticmethod(always_fail))

        assert fetcher.get_chip_distribution("600519") is None
        assert len(attempts) == 3  # 首次 + 2 次重试

    def test_non_connection_errors_are_not_retried(self, monkeypatch):
        monkeypatch.setattr(
            akshare_fetcher_module, "_CHIP_RETRY_BACKOFF_SECONDS", (0.0, 0.0)
        )
        fetcher = self._fetcher()
        attempts = []

        def broken(stock_code):
            attempts.append(stock_code)
            raise ValueError("bad data")

        monkeypatch.setattr(AkshareFetcher, "_fetch_cyq_em", staticmethod(broken))

        assert fetcher.get_chip_distribution("600519") is None
        assert len(attempts) == 1

    def test_market_scope_still_short_circuits(self, monkeypatch):
        monkeypatch.setattr(
            akshare_fetcher_module, "_CHIP_RETRY_BACKOFF_SECONDS", (0.0, 0.0)
        )
        fetcher = self._fetcher()

        def fail(stock_code):
            raise AssertionError("should not call the API")

        monkeypatch.setattr(AkshareFetcher, "_fetch_cyq_em", staticmethod(fail))

        assert fetcher.get_chip_distribution("HK00700") is None
        assert fetcher.get_chip_distribution("AAPL") is None
        assert fetcher.get_chip_distribution("510300") is None

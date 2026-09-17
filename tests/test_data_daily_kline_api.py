# -*- coding: utf-8 -*-
"""Tests for GET /api/v1/data/daily-kline (report price chart backend)."""

from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import patch

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from api.app import create_app
from api.v1.endpoints import data as data_endpoint
from api.v1.endpoints.data import MAX_DAILY_KLINE_DAYS, _daily_kline_points
from data_provider.base import DataFetchError


def _frame(rows: list) -> pd.DataFrame:
    return pd.DataFrame(rows)


class _FakeManager:
    """Return a canned DataFrame (or raise) instead of touching the network."""

    def __init__(self, frame=None, error: Exception | None = None) -> None:
        self.frame = frame
        self.error = error
        self.calls: list = []

    def get_daily_data(self, *, stock_code: str, days: int, **_kwargs):
        self.calls.append({"stock_code": stock_code, "days": days})
        if self.error is not None:
            raise self.error
        return self.frame, "fake-source"


def _client() -> TestClient:
    return TestClient(create_app(static_dir=Path(tempfile.mkdtemp())))


@pytest.fixture(autouse=True)
def _reset_fetcher_manager_singleton():
    """Keep the module-level DataFetcherManager cache out of the patched tests."""
    data_endpoint._fetcher_manager = None
    yield
    data_endpoint._fetcher_manager = None


def test_daily_kline_points_sorts_and_drops_invalid_rows():
    frame = _frame(
        [
            {"date": "2026-01-13", "open": 11.0, "high": 12.0, "low": 10.5, "close": 11.5, "volume": 100.0},
            {"date": "2026-01-12", "open": 10.0, "high": 11.0, "low": 9.5, "close": 10.2, "volume": None},
            {"date": "2026-01-14", "open": None, "high": 12.0, "low": 10.5, "close": 11.5, "volume": 120.0},
            {"date": "not-a-date", "open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0, "volume": 1.0},
        ]
    )

    points = _daily_kline_points(frame)

    assert [p.date for p in points] == ["2026-01-12", "2026-01-13"]
    assert points[0].volume is None
    assert points[1].volume == 100.0


def test_daily_kline_points_handles_empty_and_none_frames():
    assert _daily_kline_points(None) == []
    assert _daily_kline_points(pd.DataFrame()) == []


def test_daily_kline_points_keeps_non_numeric_volume_nullable():
    frame = _frame(
        [
            {"date": "2026-02-01", "open": "1.0", "high": "1.4", "low": "0.9", "close": "1.2", "volume": "n/a"},
            {"date": "2026-02-02", "open": 2.0, "high": 2.4, "low": 1.9, "close": 2.2, "volume": float("nan")},
        ]
    )

    points = _daily_kline_points(frame)

    assert [p.volume for p in points] == [None, None]
    assert points[0].close == 1.2


def test_daily_kline_returns_ascending_points():
    manager = _FakeManager(
        frame=_frame(
            [
                {"date": "2026-02-02", "open": 2.0, "high": 2.4, "low": 1.9, "close": 2.2, "volume": 20.0},
                {"date": "2026-02-01", "open": 1.0, "high": 1.4, "low": 0.9, "close": 1.2, "volume": 10.0},
            ]
        )
    )

    with tempfile.TemporaryDirectory() as temp_dir:
        client = _client()
        with patch("api.v1.endpoints.data.DataFetcherManager", lambda: manager):
            response = client.get("/api/v1/data/daily-kline", params={"code": "600519", "days": 120})

    assert response.status_code == 200
    payload = response.json()
    assert payload["code"] == "600519"
    assert [p["date"] for p in payload["points"]] == ["2026-02-01", "2026-02-02"]
    assert payload["points"][0] == {
        "date": "2026-02-01",
        "open": 1.0,
        "high": 1.4,
        "low": 0.9,
        "close": 1.2,
        "volume": 10.0,
    }
    assert manager.calls == [{"stock_code": "600519", "days": min(120, MAX_DAILY_KLINE_DAYS)}]


def test_daily_kline_caps_days_at_limit():
    manager = _FakeManager(
        frame=_frame(
            [{"date": "2026-02-01", "open": 1.0, "high": 1.4, "low": 0.9, "close": 1.2, "volume": 10.0}]
        )
    )

    with tempfile.TemporaryDirectory() as temp_dir:
        client = _client()
        with patch("api.v1.endpoints.data.DataFetcherManager", lambda: manager):
            response = client.get("/api/v1/data/daily-kline", params={"code": "600519", "days": 99999})

    assert response.status_code == 422  # Query validation rejects beyond the cap
    assert manager.calls == []


def test_daily_kline_rejects_invalid_code():
    with tempfile.TemporaryDirectory() as temp_dir:
        client = _client()
        response = client.get("/api/v1/data/daily-kline", params={"code": "not a code"})

    assert response.status_code == 400
    # 全局异常处理器会把 HTTPException.detail dict 直接作为响应体
    assert response.json()["error"] == "invalid_stock_code"


def test_daily_kline_returns_404_when_all_sources_fail():
    manager = _FakeManager(error=DataFetchError("600519: all sources failed"))

    with tempfile.TemporaryDirectory() as temp_dir:
        client = _client()
        with patch("api.v1.endpoints.data.DataFetcherManager", lambda: manager):
            response = client.get("/api/v1/data/daily-kline", params={"code": "600519"})

    assert response.status_code == 404
    assert response.json()["error"] == "not_found"


def test_daily_kline_returns_404_for_empty_frame():
    manager = _FakeManager(frame=pd.DataFrame())

    with tempfile.TemporaryDirectory() as temp_dir:
        client = _client()
        with patch("api.v1.endpoints.data.DataFetcherManager", lambda: manager):
            response = client.get("/api/v1/data/daily-kline", params={"code": "600519"})

    assert response.status_code == 404

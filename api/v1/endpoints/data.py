# -*- coding: utf-8 -*-
"""Data capability and quality endpoints."""

from __future__ import annotations

import logging
import math
import threading
from typing import Any, Optional

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query, Request

from api.deps import get_config_dep, get_current_user
from api.v1.endpoints.stocks import _validate_and_normalize_stock_code
from api.v1.schemas.common import ErrorResponse
from api.v1.schemas.data_capability import (
    DailyKlinePoint,
    DailyKlineResponse,
    DataCapabilityOverviewResponse,
)
from src.config import Config
from src.services.data_capability_service import DataCapabilityService
from data_provider.base import DataFetchError, DataFetcherManager

logger = logging.getLogger(__name__)

router = APIRouter()

# 日 K 单次返回上限（交易日）。
MAX_DAILY_KLINE_DAYS = 250

# 进程内复用同一个 DataFetcherManager：重建实例会带来数据源重复初始化开销，
# 也会让熔断/冷却状态无法跨请求生效。
_fetcher_manager: Optional[DataFetcherManager] = None
_fetcher_manager_lock = threading.Lock()


def _get_fetcher_manager() -> DataFetcherManager:
    """Return the process-wide DataFetcherManager (lazily created)."""
    global _fetcher_manager
    if _fetcher_manager is None:
        with _fetcher_manager_lock:
            if _fetcher_manager is None:
                _fetcher_manager = DataFetcherManager()
    return _fetcher_manager


def _overview_response(config: Config, *, runtime_scheduler: object = None) -> DataCapabilityOverviewResponse:
    try:
        payload = DataCapabilityService(
            config=config,
            runtime_scheduler=runtime_scheduler,
        ).get_overview()
        return DataCapabilityOverviewResponse.model_validate(payload)
    except Exception as exc:  # noqa: BLE001 - keep diagnostics fail-open at API boundary.
        logger.error("Failed to build data capability overview: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail={
                "error": "internal_error",
                "message": "Failed to build data capability overview",
            },
        )


@router.get(
    "/overview",
    response_model=DataCapabilityOverviewResponse,
    responses={500: {"model": ErrorResponse}},
    summary="Get data capability overview",
    description="Return provider capabilities, dataset quality, and source priority without exposing secrets.",
)
def get_data_overview(
    request: Request,
    config: Config = Depends(get_config_dep),
) -> DataCapabilityOverviewResponse:
    """Return the canonical read-only data overview."""
    return _overview_response(
        config,
        runtime_scheduler=getattr(request.app.state, "runtime_scheduler_service", None),
    )


@router.get(
    "/capabilities",
    response_model=DataCapabilityOverviewResponse,
    responses={500: {"model": ErrorResponse}},
    summary="Get data provider capabilities",
    description="Alias of /data/overview for clients that only need capability metadata.",
)
def get_data_capabilities(
    request: Request,
    config: Config = Depends(get_config_dep),
) -> DataCapabilityOverviewResponse:
    """Return the data overview under the capability-oriented alias."""
    return _overview_response(
        config,
        runtime_scheduler=getattr(request.app.state, "runtime_scheduler_service", None),
    )


def _to_float(value: Any) -> Optional[float]:
    """Best-effort numeric conversion; returns None for missing/NaN/non-numeric values."""
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _daily_kline_points(frame: pd.DataFrame) -> list:
    """Normalize a daily DataFrame into ascending chart points.

    Skips rows with missing/NaN OHLC values and keeps volume nullable so a
    partially degraded source row does not break the whole series.
    """
    points: list = []
    if frame is None or frame.empty or "date" not in frame.columns:
        return points

    working = frame.copy()
    working["date"] = pd.to_datetime(working["date"], errors="coerce")
    working = working.dropna(subset=["date"]).sort_values("date")

    for _, row in working.iterrows():
        ohlc: dict = {}
        for key in ("open", "high", "low", "close"):
            value = _to_float(row.get(key))
            if value is None:
                ohlc = {}
                break
            ohlc[key] = value
        if not ohlc:
            continue

        points.append(
            DailyKlinePoint(
                date=row["date"].strftime("%Y-%m-%d"),
                volume=_to_float(row.get("volume")),
                **ohlc,
            )
        )
    return points


@router.get(
    "/daily-kline",
    response_model=DailyKlineResponse,
    responses={
        400: {"description": "股票代码无效", "model": ErrorResponse},
        404: {"description": "无可用日线数据", "model": ErrorResponse},
        500: {"description": "服务器错误", "model": ErrorResponse},
    },
    summary="获取个股日 K 线",
    description="为报告页价格图返回最近的日 K 数据（默认 120 天，上限 250 个交易日，按日期升序）。",
)
def get_daily_kline(
    code: str = Query(..., description="股票代码（如 600519、hk00700、AAPL）"),
    days: int = Query(120, ge=1, le=MAX_DAILY_KLINE_DAYS, description="日线天数"),
    current_user: Optional[dict] = Depends(get_current_user),
) -> DailyKlineResponse:
    """Return recent daily K-line rows for the report price chart.

    行情数据为全局共享数据，不做 owner 作用域过滤；认证仍由中间件 +
    get_current_user 依赖链统一控制。
    """
    del current_user  # 仅用于保持与其他数据接口一致的依赖签名
    normalized = _validate_and_normalize_stock_code(code)

    try:
        frame, _source = _get_fetcher_manager().get_daily_data(
            stock_code=normalized,
            days=min(days, MAX_DAILY_KLINE_DAYS),
        )
    except DataFetchError as exc:
        logger.warning("[daily-kline] %s 无可用日线数据: %s", normalized, exc)
        raise HTTPException(
            status_code=404,
            detail={
                "error": "not_found",
                "message": f"未获取到股票 {normalized} 的日线数据",
            },
        )

    points = _daily_kline_points(frame if isinstance(frame, pd.DataFrame) else pd.DataFrame())
    if not points:
        raise HTTPException(
            status_code=404,
            detail={
                "error": "not_found",
                "message": f"未获取到股票 {normalized} 的日线数据",
            },
        )
    return DailyKlineResponse(code=normalized, points=points)

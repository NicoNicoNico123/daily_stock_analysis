# -*- coding: utf-8 -*-
"""LLM usage tracking endpoint."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query

from api.deps import get_current_user, get_database_manager, resolve_owner_scope
from api.v1.schemas.usage import UsageDashboardResponse, UsageSummaryResponse
from src.storage import DatabaseManager

logger = logging.getLogger(__name__)

_CST = timezone(timedelta(hours=8))  # Beijing time (UTC+8)

router = APIRouter()

_VALID_PERIODS = {"today", "month", "all"}


def _date_range(period: str):
    """Return (from_dt, to_dt) as naive datetimes in Beijing time (UTC+8)."""
    now = datetime.now(tz=_CST).replace(tzinfo=None)  # naive, Beijing local
    if period == "today":
        from_dt = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == "month":
        from_dt = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    else:  # all
        from_dt = datetime(2000, 1, 1)
    return from_dt, now


def _normalize_period(period: str) -> str:
    return period if period in _VALID_PERIODS else "month"


def _enrich_call_record(row: dict[str, Any]) -> dict[str, Any]:
    called_at = row.get("called_at")
    if isinstance(called_at, datetime):
        called_at_value = called_at.isoformat()
    else:
        called_at_value = str(called_at or "")
    return {
        **row,
        "called_at": called_at_value,
    }


def _scope_kwargs(owner_user_id: Optional[str], include_unowned: bool) -> dict[str, Any]:
    """仅在有明确归属时透传作用域参数；单用户/匿名保持原有调用路径不变。"""
    if owner_user_id is None:
        return {}
    return {"owner_user_id": owner_user_id, "include_unowned": include_unowned}


def _build_summary_payload(period: str, from_dt: datetime, to_dt: datetime, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "period": period,
        "from_date": from_dt.date().isoformat(),
        "to_date": to_dt.date().isoformat(),
        "total_calls": data.get("total_calls", 0),
        "total_prompt_tokens": data.get("total_prompt_tokens", 0),
        "total_completion_tokens": data.get("total_completion_tokens", 0),
        "total_tokens": data.get("total_tokens", 0),
        "by_call_type": data.get("by_call_type", []),
        "by_model": data.get("by_model", []),
    }


@router.get(
    "/summary",
    response_model=UsageSummaryResponse,
    summary="LLM token usage summary",
    description="Aggregate token consumption by period, call type, and model.",
)
def get_usage_summary(
    period: str = Query("month", description="'today' | 'month' | 'all'"),
    db_manager: DatabaseManager = Depends(get_database_manager),
    current_user: Optional[dict] = Depends(get_current_user),
) -> UsageSummaryResponse:
    # 多用户模式按登录用户聚合 LLM 用量；admin 额外计入 legacy 无主记录
    owner_user_id, include_unowned = resolve_owner_scope(current_user)
    normalized_period = _normalize_period(period)
    from_dt, to_dt = _date_range(normalized_period)
    data = db_manager.get_llm_usage_summary(
        from_dt,
        to_dt,
        **_scope_kwargs(owner_user_id, include_unowned),
    )
    return UsageSummaryResponse(**_build_summary_payload(normalized_period, from_dt, to_dt, data))


@router.get(
    "/dashboard",
    response_model=UsageDashboardResponse,
    summary="LLM token usage monitoring dashboard",
    description="Return token totals, model breakdowns, and recent LLM call records.",
)
def get_usage_dashboard(
    period: str = Query("month", description="'today' | 'month' | 'all'"),
    limit: int = Query(50, ge=1, le=200, description="Recent call records to include"),
    db_manager: DatabaseManager = Depends(get_database_manager),
    current_user: Optional[dict] = Depends(get_current_user),
) -> UsageDashboardResponse:
    # 多用户模式按登录用户聚合与读取明细；单用户模式 (None, False) 保持原行为
    owner_user_id, include_unowned = resolve_owner_scope(current_user)
    normalized_period = _normalize_period(period)
    from_dt, to_dt = _date_range(normalized_period)
    scope = _scope_kwargs(owner_user_id, include_unowned)
    data = db_manager.get_llm_usage_summary(from_dt, to_dt, **scope)
    records = db_manager.get_llm_usage_records(
        from_dt,
        to_dt,
        limit=limit,
        **scope,
    )
    payload = _build_summary_payload(normalized_period, from_dt, to_dt, data)
    payload["recent_calls"] = [_enrich_call_record(row) for row in records]
    return UsageDashboardResponse(**payload)

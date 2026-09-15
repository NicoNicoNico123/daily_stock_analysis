# -*- coding: utf-8 -*-
"""Stock screening routes."""

from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from api.deps import get_config_dep, get_current_user, get_database_manager, resolve_owner_scope
from api.v1.errors import api_error
from src.config import Config
from src.services.screening_service import ScreeningService
from src.services.task_queue import TaskStatus as QueueTaskStatus
from src.services.task_queue import get_task_queue
from src.storage import DatabaseManager

router = APIRouter()


class ScreeningScreenRequest(BaseModel):
    market: str = Field("cn", min_length=1, max_length=16)
    strategy: str = Field("dual_low", min_length=1, max_length=64)
    max_results: int = Field(20, ge=1, le=100)
    variant_seed: str = Field("", max_length=128)


class ScreeningStrategyResponse(BaseModel):
    id: str
    name: str = ""
    title: str = ""
    description: str = ""
    category: str = ""
    tag: str = ""
    tags: List[str] = Field(default_factory=list)
    market_scope: List[str] = Field(default_factory=list)
    market: str = ""
    analysis_skills: List[str] = Field(default_factory=list)


class ScreeningScreenAccepted(BaseModel):
    task_id: str
    trace_id: str
    status: str = "pending"
    message: str
    strategy: str
    market: str
    max_results: int


class ScreeningScreenTaskStatus(BaseModel):
    task_id: str
    trace_id: Optional[str] = None
    status: str
    progress: int = 0
    message: Optional[str] = None
    error: Optional[str] = None
    result: Optional[Dict[str, Any]] = None


def _service(config: Config, db_manager: Any = None) -> ScreeningService:
    usable_db = db_manager if callable(getattr(db_manager, "save_screening_run", None)) else None
    return ScreeningService(config=config, db_manager=usable_db)


class _OwnerScopedDatabaseManager:
    """把 screening_runs 读写绑定到当前用户作用域的 DatabaseManager 轻代理。

    ScreeningService 不感知多用户身份；该代理把 owner 透传给
    DatabaseManager 的选股历史作用域方法，其余方法原样转发。
    """

    def __init__(self, inner: DatabaseManager, *, owner_user_id: Optional[str], include_unowned: bool) -> None:
        self._inner = inner
        self._owner_user_id = owner_user_id
        self._include_unowned = include_unowned

    def save_screening_run(self, payload: Dict[str, Any], owner_user_id: Optional[str] = None) -> int:
        return self._inner.save_screening_run(payload, owner_user_id=self._owner_user_id)

    def list_screening_runs(self, **kwargs: Any) -> List[Dict[str, Any]]:
        kwargs["owner_user_id"] = self._owner_user_id
        kwargs["include_unowned"] = self._include_unowned
        return self._inner.list_screening_runs(**kwargs)

    def get_screening_run(
        self,
        run_id: str,
        owner_user_id: Optional[str] = None,
        include_unowned: bool = False,
    ) -> Optional[Dict[str, Any]]:
        # 他人运行返回 None，由 ScreeningService 统一映射为 404
        return self._inner.get_screening_run(
            run_id,
            owner_user_id=self._owner_user_id,
            include_unowned=self._include_unowned,
        )

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


def _scoped_db_manager(db_manager: Any, current_user: Optional[dict]) -> Any:
    """单用户模式 (None, False) 直接返回原 db_manager，保持原有调用路径不变。"""
    owner_user_id, include_unowned = resolve_owner_scope(current_user)
    if owner_user_id is None:
        return db_manager
    return _OwnerScopedDatabaseManager(
        db_manager,
        owner_user_id=owner_user_id,
        include_unowned=include_unowned,
    )


def _scoped_service(config: Config, db_manager: Any, current_user: Optional[dict]) -> ScreeningService:
    return _service(config, _scoped_db_manager(db_manager, current_user))


def _screening_task_not_found(task_id: str) -> HTTPException:
    return api_error(
        404,
        "screening_screen_task_not_found",
        f"选股任务 {task_id} 不存在或已过期",
    )


@router.get("/status")
def screening_status(config: Config = Depends(get_config_dep)) -> Dict[str, Any]:
    return _service(config).status()


@router.get("/strategies")
def screening_strategies(
    request: Request,
    config: Config = Depends(get_config_dep),
) -> Dict[str, Any]:
    return _service(config).strategies()


@router.get("/hotspots")
def screening_hotspots(
    provider: str = Query("", max_length=32),
    top: int = Query(12, ge=1, le=50),
    refresh: bool = Query(False),
    include_details: bool = Query(False),
    config: Config = Depends(get_config_dep),
) -> Dict[str, Any]:
    refresh_value = refresh if isinstance(refresh, bool) else bool(getattr(refresh, "default", False))
    include_details_value = (
        include_details
        if isinstance(include_details, bool)
        else bool(getattr(include_details, "default", False))
    )
    return _service(config).hotspots(
        provider=provider,
        top=top,
        refresh=refresh_value,
        include_details=include_details_value,
    )


@router.get("/hotspots/{topic:path}")
def screening_hotspot_detail(
    topic: str,
    provider: str = Query("", max_length=32),
    refresh: bool = Query(False),
    include_search: bool = Query(False),
    config: Config = Depends(get_config_dep),
) -> Dict[str, Any]:
    refresh_value = refresh if isinstance(refresh, bool) else bool(getattr(refresh, "default", False))
    include_search_value = (
        include_search
        if isinstance(include_search, bool)
        else bool(getattr(include_search, "default", False))
    )
    return _service(config).hotspot_detail(
        topic=topic,
        provider=provider,
        refresh=refresh_value,
        include_search=include_search_value,
    )


@router.post("/screen/tasks", status_code=202, response_model=ScreeningScreenAccepted)
def screening_start_screen_task(
    request: ScreeningScreenRequest,
    http_request: Request,
    config: Config = Depends(get_config_dep),
    db_manager: DatabaseManager = Depends(get_database_manager),
    current_user: Optional[dict] = Depends(get_current_user),
) -> ScreeningScreenAccepted:
    task_id = uuid.uuid4().hex
    task_queue = get_task_queue()
    # 在请求上下文内解析归属，后台线程只使用已解析的作用域参数
    scoped_db = _scoped_db_manager(db_manager, current_user)

    def run_screen() -> Dict[str, Any]:
        task_queue.update_task_progress(
            task_id,
            20,
            "正在执行选股，外部数据源较慢时会持续后台运行",
        )

        def report_progress(progress: int, message: str) -> None:
            task_queue.update_task_progress(task_id, progress, message)

        result = _service(config, scoped_db).screen(
            strategy=request.strategy,
            market=request.market,
            max_results=request.max_results,
            selection_seed=request.variant_seed,
            progress_callback=report_progress,
        )
        task_queue.update_task_progress(
            task_id,
            98,
            f"选股已完成，正在整理 {result.get('candidate_count', 0)} 条候选",
        )
        return result

    task = task_queue.submit_background_task(
        run_screen,
        stock_code="screening_screen",
        stock_name=f"{request.strategy} / {request.market}",
        report_type="screening_screen",
        message="选股任务已提交",
        task_id=task_id,
        trace_id=task_id,
    )
    return ScreeningScreenAccepted(
        task_id=task.task_id,
        trace_id=task.trace_id or task.task_id,
        status=task.status.value if isinstance(task.status, QueueTaskStatus) else str(task.status),
        message=task.message or "选股任务已提交",
        strategy=request.strategy,
        market=request.market,
        max_results=request.max_results,
    )


@router.get("/screen/tasks/{task_id}", response_model=ScreeningScreenTaskStatus)
def screening_screen_task_status(task_id: str) -> ScreeningScreenTaskStatus:
    task = get_task_queue().get_task(task_id)
    if task is None or task.report_type != "screening_screen":
        raise _screening_task_not_found(task_id)

    result = task.result if task.status == QueueTaskStatus.COMPLETED and isinstance(task.result, dict) else None
    return ScreeningScreenTaskStatus(
        task_id=task.task_id,
        trace_id=task.trace_id or task.task_id,
        status=task.status.value if isinstance(task.status, QueueTaskStatus) else str(task.status),
        progress=task.progress,
        message=task.message,
        error=task.error,
        result=result,
    )


@router.post("/screen")
def screening_screen(
    request: ScreeningScreenRequest,
    http_request: Request,
    config: Config = Depends(get_config_dep),
    db_manager: DatabaseManager = Depends(get_database_manager),
    current_user: Optional[dict] = Depends(get_current_user),
) -> Dict[str, Any]:
    return _scoped_service(config, db_manager, current_user).screen(
        strategy=request.strategy,
        market=request.market,
        max_results=request.max_results,
        selection_seed=request.variant_seed,
    )


@router.get("/history")
def screening_history(
    limit: int = Query(20, ge=1, le=100),
    strategy: str = Query("", max_length=64),
    market: str = Query("", max_length=16),
    config: Config = Depends(get_config_dep),
    db_manager: DatabaseManager = Depends(get_database_manager),
    current_user: Optional[dict] = Depends(get_current_user),
) -> Dict[str, Any]:
    # 多用户模式按登录用户过滤选股运行历史；admin 额外可见 legacy 无主记录
    return _scoped_service(config, db_manager, current_user).history(
        limit=limit,
        strategy=strategy,
        market=market,
    )


@router.get("/history/{run_id}")
def screening_history_detail(
    run_id: str,
    config: Config = Depends(get_config_dep),
    db_manager: DatabaseManager = Depends(get_database_manager),
    current_user: Optional[dict] = Depends(get_current_user),
) -> Dict[str, Any]:
    # 他人运行由 ScreeningService 以 404 返回
    return _scoped_service(config, db_manager, current_user).history_detail(run_id)


@router.get("/source-history")
def screening_source_history(
    limit: int = Query(100, ge=1, le=100),
    config: Config = Depends(get_config_dep),
    db_manager: DatabaseManager = Depends(get_database_manager),
    current_user: Optional[dict] = Depends(get_current_user),
) -> Dict[str, Any]:
    return _scoped_service(config, db_manager, current_user).source_history(limit=limit)

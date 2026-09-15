# -*- coding: utf-8 -*-
"""Alert API endpoints (Issue #1202 P1 MVP)."""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from api.deps import get_current_user, resolve_owner_scope
from api.v1.schemas.alerts import (
    AlertDeleteResponse,
    AlertNotificationListResponse,
    AlertRuleCreateRequest,
    AlertRuleItem,
    AlertRuleListResponse,
    AlertRuleTestResponse,
    AlertRuleUpdateRequest,
    AlertTriggerListResponse,
)
from api.v1.schemas.common import ErrorResponse
from src.services.alert_service import (
    AlertNotFoundError,
    AlertService,
    AlertServiceError,
    UnsupportedAlertTypeError,
)

logger = logging.getLogger(__name__)

router = APIRouter()


def _bad_request(exc: Exception, *, error: str = "validation_error") -> HTTPException:
    return HTTPException(
        status_code=400,
        detail={"error": error, "message": str(exc)},
    )


def _not_found(exc: Exception) -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={"error": "not_found", "message": str(exc)},
    )


def _internal_error(message: str, exc: Exception) -> HTTPException:
    logger.error("%s: %s", message, exc, exc_info=True)
    return HTTPException(
        status_code=500,
        detail={"error": "internal_error", "message": f"{message}: {str(exc)}"},
    )


@router.post(
    "/rules",
    response_model=AlertRuleItem,
    responses={400: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
    summary="Create alert rule",
)
def create_rule(
    request: AlertRuleCreateRequest,
    current_user: Optional[dict] = Depends(get_current_user),
) -> AlertRuleItem:
    # 多用户模式写入规则归属；单用户模式 (None, False) 保持原行为
    owner_user_id, include_unowned = resolve_owner_scope(current_user)
    service = AlertService()
    try:
        return AlertRuleItem(**service.create_rule(request.model_dump(), owner_user_id=owner_user_id))
    except UnsupportedAlertTypeError as exc:
        raise _bad_request(exc, error=exc.error_code)
    except AlertServiceError as exc:
        raise _bad_request(exc, error=exc.error_code)
    except Exception as exc:
        raise _internal_error("Create alert rule failed", exc)


@router.get(
    "/rules",
    response_model=AlertRuleListResponse,
    responses={500: {"model": ErrorResponse}},
    summary="List alert rules",
)
def list_rules(
    enabled: Optional[bool] = Query(None, description="Optional enabled filter"),
    alert_type: Optional[str] = Query(None, description="Optional alert type filter"),
    target_scope: Optional[str] = Query(None, description="Optional target scope filter"),
    target: Optional[str] = Query(None, description="Optional target filter"),
    source: Optional[str] = Query(None, description="Optional source filter"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    current_user: Optional[dict] = Depends(get_current_user),
) -> AlertRuleListResponse:
    # 多用户模式按登录用户过滤规则；admin 额外可见 legacy 无主规则
    owner_user_id, include_unowned = resolve_owner_scope(current_user)
    service = AlertService()
    try:
        return AlertRuleListResponse(
            **service.list_rules(
                enabled=enabled,
                alert_type=alert_type,
                target_scope=target_scope,
                target=target,
                source=source,
                page=page,
                page_size=page_size,
                owner_user_id=owner_user_id,
                include_unowned=include_unowned,
            )
        )
    except Exception as exc:
        raise _internal_error("List alert rules failed", exc)


@router.get(
    "/rules/{rule_id}",
    response_model=AlertRuleItem,
    responses={404: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
    summary="Get alert rule",
)
def get_rule(
    rule_id: int,
    current_user: Optional[dict] = Depends(get_current_user),
) -> AlertRuleItem:
    # 越权读取按 404 处理，避免暴露他人规则的存在性
    owner_user_id, include_unowned = resolve_owner_scope(current_user)
    service = AlertService()
    try:
        return AlertRuleItem(**service.get_rule(rule_id, owner_user_id=owner_user_id, include_unowned=include_unowned))
    except AlertNotFoundError as exc:
        raise _not_found(exc)
    except Exception as exc:
        raise _internal_error("Get alert rule failed", exc)


@router.patch(
    "/rules/{rule_id}",
    response_model=AlertRuleItem,
    responses={400: {"model": ErrorResponse}, 404: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
    summary="Update alert rule",
)
def update_rule(
    rule_id: int,
    request: AlertRuleUpdateRequest,
    current_user: Optional[dict] = Depends(get_current_user),
) -> AlertRuleItem:
    # 越权更新按 404 处理
    owner_user_id, include_unowned = resolve_owner_scope(current_user)
    service = AlertService()
    try:
        payload = request.model_dump(exclude_unset=True)
        return AlertRuleItem(
            **service.update_rule(
                rule_id,
                payload,
                owner_user_id=owner_user_id,
                include_unowned=include_unowned,
            )
        )
    except AlertNotFoundError as exc:
        raise _not_found(exc)
    except UnsupportedAlertTypeError as exc:
        raise _bad_request(exc, error=exc.error_code)
    except AlertServiceError as exc:
        raise _bad_request(exc, error=exc.error_code)
    except Exception as exc:
        raise _internal_error("Update alert rule failed", exc)


@router.delete(
    "/rules/{rule_id}",
    response_model=AlertDeleteResponse,
    responses={404: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
    summary="Delete alert rule",
)
def delete_rule(
    rule_id: int,
    current_user: Optional[dict] = Depends(get_current_user),
) -> AlertDeleteResponse:
    # 越权删除按 404 处理
    owner_user_id, include_unowned = resolve_owner_scope(current_user)
    service = AlertService()
    try:
        if not service.delete_rule(rule_id, owner_user_id=owner_user_id, include_unowned=include_unowned):
            raise AlertNotFoundError(f"Alert rule not found: {rule_id}")
        return AlertDeleteResponse(deleted=1)
    except AlertNotFoundError as exc:
        raise _not_found(exc)
    except Exception as exc:
        raise _internal_error("Delete alert rule failed", exc)


@router.post(
    "/rules/{rule_id}/enable",
    response_model=AlertRuleItem,
    responses={404: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
    summary="Enable alert rule",
)
def enable_rule(
    rule_id: int,
    current_user: Optional[dict] = Depends(get_current_user),
) -> AlertRuleItem:
    owner_user_id, include_unowned = resolve_owner_scope(current_user)
    service = AlertService()
    try:
        return AlertRuleItem(
            **service.enable_rule(rule_id, True, owner_user_id=owner_user_id, include_unowned=include_unowned)
        )
    except AlertNotFoundError as exc:
        raise _not_found(exc)
    except Exception as exc:
        raise _internal_error("Enable alert rule failed", exc)


@router.post(
    "/rules/{rule_id}/disable",
    response_model=AlertRuleItem,
    responses={404: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
    summary="Disable alert rule",
)
def disable_rule(
    rule_id: int,
    current_user: Optional[dict] = Depends(get_current_user),
) -> AlertRuleItem:
    owner_user_id, include_unowned = resolve_owner_scope(current_user)
    service = AlertService()
    try:
        return AlertRuleItem(
            **service.enable_rule(rule_id, False, owner_user_id=owner_user_id, include_unowned=include_unowned)
        )
    except AlertNotFoundError as exc:
        raise _not_found(exc)
    except Exception as exc:
        raise _internal_error("Disable alert rule failed", exc)


@router.post(
    "/rules/{rule_id}/test",
    response_model=AlertRuleTestResponse,
    responses={404: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
    summary="Dry-run alert rule",
)
def test_rule(
    rule_id: int,
    current_user: Optional[dict] = Depends(get_current_user),
) -> AlertRuleTestResponse:
    # 试算跟随规则归属；越权按 404 处理
    owner_user_id, include_unowned = resolve_owner_scope(current_user)
    service = AlertService()
    try:
        return AlertRuleTestResponse(
            **service.test_rule(rule_id, owner_user_id=owner_user_id, include_unowned=include_unowned)
        )
    except AlertNotFoundError as exc:
        raise _not_found(exc)
    except Exception as exc:
        raise _internal_error("Test alert rule failed", exc)


@router.get(
    "/triggers",
    response_model=AlertTriggerListResponse,
    responses={500: {"model": ErrorResponse}},
    summary="List alert trigger history",
)
def list_triggers(
    rule_id: Optional[int] = Query(None, description="Optional rule id filter"),
    target: Optional[str] = Query(None, description="Optional target filter"),
    status: Optional[str] = Query(None, description="Optional status filter"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    current_user: Optional[dict] = Depends(get_current_user),
) -> AlertTriggerListResponse:
    # 触发历史按所属规则归属过滤
    owner_user_id, include_unowned = resolve_owner_scope(current_user)
    service = AlertService()
    try:
        return AlertTriggerListResponse(
            **service.list_triggers(
                rule_id=rule_id,
                target=target,
                status=status,
                page=page,
                page_size=page_size,
                owner_user_id=owner_user_id,
                include_unowned=include_unowned,
            )
        )
    except Exception as exc:
        raise _internal_error("List alert triggers failed", exc)


@router.get(
    "/notifications",
    response_model=AlertNotificationListResponse,
    responses={500: {"model": ErrorResponse}},
    summary="List alert notification attempts",
)
def list_notifications(
    trigger_id: Optional[int] = Query(None, description="Optional trigger id filter"),
    channel: Optional[str] = Query(None, description="Optional channel filter"),
    success: Optional[bool] = Query(None, description="Optional success filter"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    current_user: Optional[dict] = Depends(get_current_user),
) -> AlertNotificationListResponse:
    # 投递记录按冗余 user_id 过滤
    owner_user_id, include_unowned = resolve_owner_scope(current_user)
    service = AlertService()
    try:
        return AlertNotificationListResponse(
            **service.list_notifications(
                trigger_id=trigger_id,
                channel=channel,
                success=success,
                page=page,
                page_size=page_size,
                owner_user_id=owner_user_id,
                include_unowned=include_unowned,
            )
        )
    except Exception as exc:
        raise _internal_error("List alert notifications failed", exc)

# -*- coding: utf-8 -*-
"""用户管理端点（多用户模式，仅管理员可用）。"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from api.deps import require_admin
from src.auth import (
    change_user_account_password,
    get_user_account,
    is_multi_user_enabled,
    list_user_accounts,
    set_user_account_active,
    set_user_account_role,
)

logger = logging.getLogger(__name__)

router = APIRouter(dependencies=[Depends(require_admin)])


class CreateUserRequest(BaseModel):
    """管理员创建账号请求。"""

    username: str = Field(default="", description="Username")
    password: str = Field(default="", description="Initial password")
    role: str = Field(default="user", description="'admin' | 'user'")


class UpdateUserRequest(BaseModel):
    """角色 / 启用状态变更请求。"""

    model_config = {"populate_by_name": True}

    role: Optional[str] = Field(default=None)
    is_active: Optional[bool] = Field(default=None, alias="isActive")


class ResetPasswordRequest(BaseModel):
    """管理员重置密码请求。"""

    new_password: str = Field(default="", alias="newPassword")


def _multi_user_guard() -> Optional[JSONResponse]:
    """多用户模式总闸：关闭时用户管理不可用。"""
    if not is_multi_user_enabled():
        return JSONResponse(
            status_code=403,
            content={"error": "multi_user_disabled", "message": "多用户模式未开启"},
        )
    return None


def _user_payload(user: dict) -> dict:
    return {
        "id": user["id"],
        "username": user["username"],
        "role": user["role"],
        "isActive": user["is_active"],
        "createdAt": user["created_at"].isoformat() + "Z" if user.get("created_at") else None,
    }


@router.get(
    "",
    summary="List users",
    description="List all user accounts (no credential material).",
)
async def admin_list_users():
    guard = _multi_user_guard()
    if guard:
        return guard
    return {"users": [_user_payload(u) for u in list_user_accounts()]}


@router.post(
    "",
    summary="Create user",
    description="Create an account. First account auto-becomes admin when no admin exists.",
)
async def admin_create_user(body: CreateUserRequest):
    guard = _multi_user_guard()
    if guard:
        return guard

    from src.auth import create_user_account

    error_code, user = create_user_account(
        (body.username or "").strip(),
        body.password or "",
        role=(body.role or "user").strip() or "user",
    )
    if error_code == "invalid_username":
        return JSONResponse(
            status_code=400,
            content={"error": "invalid_username", "message": "用户名需为 3-32 位字母、数字、下划线或连字符"},
        )
    if error_code == "invalid_password":
        return JSONResponse(
            status_code=400,
            content={"error": "invalid_password", "message": "密码至少 6 位"},
        )
    if error_code == "username_taken":
        return JSONResponse(
            status_code=409,
            content={"error": "username_taken", "message": "用户名已被使用"},
        )
    if error_code == "max_users":
        return JSONResponse(
            status_code=403,
            content={"error": "quota_exceeded", "message": "已达到用户数量上限（MULTI_USER_MAX_USERS）"},
        )
    if error_code or user is None:
        return JSONResponse(
            status_code=500,
            content={"error": "internal_error", "message": "Failed to create account"},
        )
    return JSONResponse(status_code=201, content={"user": _user_payload(user)})


@router.patch(
    "/{user_id}",
    summary="Update user role/active",
    description="Change role or enable/disable. Bumps token_version; protects the last active admin.",
)
async def admin_update_user(user_id: int, body: UpdateUserRequest):
    guard = _multi_user_guard()
    if guard:
        return guard

    if body.role is None and body.is_active is None:
        return JSONResponse(
            status_code=400,
            content={"error": "nothing_to_update", "message": "未提供要更新的字段"},
        )

    if body.role is not None:
        error_code, user = set_user_account_role(user_id, (body.role or "").strip())
        if error_code:
            return _update_error_response(error_code)

    if body.is_active is not None:
        error_code, user = set_user_account_active(user_id, bool(body.is_active))
        if error_code:
            return _update_error_response(error_code)

    refreshed = get_user_account(user_id)
    return {"user": _user_payload(refreshed) if refreshed else None}


def _update_error_response(error_code: str) -> JSONResponse:
    mapping = {
        "user_not_found": (404, "用户不存在"),
        "last_admin": (409, "不能降级或禁用最后一个可用管理员"),
        "invalid_role": (400, "角色仅支持 admin / user"),
        "storage_error": (500, "更新失败"),
    }
    status, message = mapping.get(error_code, (500, "更新失败"))
    return JSONResponse(status_code=status, content={"error": error_code, "message": message})


@router.post(
    "/{user_id}/reset-password",
    summary="Reset user password",
    description="Admin resets a user's password. Invalidates that user's existing sessions.",
)
async def admin_reset_password(user_id: int, body: ResetPasswordRequest):
    guard = _multi_user_guard()
    if guard:
        return guard

    err = change_user_account_password(user_id, body.new_password or "")
    if err and err.startswith("密码至少"):
        return JSONResponse(
            status_code=400,
            content={"error": "invalid_password", "message": err},
        )
    if err == "用户不存在":
        return JSONResponse(
            status_code=404,
            content={"error": "user_not_found", "message": err},
        )
    if err:
        return JSONResponse(
            status_code=500,
            content={"error": "internal_error", "message": err},
        )
    return Response(status_code=204)

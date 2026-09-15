# -*- coding: utf-8 -*-
"""Authentication endpoints for Web admin login."""

from __future__ import annotations

import logging
import os

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from api.deps import get_current_user, get_system_config_service, require_admin
from src.auth import (
    COOKIE_NAME,
    SESSION_MAX_AGE_HOURS_DEFAULT,
    change_password,
    change_user_password,
    check_rate_limit,
    check_registration_rate_limit,
    clear_rate_limit,
    create_session,
    create_user_account,
    get_client_ip,
    get_current_user_from_request,
    get_user_account,
    has_stored_password,
    is_auth_enabled,
    is_multi_user_enabled,
    is_password_changeable,
    is_password_set,
    is_registration_enabled,
    login_failure_key,
    record_login_failure,
    record_registration_failure,
    refresh_auth_state,
    resolve_session_user,
    rotate_session_secret,
    set_initial_password,
    verify_password,
    verify_stored_password,
    verify_user_credentials,
    verify_session,
)
from src.config import Config, setup_env
from src.core.config_manager import ConfigManager

logger = logging.getLogger(__name__)

router = APIRouter()


class LoginRequest(BaseModel):
    """Login request body. 多用户模式需 username；首次设置密码用 password + passwordConfirm."""

    model_config = {"populate_by_name": True}

    username: str = Field(default="", description="Username (multi-user mode)")
    password: str = Field(default="", description="Password")
    password_confirm: str | None = Field(default=None, alias="passwordConfirm", description="Confirm (first-time)")


class RegisterRequest(BaseModel):
    """Open registration request (multi-user mode)."""

    username: str = Field(default="", description="Username")
    password: str = Field(default="", description="Password")
    password_confirm: str | None = Field(default=None, alias="passwordConfirm", description="Confirm")


class ChangePasswordRequest(BaseModel):
    """Change password request body."""

    model_config = {"populate_by_name": True}

    current_password: str = Field(default="", alias="currentPassword")
    new_password: str = Field(default="", alias="newPassword")
    new_password_confirm: str = Field(default="", alias="newPasswordConfirm")


class AuthSettingsRequest(BaseModel):
    """Update auth enablement and initial password settings."""

    model_config = {"populate_by_name": True}

    auth_enabled: bool = Field(alias="authEnabled")
    password: str = Field(default="")
    password_confirm: str | None = Field(default=None, alias="passwordConfirm")
    current_password: str = Field(default="", alias="currentPassword")


def _cookie_params(request: Request) -> dict:
    """Build cookie params including Secure based on request."""
    secure = False
    if os.getenv("TRUST_X_FORWARDED_FOR", "false").lower() == "true":
        proto = request.headers.get("X-Forwarded-Proto", "").lower()
        secure = proto == "https"
    else:
        # Check URL scheme when not behind proxy
        secure = request.url.scheme == "https"

    try:
        max_age_hours = int(os.getenv("ADMIN_SESSION_MAX_AGE_HOURS", str(SESSION_MAX_AGE_HOURS_DEFAULT)))
    except ValueError:
        max_age_hours = SESSION_MAX_AGE_HOURS_DEFAULT
    max_age = max_age_hours * 3600

    return {
        "httponly": True,
        "samesite": "lax",
        "secure": secure,
        "path": "/",
        "max_age": max_age,
    }


def _apply_auth_enabled(enabled: bool, request: Request | None = None) -> bool:
    """Persist auth toggle to .env and reload runtime config."""
    manager_applied = False
    if request is not None:
        try:
            service = get_system_config_service(request)
            service.apply_simple_updates(
                updates=[("ADMIN_AUTH_ENABLED", "true" if enabled else "false")],
                mask_token="******",
            )
            manager_applied = True
        except Exception as exc:
            logger.warning(
                "Failed to apply auth toggle via shared SystemConfigService, falling back: %s",
                exc,
                exc_info=True,
            )
            manager_applied = False

    if not manager_applied:
        try:
            manager = ConfigManager()
            manager.apply_updates(
                updates=[("ADMIN_AUTH_ENABLED", "true" if enabled else "false")],
                sensitive_keys=set(),
                mask_token="******",
            )
            manager_applied = True
        except Exception as exc:
            logger.error("Failed to apply auth toggle via ConfigManager: %s", exc, exc_info=True)
            manager_applied = False

    if not manager_applied:
        return False

    Config.reset_instance()
    setup_env(override=True)
    refresh_auth_state()
    return True


def _password_set_for_response(auth_enabled: bool) -> bool:
    """Avoid exposing stored-password state when auth is disabled."""
    return is_password_set() if auth_enabled else False


def _set_session_cookie(response: Response, session_value: str, request: Request) -> None:
    """Attach the admin session cookie to a response."""
    params = _cookie_params(request)
    response.set_cookie(
        key=COOKIE_NAME,
        value=session_value,
        httponly=params["httponly"],
        samesite=params["samesite"],
        secure=params["secure"],
        path=params["path"],
        max_age=params["max_age"],
    )


def _get_auth_status_dict(request: Request | None = None) -> dict:
    """Helper to build consistent auth status response body."""
    auth_enabled = is_auth_enabled()
    multi_user = is_multi_user_enabled()
    logged_in = False
    current_user: dict | None = None
    if auth_enabled and request:
        cookie_val = request.cookies.get(COOKIE_NAME)
        if cookie_val:
            if multi_user:
                current_user = resolve_session_user(cookie_val)
            else:
                logged_in = verify_session(cookie_val)
            if current_user:
                logged_in = True

    # setupState determination:
    # - enabled: auth is active
    # - password_retained: auth disabled but password exists
    # - no_password: auth disabled and no password exists
    if auth_enabled:
        setup_state = "enabled"
    elif has_stored_password():
        setup_state = "password_retained"
    else:
        setup_state = "no_password"

    status: dict = {
        "authEnabled": auth_enabled,
        "loggedIn": logged_in,
        "passwordSet": _password_set_for_response(auth_enabled),
        "passwordChangeable": is_password_changeable() if auth_enabled else False,
        "setupState": setup_state,
        # 多用户扩展字段（旧前端可安全忽略）
        "multiUser": multi_user,
        "registrationEnabled": multi_user and is_registration_enabled(),
    }
    if current_user:
        status["username"] = current_user.get("username")
        status["role"] = current_user.get("role")
    return status


@router.get(
    "/status",
    summary="Get auth status",
    description="Returns whether auth is enabled and if the current request is logged in.",
)
async def auth_status(request: Request):
    """Return authEnabled, loggedIn, passwordSet, passwordChangeable, setupState without requiring auth."""
    return _get_auth_status_dict(request)


@router.post(
    "/settings",
    summary="Update auth settings",
    description=(
        "Enable or disable password login. "
        "When enabling without an existing password, password + passwordConfirm are required. "
        "When re-enabling with a stored password, currentPassword is required. "
        "When disabling auth (authEnabled=false) while auth is currently enabled, "
        "currentPassword is required to re-authenticate the admin — a valid session cookie "
        "alone is NOT enough for this high-risk action (CSRF / session-hijacking hardening "
        "for Issue #1970)."
    ),
)
async def auth_update_settings(
    request: Request,
    body: AuthSettingsRequest,
    _: None = Depends(require_admin),
):
    """Manage auth enablement from the settings page."""
    target_enabled = body.auth_enabled
    current_enabled = is_auth_enabled()

    # 多用户模式下禁止关闭认证：认证是多用户权限模型的根基，关闭即匿名可访问全部 API
    if is_multi_user_enabled() and not target_enabled:
        return JSONResponse(
            status_code=403,
            content={
                "error": "auth_locked_by_multi_user",
                "message": "多用户模式下不允许关闭登录认证；请先关闭 MULTI_USER_ENABLED",
            },
        )

    stored_password_exists = has_stored_password()

    password = (body.password or "").strip()
    confirm = (body.password_confirm or "").strip()
    current_password = (body.current_password or "").strip()

    if target_enabled:
        if password or confirm:
            if stored_password_exists:
                return JSONResponse(
                    status_code=400,
                    content={
                        "error": "password_already_set",
                        "message": "已存在管理员密码，请启用认证后通过修改密码功能更新",
                    },
                )
            if not password:
                return JSONResponse(
                    status_code=400,
                    content={"error": "password_required", "message": "请输入要设置的管理员密码"},
                )
            if password != confirm:
                return JSONResponse(
                    status_code=400,
                    content={"error": "password_mismatch", "message": "两次输入的密码不一致"},
                )
            if has_stored_password():
                return JSONResponse(
                    status_code=400,
                    content={
                        "error": "password_already_set",
                        "message": "已存在管理员密码，请启用认证后通过修改密码功能更新",
                    },
                )
            err = set_initial_password(password)
            if err:
                return JSONResponse(
                    status_code=400,
                    content={"error": "invalid_password", "message": err},
                )
        elif not stored_password_exists:
            return JSONResponse(
                status_code=400,
                content={"error": "password_required", "message": "开启密码登录前请先设置密码"},
            )
        else:
            # P1 Vulnerability Fix: Enforce current-password check independent of global cached flag
            # We must verify they actually possess a valid admin session, otherwise an attacker
            # could hit a race condition when auth becomes enabled mid-flight.
            # This triggers whenever trying to enable/keep enabled an existing auth setup.
            cookie_val = request.cookies.get(COOKIE_NAME)
            # if target_enabled is True here, they are requesting to enable or keep auth enabled
            is_valid_session = cookie_val and verify_session(cookie_val)
            
            if not is_valid_session:
                if not current_password:
                    return JSONResponse(
                        status_code=400,
                        content={"error": "current_required", "message": "重新开启认证前请输入当前密码"},
                    )
                ip = get_client_ip(request)
                if not check_rate_limit(ip):
                    return JSONResponse(
                        status_code=429,
                        content={
                            "error": "rate_limited",
                            "message": "Too many failed attempts. Please try again later.",
                        },
                    )
                if not verify_stored_password(current_password):
                    record_login_failure(ip)
                    return JSONResponse(
                        status_code=401,
                        content={"error": "invalid_password", "message": "当前密码错误"},
                    )
                clear_rate_limit(ip)
    else:
        # target_enabled is False here: caller wants to disable auth.
        # High-risk action: require current admin password re-authentication even when
        # the request carries a cryptographically valid session cookie. A leaked session
        # cookie must never be enough to flip the system into an unauthenticated state
        # (CSRF / session-hijacking hardening for Issue #1970).
        if current_enabled:
            if not current_password:
                return JSONResponse(
                    status_code=400,
                    content={"error": "current_required", "message": "关闭认证前请输入当前密码"},
                )
            ip = get_client_ip(request)
            if not check_rate_limit(ip):
                return JSONResponse(
                    status_code=429,
                    content={
                        "error": "rate_limited",
                        "message": "Too many failed attempts. Please try again later.",
                    },
                )
            if not verify_stored_password(current_password):
                record_login_failure(ip)
                return JSONResponse(
                    status_code=401,
                    content={"error": "invalid_password", "message": "当前密码错误"},
                )
            clear_rate_limit(ip)

    if target_enabled != current_enabled:
        if not _apply_auth_enabled(target_enabled, request=request):
            return JSONResponse(
                status_code=500,
                content={"error": "internal_error", "message": "Failed to update auth settings"},
            )
        if not rotate_session_secret():
            rollback_ok = _apply_auth_enabled(current_enabled, request=request)
            if not rollback_ok:
                logger.error("Failed to roll back auth state after session secret rotation failure")
            return JSONResponse(
                status_code=500,
                content={"error": "internal_error", "message": "Failed to rotate session secret"},
            )
    else:
        if not _apply_auth_enabled(target_enabled, request=request):
            return JSONResponse(
                status_code=500,
                content={"error": "internal_error", "message": "Failed to update auth settings"},
            )

    if target_enabled:
        session_val = create_session()
        if not session_val:
            rollback_ok = _apply_auth_enabled(current_enabled, request=request)
            if not rollback_ok:
                logger.error("Failed to roll back auth state after session creation failure")
            return JSONResponse(
                status_code=500,
                content={"error": "internal_error", "message": "Failed to create session"},
            )
        # We manually set loggedIn=True because the cookie is being set in this response
        # and won't be visible in request.cookies until the NEXT request.
        content = _get_auth_status_dict(request)
        content["loggedIn"] = True
        resp = JSONResponse(content=content)
        _set_session_cookie(resp, session_val, request)
        return resp

    resp = JSONResponse(content=_get_auth_status_dict(request))
    resp.delete_cookie(key=COOKIE_NAME, path="/")
    return resp



@router.post(
    "/register",
    summary="Open registration (multi-user mode)",
    description="Create a user account. Requires MULTI_USER_ENABLED and AUTH_REGISTRATION_ENABLED.",
)
async def auth_register(request: Request, body: RegisterRequest):
    """开放注册。仅在多用户模式且注册开关开启时可用；成功后自动登录。"""
    if not is_multi_user_enabled():
        return JSONResponse(
            status_code=403,
            content={"error": "multi_user_disabled", "message": "多用户模式未开启"},
        )
    if not is_registration_enabled():
        return JSONResponse(
            status_code=403,
            content={"error": "registration_disabled", "message": "注册未开放"},
        )

    ip = get_client_ip(request)
    if not check_registration_rate_limit(ip):
        return JSONResponse(
            status_code=429,
            content={"error": "rate_limited", "message": "Too many attempts. Please try again later."},
        )
    # 按“尝试次数”计数（而非仅失败）：防注册刷号与已存在用户名探测
    record_registration_failure(ip)

    username = (body.username or "").strip()
    password = (body.password or "").strip()
    confirm = (body.password_confirm or "").strip()
    if password and confirm and password != confirm:
        return JSONResponse(
            status_code=400,
            content={"error": "password_mismatch", "message": "两次输入的密码不一致"},
        )

    error_code, user = create_user_account(username, password)
    if error_code == "username_taken":
        return JSONResponse(
            status_code=409,
            content={"error": "username_taken", "message": "用户名已被使用"},
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
    if error_code == "max_users":
        return JSONResponse(
            status_code=403,
            content={"error": "quota_exceeded", "message": "注册用户数已达上限"},
        )
    if error_code or user is None:
        return JSONResponse(
            status_code=500,
            content={"error": "internal_error", "message": "Failed to create account"},
        )

    session_val = create_session(user["id"], user["token_version"])
    if not session_val:
        return JSONResponse(
            status_code=500,
            content={"error": "internal_error", "message": "Failed to create session"},
        )
    resp = JSONResponse(
        content={
            "ok": True,
            "username": user["username"],
            "role": user["role"],
        }
    )
    _set_session_cookie(resp, session_val, request)
    return resp


@router.post(
    "/login",
    summary="Login or set initial password",
    description="多用户模式：username + password。单管理员模式：仅 password（首次可 password+passwordConfirm）。",
)
async def auth_login(request: Request, body: LoginRequest):
    """Verify credentials and set cookie on success. Returns 400/401/403/429 on failure."""
    if not is_auth_enabled():
        return JSONResponse(
            status_code=400,
            content={"error": "auth_disabled", "message": "Authentication is not configured"},
        )

    password = (body.password or "").strip()
    if not password:
        return JSONResponse(
            status_code=400,
            content={"error": "password_required", "message": "请输入密码"},
        )

    if is_multi_user_enabled():
        return _login_multi_user(request, body, password)

    # ---- 单管理员模式：保持历史行为 ----
    ip = get_client_ip(request)
    if not check_rate_limit(ip):
        return JSONResponse(
            status_code=429,
            content={
                "error": "rate_limited",
                "message": "Too many failed attempts. Please try again later.",
            },
        )

    password_set = is_password_set()

    if not password_set:
        # First-time setup: require passwordConfirm
        confirm = (body.password_confirm or "").strip()
        if password != confirm:
            record_login_failure(ip)
            return JSONResponse(
                status_code=400,
                content={"error": "password_mismatch", "message": "Passwords do not match"},
            )
        err = set_initial_password(password)
        if err:
            record_login_failure(ip)
            return JSONResponse(
                status_code=400,
                content={"error": "invalid_password", "message": err},
            )
    else:
        if not verify_password(password):
            record_login_failure(ip)
            return JSONResponse(
                status_code=401,
                content={"error": "invalid_password", "message": "密码错误"},
            )

    clear_rate_limit(ip)
    session_val = create_session()
    if not session_val:
        return JSONResponse(
            status_code=500,
            content={"error": "internal_error", "message": "Failed to create session"},
        )

    resp = JSONResponse(content={"ok": True})
    _set_session_cookie(resp, session_val, request)
    return resp


def _login_multi_user(request: Request, body: LoginRequest, password: str):
    """多用户模式登录：username + password，按 (username, ip) 限流，统一错误文案防枚举。"""
    username = (body.username or "").strip()
    if not username:
        return JSONResponse(
            status_code=400,
            content={"error": "username_required", "message": "请输入用户名"},
        )

    ip = get_client_ip(request)
    bucket = login_failure_key(ip, username)
    if not check_rate_limit(bucket):
        return JSONResponse(
            status_code=429,
            content={
                "error": "rate_limited",
                "message": "Too many failed attempts. Please try again later.",
            },
        )

    user = verify_user_credentials(username, password)
    if user is None:
        record_login_failure(bucket)
        return JSONResponse(
            status_code=401,
            content={"error": "invalid_credentials", "message": "用户名或密码错误"},
        )

    clear_rate_limit(bucket)
    session_val = create_session(user["id"], user["token_version"])
    if not session_val:
        return JSONResponse(
            status_code=500,
            content={"error": "internal_error", "message": "Failed to create session"},
        )
    resp = JSONResponse(
        content={
            "ok": True,
            "username": user["username"],
            "role": user["role"],
        }
    )
    _set_session_cookie(resp, session_val, request)
    return resp


@router.post(
    "/change-password",
    summary="Change password",
    description="Change password. Requires valid session. 多用户模式按当前登录用户改密，其他会话立即失效。",
)
async def auth_change_password(request: Request, body: ChangePasswordRequest):
    """Change password. Requires login."""
    if not is_password_changeable():
        return JSONResponse(
            status_code=400,
            content={"error": "not_changeable", "message": "Password cannot be changed via web"},
        )

    current = (body.current_password or "").strip()
    new_pwd = (body.new_password or "").strip()
    new_confirm = (body.new_password_confirm or "").strip()

    if not current:
        return JSONResponse(
            status_code=400,
            content={"error": "current_required", "message": "请输入当前密码"},
        )
    if new_pwd != new_confirm:
        return JSONResponse(
            status_code=400,
            content={"error": "password_mismatch", "message": "两次输入的新密码不一致"},
        )

    current_user = get_current_user_from_request(request)
    if is_multi_user_enabled() and current_user is not None:
        err = change_user_password(int(current_user["id"]), current, new_pwd)
        if err:
            return JSONResponse(
                status_code=400,
                content={"error": "invalid_password", "message": err},
            )
        # 重新签发当前会话（携带新 token_version）；该用户其余旧会话已失效
        updated = get_user_account(int(current_user["id"]))
        session_val = (
            create_session(int(updated["id"]), int(updated["token_version"])) if updated else ""
        )
        resp = JSONResponse(content={"ok": True})
        if session_val:
            _set_session_cookie(resp, session_val, request)
        return resp

    err = change_password(current, new_pwd)
    if err:
        return JSONResponse(
            status_code=400,
            content={"error": "invalid_password", "message": err},
        )
    return Response(status_code=204)


@router.post(
    "/logout",
    summary="Logout",
    description="Clear session cookie. 单管理员模式同时轮换 secret；多用户模式仅清除本机 cookie。",
)
async def auth_logout(request: Request):
    """Clear session cookie."""
    if is_multi_user_enabled():
        # 多用户模式下 logout 只影响本机会话；轮换全局 secret 会把其他人全部登出
        resp = Response(status_code=204)
        resp.delete_cookie(key=COOKIE_NAME, path="/")
        return resp

    if is_auth_enabled() and not rotate_session_secret():
        return JSONResponse(
            status_code=500,
            content={"error": "internal_error", "message": "Failed to invalidate session"},
        )
    resp = Response(status_code=204)
    resp.delete_cookie(key=COOKIE_NAME, path="/")
    return resp

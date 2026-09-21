# -*- coding: utf-8 -*-
"""第三方登录（OAuth Authorization Code）端点。

设计要点（v1）：
- 仅多用户模式（MULTI_USER_ENABLED && ADMIN_AUTH_ENABLED）下可用；
- state 使用会话密钥 HMAC 签名 + 服务端一次性 nonce 表（单进程内存，重启即失效）；
- client_secret / access_token / code 绝不写入日志或响应体；
- 身份以 (provider, provider_user_id) 为唯一键；OAuth 自动注册受
  AUTH_REGISTRATION_ENABLED 约束，与用户名注册同一开关；
- v1 不做跨 provider 账号合并：同一邮箱在不同 provider 下各自建号，
  避免凭「邮箱声明」接管既有账号的预注册劫持（账号关联页为后续工作）；
- OAuth 建号的用户密码哈希为随机值（任何密码都无法命中），只能通过 OAuth 登录，
  密码找回/设置依赖邮箱验证链路。
"""

from __future__ import annotations

import logging
import secrets
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional
from urllib.parse import quote

import requests as http_client
from fastapi import APIRouter, Request
from fastapi.responses import RedirectResponse

from src.auth import (
    COOKIE_NAME,
    _get_session_secret,
    _sign_payload,
    build_session_cookie_params,
    create_oauth_user_account,
    create_session,
    get_webui_base_url,
    is_multi_user_enabled,
    is_registration_enabled,
    list_configured_oauth_providers,
)
from src.storage import DatabaseManager, IDENTITY_PROVIDER_FACEBOOK, IDENTITY_PROVIDER_GOOGLE

logger = logging.getLogger(__name__)

router = APIRouter()

OAUTH_STATE_TTL_SEC = 600
OAUTH_HTTP_TIMEOUT_SEC = 30
OAUTH_ERROR_PARAM = "oauthError"

# 服务端一次性 state nonce 表：nonce -> 签发时间（单进程内存；重启/多 worker 部署
# 会自然失效为「state 校验失败」，属 fail-closed，不产生安全风险）
_pending_oauth_states: Dict[str, float] = {}


@dataclass(frozen=True)
class OAuthProviderSpec:
    """单个 OAuth provider 的协议端点与参数差异。"""

    name: str
    authorize_url: str
    token_url: str
    userinfo_url: str
    scope: str
    # Facebook 无公开的 email_verified claim，按 fail-closed 视为未验证
    email_verified_by_default: bool


PROVIDER_SPECS = {
    IDENTITY_PROVIDER_GOOGLE: OAuthProviderSpec(
        name=IDENTITY_PROVIDER_GOOGLE,
        authorize_url="https://accounts.google.com/o/oauth2/v2/auth",
        token_url="https://oauth2.googleapis.com/token",
        userinfo_url="https://openidconnect.googleapis.com/v1/userinfo",
        scope="openid email profile",
        email_verified_by_default=False,
    ),
    IDENTITY_PROVIDER_FACEBOOK: OAuthProviderSpec(
        name=IDENTITY_PROVIDER_FACEBOOK,
        authorize_url="https://www.facebook.com/v19.0/dialog/oauth",
        token_url="https://www.facebook.com/v19.0/oauth/access_token",
        userinfo_url="https://graph.facebook.com/me",
        scope="email,public_profile",
        email_verified_by_default=False,
    ),
}


def _redirect_uri(provider: str) -> str:
    return f"{get_webui_base_url()}/api/v1/auth/oauth/{provider}/callback"


def _prune_expired_states(now: float) -> None:
    expired = [nonce for nonce, issued_at in _pending_oauth_states.items() if now - issued_at > OAUTH_STATE_TTL_SEC]
    for nonce in expired:
        _pending_oauth_states.pop(nonce, None)


def create_oauth_state(provider: str) -> Optional[str]:
    """签发一次性 OAuth state：``provider.nonce.ts.signature``。"""
    secret = _get_session_secret()
    if not secret:
        return None
    now = time.time()
    _prune_expired_states(now)
    nonce = secrets.token_urlsafe(24)
    ts = str(int(now))
    _pending_oauth_states[nonce] = now
    sig = _sign_payload(secret, f"oauth.{provider}.{nonce}.{ts}")
    return f"{provider}.{nonce}.{ts}.{sig}"


def consume_oauth_state(provider: str, state: str) -> bool:
    """校验并消费 state（一次性、绑定 provider、10 分钟内有效）。"""
    secret = _get_session_secret()
    if not secret or not state or state.count(".") != 3:
        return False
    state_provider, nonce, ts_str, sig = state.split(".")
    if state_provider != provider:
        return False
    if not secrets.compare_digest(_sign_payload(secret, f"oauth.{provider}.{nonce}.{ts_str}"), sig):
        return False
    try:
        ts = int(ts_str)
    except ValueError:
        return False
    now = time.time()
    if now - ts > OAUTH_STATE_TTL_SEC:
        _pending_oauth_states.pop(nonce, None)
        return False
    # pop 即消费：同一 state 第二次提交必然失败
    issued_at = _pending_oauth_states.pop(nonce, None)
    if issued_at is None:
        return False
    return True


def _oauth_error_redirect(error_code: str) -> RedirectResponse:
    return RedirectResponse(f"/login?{OAUTH_ERROR_PARAM}={error_code}", status_code=302)


def _provider_config(provider: str) -> tuple:
    """返回 (client_id, client_secret)；未读取到配置时返回 (None, None) 走 fail-closed。"""
    try:
        from src.config import get_config

        config = get_config()
    except Exception as exc:  # pragma: no cover - config 初始化失败属极端路径
        logger.error("[oauth] 读取配置失败 provider=%s: %s", provider, exc)
        return (None, None)
    if provider == IDENTITY_PROVIDER_GOOGLE:
        return (config.google_oauth_client_id, config.google_oauth_client_secret)
    if provider == IDENTITY_PROVIDER_FACEBOOK:
        return (config.facebook_oauth_app_id, config.facebook_oauth_app_secret)
    return (None, None)


def oauth_authorize(provider: str) -> RedirectResponse:
    """生成授权跳转地址。未配置 / 多用户关闭 / 会话密钥缺失一律 fail-closed。"""
    spec = PROVIDER_SPECS.get(provider)
    if spec is None or not is_multi_user_enabled():
        return _oauth_error_redirect("oauth_disabled")
    if provider not in list_configured_oauth_providers():
        return _oauth_error_redirect("not_configured")
    state = create_oauth_state(provider)
    if not state:
        return _oauth_error_redirect("state_unavailable")
    client_id, _client_secret = _provider_config(provider)

    params: Dict[str, str] = {
        "client_id": client_id or "",
        "redirect_uri": _redirect_uri(provider),
        "response_type": "code",
        "scope": spec.scope,
        "state": state,
    }
    if provider == IDENTITY_PROVIDER_GOOGLE:
        params["access_type"] = "offline"
    query = "&".join(f"{key}={quote(str(value), safe='')}" for key, value in params.items())
    return RedirectResponse(f"{spec.authorize_url}?{query}", status_code=302)


def _exchange_code_for_token(spec: OAuthProviderSpec, code: str, provider: str) -> Optional[str]:
    client_id, client_secret = _provider_config(provider)
    if not client_id or not client_secret:
        return None
    try:
        response = http_client.post(
            spec.token_url,
            data={
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": _redirect_uri(provider),
                "grant_type": "authorization_code",
            },
            timeout=OAUTH_HTTP_TIMEOUT_SEC,
        )
    except Exception as exc:
        logger.warning("[oauth] token 交换请求失败 provider=%s err=%s", provider, type(exc).__name__)
        return None
    if response.status_code != 200:
        # 只记录状态码，不记录响应体（可能含敏感参数回显）
        logger.warning("[oauth] token 交换被拒绝 provider=%s status=%s", provider, response.status_code)
        return None
    try:
        payload = response.json()
    except ValueError:
        return None
    token = payload.get("access_token")
    return token if isinstance(token, str) and token else None


def _fetch_userinfo(spec: OAuthProviderSpec, provider: str, access_token: str) -> Optional[Dict[str, Any]]:
    try:
        if provider == IDENTITY_PROVIDER_FACEBOOK:
            response = http_client.get(
                spec.userinfo_url,
                params={"fields": "id,name,email", "access_token": access_token},
                timeout=OAUTH_HTTP_TIMEOUT_SEC,
            )
        else:
            response = http_client.get(
                spec.userinfo_url,
                headers={"Authorization": f"Bearer {access_token}"},
                timeout=OAUTH_HTTP_TIMEOUT_SEC,
            )
    except Exception as exc:
        logger.warning("[oauth] userinfo 请求失败 provider=%s err=%s", provider, type(exc).__name__)
        return None
    if response.status_code != 200:
        logger.warning("[oauth] userinfo 被拒绝 provider=%s status=%s", provider, response.status_code)
        return None
    try:
        payload = response.json()
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


def oauth_callback(provider: str, request: Request, code: Optional[str], state: Optional[str]):
    """OAuth 回调：state 一次性校验 -> 换 token -> 拉用户信息 -> find-or-create -> 签发会话。"""
    spec = PROVIDER_SPECS.get(provider)
    if spec is None or not is_multi_user_enabled():
        return _oauth_error_redirect("oauth_disabled")
    if provider not in list_configured_oauth_providers():
        return _oauth_error_redirect("not_configured")
    if not consume_oauth_state(provider, state or ""):
        return _oauth_error_redirect("state_invalid")
    if not code:
        return _oauth_error_redirect("code_missing")

    access_token = _exchange_code_for_token(spec, code, provider)
    if not access_token:
        return _oauth_error_redirect("token_exchange_failed")
    userinfo = _fetch_userinfo(spec, provider, access_token)
    provider_user_id = str(userinfo.get("sub") or userinfo.get("id") or "") if userinfo else ""
    if not provider_user_id:
        return _oauth_error_redirect("provider_error")
    email = str(userinfo.get("email") or "").strip() or None
    if not email:
        return _oauth_error_redirect("email_missing")
    email_verified = bool(userinfo.get("email_verified", spec.email_verified_by_default))

    manager = DatabaseManager.get_instance()
    identity = manager.get_user_identity(provider, provider_user_id)
    if identity is not None:
        user = manager.get_user_by_id(int(identity.user_id))
        if user is None or not user.is_active:
            return _oauth_error_redirect("user_inactive")
        user_dict = user.to_auth_dict()
    else:
        if not is_registration_enabled():
            return _oauth_error_redirect("registration_disabled")
        error_code, user_dict = create_oauth_user_account(
            provider, provider_user_id, email, email_verified
        )
        if error_code == "registration_disabled":
            return _oauth_error_redirect("registration_disabled")
        if error_code == "max_users":
            return _oauth_error_redirect("quota_exceeded")
        if error_code or user_dict is None:
            return _oauth_error_redirect("storage_error")

    session_value = create_session(int(user_dict["id"]), int(user_dict.get("token_version", 0)))
    if not session_value:
        return _oauth_error_redirect("session_failed")
    target = "/oauth/callback?status=ok"
    response = RedirectResponse(target, status_code=302)
    params = build_session_cookie_params(request)
    response.set_cookie(
        key=COOKIE_NAME,
        value=session_value,
        httponly=params["httponly"],
        samesite=params["samesite"],
        secure=params["secure"],
        path=params["path"],
        max_age=params["max_age"],
    )
    logger.info("[oauth] 登录成功 provider=%s user=%s", provider, user_dict.get("username"))
    return response


@router.get(
    "/google/authorize",
    summary="Start Google OAuth",
    description="Redirects to Google's consent screen; state is single-use and HMAC-signed.",
)
async def google_authorize():
    return oauth_authorize(IDENTITY_PROVIDER_GOOGLE)


@router.get(
    "/google/callback",
    summary="Google OAuth callback",
    description="Exchanges code for token, finds or creates the user, then issues the session cookie.",
)
async def google_callback(request: Request, code: str = "", state: str = ""):
    return oauth_callback(IDENTITY_PROVIDER_GOOGLE, request, code or None, state or None)


@router.get(
    "/facebook/authorize",
    summary="Start Facebook OAuth",
    description="Redirects to Facebook's dialog; state is single-use and HMAC-signed.",
)
async def facebook_authorize():
    return oauth_authorize(IDENTITY_PROVIDER_FACEBOOK)


@router.get(
    "/facebook/callback",
    summary="Facebook OAuth callback",
    description="Exchanges code for token, finds or creates the user, then issues the session cookie.",
)
async def facebook_callback(request: Request, code: str = "", state: str = ""):
    return oauth_callback(IDENTITY_PROVIDER_FACEBOOK, request, code or None, state or None)

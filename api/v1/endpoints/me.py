# -*- coding: utf-8 -*-
"""用户个人设置端点（多用户模式）：排程、通知渠道、配额视图。"""

from __future__ import annotations

import ipaddress
import logging
import socket
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from api.deps import get_current_user
from src.auth import is_multi_user_enabled
from src.services.user_quota import get_user_usage
from src.storage import DatabaseManager

logger = logging.getLogger(__name__)

router = APIRouter()

SCHEDULE_MAX_TIMES = 5
# 用户可自助配置的通知渠道（webhook/token 型；不含需要服务端全局治理的渠道）
USER_CHANNEL_KEYS = frozenset({
    "telegram_bot_token", "telegram_chat_id",
    "email_sender", "email_password", "email_receivers",
    "wechat_webhook_url", "dingtalk_webhook_url", "dingtalk_secret",
    "feishu_webhook_url", "feishu_webhook_secret", "feishu_webhook_keyword",
    "discord_webhook_url", "slack_webhook_url",
    "custom_webhook_urls", "ntfy_url", "gotify_url", "gotify_token",
    "pushover_user_key", "pushover_api_token", "pushplus_token",
    "serverchan3_sendkey",
})

_CHANNEL_TEST_RATE: Dict[int, List[float]] = {}
_CHANNEL_TEST_MAX_PER_MINUTE = 5


class ScheduleSettings(BaseModel):
    """每用户排程设置。"""

    enabled: bool = False
    times: List[str] = Field(default_factory=list)


class MeSettingsRequest(BaseModel):
    """个人设置更新请求。"""

    model_config = {"populate_by_name": True}

    schedule: Optional[ScheduleSettings] = None
    notification_channels: Optional[Dict[str, Any]] = Field(
        default=None, alias="notificationChannels"
    )


class ChannelTestRequest(BaseModel):
    """通知渠道连通性测试请求（不落盘）。"""

    payload: Dict[str, Any] = Field(default_factory=dict)


def _me_guard() -> Optional[JSONResponse]:
    if not is_multi_user_enabled():
        return JSONResponse(
            status_code=403,
            content={"error": "multi_user_disabled", "message": "多用户模式未开启"},
        )
    return None


def _validate_schedule(schedule: ScheduleSettings) -> Optional[str]:
    """校验排程时间列表（HH:MM，最多 5 个，去重）。"""
    import re

    if not schedule.enabled:
        return None
    pattern = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
    times: List[str] = []
    for raw in schedule.times or []:
        value = str(raw).strip()
        if not value:
            continue
        if not pattern.match(value):
            return f"排程时间格式无效: {value}（需 HH:MM）"
        if value not in times:
            times.append(value)
    if not times:
        return "启用排程时至少需要一个时间"
    if len(times) > SCHEDULE_MAX_TIMES:
        return f"每天最多 {SCHEDULE_MAX_TIMES} 个排程时间"
    schedule.times = times
    return None


def _sanitize_channels(channels: Dict[str, Any]) -> Dict[str, Any]:
    """只保留白名单键；值为字符串并去首尾空白；空值删除。"""
    cleaned: Dict[str, Any] = {}
    for key, value in (channels or {}).items():
        if key not in USER_CHANNEL_KEYS:
            continue
        if value is None:
            continue
        text = str(value).strip()
        if text:
            cleaned[key] = text
    return cleaned


def _url_is_public_https(url: str) -> bool:
    """SSRF 防护：仅 https；拒绝私网/loopback/link-local/元数据地址。"""
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme != "https" or not parsed.hostname:
        return False
    try:
        infos = socket.getaddrinfo(parsed.hostname, parsed.port or 443, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, OSError):
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            return False
        # 云元数据端点（如 169.254.169.254 已被 link_local 覆盖；再兜底常见网段）
        if str(ip).startswith("100.100.100."):
            return False
    return True


def _channel_test_rate_ok(user_id: int) -> bool:
    import time

    now = time.time()
    window = [ts for ts in _CHANNEL_TEST_RATE.get(user_id, []) if now - ts < 60]
    if len(window) >= _CHANNEL_TEST_MAX_PER_MINUTE:
        _CHANNEL_TEST_RATE[user_id] = window
        return False
    window.append(now)
    _CHANNEL_TEST_RATE[user_id] = window
    return True


@router.get(
    "",
    summary="Get my settings and quota usage",
    description="Per-user schedule, notification channels (secrets masked) and daily quota usage.",
)
async def get_my_settings(current_user: Optional[dict] = Depends(get_current_user)):
    guard = _me_guard()
    if guard:
        return guard
    if not current_user:
        return JSONResponse(
            status_code=401, content={"error": "unauthorized", "message": "Login required"}
        )
    db = DatabaseManager.get_instance()
    user_id = int(current_user["id"])
    channels = db.get_user_setting(user_id, "notification_channels") or {}
    masked = {key: ("******" if value else "") for key, value in channels.items()}
    return {
        "schedule": db.get_user_setting(user_id, "schedule") or {"enabled": False, "times": []},
        "notificationChannels": masked,
        "quota": get_user_usage(user_id),
    }


@router.put(
    "",
    summary="Update my settings",
    description="Update per-user schedule and notification channels. Channel secrets masked as ****** are preserved.",
)
async def update_my_settings(
    body: MeSettingsRequest,
    current_user: Optional[dict] = Depends(get_current_user),
):
    guard = _me_guard()
    if guard:
        return guard
    if not current_user:
        return JSONResponse(
            status_code=401, content={"error": "unauthorized", "message": "Login required"}
        )
    db = DatabaseManager.get_instance()
    user_id = int(current_user["id"])

    if body.schedule is not None:
        err = _validate_schedule(body.schedule)
        if err:
            return JSONResponse(
                status_code=400,
                content={"error": "validation_failed", "message": err},
            )
        db.set_user_setting(
            user_id,
            "schedule",
            {"enabled": bool(body.schedule.enabled), "times": list(body.schedule.times)},
        )

    if body.notification_channels is not None:
        incoming = _sanitize_channels(body.notification_channels)
        # 掩码占位保持已存值，防止前端回显时覆盖真实 secret
        existing = db.get_user_setting(user_id, "notification_channels") or {}
        for key, value in incoming.items():
            if value == "******" and key in existing:
                incoming[key] = existing[key]
        db.set_user_setting(user_id, "notification_channels", incoming)

    return await get_my_settings(current_user)


@router.post(
    "/notification-channels/test",
    summary="Test my webhook channel",
    description=(
        "Send a tiny probe to a user-supplied webhook URL. "
        "SSRF-guarded: https-only, private/link-local/metadata IPs rejected, "
        "no redirects, no response body echo, 5s timeout, per-user rate limit."
    ),
)
async def test_my_channel(
    body: ChannelTestRequest,
    current_user: Optional[dict] = Depends(get_current_user),
):
    guard = _me_guard()
    if guard:
        return guard
    if not current_user:
        return JSONResponse(
            status_code=401, content={"error": "unauthorized", "message": "Login required"}
        )
    user_id = int(current_user["id"])
    if not _channel_test_rate_ok(user_id):
        return JSONResponse(
            status_code=429,
            content={"error": "rate_limited", "message": "测试请求过于频繁，请稍后再试"},
        )

    url = str((body.payload or {}).get("url") or "").strip()
    if not url:
        return JSONResponse(
            status_code=400,
            content={"error": "validation_failed", "message": "缺少 url"},
        )
    if not _url_is_public_https(url):
        return JSONResponse(
            status_code=400,
            content={"error": "validation_failed", "message": "仅允许公网 https 地址"},
        )

    try:
        response = httpx.post(
            url,
            json={"content": "DSA 通知渠道测试"},
            timeout=5.0,
            follow_redirects=False,
        )
        # 不回显响应体，仅返回状态码，避免把内网服务响应泄露给调用者
        ok = 200 <= response.status_code < 300
        return {"success": ok, "status_code": response.status_code}
    except (httpx.HTTPError, OSError) as exc:
        return {"success": False, "error": "request_failed"}
    except Exception:
        logger.warning("[me] 渠道测试异常: user=%s", user_id, exc_info=True)
        return {"success": False, "error": "request_failed"}

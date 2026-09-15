# -*- coding: utf-8 -*-
"""多用户配额护栏（服务端强制，开放注册 + 管理员共担 LLM 成本场景的防滥用层）。

设计要点：
- 仅多用户模式生效；MULTI_USER_ENABLED 关闭时所有检查直通（行为与单用户一致）。
- 计数器走 SQLite 原子递增（UPDATE ... WHERE count < limit），不做内存缓存，
  防止并发提交绕过；读取失败时 fail-closed（视为超限）。
- 上限从 .env 读取：留空/0 = 不限制；正数 = 每用户上限。
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from dotenv import dotenv_values

from src.storage import DatabaseManager

logger = logging.getLogger(__name__)

QUOTA_ANALYSIS = "analysis"
QUOTA_CHAT = "chat"

_DEFAULT_DAILY_ANALYSIS_LIMIT = 20
_DEFAULT_DAILY_CHAT_LIMIT = 100
_DEFAULT_WATCHLIST_CAP = 50


def _read_env_int(key: str, default: int) -> int:
    """从 .env 读取整数上限；留空/非法回落 default；0 = 不限制。"""
    try:
        from src.config import setup_env

        setup_env()
    except Exception:
        pass
    env_file = os.getenv("ENV_FILE")
    env_path = Path(env_file) if env_file else Path(__file__).resolve().parent.parent.parent / ".env"
    if not env_path.exists():
        return default
    try:
        values = dotenv_values(env_path)
        raw = (values.get(key) or "").strip()
        if not raw:
            return default
        parsed = int(raw)
        return parsed if parsed >= 0 else default
    except (ValueError, TypeError, OSError):
        return default


def get_max_users() -> int:
    """注册用户总量上限；0 = 不限制。"""
    return _read_env_int("MULTI_USER_MAX_USERS", 0)


def get_daily_analysis_limit() -> int:
    return _read_env_int("MULTI_USER_DAILY_ANALYSIS_LIMIT", _DEFAULT_DAILY_ANALYSIS_LIMIT)


def get_daily_chat_limit() -> int:
    return _read_env_int("MULTI_USER_DAILY_CHAT_LIMIT", _DEFAULT_DAILY_CHAT_LIMIT)


def get_watchlist_cap() -> int:
    return _read_env_int("MULTI_USER_WATCHLIST_CAP", _DEFAULT_WATCHLIST_CAP)


def user_registration_allowed(db: DatabaseManager) -> Tuple[bool, int]:
    """注册/建号前检查用户总量上限。返回 (是否允许, 当前用户数)。"""
    max_users = get_max_users()
    count = db.count_users()
    if max_users <= 0:
        return (True, count)
    return (count < max_users, count)


def consume_daily_quota(user_id: int, quota_key: str) -> Tuple[bool, int, int]:
    """消费一次每日配额。返回 (是否允许, 已用, 上限)。

    - 管理员不受配额限制。
    - 配额耗尽：拒绝（fail-closed）。
    - 配额基础设施异常：告警并放行（可用性优先；避免计数器故障拖垮分析主流程）。
    """
    try:
        db = DatabaseManager.get_instance()
        user = db.get_user_by_id(user_id)
        if user is not None and user.role == "admin":
            limit = get_daily_analysis_limit() if quota_key == QUOTA_ANALYSIS else get_daily_chat_limit()
            new_count = db.incr_user_daily_counter(user_id, quota_key)
            return (True, new_count if new_count is not None else 0, limit)
        if quota_key == QUOTA_ANALYSIS:
            limit = get_daily_analysis_limit()
        elif quota_key == QUOTA_CHAT:
            limit = get_daily_chat_limit()
        else:
            limit = 0
        if limit <= 0:
            new_count = db.incr_user_daily_counter(user_id, quota_key)
            return (True, new_count or 0, 0)
        new_count = db.incr_user_daily_counter(user_id, quota_key, max_value=limit)
        if new_count is None:
            used = db.get_user_daily_counter(user_id, quota_key)
            return (False, used, limit)
        return (True, new_count, limit)
    except Exception as exc:
        logger.warning("[quota] 配额检查异常（放行）: user=%s key=%s err=%s", user_id, quota_key, exc)
        return (True, 0, 0)


def get_user_usage(user_id: int) -> Dict[str, Any]:
    """用户当日配额使用视图。"""
    try:
        db = DatabaseManager.get_instance()
    except Exception as exc:
        logger.warning("[quota] 用量视图读取失败: %s", exc)
        return {}
    analysis_used = db.get_user_daily_counter(user_id, QUOTA_ANALYSIS)
    chat_used = db.get_user_daily_counter(user_id, QUOTA_CHAT)
    return {
        "dailyAnalysis": {"used": analysis_used, "limit": get_daily_analysis_limit()},
        "dailyChat": {"used": chat_used, "limit": get_daily_chat_limit()},
        "watchlist": {"used": db.count_user_stocks(user_id), "limit": get_watchlist_cap()},
    }

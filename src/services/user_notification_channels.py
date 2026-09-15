# -*- coding: utf-8 -*-
"""多用户模式下的按用户通知渠道解析。

职责：
1. 读取用户个人设置中的 ``notification_channels``（存储层键已由
   ``api/v1/endpoints/me.py`` 白名单约束）并构建成 ``NotificationService`` /
   各 sender 可直接读取的 config-like 对象（snake_case 属性）。
2. 提供 ``resolve_owner_channel_config``，按运行归属决定静态渠道推送使用的配置：
   - 未归属（owner 为空）或多用户关闭 -> 使用全局 .env 渠道（返回 None，保持旧行为）
   - 管理员 -> 个人渠道 + 全局渠道（管理员拥有全局渠道）
   - 普通用户 -> 仅个人渠道；未配置渠道则不做静态推送（报告仍会保存）
   - 用户无法解析 / 已停用 / 存储异常 -> 不做静态推送（fail-closed，绝不回退全局渠道）

硬性规则：普通用户的渠道凭据 / Webhook URL 绝不从全局 Config 回退，避免把
管理员的渠道凭据泄露进用户运行的通知载荷。
"""
from __future__ import annotations

import logging
import re
import threading
import time
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)

# 与 api/v1/endpoints/me.py 的 USER_CHANNEL_KEYS 保持一致（单一语义，两处只读消费）
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

CHANNEL_SETTINGS_KEY = "notification_channels"
CONFIG_CACHE_TTL_SECONDS = 60.0

# 用户存储的列表型键（发送端期望 list，而不是逗号分隔字符串）
_LIST_VALUED_KEYS = frozenset({"email_receivers", "custom_webhook_urls"})

_SPLIT_PATTERN = re.compile(r"[,;\s]+")
_MISSING = object()

# ============================================================================
# 属性回退审计表（非凭据属性）
#
# ``UserChannelConfig`` 对"白名单键之外"的属性一律抛 AttributeError，使读取方的
# ``getattr(config, name, default)`` 落到发送端自带的默认值；因此绝大多数行为型
# 属性无需在本模块回退全局配置。逐项审计结论（读自 src/notification_sender/*）：
#
# | 属性                        | 读取方                  | 处理方式                        | 原因 |
# |-----------------------------|-------------------------|--------------------------------|------|
# | wechat_webhook_url          | WechatSender（直接访问） | 用户值 / None                   | 白名单键，直接访问不可抛错 |
# | dingtalk_webhook_url/secret | DingtalkSender（直接）   | 用户值 / None                   | 同上 |
# | email_sender/password       | EmailSender（直接）      | 用户值 / None                   | 同上 |
# | email_receivers             | EmailSender（直接）      | 用户值归一化为 list / None      | 同上；字符串需转 list |
# | wechat_max_bytes / msg_type | WechatSender             | AttributeError -> 发送端默认 4000/markdown | 非凭据，缺省不崩溃 |
# | webhook_verify_ssl          | 各 webhook sender        | AttributeError -> 默认 True     | 同上 |
# | telegram_message_thread_id  | TelegramSender           | AttributeError -> 默认 None     | 同上 |
# | feishu_max_bytes / send_as_file / app_* | FeishuSender | AttributeError -> 发送端默认    | feishu_app_* 不在用户白名单（服务端治理渠道） |
# | ntfy_token / pushplus_topic / pushplus_max_bytes | 对应 sender | AttributeError -> 默认 | 非白名单，缺省安全 |
# | custom_webhook_bearer_token / body_template | CustomWebhookSender | AttributeError -> 默认 | 非白名单 |
# | discord_bot_token / main_channel_id / max_words | DiscordSender | AttributeError -> 默认 | Discord bot 形态不在用户白名单 |
# | slack_bot_token / channel_id| SlackSender              | AttributeError -> 默认          | Slack bot 形态不在用户白名单 |
# | astrbot_url / astrbot_token | AstrbotSender            | AttributeError -> 默认          | ASTRBOT 为服务端治理渠道，用户不可自助配置 |
# | email_sender_name / stock_email_groups | EmailSender   | AttributeError -> 默认          | 展示名/分组为全局策略，缺省不崩溃 |
# | markdown_to_image_channels / max_chars | NotificationService.__init__ | AttributeError -> 默认 | 渲染策略；缺省即文本发送 |
# | report_summary_only / report_show_llm_model | NotificationService | AttributeError -> 默认 | 报告展示策略，缺省即旧行为 |
# | notification_*（降噪/静默/最低级别） | notification_noise | AttributeError -> 默认 0/""     | 不回退：缺省即关闭，不会崩溃 |
# | report_notification_channels 等路由属性 | get_channels_for_route | AttributeError -> []（不过滤） | 路由策略不回退：用户渠道全量接收 |
# | report_language             | NotificationService._get_report_language | 经 get_config() 直读全局 | 报告语言为服务端渲染策略（代码路径即全局） |
#
# 结论：无需为任何属性回退全局 Config；列表型键做本地归一化即可。
# ============================================================================


class UserChannelConfig:
    """只读 config-like 视图：仅暴露用户个人渠道配置。

    - 白名单键：返回用户存储值；未存储返回 None（发送端存在直接属性访问，
      必须保证可读且为 None 语义 = 未配置）。
    - 非白名单键：抛 AttributeError，让读取方的 getattr 默认值生效。
    """

    __slots__ = ("_user_id", "_channels")

    def __init__(self, user_id: Optional[int], channels: Optional[Dict[str, Any]]):
        object.__setattr__(self, "_user_id", user_id)
        normalized: Dict[str, Any] = {}
        for key, value in (channels or {}).items():
            if key not in USER_CHANNEL_KEYS:
                continue
            normalized_value = _normalize_value(key, value)
            if normalized_value:
                normalized[key] = normalized_value
        object.__setattr__(self, "_channels", normalized)

    def __getattr__(self, name: str) -> Any:
        channels = object.__getattribute__(self, "_channels")
        if name in channels:
            return channels[name]
        if name in USER_CHANNEL_KEYS:
            # 白名单键缺省返回 None：发送端存在直接属性访问（如 config.wechat_webhook_url）
            return None
        raise AttributeError(
            f"{type(self).__name__} has no notification channel attribute '{name}'"
        )

    def get(self, name: str, default: Any = None) -> Any:
        """安全读取；仅返回用户显式配置的值，否则 default。"""
        channels = object.__getattribute__(self, "_channels")
        if name in channels:
            return channels[name]
        return default

    @property
    def user_id(self) -> Optional[int]:
        return object.__getattribute__(self, "_user_id")

    def has_any_channel(self) -> bool:
        """用户是否配置了任意渠道项。"""
        return bool(object.__getattribute__(self, "_channels"))

    def configured_keys(self) -> Tuple[str, ...]:
        """已配置的渠道键名（仅键名，禁止用于日志输出值）。"""
        return tuple(sorted(object.__getattribute__(self, "_channels")))

    def __repr__(self) -> str:  # 防止键值（凭据）进入日志
        return (
            f"{type(self).__name__}(user_id={object.__getattribute__(self, '_user_id')}, "
            f"channels={list(self.configured_keys())})"
        )


class AdminChannelConfig:
    """管理员归属运行：个人渠道优先，未覆盖的属性回落全局 Config。

    管理员拥有全局渠道，因此渠道检测结果是"个人 + 全局"的并集。
    """

    __slots__ = ("_user_config", "_global_config")

    def __init__(self, user_config: UserChannelConfig, global_config: Any):
        object.__setattr__(self, "_user_config", user_config)
        object.__setattr__(self, "_global_config", global_config)

    def __getattr__(self, name: str) -> Any:
        user_config = object.__getattribute__(self, "_user_config")
        user_value = user_config.get(name)
        if user_value is not None:
            return user_value
        global_config = object.__getattribute__(self, "_global_config")
        # 全局缺失时抛 AttributeError，让读取方的 getattr 默认值生效
        return getattr(global_config, name)

    def has_any_channel(self) -> bool:
        return True

    def configured_keys(self) -> Tuple[str, ...]:
        return object.__getattribute__(self, "_user_config").configured_keys()

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(user={object.__getattribute__(self, '_user_config')!r}, "
            f"global=merged)"
        )


# 不可变空配置：用于"该归属不做静态推送"（fail-closed），所有渠道键均为 None
_NO_STATIC_CHANNELS = UserChannelConfig(user_id=None, channels={})

_USER_CONFIG_CACHE: Dict[int, Tuple[float, UserChannelConfig]] = {}
_CACHE_LOCK = threading.Lock()


def _normalize_value(key: str, value: Any) -> Any:
    """把用户存储值归一化成发送端期望的形态。"""
    if value is None:
        return None
    if key in _LIST_VALUED_KEYS:
        if isinstance(value, (list, tuple, set)):
            items = [str(item).strip() for item in value]
        else:
            items = [part.strip() for part in _SPLIT_PATTERN.split(str(value))]
        items = [item for item in items if item]
        return items or None
    text = str(value).strip()
    return text or None


def _coerce_user_id(owner_user_id: Any) -> Optional[int]:
    if owner_user_id is None:
        return None
    try:
        return int(str(owner_user_id).strip())
    except (TypeError, ValueError):
        return None


def _multi_user_enabled() -> bool:
    """间接层：便于测试替换，也避免模块导入期引入 src.auth。"""
    from src.auth import is_multi_user_enabled

    return is_multi_user_enabled()


def _get_db():
    """间接层：延迟获取 DatabaseManager（避免导入期循环依赖）。"""
    from src.storage import DatabaseManager

    return DatabaseManager.get_instance()


def _admin_role() -> str:
    from src.storage import USER_ROLE_ADMIN

    return USER_ROLE_ADMIN


def clear_user_config_cache() -> None:
    """清空按用户配置缓存（TTL 之外的手动失效入口）。"""
    with _CACHE_LOCK:
        _USER_CONFIG_CACHE.clear()


def build_user_config(user_id: Any) -> Optional[UserChannelConfig]:
    """构建用户的个人通知渠道配置。

    Returns:
        UserChannelConfig：用户可解析时返回（可能未配置任何渠道，即空配置）。
        None：用户 id 非法或存储读取失败（调用方应视为"不可静态推送"）。
    """
    uid = _coerce_user_id(user_id)
    if uid is None:
        logger.warning("[notify] 归属用户 id 非法，忽略个人通知渠道配置")
        return None

    now = time.monotonic()
    with _CACHE_LOCK:
        cached = _USER_CONFIG_CACHE.get(uid)
        if cached is not None and now - cached[0] < CONFIG_CACHE_TTL_SECONDS:
            return cached[1]

    try:
        raw = _get_db().get_user_setting(uid, CHANNEL_SETTINGS_KEY)
    except Exception as exc:
        # fail-closed：读取失败绝不回退全局渠道，避免跨用户凭据泄露
        logger.warning("[notify] 读取用户 %s 通知渠道配置失败，跳过其静态渠道推送: %s", uid, exc)
        return None

    config = UserChannelConfig(uid, raw if isinstance(raw, dict) else {})
    with _CACHE_LOCK:
        _USER_CONFIG_CACHE[uid] = (time.monotonic(), config)
    return config


def resolve_owner_channel_config(owner_user_id: Any, global_config: Any) -> Optional[Any]:
    """按运行归属解析静态通知渠道使用的配置。

    Returns:
        None：沿用全局渠道（未归属 / 多用户关闭）。
        config-like：替代全局配置使用（普通用户 / 管理员 / 无静态渠道的空配置）。
    """
    if owner_user_id is None or not str(owner_user_id).strip():
        return None
    if not _multi_user_enabled():
        # 多用户关闭：完全保持旧行为（全局 .env 渠道）
        return None

    uid = _coerce_user_id(owner_user_id)
    if uid is None:
        logger.warning("[notify] 归属用户 id 无法解析 (%r)，跳过静态渠道推送", owner_user_id)
        return _NO_STATIC_CHANNELS

    try:
        user = _get_db().get_user_by_id(uid)
    except Exception as exc:
        logger.warning("[notify] 查询归属用户 %s 失败，跳过静态渠道推送: %s", uid, exc)
        user = None
    if user is None or not getattr(user, "is_active", True):
        logger.warning("[notify] 归属用户不存在或已停用 (user_id=%s)，跳过静态渠道推送", uid)
        return _NO_STATIC_CHANNELS

    user_config = build_user_config(uid)
    if user_config is None:
        return _NO_STATIC_CHANNELS

    if str(getattr(user, "role", "") or "") == _admin_role():
        logger.info(
            "[notify] 管理员运行将合并个人与全局通知渠道 (user_id=%s, personal=%s)",
            uid,
            list(user_config.configured_keys()),
        )
        return AdminChannelConfig(user_config, global_config)

    if not user_config.has_any_channel():
        logger.info(
            "[notify] 用户 %s 未配置个人通知渠道，跳过静态渠道推送（报告仍会保存）",
            uid,
        )
        return _NO_STATIC_CHANNELS

    logger.debug(
        "[notify] 用户 %s 运行仅使用个人通知渠道 (%s)",
        uid,
        list(user_config.configured_keys()),
    )
    return user_config

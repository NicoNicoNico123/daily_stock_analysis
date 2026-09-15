# -*- coding: utf-8 -*-
"""
多用户模式按归属通知渠道测试

覆盖：
1. 普通用户运行仅通过个人渠道推送（不触达全局渠道）
2. 管理员运行同时使用个人渠道 + 全局渠道
3. 未归属运行（CLI / Actions / 系统）仅使用全局渠道
4. 用户未配置渠道时不推送且不崩溃（报告仍保存，由上层负责）
5. 多用户关闭时，即使带归属也保持全局渠道（零行为变化）
6. 用户无法解析 / 停用时不做静态推送
7. 个人渠道配置绝不回退全局凭据；机器人会话上下文优先级不变

Mock 边界：渠道 sender 方法（send_to_wechat / send_to_telegram ...），
不发任何网络请求；存储层以内存 FakeDB 替代。
"""
import os
import sys
import unittest
from typing import Any, Dict, Optional
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# Keep this test runnable when optional LLM/runtime deps are not installed.
for optional_module in ("litellm", "json_repair"):
    try:
        __import__(optional_module)
    except ModuleNotFoundError:
        sys.modules[optional_module] = mock.MagicMock()

from bot.models import BotMessage, ChatType
from src.config import Config
from src.notification import NotificationService
from src.notification_noise import reset_notification_noise_state
from src.services import user_notification_channels as unc

OWNER_USER_ID = 2
ADMIN_USER_ID = 1


class FakeUser:
    def __init__(self, user_id: int, role: str = "user", is_active: bool = True):
        self.id = user_id
        self.role = role
        self.is_active = is_active


class FakeDB:
    """内存版 DatabaseManager 子集：仅用户与用户设置读取。"""

    def __init__(
        self,
        users: Optional[Dict[int, FakeUser]] = None,
        settings: Optional[Dict[int, Dict[str, Any]]] = None,
    ):
        self.users = users or {}
        self.settings = settings or {}

    def get_user_by_id(self, user_id: int) -> Optional[FakeUser]:
        return self.users.get(int(user_id))

    def get_user_setting(self, user_id: int, key: str) -> Optional[Any]:
        return (self.settings.get(int(user_id)) or {}).get(key)


def _make_global_config(**overrides) -> Config:
    """全局 .env 渠道形态：telegram 已配置，其余默认关闭。"""
    return Config(
        stock_list=[],
        telegram_bot_token="global-telegram-token",
        telegram_chat_id="global-chat-id",
        **overrides,
    )


def _make_dingtalk_source_message() -> BotMessage:
    return BotMessage(
        platform="dingtalk",
        message_id="m-1",
        user_id="u-1",
        user_name="tester",
        chat_id="chat-1",
        chat_type=ChatType.GROUP,
        content="分析 600519",
        raw_data={"_session_webhook": "https://oapi.dingtalk.com/robot/send?access_token=session"},
    )


class MultiUserNotificationTestCase(unittest.TestCase):
    def setUp(self):
        reset_notification_noise_state()
        unc.clear_user_config_cache()

    def tearDown(self):
        reset_notification_noise_state()
        unc.clear_user_config_cache()

    def _build_service(
        self,
        *,
        owner_user_id: Optional[str],
        user: Optional[FakeUser],
        user_channels: Optional[Dict[str, Any]],
        global_config: Optional[Config] = None,
        multi_user_enabled: bool = True,
        source_message: Optional[BotMessage] = None,
        settings: Optional[Dict[int, Dict[str, Any]]] = None,
    ) -> NotificationService:
        db = FakeDB(
            users={user.id: user} if user is not None else {},
            settings=settings if settings is not None else (
                {user.id: {"notification_channels": user_channels}} if user is not None else {}
            ),
        )
        with mock.patch.object(unc, "_multi_user_enabled", return_value=multi_user_enabled), \
                mock.patch.object(unc, "_get_db", return_value=db), \
                mock.patch("src.notification.get_config", return_value=global_config or _make_global_config()):
            return NotificationService(source_message=source_message, owner_user_id=owner_user_id)

    def _attach_sender_mocks(self, service: NotificationService):
        service.send_to_wechat = mock.Mock(return_value=True)
        service.send_to_telegram = mock.Mock(return_value=True)
        service.send_to_dingtalk = mock.Mock(return_value=True)
        service.send_to_email = mock.Mock(return_value=True)
        return service

    # 1. 普通用户运行：仅个人渠道
    def test_user_owned_run_sends_only_via_user_channels(self):
        service = self._build_service(
            owner_user_id=str(OWNER_USER_ID),
            user=FakeUser(OWNER_USER_ID, role="user"),
            user_channels={"wechat_webhook_url": "https://example.test/user-wechat"},
        )
        self._attach_sender_mocks(service)

        result = service.send_with_results("每日报告")

        self.assertTrue(result.success)
        self.assertEqual(
            [channel.value for channel in service.get_available_channels()],
            ["wechat"],
        )
        service.send_to_wechat.assert_called_once()
        service.send_to_telegram.assert_not_called()
        service.send_to_dingtalk.assert_not_called()

    # 2. 管理员运行：个人 + 全局
    def test_admin_owned_run_gets_user_and_global_channels(self):
        service = self._build_service(
            owner_user_id=str(ADMIN_USER_ID),
            user=FakeUser(ADMIN_USER_ID, role="admin"),
            user_channels={"wechat_webhook_url": "https://example.test/admin-wechat"},
        )
        self._attach_sender_mocks(service)

        result = service.send_with_results("每日报告")

        self.assertTrue(result.success)
        channel_values = sorted(channel.value for channel in service.get_available_channels())
        self.assertEqual(channel_values, ["telegram", "wechat"])
        service.send_to_wechat.assert_called_once()
        service.send_to_telegram.assert_called_once()

    # 3. 未归属运行：仅全局渠道
    def test_unowned_run_sends_global_only(self):
        service = self._build_service(
            owner_user_id=None,
            user=FakeUser(OWNER_USER_ID, role="user"),
            user_channels={"wechat_webhook_url": "https://example.test/user-wechat"},
        )
        self._attach_sender_mocks(service)

        result = service.send_with_results("每日报告")

        self.assertTrue(result.success)
        self.assertEqual(
            [channel.value for channel in service.get_available_channels()],
            ["telegram"],
        )
        service.send_to_telegram.assert_called_once()
        service.send_to_wechat.assert_not_called()

    # 4. 用户未配置渠道：不推送且不崩溃
    def test_user_without_channels_no_push_and_no_crash(self):
        service = self._build_service(
            owner_user_id=str(OWNER_USER_ID),
            user=FakeUser(OWNER_USER_ID, role="user"),
            user_channels={},
        )
        self._attach_sender_mocks(service)

        result = service.send_with_results("每日报告")

        self.assertFalse(result.dispatched)
        self.assertEqual(result.status, "no_channel")
        self.assertEqual(service.get_available_channels(), [])
        service.send_to_wechat.assert_not_called()
        service.send_to_telegram.assert_not_called()
        # 报告保存路径不受推送影响
        self.assertTrue(service.is_available() is False)

    # 5. 多用户关闭：带归属也保持全局渠道（零行为变化）
    def test_multi_user_disabled_uses_global_channels_even_with_owner(self):
        service = self._build_service(
            owner_user_id=str(OWNER_USER_ID),
            user=FakeUser(OWNER_USER_ID, role="user"),
            user_channels={"wechat_webhook_url": "https://example.test/user-wechat"},
            multi_user_enabled=False,
        )
        self._attach_sender_mocks(service)

        result = service.send_with_results("每日报告")

        self.assertTrue(result.success)
        self.assertEqual(
            [channel.value for channel in service.get_available_channels()],
            ["telegram"],
        )
        service.send_to_telegram.assert_called_once()
        service.send_to_wechat.assert_not_called()

    # 6. 用户无法解析 / 已停用：不静态推送
    def test_unknown_user_no_static_push(self):
        service = self._build_service(
            owner_user_id="9999",
            user=None,
            user_channels=None,
        )
        self._attach_sender_mocks(service)

        result = service.send_with_results("每日报告")

        self.assertFalse(result.dispatched)
        self.assertEqual(service.get_available_channels(), [])
        service.send_to_telegram.assert_not_called()

    def test_disabled_user_no_static_push(self):
        service = self._build_service(
            owner_user_id=str(OWNER_USER_ID),
            user=FakeUser(OWNER_USER_ID, role="user", is_active=False),
            user_channels={"wechat_webhook_url": "https://example.test/user-wechat"},
        )
        self._attach_sender_mocks(service)

        result = service.send_with_results("每日报告")

        self.assertFalse(result.dispatched)
        service.send_to_wechat.assert_not_called()
        service.send_to_telegram.assert_not_called()

    # 7. 硬性规则：个人配置绝不回退全局凭据
    def test_user_config_never_falls_back_to_global_credentials(self):
        service = self._build_service(
            owner_user_id=str(OWNER_USER_ID),
            user=FakeUser(OWNER_USER_ID, role="user"),
            user_channels={"wechat_webhook_url": "https://example.test/user-wechat"},
        )
        config = service._config

        self.assertEqual(config.wechat_webhook_url, "https://example.test/user-wechat")
        # 全局 telegram 凭据不得泄露进用户运行
        self.assertIsNone(config.telegram_bot_token)
        self.assertIsNone(config.telegram_chat_id)
        # 非白名单属性走发送端默认（getattr 语义），而非全局值
        with self.assertRaises(AttributeError):
            _ = config.report_summary_only
        self.assertIsNone(config.dingtalk_webhook_url)

    # 8. 用户列表型配置归一化为 list（email_receivers）
    def test_user_email_channel_normalizes_receivers_to_list(self):
        service = self._build_service(
            owner_user_id=str(OWNER_USER_ID),
            user=FakeUser(OWNER_USER_ID, role="user"),
            user_channels={
                "email_sender": "user@example.test",
                "email_password": "user-password",
                "email_receivers": "a@example.test, b@example.test",
            },
        )
        self._attach_sender_mocks(service)

        result = service.send_with_results("每日报告")

        self.assertTrue(result.success)
        self.assertEqual(
            [channel.value for channel in service.get_available_channels()],
            ["email"],
        )
        service.send_to_email.assert_called_once()
        self.assertEqual(
            service._email_config["receivers"],
            ["a@example.test", "b@example.test"],
        )
        self.assertEqual(service._email_config["sender"], "user@example.test")
        service.send_to_telegram.assert_not_called()

    # 9. 机器人会话上下文优先级不变：命中上下文时跳过静态渠道
    def test_context_channel_priority_untouched_for_user_owned_run(self):
        service = self._build_service(
            owner_user_id=str(OWNER_USER_ID),
            user=FakeUser(OWNER_USER_ID, role="user"),
            user_channels={"wechat_webhook_url": "https://example.test/user-wechat"},
            source_message=_make_dingtalk_source_message(),
        )
        self._attach_sender_mocks(service)
        service._send_dingtalk_chunked = mock.Mock(return_value=True)

        result = service.send_with_results("每日报告")

        self.assertTrue(result.success)
        service._send_dingtalk_chunked.assert_called_once()
        service.send_to_wechat.assert_not_called()
        service.send_to_telegram.assert_not_called()

    # 10. 管理员个人值优先于全局同键值
    def test_admin_user_value_overrides_global_same_key(self):
        service = self._build_service(
            owner_user_id=str(ADMIN_USER_ID),
            user=FakeUser(ADMIN_USER_ID, role="admin"),
            user_channels={
                "telegram_bot_token": "admin-own-token",
                "telegram_chat_id": "admin-own-chat",
            },
        )
        self._attach_sender_mocks(service)

        result = service.send_with_results("每日报告")

        self.assertTrue(result.success)
        self.assertEqual(service._telegram_config["bot_token"], "admin-own-token")
        self.assertEqual(service._telegram_config["chat_id"], "admin-own-chat")
        service.send_to_telegram.assert_called_once()


if __name__ == "__main__":
    unittest.main()

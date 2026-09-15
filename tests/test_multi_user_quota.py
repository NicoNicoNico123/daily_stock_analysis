# -*- coding: utf-8 -*-
"""多用户配额护栏与个人设置 API 测试。"""

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import src.auth as auth
from src.config import Config
from src.storage import DatabaseManager, USER_ROLE_ADMIN, USER_ROLE_USER


def _reset_auth_globals() -> None:
    auth._auth_enabled = None
    auth._multi_user_enabled = None
    auth._registration_enabled = None
    auth._session_secret = None
    auth._user_state_cache.clear()


class QuotaTestBase(unittest.TestCase):
    multi_user = True

    def setUp(self) -> None:
        _reset_auth_globals()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp_dir.name)
        (self.data_dir / ".env").write_text(
            "\n".join([
                "STOCK_LIST=600519",
                "ADMIN_AUTH_ENABLED=true",
                f"MULTI_USER_ENABLED={'true' if self.multi_user else 'false'}",
            ]) + "\n",
            encoding="utf-8",
        )
        os.environ["ENV_FILE"] = str(self.data_dir / ".env")
        os.environ["DATABASE_PATH"] = str(self.data_dir / "test.db")
        Config.reset_instance()
        DatabaseManager.reset_instance()
        DatabaseManager.get_instance()
        self.env_patches = [
            patch("src.services.user_quota.get_daily_analysis_limit", return_value=2),
            patch("src.services.user_quota.get_daily_chat_limit", return_value=3),
            patch("src.services.user_quota.get_watchlist_cap", return_value=2),
            patch("src.services.user_quota.get_max_users", return_value=2),
        ]
        for p in self.env_patches:
            p.start()

    def tearDown(self) -> None:
        for p in self.env_patches:
            p.stop()
        DatabaseManager.reset_instance()
        Config.reset_instance()
        _reset_auth_globals()
        os.environ.pop("ENV_FILE", None)
        os.environ.pop("DATABASE_PATH", None)
        self.temp_dir.cleanup()

    def _db(self) -> DatabaseManager:
        return DatabaseManager.get_instance()

    def _admin(self):
        from src.auth import hash_password

        return self._db().create_user("admin", *hash_password("adminpass1"), role=USER_ROLE_ADMIN)

    def _user(self, username: str):
        from src.auth import hash_password

        return self._db().create_user(username, *hash_password("password1"), role=USER_ROLE_USER)


class DailyCounterTests(QuotaTestBase):
    def test_increment_and_cap(self) -> None:
        db = self._db()
        user = self._user("alice")
        self.assertEqual(db.incr_user_daily_counter(user.id, "analysis", max_value=2), 1)
        self.assertEqual(db.incr_user_daily_counter(user.id, "analysis", max_value=2), 2)
        self.assertIsNone(db.incr_user_daily_counter(user.id, "analysis", max_value=2), "达上限后应拒绝")
        # 不影响其他 key
        self.assertEqual(db.incr_user_daily_counter(user.id, "chat", max_value=2), 1)

    def test_unlimited_when_no_cap(self) -> None:
        db = self._db()
        user = self._user("bob")
        for expected in (1, 2, 3, 4):
            self.assertEqual(db.incr_user_daily_counter(user.id, "analysis"), expected)


class ConsumeQuotaTests(QuotaTestBase):
    def test_user_blocked_at_limit_admin_unlimited(self) -> None:
        from src.services.user_quota import QUOTA_ANALYSIS, consume_daily_quota

        admin = self._admin()
        user = self._user("alice")
        # 上限 2：前两次允许，第三次拒绝
        self.assertTrue(consume_daily_quota(user.id, QUOTA_ANALYSIS)[0])
        self.assertTrue(consume_daily_quota(user.id, QUOTA_ANALYSIS)[0])
        allowed, used, limit = consume_daily_quota(user.id, QUOTA_ANALYSIS)
        self.assertFalse(allowed)
        self.assertEqual((used, limit), (2, 2))
        # admin 直通
        for _ in range(5):
            self.assertTrue(consume_daily_quota(admin.id, QUOTA_ANALYSIS)[0])

    def test_zero_limit_means_unlimited(self) -> None:
        from src.services.user_quota import QUOTA_CHAT, consume_daily_quota

        with patch("src.services.user_quota.get_daily_chat_limit", return_value=0):
            user = self._user("carol")
            for _ in range(10):
                self.assertTrue(consume_daily_quota(user.id, QUOTA_CHAT)[0])


class RegistrationCapTests(QuotaTestBase):
    def test_max_users_cap(self) -> None:
        from src.auth import create_user_account

        self._admin()
        # 上限 2：已有 admin，可再建 1 个，第 2 个被拒
        err1, user1 = create_user_account("alice", "password1")
        self.assertIsNone(err1)
        err2, _ = create_user_account("bob", "password1")
        self.assertEqual(err2, "max_users")


class AnalysisQuotaGateTests(QuotaTestBase):
    def test_task_queue_gate_raises_at_limit(self) -> None:
        from src.services.task_queue import AnalysisQuotaExceededError, AnalysisTaskQueue
        from src.services.user_quota import QUOTA_ANALYSIS, consume_daily_quota

        user = self._user("alice")
        queue = AnalysisTaskQueue()
        # 上限 2：两只要分析的股票允许，第三只触发配额异常
        queue._enforce_daily_analysis_quota(["600519", "000001"], str(user.id))
        with self.assertRaises(AnalysisQuotaExceededError):
            queue._enforce_daily_analysis_quota(["300750"], str(user.id))
        # owner 为空（单用户/系统任务）不受限
        queue._enforce_daily_analysis_quota(["600519", "000001", "300750"], None)

    def test_admin_not_limited(self) -> None:
        from src.services.task_queue import AnalysisTaskQueue

        admin = self._admin()
        queue = AnalysisTaskQueue()
        queue._enforce_daily_analysis_quota(["600519"] * 10, str(admin.id))


class MeSettingsApiTests(QuotaTestBase):
    def _client(self, current_user) -> TestClient:
        from api.v1.endpoints import me as me_endpoint

        app = FastAPI()
        app.include_router(me_endpoint.router, prefix="/api/v1/me")
        app.dependency_overrides[me_endpoint.get_current_user] = lambda: current_user
        return TestClient(app)

    def test_settings_roundtrip_and_masking(self) -> None:
        user = self._user("alice")
        client = self._client({"id": user.id, "username": "alice", "role": USER_ROLE_USER})

        with patch("api.v1.endpoints.me.is_multi_user_enabled", return_value=True):
            # 写入排程 + 渠道
            resp = client.put(
                "/api/v1/me",
                json={
                    "schedule": {"enabled": True, "times": ["18:00", "09:30", "18:00"]},
                    "notificationChannels": {
                        "telegram_bot_token": "tok123",
                        "evil_key": "dropped",
                        "custom_webhook_urls": "https://example.com/hook",
                    },
                },
            )
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            # 去重保序（按用户输入顺序，不做重排序）
            self.assertEqual(data["schedule"], {"enabled": True, "times": ["18:00", "09:30"]})
            self.assertEqual(data["notificationChannels"]["telegram_bot_token"], "******")
            self.assertNotIn("evil_key", data["notificationChannels"])

            # 回传掩码不覆盖真实值
            resp = client.put(
                "/api/v1/me",
                json={"notificationChannels": {"telegram_bot_token": "******"}},
            )
            self.assertEqual(resp.status_code, 200)
            stored = self._db().get_user_setting(user.id, "notification_channels")
            self.assertEqual(stored.get("telegram_bot_token"), "tok123")

    def test_schedule_validation_errors(self) -> None:
        user = self._user("bob")
        client = self._client({"id": user.id, "username": "bob", "role": USER_ROLE_USER})
        with patch("api.v1.endpoints.me.is_multi_user_enabled", return_value=True):
            resp = client.put(
                "/api/v1/me",
                json={"schedule": {"enabled": True, "times": ["25:00"]}},
            )
            self.assertEqual(resp.status_code, 400)
            resp = client.put(
                "/api/v1/me",
                json={"schedule": {"enabled": True, "times": []}},
            )
            self.assertEqual(resp.status_code, 400)

    def test_quota_view_in_response(self) -> None:
        user = self._user("carol")
        client = self._client({"id": user.id, "username": "carol", "role": USER_ROLE_USER})
        with patch("api.v1.endpoints.me.is_multi_user_enabled", return_value=True):
            resp = client.get("/api/v1/me")
            self.assertEqual(resp.status_code, 200)
            quota = resp.json()["quota"]
            self.assertEqual(quota["dailyAnalysis"]["limit"], 2)
            self.assertEqual(quota["watchlist"]["limit"], 2)

    def test_multi_user_off_returns_403(self) -> None:
        user = self._user("dave")
        client = self._client({"id": user.id, "username": "dave", "role": USER_ROLE_USER})
        with patch("api.v1.endpoints.me.is_multi_user_enabled", return_value=False):
            resp = client.get("/api/v1/me")
            self.assertEqual(resp.status_code, 403)


if __name__ == "__main__":
    unittest.main()

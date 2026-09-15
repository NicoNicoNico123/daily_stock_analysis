# -*- coding: utf-8 -*-
"""多用户数据隔离测试（存储层作用域契约）。

覆盖：分析历史归属与跨用户隔离、大盘复盘全局可见、会话归属、
watchlist/user_settings 存取、STOCK_LIST 一次性回填幂等。
"""

import base64
import hashlib
import os
import tempfile
import unittest
from pathlib import Path

import src.auth as auth
from src.config import Config
from src.storage import DatabaseManager, USER_ROLE_ADMIN


def _write_credential_file(data_dir: Path, password: str) -> None:
    salt = os.urandom(32)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt=salt, iterations=auth.PBKDF2_ITERATIONS)
    content = (
        f"{base64.standard_b64encode(salt).decode()}:{base64.standard_b64encode(derived).decode()}"
    )
    (data_dir / ".admin_password_hash").write_text(content, encoding="utf-8")


class ScopingTestBase(unittest.TestCase):
    multi_user = True
    stock_list = "600519,300750"

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp_dir.name)
        self.env_path = self.data_dir / ".env"
        self.env_path.write_text(
            "\n".join([
                f"STOCK_LIST={self.stock_list}",
                "GEMINI_API_KEY=test",
                "ADMIN_AUTH_ENABLED=true",
                f"MULTI_USER_ENABLED={'true' if self.multi_user else 'false'}",
            ]) + "\n",
            encoding="utf-8",
        )
        os.environ["ENV_FILE"] = str(self.env_path)
        os.environ["DATABASE_PATH"] = str(self.data_dir / "test.db")
        _write_credential_file(self.data_dir, "adminpass1")
        auth._multi_user_enabled = None
        auth._registration_enabled = None
        auth._auth_enabled = None
        auth._session_secret = None
        Config.reset_instance()
        DatabaseManager.reset_instance()

    def tearDown(self) -> None:
        DatabaseManager.reset_instance()
        Config.reset_instance()
        auth._multi_user_enabled = None
        auth._registration_enabled = None
        os.environ.pop("ENV_FILE", None)
        os.environ.pop("DATABASE_PATH", None)
        self.temp_dir.cleanup()

    def _db(self) -> DatabaseManager:
        return DatabaseManager.get_instance()

    def _admin(self):
        admin = self._db().get_admin_user()
        assert admin is not None, "bootstrap 迁移应生成 admin 行"
        return admin

    def _user(self, username: str):
        from src.storage import USER_ROLE_USER

        salt, derived = auth.hash_password("password1")
        return self._db().create_user(username, salt, derived, role=USER_ROLE_USER)


class AnalysisHistoryScopingTests(ScopingTestBase):
    def _save(self, code: str, owner: str = None) -> int:
        result = type(
            "R", (), {
                "code": code, "name": code, "sentiment_score": 60,
                "operation_advice": "hold", "trend_prediction": "up",
                "analysis_summary": "s",
            },
        )()
        return self._db().save_analysis_history(result, f"q-{code}", "daily", None, owner_user_id=owner)

    def test_owner_scoping_across_users(self) -> None:
        admin = self._admin()
        alice = self._user("alice")
        bob = self._user("bob")

        self._save("600519", owner=str(admin.id))
        self._save("000001", owner=str(alice.id))
        self._save("300750", owner=str(bob.id))
        self._save("600036")  # NULL = legacy/无主

        # alice 只看到自己的
        rows, total = self._db().get_analysis_history_paginated(owner_user_id=str(alice.id))
        codes = {r.code for r in rows}
        self.assertEqual(codes, {"000001"})
        self.assertEqual(total, 1)

        # admin 看到自己 + NULL
        rows, total = self._db().get_analysis_history_paginated(
            owner_user_id=str(admin.id), include_unowned=True
        )
        codes = {r.code for r in rows}
        self.assertEqual(codes, {"600519", "600036"})

        # 不过滤（单用户路径）看到全部
        _, total_all = self._db().get_analysis_history_paginated()
        self.assertEqual(total_all, 4)

    def test_market_review_visible_to_all_users(self) -> None:
        admin = self._admin()
        alice = self._user("alice")
        mr_code = DatabaseManager._market_review_history_code()

        result = type(
            "R", (), {
                "code": mr_code, "name": "market", "sentiment_score": 50,
                "operation_advice": "hold", "trend_prediction": "flat",
                "analysis_summary": "review",
            },
        )()
        self._db().save_analysis_history(result, "q-mr", "market_review", None, owner_user_id=str(admin.id))

        # alice（无 include_unowned）也能看到大盘复盘
        rows, _ = self._db().get_analysis_history_paginated(owner_user_id=str(alice.id))
        self.assertIn(mr_code, {r.code for r in rows})

    def test_non_admin_cannot_delete_foreign_history(self) -> None:
        alice = self._user("alice")
        bob = self._user("bob")
        record_id = self._save("600519", owner=str(bob.id))

        deleted = self._db().delete_analysis_history_records([record_id], owner_user_id=str(alice.id))
        self.assertEqual(deleted, 0)

        deleted = self._db().delete_analysis_history_records(
            [record_id], owner_user_id=str(bob.id)
        )
        self.assertEqual(deleted, 1)


class ConversationScopingTests(ScopingTestBase):
    def test_session_isolation_between_users(self) -> None:
        alice = self._user("alice")
        bob = self._user("bob")
        admin = self._admin()
        session_id = "uuid-alice-session"

        db = self._db()
        db.save_conversation_message(session_id, "user", "hello", owner_user_id=str(alice.id))
        db.save_conversation_message(session_id, "assistant", "hi", owner_user_id=str(alice.id))

        # bob 看不到 alice 的会话
        self.assertEqual(
            db.get_conversation_messages(session_id, owner_user_id=str(bob.id)), []
        )
        self.assertEqual(
            db.get_conversation_history(session_id, owner_user_id=str(bob.id)), []
        )
        self.assertEqual(
            [
                s for s in db.get_chat_sessions(owner_user_id=str(bob.id))
                if s["session_id"] == session_id
            ],
            [],
        )
        # bob 无法删除他人会话
        self.assertEqual(
            db.delete_conversation_session(session_id, owner_user_id=str(bob.id)), 0
        )

        # alice 可见
        self.assertEqual(len(db.get_conversation_messages(session_id, owner_user_id=str(alice.id))), 2)

        # admin include_unowned 看不到他人会话，但能看到 NULL（bot/legacy）会话
        null_session = "bot-session-1"
        db.save_conversation_message(null_session, "user", "bot msg")
        sessions_admin = db.get_chat_sessions(owner_user_id=str(admin.id), include_unowned=True)
        admin_sids = {s["session_id"] for s in sessions_admin}
        self.assertNotIn(session_id, admin_sids)
        self.assertIn(null_session, admin_sids)

        # 无过滤（单用户路径）全部可见
        self.assertEqual(len(db.get_conversation_messages(session_id)), 2)


class UserStocksAndSettingsTests(ScopingTestBase):
    def test_watchlist_crud_idempotent(self) -> None:
        admin = self._admin()
        db = self._db()
        # 清掉回填项，从空列表验证 CRUD（不依赖环境 STOCK_LIST 的具体内容）
        for code in list(db.list_user_stocks(admin.id)):
            db.remove_user_stock(admin.id, code)
        self.assertTrue(db.add_user_stock(admin.id, "601318"))
        self.assertTrue(db.add_user_stock(admin.id, "000001"))
        self.assertFalse(db.add_user_stock(admin.id, "601318"), "重复添加应幂等")
        self.assertEqual(db.list_user_stocks(admin.id), ["601318", "000001"])
        self.assertEqual(db.count_user_stocks(admin.id), 2)
        self.assertTrue(db.remove_user_stock(admin.id, "601318"))
        self.assertFalse(db.remove_user_stock(admin.id, "601318"))
        self.assertEqual(db.list_user_stocks(admin.id), ["000001"])

    def test_user_settings_roundtrip_and_upsert(self) -> None:
        admin = self._admin()
        db = self._db()
        self.assertIsNone(db.get_user_setting(admin.id, "schedule"))
        self.assertTrue(db.set_user_setting(admin.id, "schedule", {"enabled": True, "times": ["18:00"]}))
        self.assertEqual(
            db.get_user_setting(admin.id, "schedule"),
            {"enabled": True, "times": ["18:00"]},
        )
        self.assertTrue(db.set_user_setting(admin.id, "schedule", {"enabled": False, "times": []}))
        self.assertEqual(db.get_user_setting(admin.id, "schedule"), {"enabled": False, "times": []})

    def test_stocks_isolated_per_user(self) -> None:
        admin = self._admin()
        alice = self._user("alice")
        db = self._db()
        # admin 只有回填的 STOCK_LIST；alice 加入互不影响
        db.add_user_stock(alice.id, "601318")
        self.assertEqual(db.list_user_stocks(admin.id), list(Config.get_instance().stock_list or []))
        self.assertEqual(db.list_user_stocks(alice.id), ["601318"])


class StockListBackfillTests(ScopingTestBase):
    def test_backfill_admin_watchlist_once(self) -> None:
        admin = self._admin()
        db = self._db()
        # 多用户开启：STOCK_LIST 回填进 admin 自选股（顺序与解析后的配置一致）
        expected_codes = list(Config.get_instance().stock_list or [])
        self.assertTrue(expected_codes)
        self.assertEqual(db.list_user_stocks(admin.id), expected_codes)

        # 标记存在：admin 删除后重新初始化不会复活
        db.remove_user_stock(admin.id, expected_codes[0])
        DatabaseManager.reset_instance()
        db = DatabaseManager.get_instance()
        self.assertEqual(db.list_user_stocks(admin.id), expected_codes[1:])

    def test_backfill_marker_in_schema_migrations(self) -> None:
        self._admin()
        db = self._db()
        with db.get_session() as session:
            from src.storage import DatabaseSchemaMigration

            row = (
                session.query(DatabaseSchemaMigration)
                .filter(
                    DatabaseSchemaMigration.version == DatabaseManager._USER_SCOPE_BACKFILL_MARKER
                )
                .first()
            )
            self.assertIsNotNone(row)


class MultiUserOffBackfillTests(ScopingTestBase):
    multi_user = False

    def test_no_backfill_when_multi_user_off(self) -> None:
        admin = self._admin()
        self.assertEqual(self._db().list_user_stocks(admin.id), [])


class ScreeningScopingTests(ScopingTestBase):
    def test_screening_run_scoped(self) -> None:
        alice = self._user("alice")
        bob = self._user("bob")
        db = self._db()
        db.save_screening_run({"run_id": "r1", "strategy": "hot", "market": "cn"}, owner_user_id=str(alice.id))

        runs = db.list_screening_runs(owner_user_id=str(alice.id))
        self.assertEqual([r["run_id"] for r in runs], ["r1"])
        self.assertEqual(db.list_screening_runs(owner_user_id=str(bob.id)), [])
        self.assertIsNotNone(db.get_screening_run("r1", owner_user_id=str(alice.id)))
        self.assertIsNone(db.get_screening_run("r1", owner_user_id=str(bob.id)))
        # 单用户路径不受影响
        self.assertEqual(len(db.list_screening_runs()), 1)


if __name__ == "__main__":
    unittest.main()

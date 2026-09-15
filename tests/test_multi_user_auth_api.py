# -*- coding: utf-8 -*-
"""多用户模式（MULTI_USER_ENABLED）认证与授权测试。

覆盖：users 表 bootstrap 迁移、按用户登录/注册、5 段会话 cookie、
token_version 失效、require_admin 闸门、最后管理员保护、logout 语义。
单管理员模式回归由 test_auth.py / test_auth_api.py 覆盖。
"""

import asyncio
import base64
import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

try:
    import litellm  # noqa: F401
except ModuleNotFoundError:
    sys.modules["litellm"] = MagicMock()

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

import src.auth as auth
from api.middlewares.auth import AuthMiddleware
from api.deps import get_current_user, require_admin
from src.config import Config
from src.storage import DatabaseManager, User, USER_ROLE_ADMIN


def _hash_password_file(password: str) -> str:
    salt = os.urandom(32)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt=salt, iterations=auth.PBKDF2_ITERATIONS)
    return f"{base64.standard_b64encode(salt).decode()}:{base64.standard_b64encode(derived).decode()}"


def _reset_auth_globals() -> None:
    auth._auth_enabled = None
    auth._multi_user_enabled = None
    auth._registration_enabled = None
    auth._session_secret = None
    auth._password_hash_salt = None
    auth._password_hash_stored = None
    auth._rate_limit = {}
    auth._user_state_cache.clear()
    auth._last_multi_user_state = None


class MultiUserAuthTestCase(unittest.TestCase):
    """多用户模式 API 与授权测试基类。"""

    multi_user = True
    registration = False

    def setUp(self) -> None:
        _reset_auth_globals()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp_dir.name)
        self.env_path = self.data_dir / ".env"
        env_lines = [
            "STOCK_LIST=600519",
            "GEMINI_API_KEY=test",
            "ADMIN_AUTH_ENABLED=true",
            f"MULTI_USER_ENABLED={'true' if self.multi_user else 'false'}",
            f"AUTH_REGISTRATION_ENABLED={'true' if self.registration else 'false'}",
        ]
        self.env_path.write_text("\n".join(env_lines) + "\n", encoding="utf-8")
        os.environ["ENV_FILE"] = str(self.env_path)
        os.environ["DATABASE_PATH"] = str(self.data_dir / "test.db")
        Config.reset_instance()
        DatabaseManager.reset_instance()
        self._reset_singletons()

        self.auth_patcher = patch.object(auth, "_is_auth_enabled_from_env", return_value=True)
        self.data_dir_patcher = patch.object(auth, "_get_data_dir", return_value=self.data_dir)
        self.auth_patcher.start()
        self.data_dir_patcher.start()

    def tearDown(self) -> None:
        self.auth_patcher.stop()
        self.data_dir_patcher.stop()
        DatabaseManager.reset_instance()
        Config.reset_instance()
        _reset_auth_globals()
        os.environ.pop("ENV_FILE", None)
        os.environ.pop("DATABASE_PATH", None)
        self.temp_dir.cleanup()

    def _reset_singletons(self) -> None:
        """预置单管理员凭据文件 + 初始化 DB（触发 bootstrap 迁移）。"""
        cred_path = self.data_dir / ".admin_password_hash"
        if not cred_path.exists():
            cred_path.write_text(_hash_password_file("adminpass1"), encoding="utf-8")
        DatabaseManager.get_instance()

    def _db(self) -> DatabaseManager:
        return DatabaseManager.get_instance()

    @staticmethod
    def _build_request(cookies=None, state_user=None):
        request = SimpleNamespace(
            headers={},
            url=SimpleNamespace(scheme="http"),
            cookies=cookies or {},
            client=SimpleNamespace(host="127.0.0.1"),
        )
        if state_user is not None:
            request.state = SimpleNamespace(current_user=state_user)
        else:
            request.state = SimpleNamespace()
        return request


class MultiUserBootstrapTests(MultiUserAuthTestCase):
    def test_bootstrap_migrates_admin_password_hash(self) -> None:
        admin = self._db().get_admin_user()
        self.assertIsNotNone(admin)
        self.assertEqual(admin.username, "admin")
        self.assertEqual(admin.role, USER_ROLE_ADMIN)
        self.assertTrue(auth.verify_stored_password("adminpass1"))

    def test_bootstrap_is_idempotent(self) -> None:
        first = self._db().get_admin_user()
        DatabaseManager.reset_instance()
        _reset_auth_globals()
        DatabaseManager.get_instance()
        second = self._db().get_admin_user()
        self.assertEqual(first.id, second.id)


class MultiUserLoginTests(MultiUserAuthTestCase):
    def test_admin_login_with_username(self) -> None:
        from api.v1.endpoints import auth as auth_endpoint

        response = asyncio.run(
            auth_endpoint.auth_login(
                self._build_request(),
                auth_endpoint.LoginRequest(username="admin", password="adminpass1"),
            )
        )
        self.assertEqual(response.status_code, 200)
        cookie = response.headers["set-cookie"].split(";")[0]
        value = cookie.split("=", 1)[1]
        self.assertEqual(value.count("."), 4, "多用户 cookie 应为 5 段格式")
        user = auth.resolve_session_user(value)
        self.assertIsNotNone(user)
        self.assertEqual(user["username"], "admin")
        self.assertEqual(user["role"], USER_ROLE_ADMIN)

    def test_login_wrong_username_generic_error(self) -> None:
        from api.v1.endpoints import auth as auth_endpoint

        response = asyncio.run(
            auth_endpoint.auth_login(
                self._build_request(),
                auth_endpoint.LoginRequest(username="nosuchuser", password="whatever1"),
            )
        )
        self.assertEqual(response.status_code, 401)
        self.assertIn(b"invalid_credentials", response.body)

    def test_login_wrong_password_401(self) -> None:
        from api.v1.endpoints import auth as auth_endpoint

        response = asyncio.run(
            auth_endpoint.auth_login(
                self._build_request(),
                auth_endpoint.LoginRequest(username="admin", password="wrongpass"),
            )
        )
        self.assertEqual(response.status_code, 401)

    def test_disabled_user_cannot_login(self) -> None:
        from api.v1.endpoints import auth as auth_endpoint

        _, user = auth.create_user_account("alice", "alicepass1")
        self.assertIsNotNone(user)
        error_code, _ = auth.set_user_account_active(user["id"], False)
        self.assertIsNone(error_code)

        response = asyncio.run(
            auth_endpoint.auth_login(
                self._build_request(),
                auth_endpoint.LoginRequest(username="alice", password="alicepass1"),
            )
        )
        self.assertEqual(response.status_code, 401)


class MultiUserRegistrationTests(MultiUserAuthTestCase):
    registration = True

    def test_register_creates_normal_user(self) -> None:
        from api.v1.endpoints import auth as auth_endpoint

        response = asyncio.run(
            auth_endpoint.auth_register(
                self._build_request(),
                auth_endpoint.RegisterRequest(username="alice", password="alicepass1"),
            )
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'"role":"user"', response.body)
        cookie = response.headers["set-cookie"].split(";")[0].split("=", 1)[1]
        session_user = auth.resolve_session_user(cookie)
        self.assertIsNotNone(session_user)
        self.assertEqual(session_user["username"], "alice")

    def test_register_duplicate_username_409(self) -> None:
        from api.v1.endpoints import auth as auth_endpoint

        asyncio.run(
            auth_endpoint.auth_register(
                self._build_request(),
                auth_endpoint.RegisterRequest(username="alice", password="alicepass1"),
            )
        )
        response = asyncio.run(
            auth_endpoint.auth_register(
                self._build_request(),
                auth_endpoint.RegisterRequest(username="alice", password="alicepass2"),
            )
        )
        self.assertEqual(response.status_code, 409)
        self.assertIn(b"username_taken", response.body)

    def test_register_invalid_username_400(self) -> None:
        from api.v1.endpoints import auth as auth_endpoint

        response = asyncio.run(
            auth_endpoint.auth_register(
                self._build_request(),
                auth_endpoint.RegisterRequest(username="bad user!", password="alicepass1"),
            )
        )
        self.assertEqual(response.status_code, 400)

    def test_register_rate_limited(self) -> None:
        from api.v1.endpoints import auth as auth_endpoint

        request = self._build_request()
        for index in range(5):
            response = asyncio.run(
                auth_endpoint.auth_register(
                    request,
                    auth_endpoint.RegisterRequest(username=f"user{index}", password="password1"),
                )
            )
            self.assertEqual(response.status_code, 200)
        sixth = asyncio.run(
            auth_endpoint.auth_register(
                request,
                auth_endpoint.RegisterRequest(username="user_overflow", password="password1"),
            )
        )
        self.assertEqual(sixth.status_code, 429)

    def test_registration_disabled_when_flag_off(self) -> None:
        from api.v1.endpoints import auth as auth_endpoint

        self.env_path.write_text(
            "ADMIN_AUTH_ENABLED=true\nMULTI_USER_ENABLED=true\nAUTH_REGISTRATION_ENABLED=false\n",
            encoding="utf-8",
        )
        with patch.object(auth, "is_registration_enabled", return_value=False):
            response = asyncio.run(
                auth_endpoint.auth_register(
                    self._build_request(),
                    auth_endpoint.RegisterRequest(username="alice", password="alicepass1"),
                )
            )
        self.assertEqual(response.status_code, 403)
        self.assertIn(b"registration_disabled", response.body)


class MultiUserRegistrationClosedTests(MultiUserAuthTestCase):
    """AUTH_REGISTRATION_ENABLED 默认 false：注册必须被拒绝。"""

    def test_register_rejected_when_closed(self) -> None:
        from api.v1.endpoints import auth as auth_endpoint

        response = asyncio.run(
            auth_endpoint.auth_register(
                self._build_request(),
                auth_endpoint.RegisterRequest(username="alice", password="alicepass1"),
            )
        )
        self.assertEqual(response.status_code, 403)
        self.assertIn(b"registration_disabled", response.body)


class RequireAdminTests(MultiUserAuthTestCase):
    def _probe_app(self) -> FastAPI:
        app = FastAPI()
        app.add_middleware(AuthMiddleware)

        @app.get("/api/v1/any")
        async def any_endpoint(request=Depends(get_current_user)):
            return {"user": request}

        @app.get("/api/v1/admin-only")
        async def admin_endpoint(_: None = Depends(require_admin)):
            return {"ok": True}

        return app

    def test_normal_user_forbidden_on_admin_endpoint(self) -> None:
        _, user = auth.create_user_account("bob", "bobpass12")
        session_val = auth.create_session(user["id"], user["token_version"])
        client = TestClient(self._probe_app())
        response = client.get(
            "/api/v1/admin-only", cookies={auth.COOKIE_NAME: session_val}
        )
        self.assertEqual(response.status_code, 403)

    def test_admin_allowed_on_admin_endpoint(self) -> None:
        admin = self._db().get_admin_user()
        session_val = auth.create_session(admin.id, admin.token_version)
        client = TestClient(self._probe_app())
        response = client.get(
            "/api/v1/admin-only", cookies={auth.COOKIE_NAME: session_val}
        )
        self.assertEqual(response.status_code, 200)

    def test_token_version_mismatch_rejected(self) -> None:
        _, user = auth.create_user_account("carol", "carolpass1")
        stale_session = auth.create_session(user["id"], user["token_version"])
        auth.change_user_account_password(user["id"], "newpass456")
        client = TestClient(self._probe_app())
        response = client.get(
            "/api/v1/any", cookies={auth.COOKIE_NAME: stale_session}
        )
        self.assertEqual(response.status_code, 401, "改密后旧 token_version 会话必须失效")

    def test_legacy_cookie_rejected_in_multi_user_mode(self) -> None:
        legacy_session = asyncio.run(self._legacy_session())
        client = TestClient(self._probe_app())
        response = client.get(
            "/api/v1/any", cookies={auth.COOKIE_NAME: legacy_session}
        )
        self.assertEqual(response.status_code, 401)

    async def _legacy_session(self) -> str:
        with patch.object(auth, "is_multi_user_enabled", return_value=False):
            return auth.create_session()


class MultiUserOffPassthroughTests(MultiUserAuthTestCase):
    """MULTI_USER_ENABLED=false：require_admin 直通、旧 3 段 cookie 仍有效。"""

    multi_user = False

    def test_admin_endpoint_open_for_any_session(self) -> None:
        # 多用户关闭但 auth 开启：任何有效（3 段旧格式）会话都拥有 admin 语义
        session_val = auth.create_session()
        client = TestClient(self._probe_app())
        response = client.get(
            "/api/v1/admin-only", cookies={auth.COOKIE_NAME: session_val}
        )
        self.assertEqual(response.status_code, 200, "多用户关闭时 require_admin 直通")

    def test_legacy_session_still_valid(self) -> None:
        session_val = auth.create_session()
        self.assertEqual(session_val.count("."), 2, "多用户关闭时会话保持 3 段格式")
        client = TestClient(self._probe_app())
        response = client.get("/api/v1/any", cookies={auth.COOKIE_NAME: session_val})
        self.assertEqual(response.status_code, 200)

    def _probe_app(self) -> FastAPI:
        app = FastAPI()
        app.add_middleware(AuthMiddleware)

        @app.get("/api/v1/any")
        async def any_endpoint(request=Depends(get_current_user)):
            return {"user": request}

        @app.get("/api/v1/admin-only")
        async def admin_endpoint(_: None = Depends(require_admin)):
            return {"ok": True}

        return app


class LastAdminProtectionTests(MultiUserAuthTestCase):
    def test_cannot_disable_last_admin(self) -> None:
        admin = self._db().get_admin_user()
        error_code, _ = auth.set_user_account_active(admin.id, False)
        self.assertEqual(error_code, "last_admin")

    def test_cannot_demote_last_admin(self) -> None:
        admin = self._db().get_admin_user()
        error_code, _ = auth.set_user_account_role(admin.id, "user")
        self.assertEqual(error_code, "last_admin")

    def test_second_admin_can_be_disabled(self) -> None:
        _, second = auth.create_user_account("admin2", "admin2pass", role=USER_ROLE_ADMIN)
        error_code, _ = auth.set_user_account_active(second["id"], False)
        self.assertIsNone(error_code)


class MultiUserLogoutTests(MultiUserAuthTestCase):
    def test_logout_does_not_invalidate_other_users(self) -> None:
        from api.v1.endpoints import auth as auth_endpoint

        admin = self._db().get_admin_user()
        _, alice = auth.create_user_account("alice", "alicepass1")
        alice_session = auth.create_session(alice["id"], alice["token_version"])

        response = asyncio.run(auth_endpoint.auth_logout(self._build_request()))
        self.assertEqual(response.status_code, 204)

        # 其他用户会话仍然有效（logout 不再全局轮换 secret）
        auth._user_state_cache.clear()
        state = auth.resolve_session_user(alice_session)
        self.assertIsNotNone(state)
        self.assertEqual(state["id"], alice["id"])
        self.assertIsNotNone(self._db().get_user_by_id(admin.id))


class MultiUserChangePasswordTests(MultiUserAuthTestCase):
    def test_change_password_reissues_cookie_and_kills_old_sessions(self) -> None:
        from api.v1.endpoints import auth as auth_endpoint

        _, alice = auth.create_user_account("alice", "alicepass1")
        old_session = auth.create_session(alice["id"], alice["token_version"])
        user_state = auth.resolve_session_user(old_session)
        self.assertIsNotNone(user_state)

        request = self._build_request(cookies={auth.COOKIE_NAME: old_session})
        request.state.current_user = user_state

        response = asyncio.run(
            auth_endpoint.auth_change_password(
                request,
                auth_endpoint.ChangePasswordRequest(
                    currentPassword="alicepass1",
                    newPassword="newpass99",
                    newPasswordConfirm="newpass99",
                ),
            )
        )
        self.assertEqual(response.status_code, 200)

        # 新 cookie 有效
        set_cookie = response.headers.get("set-cookie", "")
        if set_cookie:
            new_value = set_cookie.split(";")[0].split("=", 1)[1]
            auth._user_state_cache.clear()
            self.assertIsNotNone(auth.resolve_session_user(new_value))

        # 旧会话失效
        auth._user_state_cache.clear()
        self.assertIsNone(auth.resolve_session_user(old_session))


if __name__ == "__main__":
    unittest.main()

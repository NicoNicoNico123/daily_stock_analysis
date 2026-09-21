# -*- coding: utf-8 -*-
"""邮箱登录 / 邮箱验证 / OAuth 第三方登录（多用户模式）离线测试。

覆盖：
- user_identities 表与 users.email 迁移（幂等）、身份唯一性；
- 注册可选邮箱（重复 409）、邮箱或用户名登录、验证令牌（happy / 篡改 / 过期 / 复用）；
- OAuth state 一次性消费与篡改拒绝；
- Google 回调建号 -> 会话 cookie 有效 -> 同一 sub 重复登录不重复建号；
- AUTH_REGISTRATION_ENABLED=false 时回调拒绝；
- token 端点失败 -> 错误重定向；密钥 / code / access_token 不落日志或响应。

所有外部 HTTP 均通过 patch 替换，测试完全离线。
"""

import asyncio
import base64
import hashlib
import logging
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

try:
    import litellm  # noqa: F401
except ModuleNotFoundError:
    sys.modules["litellm"] = MagicMock()

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.v1.endpoints.oauth as oauth_module
import src.auth as auth
from api.middlewares.auth import AuthMiddleware
from api.v1.endpoints import auth as auth_endpoint
from src.config import Config
from src.storage import DatabaseManager


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
    oauth_module._pending_oauth_states.clear()


class OAuthTestCase(unittest.TestCase):
    """多用户 + 开放注册基类（与 test_multi_user_auth_api.py 同构）。"""

    registration = True

    def setUp(self) -> None:
        _reset_auth_globals()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp_dir.name)
        self.env_path = self.data_dir / ".env"
        self._write_env(self.registration)
        # 保存外部 ENV_FILE / DATABASE_PATH，tearDown 还原（避免破坏同进程后续测试模块）
        self._previous_env_file = os.environ.get("ENV_FILE")
        self._previous_db_path = os.environ.get("DATABASE_PATH")
        os.environ["ENV_FILE"] = str(self.env_path)
        os.environ["DATABASE_PATH"] = str(self.data_dir / "test.db")
        Config.reset_instance()
        DatabaseManager.reset_instance()

        self.auth_patcher = patch.object(auth, "_is_auth_enabled_from_env", return_value=True)
        self.data_dir_patcher = patch.object(auth, "_get_data_dir", return_value=self.data_dir)
        self.auth_patcher.start()
        self.data_dir_patcher.start()

        cred_path = self.data_dir / ".admin_password_hash"
        cred_path.write_text(_hash_password_file("adminpass1"), encoding="utf-8")
        DatabaseManager.get_instance()

    def tearDown(self) -> None:
        self.auth_patcher.stop()
        self.data_dir_patcher.stop()
        DatabaseManager.reset_instance()
        Config.reset_instance()
        _reset_auth_globals()
        for key, previous in (
            ("ENV_FILE", self._previous_env_file),
            ("DATABASE_PATH", self._previous_db_path),
        ):
            if previous is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = previous
        self.temp_dir.cleanup()

    def _write_env(self, registration: bool) -> None:
        self.env_path.write_text(
            "\n".join(
                [
                    "STOCK_LIST=600519",
                    "GEMINI_API_KEY=test",
                    "ADMIN_AUTH_ENABLED=true",
                    "MULTI_USER_ENABLED=true",
                    f"AUTH_REGISTRATION_ENABLED={'true' if registration else 'false'}",
                    "GOOGLE_OAUTH_CLIENT_ID=google-client-id",
                    "GOOGLE_OAUTH_CLIENT_SECRET=google-client-secret",
                    "FACEBOOK_OAUTH_APP_ID=facebook-app-id",
                    "FACEBOOK_OAUTH_APP_SECRET=facebook-app-secret",
                ]
            )
            + "\n",
            encoding="utf-8",
        )

    def _db(self) -> DatabaseManager:
        return DatabaseManager.get_instance()

    @staticmethod
    def _build_request(cookies=None, accept="application/json"):
        request = SimpleNamespace(
            headers={"accept": accept},
            url=SimpleNamespace(scheme="http"),
            cookies=cookies or {},
            client=SimpleNamespace(host="127.0.0.1"),
            query_params={},
        )
        request.state = SimpleNamespace()
        return request

    @staticmethod
    def _user_id_from_cookie(response) -> int:
        cookie_value = response.headers["set-cookie"].split(";", 1)[0].split("=", 1)[1]
        session_user = auth.resolve_session_user(cookie_value)
        assert session_user is not None, "OAuth 回调签发的会话 cookie 必须可解析"
        return int(session_user["id"])


class IdentityStorageTests(OAuthTestCase):
    """user_identities / users.email 迁移与唯一性。"""

    def test_users_email_lookup_is_normalized(self) -> None:
        self.assertTrue(self._db().update_user_email(1, "Owner@Example.com"))
        self.assertIsNotNone(self._db().find_user_by_email("owner@example.com"))
        self.assertIsNone(self._db().find_user_by_email("other@example.com"))

    def test_email_migration_is_idempotent(self) -> None:
        self.assertTrue(self._db().update_user_email(1, "root@example.com"))
        DatabaseManager.reset_instance()
        _reset_auth_globals()
        DatabaseManager.get_instance()
        self.assertIsNotNone(self._db().find_user_by_email("ROOT@example.com"))

    def test_identity_unique_per_provider(self) -> None:
        manager = self._db()
        first = manager.create_user_identity(1, "google", "sub-1", email="a@example.com", email_verified=True)
        self.assertIsNotNone(first)
        self.assertIsNone(manager.create_user_identity(1, "google", "sub-1"))
        # 同一邮箱允许出现在不同 provider 下（v1 不做跨 provider 合并）
        self.assertIsNotNone(manager.create_user_identity(1, "facebook", "fb-1", email="a@example.com"))
        self.assertTrue(manager.mark_user_identity_verified(int(first.id)))
        self.assertTrue(manager.get_user_identity("google", "sub-1").email_verified)

    def test_register_user_with_email_creates_email_identity(self) -> None:
        error_code, user = auth.register_user_with_email("alice", "Alice@Example.com ", "alicepass1")
        self.assertIsNone(error_code)
        self.assertEqual(user["email"], "alice@example.com")
        identities = self._db().get_user_identities(int(user["id"]))
        self.assertEqual([i.provider for i in identities], ["email"])
        self.assertFalse(identities[0].email_verified)

    def test_register_rejects_duplicate_and_invalid_email(self) -> None:
        auth.register_user_with_email("alice", "alice@example.com", "alicepass1")
        self.assertEqual(
            auth.register_user_with_email("bob", "alice@example.com", "bobpass1")[0],
            "email_taken",
        )
        self.assertEqual(
            auth.register_user_with_email("bob", "not-an-email", "bobpass1")[0],
            "invalid_email",
        )
        # 用户名规则保持不变
        self.assertEqual(
            auth.register_user_with_email("bad user!", "bob@example.com", "bobpass1")[0],
            "invalid_username",
        )


class EmailLoginTests(OAuthTestCase):
    """邮箱 / 用户名双通道登录。"""

    def test_login_by_email_and_username(self) -> None:
        auth.register_user_with_email("alice", "alice@example.com", "alicepass1")
        by_email = auth.authenticate_by_login("alice@example.com", "alicepass1")
        self.assertIsNotNone(by_email)
        self.assertEqual(by_email["username"], "alice")
        by_username = auth.authenticate_by_login("alice", "alicepass1")
        self.assertIsNotNone(by_username)
        self.assertEqual(by_email["id"], by_username["id"])

    def test_login_rejects_wrong_credentials(self) -> None:
        auth.register_user_with_email("alice", "alice@example.com", "alicepass1")
        self.assertIsNone(auth.authenticate_by_login("alice@example.com", "wrongpass"))
        self.assertIsNone(auth.authenticate_by_login("nosuchuser@example.com", "alicepass1"))

    def test_login_endpoint_accepts_email_in_username_field(self) -> None:
        auth.register_user_with_email("alice", "alice@example.com", "alicepass1")
        response = asyncio.run(
            auth_endpoint.auth_login(
                self._build_request(),
                auth_endpoint.LoginRequest(username="alice@example.com", password="alicepass1"),
            )
        )
        self.assertEqual(response.status_code, 200)
        cookie = response.headers["set-cookie"].split(";")[0].split("=", 1)[1]
        session_user = auth.resolve_session_user(cookie)
        self.assertIsNotNone(session_user)
        self.assertEqual(session_user["username"], "alice")

    def test_register_endpoint_duplicate_email_409(self) -> None:
        first = asyncio.run(
            auth_endpoint.auth_register(
                self._build_request(),
                auth_endpoint.RegisterRequest(username="alice", password="alicepass1", email="alice@example.com"),
            )
        )
        self.assertEqual(first.status_code, 200)
        second = asyncio.run(
            auth_endpoint.auth_register(
                self._build_request(),
                auth_endpoint.RegisterRequest(username="bob", password="bobpass1", email="alice@example.com"),
            )
        )
        self.assertEqual(second.status_code, 409)
        self.assertIn(b"email_taken", second.body)
        invalid = asyncio.run(
            auth_endpoint.auth_register(
                self._build_request(),
                auth_endpoint.RegisterRequest(username="bob", password="bobpass1", email="broken@@example"),
            )
        )
        self.assertEqual(invalid.status_code, 400)
        self.assertIn(b"invalid_email", invalid.body)


class EmailVerificationTests(OAuthTestCase):
    """验证令牌：签发 / 篡改 / 过期 / 复用。"""

    def _issue_token(self, username="alice", email="alice@example.com") -> dict:
        _, user = auth.register_user_with_email(username, email, "alicepass1")
        token = auth.create_email_verification_token(int(user["id"]), email)
        self.assertTrue(token)
        return {"token": token, "user": user}

    def test_verify_token_happy_path_marks_identity_verified(self) -> None:
        issued = self._issue_token()
        error_code, info = auth.verify_email_token(issued["token"])
        self.assertIsNone(error_code)
        self.assertEqual(info["email"], "alice@example.com")
        identity = self._db().find_user_identity_by_email("email", "alice@example.com")
        self.assertTrue(identity.email_verified)

    def test_verify_token_rejects_tampering(self) -> None:
        issued = self._issue_token()
        self.assertEqual(auth.verify_email_token(issued["token"][:-4] + "zzzz")[0], "invalid_token")

    def test_verify_token_rejects_reuse(self) -> None:
        issued = self._issue_token()
        self.assertIsNone(auth.verify_email_token(issued["token"])[0])
        self.assertEqual(auth.verify_email_token(issued["token"])[0], "used_token")

    def test_verify_token_expires(self) -> None:
        issued = self._issue_token()
        future = time.time() + auth.EMAIL_VERIFICATION_TTL_HOURS * 3600 + 60
        with patch.object(auth.time, "time", return_value=future):
            self.assertEqual(auth.verify_email_token(issued["token"])[0], "expired_token")

    def test_verify_email_endpoint_html_and_json(self) -> None:
        issued = self._issue_token()
        html = asyncio.run(
            auth_endpoint.auth_verify_email(self._build_request(accept="text/html"), token=issued["token"])
        )
        self.assertEqual(html.status_code, 200)
        self.assertIn("驗證成功", html.body.decode())
        second = self._issue_token(username="bob", email="bob@example.com")
        reused = asyncio.run(
            auth_endpoint.auth_verify_email(self._build_request(), token=second["token"])
        )
        self.assertEqual(reused.status_code, 200)
        third = asyncio.run(
            auth_endpoint.auth_verify_email(self._build_request(), token=second["token"])
        )
        self.assertEqual(third.status_code, 400)


def _fake_response(status_code=200, payload=None) -> MagicMock:
    response = MagicMock()
    response.status_code = status_code
    response.json.return_value = payload if payload is not None else {}
    return response


class _GoogleCallbackMixin:
    """patch 掉全部出站 HTTP；离线模拟 Google token / userinfo 端点。"""

    def _patch_http(self, token_payload=None, userinfo=None, token_status=200, userinfo_status=200):
        patcher = patch.multiple(
            oauth_module.http_client,
            post=MagicMock(return_value=_fake_response(token_status, token_payload)),
            get=MagicMock(return_value=_fake_response(userinfo_status, userinfo)),
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def _google_userinfo(email="first@gmail.com", email_verified=True, sub="google-sub-1"):
        return {"sub": sub, "email": email, "email_verified": email_verified, "name": "First User"}

    def _callback(self, provider="google", code="auth-code", state=None):
        state = state or oauth_module.create_oauth_state(provider)
        endpoint = oauth_module.google_callback if provider == "google" else oauth_module.facebook_callback
        return asyncio.run(endpoint(self._build_request(), code=code, state=state))


class OAuthStateTests(OAuthTestCase):
    """state 签发 / 一次性消费 / 篡改拒绝。"""

    def test_state_roundtrip_and_one_time(self) -> None:
        state = oauth_module.create_oauth_state("google")
        self.assertTrue(state)
        self.assertEqual(state.count("."), 3)
        self.assertTrue(oauth_module.consume_oauth_state("google", state))
        self.assertFalse(oauth_module.consume_oauth_state("google", state), "state 必须一次性")

    def test_state_rejects_tamper_and_provider_swap(self) -> None:
        state = oauth_module.create_oauth_state("google")
        self.assertFalse(oauth_module.consume_oauth_state("google", state[:-3] + "aaa"))
        self.assertFalse(oauth_module.consume_oauth_state("facebook", state))

    def test_state_expires(self) -> None:
        state = oauth_module.create_oauth_state("google")
        nonce = state.split(".")[1]
        future = time.time() + oauth_module.OAUTH_STATE_TTL_SEC + 10
        with patch.object(oauth_module.time, "time", return_value=future):
            self.assertFalse(oauth_module.consume_oauth_state("google", state))
        self.assertNotIn(nonce, oauth_module._pending_oauth_states, "过期 state 必须被清理")


class OAuthGoogleCallbackTests(_GoogleCallbackMixin, OAuthTestCase):
    def _google_userinfo(self, *args, **kwargs):  # type: ignore[override]
        return _GoogleCallbackMixin._google_userinfo(*args, **kwargs)

    def test_first_callback_creates_user_identity_and_session(self) -> None:
        self._patch_http(token_payload={"access_token": "atok"}, userinfo=self._google_userinfo())
        response = self._callback()
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers["location"].startswith("/oauth/callback?status=ok"))
        self.assertIn("dsa_session=", response.headers["set-cookie"])
        user_id = self._user_id_from_cookie(response)
        session_user = auth.get_user_account(user_id)
        self.assertEqual(session_user["username"], "first")
        self.assertEqual(session_user["role"], "user")
        identity = self._db().get_user_identity("google", "google-sub-1")
        self.assertIsNotNone(identity)
        self.assertEqual(int(identity.user_id), user_id)
        self.assertTrue(identity.email_verified)
        self.assertEqual(identity.email, "first@gmail.com")

    def test_second_callback_same_sub_returns_same_user(self) -> None:
        self._patch_http(token_payload={"access_token": "atok"}, userinfo=self._google_userinfo())
        first = self._callback()
        second = self._callback()
        self.assertEqual(self._user_id_from_cookie(first), self._user_id_from_cookie(second))
        usernames = [u.username for u in self._db().list_users() if u.username.startswith("first")]
        self.assertEqual(len(usernames), 1)

    def test_unverified_email_identity_created_but_flagged(self) -> None:
        self._patch_http(
            token_payload={"access_token": "atok"},
            userinfo=self._google_userinfo(email="unverified@gmail.com", email_verified=False),
        )
        response = self._callback()
        self.assertEqual(response.status_code, 302)
        identity = self._db().get_user_identity("google", "google-sub-1")
        self.assertIsNotNone(identity)
        self.assertFalse(identity.email_verified, "未验证邮箱身份必须保持未验证标记")

    def test_registration_disabled_rejected(self) -> None:
        self._patch_http(token_payload={"access_token": "atok"}, userinfo=self._google_userinfo())
        with patch.object(auth, "is_registration_enabled", return_value=False):
            response = self._callback()
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["location"], "/login?oauthError=registration_disabled")
        self.assertIsNone(self._db().get_user_identity("google", "google-sub-1"))

    def test_token_endpoint_failure_redirects_to_error(self) -> None:
        self._patch_http(token_status=400, token_payload={"error": "invalid_grant"})
        response = self._callback()
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["location"], "/login?oauthError=token_exchange_failed")

    def test_userinfo_failure_redirects_to_error(self) -> None:
        self._patch_http(token_payload={"access_token": "atok"}, userinfo_status=401)
        response = self._callback()
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["location"], "/login?oauthError=provider_error")

    def test_replayed_or_invalid_state_rejected(self) -> None:
        self._patch_http(token_payload={"access_token": "atok"}, userinfo=self._google_userinfo())
        self.assertEqual(
            self._callback(state="google.bad.ts.sig").headers["location"],
            "/login?oauthError=state_invalid",
        )
        state = oauth_module.create_oauth_state("google")
        asyncio.run(oauth_module.google_callback(self._build_request(), code="auth-code", state=state))
        replay = asyncio.run(
            oauth_module.google_callback(self._build_request(), code="auth-code", state=state)
        )
        self.assertEqual(replay.headers["location"], "/login?oauthError=state_invalid")

    def test_facebook_callback_creates_identity_unverified_email(self) -> None:
        self._patch_http(
            token_payload={"access_token": "fbtok"},
            userinfo={"id": "fb-77", "name": "FB User", "email": "user@facebook.com"},
        )
        response = self._callback(provider="facebook")
        self.assertEqual(response.status_code, 302)
        identity = self._db().get_user_identity("facebook", "fb-77")
        self.assertIsNotNone(identity)
        self.assertFalse(identity.email_verified, "Facebook 无 email_verified claim，按未验证处理")


class OAuthSecurityTests(_GoogleCallbackMixin, OAuthTestCase):
    def test_client_secret_never_logged_or_returned(self) -> None:
        captured: list[str] = []
        handler = logging.Handler()
        handler.emit = lambda record: captured.append(record.getMessage())
        oauth_logger = logging.getLogger("api.v1.endpoints.oauth")
        oauth_logger.addHandler(handler)
        self.addCleanup(lambda: oauth_logger.removeHandler(handler))
        self._patch_http(token_payload={"access_token": "atok"}, userinfo=self._google_userinfo())
        response = self._callback()
        visible = (response.headers.get("location") or "") + (response.headers.get("set-cookie") or "")
        self.assertNotIn("google-client-secret", visible)
        for line in captured:
            self.assertNotIn("google-client-secret", line)
            self.assertNotIn("auth-code", line)
            self.assertNotIn("atok", line)

    def test_authorize_redirects_to_google_with_state(self) -> None:
        response = asyncio.run(oauth_module.google_authorize())
        self.assertEqual(response.status_code, 302)
        location = response.headers["location"]
        self.assertTrue(location.startswith("https://accounts.google.com/o/oauth2/v2/auth?"))
        self.assertIn("client_id=google-client-id", location)
        self.assertIn("response_type=code", location)
        self.assertIn("scope=openid%20email%20profile", location)
        self.assertIn("access_type=offline", location)
        self.assertIn("redirect_uri=", location)
        self.assertNotIn("google-client-secret", location)
        state = location.split("state=", 1)[1].split("&", 1)[0]
        self.assertTrue(oauth_module.consume_oauth_state("google", state))

    def test_authorize_fails_closed_without_config(self) -> None:
        with patch.object(oauth_module, "list_configured_oauth_providers", return_value=[]):
            response = asyncio.run(oauth_module.google_authorize())
        self.assertEqual(response.headers["location"], "/login?oauthError=not_configured")

    def test_providers_list_requires_both_id_and_secret(self) -> None:
        cases = [
            (None, None, "id", "secret"),  # google 完全未配置
            ("id", "secret", "id", None),  # facebook 缺 secret
            ("id", None, "id", "secret"),  # google 缺 secret
        ]
        for google_id, google_secret, facebook_id, facebook_secret in cases:
            config = SimpleNamespace(
                google_oauth_client_id=google_id,
                google_oauth_client_secret=google_secret,
                facebook_oauth_app_id=facebook_id,
                facebook_oauth_app_secret=facebook_secret,
            )
            with patch("src.config.get_config", return_value=config):
                expected = [
                    name
                    for name, ready in (
                        ("google", bool(google_id and google_secret)),
                        ("facebook", bool(facebook_id and facebook_secret)),
                    )
                    if ready
                ]
                self.assertEqual(auth.list_configured_oauth_providers(), expected)

    def test_status_reports_oauth_providers_and_email_login(self) -> None:
        status = asyncio.run(auth_endpoint.auth_status(self._build_request()))
        self.assertEqual(status["oauthProviders"], ["google", "facebook"])
        self.assertFalse(status["emailLoginEnabled"])

        self.env_path.write_text(
            self.env_path.read_text(encoding="utf-8")
            + "EMAIL_SENDER=bot@example.com\nEMAIL_PASSWORD=secret-code\n",
            encoding="utf-8",
        )
        Config.reset_instance()
        status = asyncio.run(auth_endpoint.auth_status(self._build_request()))
        self.assertTrue(status["emailLoginEnabled"])

    def test_status_oauth_providers_empty_when_multi_user_disabled(self) -> None:
        with patch.object(auth, "is_multi_user_enabled", return_value=False):
            status = asyncio.run(auth_endpoint.auth_status(self._build_request()))
        self.assertEqual(status["oauthProviders"], [])


class OAuthMiddlewareExemptionTests(OAuthTestCase):
    def test_oauth_paths_reachable_without_session(self) -> None:
        app = FastAPI()
        app.add_middleware(AuthMiddleware)
        app.include_router(oauth_module.router, prefix="/api/v1/auth/oauth")
        client = TestClient(app, raise_server_exceptions=False)
        # 未登录访问 authorize 不应 401，而是 fail-closed 的错误重定向或正常 302
        response = client.get("/api/v1/auth/oauth/google/authorize", follow_redirects=False)
        self.assertIn(response.status_code, (302, 307))
        self.assertNotEqual(response.status_code, 401)

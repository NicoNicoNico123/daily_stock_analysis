# -*- coding: utf-8 -*-
"""
Web admin authentication module.

Single toggle (ADMIN_AUTH_ENABLED) + file-based credentials.
First login sets initial password; supports web change-password and CLI reset.

多用户模式（MULTI_USER_ENABLED && ADMIN_AUTH_ENABLED）：
- 账号存于 users 表（src/storage.py），会话 cookie 携带 userId + tokenVersion；
- 每请求校验 is_active/token_version，禁用或改密立即失效；
- MULTI_USER_ENABLED 关闭时，全部行为与单管理员模式保持一致（纯文件凭据路径）。
"""

from __future__ import annotations

import base64
import getpass
import hashlib
import hmac
import logging
import os
import re
import secrets
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from dotenv import dotenv_values
from sqlalchemy.exc import IntegrityError

from src.storage import USER_ROLE_ADMIN, USER_ROLE_USER

logger = logging.getLogger(__name__)

COOKIE_NAME = "dsa_session"
PBKDF2_ITERATIONS = 100_000
RATE_LIMIT_WINDOW_SEC = 300
RATE_LIMIT_MAX_FAILURES = 5
REGISTRATION_RATE_WINDOW_SEC = 3600
REGISTRATION_RATE_MAX = 5
SESSION_MAX_AGE_HOURS_DEFAULT = 24
MIN_PASSWORD_LEN = 6
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]{3,32}$")
# 会话用户状态缓存 TTL（秒）：避免每请求查 DB；禁用/改密通过 token_version 失效机制兜底
USER_STATE_CACHE_TTL_SEC = 5.0

# Lazy-loaded state
_auth_enabled: Optional[bool] = None
_multi_user_enabled: Optional[bool] = None
_registration_enabled: Optional[bool] = None
_session_secret: Optional[bytes] = None
_password_hash_salt: Optional[bytes] = None
_password_hash_stored: Optional[bytes] = None
_rate_limit: dict[str, Tuple[int, float, int]] = {}
_rate_limit_lock = None
_user_state_cache: dict[int, Tuple[float, Optional[Dict[str, Any]]]] = {}
# 跟踪多用户开关的 OFF->ON 切换，切换瞬间轮换 session secret 作废全部旧 cookie
_last_multi_user_state: Optional[bool] = None
_dummy_password_hash: Optional[Tuple[bytes, bytes]] = None


def _get_lock():
    """Lazy init threading lock for rate limit dict."""
    global _rate_limit_lock
    if _rate_limit_lock is None:
        import threading
        _rate_limit_lock = threading.Lock()
    return _rate_limit_lock


def _ensure_env_loaded() -> None:
    """Ensure .env is loaded before reading config."""
    from src.config import setup_env
    setup_env()


def _get_data_dir() -> Path:
    """Return DATA_DIR as parent of DATABASE_PATH."""
    db_path = os.getenv("DATABASE_PATH", "./data/stock_analysis.db")
    return Path(db_path).resolve().parent


def _get_credential_path() -> Path:
    """Path to stored password hash file."""
    return _get_data_dir() / ".admin_password_hash"


def _is_auth_enabled_from_env() -> bool:
    """Read ADMIN_AUTH_ENABLED from .env file."""
    _ensure_env_loaded()
    env_file = os.getenv("ENV_FILE")
    env_path = Path(env_file) if env_file else Path(__file__).resolve().parent.parent / ".env"
    if not env_path.exists():
        return False
    values = dotenv_values(env_path)
    val = (values.get("ADMIN_AUTH_ENABLED") or "").strip().lower()
    return val in ("true", "1", "yes")


def rotate_session_secret() -> bool:
    """Rotate the session signing secret to invalidate all active sessions."""
    global _session_secret
    data_dir = _get_data_dir()
    secret_path = data_dir / ".session_secret"
    data_dir.mkdir(parents=True, exist_ok=True)
    new_secret = secrets.token_bytes(32)
    try:
        tmp_path = secret_path.with_suffix(".tmp")
        tmp_path.write_bytes(new_secret)
        tmp_path.chmod(0o600)
        tmp_path.replace(secret_path)
        _session_secret = new_secret
        logger.info("Session secret rotated successfully")
        return True
    except OSError as e:
        logger.error("Failed to rotate .session_secret: %s", e)
        return False


def _load_session_secret() -> Optional[bytes]:
    """Load or create session secret."""
    global _session_secret
    if _session_secret is not None:
        return _session_secret

    data_dir = _get_data_dir()
    secret_path = data_dir / ".session_secret"

    try:
        if secret_path.exists():
            _session_secret = secret_path.read_bytes()
            if len(_session_secret) != 32:
                logger.warning("Invalid .session_secret length, regenerating")
                _session_secret = None
                if rotate_session_secret():
                    return _session_secret
                return None
            return _session_secret

        data_dir.mkdir(parents=True, exist_ok=True)
        new_secret = secrets.token_bytes(32)
        try:
            with open(secret_path, "xb") as f:
                f.write(new_secret)
            secret_path.chmod(0o600)
        except FileExistsError:
            _session_secret = secret_path.read_bytes()
        else:
            _session_secret = new_secret
        return _session_secret
    except OSError as e:
        logger.error("Failed to create or read .session_secret: %s", e)
        return None


def _parse_password_hash(value: str) -> Optional[Tuple[bytes, bytes]]:
    """Parse salt_b64:hash_b64. Returns (salt, hash) or None."""
    if not value or ":" not in value:
        return None
    parts = value.strip().split(":", 1)
    if len(parts) != 2:
        return None
    try:
        salt_b64, hash_b64 = parts[0].strip(), parts[1].strip()
        salt = base64.standard_b64decode(salt_b64)
        stored_hash = base64.standard_b64decode(hash_b64)
        if salt and stored_hash:
            return (salt, stored_hash)
    except (ValueError, TypeError):
        pass
    return None


def _verify_password_hash(submitted: str, salt: bytes, stored_hash: bytes) -> bool:
    """Verify submitted password against stored pbkdf2 hash."""
    computed = hashlib.pbkdf2_hmac(
        "sha256",
        submitted.encode("utf-8"),
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
    )
    return hmac.compare_digest(computed, stored_hash)


def _load_credential_from_file() -> bool:
    """Load credential from file into module globals. Returns True if loaded."""
    global _password_hash_salt, _password_hash_stored

    path = _get_credential_path()
    if not path.exists():
        _password_hash_salt = None
        _password_hash_stored = None
        return False

    try:
        raw = path.read_text().strip()
        parsed = _parse_password_hash(raw)
        if parsed is None:
            logger.warning("Invalid .admin_password_hash format, ignoring")
            return False
        _password_hash_salt, _password_hash_stored = parsed
        return True
    except OSError as e:
        logger.error("Failed to read credential file: %s", e)
        return False


def refresh_auth_state() -> None:
    """Reload auth-related state from disk and env."""
    global _auth_enabled, _multi_user_enabled, _registration_enabled, _session_secret
    global _last_multi_user_state
    _auth_enabled = None
    _multi_user_enabled = None
    _registration_enabled = None
    _session_secret = None
    _user_state_cache.clear()
    _load_credential_from_file()

    # 多用户开关 OFF->ON 切换瞬间轮换 session secret：
    # 一次性作废全部旧格式（3 段匿名）cookie，避免切换后旧会话残留。
    current_multi_user = is_multi_user_enabled()
    if _last_multi_user_state is False and current_multi_user:
        rotate_session_secret()
    _last_multi_user_state = current_multi_user


def is_auth_enabled() -> bool:
    """Return whether admin authentication is enabled (ADMIN_AUTH_ENABLED=true)."""
    global _auth_enabled
    if _auth_enabled is not None:
        return _auth_enabled
    _auth_enabled = _is_auth_enabled_from_env()
    return _auth_enabled


def _read_env_flag(key: str) -> bool:
    """Read a boolean flag from the .env file (same source as ADMIN_AUTH_ENABLED)."""
    _ensure_env_loaded()
    env_file = os.getenv("ENV_FILE")
    env_path = Path(env_file) if env_file else Path(__file__).resolve().parent.parent / ".env"
    if not env_path.exists():
        return False
    values = dotenv_values(env_path)
    val = (values.get(key) or "").strip().lower()
    return val in ("true", "1", "yes")


def is_multi_user_enabled() -> bool:
    """多用户模式生效 = MULTI_USER_ENABLED 且 ADMIN_AUTH_ENABLED 同时开启。

    生效条件绑定 ADMIN_AUTH_ENABLED：认证本身关闭时绝不能进入多用户语义
    （否则中间件放行匿名请求，而依赖 require_admin 的端点会把匿名当管理员处理）。
    """
    global _multi_user_enabled
    if _multi_user_enabled is None:
        _multi_user_enabled = _read_env_flag("MULTI_USER_ENABLED") and is_auth_enabled()
    return _multi_user_enabled


def is_registration_enabled() -> bool:
    """开放注册开关（AUTH_REGISTRATION_ENABLED）；仅在多用户模式下有意义。"""
    global _registration_enabled
    if _registration_enabled is None:
        _registration_enabled = _read_env_flag("AUTH_REGISTRATION_ENABLED")
    return _registration_enabled


def hash_password(password: str) -> Tuple[bytes, bytes]:
    """PBKDF2 派生 (salt, hash)，users 表与遗留文件共用同一格式。"""
    salt = secrets.token_bytes(32)
    derived = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
    )
    return salt, derived


def validate_username(username: str) -> Optional[str]:
    """返回错误信息；None 表示合法。"""
    if not username or not USERNAME_PATTERN.match(username):
        return "用户名需为 3-32 位字母、数字、下划线或连字符"
    return None


def _get_dummy_password_hash() -> Tuple[bytes, bytes]:
    """惰性生成一次性 dummy 派生参数，用于未知用户名的等时校验（防用户名枚举）。"""
    global _dummy_password_hash
    if _dummy_password_hash is None:
        _dummy_password_hash = hash_password("dummy-password-for-timing")
    return _dummy_password_hash


def _get_db_manager():
    from src.storage import DatabaseManager

    return DatabaseManager.get_instance()


def _load_admin_credential() -> Optional[Tuple[bytes, bytes]]:
    """管理凭据读取：多用户模式优先 users 表 admin 行（唯一校验真源），无行时回退遗留文件。"""
    if is_multi_user_enabled():
        try:
            admin = _get_db_manager().get_admin_user()
            if admin is not None and admin.is_active:
                return (bytes(admin.password_salt), bytes(admin.password_hash))
        except Exception as exc:
            logger.warning("[auth] 读取 users 表 admin 行失败，回退遗留凭据文件: %s", exc)
    if _load_credential_from_file():
        return (_password_hash_salt, _password_hash_stored)
    return None


def has_stored_password() -> bool:
    """Return whether a valid stored password hash exists."""
    return _load_admin_credential() is not None


def verify_stored_password(password: str) -> bool:
    """Verify password against stored credential even when auth is disabled."""
    credential = _load_admin_credential()
    if credential is None:
        return False
    return _verify_password_hash(password, credential[0], credential[1])


def is_password_set() -> bool:
    """Return whether initial password has been set (credential file exists and valid)."""
    if not is_auth_enabled():
        return False
    return has_stored_password()


def is_password_changeable() -> bool:
    """Return whether password can be changed via web/CLI (always True when auth enabled)."""
    return is_auth_enabled()


def _get_session_secret() -> Optional[bytes]:
    """Return session signing secret."""
    if not is_auth_enabled():
        return None
    return _load_session_secret()


def _validate_password(pwd: str) -> Optional[str]:
    """Return error message if invalid, None if valid."""
    if not pwd or not pwd.strip():
        return "密码不能为空"
    if len(pwd) < MIN_PASSWORD_LEN:
        return f"密码至少 {MIN_PASSWORD_LEN} 位"
    return None


def _write_admin_credential_to_db(salt: bytes, derived: bytes) -> bool:
    """多用户模式下把管理密码写入 users 表 admin 行（唯一校验真源）。"""
    try:
        return _get_db_manager().upsert_admin_password(salt, derived) is not None
    except Exception as e:
        logger.error("Failed to write admin credential into users table: %s", e)
        return False


def set_initial_password(password: str) -> Optional[str]:
    """
    Set initial password (first-time setup). Returns error message or None on success.
    Atomic write with 0o600 permissions. 多用户模式同时写入 users 表 admin 行。
    """
    err = _validate_password(password)
    if err:
        return err

    data_dir = _get_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    cred_path = _get_credential_path()

    salt, derived = hash_password(password)
    salt_b64 = base64.standard_b64encode(salt).decode("ascii")
    hash_b64 = base64.standard_b64encode(derived).decode("ascii")
    content = f"{salt_b64}:{hash_b64}"

    try:
        tmp_path = cred_path.with_suffix(".tmp")
        tmp_path.write_text(content)
        tmp_path.chmod(0o600)
        tmp_path.replace(cred_path)
        _load_credential_from_file()
    except OSError as e:
        logger.error("Failed to write credential file: %s", e)
        return "密码保存失败"

    if is_multi_user_enabled() and not _write_admin_credential_to_db(salt, derived):
        return "密码保存失败"
    return None


def verify_password(password: str) -> bool:
    """Verify password against stored credential. Constant-time where applicable."""
    if not is_auth_enabled():
        return True
    return verify_stored_password(password)


def change_password(current: str, new: str) -> Optional[str]:
    """
    Change password. Verifies current, writes new hash. Returns error message or None on success.
    多用户模式写 users 表 admin 行；普通用户改密走 change_user_password。
    """
    if not is_auth_enabled():
        return "认证功能未启用"
    if not is_password_set():
        return "尚未设置密码"

    credential = _load_admin_credential()
    if not current or not current.strip():
        return "请输入当前密码"
    if credential is None or not _verify_password_hash(current, credential[0], credential[1]):
        return "当前密码错误"

    err = _validate_password(new)
    if err:
        return err

    cred_path = _get_credential_path()
    salt, derived = hash_password(new)
    salt_b64 = base64.standard_b64encode(salt).decode("ascii")
    hash_b64 = base64.standard_b64encode(derived).decode("ascii")
    content = f"{salt_b64}:{hash_b64}"

    try:
        tmp_path = cred_path.with_suffix(".tmp")
        tmp_path.write_text(content)
        tmp_path.chmod(0o600)
        tmp_path.replace(cred_path)
        # Reload into memory so subsequent verify_password uses new hash
        _load_credential_from_file()
    except OSError as e:
        logger.error("Failed to write credential file: %s", e)
        return "密码保存失败"

    if is_multi_user_enabled() and not _write_admin_credential_to_db(salt, derived):
        return "密码保存失败"
    return None


def change_user_password(user_id: int, current: str, new: str) -> Optional[str]:
    """普通用户自助改密：校验当前密码后更新 users 行并递增 token_version。"""
    err = _validate_password(new)
    if err:
        return err
    if not current:
        return "请输入当前密码"
    try:
        user = _get_db_manager().get_user_by_id(user_id)
    except Exception as e:
        logger.error("Failed to load user for password change: %s", e)
        return "密码保存失败"
    if user is None or not user.is_active:
        return "用户不存在或已禁用"
    if not _verify_password_hash(current, bytes(user.password_salt), bytes(user.password_hash)):
        return "当前密码错误"

    salt, derived = hash_password(new)
    try:
        new_tv = _get_db_manager().update_user_password(user_id, salt, derived)
    except Exception as e:
        logger.error("Failed to write user password: %s", e)
        return "密码保存失败"
    if new_tv is None:
        return "用户不存在或已禁用"

    with _get_lock():
        _user_state_cache.pop(user_id, None)
    return None


def _session_max_age_hours() -> int:
    try:
        return int(os.getenv("ADMIN_SESSION_MAX_AGE_HOURS", str(SESSION_MAX_AGE_HOURS_DEFAULT)))
    except ValueError:
        return SESSION_MAX_AGE_HOURS_DEFAULT


def _sign_payload(secret: bytes, payload: str) -> str:
    return hmac.new(secret, payload.encode("utf-8"), hashlib.sha256).hexdigest()


def _check_session_expiry(ts_str: str) -> bool:
    try:
        ts = int(ts_str)
    except ValueError:
        return False
    return time.time() - ts <= _session_max_age_hours() * 3600


def create_session(user_id: Optional[int] = None, token_version: int = 0) -> str:
    """Create a signed session payload.

    - 多用户模式：``userId.tokenVersion.nonce.ts.signature``（携带身份，配合每请求校验）
    - 单管理员模式：``nonce.ts.signature``（与历史格式一致）
    """
    secret = _get_session_secret()
    if not secret:
        return ""
    nonce = secrets.token_urlsafe(32)
    ts = str(int(time.time()))
    if is_multi_user_enabled() and user_id is not None:
        payload = f"{user_id}.{int(token_version)}.{nonce}.{ts}"
    else:
        payload = f"{nonce}.{ts}"
    sig = _sign_payload(secret, payload)
    return f"{payload}.{sig}"


def _get_cached_user_state(user_id: int) -> Optional[Dict[str, Any]]:
    """带短 TTL 缓存的用户状态查询；返回 None 表示用户不存在/被禁用/token_version 不匹配。"""
    lock = _get_lock()
    now = time.time()
    with lock:
        cached = _user_state_cache.get(user_id)
        if cached and now - cached[0] < USER_STATE_CACHE_TTL_SEC:
            return cached[1]

    state: Optional[Dict[str, Any]] = None
    try:
        from src.storage import DatabaseManager

        user = DatabaseManager.get_instance().get_user_by_id(user_id)
        if user is not None and user.is_active:
            state = user.to_auth_dict()
    except Exception as exc:
        # DB 不可用时保守处理：视为无有效用户（fail-closed），并短暂缓存避免每请求重试
        logger.warning("[auth] 用户状态查询失败: %s", exc)

    with lock:
        _user_state_cache[user_id] = (now, state)
    return state


def resolve_session_user(value: str) -> Optional[Dict[str, Any]]:
    """校验会话 cookie 并解析出当前用户；无效/过期/禁用/token_version 不匹配返回 None。"""
    if not is_multi_user_enabled():
        return None
    secret = _get_session_secret()
    if not secret or not value:
        return None
    parts = value.split(".")
    if len(parts) != 5:
        return None
    user_id_str, token_version_str, nonce, ts_str, sig = parts
    payload = f"{user_id_str}.{token_version_str}.{nonce}.{ts_str}"
    expected = _sign_payload(secret, payload)
    if not hmac.compare_digest(sig, expected):
        return None
    if not _check_session_expiry(ts_str):
        return None
    try:
        user_id = int(user_id_str)
        token_version = int(token_version_str)
    except ValueError:
        return None
    state = _get_cached_user_state(user_id)
    if state is None or int(state.get("token_version", 0)) != token_version:
        return None
    return state


def get_current_user_from_request(request: Any) -> Optional[Dict[str, Any]]:
    """从 request.state 读取中间件解析好的当前用户；匿名/未解析返回 None。"""
    return getattr(getattr(request, "state", None), "current_user", None)


def verify_session(value: str) -> bool:
    """Verify session cookie and check expiry."""
    secret = _get_session_secret()
    if not secret or not value:
        return False
    if is_multi_user_enabled():
        return resolve_session_user(value) is not None
    parts = value.split(".")
    if len(parts) != 3:
        return False
    nonce, ts_str, sig = parts[0], parts[1], parts[2]
    payload = f"{nonce}.{ts_str}"
    expected = hmac.new(secret, payload.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return False
    return _check_session_expiry(ts_str)


def get_client_ip(request) -> str:
    """Get client IP, respecting TRUST_X_FORWARDED_FOR.

    When behind a single trusted reverse proxy, the proxy appends the real
    client IP as the rightmost entry in X-Forwarded-For.  We use [-1] instead
    of [0] so that an attacker cannot spoof an arbitrary leftmost value to
    rotate rate-limit buckets and bypass brute-force protection.
    """
    if os.getenv("TRUST_X_FORWARDED_FOR", "false").lower() == "true":
        forwarded = request.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[-1].strip()
    if request.client:
        return request.client.host or "127.0.0.1"
    return "127.0.0.1"


def _rl_check(key: str, max_failures: int, window_sec: int) -> bool:
    """Return True if under limit, False if rate limited."""
    lock = _get_lock()
    now = time.time()
    with lock:
        expired_keys = [k for k, (_, ts, w) in _rate_limit.items() if now - ts > w]
        for k in expired_keys:
            del _rate_limit[k]
        if key in _rate_limit:
            count, first_ts, _ = _rate_limit[key]
            if count >= max_failures:
                return False
        return True


def _rl_record(key: str, window_sec: int) -> None:
    """Record a failure into a rate-limit bucket."""
    lock = _get_lock()
    now = time.time()
    with lock:
        if key in _rate_limit:
            count, first_ts, _ = _rate_limit[key]
            if now - first_ts > window_sec:
                _rate_limit[key] = (1, now, window_sec)
            else:
                _rate_limit[key] = (count + 1, first_ts, window_sec)
        else:
            _rate_limit[key] = (1, now, window_sec)


def _rl_clear(key: str) -> None:
    lock = _get_lock()
    with lock:
        _rate_limit.pop(key, None)


def login_failure_key(ip: str, username: str = "") -> str:
    """限流桶 key：多用户模式按 (username, ip) 组合，防止单 IP 锁死所有账号或单账号被任意 IP 定向锁死。

    单管理员模式保持纯 ip key（与历史行为一致）。
    """
    if username and is_multi_user_enabled():
        return f"login:{username}:{ip}"
    return ip


def check_rate_limit(ip: str) -> bool:
    """Return True if under limit, False if rate limited."""
    return _rl_check(ip, RATE_LIMIT_MAX_FAILURES, RATE_LIMIT_WINDOW_SEC)


def record_login_failure(ip: str) -> None:
    """Record a failed login attempt for rate limiting."""
    _rl_record(ip, RATE_LIMIT_WINDOW_SEC)


def clear_rate_limit(ip: str) -> None:
    """Clear rate limit for IP after successful login."""
    _rl_clear(ip)


def check_registration_rate_limit(ip: str) -> bool:
    """注册接口限流：每 IP 每小时最多 5 次。"""
    return _rl_check(f"reg:{ip}", REGISTRATION_RATE_MAX, REGISTRATION_RATE_WINDOW_SEC)


def record_registration_failure(ip: str) -> None:
    _rl_record(f"reg:{ip}", REGISTRATION_RATE_WINDOW_SEC)


def clear_registration_rate_limit(ip: str) -> None:
    _rl_clear(f"reg:{ip}")


def overwrite_password(new_password: str) -> Optional[str]:
    """
    Overwrite stored password without verifying current. For CLI reset only.
    Returns error message or None on success. 多用户模式同时写 users 表 admin 行。
    """
    if not is_auth_enabled():
        return "认证功能未启用"
    err = _validate_password(new_password)
    if err:
        return err

    data_dir = _get_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    cred_path = _get_credential_path()

    salt, derived = hash_password(new_password)
    salt_b64 = base64.standard_b64encode(salt).decode("ascii")
    hash_b64 = base64.standard_b64encode(derived).decode("ascii")
    content = f"{salt_b64}:{hash_b64}"

    try:
        tmp_path = cred_path.with_suffix(".tmp")
        tmp_path.write_text(content)
        tmp_path.chmod(0o600)
        tmp_path.replace(cred_path)
        _load_credential_from_file()
    except OSError as e:
        logger.error("Failed to write credential file: %s", e)
        return "密码保存失败"

    if is_multi_user_enabled() and not _write_admin_credential_to_db(salt, derived):
        return "密码保存失败"
    return None


def verify_user_credentials(username: str, password: str) -> Optional[Dict[str, Any]]:
    """多用户模式登录校验。成功返回用户脱敏字典；失败返回 None（等时处理防枚举）。"""
    if not is_multi_user_enabled():
        return None
    try:
        user = _get_db_manager().get_user_by_username(username or "")
    except Exception as e:
        logger.error("Failed to query user for login: %s", e)
        user = None
    if user is None or not user.is_active:
        # 等时：未知用户也执行一次 PBKDF2，避免响应时间泄露用户名是否存在
        salt, stored = _get_dummy_password_hash()
        _verify_password_hash(password or "", salt, stored)
        return None
    if not _verify_password_hash(password or "", bytes(user.password_salt), bytes(user.password_hash)):
        return None
    return user.to_auth_dict()


def create_user_account(username: str, password: str, role: str = USER_ROLE_USER) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    """创建用户账号。返回 (错误码, 用户字典)；错误码 None 表示成功。

    错误码：invalid_username / invalid_password / username_taken / storage_error
    无任何 admin 行时首个创建的账号自动成为 admin（初始化入口）。
    """
    err = validate_username(username)
    if err:
        return ("invalid_username", None)
    err = _validate_password(password)
    if err:
        return ("invalid_password", None)
    try:
        manager = _get_db_manager()
        # 注册总量上限（防开放注册滥用；0 = 不限制）
        from src.services.user_quota import user_registration_allowed

        allowed, _count = user_registration_allowed(manager)
        if not allowed:
            return ("max_users", None)
        # 无任何 admin 行时，首个账号自动成为 admin（初始化入口）
        actual_role = USER_ROLE_ADMIN if manager.get_admin_user() is None else role
        salt, derived = hash_password(password)
        user = manager.create_user(username, salt, derived, role=actual_role)
    except IntegrityError:
        return ("username_taken", None)
    except Exception as e:
        logger.error("Failed to create user account: %s", e)
        return ("storage_error", None)
    if user is None:
        return ("username_taken", None)
    return (None, user.to_auth_dict())


def list_user_accounts() -> list[Dict[str, Any]]:
    """全部用户（脱敏）列表。"""
    try:
        users = _get_db_manager().list_users()
    except Exception as e:
        logger.error("Failed to list users: %s", e)
        return []
    return [u.to_auth_dict() for u in users]


def get_user_account(user_id: int) -> Optional[Dict[str, Any]]:
    try:
        user = _get_db_manager().get_user_by_id(user_id)
    except Exception as e:
        logger.error("Failed to get user account: %s", e)
        return None
    return user.to_auth_dict() if user else None


def change_user_account_password(user_id: int, new_password: str) -> Optional[str]:
    """管理员重置指定用户密码（不校验旧密码）。返回错误信息或 None。"""
    err = _validate_password(new_password)
    if err:
        return err
    salt, derived = hash_password(new_password)
    try:
        new_tv = _get_db_manager().update_user_password(user_id, salt, derived)
    except Exception as e:
        logger.error("Failed to reset user password: %s", e)
        return "密码保存失败"
    if new_tv is None:
        return "用户不存在"
    with _get_lock():
        _user_state_cache.pop(user_id, None)
    return None


def set_user_account_role(user_id: int, role: str) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    """变更用户角色。保护最后一个可用 admin。返回 (错误码, 用户字典)。"""
    if role not in (USER_ROLE_ADMIN, USER_ROLE_USER):
        return ("invalid_role", None)
    try:
        manager = _get_db_manager()
        target = manager.get_user_by_id(user_id)
        if target is None:
            return ("user_not_found", None)
        if (
            target.role == USER_ROLE_ADMIN
            and target.is_active
            and role != USER_ROLE_ADMIN
            and manager.count_active_admins() <= 1
        ):
            return ("last_admin", None)
        updated = manager.update_user_role(user_id, role)
    except Exception as e:
        logger.error("Failed to update user role: %s", e)
        return ("storage_error", None)
    if updated is None:
        return ("user_not_found", None)
    with _get_lock():
        _user_state_cache.pop(user_id, None)
    return (None, updated.to_auth_dict())


def set_user_account_active(user_id: int, is_active: bool) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    """启用/禁用用户。保护最后一个可用 admin 不被禁用。返回 (错误码, 用户字典)。"""
    try:
        manager = _get_db_manager()
        target = manager.get_user_by_id(user_id)
        if target is None:
            return ("user_not_found", None)
        if (
            not is_active
            and target.role == USER_ROLE_ADMIN
            and target.is_active
            and manager.count_active_admins() <= 1
        ):
            return ("last_admin", None)
        updated = manager.update_user_active(user_id, is_active)
    except Exception as e:
        logger.error("Failed to update user active state: %s", e)
        return ("storage_error", None)
    if updated is None:
        return ("user_not_found", None)
    with _get_lock():
        _user_state_cache.pop(user_id, None)
    return (None, updated.to_auth_dict())


def reset_password_cli() -> int:
    """Interactive CLI to reset password. Returns exit code."""
    _ensure_env_loaded()
    if not _is_auth_enabled_from_env():
        print("Error: Auth is not enabled. Set ADMIN_AUTH_ENABLED=true in .env", file=sys.stderr)
        return 1

    print("Enter new admin password (will not echo):", end=" ")
    pwd = getpass.getpass("")
    err = _validate_password(pwd)
    if err:
        print(f"Error: {err}", file=sys.stderr)
        return 1

    print("Confirm new password:", end=" ")
    pwd2 = getpass.getpass("")
    if pwd != pwd2:
        print("Error: Passwords do not match", file=sys.stderr)
        return 1

    err = overwrite_password(pwd)
    if err:
        print(f"Error: {err}", file=sys.stderr)
        return 1

    print("Password has been reset successfully.")
    return 0


def _main() -> int:
    """CLI entry: reset_password subcommand."""
    if len(sys.argv) > 1 and sys.argv[1] == "reset_password":
        return reset_password_cli()
    print("Usage: python -m src.auth reset_password", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(_main())

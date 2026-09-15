# -*- coding: utf-8 -*-
"""
===================================
API 依赖注入模块
===================================

职责：
1. 提供数据库 Session 依赖
2. 提供配置依赖
3. 提供服务层依赖
"""

from typing import Any, Dict, Generator, Optional, Tuple

from fastapi import HTTPException, Request
from sqlalchemy.orm import Session

from src.auth import get_current_user_from_request, is_multi_user_enabled
from src.storage import DatabaseManager
from src.config import get_config, Config
from src.services.system_config_service import SystemConfigService
from src.services.runtime_scheduler import RuntimeSchedulerService
from src.services.agent_chat_session_service import AgentChatSessionService


def get_current_user(request: Request) -> Optional[Dict[str, Any]]:
    """当前登录用户（多用户模式）；单用户模式 / 认证关闭 / 匿名时返回 None。

    身份由 AuthMiddleware 解析并写入 request.state（已校验签名、有效期、
    is_active、token_version）；此依赖不重复查库。
    """
    return get_current_user_from_request(request)


def require_admin(request: Request) -> None:
    """管理员权限闸门。

    - 多用户关闭：直通（保持旧语义——任何有效会话即管理员）。
    - 多用户开启：必须已登录且 role=admin；未登录 401、权限不足 403。
      认证关闭但多用户开启时，匿名请求无身份 → 401（fail-closed）。
    """
    if not is_multi_user_enabled():
        return
    user = get_current_user(request)
    if user is None:
        raise HTTPException(
            status_code=401,
            detail={"error": "unauthorized", "message": "Login required"},
        )
    if user.get("role") != "admin":
        raise HTTPException(
            status_code=403,
            detail={"error": "forbidden", "message": "Admin privilege required"},
        )


def resolve_owner_scope(user: Optional[Dict[str, Any]]) -> Tuple[Optional[str], bool]:
    """把当前用户解析为数据作用域参数 (owner_user_id, include_unowned)。

    - 多用户关闭 / 匿名：返回 (None, False)——查询不过滤、写入不留归属，
      与单用户部署的历史行为完全一致。
    - 多用户开启：owner 为用户 id 字符串；admin 额外可见 NULL（legacy/无主）行。
    """
    if user and is_multi_user_enabled():
        return str(user["id"]), user.get("role") == "admin"
    return None, False


def get_db() -> Generator[Session, None, None]:
    """
    获取数据库 Session 依赖
    
    使用 FastAPI 依赖注入机制，确保请求结束后自动关闭 Session
    
    Yields:
        Session: SQLAlchemy Session 对象
        
    Example:
        @router.get("/items")
        async def get_items(db: Session = Depends(get_db)):
            ...
    """
    db_manager = DatabaseManager.get_instance()
    session = db_manager.get_session()
    try:
        yield session
    finally:
        session.close()


def get_config_dep() -> Config:
    """
    获取配置依赖
    
    Returns:
        Config: 配置单例对象
    """
    return get_config()


def get_database_manager() -> DatabaseManager:
    """
    获取数据库管理器依赖
    
    Returns:
        DatabaseManager: 数据库管理器单例对象
    """
    return DatabaseManager.get_instance()


def get_agent_chat_session_service() -> AgentChatSessionService:
    """Build an Agent Chat session service for the current database manager."""
    return AgentChatSessionService(DatabaseManager.get_instance())


def get_system_config_service(request: Request) -> SystemConfigService:
    """Get app-lifecycle shared SystemConfigService instance."""
    service = getattr(request.app.state, "system_config_service", None)
    if service is None:
        service = SystemConfigService()
        request.app.state.system_config_service = service
    return service


def get_runtime_scheduler_service(request: Request) -> RuntimeSchedulerService:
    """Get app-lifecycle shared RuntimeSchedulerService instance."""
    service = getattr(request.app.state, "runtime_scheduler_service", None)
    if service is None:
        service = RuntimeSchedulerService()
        request.app.state.runtime_scheduler_service = service
    return service

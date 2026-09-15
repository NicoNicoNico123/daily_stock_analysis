# -*- coding: utf-8 -*-
"""Agent Chat session state service."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from src.agent.factory import normalize_requested_skill_ids
from src.storage import DatabaseManager


@dataclass(frozen=True)
class ChatSkillSelection:
    """Effective Skill ids and the optional state update for one chat turn."""

    effective_skill_ids: Optional[List[str]]
    selected_skill_ids_update: Optional[List[str]]


@dataclass(frozen=True)
class ChatSessionDetail:
    """Visible messages and the persisted Skill selection for one session."""

    messages: List[Dict[str, Any]]
    selected_skill_ids: Optional[List[str]]


class AgentChatSessionService:
    """Coordinate Agent Chat session state without exposing storage to HTTP handlers."""

    def __init__(self, db_manager: Optional[DatabaseManager] = None):
        self.db = db_manager or DatabaseManager.get_instance()

    def resolve_skill_selection(
        self,
        config,
        session_id: str,
        requested_skill_ids: Optional[List[str]],
        owner_user_id: Optional[str] = None,
        include_unowned: bool = False,
    ) -> ChatSkillSelection:
        if requested_skill_ids is None:
            return ChatSkillSelection(
                effective_skill_ids=(
                    self.db.get_conversation_session_selected_skill_ids(
                        session_id,
                        owner_user_id=owner_user_id,
                        include_unowned=include_unowned,
                    )
                ),
                selected_skill_ids_update=None,
            )
        if not requested_skill_ids:
            return ChatSkillSelection(
                effective_skill_ids=[],
                selected_skill_ids_update=[],
            )

        normalized = normalize_requested_skill_ids(config, requested_skill_ids)
        if not normalized:
            return ChatSkillSelection(
                effective_skill_ids=(
                    self.db.get_conversation_session_selected_skill_ids(
                        session_id,
                        owner_user_id=owner_user_id,
                        include_unowned=include_unowned,
                    )
                ),
                selected_skill_ids_update=None,
            )
        return ChatSkillSelection(
            effective_skill_ids=normalized,
            selected_skill_ids_update=normalized,
        )

    def list_sessions(
        self,
        limit: int,
        user_id: Optional[str],
        owner_user_id: Optional[str] = None,
        include_unowned: bool = False,
    ) -> List[Dict[str, Any]]:
        # 多用户模式：user_id 前缀过滤被忽略，严格按归属过滤；admin 额外可见 NULL（legacy/bot）会话。
        return self.db.get_chat_sessions(
            limit=limit,
            session_prefix=user_id,
            extra_session_ids=[user_id] if user_id else None,
            owner_user_id=owner_user_id,
            include_unowned=include_unowned,
        )

    def get_session_detail(
        self,
        session_id: str,
        limit: int,
        owner_user_id: Optional[str] = None,
        include_unowned: bool = False,
    ) -> ChatSessionDetail:
        messages = self.db.get_conversation_messages(
            session_id,
            limit=limit,
            owner_user_id=owner_user_id,
            include_unowned=include_unowned,
        )
        selected_skill_ids = self.db.get_conversation_session_selected_skill_ids(
            session_id,
            owner_user_id=owner_user_id,
            include_unowned=include_unowned,
        )

        return ChatSessionDetail(
            messages=messages,
            selected_skill_ids=selected_skill_ids,
        )

    def delete_session(
        self,
        session_id: str,
        owner_user_id: Optional[str] = None,
        include_unowned: bool = False,
    ) -> int:
        return self.db.delete_conversation_session(
            session_id,
            owner_user_id=owner_user_id,
            include_unowned=include_unowned,
        )

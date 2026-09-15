# -*- coding: utf-8 -*-
"""Alert repository.

Provides DB access helpers for alert-center P1 API tables.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import and_, delete, desc, func, or_, select

from src.storage import (
    AlertCooldownRecord,
    AlertNotificationRecord,
    AlertRuleRecord,
    AlertTriggerRecord,
    DatabaseManager,
)


class AlertRepository:
    """DB access layer for alert rules and read-only alert history."""

    def __init__(self, db_manager: Optional[DatabaseManager] = None):
        self.db = db_manager or DatabaseManager.get_instance()

    @staticmethod
    def _user_scope_condition(column, owner_user_id: Optional[str], include_unowned: bool):
        """按 owner 过滤 user_id 列；owner_user_id 为 None 时不过滤（单用户历史行为）。"""
        if owner_user_id is None:
            return None
        if include_unowned:
            # admin：可见本人 + NULL（legacy/无主）行
            return or_(column == owner_user_id, column.is_(None))
        return column == owner_user_id

    def create_rule(self, fields: Dict[str, Any], owner_user_id: Optional[str] = None) -> AlertRuleRecord:
        if owner_user_id is not None and "user_id" not in fields:
            fields = {**fields, "user_id": owner_user_id}
        with self.db.get_session() as session:
            row = AlertRuleRecord(**fields)
            session.add(row)
            session.commit()
            session.refresh(row)
            return row

    def get_rule(
        self,
        rule_id: int,
        owner_user_id: Optional[str] = None,
        include_unowned: bool = False,
    ) -> Optional[AlertRuleRecord]:
        with self.db.get_session() as session:
            query = select(AlertRuleRecord).where(AlertRuleRecord.id == rule_id)
            scope = self._user_scope_condition(AlertRuleRecord.user_id, owner_user_id, include_unowned)
            if scope is not None:
                query = query.where(scope)
            return session.execute(query.limit(1)).scalar_one_or_none()

    def update_rule(
        self,
        rule_id: int,
        fields: Dict[str, Any],
        owner_user_id: Optional[str] = None,
        include_unowned: bool = False,
    ) -> Optional[AlertRuleRecord]:
        with self.db.get_session() as session:
            query = select(AlertRuleRecord).where(AlertRuleRecord.id == rule_id)
            scope = self._user_scope_condition(AlertRuleRecord.user_id, owner_user_id, include_unowned)
            if scope is not None:
                query = query.where(scope)
            row = session.execute(query.limit(1)).scalar_one_or_none()
            if row is None:
                return None
            if owner_user_id is not None and "user_id" not in fields:
                row.user_id = owner_user_id
            for key, value in fields.items():
                setattr(row, key, value)
            row.updated_at = datetime.now()
            session.commit()
            session.refresh(row)
            return row

    def delete_rule(
        self,
        rule_id: int,
        owner_user_id: Optional[str] = None,
        include_unowned: bool = False,
    ) -> bool:
        with self.db.get_session() as session:
            conditions = [AlertRuleRecord.id == rule_id]
            scope = self._user_scope_condition(AlertRuleRecord.user_id, owner_user_id, include_unowned)
            if scope is not None:
                conditions.append(scope)
            result = session.execute(delete(AlertRuleRecord).where(and_(*conditions)))
            session.commit()
            return bool(result.rowcount)

    def list_rules(
        self,
        *,
        enabled: Optional[bool] = None,
        alert_type: Optional[str] = None,
        target_scope: Optional[str] = None,
        target: Optional[str] = None,
        source: Optional[str] = None,
        page: int = 1,
        page_size: int = 20,
        owner_user_id: Optional[str] = None,
        include_unowned: bool = False,
    ) -> Tuple[List[AlertRuleRecord], int]:
        conditions = []
        scope = self._user_scope_condition(AlertRuleRecord.user_id, owner_user_id, include_unowned)
        if scope is not None:
            conditions.append(scope)
        if enabled is not None:
            conditions.append(AlertRuleRecord.enabled.is_(enabled))
        if alert_type:
            conditions.append(AlertRuleRecord.alert_type == alert_type)
        if target_scope:
            conditions.append(AlertRuleRecord.target_scope == target_scope)
        if target:
            if target_scope == "single_symbol":
                conditions.append(func.lower(AlertRuleRecord.target) == target.strip().lower())
            else:
                conditions.append(AlertRuleRecord.target == target)
        if source:
            conditions.append(AlertRuleRecord.source == source)

        where_clause = and_(*conditions) if conditions else True
        offset = (page - 1) * page_size
        with self.db.get_session() as session:
            total = session.execute(
                select(func.count(AlertRuleRecord.id)).select_from(AlertRuleRecord).where(where_clause)
            ).scalar() or 0
            rows = session.execute(
                select(AlertRuleRecord)
                .where(where_clause)
                .order_by(desc(AlertRuleRecord.updated_at), desc(AlertRuleRecord.id))
                .offset(offset)
                .limit(page_size)
            ).scalars().all()
            return list(rows), int(total)

    def list_enabled_rules(self, *, limit: int = 1000) -> List[AlertRuleRecord]:
        safe_limit = max(1, min(int(limit), 1000))
        with self.db.get_session() as session:
            rows = session.execute(
                select(AlertRuleRecord)
                .where(AlertRuleRecord.enabled.is_(True))
                .order_by(desc(AlertRuleRecord.updated_at), desc(AlertRuleRecord.id))
                .limit(safe_limit)
            ).scalars().all()
            return list(rows)

    def create_trigger(self, fields: Dict[str, Any]) -> AlertTriggerRecord:
        self._validate_trigger_fields(fields)

        with self.db.get_session() as session:
            row = AlertTriggerRecord(**fields)
            session.add(row)
            session.commit()
            session.refresh(row)
            return row

    def create_trigger_if_absent(self, fields: Dict[str, Any]) -> Tuple[AlertTriggerRecord, bool]:
        """Create a triggered history row unless the same DB signal already exists.

        Callers must use this only after they have decided the trigger is safe to
        deduplicate. Non-triggered or timestamp-less history should use
        ``create_trigger`` so audit rows are not silently reclassified as deduped.
        """
        self._validate_trigger_fields(fields)

        rule_id = fields.get("rule_id")
        data_timestamp = fields.get("data_timestamp")
        if fields.get("status") != "triggered" or rule_id is None or data_timestamp is None:
            raise ValueError(
                "create_trigger_if_absent requires triggered status, rule_id, and data_timestamp"
            )

        with self.db.get_session() as session:
            query = select(AlertTriggerRecord).where(
                AlertTriggerRecord.rule_id == rule_id,
                AlertTriggerRecord.target == fields.get("target"),
                AlertTriggerRecord.status == "triggered",
                AlertTriggerRecord.data_timestamp == data_timestamp,
            )
            data_source = fields.get("data_source")
            if data_source is None:
                query = query.where(AlertTriggerRecord.data_source.is_(None))
            else:
                query = query.where(AlertTriggerRecord.data_source == data_source)

            existing = session.execute(
                query.order_by(AlertTriggerRecord.id.asc()).limit(1)
            ).scalar_one_or_none()
            if existing is not None:
                return existing, False

            row = AlertTriggerRecord(**fields)
            session.add(row)
            session.commit()
            session.refresh(row)
            return row, True

    @staticmethod
    def _validate_trigger_fields(fields: Dict[str, Any]) -> None:
        if not fields.get("target"):
            raise ValueError("alert trigger target is required")
        if not fields.get("status"):
            raise ValueError("alert trigger status is required")

    def record_notification_attempt(self, fields: Dict[str, Any]) -> AlertNotificationRecord:
        if not fields.get("channel"):
            raise ValueError("alert notification channel is required")
        if "user_id" not in fields:
            # 通知记录跟随触发规则归属（多用户模式）；查不到归属时保持 NULL
            owner = self._resolve_trigger_owner(fields.get("trigger_id"))
            if owner is not None:
                fields = {**fields, "user_id": owner}

        with self.db.get_session() as session:
            row = AlertNotificationRecord(**fields)
            session.add(row)
            session.commit()
            session.refresh(row)
            return row

    def _resolve_trigger_owner(self, trigger_id: Optional[int]) -> Optional[str]:
        if trigger_id is None:
            return None
        with self.db.get_session() as session:
            return session.execute(
                select(AlertRuleRecord.user_id)
                .join(AlertTriggerRecord, AlertTriggerRecord.rule_id == AlertRuleRecord.id)
                .where(AlertTriggerRecord.id == trigger_id)
                .limit(1)
            ).scalar_one_or_none()

    def get_active_cooldown(
        self,
        *,
        rule_id: int,
        target: str,
        severity: Optional[str],
        now: Optional[datetime] = None,
    ) -> Optional[AlertCooldownRecord]:
        now_value = now or datetime.now()
        with self.db.get_session() as session:
            return session.execute(
                select(AlertCooldownRecord)
                .where(
                    AlertCooldownRecord.rule_id == rule_id,
                    AlertCooldownRecord.target == target,
                    AlertCooldownRecord.severity == severity,
                    AlertCooldownRecord.state == "active",
                    AlertCooldownRecord.cooldown_until > now_value,
                )
                .order_by(desc(AlertCooldownRecord.cooldown_until), desc(AlertCooldownRecord.id))
                .limit(1)
            ).scalar_one_or_none()

    def upsert_cooldown(
        self,
        *,
        rule_id: int,
        rule_key: Optional[str],
        target: str,
        severity: Optional[str],
        last_triggered_at: datetime,
        cooldown_until: datetime,
        reason: Optional[str] = None,
        state: str = "active",
    ) -> AlertCooldownRecord:
        with self.db.get_session() as session:
            row = session.execute(
                select(AlertCooldownRecord)
                .where(
                    AlertCooldownRecord.rule_id == rule_id,
                    AlertCooldownRecord.target == target,
                    AlertCooldownRecord.severity == severity,
                )
                .limit(1)
            ).scalar_one_or_none()
            if row is None:
                row = AlertCooldownRecord(
                    rule_id=rule_id,
                    rule_key=rule_key,
                    target=target,
                    severity=severity,
                )
                session.add(row)
            row.rule_key = rule_key
            row.last_triggered_at = last_triggered_at
            row.cooldown_until = cooldown_until
            row.reason = reason
            row.state = state
            row.updated_at = datetime.now()
            session.commit()
            session.refresh(row)
            return row

    def get_rule_cooldown_summary(
        self,
        *,
        rule_id: int,
        target: str,
        severity: Optional[str],
    ) -> Optional[AlertCooldownRecord]:
        with self.db.get_session() as session:
            return session.execute(
                select(AlertCooldownRecord)
                .where(
                    AlertCooldownRecord.rule_id == rule_id,
                    AlertCooldownRecord.target == target,
                    AlertCooldownRecord.severity == severity,
                )
                .order_by(desc(AlertCooldownRecord.updated_at), desc(AlertCooldownRecord.id))
                .limit(1)
            ).scalar_one_or_none()

    def list_triggers(
        self,
        *,
        rule_id: Optional[int] = None,
        target: Optional[str] = None,
        status: Optional[str] = None,
        page: int = 1,
        page_size: int = 20,
        owner_user_id: Optional[str] = None,
        include_unowned: bool = False,
    ) -> Tuple[List[AlertTriggerRecord], int]:
        conditions = []
        # alert_triggers 无 user_id 列，按所属规则的归属过滤
        scope = self._user_scope_condition(AlertRuleRecord.user_id, owner_user_id, include_unowned)
        if scope is not None:
            scoped_rule_ids = select(AlertRuleRecord.id).where(scope)
            if include_unowned:
                # admin：额外保留 legacy env 规则（rule_id 为空）产生的触发历史
                conditions.append(
                    or_(
                        AlertTriggerRecord.rule_id.in_(scoped_rule_ids),
                        AlertTriggerRecord.rule_id.is_(None),
                    )
                )
            else:
                conditions.append(AlertTriggerRecord.rule_id.in_(scoped_rule_ids))
        if rule_id is not None:
            conditions.append(AlertTriggerRecord.rule_id == rule_id)
        if target:
            conditions.append(AlertTriggerRecord.target == target)
        if status:
            conditions.append(AlertTriggerRecord.status == status)

        where_clause = and_(*conditions) if conditions else True
        offset = (page - 1) * page_size
        with self.db.get_session() as session:
            total = session.execute(
                select(func.count(AlertTriggerRecord.id)).select_from(AlertTriggerRecord).where(where_clause)
            ).scalar() or 0
            rows = session.execute(
                select(AlertTriggerRecord)
                .where(where_clause)
                .order_by(desc(AlertTriggerRecord.triggered_at), desc(AlertTriggerRecord.id))
                .offset(offset)
                .limit(page_size)
            ).scalars().all()
            return list(rows), int(total)

    def list_notifications(
        self,
        *,
        trigger_id: Optional[int] = None,
        channel: Optional[str] = None,
        success: Optional[bool] = None,
        page: int = 1,
        page_size: int = 20,
        owner_user_id: Optional[str] = None,
        include_unowned: bool = False,
    ) -> Tuple[List[AlertNotificationRecord], int]:
        conditions = []
        scope = self._user_scope_condition(AlertNotificationRecord.user_id, owner_user_id, include_unowned)
        if scope is not None:
            conditions.append(scope)
        if trigger_id is not None:
            conditions.append(AlertNotificationRecord.trigger_id == trigger_id)
        if channel:
            conditions.append(AlertNotificationRecord.channel == channel)
        if success is not None:
            conditions.append(AlertNotificationRecord.success.is_(success))

        where_clause = and_(*conditions) if conditions else True
        offset = (page - 1) * page_size
        with self.db.get_session() as session:
            total = session.execute(
                select(func.count(AlertNotificationRecord.id))
                .select_from(AlertNotificationRecord)
                .where(where_clause)
            ).scalar() or 0
            rows = session.execute(
                select(AlertNotificationRecord)
                .where(where_clause)
                .order_by(desc(AlertNotificationRecord.created_at), desc(AlertNotificationRecord.id))
                .offset(offset)
                .limit(page_size)
            ).scalars().all()
            return list(rows), int(total)

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""历史中文报告 -> 繁体：一次性离线迁移脚本。

背景：
- 新生成的中文报告在分析定稿时统一做 OpenCC s2t 转换（见 ``src/utils/traditional.py``
  与 ``src/core/pipeline.py``），历史库里的存量中文报告仍是简体。本脚本把存量记录的
  报告文本字段批量转换为繁体，使历史数据与新生成报告保持一致。

转换范围（只动报告文本，绝不改 user_id / 代码 / 分数等其它列）：
- ``analysis_history.analysis_summary`` / ``operation_advice`` / ``trend_prediction``
- ``analysis_history.raw_result`` JSON 内的报告文本字段（含 dashboard 里的核心结论、
  狙击点位字符串、情报摘要等；``code`` / ``sentiment_score`` / ``raw_response`` 等
  非报告文本值原样保留）

用法：
    # 默认 DRY-RUN：逐行打印将被转换的记录预览，不写库
    python scripts/convert_reports_traditional.py

    # 只看前 N 条
    python scripts/convert_reports_traditional.py --limit 5

    # 实际写库
    python scripts/convert_reports_traditional.py --apply

    # 指定数据库（默认读 DATABASE_PATH / ENV_FILE）
    python scripts/convert_reports_traditional.py --db ./data/stock_analysis.db --apply

幂等性：已是繁体的字段（s2t 转换后无变化）会被跳过，重复执行安全。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.utils.traditional import to_traditional, to_traditional_tree  # noqa: E402

# raw_result JSON 中需要转换的报告文本字段（顶层字符串字段）
_RAW_RESULT_TEXT_FIELDS = (
    "analysis_summary",
    "operation_advice",
    "trend_prediction",
    "confidence_level",
    "action_label",
    "trend_analysis",
    "short_term_outlook",
    "medium_term_outlook",
    "technical_analysis",
    "ma_analysis",
    "volume_analysis",
    "pattern_analysis",
    "fundamental_analysis",
    "sector_position",
    "company_highlights",
    "news_summary",
    "market_sentiment",
    "hot_topics",
    "key_points",
    "risk_warning",
    "buy_reason",
    "error_message",
)

# raw_result JSON 中需要递归转换的结构化报告字段（dashboard 内含核心结论 / 狙击点位等）
_RAW_RESULT_TREE_FIELDS = ("dashboard", "market_snapshot")

# 其余键（code / stock_name / decision_type / action / raw_response / data_sources /
# sentiment_score 等）一律原样保留：taxonomy、标识与调试数据不做繁体转换。



def _resolve_db_path(cli_value: Optional[str]) -> Path:
    if cli_value:
        return Path(cli_value).expanduser().resolve()
    env_path = (os.getenv("DATABASE_PATH") or "").strip()
    if env_path:
        return Path(env_path).expanduser().resolve()
    env_file = (os.getenv("ENV_FILE") or "").strip()
    if env_file:
        for line in Path(env_file).read_text(encoding="utf-8").splitlines():
            if line.startswith("DATABASE_PATH="):
                value = line.split("=", 1)[1].strip().strip('"').strip("'")
                if value:
                    return Path(value).expanduser().resolve()
    return (ROOT / "data" / "stock_analysis.db").resolve()


def _load_json(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _convert_raw_result(raw_result: Dict[str, Any]) -> Tuple[Dict[str, Any], int]:
    """按白名单转换 raw_result；返回 (转换后字典, 变更字段数)。"""
    converted: Dict[str, Any] = {}
    changed = 0
    for key, value in raw_result.items():
        if key in _RAW_RESULT_TEXT_FIELDS:
            new_value = to_traditional(value) if isinstance(value, str) else to_traditional_tree(value)
        elif key in _RAW_RESULT_TREE_FIELDS:
            new_value = to_traditional_tree(value)
        else:
            new_value = value
        if new_value != value:
            changed += 1
        converted[key] = new_value
    return converted, changed


def _convert_row(row: Any) -> Tuple[Dict[str, Any], int]:
    """返回 (列更新字典, 变更字段数)。"""
    updates: Dict[str, Any] = {}
    changed = 0

    for column in ("analysis_summary", "operation_advice", "trend_prediction"):
        value = row[column] if column in row.keys() else None
        if not isinstance(value, str) or not value:
            continue
        converted = to_traditional(value)
        if converted != value:
            updates[column] = converted
            changed += 1

    raw_result = _load_json(row["raw_result"] if "raw_result" in row.keys() else None)
    if raw_result:
        converted_tree, raw_changed = _convert_raw_result(raw_result)
        if raw_changed:
            updates["raw_result"] = json.dumps(converted_tree, ensure_ascii=False)
            changed += raw_changed

    return updates, changed


def main() -> int:
    parser = argparse.ArgumentParser(description="把历史中文报告文本转换为繁体（默认 DRY-RUN）")
    parser.add_argument("--db", help="SQLite 数据库路径（默认 DATABASE_PATH / ENV_FILE / ./data）")
    parser.add_argument("--apply", action="store_true", help="实际写库；缺省只做预览")
    parser.add_argument("--limit", type=int, default=0, help="只处理前 N 条记录（0 = 不限制）")
    args = parser.parse_args()

    db_path = _resolve_db_path(args.db)
    if not db_path.exists():
        print(f"[migrate] ERROR: 数据库不存在: {db_path}", file=sys.stderr)
        return 1

    import sqlite3

    print(f"[migrate] database = {db_path}")
    print(f"[migrate] mode     = {'APPLY' if args.apply else 'DRY-RUN'}")

    connection = sqlite3.connect(str(db_path))
    connection.row_factory = sqlite3.Row
    rows = connection.execute(
        "SELECT id, code, analysis_summary, operation_advice, trend_prediction, raw_result "
        "FROM analysis_history ORDER BY id"
    ).fetchall()

    total = len(rows)
    touched = 0
    changed_fields = 0
    skipped = 0
    for index, row in enumerate(rows):
        if args.limit and touched >= args.limit:
            break
        updates, changed = _convert_row(row)
        if not updates:
            skipped += 1
            continue
        touched += 1
        changed_fields += changed
        summary = (updates.get("analysis_summary") or row["analysis_summary"] or "")[:40]
        print(
            f"[migrate] id={row['id']} code={row['code']} fields={changed} "
            f"summary={summary}..."
        )
        if args.apply:
            set_clause = ", ".join(f"{column} = ?" for column in updates)
            connection.execute(
                f"UPDATE analysis_history SET {set_clause} WHERE id = ?",
                [*updates.values(), row["id"]],
            )
            connection.commit()

    print(
        f"[migrate] done: total={total} converted={touched} "
        f"skipped_already_traditional={skipped} changed_fields={changed_fields} "
        f"applied={bool(args.apply)}"
    )
    if not args.apply and touched:
        print("[migrate] DRY-RUN 未写库；确认无误后加 --apply 执行。")
    connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

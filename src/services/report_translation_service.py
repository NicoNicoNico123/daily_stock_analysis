# -*- coding: utf-8 -*-
"""报告翻译服务

职责：
1. 读取（带归属过滤的）单条分析历史记录
2. 命中缓存时直接返回已持久化的翻译结果
3. 未命中时调用现有 LLM 生成链路翻译报告并持久化（同一记录同一目标语言只付费一次）

说明：
- 目标语言仅支持 ``en`` / ``zh``；``zh`` 表示简体中文，与后端报告语言约定一致。
- 翻译内容只覆盖报告正文（summary / strategy / markdown），记录标题、股票名称等
  数据字段保持原样，决策动作 taxonomy（decisionAction）不参与翻译。
- 任何失败都不抛异常：返回 None，由调用方回退为展示原始报告内容。
"""

from __future__ import annotations

import json
import logging
import threading
from typing import Any, Dict, Mapping, Optional

from src.config import get_config
from src.report_language import normalize_report_language
from src.services.history_service import HistoryService, MarkdownReportGenerationError
from src.storage import DatabaseManager, get_db

logger = logging.getLogger(__name__)

SUPPORTED_TARGET_LANGUAGES = ("en", "zh")

# 存储层缓存内容键
_SUMMARY_KEYS = ("analysis_summary", "operation_advice", "trend_prediction")
_STRATEGY_KEYS = ("ideal_buy", "secondary_buy", "stop_loss", "take_profit")
_MARKDOWN_KEY = "markdown"

_TRANSLATION_CALL_TYPE = "report_translation"
_TRANSLATION_MAX_TOKENS = 16384
_TRANSLATION_TEMPERATURE = 0.2

_LANGUAGE_DISPLAY = {"en": "English", "zh": "Simplified Chinese"}

_ANALYZER_LOCK = threading.Lock()
_analyzer: Optional[Any] = None


def _coerce_text(value: Any) -> Optional[str]:
    """把任意值规整为非空字符串，空值返回 None。"""
    if value is None or isinstance(value, (dict, list)):
        return None
    text = str(value).strip()
    return text or None


def _clean_payload_section(section: Any, keys: tuple[str, ...]) -> Dict[str, str]:
    """从 LLM 返回的结构里抽取指定键的非空字符串值。"""
    cleaned: Dict[str, str] = {}
    if not isinstance(section, Mapping):
        return cleaned
    for key in keys:
        text = _coerce_text(section.get(key))
        if text is not None:
            cleaned[key] = text
    return cleaned


def _build_source_payload(
    detail: Mapping[str, Any],
    markdown_content: Optional[str],
) -> Dict[str, Any]:
    """从历史详情构造待翻译 payload（只包含非空字段）。"""
    payload: Dict[str, Any] = {
        "summary": _clean_payload_section(detail, _SUMMARY_KEYS),
        "strategy": _clean_payload_section(detail, _STRATEGY_KEYS),
    }
    markdown_text = _coerce_text(markdown_content)
    if markdown_text is not None:
        payload[_MARKDOWN_KEY] = markdown_text
    return payload


def _build_translation_prompt(source_payload: Mapping[str, Any], target_lang: str) -> str:
    target_language = _LANGUAGE_DISPLAY.get(target_lang, target_lang)
    return (
        "Translate the following stock research report content into "
        f"{target_language}.\n\n"
        "Rules:\n"
        "- Translate ONLY the values; keep every JSON key exactly as provided.\n"
        "- Preserve all numbers, prices, percentages, tickers, stock codes, units and "
        "sign conventions exactly as written.\n"
        "- Preserve the Markdown structure (headings, lists, tables, bold, links) and keep "
        "markdown line breaks.\n"
        "- Keep ticker symbols and stock codes unchanged; render company names in the target "
        "language when a common name exists, otherwise keep the original name.\n"
        "- Do not add, drop, summarise or comment on any content; no translator notes.\n"
        "- Output STRICT JSON only, with exactly these keys: "
        '{"summary": {...}, "strategy": {...}, "markdown": "..."}. '
        "No code fences, no extra text.\n\n"
        f"Content to translate:\n{json.dumps(source_payload, ensure_ascii=False)}"
    )


def _strip_code_fences(text: str) -> str:
    """去掉 LLM 输出中常见的 ``` / ```json 围栏。"""
    stripped = (text or "").strip()
    if not stripped.startswith("```"):
        return stripped
    body = stripped[3:]
    first_newline = body.find("\n")
    if first_newline >= 0 and body[:first_newline].strip().lower() == "json":
        body = body[first_newline + 1 :]
    if body.rstrip().endswith("```"):
        body = body.rstrip()[:-3]
    return body.strip()


def _parse_translation_payload(text: str) -> Optional[Dict[str, Any]]:
    """防御式解析 LLM 返回的 JSON payload。"""
    if not text:
        return None
    candidate = _strip_code_fences(text)
    parsed: Any = None
    try:
        parsed = json.loads(candidate)
    except (TypeError, ValueError):
        try:
            from json_repair import repair_json

            repaired = repair_json(candidate, return_objects=True)
            parsed = repaired if isinstance(repaired, dict) else None
        except Exception as exc:  # pragma: no cover - json_repair optional
            logger.warning("报告翻译结果 JSON 解析失败: %s", exc)
            return None
    if not isinstance(parsed, Mapping):
        return None
    summary = _clean_payload_section(parsed.get("summary"), _SUMMARY_KEYS)
    strategy = _clean_payload_section(parsed.get("strategy"), _STRATEGY_KEYS)
    markdown = _coerce_text(parsed.get(_MARKDOWN_KEY))
    if not summary and not strategy and not markdown:
        return None
    payload: Dict[str, Any] = {
        "summary": summary,
        "strategy": strategy,
    }
    if markdown is not None:
        payload[_MARKDOWN_KEY] = markdown
    return payload


def _get_analyzer() -> Optional[Any]:
    """惰性获取共享的分析器实例（复用后端已配置的 LLM 生成链路）。"""
    global _analyzer
    with _ANALYZER_LOCK:
        if _analyzer is not None:
            return _analyzer
        try:
            from src.analyzer import GeminiAnalyzer

            analyzer = GeminiAnalyzer(config=get_config())
        except Exception as exc:
            logger.warning("报告翻译初始化 LLM 分析器失败: %s", exc)
            return None
        if not analyzer.is_available():
            logger.warning("报告翻译跳过：未检测到可用的 LLM 配置")
            return None
        _analyzer = analyzer
        return _analyzer


def _invoke_llm(prompt: str, source_lang_hint: str, target_lang: str, stock_code: str) -> Optional[str]:
    """通过现有生成链路调用 LLM，返回响应文本；失败返回 None。"""
    analyzer = _get_analyzer()
    if analyzer is None:
        return None
    try:
        result = analyzer._call_litellm(
            prompt,
            generation_config={
                "max_tokens": _TRANSLATION_MAX_TOKENS,
                "temperature": _TRANSLATION_TEMPERATURE,
            },
            system_prompt=(
                "You are a professional financial translator. You translate equity research and "
                "trading reports faithfully and precisely."
            ),
            response_validator=_validate_translation_json,
            audit_context={
                "call_type": _TRANSLATION_CALL_TYPE,
                "source_language": source_lang_hint,
                "target_language": target_lang,
            },
            return_generation_result=True,
        )
    except Exception as exc:
        logger.warning("报告翻译 LLM 调用失败 (%s -> %s): %s", source_lang_hint, target_lang, exc)
        return None

    if result is None or not getattr(result, "text", ""):
        logger.warning("报告翻译 LLM 返回空结果 (%s -> %s)", source_lang_hint, target_lang)
        return None

    try:
        from src.llm.usage import should_persist_usage_telemetry
        from src.storage import persist_llm_usage

        if should_persist_usage_telemetry(getattr(result, "usage", None)):
            persist_llm_usage(
                result.usage,
                result.model,
                call_type=_TRANSLATION_CALL_TYPE,
                stock_code=stock_code or None,
            )
    except Exception as exc:  # pragma: no cover - 遥测失败不影响主流程
        logger.warning("报告翻译用量记录失败: %s", exc)

    return result.text


def _validate_translation_json(text: str) -> None:
    """响应校验：非 JSON 内容触发后端既有 fallback/重试语义。"""
    if _parse_translation_payload(text) is None:
        raise ValueError("translation response is not valid JSON")


def translate_analysis_report(
    record_id: int,
    target_lang: str,
    owner_user_id: Optional[str] = None,
    include_unowned: bool = False,
    *,
    detail: Optional[Mapping[str, Any]] = None,
    db_manager: Optional[DatabaseManager] = None,
) -> Optional[Dict[str, Any]]:
    """
    翻译单条分析报告（带持久化缓存）。

    Args:
        record_id: 分析历史记录主键 ID
        target_lang: 目标语言，仅支持 'en' / 'zh'（zh = 简体中文）
        owner_user_id: 归属用户过滤（多用户模式）
        include_unowned: admin 额外可见 NULL（legacy/无主）行
        detail: 调用方已解析好的历史详情（可选；传入后不再重复查询）
        db_manager: 数据库管理器（默认取全局单例）

    Returns:
        ``{"cached": bool, "summary": {...}, "strategy": {...}, "markdown": str|None}``；
        记录不存在 / 无权访问 / 翻译失败时返回 None。
    """
    language = (target_lang or "").strip().lower()
    if language not in SUPPORTED_TARGET_LANGUAGES:
        logger.warning("报告翻译目标语言不支持: %s", target_lang)
        return None

    try:
        record_id_int = int(record_id)
    except (TypeError, ValueError):
        logger.warning("报告翻译记录 ID 非法: %s", record_id)
        return None

    db = db_manager or get_db()

    if detail is None:
        detail = HistoryService(db).resolve_and_get_detail(
            str(record_id_int),
            owner_user_id=owner_user_id,
            include_unowned=include_unowned,
        )
    if not detail or not detail.get("id"):
        return None

    cached = db.get_report_translation(record_id_int, language)
    if isinstance(cached, Mapping) and cached:
        return {
            "cached": True,
            "summary": _clean_payload_section(cached.get("summary"), _SUMMARY_KEYS),
            "strategy": _clean_payload_section(cached.get("strategy"), _STRATEGY_KEYS),
            "markdown": _coerce_text(cached.get(_MARKDOWN_KEY)),
        }

    raw_result = detail.get("raw_result")
    stored_language = ""
    if isinstance(raw_result, Mapping):
        stored_language = normalize_report_language(raw_result.get("report_language"))

    if stored_language == language:
        # 报告本身就是目标语言：直接回显原文，不产生 LLM 调用
        return {
            "cached": False,
            "summary": _clean_payload_section(detail, _SUMMARY_KEYS),
            "strategy": _clean_payload_section(detail, _STRATEGY_KEYS),
            "markdown": None,
        }

    markdown_content: Optional[str] = None
    try:
        markdown_content = HistoryService(db).get_markdown_report(
            str(record_id_int),
            owner_user_id=owner_user_id,
            include_unowned=include_unowned,
        )
    except MarkdownReportGenerationError as exc:
        logger.warning("报告翻译获取 Markdown 失败 (%s): %s", record_id_int, exc.message)
    except Exception as exc:
        logger.warning("报告翻译获取 Markdown 失败 (%s): %s", record_id_int, exc)

    source_payload = _build_source_payload(detail, markdown_content)
    if not source_payload["summary"] and not source_payload["strategy"] and not source_payload.get(_MARKDOWN_KEY):
        logger.info("报告翻译跳过：记录 %s 无可翻译内容", record_id_int)
        return None

    response_text = _invoke_llm(
        _build_translation_prompt(source_payload, language),
        source_lang_hint=stored_language or "auto",
        target_lang=language,
        stock_code=str(detail.get("storage_stock_code") or detail.get("stock_code") or ""),
    )
    translated = _parse_translation_payload(response_text or "") if response_text else None
    if translated is None:
        logger.warning("报告翻译失败：记录 %s -> %s", record_id_int, language)
        return None

    db.save_report_translation(record_id_int, language, translated)

    return {
        "cached": False,
        "summary": translated["summary"],
        "strategy": translated["strategy"],
        "markdown": translated.get(_MARKDOWN_KEY),
    }

# -*- coding: utf-8 -*-
"""报告翻译服务

职责：
1. 读取（带归属过滤的）单条分析历史记录
2. 命中缓存时直接返回已持久化的翻译结果
3. 未命中时调用现有 LLM 生成链路翻译报告并持久化（同一记录同一目标语言只付费一次）

说明：
- 目标语言仅支持 ``en`` / ``zh``；``zh`` 表示**繁体中文**（与新生成中文报告的繁体输出
  约定一致，OpenCC s2t 兜底），``en`` 表示英文。
- 翻译模型通过 ``REPORT_TRANSLATION_MODEL`` 覆盖；留空时使用主模型（默认部署即 DeepSeek）。
- 英文译文有质量重试：残留中文超过阈值时用更严格的指令重试一次，取残留更少的结果，
  单次翻译最多 2 次 LLM 调用。
- 翻译内容只覆盖报告正文（summary / strategy / markdown），记录标题、股票名称等
  数据字段保持原样，决策动作 taxonomy（decisionAction）不参与翻译。
- 任何失败都不抛异常：返回 None，由调用方回退为展示原始报告内容。
"""

from __future__ import annotations

import copy
import json
import re
import logging
import os
import threading
from typing import Any, Dict, Mapping, Optional

from src.config import get_config
from src.report_language import normalize_report_language
from src.services.history_service import HistoryService, MarkdownReportGenerationError
from src.storage import DatabaseManager, get_db
from src.utils.traditional import count_cjk_chars, to_traditional, to_traditional_tree

logger = logging.getLogger(__name__)

SUPPORTED_TARGET_LANGUAGES = ("en", "zh")

# 存储层缓存内容键
_SUMMARY_KEYS = ("analysis_summary", "operation_advice", "trend_prediction")
_STRATEGY_KEYS = ("ideal_buy", "secondary_buy", "stop_loss", "take_profit")
_MARKDOWN_KEY = "markdown"

_TRANSLATION_CALL_TYPE = "report_translation"
_TRANSLATION_MAX_TOKENS = 16384
_TRANSLATION_TEMPERATURE = 0.2

# 英文译文质量重试：全部字段残留 CJK 字符总数超过该阈值时，用更严格指令重试一次
_EN_CJK_RETRY_THRESHOLD = 20

_LANGUAGE_DISPLAY = {"en": "English", "zh": "Traditional Chinese"}


def _resolve_translation_model() -> str:
    """报告翻译专用模型覆盖；留空 = 使用主模型（默认部署为 DeepSeek）。"""
    try:
        configured = str(getattr(get_config(), "report_translation_model", "") or "").strip()
    except Exception:
        configured = ""
    if not configured:
        configured = str(os.getenv("REPORT_TRANSLATION_MODEL", "") or "").strip()
    return configured


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
    rules = [
        "Translate ONLY the values; keep every JSON key exactly as provided.",
        "Preserve all numbers, prices, percentages, tickers, stock codes, units and "
        "sign conventions exactly as written.",
        "Preserve the Markdown structure (headings, lists, tables, bold, links) and keep "
        "markdown line breaks.",
        "Keep ticker symbols and stock codes unchanged; render company names in the target "
        "language when a common name exists, otherwise keep the original name.",
        "Do not add, drop, summarise or comment on any content; no translator notes.",
    ]
    if target_lang == "en":
        rules.extend(_ENGLISH_QUALITY_RULES)
    return (
        "Translate the following stock research report content into "
        f"{target_language}.\n\n"
        "Rules:\n" + "".join(f"- {rule}\n" for rule in rules) +
        "- Output STRICT JSON only, with exactly these keys: "
        '{"summary": {...}, "strategy": {...}, "markdown": "..."}. '
        "No code fences, no extra text.\n\n"
        f"Content to translate:\n{json.dumps(source_payload, ensure_ascii=False)}"
    )


# 英文译文的金融表达硬规则：货币单位按上市地换算、交易术语用地道英文、禁止残留中文
_ENGLISH_QUALITY_RULES = (
    "Currency units MUST follow the listing market of the stock: for HK-listed stocks "
    "translate 元 as HK$ placed before the amount in natural English (for example "
    "'661.50 元' -> 'HK$661.50'); for A-share stocks translate 元 as CNY (for example "
    "'12.34 元' -> 'CNY 12.34'); if the market is unknown, prefer CNY. Never leave 元 in "
    "the output.",
    "Use standard English finance vocabulary: 仓位 -> position (sizing), 筹码 -> chip "
    "distribution / shareholding structure, 主力 -> institutional/smart money, 加仓 -> add "
    "to the position, 减仓 -> trim/reduce the position, 止损 -> stop-loss, 止盈 -> "
    "take-profit, 支撑位 -> support, 压力位 -> resistance, 均线 -> moving average (MA), "
    "成交量 -> trading volume.",
    "The English output must contain NO Chinese characters at all, except stock names or "
    "proper nouns that have no established English form. Rewrite every remaining Chinese "
    "phrase into English instead of copying it.",
)

_STRICT_ENGLISH_RETRY_INSTRUCTION = (
    "STRICT QUALITY REQUIREMENT (previous attempt was rejected): the previous translation "
    "still contained Chinese characters. Produce the English translation again and make "
    "sure the output contains ZERO Chinese characters, except unavoidable stock names or "
    "proper nouns that have no English form. Convert every 元 amount into HK$ (HK-listed) "
    "or CNY (A-share / unknown market) written in English. Use plain professional English "
    "finance vocabulary throughout; do not copy any Chinese phrase."
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


def _build_translation_config():
    """返回翻译专用的运行时配置。

    ``REPORT_TRANSLATION_MODEL`` 为空时直接复用全局配置（主模型，默认部署即 DeepSeek）；
    配置了覆盖值时，在配置副本上替换主模型，其余渠道 / fallback / key 语义保持不变，
    不影响分析主流程使用的全局配置单例。
    """
    base_config = get_config()
    override_model = _resolve_translation_model()
    if not override_model:
        return base_config
    translation_config = copy.copy(base_config)
    translation_config.litellm_model = override_model
    return translation_config


def _get_analyzer() -> Optional[Any]:
    """惰性获取共享的分析器实例（复用后端已配置的 LLM 生成链路）。"""
    global _analyzer
    with _ANALYZER_LOCK:
        if _analyzer is not None:
            return _analyzer
        try:
            from src.analyzer import GeminiAnalyzer

            analyzer = GeminiAnalyzer(config=_build_translation_config())
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


def _payload_cjk_count(payload: Mapping[str, Any]) -> int:
    """统计译文 payload 中残留的 CJK 字符总数（英文译文质量指标）。"""
    total = 0
    for section in payload.values():
        if isinstance(section, Mapping):
            for value in section.values():
                total += count_cjk_chars(value if isinstance(value, str) else None)
        else:
            total += count_cjk_chars(section if isinstance(section, str) else None)
    return total


def _payload_has_yuan(payload: Mapping[str, Any]) -> bool:
    """英文译文是否残留中文货币单位「元」。"""
    return "元" in json.dumps(payload, ensure_ascii=False)


_YUAN_PATTERN = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s*元")


def _repair_currency_units(payload: Dict[str, Any], stock_code: str) -> Dict[str, Any]:
    """确定性兜底：把英文译文残留的「N 元」按市场改写为 HK$/CNY（LLM 重试后仍残留时）。"""
    is_hk = str(stock_code or "").upper().endswith(".HK")
    replacement = lambda m: (f"HK${m.group(1)}" if is_hk else f"{m.group(1)} CNY")  # noqa: E731

    def walk(value: Any) -> Any:
        if isinstance(value, str):
            return _YUAN_PATTERN.sub(replacement, value)
        if isinstance(value, list):
            return [walk(item) for item in value]
        if isinstance(value, dict):
            return {key: walk(item) for key, item in value.items()}
        return value

    return walk(payload)


def _retry_english_translation_if_needed(
    translated: Dict[str, Any],
    *,
    source_payload: Mapping[str, Any],
    stored_language: str,
    stock_code: str,
) -> Dict[str, Any]:
    """英文译文残留中文过多时，用更严格指令重试一次；取残留更少的结果。

    有界成本：最多再调用 1 次 LLM（整个翻译流程上限 2 次）。
    """
    first_cjk = _payload_cjk_count(translated)
    # 「元」是英文译文里最高频的漏翻单位（如 220.00元），即便 CJK 总量很低也必须重试
    if first_cjk <= _EN_CJK_RETRY_THRESHOLD and not _payload_has_yuan(translated):
        return translated

    retry_prompt = (
        _build_translation_prompt(source_payload, "en")
        + "\n\n"
        + _STRICT_ENGLISH_RETRY_INSTRUCTION
    )
    retry_text = _invoke_llm(
        retry_prompt,
        source_lang_hint=stored_language or "auto",
        target_lang="en",
        stock_code=stock_code,
    )
    retry_translated = _parse_translation_payload(retry_text or "") if retry_text else None
    if retry_translated is None:
        logger.warning(
            "报告翻译英文质量重试失败，保留首次结果 (record cjk=%s)", first_cjk
        )
        return translated

    retry_cjk = _payload_cjk_count(retry_translated)
    retry_better = retry_cjk < first_cjk or (
        _payload_has_yuan(translated) and not _payload_has_yuan(retry_translated)
    )
    if retry_better:
        logger.info(
            "报告翻译英文质量重试生效：CJK %s -> %s, 元残留 %s -> %s",
            first_cjk, retry_cjk, _payload_has_yuan(translated), _payload_has_yuan(retry_translated),
        )
        return retry_translated
    logger.info("报告翻译英文质量重试未改善：CJK %s -> %s，保留首次结果", first_cjk, retry_cjk)
    return translated


def _finalize_translated_section(
    section: Dict[str, str],
    target_lang: str,
) -> Dict[str, str]:
    """按目标语言做输出定稿：zh 强制繁体，en 原样返回。"""
    if target_lang != "zh":
        return section
    return {key: to_traditional(text) for key, text in section.items()}


def _finalize_translation_payload(payload: Dict[str, Any], target_lang: str) -> Dict[str, Any]:
    """翻译结果落库前的语言定稿（zh -> 繁体；en 原样）。"""
    if target_lang != "zh":
        return payload
    return to_traditional_tree(payload)


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
        target_lang: 目标语言，仅支持 'en' / 'zh'（zh = 繁体中文）
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
        # 报告本身就是目标语言：直接回显原文，不产生 LLM 调用。
        # zh 回显同样过一次繁体转换（幂等），保证旧简体记录也按繁体契约输出。
        return {
            "cached": False,
            "summary": _finalize_translated_section(
                _clean_payload_section(detail, _SUMMARY_KEYS), language
            ),
            "strategy": _finalize_translated_section(
                _clean_payload_section(detail, _STRATEGY_KEYS), language
            ),
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

    stock_code = str(detail.get("storage_stock_code") or detail.get("stock_code") or "")
    response_text = _invoke_llm(
        _build_translation_prompt(source_payload, language),
        source_lang_hint=stored_language or "auto",
        target_lang=language,
        stock_code=stock_code,
    )
    translated = _parse_translation_payload(response_text or "") if response_text else None
    if translated is None:
        logger.warning("报告翻译失败：记录 %s -> %s", record_id_int, language)
        return None

    if language == "en":
        translated = _retry_english_translation_if_needed(
            translated,
            source_payload=source_payload,
            stored_language=stored_language,
            stock_code=stock_code,
        )
        # 确定性兜底：重试后仍残留的「N 元」按市场改写为 HK$/CNY
        translated = _repair_currency_units(translated, stock_code)

    # zh 目标语言强制繁体输出（OpenCC s2t 兜底，幂等）
    translated = _finalize_translation_payload(translated, language)

    db.save_report_translation(record_id_int, language, translated)

    return {
        "cached": False,
        "summary": translated["summary"],
        "strategy": translated["strategy"],
        "markdown": translated.get(_MARKDOWN_KEY),
    }

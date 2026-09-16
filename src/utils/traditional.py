# -*- coding: utf-8 -*-
"""报告输出繁体中文（Traditional Chinese）确定性转换工具。

背景：
- 报告生成语言（``REPORT_LANGUAGE=zh``）由 Prompt / 本地化文案控制，产出的中文报告
  长期是简体中文。产品要求所有新生成的中文报告正文以繁体中文输出。
- 为避免依赖 LLM「自觉」输出繁体（不稳定、不可回归测试），这里在分析结果定稿后做一次
  确定性的 OpenCC ``s2t`` 转换：同一输入永远得到同一输出。

设计约束：
- 惰性初始化 + 进程内缓存 converter；OpenCC 不可用或转换异常时返回原文，绝不抛异常，
  不影响分析主流程。
- 只做字符级映射（s2t），不改写数字、代码、taxonomy（ASCII 值原样返回）。
"""

from __future__ import annotations

import logging
import re
import threading
from typing import Any, Dict, List, Mapping, Optional

logger = logging.getLogger(__name__)

# s2t：简体 -> 繁体（OpenCC 标准词典，不做地区习惯转换；如需台湾用语可换 s2twp）
_OPENCC_CONFIG = "s2t"

_converter_ready = False
_converter_lock = threading.Lock()

# CJK 统一表意文字（含扩展 A / 兼容区），用于英文译文的残留中文检测
_CJK_CHAR_RE = re.compile(r"[㐀-䶿一-鿿豈-﫿]")


def _get_converter() -> Any:
    """惰性创建 OpenCC converter；不可用时返回 None 并不再重复尝试。"""
    global _converter, _converter_ready
    if _converter_ready:
        return _converter
    with _converter_lock:
        if _converter_ready:
            return _converter
        try:
            from opencc import OpenCC

            _converter = OpenCC(_OPENCC_CONFIG)
        except Exception as exc:  # pragma: no cover - 依赖缺失时的降级路径
            logger.warning("OpenCC 初始化失败，中文报告将保持原始输出: %s", exc)
            _converter = None
        _converter_ready = True
    return _converter


def reset_converter_for_tests() -> None:
    """测试辅助：清空缓存的 converter，恢复惰性初始化状态。"""
    global _converter, _converter_ready
    with _converter_lock:
        _converter = None
        _converter_ready = False


def to_traditional(text: Optional[str]) -> Optional[str]:
    """把文本转换为繁体中文；非字符串 / 空文本 / 转换失败时原样返回。

    该函数是唯一入口：报告生成定稿、翻译服务 zh 目标语言、历史数据迁移共用。
    """
    if not isinstance(text, str) or not text:
        return text
    converter = _get_converter()
    if converter is None:
        return text
    try:
        return converter.convert(text)
    except Exception as exc:  # pragma: no cover - 防御：单条转换失败不拖垮主流程
        logger.warning("繁体转换失败，返回原文: %s", exc)
        return text


def to_simplified(text: Optional[str]) -> Optional[str]:
    """繁体 -> 简体（t2s），仅用于与简体匹配表/标记做比对；失败返回原文。

    与 to_traditional 同样的防御约定：惰性初始化、绝不抛异常。
    """
    if not isinstance(text, str) or not text:
        return text
    try:
        from opencc import OpenCC

        return OpenCC("t2s").convert(text)
    except Exception as exc:  # pragma: no cover - 依赖缺失时的降级路径
        logger.warning("简体归一化失败，返回原文: %s", exc)
        return text


def to_traditional_tree(value: Any) -> Any:
    """递归转换 dict / list / 字符串结构中的所有文本（键名保持不变）。"""
    if isinstance(value, str):
        return to_traditional(value)
    if isinstance(value, Mapping):
        return {key: to_traditional_tree(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        converted: List[Any] = [to_traditional_tree(item) for item in value]
        if isinstance(value, tuple):
            return tuple(converted)
        return converted
    return value


def count_cjk_chars(text: Optional[str]) -> int:
    """统计文本中的 CJK 字符数量，用于英文译文的残留中文检测。"""
    if not isinstance(text, str) or not text:
        return 0
    return len(_CJK_CHAR_RE.findall(text))


def is_traditional_text(text: Optional[str]) -> bool:
    """判断文本是否已经是繁体（s2t 幂等：转换后无变化即视为已是繁体）。

    空文本 / 非字符串视为「无需转换」，返回 True，便于迁移脚本跳过。
    """
    if not isinstance(text, str) or not text:
        return True
    return to_traditional(text) == text


def convert_report_text_fields(
    fields: Dict[str, Any],
    keys: tuple,
) -> Dict[str, str]:
    """按给定键集合转换字典中的文本值；缺失 / 非字符串键保持原样跳过。"""
    converted: Dict[str, str] = {}
    for key in keys:
        value = fields.get(key)
        if isinstance(value, str) and value:
            converted[key] = to_traditional(value)
    return converted

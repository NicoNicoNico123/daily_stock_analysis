# -*- coding: utf-8 -*-
"""报告翻译（LLM 翻译 + 持久化缓存）服务与接口测试。

全部离线：LLM 生成链路通过 mock ``_get_analyzer`` 注入，不发真实请求。
覆盖：缓存未命中 -> 调用一次 LLM 并持久化；二次调用命中缓存；跨用户不可见；
非法目标语言；LLM 失败 -> None 且不落库；API 400 / 404 / 502 契约。
"""

import os
import json
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

from fastapi import HTTPException

import src.auth as auth
from api.v1.endpoints.history import get_history_translation
from src.analyzer import AnalysisResult
from src.config import Config, get_config
from src.storage import DatabaseManager, AnalysisHistory, ReportTranslation
from src.services.report_translation_service import (
    _parse_translation_payload,
    translate_analysis_report,
)

TRANSLATED_JSON = """{
  "summary": {
    "analysis_summary": "Fundamentals stay solid; consolidating in the short term.",
    "operation_advice": "Hold",
    "trend_prediction": "Bullish"
  },
  "strategy": {
    "ideal_buy": "Ideal entry: 125.5 CNY",
    "secondary_buy": "120-121 scale in",
    "stop_loss": "Stop below 110 CNY",
    "take_profit": "Target: 150.0 CNY"
  },
  "markdown": "# Kweichow Moutai (600519) report\\n\\nBullish with a solid base."
}"""


def _generation_result(text: str) -> SimpleNamespace:
    """构造与 GenerationResult 兼容的返回对象。"""
    return SimpleNamespace(
        text=text,
        model="test-llm-model",
        usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        backend="litellm",
        provider="litellm",
        diagnostics={},
    )


class ReportTranslationTestCase(unittest.TestCase):
    """报告翻译测试"""

    def setUp(self) -> None:
        auth._auth_enabled = False
        self._temp_dir = tempfile.TemporaryDirectory()
        self._db_path = os.path.join(self._temp_dir.name, "test_report_translation.db")
        self._env_path = os.path.join(self._temp_dir.name, ".env")
        with open(self._env_path, "w", encoding="utf-8") as env_file:
            env_file.write("STOCK_LIST=600519\n")

        self._original_env = {
            key: os.environ.get(key) for key in ("ENV_FILE", "DATABASE_PATH")
        }
        os.environ["ENV_FILE"] = self._env_path
        os.environ["DATABASE_PATH"] = self._db_path

        Config._instance = None
        DatabaseManager.reset_instance()
        self.db = DatabaseManager.get_instance()

        import src.services.report_translation_service as svc

        self._svc = svc

    def tearDown(self) -> None:
        DatabaseManager.reset_instance()
        Config._instance = None
        for key, value in self._original_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self._temp_dir.cleanup()

    def _save_history(
        self,
        query_id: str = "query_translation",
        owner_user_id: str = "",
        report_language: str = "zh",
    ) -> int:
        result = AnalysisResult(
            code="600519",
            name="贵州茅台",
            sentiment_score=78,
            trend_prediction="看多",
            operation_advice="持有",
            analysis_summary="基本面稳健，短期震荡",
        )
        result.report_language = report_language
        result.dashboard = {
            "battle_plan": {
                "sniper_points": {
                    "ideal_buy": "理想买入点：125.5元",
                    "secondary_buy": "120",
                    "stop_loss": "止损位：110元",
                    "take_profit": "目标位：150.0元",
                }
            }
        }
        kwargs = {"owner_user_id": owner_user_id} if owner_user_id else {}
        saved = self.db.save_analysis_history(
            result=result,
            query_id=query_id,
            report_type="simple",
            news_content="新闻摘要",
            context_snapshot=None,
            save_snapshot=False,
            **kwargs,
        )
        self.assertGreater(saved, 0)
        return saved

    def _patch_llm(self, text: str = TRANSLATED_JSON, side_effect: Exception = None) -> MagicMock:
        analyzer = MagicMock()
        if side_effect is not None:
            analyzer._call_litellm.side_effect = side_effect
        else:
            analyzer._call_litellm.return_value = _generation_result(text)
        analyzer.is_available.return_value = True
        patcher = patch.object(self._svc, "_get_analyzer", return_value=analyzer)
        patcher.start()
        self.addCleanup(patcher.stop)
        return analyzer

    def test_translate_then_serve_from_cache(self) -> None:
        """首次翻译调用一次 LLM 并持久化；再次请求命中缓存且不再调用 LLM。"""
        record_id = self._save_history()
        analyzer = self._patch_llm()

        first = translate_analysis_report(record_id, "en", db_manager=self.db)
        self.assertIsNotNone(first)
        self.assertFalse(first["cached"])
        self.assertEqual(
            first["summary"]["analysis_summary"],
            "Fundamentals stay solid; consolidating in the short term.",
        )
        self.assertEqual(first["summary"]["trend_prediction"], "Bullish")
        self.assertEqual(first["strategy"]["ideal_buy"], "Ideal entry: 125.5 CNY")
        self.assertIn("Kweichow Moutai", first["markdown"])
        self.assertEqual(analyzer._call_litellm.call_count, 1)

        self.assertIsNotNone(
            self.db.get_report_translation(record_id, "en"),
            "翻译结果必须持久化",
        )

        second = translate_analysis_report(record_id, "en", db_manager=self.db)
        self.assertIsNotNone(second)
        self.assertTrue(second["cached"])
        self.assertEqual(second["summary"], first["summary"])
        self.assertEqual(second["strategy"], first["strategy"])
        self.assertEqual(analyzer._call_litellm.call_count, 1, "缓存命中时不得再次调用 LLM")

    def test_translation_per_target_language(self) -> None:
        """不同目标语言各自缓存；目标语言与报告语言相同时不调用 LLM。"""
        record_id = self._save_history()  # 报告语言 = zh
        analyzer = self._patch_llm()

        zh = translate_analysis_report(record_id, "zh", db_manager=self.db)
        self.assertIsNotNone(zh)
        self.assertFalse(zh["cached"])
        # zh 目标语言契约 = 繁体中文（回显路径同样做 s2t 定稿）
        self.assertEqual(zh["summary"]["analysis_summary"], "基本面穩健，短期震盪")
        self.assertEqual(analyzer._call_litellm.call_count, 0, "同语言回显不调用 LLM")

        en = translate_analysis_report(record_id, "en", db_manager=self.db)
        self.assertIsNotNone(en)
        self.assertEqual(analyzer._call_litellm.call_count, 1)
        self.assertEqual(en["summary"]["analysis_summary"], "Fundamentals stay solid; consolidating in the short term.")

        # 各目标语言缓存互不影响
        zh_again = translate_analysis_report(record_id, "zh", db_manager=self.db)
        self.assertIsNotNone(zh_again)
        self.assertEqual(zh_again["summary"]["analysis_summary"], "基本面穩健，短期震盪")
        self.assertEqual(analyzer._call_litellm.call_count, 1)

    def test_zh_target_outputs_traditional(self) -> None:
        """zh 译文（LLM 返回简体时）落库与返回均为繁体，且 s2t 幂等。"""
        simplified_llm_json = """{
          "summary": {
            "analysis_summary": "基本面稳健，短期震荡，筹码集中。",
            "operation_advice": "持有",
            "trend_prediction": "看多"
          },
          "strategy": {
            "ideal_buy": "理想买点：125.5 元",
            "secondary_buy": "120-121 加仓",
            "stop_loss": "止损：110 元",
            "take_profit": "目标：150.0 元"
          }
        }"""
        record_id = self._save_history(report_language="en")
        analyzer = self._patch_llm(text=simplified_llm_json)

        payload = translate_analysis_report(record_id, "zh", db_manager=self.db)

        self.assertIsNotNone(payload)
        self.assertEqual(payload["summary"]["analysis_summary"], "基本面穩健，短期震盪，籌碼集中。")
        self.assertEqual(payload["strategy"]["ideal_buy"], "理想買點：125.5 元")
        self.assertEqual(analyzer._call_litellm.call_count, 1)

        cached = self.db.get_report_translation(record_id, "zh")
        self.assertIsNotNone(cached)
        self.assertEqual(cached["summary"]["analysis_summary"], "基本面穩健，短期震盪，籌碼集中。")

        from src.utils.traditional import to_traditional

        self.assertEqual(
            to_traditional(payload["summary"]["analysis_summary"]),
            payload["summary"]["analysis_summary"],
            "zh 译文必须已经是繁体（s2t 幂等）",
        )

    def test_same_language_report_skips_llm(self) -> None:
        """报告本身就是目标语言时直接回显原文，不调用 LLM。"""
        record_id = self._save_history(report_language="en")
        analyzer = self._patch_llm()

        payload = translate_analysis_report(record_id, "en", db_manager=self.db)

        self.assertIsNotNone(payload)
        self.assertFalse(payload["cached"])
        self.assertEqual(payload["summary"]["analysis_summary"], "基本面稳健，短期震荡")
        self.assertEqual(analyzer._call_litellm.call_count, 0)
        self.assertIsNone(self.db.get_report_translation(record_id, "en"))

    def test_service_resolves_record_and_translates_markdown_itself(self) -> None:
        """不传 detail 时由服务自行解析记录，且 Markdown 一并翻译（回归：函数内局部导入遮蔽）。"""
        record_id = self._save_history()
        analyzer = self._patch_llm()

        payload = translate_analysis_report(record_id, "en", db_manager=self.db)

        self.assertIsNotNone(payload)
        self.assertFalse(payload["cached"])
        self.assertEqual(payload["summary"]["analysis_summary"], "Fundamentals stay solid; consolidating in the short term.")
        self.assertIn("Kweichow Moutai", payload["markdown"])
        self.assertEqual(analyzer._call_litellm.call_count, 1)
        # Markdown 进入了待翻译 payload
        prompt = analyzer._call_litellm.call_args.args[0]
        self.assertIn("markdown", prompt)
        self.assertIn("理想买入点", prompt)

    def test_record_not_found_returns_none(self) -> None:
        analyzer = self._patch_llm()
        self.assertIsNone(translate_analysis_report(999999, "en", db_manager=self.db))
        self.assertEqual(analyzer._call_litellm.call_count, 0)

    def test_cross_user_record_is_invisible(self) -> None:
        """多用户模式下其他用户的记录不可翻译（返回 None）。"""
        record_id = self._save_history(owner_user_id="user-a")
        analyzer = self._patch_llm()

        payload = translate_analysis_report(
            record_id,
            "en",
            owner_user_id="user-b",
            include_unowned=False,
            db_manager=self.db,
        )
        self.assertIsNone(payload)
        self.assertEqual(analyzer._call_litellm.call_count, 0)

        owner_payload = translate_analysis_report(
            record_id,
            "en",
            owner_user_id="user-a",
            include_unowned=False,
            db_manager=self.db,
        )
        self.assertIsNotNone(owner_payload)

    def test_invalid_target_language_returns_none(self) -> None:
        record_id = self._save_history()
        analyzer = self._patch_llm()
        self.assertIsNone(translate_analysis_report(record_id, "fr", db_manager=self.db))
        self.assertEqual(analyzer._call_litellm.call_count, 0)

    def test_llm_failure_returns_none_and_persists_nothing(self) -> None:
        """LLM 失败返回 None，且不写入缓存。"""
        record_id = self._save_history()
        analyzer = self._patch_llm(side_effect=RuntimeError("llm unavailable"))

        payload = translate_analysis_report(record_id, "en", db_manager=self.db)

        self.assertIsNone(payload)
        self.assertIsNone(self.db.get_report_translation(record_id, "en"))
        self.assertEqual(analyzer._call_litellm.call_count, 1)

    def test_invalid_llm_json_is_not_persisted(self) -> None:
        """LLM 返回非 JSON 内容时不落库。"""
        record_id = self._save_history()
        analyzer = self._patch_llm(text="Sorry, I cannot translate that.")

        payload = translate_analysis_report(record_id, "en", db_manager=self.db)

        self.assertIsNone(payload)
        self.assertIsNone(self.db.get_report_translation(record_id, "en"))
        self.assertEqual(analyzer._call_litellm.call_count, 1)

    # ---------------- API 层 ----------------

    def test_translation_api_contract(self) -> None:
        """GET /api/v1/history/{id}/translation 契约：200 / 400 / 404 / 502。"""
        record_id = self._save_history()
        self._patch_llm()

        response = get_history_translation(record_id, lang="en", db_manager=self.db)
        self.assertFalse(response.cached)
        self.assertEqual(response.target_lang, "en")
        self.assertEqual(response.summary["analysis_summary"], "Fundamentals stay solid; consolidating in the short term.")
        self.assertEqual(response.strategy["stop_loss"], "Stop below 110 CNY")

        # 二次请求：命中缓存
        cached_response = get_history_translation(record_id, lang="en", db_manager=self.db)
        self.assertTrue(cached_response.cached)

        with self.assertRaises(HTTPException) as ctx:
            get_history_translation(record_id, lang="fr", db_manager=self.db)
        self.assertEqual(ctx.exception.status_code, 400)

        with self.assertRaises(HTTPException) as ctx:
            get_history_translation(999999, lang="en", db_manager=self.db)
        self.assertEqual(ctx.exception.status_code, 404)

        with patch("api.v1.endpoints.history.translate_analysis_report", return_value=None):
            with self.assertRaises(HTTPException) as ctx:
                get_history_translation(record_id, lang="en", db_manager=self.db)
        self.assertEqual(ctx.exception.status_code, 502)

    def test_translation_api_cross_user_404(self) -> None:
        """多用户模式下其他用户访问他人记录翻译返回 404。"""
        record_id = self._save_history(owner_user_id="user-a")
        self._patch_llm()

        with patch("api.deps.is_multi_user_enabled", return_value=True):
            with self.assertRaises(HTTPException) as ctx:
                get_history_translation(
                    record_id,
                    lang="en",
                    db_manager=self.db,
                    current_user={"id": "user-b", "role": "user"},
                )
        self.assertEqual(ctx.exception.status_code, 404)

        # 记录归属用户自己可以正常翻译
        admin_response = get_history_translation(
            record_id,
            lang="en",
            db_manager=self.db,
            current_user={"id": "user-a", "role": "user"},
        )
        self.assertEqual(admin_response.target_lang, "en")


class ParseTranslationPayloadTestCase(unittest.TestCase):
    """翻译响应解析测试"""

    def test_parses_code_fenced_json(self) -> None:
        text = "```json\n" + TRANSLATED_JSON + "\n```"
        payload = _parse_translation_payload(text)
        self.assertIsNotNone(payload)
        self.assertEqual(payload["summary"]["operation_advice"], "Hold")
        self.assertEqual(payload["strategy"]["ideal_buy"], "Ideal entry: 125.5 CNY")
        self.assertIn("Bullish with a solid base", payload["markdown"])


class EnglishQualityRetryTestCase(unittest.TestCase):
    """英文译文质量规则与重试逻辑测试"""

    def _svc(self):
        import src.services.report_translation_service as svc

        return svc

    def test_english_prompt_contains_financial_unit_rules(self) -> None:
        """英文 prompt 必须带货币单位（HK$/CNY）与禁写中文的硬规则。"""
        svc = self._svc()
        prompt = svc._build_translation_prompt({"summary": {"analysis_summary": "元"}}, "en")
        self.assertIn("HK$", prompt)
        self.assertIn("CNY", prompt)
        self.assertIn("元", prompt, "货币规则必须显式说明 元 的译法")
        self.assertIn("NO Chinese characters", prompt)
        self.assertIn("position", prompt)

        zh_prompt = svc._build_translation_prompt({"summary": {"analysis_summary": "元"}}, "zh")
        self.assertNotIn("HK$", zh_prompt)

    def test_retry_triggered_and_better_attempt_used(self) -> None:
        """首次译文残留中文超阈值 -> 重试一次；取残留更少的结果。"""
        svc = self._svc()
        high_cjk = {
            "summary": {"analysis_summary": "基本面稳健，短期震荡，筹码集中，主力资金流出，支撑位失效，等待确认。"},
            "strategy": {},
        }
        low_cjk = {
            "summary": {"analysis_summary": "Fundamentals stay solid; chip distribution is concentrated."},
            "strategy": {},
        }
        self.assertGreater(svc._payload_cjk_count(high_cjk), svc._EN_CJK_RETRY_THRESHOLD)
        self.assertLess(svc._payload_cjk_count(low_cjk), svc._EN_CJK_RETRY_THRESHOLD)

        calls = []

        def _fake_invoke(prompt, source_lang_hint, target_lang, stock_code):
            calls.append(prompt)
            # 重试请求必须携带更严格的英文质量指令
            self.assertIn("STRICT QUALITY REQUIREMENT", prompt)
            self.assertIn("HK$", prompt)
            return json.dumps(low_cjk, ensure_ascii=False)

        with patch.object(svc, "_invoke_llm", side_effect=_fake_invoke):
            result = svc._retry_english_translation_if_needed(
                high_cjk,
                source_payload={"summary": {"analysis_summary": "基本面稳健"}},
                stored_language="zh",
                stock_code="600519",
            )

        self.assertEqual(result, low_cjk, "必须采用残留中文更少的第二次结果")
        self.assertEqual(len(calls), 1, "重试只额外调用一次 LLM")

    def test_retry_triggered_by_yuan_even_below_cjk_threshold(self) -> None:
        """英文译文残留「元」即便 CJK 总量很低也必须重试（用户实测 220.00元 场景）。"""
        svc = self._svc()
        low_cjk_with_yuan = {
            "summary": {"analysis_summary": "Zhipu closed at 680.0元, down 5.69%."},
            "strategy": {},
        }
        fixed = {
            "summary": {"analysis_summary": "Zhipu closed at HK$680.0, down 5.69%."},
            "strategy": {},
        }
        with patch.object(svc, "_invoke_llm", return_value=json.dumps(fixed, ensure_ascii=False)) as invoke_mock:
            result = svc._retry_english_translation_if_needed(
                low_cjk_with_yuan,
                source_payload={"summary": {"analysis_summary": "智谱收报680.0元。"}},
                stored_language="zh",
                stock_code="02513.HK",
            )
        invoke_mock.assert_called_once()
        self.assertEqual(result, fixed)

    def test_retry_skipped_when_clean_even_below_cjk_threshold(self) -> None:
        """无「元」残留且 CJK 低于阈值时不重试。"""
        svc = self._svc()
        clean = {
            "summary": {"analysis_summary": "Zhipu closed at HK$680.0, down 5.69%."},
            "strategy": {},
        }
        with patch.object(svc, "_invoke_llm") as invoke_mock:
            result = svc._retry_english_translation_if_needed(
                clean,
                source_payload={"summary": {"analysis_summary": "智谱收报680.0港元。"}},
                stored_language="zh",
                stock_code="02513.HK",
            )
        self.assertEqual(result, clean)
        invoke_mock.assert_not_called()

    def test_repair_currency_units_by_market(self) -> None:
        """确定性兜底：残留「N 元」按股票市场改写为 HK$/CNY。"""
        svc = self._svc()
        payload = {
            "summary": {"analysis_summary": "closed at 680.0元, low 670.00 元."},
            "strategy": {"ideal_buy": "scale in at 1,720.50元"},
        }
        hk = svc._repair_currency_units(json.loads(json.dumps(payload)), "02513.HK")
        self.assertEqual(hk["summary"]["analysis_summary"], "closed at HK$680.0, low HK$670.00.")
        self.assertEqual(hk["strategy"]["ideal_buy"], "scale in at HK$1,720.50")
        cn = svc._repair_currency_units(json.loads(json.dumps(payload)), "600519")
        self.assertEqual(cn["summary"]["analysis_summary"], "closed at 680.0 CNY, low 670.00 CNY.")

    def test_retry_skipped_when_below_threshold(self) -> None:
        """首次译文残留中文低于阈值时不重试（控制成本）。"""
        svc = self._svc()
        clean = {
            "summary": {"analysis_summary": "Fundamentals stay solid."},
            "strategy": {},
        }
        with patch.object(svc, "_invoke_llm") as invoke_mock:
            result = svc._retry_english_translation_if_needed(
                clean,
                source_payload={"summary": {"analysis_summary": "基本面稳健"}},
                stored_language="zh",
                stock_code="600519",
            )
        self.assertEqual(result, clean)
        invoke_mock.assert_not_called()

    def test_retry_keeps_first_when_retry_not_better(self) -> None:
        """重试结果残留更多时保留首次结果。"""
        svc = self._svc()
        high_cjk = {
            "summary": {"analysis_summary": "基本面稳健，短期震荡，筹码集中，主力资金流出，支撑位失效，等待确认。"},
            "strategy": {},
        }
        worse = {
            "summary": {"analysis_summary": "基本面稳健，短期震荡，筹码集中，主力资金流出，支撑位失效，等待确认，止损。"},
            "strategy": {},
        }
        with patch.object(svc, "_invoke_llm", return_value=json.dumps(worse, ensure_ascii=False)):
            with patch.object(svc, "_parse_translation_payload", return_value=worse):
                result = svc._retry_english_translation_if_needed(
                    high_cjk,
                    source_payload={"summary": {"analysis_summary": "基本面稳健"}},
                    stored_language="zh",
                    stock_code="600519",
                )
        self.assertEqual(result, high_cjk)

    def test_translation_model_override_uses_report_translation_model(self) -> None:
        """REPORT_TRANSLATION_MODEL 配置时，翻译分析器使用该模型且不影响全局配置。"""
        svc = self._svc()
        base_config = get_config()
        original_model = base_config.litellm_model
        try:
            base_config.report_translation_model = "openai/deepseek-chat"
            translation_config = svc._build_translation_config()
            self.assertEqual(translation_config.litellm_model, "openai/deepseek-chat")
            self.assertIsNot(translation_config, base_config)
            self.assertEqual(base_config.litellm_model, original_model, "不得污染全局配置单例")
        finally:
            base_config.report_translation_model = ""

        self.assertIs(svc._build_translation_config(), get_config(), "留空时直接复用主配置")

    def test_rejects_non_json_and_empty_payloads(self) -> None:
        self.assertIsNone(_parse_translation_payload(""))
        self.assertIsNone(_parse_translation_payload("not json at all"))
        self.assertIsNone(_parse_translation_payload('{"summary": {}, "strategy": {}}'))


class ReportTranslationStorageTestCase(unittest.TestCase):
    """翻译缓存存储层测试"""

    def setUp(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        self._db_path = os.path.join(self._temp_dir.name, "test_translation_cache.db")
        self._env_path = os.path.join(self._temp_dir.name, ".env")
        with open(self._env_path, "w", encoding="utf-8") as env_file:
            env_file.write("STOCK_LIST=600519\n")
        self._original_env = {
            key: os.environ.get(key) for key in ("ENV_FILE", "DATABASE_PATH")
        }
        os.environ["ENV_FILE"] = self._env_path
        os.environ["DATABASE_PATH"] = self._db_path
        Config._instance = None
        DatabaseManager.reset_instance()
        self.db = DatabaseManager.get_instance()

    def tearDown(self) -> None:
        DatabaseManager.reset_instance()
        Config._instance = None
        for key, value in self._original_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self._temp_dir.cleanup()

    def test_cache_roundtrip_and_upsert(self) -> None:
        self.assertIsNone(self.db.get_report_translation(1, "en"))
        self.assertTrue(self.db.save_report_translation(1, "en", {"summary": {"analysis_summary": "v1"}}))
        self.assertEqual(
            self.db.get_report_translation(1, "en")["summary"]["analysis_summary"],
            "v1",
        )
        self.assertTrue(self.db.save_report_translation(1, "en", {"summary": {"analysis_summary": "v2"}}))
        self.assertEqual(
            self.db.get_report_translation(1, "en")["summary"]["analysis_summary"],
            "v2",
        )
        self.assertIsNone(self.db.get_report_translation(1, "zh"), "其他语言互不影响")

    def test_corrupted_cache_payload_returns_none(self) -> None:
        with self.db.get_session() as session:
            session.add(
                ReportTranslation(
                    analysis_history_id=2,
                    target_lang="en",
                    content_json="{not-json",
                )
            )
            session.commit()
        self.assertIsNone(self.db.get_report_translation(2, "en"))

    def test_cache_cleared_with_history_records(self) -> None:
        history_id = self._save_min_history()
        self.assertTrue(self.db.save_report_translation(history_id, "en", {"summary": {}}))
        deleted = self.db.delete_analysis_history_records([history_id])
        self.assertEqual(deleted, 1)
        self.assertIsNone(self.db.get_report_translation(history_id, "en"))

    def _save_min_history(self) -> int:
        result = AnalysisResult(
            code="600519",
            name="贵州茅台",
            sentiment_score=50,
            trend_prediction="震荡",
            operation_advice="观望",
            analysis_summary="测试",
        )
        saved = self.db.save_analysis_history(
            result=result,
            query_id="query_cache_cleanup",
            report_type="simple",
            news_content=None,
            context_snapshot=None,
            save_snapshot=False,
        )
        self.assertGreater(saved, 0)
        with self.db.get_session() as session:
            row = session.query(AnalysisHistory).filter(AnalysisHistory.id == saved).first()
            self.assertIsNotNone(row)
        return saved


if __name__ == "__main__":
    unittest.main()

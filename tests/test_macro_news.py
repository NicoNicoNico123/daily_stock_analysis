# -*- coding: utf-8 -*-
"""宏观市场动态（MACRO news）共享快照 + 多点影响分析单元测试（离线，mock 渠道层）。"""

import sys
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

# Mock newspaper before search_service import (optional dependency)
if "newspaper" not in sys.modules:
    mock_np = MagicMock()
    mock_np.Article = MagicMock()
    mock_np.Config = MagicMock()
    sys.modules["newspaper"] = mock_np

try:
    import litellm  # noqa: F401
except ModuleNotFoundError:
    from tests.litellm_stub import ensure_litellm_stub

    ensure_litellm_stub()

from src.search_service import (
    MACRO_NEWS_ITEM_PREFIX,
    MACRO_NEWS_QUERIES,
    MACRO_NEWS_RESULT_CATEGORY,
    MACRO_NEWS_SECTION_TITLE,
    MACRO_NEWS_SNAPSHOT_RETENTION_DAYS,
    SearchResponse,
    SearchResult,
    SearchService,
    format_macro_news_section,
    macro_snapshot_date_utc,
    macro_snapshot_payload_from_response,
)


def _macro_response(titles=("宏观头条A", "宏观头条B"), provider="Mock", query="宏观查询"):
    """构造一条带两条宏观头条的成功响应。"""
    return SearchResponse(
        query=query,
        results=[
            SearchResult(
                title=title,
                snippet=f"{title}摘要",
                url=f"https://example.com/macro/{title}",
                source="example.com",
                published_date="2026-09-17",
            )
            for title in titles
        ],
        provider=provider,
        success=True,
    )


class _FakeStore:
    """内存版宏观快照存储（对齐 DatabaseManager 的三个宏观快照方法签名）。"""

    def __init__(self):
        self.snapshots = {}
        self.upsert_calls = []
        self.purge_calls = []

    def get_macro_news_snapshot(self, market, snapshot_date):
        snapshot = self.snapshots.get((market, snapshot_date))
        if snapshot is None:
            return None
        return dict(snapshot)

    def upsert_macro_news_snapshot(self, market, snapshot_date, content, provider=""):
        self.snapshots[(market, snapshot_date)] = {
            "market": market,
            "snapshot_date": snapshot_date,
            "fetched_at": None,
            "source_provider": provider,
            "content": content,
        }
        self.upsert_calls.append((market, snapshot_date, provider))
        return True

    def purge_old_macro_news_snapshots(self, keep_days=7):
        self.purge_calls.append(keep_days)
        return 0

    def backdate(self, market, hours):
        """把指定市场当日快照的抓取时间回拨，模拟 TTL 过期。"""
        snapshot = self.snapshots[(market, macro_snapshot_date_utc())]
        stale_at = datetime.now(timezone.utc) - timedelta(hours=hours)
        snapshot["content"]["fetched_at"] = stale_at.isoformat()


class MacroNewsSearchTestCase(unittest.TestCase):
    """search_macro_news 的查询、共享快照与回退语义。"""

    def _service(self, *, refresh_hours=6, store=None):
        return SearchService(
            bocha_keys=["dummy_key"],
            searxng_public_instances_enabled=False,
            macro_refresh_hours=refresh_hours,
            macro_snapshot_store=store if store is not None else _FakeStore(),
        )

    def _install_topic_stub(self, service, responses_by_topic=None, default=None):
        calls = []

        def _fake(topic, max_results=5, focus_keywords=None):
            calls.append(
                {
                    "topic": topic,
                    "max_results": max_results,
                    "focus_keywords": list(focus_keywords or []),
                }
            )
            if responses_by_topic and topic in responses_by_topic:
                return responses_by_topic[topic]
            return default() if callable(default) else default

        service.search_topic_news = _fake
        return calls

    def test_per_market_queries_routed_through_topic_channel(self) -> None:
        for market, expected_queries in MACRO_NEWS_QUERIES.items():
            with self.subTest(market=market):
                service = self._service()
                calls = self._install_topic_stub(
                    service,
                    responses_by_topic={q: _macro_response() for q in expected_queries},
                )
                response = service.search_macro_news(market, max_results=4)

                self.assertTrue(response.success)
                self.assertEqual([c["topic"] for c in calls], list(expected_queries))
                # focus_keywords 直接作为查询串，避免 topic 路径追加个股向后缀
                for call in calls:
                    self.assertEqual(call["focus_keywords"], [call["topic"]])
                self.assertTrue(response.results)
                for item in response.results:
                    self.assertEqual(item.category, MACRO_NEWS_RESULT_CATEGORY)
                self.assertLessEqual(len(response.results), 4)

    def test_unknown_market_returns_empty_without_channel_call(self) -> None:
        service = self._service()
        calls = self._install_topic_stub(service, default=_macro_response())

        response = service.search_macro_news("jp")

        self.assertFalse(response.success)
        self.assertEqual(response.results, [])
        self.assertIn("未配置宏观新闻查询", response.error_message)
        self.assertEqual(calls, [])

    def test_no_search_channel_returns_empty_without_snapshot_access(self) -> None:
        store = _FakeStore()
        service = SearchService(
            bocha_keys=[],
            searxng_public_instances_enabled=False,
            macro_snapshot_store=store,
        )
        self.assertFalse(service.is_available)

        response = service.search_macro_news("hk")

        self.assertFalse(response.success)
        self.assertIn("未配置搜索能力", response.error_message)
        self.assertEqual(store.upsert_calls, [])

    def test_shared_snapshot_two_calls_fetch_once(self) -> None:
        store = _FakeStore()
        service = self._service(store=store)
        calls = self._install_topic_stub(service, default=_macro_response())

        first = service.search_macro_news("hk")
        second = service.search_macro_news("hk")

        # 两条内置查询各调用一次渠道；第二次命中持久化共享快照，零渠道调用
        self.assertEqual(len(calls), 2)
        self.assertEqual([i.title for i in first.results], [i.title for i in second.results])
        self.assertFalse(second.stale)
        self.assertEqual(
            store.upsert_calls,
            [("hk", macro_snapshot_date_utc(), first.provider)],
        )

    def test_cross_market_snapshots_do_not_share(self) -> None:
        store = _FakeStore()
        service = self._service(store=store)
        hk_response = _macro_response(titles=("港股宏观",), query="hk query")
        us_response = _macro_response(titles=("美股宏观",), query="us query")
        calls = self._install_topic_stub(
            service,
            responses_by_topic={
                "港股市场 今日走势": hk_response,
                "美联储加息 港股 影响": hk_response,
                "美联储利率决议 最新动态": us_response,
                "美股市场 今日走势 原因": us_response,
            },
        )

        hk = service.search_macro_news("hk")
        us = service.search_macro_news("us")

        # 不同市场互不共享：各自各抓一次（每市场 2 条查询）
        self.assertEqual(len(calls), 4)
        self.assertEqual([i.title for i in hk.results], ["港股宏观"])
        self.assertEqual([i.title for i in us.results], ["美股宏观"])
        self.assertIn(("hk", macro_snapshot_date_utc(), "Mock"), store.upsert_calls)
        self.assertIn(("us", macro_snapshot_date_utc(), "Mock"), store.upsert_calls)

    def test_ttl_expiry_triggers_refetch(self) -> None:
        store = _FakeStore()
        service = self._service(refresh_hours=6, store=store)
        calls = self._install_topic_stub(service, default=_macro_response())

        service.search_macro_news("cn")
        self.assertEqual(len(calls), 2)

        store.backdate("cn", hours=10)
        refreshed = service.search_macro_news("cn")

        self.assertEqual(len(calls), 4)
        self.assertTrue(refreshed.success)
        self.assertFalse(refreshed.stale)

    def test_refresh_hours_zero_means_once_per_day(self) -> None:
        store = _FakeStore()
        service = self._service(refresh_hours=0, store=store)
        calls = self._install_topic_stub(service, default=_macro_response())

        service.search_macro_news("hk")
        store.backdate("hk", hours=1)
        service.search_macro_news("hk")

        self.assertEqual(len(calls), 2)

    def test_fetch_failure_falls_back_to_stale_snapshot(self) -> None:
        store = _FakeStore()
        service = self._service(refresh_hours=6, store=store)
        self._install_topic_stub(service, default=_macro_response())

        service.search_macro_news("hk")
        store.backdate("hk", hours=9)

        def _boom(*args, **kwargs):
            raise RuntimeError("channel down")

        service.search_topic_news = _boom
        fallback = service.search_macro_news("hk")

        self.assertTrue(fallback.success)
        self.assertTrue(fallback.stale)
        self.assertEqual([i.title for i in fallback.results], ["宏观头条A", "宏观头条B"])
        for item in fallback.results:
            self.assertEqual(item.category, MACRO_NEWS_RESULT_CATEGORY)

    def test_failure_without_snapshot_returns_empty(self) -> None:
        service = self._service()

        def _empty(*args, **kwargs):
            return SearchResponse(
                query="宏观查询",
                results=[],
                provider="Mock",
                success=True,
                error_message="宏观新闻过滤后无有效结果",
            )

        service.search_topic_news = _empty
        response = service.search_macro_news("us")

        self.assertEqual(response.results, [])
        self.assertIn("无有效结果", response.error_message)

    def test_purge_uses_snapshot_retention_days(self) -> None:
        store = _FakeStore()
        service = self._service(store=store)
        self._install_topic_stub(service, default=_macro_response())

        service.search_macro_news("cn")

        self.assertEqual(store.purge_calls, [MACRO_NEWS_SNAPSHOT_RETENTION_DAYS])

    def test_format_macro_section_marks_items_as_macro(self) -> None:
        section = format_macro_news_section(_macro_response())

        self.assertIn(MACRO_NEWS_SECTION_TITLE, section)
        self.assertIn("【宏观】【example.com】宏观头条A", section)
        self.assertIn("【宏观】【example.com】宏观头条B", section)
        self.assertIn("摘要：宏观头条A摘要", section)
        # 两条条目各自带【宏观】前缀（导语中的说明文字不计）
        self.assertEqual(section.count(MACRO_NEWS_ITEM_PREFIX + "【example.com】"), 2)

        self.assertIsNone(format_macro_news_section(None))
        self.assertIsNone(
            format_macro_news_section(
                SearchResponse(query="q", results=[], provider="Mock", success=False)
            )
        )

    def test_snapshot_payload_round_trip_keeps_macro_category(self) -> None:
        payload = macro_snapshot_payload_from_response(_macro_response())
        self.assertTrue(payload["results"])

        rebuilt = SearchResponse(
            query=payload["query"],
            results=[
                SearchResult(
                    title=item["title"],
                    snippet=item["snippet"],
                    url=item["url"],
                    source=item["source"],
                    published_date=item["published_date"],
                    category=item["category"],
                )
                for item in payload["results"]
            ],
            provider=payload["provider"],
            success=True,
        )
        section = format_macro_news_section(rebuilt)

        self.assertIn("【宏观】", section)
        self.assertEqual(
            {item["category"] for item in payload["results"]},
            {MACRO_NEWS_RESULT_CATEGORY},
        )

    def test_reset_macro_cache_for_tests_clears_inflight_locks(self) -> None:
        service = self._service()
        service._macro_inflight_lock("hk")
        self.assertIn("hk", service._macro_inflight)

        service.reset_macro_cache_for_tests()

        self.assertEqual(service._macro_inflight, {})


class _StubSearchService:
    """仅暴露 is_available / search_macro_news 的桩服务。"""

    def __init__(self, response=None, error=None, is_available=True):
        self.is_available = is_available
        self._response = response
        self._error = error
        self.calls = []

    def search_macro_news(self, market, max_results=5):
        self.calls.append({"market": market, "max_results": max_results})
        if self._error is not None:
            raise self._error
        return self._response


class MacroNewsPipelineGateTestCase(unittest.TestCase):
    """pipeline 侧功能开关：MACRO_NEWS_ENABLED=false / 无渠道时零行为变化。"""

    def _pipeline(self, search_service, config):
        from src.core.pipeline import StockAnalysisPipeline

        pipeline = StockAnalysisPipeline.__new__(StockAnalysisPipeline)
        pipeline.search_service = search_service
        pipeline.config = config
        return pipeline

    def test_disabled_flag_skips_macro_search(self) -> None:
        stub = _StubSearchService(response=_macro_response())
        pipeline = self._pipeline(
            stub,
            SimpleNamespace(macro_news_enabled=False, macro_news_max_results=5),
        )

        section, count = pipeline._build_macro_news_section(code="00700", market="hk")

        self.assertIsNone(section)
        self.assertEqual(count, 0)
        self.assertEqual(stub.calls, [])

    def test_missing_search_service_skips_macro_search(self) -> None:
        pipeline = self._pipeline(
            None,
            SimpleNamespace(macro_news_enabled=True, macro_news_max_results=5),
        )

        section, count = pipeline._build_macro_news_section(code="600519", market="cn")

        self.assertIsNone(section)
        self.assertEqual(count, 0)

    def test_unavailable_search_service_skips_macro_search(self) -> None:
        stub = _StubSearchService(response=_macro_response(), is_available=False)
        pipeline = self._pipeline(
            stub,
            SimpleNamespace(macro_news_enabled=True, macro_news_max_results=5),
        )

        section, count = pipeline._build_macro_news_section(code="AAPL", market="us")

        self.assertIsNone(section)
        self.assertEqual(count, 0)
        self.assertEqual(stub.calls, [])

    def test_enabled_pipeline_formats_macro_section(self) -> None:
        stub = _StubSearchService(response=_macro_response(titles=("美联储加息",)))
        pipeline = self._pipeline(
            stub,
            SimpleNamespace(macro_news_enabled=True, macro_news_max_results=3),
        )

        section, count = pipeline._build_macro_news_section(
            code="00700", market="hk", stock_name="腾讯控股"
        )

        self.assertIsNotNone(section)
        self.assertIn(MACRO_NEWS_SECTION_TITLE, section)
        self.assertIn("【宏观】", section)
        self.assertEqual(count, 1)
        self.assertEqual(stub.calls, [{"market": "hk", "max_results": 3}])

    def test_search_failure_is_fail_open(self) -> None:
        stub = _StubSearchService(error=RuntimeError("timeout"))
        pipeline = self._pipeline(
            stub,
            SimpleNamespace(macro_news_enabled=True, macro_news_max_results=5),
        )

        section, count = pipeline._build_macro_news_section(code="AAPL", market="us")

        self.assertIsNone(section)
        self.assertEqual(count, 0)


class MacroNewsPromptTestCase(unittest.TestCase):
    """分析 prompt 的宏观多点影响指令注入。"""

    def _prompt(self, news_context):
        from src.analyzer import GeminiAnalyzer

        with patch.object(GeminiAnalyzer, "_init_litellm", return_value=None):
            analyzer = GeminiAnalyzer()

        context = {
            "code": "00700",
            "stock_name": "腾讯控股",
            "date": "2026-09-17",
            "today": {},
        }
        fake_cfg = SimpleNamespace(
            news_max_age_days=3,
            news_strategy_profile="short",
        )
        with patch("src.analyzer.get_config", return_value=fake_cfg):
            return analyzer._format_prompt(context, "腾讯控股", news_context=news_context)

    def _macro_news_context(self):
        return format_macro_news_section(_macro_response())

    def test_prompt_contains_macro_section_and_multi_point_instruction(self) -> None:
        prompt = self._prompt(self._macro_news_context())

        # 宏观段落（来自 pipeline 注入的 news_context）
        self.assertIn(MACRO_NEWS_SECTION_TITLE, prompt)
        self.assertIn("【宏观】【example.com】宏观头条A", prompt)
        # 多点影响分析指令
        self.assertIn("宏观动态多点影响分析", prompt)
        self.assertIn("宏观事件 → 市场/行业传导", prompt)
        self.assertIn("影响方向（利好 / 利空 / 中性）与置信度", prompt)
        self.assertIn("以个股证据优先", prompt)

    def test_prompt_without_macro_news_keeps_original_shape(self) -> None:
        from src.analyzer import MACRO_IMPACT_PROMPT_BLOCK

        prompt = self._prompt("【东方财富】腾讯控股发布回购公告 (2026-09-16)")

        self.assertNotIn(MACRO_NEWS_SECTION_TITLE, prompt)
        self.assertNotIn("宏观动态多点影响分析", prompt)
        self.assertNotIn(MACRO_IMPACT_PROMPT_BLOCK, prompt)
        self.assertIn("近3日的新闻搜索结果", prompt)

    def test_prompt_without_any_news_keeps_original_shape(self) -> None:
        prompt = self._prompt(None)

        self.assertNotIn(MACRO_NEWS_SECTION_TITLE, prompt)
        self.assertIn("未搜索到该股票近期的相关新闻", prompt)

    def test_macro_marker_constant_matches_search_service(self) -> None:
        from src.analyzer import MACRO_NEWS_ITEM_MARKER

        self.assertEqual(MACRO_NEWS_ITEM_MARKER, MACRO_NEWS_ITEM_PREFIX)


class MacroNewsSnapshotStorageTestCase(unittest.TestCase):
    """macro_news_snapshots 表的持久化共享快照语义（临时 SQLite 库）。"""

    def setUp(self) -> None:
        import os
        import tempfile

        from src.config import Config
        from src.storage import DatabaseManager

        self._temp_dir = tempfile.TemporaryDirectory()
        self._db_path = os.path.join(self._temp_dir.name, "test_macro_news.db")
        os.environ["DATABASE_PATH"] = self._db_path
        Config._instance = None
        DatabaseManager.reset_instance()
        self.db = DatabaseManager.get_instance()

    def tearDown(self) -> None:
        from src.storage import DatabaseManager

        DatabaseManager.reset_instance()
        self._temp_dir.cleanup()

    def _content(self, title="美联储加息"):
        return {
            "query": "美联储利率决议 最新动态 / 美股市场 今日走势 原因",
            "provider": "Mock",
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "results": [
                {
                    "title": title,
                    "snippet": f"{title}摘要",
                    "url": f"https://example.com/macro/{title}",
                    "source": "example.com",
                    "published_date": "2026-09-17",
                    "category": MACRO_NEWS_RESULT_CATEGORY,
                }
            ],
        }

    def test_upsert_then_get_round_trip(self) -> None:
        today = macro_snapshot_date_utc()

        self.assertTrue(
            self.db.upsert_macro_news_snapshot("hk", today, self._content(), "Mock")
        )
        snapshot = self.db.get_macro_news_snapshot("hk", today)

        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot["market"], "hk")
        self.assertEqual(snapshot["snapshot_date"], today)
        self.assertEqual(snapshot["source_provider"], "Mock")
        self.assertEqual(
            snapshot["content"]["results"][0]["category"],
            MACRO_NEWS_RESULT_CATEGORY,
        )

    def test_upsert_overwrites_same_market_and_date(self) -> None:
        today = macro_snapshot_date_utc()

        self.assertTrue(
            self.db.upsert_macro_news_snapshot("cn", today, self._content("旧头条"), "A")
        )
        self.assertTrue(
            self.db.upsert_macro_news_snapshot("cn", today, self._content("新头条"), "B")
        )

        snapshot = self.db.get_macro_news_snapshot("cn", today)
        self.assertEqual(snapshot["content"]["results"][0]["title"], "新头条")
        self.assertEqual(snapshot["source_provider"], "B")

    def test_markets_do_not_share_rows(self) -> None:
        today = macro_snapshot_date_utc()

        self.db.upsert_macro_news_snapshot("hk", today, self._content("港股宏观"))
        self.db.upsert_macro_news_snapshot("us", today, self._content("美股宏观"))

        self.assertEqual(
            self.db.get_macro_news_snapshot("hk", today)["content"]["results"][0]["title"],
            "港股宏观",
        )
        self.assertEqual(
            self.db.get_macro_news_snapshot("us", today)["content"]["results"][0]["title"],
            "美股宏观",
        )

    def test_purge_keeps_only_recent_days(self) -> None:
        today = macro_snapshot_date_utc()
        old_date = (
            datetime.now(timezone.utc) - timedelta(days=MACRO_NEWS_SNAPSHOT_RETENTION_DAYS + 3)
        ).date().isoformat()

        self.db.upsert_macro_news_snapshot("hk", today, self._content("今日宏观"))
        self.db.upsert_macro_news_snapshot("hk", old_date, self._content("旧宏观"))

        deleted = self.db.purge_old_macro_news_snapshots(
            keep_days=MACRO_NEWS_SNAPSHOT_RETENTION_DAYS
        )

        self.assertEqual(deleted, 1)
        self.assertIsNotNone(self.db.get_macro_news_snapshot("hk", today))
        self.assertIsNone(self.db.get_macro_news_snapshot("hk", old_date))

    def test_invalid_arguments_fail_open(self) -> None:
        self.assertFalse(self.db.upsert_macro_news_snapshot("", "2026-09-17", self._content()))
        self.assertFalse(self.db.upsert_macro_news_snapshot("hk", "", {}))
        self.assertIsNone(self.db.get_macro_news_snapshot("", "2026-09-17"))
        self.assertIsNone(self.db.get_macro_news_snapshot("hk", ""))


if __name__ == "__main__":
    unittest.main()

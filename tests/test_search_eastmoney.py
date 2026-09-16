# -*- coding: utf-8 -*-
"""
东方财富妙想资讯搜索渠道测试套件（离线，mock HTTP）

测试覆盖范围:
1. 渠道注册测试 - 配置/未配置 EASTMONEY_API_KEY 时的注册与优先级位置
2. 查询构造测试 - 个股场景使用「{股票名称}的资讯」语义查询
3. 响应解析测试 - 真实返回结构（嵌套 llmSearchResponse.data）解析为 SearchResult
4. 业务码隔离测试 - 业务失败（success=false / code!=0）不抛异常、不阻断分析链路
5. 异常隔离测试 - 单渠道抛错时回退到下一引擎
"""

import os
import sys
import unittest
from unittest.mock import MagicMock, patch

import requests

from src.search_service import EastMoneySearchProvider, SearchService, _post_with_retry

# Mock newspaper before search_service import (optional dependency)
if "newspaper" not in sys.modules:
    mock_np = MagicMock()
    mock_np.Article = MagicMock()
    mock_np.Config = MagicMock()
    sys.modules["newspaper"] = mock_np

project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if project_root not in sys.path:
    sys.path.insert(0, project_root)


EASTMONEY_LIKE_PAYLOAD = {
    "success": True,
    "status": 0,
    "code": 0,
    "message": "ok",
    "requestId": "req-1",
    "data": {
        "requestId": None,
        "message": "OK",
        "status": 0,
        "code": 0,
        "stack": None,
        "data": {
            "protocolType": "SEARCH_NEWS",
            "id": "task-1",
            "llmSearchRequest": {"query": "贵州茅台的资讯"},
            "llmSearchResponse": {
                "data": [
                    {
                        "code": "NW1",
                        "title": "茅台批价企稳回升",
                        "content": "渠道调研显示飞天批价近期止跌回升。" * 20,
                        "date": "2026-09-15 16:55:00",
                        "informationType": "NEWS",
                        "source": "证券时报网",
                        "jumpUrl": "https://finance.example.com/news/1",
                        "secuList": [
                            {"secuCode": "600519", "secuName": "贵州茅台", "secuType": "股票"},
                        ],
                    },
                    {
                        "code": "NW2",
                        "title": "白酒板块情绪修复",
                        "content": "板块估值处于低位。",
                        "date": "2026-09-15 09:30:00",
                        "source": "证券时报网",
                    },
                ],
                "traceId": "trace-1",
                "code": 0,
                "status": 0,
                "message": "OK",
            },
        },
    },
}


def _fake_response(payload, status_code=200):
    response = MagicMock()
    response.status_code = status_code
    response.text = str(payload)[:200]
    response.json.return_value = payload
    return response


class EastMoneySearchProviderTestCase(unittest.TestCase):
    """渠道注册、查询构造与响应解析测试"""

    def tearDown(self) -> None:
        os.environ.pop("EASTMONEY_API_KEY", None)

    def _build_service(self, **kwargs) -> SearchService:
        return SearchService(
            eastmoney_api_key="test-eastmoney-key",
            news_max_age_days=3,
            news_strategy_profile="short",
            **kwargs,
        )

    def test_provider_registered_only_with_api_key(self) -> None:
        with_key = SearchService(eastmoney_api_key="test-eastmoney-key")
        self.assertIn("EastMoney", [provider.name for provider in with_key._providers])
        self.assertTrue(with_key.is_available)

        without_key = SearchService(eastmoney_api_key=None)
        self.assertNotIn("EastMoney", [provider.name for provider in without_key._providers])

        # 非字符串（例如测试里未显式配置的 mock 属性）不应注册渠道
        with_invalid = SearchService(eastmoney_api_key=object())
        self.assertNotIn("EastMoney", [provider.name for provider in with_invalid._providers])

    def test_channel_slots_right_after_bocha(self) -> None:
        service = self._build_service(bocha_keys=["bocha-key"], tavily_keys=["tavily-key"])
        names = [provider.name for provider in service._providers]
        self.assertEqual(names.index("Bocha") + 1, names.index("EastMoney"))
        self.assertLess(names.index("EastMoney"), names.index("Tavily"))

    def test_do_search_posts_apikey_header_and_parses_items(self) -> None:
        provider = EastMoneySearchProvider(["test-eastmoney-key"])
        captured = {}

        def fake_post(url, **kwargs):
            captured.update({"url": url, "kwargs": kwargs})
            return _fake_response(EASTMONEY_LIKE_PAYLOAD)

        with patch("src.search_service._post_with_retry", side_effect=fake_post):
            response = provider._do_search("贵州茅台 600519 股票 最新消息", "test-eastmoney-key", 5, days=3)

        self.assertTrue(response.success)
        self.assertEqual(captured["url"], EastMoneySearchProvider.API_ENDPOINT)
        self.assertEqual(captured["kwargs"]["json"], {"query": "贵州茅台 600519 股票 最新消息"})
        self.assertEqual(captured["kwargs"]["headers"]["apikey"], "test-eastmoney-key")

        self.assertEqual(len(response.results), 2)
        first = response.results[0]
        self.assertEqual(first.title, "茅台批价企稳回升")
        self.assertIn("关联证券: 贵州茅台", first.snippet)
        self.assertEqual(first.url, "https://finance.example.com/news/1")
        self.assertEqual(first.source, "证券时报网")
        self.assertEqual(first.published_date, "2026-09-15 16:55:00")

        # 缺少 jumpUrl / secuList 的条目仍可解析，URL 交给下游兜底
        second = response.results[1]
        self.assertEqual(second.title, "白酒板块情绪修复")
        self.assertNotIn("关联证券", second.snippet)

    def test_do_search_uses_semantic_query_when_provided(self) -> None:
        provider = EastMoneySearchProvider(["test-eastmoney-key"])
        captured = {}

        def fake_post(url, **kwargs):
            captured["json"] = kwargs.get("json")
            return _fake_response(EASTMONEY_LIKE_PAYLOAD)

        with patch("src.search_service._post_with_retry", side_effect=fake_post):
            response = provider._do_search("通用查询", "test-eastmoney-key", 5, days=3, em_query="贵州茅台的资讯")

        self.assertTrue(response.success)
        self.assertEqual(captured["json"], {"query": "贵州茅台的资讯"})

    def test_business_error_is_reported_without_raising(self) -> None:
        provider = EastMoneySearchProvider(["invalid-key"])
        error_payload = {
            "success": False,
            "status": 114,
            "code": 114,
            "message": "API密钥不存在或已失效，请确认密钥是否正确",
            "data": None,
        }

        with patch("src.search_service._post_with_retry", return_value=_fake_response(error_payload)):
            response = provider.search("贵州茅台的资讯", 5, days=3)

        self.assertFalse(response.success)
        self.assertEqual(response.provider, "EastMoney")
        self.assertIn("API密钥不存在或已失效", response.error_message)
        self.assertNotIn("invalid-key", response.error_message)

    def test_malformed_payload_is_reported_without_raising(self) -> None:
        provider = EastMoneySearchProvider(["test-eastmoney-key"])
        with patch("src.search_service._post_with_retry", return_value=_fake_response({"success": True, "data": {}})):
            response = provider.search("贵州茅台的资讯", 5, days=3)

        self.assertFalse(response.success)
        self.assertIn("资讯条目", response.error_message)

    def test_build_stock_query_prefers_name_then_code(self) -> None:
        self.assertEqual(EastMoneySearchProvider.build_stock_query("贵州茅台", "600519"), "贵州茅台的资讯")
        self.assertEqual(EastMoneySearchProvider.build_stock_query("", "600519"), "600519的资讯")
        self.assertIsNone(EastMoneySearchProvider.build_stock_query("", ""))


class EastMoneyChannelFallbackTestCase(unittest.TestCase):
    """渠道在个股搜索链路中的异常隔离测试"""

    def test_search_stock_news_falls_back_when_eastmoney_fails(self) -> None:
        service = SearchService(eastmoney_api_key="test-eastmoney-key", news_max_age_days=3)

        stub_response = MagicMock()
        stub_response.success = True
        stub_response.query = "stub query"
        stub_response.provider = "Stub"
        stub_response.results = []
        stub_provider = MagicMock()
        stub_provider.name = "Stub"
        stub_provider.is_available = True
        stub_provider.search.return_value = stub_response
        service._providers.append(stub_provider)

        with patch("src.search_service._post_with_retry", side_effect=requests.exceptions.Timeout("timeout")):
            response = service.search_stock_news("600519", "贵州茅台", max_results=5)

        self.assertIsNotNone(response)
        stub_provider.search.assert_called_once()
        self.assertEqual(stub_provider.search.call_args.args[0], "贵州茅台 600519 股票 最新消息")

    def test_search_stock_news_sends_semantic_query_to_eastmoney(self) -> None:
        service = SearchService(eastmoney_api_key="test-eastmoney-key", news_max_age_days=3)
        captured = {}

        def fake_post(url, **kwargs):
            captured["json"] = kwargs.get("json")
            # 返回空条目，让链路继续走“过滤后无有效新闻”的降级路径
            return _fake_response({"success": True, "code": 0, "status": 0, "data": {"data": {"llmSearchResponse": {"data": []}}}})

        with patch("src.search_service._post_with_retry", side_effect=fake_post):
            response = service.search_stock_news("600519", "贵州茅台", max_results=5)

        self.assertEqual(captured["json"], {"query": "贵州茅台的资讯"})
        self.assertFalse(response.results)

    def test_search_topic_news_sends_topic_query_to_eastmoney(self) -> None:
        service = SearchService(eastmoney_api_key="test-eastmoney-key", news_max_age_days=3)
        captured = {}

        def fake_post(url, **kwargs):
            captured["json"] = kwargs.get("json")
            return _fake_response({"success": True, "code": 0, "status": 0, "data": {"data": {"llmSearchResponse": {"data": []}}}})

        with patch("src.search_service._post_with_retry", side_effect=fake_post):
            service.search_topic_news("半导体设备", max_results=5)

        self.assertEqual(captured["json"], {"query": "半导体设备的资讯"})


if __name__ == "__main__":
    unittest.main()

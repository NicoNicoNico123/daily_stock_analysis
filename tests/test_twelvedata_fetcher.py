# -*- coding: utf-8 -*-
"""
TwelvedataFetcher offline unit tests.
"""

import os
import sys
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch, MagicMock

import requests

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from data_provider.base import STANDARD_COLUMNS


# Offline OK payload: 3 consecutive US trading days (2024-06-10 ~ 2024-06-12).
# TwelveData returns values in DESC (newest-first) order.
_TIME_SERIES_OK_PAYLOAD = {
    'meta': {'symbol': 'AAPL', 'interval': '1day'},
    'values': [
        {'datetime': '2024-06-12', 'open': '149.0', 'high': '150.0', 'low': '147.0', 'close': '148.5', 'volume': '900000'},
        {'datetime': '2024-06-11', 'open': '151.0', 'high': '153.0', 'low': '150.0', 'close': '152.0', 'volume': '1200000'},
        {'datetime': '2024-06-10', 'open': '149.5', 'high': '151.0', 'low': '149.0', 'close': '150.0', 'volume': '1000000'},
    ],
    'status': 'ok',
}


class _DailyDataBase(unittest.TestCase):
    """Shared setup for get_daily_data offline tests (no real sleeps / HTTP)."""

    def setUp(self):
        from data_provider.twelvedata_fetcher import TwelvedataFetcher
        from data_provider.base import BaseFetcher

        self.fetcher = TwelvedataFetcher()
        self.fetcher._api_key = "test_key"
        sleep_patcher = patch.object(
            BaseFetcher, 'random_sleep', lambda *args, **kwargs: None
        )
        sleep_patcher.start()
        self.addCleanup(sleep_patcher.stop)
        retry_sleep_patcher = patch(
            'data_provider.twelvedata_fetcher.time.sleep', lambda *_: None
        )
        retry_sleep_patcher.start()
        self.addCleanup(retry_sleep_patcher.stop)


def _make_mock_response(json_data, status_code=200):
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_data
    resp.raise_for_status.return_value = None
    return resp


class TestTwelvedataFetcherNormalize(unittest.TestCase):
    """Test _normalize_data with raw TwelveData time series rows."""

    def setUp(self):
        from data_provider.twelvedata_fetcher import TwelvedataFetcher
        self.fetcher = TwelvedataFetcher()

    def test_normalize_sorts_desc_payload_ascending(self):
        import pandas as pd
        raw = pd.DataFrame([
            {'datetime': '2024-06-12', 'open': 149.0, 'high': 150.0, 'low': 147.0, 'close': 148.5, 'volume': 900000},
            {'datetime': '2024-06-11', 'open': 151.0, 'high': 153.0, 'low': 150.0, 'close': 152.0, 'volume': 1200000},
            {'datetime': '2024-06-10', 'open': 149.5, 'high': 151.0, 'low': 149.0, 'close': 150.0, 'volume': 1000000},
        ])
        result = self.fetcher._normalize_data(raw, 'AAPL')
        dates = [str(value) for value in result['date']]
        self.assertEqual(dates, ['2024-06-10', '2024-06-11', '2024-06-12'])
        self.assertAlmostEqual(result.iloc[0]['close'], 150.0)
        self.assertEqual(result.iloc[0]['code'], 'AAPL')
        self.assertEqual(set(STANDARD_COLUMNS).issubset(set(result.columns)), True)

    def test_normalize_calculates_pct_chg_after_sort(self):
        import pandas as pd
        raw = pd.DataFrame([
            {'datetime': '2024-06-11', 'open': 151.0, 'high': 154.0, 'low': 150.0, 'close': 153.0, 'volume': 1200000},
            {'datetime': '2024-06-10', 'open': 149.5, 'high': 151.0, 'low': 149.0, 'close': 150.0, 'volume': 1000000},
        ])
        result = self.fetcher._normalize_data(raw, 'AAPL')
        self.assertAlmostEqual(result.iloc[1]['pct_chg'], 2.0)

    def test_normalize_empty_df(self):
        import pandas as pd
        raw = pd.DataFrame()
        result = self.fetcher._normalize_data(raw, 'AAPL')
        self.assertTrue(result.empty)


class TestTwelvedataFetcherFetchRaw(unittest.TestCase):
    """Test _fetch_raw_data with mocked HTTP."""

    def setUp(self):
        from data_provider.twelvedata_fetcher import TwelvedataFetcher
        self.fetcher = TwelvedataFetcher()
        self.fetcher._api_key = "test_key"

    @patch('data_provider.twelvedata_fetcher.requests.get')
    def test_fetch_raw_success(self, mock_get):
        mock_get.return_value = _make_mock_response(dict(_TIME_SERIES_OK_PAYLOAD))
        df = self.fetcher._fetch_raw_data('AAPL', '2024-06-10', '2024-06-12')
        self.assertFalse(df.empty)
        self.assertIn('close', df.columns)

    @patch('data_provider.twelvedata_fetcher.requests.get')
    def test_fetch_raw_filters_out_of_window_rows(self, mock_get):
        payload = {
            'meta': {},
            'values': [
                {'datetime': '2024-06-12', 'open': '149.0', 'high': '150.0', 'low': '147.0', 'close': '148.5', 'volume': '900000'},
                {'datetime': '2024-05-01', 'open': '140.0', 'high': '141.0', 'low': '139.0', 'close': '140.5', 'volume': '800000'},
            ],
        }
        mock_get.return_value = _make_mock_response(payload)
        df = self.fetcher._fetch_raw_data('AAPL', '2024-06-10', '2024-06-12')
        self.assertEqual(len(df), 1)
        self.assertEqual(df.iloc[0]['datetime'], '2024-06-12')

    @patch('data_provider.twelvedata_fetcher.requests.get')
    def test_fetch_raw_empty_response(self, mock_get):
        from data_provider.base import DataFetchError
        mock_get.return_value = _make_mock_response({'meta': {}, 'values': []})
        with self.assertRaises(DataFetchError):
            self.fetcher._fetch_raw_data('AAPL', '2024-06-10', '2024-06-12')

    @patch('data_provider.twelvedata_fetcher.requests.get')
    def test_fetch_raw_error_payload_in_200_body(self, mock_get):
        from data_provider.base import DataFetchError
        mock_get.return_value = _make_mock_response(
            {'code': 401, 'status': 'error', 'message': 'apikey is invalid'}
        )
        with self.assertRaises(DataFetchError):
            self.fetcher._fetch_raw_data('AAPL', '2024-06-10', '2024-06-12')

    @patch('data_provider.twelvedata_fetcher.requests.get')
    def test_fetch_raw_http_error(self, mock_get):
        from data_provider.base import DataFetchError
        mock_get.side_effect = Exception("connection timeout")
        with self.assertRaises(DataFetchError):
            self.fetcher._fetch_raw_data('AAPL', '2024-06-10', '2024-06-12')


class TestTwelvedataFetcherDailyData(_DailyDataBase):
    """Test the graceful get_daily_data daily K-line fallback."""

    @patch('data_provider.twelvedata_fetcher.requests.get')
    def test_daily_data_ok_payload_matches_standard_contract(self, mock_get):
        mock_get.return_value = _make_mock_response(dict(_TIME_SERIES_OK_PAYLOAD))

        df = self.fetcher.get_daily_data('AAPL', end_date='2024-06-12')

        self.assertIsNotNone(df)
        self.assertEqual(len(df), 3)
        # Standard columns + code, and the shared indicator columns every
        # sibling fetcher produces via BaseFetcher.get_daily_data.
        self.assertTrue(set(STANDARD_COLUMNS).issubset(set(df.columns)))
        self.assertIn('code', df.columns)
        for indicator in ('ma5', 'ma10', 'ma20', 'volume_ratio'):
            self.assertIn(indicator, df.columns)
        self.assertEqual(df.iloc[0]['code'], 'AAPL')
        self.assertAlmostEqual(df.iloc[0]['close'], 150.0)
        self.assertAlmostEqual(df.iloc[1]['pct_chg'], 1.33)
        # Ascending dates even though the API returns newest-first.
        dates = [str(value.date()) for value in df['date']]
        self.assertEqual(dates, ['2024-06-10', '2024-06-11', '2024-06-12'])
        self.assertEqual(dates, sorted(dates))

    @patch('data_provider.twelvedata_fetcher.requests.get')
    def test_daily_data_window_uses_days_and_end_date(self, mock_get):
        mock_get.return_value = _make_mock_response(dict(_TIME_SERIES_OK_PAYLOAD))

        self.fetcher.get_daily_data('AAPL', end_date='2024-06-12', days=10)

        params = mock_get.call_args.kwargs['params']
        expected_from = (
            datetime.strptime('2024-06-12', '%Y-%m-%d') - timedelta(days=20)
        ).strftime('%Y-%m-%d')
        expected_outputsize = (
            datetime.strptime('2024-06-12', '%Y-%m-%d')
            - datetime.strptime(expected_from, '%Y-%m-%d')
        ).days + 1
        self.assertEqual(params['symbol'], 'AAPL')
        self.assertEqual(params['interval'], '1day')
        self.assertEqual(params['outputsize'], expected_outputsize)
        request_url = mock_get.call_args.args[0]
        self.assertEqual(request_url, 'https://api.twelvedata.com/time_series')

    @patch('data_provider.twelvedata_fetcher.requests.get')
    def test_daily_data_honors_explicit_start_date(self, mock_get):
        mock_get.return_value = _make_mock_response(dict(_TIME_SERIES_OK_PAYLOAD))

        self.fetcher.get_daily_data(
            'AAPL', start_date='2024-06-01', end_date='2024-06-12'
        )

        params = mock_get.call_args.kwargs['params']
        # outputsize must cover the requested window, not just `days`.
        expected_outputsize = (
            datetime.strptime('2024-06-12', '%Y-%m-%d')
            - datetime.strptime('2024-06-01', '%Y-%m-%d')
        ).days + 1
        self.assertEqual(params['outputsize'], expected_outputsize)

    @patch('data_provider.twelvedata_fetcher.requests.get')
    def test_daily_data_no_data_returns_none(self, mock_get):
        mock_get.return_value = _make_mock_response({'meta': {}, 'values': []})

        df = self.fetcher.get_daily_data('AAPL', end_date='2024-06-12')

        self.assertIsNone(df)
        self.assertEqual(mock_get.call_count, 1)

    @patch('data_provider.twelvedata_fetcher.requests.get')
    def test_daily_data_401_returns_none_without_raising(self, mock_get):
        mock_get.return_value = _make_mock_response({}, status_code=401)

        with self.assertLogs('data_provider.twelvedata_fetcher', level='WARNING') as captured:
            df = self.fetcher.get_daily_data('AAPL', end_date='2024-06-12')

        self.assertIsNone(df)
        joined_logs = "\n".join(captured.output)
        self.assertIn('http_status=401', joined_logs)
        self.assertNotIn('test_key', joined_logs)

    @patch('data_provider.twelvedata_fetcher.requests.get')
    def test_daily_data_429_retries_once_then_succeeds(self, mock_get):
        mock_get.side_effect = [
            _make_mock_response({}, status_code=429),
            _make_mock_response(dict(_TIME_SERIES_OK_PAYLOAD)),
        ]

        df = self.fetcher.get_daily_data('AAPL', end_date='2024-06-12')

        self.assertIsNotNone(df)
        self.assertEqual(mock_get.call_count, 2)

    @patch('data_provider.twelvedata_fetcher.requests.get')
    def test_daily_data_persistent_429_gives_up_after_one_retry(self, mock_get):
        mock_get.side_effect = [
            _make_mock_response({}, status_code=429),
            _make_mock_response({}, status_code=429),
        ]

        with self.assertLogs('data_provider.twelvedata_fetcher', level='WARNING'):
            df = self.fetcher.get_daily_data('AAPL', end_date='2024-06-12')

        self.assertIsNone(df)
        self.assertEqual(mock_get.call_count, 2)

    @patch('data_provider.twelvedata_fetcher.requests.get')
    def test_daily_data_network_error_returns_none_and_redacts_key(self, mock_get):
        mock_get.side_effect = requests.exceptions.ConnectionError(
            "connection aborted for url ...apikey=super_secret_key"
        )

        with self.assertLogs('data_provider.twelvedata_fetcher', level='WARNING') as captured:
            df = self.fetcher.get_daily_data('AAPL', end_date='2024-06-12')

        self.assertIsNone(df)
        joined_logs = "\n".join(captured.output)
        self.assertNotIn('super_secret_key', joined_logs)
        self.assertIn('apikey=***', joined_logs)

    @patch('data_provider.twelvedata_fetcher.requests.get')
    def test_daily_data_accepts_manager_call_shape(self, mock_get):
        """DataFetcherManager calls get_daily_data with these keyword names."""
        mock_get.return_value = _make_mock_response(dict(_TIME_SERIES_OK_PAYLOAD))

        df = self.fetcher.get_daily_data(
            stock_code='AAPL', start_date=None, end_date='2024-06-12', days=30
        )

        self.assertIsNotNone(df)
        params = mock_get.call_args.kwargs['params']
        self.assertEqual(params['symbol'], 'AAPL')

    @patch('data_provider.twelvedata_fetcher.requests.get')
    def test_daily_data_non_us_code_skips_http(self, mock_get):
        df = self.fetcher.get_daily_data('600519', end_date='2024-06-12')

        self.assertIsNone(df)
        mock_get.assert_not_called()

    def test_daily_data_without_api_key_skips_http(self):
        self.fetcher._api_key = None

        with patch('data_provider.twelvedata_fetcher.requests.get') as mock_get:
            df = self.fetcher.get_daily_data('AAPL', end_date='2024-06-12')

        self.assertIsNone(df)
        mock_get.assert_not_called()


class TestTwelvedataFetcherRealtimeQuote(unittest.TestCase):
    """Test get_realtime_quote (/price + /quote) with mocked HTTP."""

    def setUp(self):
        from data_provider.twelvedata_fetcher import TwelvedataFetcher
        from data_provider.base import BaseFetcher

        self.fetcher = TwelvedataFetcher()
        self.fetcher._api_key = "test_key"
        sleep_patcher = patch.object(
            BaseFetcher, 'random_sleep', lambda *args, **kwargs: None
        )
        sleep_patcher.start()
        self.addCleanup(sleep_patcher.stop)

    @patch('data_provider.twelvedata_fetcher.requests.get')
    def test_realtime_quote_us_stock(self, mock_get):
        mock_get.side_effect = [
            _make_mock_response({'price': '150.0'}),
            _make_mock_response({
                'symbol': 'AAPL',
                'close': '150.0',
                'previous_close': '148.0',
                'change': '2.0',
                'percent_change': '1.35',
                'open': '149.0',
                'high': '151.0',
                'low': '148.0',
                'volume': '5000000',
                'is_market_open': True,
            }),
        ]

        quote = self.fetcher.get_realtime_quote('AAPL')

        self.assertIsNotNone(quote)
        self.assertEqual(quote.code, 'AAPL')
        self.assertAlmostEqual(quote.price, 150.0)
        self.assertAlmostEqual(quote.change_pct, 1.35)
        self.assertAlmostEqual(quote.pre_close, 148.0)
        self.assertAlmostEqual(quote.amplitude, 2.03)

    @patch('data_provider.twelvedata_fetcher.requests.get')
    def test_realtime_quote_survives_quote_endpoint_failure(self, mock_get):
        """Only /price is mandatory; /quote failure degrades change_pct to None."""
        mock_get.side_effect = [
            _make_mock_response({'price': '150.0'}),
            _make_mock_response({}, status_code=429),
        ]

        quote = self.fetcher.get_realtime_quote('AAPL')

        self.assertIsNotNone(quote)
        self.assertAlmostEqual(quote.price, 150.0)
        self.assertIsNone(quote.change_pct)
        self.assertIsNone(quote.pre_close)

    @patch('data_provider.twelvedata_fetcher.requests.get')
    def test_realtime_quote_price_failure_returns_none(self, mock_get):
        mock_get.return_value = _make_mock_response({}, status_code=401)

        quote = self.fetcher.get_realtime_quote('AAPL')

        self.assertIsNone(quote)

    @patch('data_provider.twelvedata_fetcher.requests.get')
    def test_realtime_quote_empty_price_returns_none(self, mock_get):
        mock_get.return_value = _make_mock_response({'price': ''})

        quote = self.fetcher.get_realtime_quote('AAPL')

        self.assertIsNone(quote)

    @patch('data_provider.twelvedata_fetcher.requests.get')
    def test_realtime_quote_http_failure_returns_none(self, mock_get):
        mock_get.side_effect = Exception("timeout")

        quote = self.fetcher.get_realtime_quote('AAPL')

        self.assertIsNone(quote)

    def test_realtime_quote_non_us_stock(self):
        with patch('data_provider.twelvedata_fetcher.requests.get') as mock_get:
            quote = self.fetcher.get_realtime_quote('600519')

        self.assertIsNone(quote)
        mock_get.assert_not_called()


class TestTwelvedataFetcherInit(unittest.TestCase):
    """Test constructor / key handling."""

    @patch('src.config.get_config')
    def test_init_with_key(self, mock_config):
        mock_config.return_value = MagicMock(twelvedata_api_key='td-test-123')
        from data_provider.twelvedata_fetcher import TwelvedataFetcher
        f = TwelvedataFetcher()
        self.assertEqual(f._api_key, 'td-test-123')

    @patch.dict(os.environ, {}, clear=False)
    @patch('src.config.get_config')
    def test_init_without_key(self, mock_config):
        os.environ.pop('TWELVEDATA_API_KEY', None)
        mock_config.return_value = MagicMock(twelvedata_api_key=None)
        from data_provider.twelvedata_fetcher import TwelvedataFetcher
        f = TwelvedataFetcher()
        self.assertIsNone(f._api_key)


class TestTwelvedataFetcherRegistration(unittest.TestCase):
    """Test that TwelvedataFetcher is registered in DataFetcherManager when key is present."""

    def _mock_config(self, twelvedata_api_key):
        return MagicMock(
            finnhub_api_key=None,
            alphavantage_api_key=None,
            twelvedata_api_key=twelvedata_api_key,
            tushare_token=None,
            longbridge_app_key=None,
            longbridge_app_secret=None,
            longbridge_access_token=None,
            longbridge_oauth_client_id=None,
            tickflow_api_key=None,
            futu_opend_host=None,
        )

    @patch('src.config.get_config')
    def test_registered_with_key(self, mock_config):
        mock_config.return_value = self._mock_config('td-test')
        from data_provider.base import DataFetcherManager
        mgr = DataFetcherManager()
        names = [f.name for f in mgr._get_fetchers_snapshot()]
        self.assertIn('TwelvedataFetcher', names)
        # 最后兜底：排在美股链内其他 US 源之后
        self.assertEqual(names[-1], 'TwelvedataFetcher')

    @patch('src.config.get_config')
    def test_not_registered_without_key(self, mock_config):
        mock_config.return_value = self._mock_config(None)
        from data_provider.base import DataFetcherManager
        mgr = DataFetcherManager()
        names = [f.name for f in mgr._get_fetchers_snapshot()]
        self.assertNotIn('TwelvedataFetcher', names)

    @patch('src.config.get_config')
    def test_us_daily_routing_includes_twelvedata_as_last_fallback(self, mock_config):
        config = self._mock_config('td-test')
        config.finnhub_api_key = 'fh-test'
        config.alphavantage_api_key = 'av-test'
        mock_config.return_value = config
        from data_provider.base import DataFetcherManager
        mgr = DataFetcherManager()
        names = [f.name for f in mgr._get_fetchers_snapshot()]
        self.assertIn('TwelvedataFetcher', names)
        # 最后兜底：排在美股链内 Finnhub / Yfinance 之后
        self.assertLess(names.index('FinnhubFetcher'), names.index('TwelvedataFetcher'))
        self.assertLess(names.index('AlphaVantageFetcher'), names.index('TwelvedataFetcher'))
        self.assertLess(names.index('YfinanceFetcher'), names.index('TwelvedataFetcher'))


if __name__ == '__main__':
    unittest.main()

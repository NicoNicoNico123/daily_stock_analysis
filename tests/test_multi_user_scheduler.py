# -*- coding: utf-8 -*-
"""多用户定时排程回归测试（runtime_scheduler per-user 分支契约）。

覆盖：
- 多用户开启时忽略全局 SCHEDULE_ENABLED/SCHEDULE_TIME(S)，按用户排程触发，
  并向派生子进程注入 DSA_SCHEDULER_USER_ID、按用户自选股收窄分析范围；
- 每次真实运行前消费一次每日分析配额，配额耗尽的用户被跳过且不启动子进程；
- 全局分析锁被占用时含用户 id 的 busy-skip 与唯一一次延迟重试；
- 多用户关闭时保持原全局排程路径不变。
"""

from __future__ import annotations

import os
import time
import unittest
from queue import Queue
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from src.services import runtime_scheduler
from src.services.runtime_scheduler import (
    PER_USER_SCHEDULE_STAGGER_SECONDS,
    PER_USER_SCHEDULE_TASK_NAME,
    PER_USER_SCHEDULE_TICK_SECONDS,
    SCHEDULER_USER_ID_ENV,
    RuntimeSchedulerService,
    _run_scheduled_analysis_process,
)


class _NoopThread:
    def __init__(self, target=None, **kwargs):
        self.target = target

    def start(self):
        return None

    def is_alive(self):
        return False


class _FakeScheduler:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.schedule_times = list(kwargs.get("schedule_times") or [])
        self.background_tasks = []
        self.daily_task = None

    def set_daily_task(self, task, run_immediately: bool) -> None:
        self.daily_task = task

    def add_background_task(
        self,
        task,
        interval_seconds: int,
        run_immediately: bool,
        name=None,
    ) -> None:
        self.background_tasks.append({
            "task": task,
            "interval_seconds": interval_seconds,
            "run_immediately": run_immediately,
            "name": name,
        })

    def run(self) -> None:
        return None

    def stop(self) -> None:
        return None

    @property
    def schedule(self):
        class _Namespace:
            @staticmethod
            def get_jobs():
                return []

        return _Namespace


def _current_hm() -> str:
    return time.strftime("%H:%M")


class MultiUserSchedulerTestCase(unittest.TestCase):
    def _service(self, *, schedule_enabled: bool = False) -> RuntimeSchedulerService:
        config = SimpleNamespace(
            schedule_enabled=schedule_enabled,
            schedule_time="03:00",
            schedule_times=["03:00"],
        )
        service = RuntimeSchedulerService(config_provider=lambda: config)
        service._reload_config = lambda: config
        # 分发线程同步执行，保证断言确定性。
        service._run_in_background_thread = lambda target: target()
        return service

    def test_multi_user_start_ignores_global_schedule_config(self) -> None:
        """多用户开启时：SCHEDULE_ENABLED=false 仍启用调度，但只注册用户排程轮询。"""
        service = self._service(schedule_enabled=False)
        with patch("src.auth.is_multi_user_enabled", return_value=True), patch(
            "src.services.runtime_scheduler.Scheduler", _FakeScheduler
        ), patch("src.services.runtime_scheduler.threading.Thread", _NoopThread), patch.object(
            service, "_list_enabled_user_schedules", return_value=[]
        ):
            service.start()
            status = service.status()

        scheduler = service._scheduler
        self.assertIsNotNone(scheduler)
        # 全局 SCHEDULE_TIME(S) 不再注册每日任务，.env 配置不会触发运行。
        self.assertIsNone(scheduler.daily_task)
        tick_entries = [
            entry
            for entry in scheduler.background_tasks
            if entry["name"] == PER_USER_SCHEDULE_TASK_NAME
        ]
        self.assertEqual(len(tick_entries), 1)
        self.assertEqual(tick_entries[0]["interval_seconds"], PER_USER_SCHEDULE_TICK_SECONDS)
        self.assertTrue(status["enabled"])
        self.assertEqual(status["mode"], "per_user")
        self.assertEqual(status["per_user_enabled_schedules"], 0)
        self.assertEqual(status["schedule_times"], [])

    def test_per_user_tick_spawns_owner_scoped_analysis(self) -> None:
        """命中当前 HH:MM 的用户按其自选股触发，且同一分钟不重复触发。"""
        service = self._service()
        schedules = [{
            "user_id": 7,
            "times": [_current_hm(), "23:59"],
            "stock_codes": ["600519", "sz000001"],
        }]
        seen = []

        def _capture(stock_codes=None, **kwargs):
            seen.append({"stock_codes": stock_codes, **kwargs})
            return True

        with patch("src.auth.is_multi_user_enabled", return_value=True), patch.object(
            service, "_list_enabled_user_schedules", return_value=schedules
        ), patch.object(service, "_start_analysis_watchdog", side_effect=_capture):
            service._per_user_schedule_tick()
            service._per_user_schedule_tick()

        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0]["stock_codes"], ["600519", "sz000001"])
        self.assertEqual(seen[0]["owner_user_id"], 7)
        gate = seen[0]["start_gate"]
        self.assertTrue(callable(gate))
        with patch(
            "src.services.user_quota.consume_daily_quota",
            return_value=(True, 1, 10),
        ) as consume:
            self.assertIsNone(gate())
        consume.assert_called_once_with(7, "analysis")

    def test_stagger_delay_uses_index_times_stagger_seconds(self) -> None:
        """第 N 个命中的用户延迟 N*120 秒（首个用户立即分发）。"""
        service = self._service()
        events = []
        schedules = [
            {"user_id": 1, "times": ["18:00"], "stock_codes": ["600519"]},
            {"user_id": 2, "times": ["18:00"], "stock_codes": ["000001"]},
        ]

        def _record_sleep(delay_seconds):
            events.append(("sleep", delay_seconds))

        def _record_run(schedule):
            events.append(("run", schedule["user_id"]))

        with patch.object(
            runtime_scheduler.time, "sleep", side_effect=_record_sleep
        ), patch.object(service, "_run_user_scheduled_analysis", side_effect=_record_run):
            service._dispatch_due_user_schedules(schedules)

        self.assertEqual(
            events,
            [
                ("run", 1),
                ("sleep", PER_USER_SCHEDULE_STAGGER_SECONDS),
                ("run", 2),
            ],
        )

    def test_quota_refused_user_is_skipped_without_spawning(self) -> None:
        """配额耗尽的用户：告警跳过、记录 skip 原因且不启动子进程。"""
        service = self._service()
        schedules = [{
            "user_id": 9,
            "times": [_current_hm()],
            "stock_codes": ["600519"],
        }]
        context_mock = MagicMock()
        with patch("src.auth.is_multi_user_enabled", return_value=True), patch(
            "src.services.user_quota.consume_daily_quota",
            return_value=(False, 5, 10),
        ) as consume, patch.object(
            service, "_list_enabled_user_schedules", return_value=schedules
        ), patch.object(
            runtime_scheduler.multiprocessing, "get_context", return_value=context_mock
        ) as get_context:
            service._per_user_schedule_tick()
            deadline = time.monotonic() + 3
            while (
                service.status()["last_skip_reason"] != "user_quota_exhausted"
                and time.monotonic() < deadline
            ):
                time.sleep(0.02)
            while service._run_lock.locked() and time.monotonic() < deadline:
                time.sleep(0.02)
            status = service.status()

        consume.assert_called_once_with(9, "analysis")
        get_context.assert_called_once()  # 仅构建队列/进程占位，未启动子进程
        context_mock.Process.return_value.start.assert_not_called()
        self.assertEqual(status["last_skip_reason"], "user_quota_exhausted")
        self.assertIsNotNone(status["last_skipped_at"])

    def test_lock_busy_user_run_skips_then_retries_once(self) -> None:
        """全局分析锁占用时记录 busy-skip 并在延迟后仅重试一次。"""
        service = self._service()
        attempts = []

        def _capture(stock_codes=None, **kwargs):
            attempts.append({"stock_codes": stock_codes, **kwargs})
            # 第一次模拟锁被占用，重试时允许执行。
            return len(attempts) > 1

        schedule = {"user_id": 11, "times": [_current_hm()], "stock_codes": ["600519"]}
        with patch.object(
            runtime_scheduler, "PER_USER_SCHEDULE_RETRY_SECONDS", 0
        ), patch.object(service, "_start_analysis_watchdog", side_effect=_capture):
            service._run_user_scheduled_analysis(schedule)

        self.assertEqual(len(attempts), 2)
        self.assertTrue(all(item["owner_user_id"] == 11 for item in attempts))

    def test_spawned_process_env_injects_owner_user_id(self) -> None:
        """派生的分析子进程环境包含 DSA_SCHEDULER_USER_ID=<user_id>。"""
        os.environ.pop(SCHEDULER_USER_ID_ENV, None)
        captured = {}
        result_queue = Queue()

        def _fake_locked(self, stock_codes):
            captured["stock_codes"] = stock_codes
            captured["env_user_id"] = os.environ.get(SCHEDULER_USER_ID_ENV)
            return True

        try:
            with patch.object(
                RuntimeSchedulerService, "_run_analysis_locked", _fake_locked
            ), patch("os.setsid"):
                _run_scheduled_analysis_process(result_queue, ["600519"], {}, owner_user_id=7)
        finally:
            os.environ.pop(SCHEDULER_USER_ID_ENV, None)

        self.assertEqual(captured["env_user_id"], "7")
        self.assertEqual(captured["stock_codes"], ["600519"])
        self.assertEqual(result_queue.get_nowait(), {"success": True, "error": None})

    def test_spawned_process_without_owner_leaves_env_untouched(self) -> None:
        """无归属（多用户关闭/全局路径）时不注入归属环境变量。"""
        os.environ.pop(SCHEDULER_USER_ID_ENV, None)
        result_queue = Queue()
        with patch.object(
            RuntimeSchedulerService, "_run_analysis_locked", lambda self, codes: True
        ), patch("os.setsid"):
            _run_scheduled_analysis_process(result_queue, None, {})

        self.assertIsNone(os.environ.get(SCHEDULER_USER_ID_ENV))
        self.assertEqual(result_queue.get_nowait(), {"success": True, "error": None})

    def test_status_reports_per_user_mode_without_leaking_watchlists(self) -> None:
        """per-user 状态只暴露启用排程用户数，不泄露任何用户的自选股。"""
        service = self._service()
        schedules = [{
            "user_id": 7,
            "times": ["18:00"],
            "stock_codes": ["600519", "300750"],
        }]
        with patch("src.auth.is_multi_user_enabled", return_value=True), patch.object(
            service, "_list_enabled_user_schedules", return_value=schedules
        ):
            status = service.status()

        self.assertEqual(status["mode"], "per_user")
        self.assertEqual(status["per_user_enabled_schedules"], 1)
        self.assertEqual(status["schedule_times"], [])
        self.assertNotIn("600519", str(status))
        self.assertNotIn("300750", str(status))

    def test_multi_user_off_keeps_global_schedule_path(self) -> None:
        """多用户关闭时：保持全局配置排程，不注册用户轮询，也不读用户排程。"""
        config = SimpleNamespace(
            schedule_enabled=True,
            schedule_time="18:00",
            schedule_times=["18:00"],
        )
        service = RuntimeSchedulerService(config_provider=lambda: config)
        service._reload_config = lambda: config
        with patch("src.auth.is_multi_user_enabled", return_value=False), patch(
            "src.services.runtime_scheduler.Scheduler", _FakeScheduler
        ), patch("src.services.runtime_scheduler.threading.Thread", _NoopThread):
            service.start()
            scheduler = service._scheduler
            status = service.status()

        self.assertIsNotNone(scheduler.daily_task)
        self.assertEqual(scheduler.background_tasks, [])
        self.assertEqual(status["mode"], "global")
        self.assertIsNone(status["per_user_enabled_schedules"])
        self.assertEqual(status["schedule_times"], ["18:00"])

        with patch("src.auth.is_multi_user_enabled", return_value=False), patch.object(
            service, "_list_enabled_user_schedules"
        ) as list_schedules:
            service._per_user_schedule_tick()
        list_schedules.assert_not_called()

    def test_multi_user_off_still_requires_global_schedule_enabled(self) -> None:
        """多用户关闭且 SCHEDULE_ENABLED=false 时，调度保持停用（不因 per-user 逻辑放开）。"""
        service = self._service(schedule_enabled=False)
        with patch("src.auth.is_multi_user_enabled", return_value=False), patch(
            "src.services.runtime_scheduler.Scheduler", _FakeScheduler
        ), patch("src.services.runtime_scheduler.threading.Thread", _NoopThread):
            service.start()

        self.assertIsNone(service._scheduler)
        self.assertFalse(service.status()["enabled"])


if __name__ == "__main__":
    unittest.main()

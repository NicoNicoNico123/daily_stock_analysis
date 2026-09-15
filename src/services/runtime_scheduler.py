# -*- coding: utf-8 -*-
"""Runtime scheduler service for long-lived API/Web/Desktop processes."""

from __future__ import annotations

import logging
import multiprocessing
import os
import re
import signal
import subprocess
import threading
import _thread
import time
from datetime import datetime
from functools import partial
from queue import Empty
from types import SimpleNamespace
from typing import Any, Callable, Dict, List, Optional, Set

from src.config import Config, get_config
from src.scheduler import Scheduler, normalize_schedule_times

logger = logging.getLogger(__name__)
CLI_SCHEDULER_OWNER_ENV = "DSA_CLI_SCHEDULER_OWNS_SCHEDULE"
RUNTIME_SCHEDULER_FORCE_ENABLED_ENV = "DSA_RUNTIME_SCHEDULER_FORCE_ENABLED"
RUNTIME_SCHEDULER_RUN_IMMEDIATELY_ENV = "DSA_RUNTIME_SCHEDULER_RUN_IMMEDIATELY"
RUNTIME_SCHEDULER_SUPPRESS_START_ENV = "DSA_RUNTIME_SCHEDULER_SUPPRESS_START"
RUNTIME_SCHEDULER_ARGS_ENV = "DSA_RUNTIME_SCHEDULER_ARGS"
RUNTIME_SCHEDULER_TIMEOUT_ENV = "DSA_RUNTIME_SCHEDULER_TIMEOUT_SECONDS"
DEFAULT_RUNTIME_SCHEDULER_TIMEOUT_SECONDS = 45 * 60
# 多用户定时排程：子进程归属用户注入的环境变量（main.py 侧消费）。
SCHEDULER_USER_ID_ENV = "DSA_SCHEDULER_USER_ID"
PER_USER_SCHEDULE_TASK_NAME = "per_user_schedule_tick"
PER_USER_SCHEDULE_TICK_SECONDS = 60
PER_USER_SCHEDULE_STAGGER_SECONDS = 120
PER_USER_SCHEDULE_RETRY_SECONDS = 5 * 60
_RUNTIME_ANALYSIS_LOCK = threading.Lock()
SCHEDULE_ARGS_OVERRIDE_KEYS = {
    "no_notify",
    "no_market_review",
    "dry_run",
    "force_run",
    "single_notify",
    "no_context_snapshot",
    "workers",
    "portfolio",
}


def run_with_global_analysis_lock(
    task_runner: Callable[[Config, Any, Optional[List[str]]], Any],
    config: Config,
    args: Any,
    stock_codes: Optional[List[str]] = None,
    *,
    blocking: bool = True,
) -> bool:
    """Execute a task while holding the shared runtime analysis lock."""
    if not _RUNTIME_ANALYSIS_LOCK.acquire(blocking=blocking):
        return False
    try:
        task_runner(config, args, stock_codes)
    finally:
        _RUNTIME_ANALYSIS_LOCK.release()
    return True


def _run_scheduled_analysis_process(
    result_queue: Any,
    stock_codes: Optional[List[str]],
    schedule_args_overrides: Dict[str, Any],
    owner_user_id: Optional[int] = None,
) -> None:
    """Run one analysis in a spawn-safe child process."""
    if owner_user_id is not None:
        # 在子进程环境注入归属用户：main.py 侧据此把历史/报告归属到该用户。
        # 只新增这一个变量，不透传其他调度内部状态。
        os.environ[SCHEDULER_USER_ID_ENV] = str(owner_user_id)
    if os.name == "posix":
        try:
            os.setsid()
        except OSError:
            # Being a session leader already is equivalent to success. Any
            # other failure would make process-tree cleanup unsafe, so fail
            # before analysis can create descendants.
            if os.getsid(0) != os.getpid():
                raise
    service = RuntimeSchedulerService(schedule_args_overrides=schedule_args_overrides)
    success = service._run_analysis_locked(stock_codes)
    result_queue.put({"success": success, "error": service._last_error})


def _posix_descendant_process_ids(root_pid: int) -> Set[int]:
    """Return a best-effort snapshot of descendants before the root exits."""
    try:
        completed = subprocess.run(
            ["ps", "-axo", "pid=,ppid="],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return set()

    children_by_parent: Dict[int, List[int]] = {}
    for line in completed.stdout.splitlines():
        parts = line.split()
        if len(parts) != 2:
            continue
        try:
            pid, parent_pid = (int(value) for value in parts)
        except ValueError:
            continue
        children_by_parent.setdefault(parent_pid, []).append(pid)

    descendants: Set[int] = set()
    pending = list(children_by_parent.get(root_pid, []))
    while pending:
        pid = pending.pop()
        if pid in descendants:
            continue
        descendants.add(pid)
        pending.extend(children_by_parent.get(pid, []))
    return descendants


def _terminate_analysis_process_tree(process: Any) -> None:
    """Stop an analysis worker and any descendants it created."""
    root_alive = process.is_alive()
    process_id = process.pid

    posix_process_groups: Set[int] = set()
    if os.name == "posix" and process_id:
        posix_process_groups.add(process_id)
        current_process_group = os.getpgrp()
        if root_alive:
            for descendant_pid in _posix_descendant_process_ids(process_id):
                try:
                    descendant_group = os.getpgid(descendant_pid)
                except ProcessLookupError:
                    continue
                if descendant_group != current_process_group:
                    posix_process_groups.add(descendant_group)

    try:
        if os.name == "posix" and process_id:
            for process_group in posix_process_groups:
                try:
                    os.killpg(process_group, signal.SIGTERM)
                except ProcessLookupError:
                    continue
            # The spawned worker calls setsid(), but stop/timeout can win the
            # race before that happens. In that window killpg(worker_pid, ...)
            # has no target, so also terminate the multiprocessing handle.
            if process.is_alive():
                process.terminate()
        elif os.name == "nt" and process_id:
            subprocess.run(
                ["taskkill", "/PID", str(process_id), "/T", "/F"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
            )
        elif root_alive:
            process.terminate()
    except (OSError, subprocess.SubprocessError):
        if root_alive:
            process.terminate()

    process.join(2)
    if os.name == "posix" and process_id:
        remaining_process_groups: Set[int] = set()
        for process_group in posix_process_groups:
            try:
                os.killpg(process_group, 0)
            except ProcessLookupError:
                continue
            except PermissionError:
                pass
            remaining_process_groups.add(process_group)
        if not remaining_process_groups:
            return
    elif not process.is_alive():
        return

    try:
        if os.name == "posix" and process_id:
            for process_group in remaining_process_groups:
                try:
                    os.killpg(process_group, signal.SIGKILL)
                except ProcessLookupError:
                    continue
        else:
            process.kill()
    except (OSError, AttributeError):
        if process.is_alive():
            process.terminate()
    process.join(10)


def _agent_event_monitor_interval_seconds(config: Config) -> int:
    """Return the validated Event Monitor polling interval in seconds."""
    interval_minutes = getattr(config, "agent_event_monitor_interval_minutes", 5)
    try:
        interval_minutes = max(1, int(interval_minutes))
    except (TypeError, ValueError):  # pragma: no cover - defensive branch
        logger.warning(
            "Invalid AGENT_EVENT_MONITOR_INTERVAL_MINUTES=%r; use fallback 5",
            interval_minutes,
        )
        interval_minutes = 5
    return interval_minutes * 60


def build_agent_event_monitor_background_tasks(
    config: Config,
    *,
    config_provider: Callable[[], Config],
) -> List[Dict[str, Any]]:
    """Build scheduler background tasks used by the runtime scheduler."""
    if not getattr(config, "agent_event_monitor_enabled", False):
        return []

    from src.services.alert_worker import AlertWorker

    interval_seconds = _agent_event_monitor_interval_seconds(config)
    try:
        alert_worker = AlertWorker(config_provider=config_provider)
    except Exception as exc:  # pragma: no cover - defensive branch
        logger.warning("Failed to initialize AlertWorker for event monitor: %s", exc)
        return []

    def event_monitor_task() -> None:
        stats = alert_worker.run_once()
        triggered_count = stats.get("triggered", 0)
        if triggered_count:
            logger.info("[EventMonitor] triggered %d alert(s)", triggered_count)

    return [{
        "task": event_monitor_task,
        "interval_seconds": interval_seconds,
        "run_immediately": True,
        "name": "agent_event_monitor",
    }]


class RuntimeSchedulerService:
    """Manage scheduled analysis inside the current API/Web/Desktop process."""

    def __init__(
        self,
        *,
        config_provider: Callable[[], Config] = get_config,
        task_runner: Optional[Callable[[Config, Any, Optional[List[str]]], Any]] = None,
        owns_schedule: Optional[bool] = None,
        force_enabled: bool = False,
        run_immediately_in_background: bool = False,
        background_tasks_provider: Optional[Callable[[Config], List[Dict[str, Any]]]] = None,
        schedule_args_overrides: Optional[Dict[str, Any]] = None,
    ) -> None:
        self._config_provider = config_provider
        self._task_runner = task_runner
        if owns_schedule is None:
            owns_schedule = os.getenv(CLI_SCHEDULER_OWNER_ENV, "").strip().lower() not in {
                "1",
                "true",
                "yes",
                "on",
            }
        self._owns_schedule = owns_schedule
        self._force_enabled = force_enabled
        self._run_immediately_in_background = run_immediately_in_background
        self._background_tasks_provider = background_tasks_provider
        self._schedule_args_overrides = {
            key: value
            for key, value in (schedule_args_overrides or {}).items()
            if key in SCHEDULE_ARGS_OVERRIDE_KEYS
        }
        self._background_task_cache: Dict[str, Dict[str, Any]] = {}
        self._background_task_registered_names: Set[str] = set()
        self._lock = threading.RLock()
        self._run_lock = _RUNTIME_ANALYSIS_LOCK
        self._scheduler: Optional[Scheduler] = None
        self._thread: Optional[threading.Thread] = None
        self._enabled = False
        self._last_run_at: Optional[str] = None
        self._last_success_at: Optional[str] = None
        self._last_error: Optional[str] = None
        self._last_skipped_at: Optional[str] = None
        self._last_skip_reason: Optional[str] = None
        self._analysis_process_target = _run_scheduled_analysis_process
        self._analysis_process: Optional[Any] = None
        self._analysis_process_lock = threading.Lock()
        self._analysis_generation = 0
        # 多用户排程：记录当天已触发的 (日期|HH:MM|user_id)，避免同一时刻重复触发。
        self._per_user_state_lock = threading.Lock()
        self._per_user_fired_keys: Set[str] = set()
        self._per_user_fired_date: Optional[str] = None

    def _make_schedule_args(self) -> SimpleNamespace:
        defaults = {
            "schedule": True,
            "no_run_immediately": True,
            "no_notify": False,
            "no_market_review": False,
            "dry_run": False,
            "force_run": False,
            "single_notify": False,
            "no_context_snapshot": False,
            "market_review": False,
            "serve": False,
            "serve_only": True,
            "stocks": None,
            "portfolio": None,
            "workers": None,
        }
        defaults.update(self._schedule_args_overrides)
        return SimpleNamespace(**defaults)

    def _reload_config(self) -> Config:
        from main import _reload_runtime_config

        return _reload_runtime_config()

    def _record_analysis_busy_skip(self) -> None:
        self._last_skipped_at = datetime.now().isoformat()
        self._last_skip_reason = "analysis_already_running"
        logger.warning("Runtime scheduler skipped run: analysis already running")

    def _run_analysis_locked(self, stock_codes: Optional[List[str]]) -> bool:
        try:
            config = self._reload_config()
            runner = self._task_runner
            if runner is None:
                from main import run_scheduled_analysis

                runner = run_scheduled_analysis
            self._last_run_at = datetime.now().isoformat()
            result = runner(config, self._make_schedule_args(), stock_codes)
            if result is False:
                raise RuntimeError("runtime scheduled analysis reported failure")
            self._last_success_at = datetime.now().isoformat()
            self._last_error = None
            return True
        except Exception as exc:  # noqa: BLE001 - scheduled runs must not kill API process.
            self._last_error = str(exc)
            logger.exception("Runtime scheduled analysis failed: %s", exc)
            return False

    def _run_analysis_once(self, stock_codes: Optional[List[str]] = None) -> bool:
        if not self._run_lock.acquire(blocking=False):
            self._record_analysis_busy_skip()
            return False
        try:
            self._run_analysis_locked(stock_codes)
        finally:
            self._run_lock.release()
        return True

    def _analysis_timeout_seconds(self) -> int:
        try:
            value = os.getenv(
                RUNTIME_SCHEDULER_TIMEOUT_ENV,
                str(DEFAULT_RUNTIME_SCHEDULER_TIMEOUT_SECONDS),
            )
            return max(60, int(value))
        except ValueError:
            logger.warning(
                "Invalid %s; using %ss",
                RUNTIME_SCHEDULER_TIMEOUT_ENV,
                DEFAULT_RUNTIME_SCHEDULER_TIMEOUT_SECONDS,
            )
            return DEFAULT_RUNTIME_SCHEDULER_TIMEOUT_SECONDS

    def _bind_analysis_process_target(self, owner_user_id: Optional[int]) -> Any:
        """Bind the owner user onto the spawn target without changing its arity.

        既有测试/自定义 spawn target 只接受 3 个位置参数，因此仅在需要归属时
        以 partial 追加 owner_user_id 关键字参数。
        """
        target = self._analysis_process_target
        if owner_user_id is None:
            return target
        return partial(target, owner_user_id=owner_user_id)

    def _run_analysis_with_watchdog(
        self,
        stock_codes: Optional[List[str]] = None,
        *,
        lock_held: bool = False,
        generation: Optional[int] = None,
        owner_user_id: Optional[int] = None,
        start_gate: Optional[Callable[[], Optional[str]]] = None,
    ) -> None:
        if not lock_held and not self._run_lock.acquire(blocking=False):
            self._record_analysis_busy_skip()
            return
        if generation is None:
            with self._analysis_process_lock:
                generation = self._analysis_generation

        result_queue = None
        try:
            context = multiprocessing.get_context("spawn")
            result_queue = context.Queue()
            process = context.Process(
                target=self._bind_analysis_process_target(owner_user_id),
                args=(result_queue, stock_codes, dict(self._schedule_args_overrides)),
                name="runtime-scheduled-analysis",
            )
            timeout = self._analysis_timeout_seconds()
            if start_gate is not None:
                # 闸门在锁已持有、子进程即将启动前执行，保证每次真实运行只扣一次配额；
                # 拒绝时不启动进程，直接按跳过记录。
                gate_reason = start_gate()
                if gate_reason is not None:
                    with self._analysis_process_lock:
                        if generation == self._analysis_generation:
                            self._last_skipped_at = datetime.now().isoformat()
                            self._last_skip_reason = gate_reason
                    return
            with self._analysis_process_lock:
                if generation != self._analysis_generation:
                    return
                process.start()
                self._analysis_process = process
                self._last_run_at = datetime.now().isoformat()

            result = None
            deadline = time.monotonic() + timeout
            while result is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    result = result_queue.get(timeout=min(0.2, remaining))
                except Empty:
                    if not process.is_alive():
                        deadline = min(deadline, time.monotonic() + 2)

            if result is None and process.is_alive():
                logger.error(
                    "Runtime scheduled analysis exceeded %ss; terminating worker",
                    timeout,
                )
                _terminate_analysis_process_tree(process)
                with self._analysis_process_lock:
                    if generation != self._analysis_generation:
                        return
                    self._last_error = f"runtime scheduled analysis timed out after {timeout}s"
                return

            if result is None:
                exit_code = process.exitcode
                _terminate_analysis_process_tree(process)
                with self._analysis_process_lock:
                    if generation != self._analysis_generation:
                        return
                    self._last_error = (
                        "runtime scheduled analysis worker exited without a result "
                        f"(exit code {exit_code})"
                    )
                return

            process.join(2)
            if process.is_alive():
                _terminate_analysis_process_tree(process)
                with self._analysis_process_lock:
                    if generation != self._analysis_generation:
                        return
                    self._last_error = "runtime scheduled analysis worker did not exit"
                return

            with self._analysis_process_lock:
                if generation != self._analysis_generation:
                    return
                if result.get("success"):
                    self._last_success_at = datetime.now().isoformat()
                    self._last_error = None
                else:
                    self._last_error = result.get("error") or "runtime scheduled analysis failed"
        except Exception as exc:  # noqa: BLE001 - watchdog failures must release the scheduler.
            with self._analysis_process_lock:
                if generation == self._analysis_generation:
                    self._last_error = str(exc)
            logger.exception("Runtime scheduler watchdog failed: %s", exc)
        finally:
            self._run_lock.release()
            if "process" in locals():
                with self._analysis_process_lock:
                    if self._analysis_process is process:
                        self._analysis_process = None
            if result_queue is not None:
                result_queue.cancel_join_thread()
                result_queue.close()

    def _start_analysis_watchdog(
        self,
        stock_codes: Optional[List[str]] = None,
        *,
        generation: Optional[int] = None,
        owner_user_id: Optional[int] = None,
        start_gate: Optional[Callable[[], Optional[str]]] = None,
    ) -> bool:
        with self._analysis_process_lock:
            current_generation = self._analysis_generation
            if generation is not None and generation != current_generation:
                return False
            generation = current_generation
        if not self._run_lock.acquire(blocking=False):
            self._record_analysis_busy_skip()
            return False
        worker = threading.Thread(
            target=lambda: self._run_analysis_with_watchdog(
                stock_codes,
                lock_held=True,
                generation=generation,
                owner_user_id=owner_user_id,
                start_gate=start_gate,
            ),
            daemon=True,
            name="runtime-scheduler-watchdog",
        )
        try:
            worker.start()
        except Exception:
            self._run_lock.release()
            raise
        return True

    def _current_times(self) -> List[str]:
        config = self._config_provider()
        return normalize_schedule_times(
            getattr(config, "schedule_times", None),
            fallback_time=getattr(config, "schedule_time", "18:00"),
        )

    def _is_schedule_enabled(self, config: Config) -> bool:
        if self._is_multi_user_mode():
            # 多用户模式：排程唯一真源是用户配置，全局 SCHEDULE_ENABLED 不再决定调度开关。
            return True
        return self._force_enabled or bool(getattr(config, "schedule_enabled", False))

    def _is_multi_user_mode(self) -> bool:
        """多用户模式开启时，定时排程切换为按用户配置触发。"""
        try:
            from src.auth import is_multi_user_enabled

            return bool(is_multi_user_enabled())
        except Exception as exc:  # noqa: BLE001 - 开关读取失败按关闭处理，保持旧全局行为。
            logger.warning("[PerUserScheduler] 多用户开关读取失败，按关闭处理: %s", exc)
            return False

    def _list_enabled_user_schedules(self) -> List[Dict[str, Any]]:
        """读取启用排程且自选股非空的用户（存储层已过滤空 watchlist）。"""
        from src.storage import DatabaseManager

        return DatabaseManager.get_instance().list_enabled_user_schedules()

    def _count_enabled_user_schedules(self) -> int:
        """状态接口用的启用排程用户数（不暴露任何用户的自选股内容）。"""
        try:
            return len(self._list_enabled_user_schedules())
        except Exception as exc:  # noqa: BLE001 - 状态统计失败不能影响 status 接口。
            logger.warning("[PerUserScheduler] 统计启用排程用户数失败: %s", exc)
            return 0

    @staticmethod
    def _normalize_user_schedule_times(times: Any) -> List[str]:
        """把用户排程时间归一化为 HH:MM 集合（容忍 HH:MM:SS 写法）。"""
        normalized: Set[str] = set()
        for item in times or []:
            match = re.fullmatch(r"(\d{1,2}):(\d{2})(?::\d{2})?", str(item).strip())
            if not match:
                continue
            hour, minute = int(match.group(1)), int(match.group(2))
            if 0 <= hour <= 23 and 0 <= minute <= 59:
                normalized.add(f"{hour:02d}:{minute:02d}")
        return sorted(normalized)

    def _build_user_quota_gate(self, user_id: int) -> Callable[[], Optional[str]]:
        """构造子进程启动前的每日配额闸门；拒绝时返回 skip 原因。"""

        def _gate() -> Optional[str]:
            from src.services.user_quota import QUOTA_ANALYSIS, consume_daily_quota

            allowed, used, limit = consume_daily_quota(user_id, QUOTA_ANALYSIS)
            if allowed:
                return None
            logger.warning(
                "[PerUserScheduler] 用户 %s 今日分析配额已用尽（%s/%s），跳过本次定时分析",
                user_id,
                used,
                limit,
            )
            return "user_quota_exhausted"

        return _gate

    def _per_user_schedule_tick(self) -> None:
        """多用户排程轮询：命中当前 HH:MM 的用户进入错峰分发。

        由调度循环以后台任务方式调用；读取/分发都不阻塞调度主循环，
        任何异常也不能拖垮调度器本身。
        """
        if not self._is_multi_user_mode():
            return
        try:
            schedules = self._list_enabled_user_schedules()
        except Exception as exc:  # noqa: BLE001 - 排程读取失败只影响本轮。
            logger.warning("[PerUserScheduler] 读取用户排程失败，本轮跳过: %s", exc)
            return

        now = datetime.now()
        current_hm = now.strftime("%H:%M")
        today = now.strftime("%Y-%m-%d")
        due_schedules: List[Dict[str, Any]] = []
        with self._per_user_state_lock:
            if self._per_user_fired_date != today:
                # 跨天清理触发记录，避免集合无限增长。
                self._per_user_fired_keys.clear()
                self._per_user_fired_date = today
            for schedule in schedules:
                if current_hm not in self._normalize_user_schedule_times(schedule.get("times")):
                    continue
                fired_key = f"{today}|{current_hm}|{schedule.get('user_id')}"
                if fired_key in self._per_user_fired_keys:
                    continue
                self._per_user_fired_keys.add(fired_key)
                due_schedules.append(schedule)
        if not due_schedules:
            return
        logger.info(
            "[PerUserScheduler] %s 命中 %d 个用户的定时排程，开始错峰分发",
            current_hm,
            len(due_schedules),
        )
        self._run_in_background_thread(
            partial(self._dispatch_due_user_schedules, due_schedules)
        )

    def _dispatch_due_user_schedules(self, due_schedules: List[Dict[str, Any]]) -> None:
        """依次分发命中的用户；第 N 个用户延迟 N*120 秒，避免同时挤兑分析资源。"""
        for index, schedule in enumerate(due_schedules):
            delay_seconds = index * PER_USER_SCHEDULE_STAGGER_SECONDS
            if delay_seconds > 0:
                time.sleep(delay_seconds)
            user_id = schedule.get("user_id")
            try:
                self._run_user_scheduled_analysis(schedule)
            except Exception as exc:  # noqa: BLE001 - 单用户失败不影响其他用户。
                logger.error("[PerUserScheduler] 用户 %s 定时分发失败: %s", user_id, exc)

    def _run_user_scheduled_analysis(
        self,
        schedule: Dict[str, Any],
        *,
        allow_retry: bool = True,
    ) -> None:
        """为单个用户触发一次限定其自选股、归属其名下的定时分析子进程。"""
        user_id = schedule.get("user_id")
        stock_codes = [
            str(code)
            for code in (schedule.get("stock_codes") or [])
            if str(code or "").strip()
        ]
        if not stock_codes:
            logger.warning("[PerUserScheduler] 用户 %s 自选股为空，跳过本次定时分析", user_id)
            return
        started = self._start_analysis_watchdog(
            stock_codes,
            owner_user_id=user_id,
            start_gate=self._build_user_quota_gate(int(user_id)),
        )
        if started:
            logger.info(
                "[PerUserScheduler] 已触发用户 %s 的定时分析（%d 只自选股）",
                user_id,
                len(stock_codes),
            )
            return
        # 全局分析锁被占用：记录含用户 id 的 busy-skip，5 分钟后仅重试一次。
        if not allow_retry:
            logger.warning(
                "[PerUserScheduler] 用户 %s 重试仍因已有分析执行被跳过，等待下一次排程",
                user_id,
            )
            return
        logger.warning(
            "[PerUserScheduler] 用户 %s 定时分析因已有分析执行被跳过，%d 秒后重试一次",
            user_id,
            PER_USER_SCHEDULE_RETRY_SECONDS,
        )
        self._run_in_background_thread(
            partial(self._retry_user_scheduled_analysis, schedule)
        )

    def _retry_user_scheduled_analysis(self, schedule: Dict[str, Any]) -> None:
        """锁占用后的唯一一次延迟重试（best-effort，失败即放弃到下一排程）。"""
        time.sleep(PER_USER_SCHEDULE_RETRY_SECONDS)
        self._run_user_scheduled_analysis(schedule, allow_retry=False)

    def _current_background_tasks(self, config: Config) -> List[Dict[str, Any]]:
        if self._background_tasks_provider is not None:
            return self._background_tasks_provider(config)
        return self._current_agent_event_monitor_background_tasks(config)

    def _current_agent_event_monitor_background_tasks(self, config: Config) -> List[Dict[str, Any]]:
        name = "agent_event_monitor"
        if not getattr(config, "agent_event_monitor_enabled", False):
            self._background_task_cache.pop(name, None)
            self._background_task_registered_names.discard(name)
            return []

        cached = self._background_task_cache.get(name)
        if cached is None:
            entries = build_agent_event_monitor_background_tasks(
                config,
                config_provider=self._reload_config,
            )
            if not entries:
                self._background_task_cache.pop(name, None)
                self._background_task_registered_names.discard(name)
                return []
            cached = dict(entries[0])
            cached["name"] = name
            self._background_task_cache[name] = cached
            interval_seconds = int(cached["interval_seconds"])
        else:
            interval_seconds = _agent_event_monitor_interval_seconds(config)

        run_immediately = (
            bool(cached.get("run_immediately", False))
            and name not in self._background_task_registered_names
        )
        self._background_task_registered_names.add(name)
        return [{
            "task": cached["task"],
            "interval_seconds": interval_seconds,
            "run_immediately": run_immediately,
            "name": name,
        }]

    @staticmethod
    def _run_in_background_thread(target: Callable[[], None]) -> None:
        """Run a callback in a background thread without blocking startup."""
        try:
            _thread.start_new_thread(target, ())
            return
        except Exception:
            # Best-effort fallback for environments where the low-level thread API
            # is unavailable or restricted.
            thread = threading.Thread(target=target, daemon=True)
            thread.start()

    def start(self, *, run_immediately: bool = False) -> None:
        with self._lock:
            if not self._owns_schedule:
                self.stop()
                return
            config = self._config_provider()
            per_user_mode = self._is_multi_user_mode()
            if not (per_user_mode or self._is_schedule_enabled(config)):
                self.stop()
                return
            background_tasks = self._current_background_tasks(config)
            self.stop()
            times = normalize_schedule_times(
                getattr(config, "schedule_times", None),
                fallback_time=getattr(config, "schedule_time", "18:00"),
            )
            scheduler = Scheduler(
                schedule_time=getattr(config, "schedule_time", "18:00"),
                schedule_times=times,
                schedule_times_provider=self._current_times,
                register_signals=False,
            )
            if per_user_mode:
                # 多用户模式：不注册全局每日任务（.env SCHEDULE_* 不触发运行），
                # 改为周期轮询用户排程并错峰分发，调度循环保持响应。
                scheduler.add_background_task(
                    self._per_user_schedule_tick,
                    interval_seconds=PER_USER_SCHEDULE_TICK_SECONDS,
                    run_immediately=False,
                    name=PER_USER_SCHEDULE_TASK_NAME,
                )
            else:
                with self._analysis_process_lock:
                    generation = self._analysis_generation
                scheduled_analysis = partial(
                    self._start_analysis_watchdog,
                    generation=generation,
                )
                if run_immediately and self._run_immediately_in_background:
                    scheduler.set_daily_task(scheduled_analysis, run_immediately=False)
                else:
                    scheduler.set_daily_task(
                        scheduled_analysis,
                        run_immediately=run_immediately,
                    )
            for entry in background_tasks:
                scheduler.add_background_task(
                    entry["task"],
                    interval_seconds=entry["interval_seconds"],
                    run_immediately=entry.get("run_immediately", False),
                    name=entry.get("name"),
                )
            if (
                not per_user_mode
                and run_immediately
                and self._run_immediately_in_background
            ):
                self._run_in_background_thread(scheduled_analysis)
            thread = threading.Thread(
                target=scheduler.run,
                daemon=True,
                name="runtime-scheduler",
            )
            self._scheduler = scheduler
            self._thread = thread
            self._enabled = True
            thread.start()

    def stop(self) -> None:
        with self._lock:
            with self._analysis_process_lock:
                self._analysis_generation += 1
                process = self._analysis_process
            scheduler = self._scheduler
            if scheduler is not None:
                scheduler.stop()
            if process is not None:
                _terminate_analysis_process_tree(process)
            self._scheduler = None
            self._thread = None
            self._enabled = False

    def reconcile_from_config(
        self,
        *,
        run_immediately: bool = False,
        clear_enabled_override: bool = False,
    ) -> None:
        if clear_enabled_override:
            self._force_enabled = False
        if not self._owns_schedule:
            self.stop()
            return
        config = self._config_provider()
        if self._is_schedule_enabled(config):
            self.start(run_immediately=run_immediately)
        else:
            self.stop()

    def run_now(self) -> Dict[str, Any]:
        if not self._start_analysis_watchdog():
            return {
                "accepted": False,
                "running": True,
                "reason": "analysis_already_running",
            }
        return {"accepted": True, "running": True}

    def is_background_task_active(self, name: str) -> bool:
        """Return whether a named task is registered on the live scheduler."""
        with self._lock:
            scheduler = self._scheduler
            thread = self._thread
            if (
                not self._enabled
                or scheduler is None
                or thread is None
                or not thread.is_alive()
            ):
                return False
            return any(
                str(entry.get("name") or "") == name
                for entry in getattr(scheduler, "_background_tasks", [])
            )

    def status(self) -> Dict[str, Any]:
        scheduler = self._scheduler
        per_user_mode = self._is_multi_user_mode()
        jobs = scheduler.schedule.get_jobs() if scheduler is not None else []
        next_run = None
        if jobs:
            next_run = min(job.next_run for job in jobs).isoformat()
        per_user_enabled_schedules: Optional[int] = None
        if per_user_mode:
            # 多用户模式：排程真源是用户配置，全局 SCHEDULE_* 不再代表执行计划；
            # 只暴露启用排程的用户数，不泄露任何用户的自选股内容。
            schedule_times: List[str] = []
            per_user_enabled_schedules = self._count_enabled_user_schedules()
        elif scheduler is not None:
            schedule_times = list(getattr(scheduler, "schedule_times", []))
        else:
            try:
                schedule_times = self._current_times()
            except Exception:  # pragma: no cover - defensive status fallback
                schedule_times = []
        running = self._run_lock.locked()
        return {
            "enabled": self._enabled,
            "running": running,
            "schedule_times": schedule_times,
            "next_run_at": next_run,
            "last_run_at": self._last_run_at,
            "last_success_at": self._last_success_at,
            "last_error": self._last_error,
            "last_skipped_at": self._last_skipped_at,
            "last_skip_reason": self._last_skip_reason,
            # 以下为新增的附加字段，保持既有响应结构向后兼容。
            "mode": "per_user" if per_user_mode else "global",
            "per_user_enabled_schedules": per_user_enabled_schedules,
        }

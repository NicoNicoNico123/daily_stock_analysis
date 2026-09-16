# -*- coding: utf-8 -*-
"""
===================================
筹码分布（CYQ）本地估算器
===================================

当东方财富筹码接口（ak.stock_cyq_em）与 Tushare cyq_chips 同时不可用时
（东财按 IP 限流，RemoteDisconnected 很常见），用日线量价数据离线估算筹码分布。

算法沿用经典的 CYQ 换手衰减模型（参考实现：github kengerlwl/ChipDistribution，
与东方财富前端 kline JS 版 CYQCalculator 同源）：

1. 在 [min(low)*0.98, max(high)*1.02] 上取 PRICE_BIN_COUNT 个价格档位；
2. 按时间从旧到新迭代每个交易日：
   - 存量筹码按 (1 - 换手率) 衰减；
   - 当日新增筹码（换手率 t_i）按"以当日均价为峰的三角分布"摊到
     [low_i*0.99, high_i*1.01] 区间（与东财 JS 版一致的三角形态，
     区间外扩 1% 用于容纳收盘价等于最高/最低的一字板情形）；
3. 汇总后计算获利比例、平均成本、90%/70% 成本区间与集中度。

换手率来源：
- 优先使用实时行情的当日换手率反推流通股本：float_shares = 当日成交量 / 换手率，
  再用每天的成交量 / float_shares 得到每日换手率；
- 无换手率时使用启发式：t_i = min(1, HEURISTIC_TURNOVER_SCALE * volume_i / median(volume))，
  即把"中位数成交量的交易日"近似为 3% 流通换手（A 股日常换手的常见量级），
  并按成交量相对中位数的比例缩放。该近似只影响衰减速度的绝对值，
  不影响筹码的相对价格分布形状。

纯计算，无任何 I/O，不落库；结果仅作为当次分析的临时输入。
"""

import logging
from typing import Any, Optional, Tuple

import numpy as np

from .realtime_types import ChipDistribution

logger = logging.getLogger(__name__)

# === 算法常量 ===
PRICE_BIN_COUNT = 200          # 价格档位数（东财 JS 版为 150，这里取 200 提升分位数精度）
PRICE_PAD_LOW = 0.98           # 价格下界 = min(low) * PRICE_PAD_LOW
PRICE_PAD_HIGH = 1.02          # 价格上界 = max(high) * PRICE_PAD_HIGH
DAILY_PRICE_PAD = 0.01         # 单日新增筹码区间外扩：[low*(1-pad), high*(1+pad)]
MAX_DAILY_TURNOVER = 1.0       # 单日换手上限（100%）
HEURISTIC_TURNOVER_SCALE = 0.03  # 启发式：中位数成交量 ≈ 3% 流通换手
TURNOVER_PERCENT_THRESHOLD = 1.5  # 换手率 > 1.5 视为百分数口径（本仓库 EM/东财均为 %）
MIN_BARS = 5                   # 少于该天数不做估算（结果不可信）
_PRICE_EPS = 1e-9


def _to_float(value: Any) -> Optional[float]:
    """宽松转 float，失败/NaN/inf 返回 None。"""
    try:
        if value is None:
            return None
        if isinstance(value, (np.floating, np.integer)):
            numeric = float(value)
        else:
            numeric = float(value)
    except (TypeError, ValueError):
        return None
    if np.isnan(numeric) or np.isinf(numeric):
        return None
    return numeric


def _format_date(value: Any) -> str:
    """把日线日期统一成 YYYY-MM-DD 字符串（兼容 Timestamp / date / str）。"""
    if value is None:
        return ""
    strftime = getattr(value, "strftime", None)
    if strftime is not None:
        try:
            return value.strftime("%Y-%m-%d")
        except (ValueError, TypeError):
            return str(value)
    text = str(value).strip()
    return text[:10] if len(text) >= 10 else text


def _extract_ohlcv(daily_bars: Any) -> Optional[Tuple[Any, np.ndarray, np.ndarray, np.ndarray, np.ndarray, Any]]:
    """
    从多种日线输入形态中提取 (dates, highs, lows, closes, volumes, opens)。

    支持 pandas DataFrame（STANDARD_COLUMNS：date/open/high/low/close/volume）
    以及由 dict 或带同名属性的行对象组成的序列。
    """
    if daily_bars is None:
        return None

    if hasattr(daily_bars, "columns") and hasattr(daily_bars, "__getitem__"):
        columns = {str(col).strip().lower(): col for col in daily_bars.columns}

        def _col(*names: str):
            for name in names:
                if name in columns:
                    return daily_bars[columns[name]]
            return None

        dates = _col("date", "日期", "time")
        opens = _col("open", "开盘")
        highs = _col("high", "最高")
        lows = _col("low", "最低")
        closes = _col("close", "收盘")
        volumes = _col("volume", "成交量")
    elif isinstance(daily_bars, (list, tuple)):
        if not daily_bars:
            return None
        first = daily_bars[0]

        def _values(name: str):
            values = []
            for row in daily_bars:
                if isinstance(row, dict):
                    value = row.get(name)
                else:
                    value = getattr(row, name, None)
                if value is None and isinstance(row, dict):
                    value = row.get(name.capitalize())
                values.append(value)
            return values

        dates = _values("date")
        opens = _values("open")
        highs = _values("high")
        lows = _values("low")
        closes = _values("close")
        volumes = _values("volume")
    else:
        return None

    if highs is None or lows is None or closes is None or volumes is None:
        return None

    def _as_array(values) -> Optional[np.ndarray]:
        if values is None:
            return None
        try:
            return np.asarray(
                [_to_float(v) for v in np.asarray(values).ravel().tolist()],
                dtype=float,
            )
        except (TypeError, ValueError):
            return None

    highs_arr = _as_array(highs)
    lows_arr = _as_array(lows)
    closes_arr = _as_array(closes)
    volumes_arr = _as_array(volumes)
    opens_arr = _as_array(opens) if opens is not None else None
    if highs_arr is None or lows_arr is None or closes_arr is None or volumes_arr is None:
        return None
    return dates, highs_arr, lows_arr, closes_arr, volumes_arr, opens_arr


def _normalize_turnover_rate(latest_turnover_rate: Any) -> Optional[float]:
    """归一化换手率为小数口径（0-1）。百分数口径（本仓库主流）自动 /100。"""
    rate = _to_float(latest_turnover_rate)
    if rate is None or rate <= 0:
        return None
    if rate > TURNOVER_PERCENT_THRESHOLD:
        rate = rate / 100.0
    if rate <= 0 or rate > MAX_DAILY_TURNOVER * 10:  # 明显异常（如把成交额当换手率）
        return None
    return rate


def _daily_turnovers(volumes: np.ndarray, latest_turnover_rate: Any) -> Tuple[np.ndarray, str]:
    """
    计算每日换手率序列（已截断到 MAX_DAILY_TURNOVER）。

    Returns:
        (turnovers, mode)：mode 为 "realtime"（实时换手率反推流通股本）或
        "heuristic"（中位数成交量近似）。
    """
    rate = _normalize_turnover_rate(latest_turnover_rate)
    latest_volume = float(volumes[-1]) if len(volumes) else 0.0
    if rate is not None and latest_volume > 0:
        float_shares = latest_volume / rate
        if float_shares > 0:
            return (
                np.minimum(MAX_DAILY_TURNOVER, volumes / float_shares),
                "realtime",
            )
    # 启发式：以"中位数成交量的交易日 ≈ 3% 流通换手"为锚，按量比缩放。
    # 取正成交量的中位数，避免长期停牌（大量零成交日）把锚点拉成 0。
    positive = volumes[volumes > 0]
    median_volume = float(np.median(positive)) if positive.size else 0.0
    if median_volume <= 0:
        median_volume = float(volumes[-1]) if len(volumes) else 0.0
    if median_volume <= 0:
        return np.zeros_like(volumes), "heuristic"
    return (
        np.minimum(
            MAX_DAILY_TURNOVER,
            HEURISTIC_TURNOVER_SCALE * volumes / median_volume,
        ),
        "heuristic",
    )


def _triangular_weights(
    grid: np.ndarray,
    day_high: float,
    day_low: float,
    day_avg: float,
) -> Optional[np.ndarray]:
    """
    单日新增筹码的三角分布权重（已归一化，sum == 1）。

    以当日均价为峰、[low*0.99, high*1.01] 为底的三角形；均价贴边（一字板等）
    时退化为另一侧的直角三角/均匀分布，避免除零。
    """
    win_low = day_low * (1.0 - DAILY_PRICE_PAD)
    win_high = day_high * (1.0 + DAILY_PRICE_PAD)
    if not (win_high > win_low > 0):
        return None

    weights = np.zeros_like(grid)
    mask = (grid >= win_low) & (grid <= win_high)
    if not mask.any():
        return None

    prices = grid[mask]
    left_denom = max(day_avg - win_low, _PRICE_EPS)
    right_denom = max(win_high - day_avg, _PRICE_EPS)
    weights[mask] = np.where(
        prices <= day_avg,
        (prices - win_low) / left_denom,
        (win_high - prices) / right_denom,
    )

    total = weights.sum()
    if total <= 0:
        return None
    return weights / total


def compute_chip_distribution(
    daily_bars: Any,
    current_price: Any = None,
    latest_turnover_rate: Any = None,
    *,
    code: str = "",
    date: Any = None,
) -> Optional[ChipDistribution]:
    """
    用日线量价数据估算筹码分布。

    Args:
        daily_bars: 日线数据（DataFrame 或行序列），从旧到新，建议 90-120 根，
            需要 high/low/close/volume 列（open 可选，用于三角分布峰值）。
        current_price: 当前价（获利比例基准）；缺省用日线最后一根收盘价。
        latest_turnover_rate: 实时行情换手率（% 或小数），用于反推流通股本；
            缺省时用中位数成交量启发式近似。
        code: 股票代码（写入返回对象）。
        date: 记录日期（写入返回对象），缺省取日线最后一根的日期。

    Returns:
        ChipDistribution（source="computed"），数据不足或无法计算时返回 None。
    """
    extracted = _extract_ohlcv(daily_bars)
    if extracted is None:
        logger.debug("[筹码估算] 日线数据为空或缺少 high/low/close/volume 列")
        return None

    dates, highs, lows, closes, volumes, opens = extracted
    bar_count = len(closes)
    if bar_count < MIN_BARS:
        logger.debug("[筹码估算] 日线不足 %s 根，跳过本地估算 (实际 %s)", MIN_BARS, bar_count)
        return None

    volumes = np.where(np.isnan(volumes), 0.0, np.maximum(volumes, 0.0))

    # 价格必须全部为正数，否则价格网格与权重都不可信
    highs_arr: list = []
    lows_arr: list = []
    closes_arr: list = []
    for idx in range(bar_count):
        high = _to_float(highs[idx])
        low = _to_float(lows[idx])
        close = _to_float(closes[idx])
        if high is None or low is None or close is None or high <= 0 or low <= 0 or close <= 0:
            logger.debug("[筹码估算] 第 %s 根日线存在非法价格，跳过本地估算", idx)
            return None
        highs_arr.append(high)
        lows_arr.append(low)
        closes_arr.append(close)
    highs = np.asarray(highs_arr, dtype=float)
    lows = np.asarray(lows_arr, dtype=float)
    closes = np.asarray(closes_arr, dtype=float)

    if float(np.nansum(volumes)) <= 0:
        logger.debug("[筹码估算] 日线成交量全为 0，无法估算筹码分布")
        return None

    price = _to_float(current_price)
    if price is None or price <= 0:
        price = float(closes[-1])

    grid_low = float(np.min(lows)) * PRICE_PAD_LOW
    grid_high = float(np.max(highs)) * PRICE_PAD_HIGH
    if not (grid_high > grid_low > 0):
        logger.debug("[筹码估算] 价格区间非法 (%s, %s)", grid_low, grid_high)
        return None

    grid = np.linspace(grid_low, grid_high, PRICE_BIN_COUNT)
    chips = np.zeros(PRICE_BIN_COUNT, dtype=float)
    turnovers, turnover_mode = _daily_turnovers(volumes, latest_turnover_rate)

    for idx in range(bar_count):
        turnover = float(turnovers[idx])
        if turnover <= 0:
            continue
        chips *= 1.0 - turnover
        if opens is not None and _to_float(opens[idx]) and _to_float(opens[idx]) > 0:
            day_avg = (
                float(opens[idx]) + float(highs[idx]) + float(lows[idx]) + float(closes[idx])
            ) / 4.0
        else:
            day_avg = (
                float(highs[idx]) + float(lows[idx]) + float(closes[idx])
            ) / 3.0
        weights = _triangular_weights(grid, float(highs[idx]), float(lows[idx]), day_avg)
        if weights is None:
            continue
        chips += turnover * weights

    total = float(chips.sum())
    if total <= 0:
        logger.debug("[筹码估算] 筹码总量为 0，无法估算筹码分布")
        return None

    # 获利比例：现价以下（含）筹码占比
    profit_ratio = float(chips[grid <= price + _PRICE_EPS].sum() / total)
    profit_ratio = min(max(profit_ratio, 0.0), 1.0)

    avg_cost = float(np.dot(grid, chips) / total)
    if avg_cost <= 0:
        return None

    cumulative = np.cumsum(chips) / total

    def _quantile(q: float) -> float:
        position = int(np.searchsorted(cumulative, q, side="left"))
        return float(grid[min(max(position, 0), PRICE_BIN_COUNT - 1)])

    cost_90_low = _quantile(0.05)
    cost_90_high = _quantile(0.95)
    cost_70_low = _quantile(0.15)
    cost_70_high = _quantile(0.85)

    def _concentration(low: float, high: float) -> float:
        if high + low <= 0:
            return 0.0
        return max((high - low) / (high + low), 0.0)

    concentration_90 = _concentration(cost_90_low, cost_90_high)
    concentration_70 = _concentration(cost_70_low, cost_70_high)

    record_date = _format_date(date) if date is not None else ""
    if not record_date and dates is not None:
        try:
            record_date = _format_date(np.asarray(dates).ravel()[-1])
        except (IndexError, TypeError, ValueError):
            record_date = ""

    return ChipDistribution(
        code=code,
        date=record_date,
        source="computed",
        profit_ratio=round(profit_ratio, 6),
        avg_cost=round(avg_cost, 6),
        cost_90_low=round(cost_90_low, 6),
        cost_90_high=round(cost_90_high, 6),
        concentration_90=round(concentration_90, 6),
        cost_70_low=round(cost_70_low, 6),
        cost_70_high=round(cost_70_high, 6),
        concentration_70=round(concentration_70, 6),
    )

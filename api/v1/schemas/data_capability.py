# -*- coding: utf-8 -*-
"""Data source capability and dataset quality schemas."""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


ProviderCapabilityStatus = Literal[
    "ok",
    "partial",
    "unconfigured",
    "unavailable",
    "unknown",
]
DatasetQualityStatus = Literal[
    "ok",
    "degraded",
    "partial",
    "unconfigured",
    "unavailable",
    "unknown",
    "stale",
]


class DataProviderCapability(BaseModel):
    """Visible capability metadata for one data provider."""

    name: str = Field(..., description="Stable provider token")
    label: str = Field("", description="Human-readable provider name")
    enabled: bool = Field(..., description="Whether the provider is enabled for runtime routing")
    configured: bool = Field(..., description="Whether required configuration is present")
    status: ProviderCapabilityStatus = Field(..., description="Configuration/runtime availability summary")
    priority: Optional[int] = Field(None, description="Runtime fetcher priority when available")
    markets: List[str] = Field(default_factory=list, description="Supported markets")
    datasets: List[str] = Field(default_factory=list, description="Supported dataset identifiers")
    dataset_markets: Dict[str, List[str]] = Field(
        default_factory=dict,
        description="Exact supported markets for each dataset; consumers must not infer a markets × datasets cross-product",
    )
    warnings: List[str] = Field(default_factory=list, description="Stable warning codes")
    last_error: Optional[str] = Field(None, description="Last known non-sensitive error summary")
    cooldown: Optional[bool] = Field(None, description="Whether the provider is currently in cooldown")


class DataDatasetQuality(BaseModel):
    """Dataset-level quality view consumed by dashboards and data center."""

    dataset: str = Field(..., description="Stable dataset identifier")
    status: DatasetQualityStatus = Field(..., description="Current quality status")
    source: Optional[str] = Field(None, description="Selected source token when known")
    stale: Optional[bool] = Field(None, description="Whether the data is known stale")
    last_success: Optional[str] = Field(None, description="Last successful load timestamp")
    last_error: Optional[str] = Field(None, description="Last non-sensitive error summary")
    fallback_from: List[str] = Field(default_factory=list, description="Earlier priority sources skipped before selected source")
    coverage: Optional[Dict[str, Any]] = Field(None, description="Optional dataset coverage summary")
    warnings: List[str] = Field(default_factory=list, description="Stable warning codes")


class DataPriorityView(BaseModel):
    """Configured provider order for one usage scenario."""

    scenario: str = Field(..., description="Stable scenario identifier")
    providers: List[str] = Field(default_factory=list, description="Configured provider/source tokens")
    source: str = Field("", description="Where this priority list comes from")
    warnings: List[str] = Field(default_factory=list, description="Stable warning codes")


class DataCapabilityOverviewResponse(BaseModel):
    """Read-only data capability and dataset quality overview."""

    as_of: str
    providers: List[DataProviderCapability] = Field(default_factory=list)
    datasets: List[DataDatasetQuality] = Field(default_factory=list)
    priorities: List[DataPriorityView] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)


class DailyKlinePoint(BaseModel):
    """Single daily K-line point for charting."""

    date: str = Field(..., description="交易日 YYYY-MM-DD，升序")
    open: float = Field(..., description="开盘价")
    high: float = Field(..., description="最高价")
    low: float = Field(..., description="最低价")
    close: float = Field(..., description="收盘价")
    volume: Optional[float] = Field(None, description="成交量（缺失时为 null）")


class DailyKlineResponse(BaseModel):
    """Daily K-line response for the report price chart."""

    code: str = Field(..., description="规范化后的股票代码")
    points: List[DailyKlinePoint] = Field(default_factory=list, description="日 K 数据点，按日期升序")

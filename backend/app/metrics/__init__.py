"""Shared return, XIRR, and cash-flow-adjusted drawdown calculations."""

from .engine import METRIC_METHOD_VERSION, calculate_metrics, calculate_xirr
from .types import MetricsInput, MetricsResult

__all__ = [
    "METRIC_METHOD_VERSION",
    "MetricsInput",
    "MetricsResult",
    "calculate_metrics",
    "calculate_xirr",
]

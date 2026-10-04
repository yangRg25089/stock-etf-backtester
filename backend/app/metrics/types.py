"""Metric calculation input and output contracts."""

from dataclasses import dataclass

from app.calendar import ScheduleResult
from app.domain.contracts import (
    DailyAsset,
    FrozenStrategyInstance,
    MetricSummary,
)
from app.domain.performance import AnalysisSettings
from app.domain.status import DomainModel
from app.ledger import LedgerResult


@dataclass(frozen=True, slots=True)
class MetricsInput:
    """Frozen ledger context needed to calculate comparable performance."""

    strategy: FrozenStrategyInstance
    schedule: ScheduleResult
    ledger: LedgerResult
    data_fingerprint: str
    analysis_settings: AnalysisSettings | None = None


class MetricsResult(DomainModel):
    """Summary metrics and the cash-flow-adjusted daily unit-value series."""

    summary: MetricSummary
    daily_assets: tuple[DailyAsset, ...]

"""Run-time data provider boundary for the local orchestration layer."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

from pydantic import model_validator

from app.calendar import ExchangeCalendar
from app.config.validation import DataRequirement
from app.domain.contracts import (
    DataSnapshot,
    FrozenStrategyInstance,
    SharedSettings,
)
from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    DiagnosticSeverity,
    DomainModel,
)


class StrategyDataLoad(DomainModel):
    """Normalized data and its calendar for one selected strategy."""

    calendar: ExchangeCalendar | None = None
    snapshot: DataSnapshot | None = None
    diagnostics: tuple[Diagnostic, ...] = ()

    @model_validator(mode="after")
    def require_complete_context(self) -> StrategyDataLoad:
        if (self.calendar is None) != (self.snapshot is None):
            raise ValueError("calendar and data snapshot must be loaded together")
        if self.snapshot is None and not self.diagnostics:
            raise ValueError("missing strategy data requires a diagnostic")
        return self


class RunDataProvider(Protocol):
    """Load provider-neutral data independently for one selected strategy."""

    version: str

    def load_for_strategy(
        self,
        *,
        shared: SharedSettings,
        strategy: FrozenStrategyInstance,
        requirements: Sequence[DataRequirement],
    ) -> StrategyDataLoad: ...


class UnconfiguredRunDataProvider:
    """Report missing local data integration without fabricating a result."""

    version = "no-provider-v1"

    def load_for_strategy(
        self,
        *,
        shared: SharedSettings,
        strategy: FrozenStrategyInstance,
        requirements: Sequence[DataRequirement],
    ) -> StrategyDataLoad:
        return StrategyDataLoad(
            diagnostics=(
                Diagnostic(
                    code=DiagnosticCode.PROVIDER_REQUEST_FAILED,
                    severity=DiagnosticSeverity.ERROR,
                    messageKey="data.provider_not_configured",
                    fieldPath="run.symbol",
                    details={
                        "strategyId": strategy.id,
                        "symbol": shared.run.symbol,
                        "requiredKinds": sorted(
                            {requirement.kind.value for requirement in requirements}
                        ),
                    },
                ),
            )
        )

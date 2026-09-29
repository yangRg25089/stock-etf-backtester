"""Serializable output of the shared, pure trading ledger."""

from pydantic import Field, model_validator

from app.domain.contracts import DailyAsset, SignalEvaluation, Trade, UnexecutedSignal
from app.domain.status import Diagnostic, DomainModel


class LedgerResult(DomainModel):
    """One strategy's ledger output before performance metrics are attached."""

    strategy_id: str = Field(alias="strategyId", min_length=1)
    available: bool = True
    diagnostics: tuple[Diagnostic, ...] = ()
    signals: tuple[SignalEvaluation, ...] = ()
    unexecuted_signals: tuple[UnexecutedSignal, ...] = Field(
        default=(), alias="unexecutedSignals"
    )
    trades: tuple[Trade, ...] = ()
    daily_assets: tuple[DailyAsset, ...] = Field(default=(), alias="dailyAssets")

    @model_validator(mode="after")
    def validate_unavailable_result(self) -> "LedgerResult":
        if not self.available and not self.diagnostics:
            raise ValueError("unavailable ledger results require diagnostics")
        if not self.available and (self.trades or self.daily_assets):
            raise ValueError(
                "unavailable ledger results must not contain partial output"
            )
        return self

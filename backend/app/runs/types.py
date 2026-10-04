"""Immutable inputs and records exchanged with the local run service."""

from pydantic import Field, model_validator

from app.config.validation import DataRequirement, StrategyValidationResult
from app.domain.contracts import (
    FrozenRunConfig,
    MetricSummary,
    RunResult,
    RunScope,
    RunSnapshot,
)
from app.domain.status import (
    Diagnostic,
    DomainModel,
    StrategyStatus,
    is_success,
    is_terminal,
)


class RunSubmission(DomainModel):
    """Validated, frozen selection passed from HTTP to the run service."""

    config: FrozenRunConfig
    scope: RunScope
    selected_strategy_ids: tuple[str, ...] = Field(alias="selectedStrategyIds")
    catalog_version: str = Field(alias="catalogVersion", min_length=1)
    engine_version: str = Field(alias="engineVersion", min_length=1)
    strategy_validations: tuple[StrategyValidationResult, ...] = Field(
        alias="strategyValidations"
    )
    data_requirements: tuple[DataRequirement, ...] = Field(
        default=(), alias="dataRequirements"
    )

    @model_validator(mode="after")
    def validate_selection(self) -> "RunSubmission":
        config_ids = tuple(strategy.id for strategy in self.config.strategies)
        validation_ids = tuple(
            result.strategy_id for result in self.strategy_validations
        )
        if not config_ids or config_ids != self.selected_strategy_ids:
            raise ValueError("submission must freeze every selected strategy")
        if validation_ids != self.selected_strategy_ids:
            raise ValueError("submission validation must match selected strategies")
        if self.scope is RunScope.ACTIVE and len(config_ids) != 1:
            raise ValueError("active scope must select exactly one strategy")
        return self


class RunProgress(DomainModel):
    completed_strategies: int = Field(alias="completedStrategies", ge=0)
    total_strategies: int = Field(alias="totalStrategies", ge=1)
    current_strategy_id: str | None = Field(
        default=None, alias="currentStrategyId", min_length=1
    )

    @model_validator(mode="after")
    def completed_does_not_exceed_total(self) -> "RunProgress":
        if self.completed_strategies > self.total_strategies:
            raise ValueError("completed strategy count cannot exceed total")
        return self


class RunResponse(DomainModel):
    """Current status, progress, immutable inputs, and saved results."""

    run_id: str = Field(alias="runId", min_length=1)
    status: StrategyStatus
    selected_strategy_ids: tuple[str, ...] = Field(alias="selectedStrategyIds")
    progress: RunProgress | None = None
    snapshot: RunSnapshot
    result: RunResult | None = None

    @model_validator(mode="after")
    def run_identity_matches_children(self) -> "RunResponse":
        if self.snapshot.run_id != self.run_id:
            raise ValueError("run response snapshot identity does not match")
        snapshot_ids = tuple(
            strategy.id for strategy in self.snapshot.config.strategies
        )
        if snapshot_ids != self.selected_strategy_ids:
            raise ValueError("run response snapshot must preserve selected strategies")
        if self.result is not None and self.result.run_id != self.run_id:
            raise ValueError("run response result identity does not match")
        if not self.selected_strategy_ids:
            raise ValueError("run response must preserve a selected strategy")
        if len(set(self.selected_strategy_ids)) != len(self.selected_strategy_ids):
            raise ValueError("selected strategy IDs must be unique")
        return self


class RunStrategySummary(DomainModel):
    """A terminal strategy's saved metrics and diagnostics in a small event."""

    metrics: MetricSummary | None = None
    diagnostics: tuple[Diagnostic, ...] = ()


class RunProgressEvent(DomainModel):
    """JSON data inside an SSE frame; states are the same as full run responses."""

    run_id: str = Field(alias="runId", min_length=1)
    status: StrategyStatus
    progress: RunProgress | None
    strategy_statuses: dict[str, StrategyStatus] = Field(
        alias="strategyStatuses", max_length=34
    )
    strategy_summaries: dict[str, RunStrategySummary] = Field(
        default_factory=dict, alias="strategySummaries", max_length=34
    )

    @model_validator(mode="after")
    def consistent_terminal_data(self) -> "RunProgressEvent":
        if (
            is_terminal(self.status)
            and self.progress is not None
            and self.progress.completed_strategies != self.progress.total_strategies
        ):
            raise ValueError("a terminal event must count every strategy as finished")
        if is_terminal(self.status) and any(
            not is_terminal(status) for status in self.strategy_statuses.values()
        ):
            raise ValueError("a terminal event cannot contain unfinished strategies")
        for strategy_id, summary in self.strategy_summaries.items():
            status = self.strategy_statuses.get(strategy_id)
            if status is None or not is_terminal(status):
                raise ValueError("summaries must belong to terminal strategies")
            if is_success(status) and summary.metrics is None:
                raise ValueError("successful summaries require saved metrics")
            if (
                status in {StrategyStatus.FAILED, StrategyStatus.UNAVAILABLE}
                and not summary.diagnostics
            ):
                raise ValueError("unsuccessful summaries require a diagnosis")
        return self

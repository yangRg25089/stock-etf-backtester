"""Immutable inputs and records exchanged with the local run service."""

from pydantic import Field, model_validator

from app.config.validation import DataRequirement, StrategyValidationResult
from app.domain.contracts import (
    FrozenRunConfig,
    RunResult,
    RunScope,
    RunSnapshot,
)
from app.domain.status import DomainModel, StrategyStatus


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
        if any(not result.enabled for result in self.strategy_validations):
            raise ValueError("only enabled strategy validations may be submitted")
        if any(not strategy.enabled for strategy in self.config.strategies):
            raise ValueError("only enabled strategies may be submitted")
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

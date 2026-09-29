"""Stable request and response contracts for the versioned HTTP API."""

from collections.abc import Mapping
from hashlib import sha256
from json import dumps

from pydantic import Field, field_serializer, field_validator, model_validator

from app.config.validation import DataRequirement, StrategyValidationResult
from app.domain.contracts import (
    FrozenRunConfig,
    RunResult,
    RunScope,
    RunSnapshot,
    SharedSettings,
)
from app.domain.immutability import FrozenMap, freeze_mapping, thaw_value
from app.domain.status import Diagnostic, DomainModel, StrategyStatus


class DraftValidationRequest(DomainModel):
    draft: Mapping[str, object]

    @field_validator("draft", mode="after")
    @classmethod
    def freeze_draft(cls, value: Mapping[str, object]) -> FrozenMap:
        return freeze_mapping(value)

    @field_serializer("draft")
    def serialize_draft(self, value: Mapping[str, object]) -> object:
        return thaw_value(value)


class DraftValidationResponse(DomainModel):
    valid: bool
    shared_settings: SharedSettings | None = Field(default=None, alias="sharedSettings")
    diagnostics: tuple[Diagnostic, ...] = ()
    strategies: tuple[StrategyValidationResult, ...] = ()
    data_requirements: tuple[DataRequirement, ...] = Field(
        default=(), alias="dataRequirements"
    )


class RunSubmissionRequest(DomainModel):
    draft: Mapping[str, object]
    scope: RunScope
    active_strategy_id: str | None = Field(default=None, alias="activeStrategyId")

    @field_validator("draft", mode="after")
    @classmethod
    def freeze_draft(cls, value: Mapping[str, object]) -> FrozenMap:
        return freeze_mapping(value)


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


class ContractVersionResponse(DomainModel):
    api_version: str = Field(alias="apiVersion")
    contract_version: str = Field(alias="contractVersion")
    openapi_url: str = Field(alias="openapiUrl")

    @classmethod
    def from_openapi(cls, schema: Mapping[str, object]) -> "ContractVersionResponse":
        serialized = dumps(schema, sort_keys=True, separators=(",", ":"))
        fingerprint = sha256(serialized.encode("utf-8")).hexdigest()[:16]
        return cls(
            apiVersion="v1",
            contractVersion=fingerprint,
            openapiUrl="/openapi.json",
        )


class APIError(DomainModel):
    code: str = Field(min_length=1)
    message_key: str = Field(alias="messageKey", min_length=1)
    diagnostics: tuple[Diagnostic, ...] = ()


class APIErrorResponse(DomainModel):
    error: APIError

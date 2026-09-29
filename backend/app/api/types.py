"""Stable request and response contracts for the versioned HTTP API."""

from collections.abc import Mapping
from hashlib import sha256
from json import dumps

from pydantic import Field, field_serializer, field_validator

from app.config.validation import DataRequirement, StrategyValidationResult
from app.domain.contracts import (
    RunScope,
    SharedSettings,
)
from app.domain.immutability import FrozenMap, freeze_mapping, thaw_value
from app.domain.status import Diagnostic, DomainModel
from app.runs.types import RunProgress, RunResponse, RunSubmission

__all__ = [
    "DraftValidationRequest",
    "DraftValidationResponse",
    "RunProgress",
    "RunResponse",
    "RunSubmission",
    "RunSubmissionRequest",
]


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

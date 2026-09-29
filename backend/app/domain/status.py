"""Stable execution, signal, and diagnostic values shared by domain consumers."""

from collections.abc import Mapping
from datetime import date
from enum import StrEnum
from typing import Final

from pydantic import BaseModel, ConfigDict, Field, field_serializer, field_validator


class DomainModel(BaseModel):
    """Base configuration for immutable, serializable domain contracts."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        str_strip_whitespace=True,
    )


class StrategyStatus(StrEnum):
    """Statuses emitted for a job and for each strategy result."""

    QUEUED = "queued"
    LOADING = "loading"
    RUNNING = "running"
    COMPLETED = "completed"
    COMPLETED_WITH_WARNING = "completed_with_warning"
    UNAVAILABLE = "unavailable"
    FAILED = "failed"


# ``RunStatus`` is a descriptive alias for callers that model the whole job.
RunStatus = StrategyStatus


class ResultPageState(StrEnum):
    """Result-view state; ``empty`` means that no job exists yet."""

    EMPTY = "empty"
    QUEUED = StrategyStatus.QUEUED.value
    LOADING = StrategyStatus.LOADING.value
    RUNNING = StrategyStatus.RUNNING.value
    COMPLETED = StrategyStatus.COMPLETED.value
    COMPLETED_WITH_WARNING = StrategyStatus.COMPLETED_WITH_WARNING.value
    UNAVAILABLE = StrategyStatus.UNAVAILABLE.value
    FAILED = StrategyStatus.FAILED.value


class SignalState(StrEnum):
    """Three-valued state for every enabled daily signal dependency."""

    TRUE = "true"
    FALSE = "false"
    UNAVAILABLE = "unavailable"


class DiagnosticSeverity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"


class DiagnosticCode(StrEnum):
    """Machine-readable diagnostics; localized text belongs to the UI dictionary."""

    INVALID_PARAMETER = "invalid_parameter"
    REQUIRED_DATA_UNAVAILABLE = "required_data_unavailable"
    PROVIDER_REQUEST_FAILED = "provider_request_failed"
    CALCULATION_FAILED = "calculation_failed"
    SOURCE_QUALITY_WARNING = "source_quality_warning"
    STALE_DATA = "stale_data"
    UNKNOWN_SOURCE_UNIT = "unknown_source_unit"
    PRICE_BASIS_UNAVAILABLE = "price_basis_unavailable"
    NO_VALID_CONTRIBUTION = "no_valid_contribution"
    NO_VALID_XIRR = "no_valid_xirr"
    COMPARISON_UNAVAILABLE = "comparison_unavailable"
    INVALID_STATUS_TRANSITION = "invalid_status_transition"
    RUN_INTERRUPTED = "run_interrupted"


class Diagnostic(DomainModel):
    """A structured reason that can be rendered through a translation key."""

    code: DiagnosticCode
    severity: DiagnosticSeverity = DiagnosticSeverity.ERROR
    message_key: str = Field(alias="messageKey", min_length=1)
    field_path: str | None = Field(default=None, alias="fieldPath", min_length=1)
    as_of: date | None = Field(default=None, alias="asOf")
    source: str | None = Field(default=None, min_length=1)
    details: Mapping[str, object] = Field(default_factory=dict, validate_default=True)

    @field_validator("details", mode="after")
    @classmethod
    def _freeze_details(cls, value: Mapping[str, object]) -> Mapping[str, object]:
        from app.domain.immutability import freeze_mapping

        return freeze_mapping(value)

    @field_serializer("details")
    def _serialize_details(self, value: Mapping[str, object]) -> object:
        from app.domain.immutability import thaw_value

        return thaw_value(value)


class StatusTransitionError(ValueError):
    """Raised when a result attempts to move between incompatible states."""

    def __init__(self, current: StrategyStatus, target: StrategyStatus) -> None:
        self.current = current
        self.target = target
        super().__init__(
            f"invalid status transition: {current.value} -> {target.value}"
        )


_STATUS_TRANSITIONS: Final[dict[StrategyStatus, frozenset[StrategyStatus]]] = {
    StrategyStatus.QUEUED: frozenset(
        {
            StrategyStatus.QUEUED,
            StrategyStatus.LOADING,
            StrategyStatus.UNAVAILABLE,
            StrategyStatus.FAILED,
        }
    ),
    StrategyStatus.LOADING: frozenset(
        {
            StrategyStatus.LOADING,
            StrategyStatus.RUNNING,
            StrategyStatus.UNAVAILABLE,
            StrategyStatus.FAILED,
        }
    ),
    StrategyStatus.RUNNING: frozenset(
        {
            StrategyStatus.RUNNING,
            StrategyStatus.COMPLETED,
            StrategyStatus.COMPLETED_WITH_WARNING,
            StrategyStatus.UNAVAILABLE,
            StrategyStatus.FAILED,
        }
    ),
    StrategyStatus.COMPLETED: frozenset({StrategyStatus.COMPLETED}),
    StrategyStatus.COMPLETED_WITH_WARNING: frozenset(
        {StrategyStatus.COMPLETED_WITH_WARNING}
    ),
    StrategyStatus.UNAVAILABLE: frozenset({StrategyStatus.UNAVAILABLE}),
    StrategyStatus.FAILED: frozenset({StrategyStatus.FAILED}),
}


def can_transition(current: StrategyStatus, target: StrategyStatus) -> bool:
    """Return whether a status update is allowed by the shared state machine."""

    current_status = StrategyStatus(current)
    target_status = StrategyStatus(target)
    return target_status in _STATUS_TRANSITIONS[current_status]


def transition_status(
    current: StrategyStatus, target: StrategyStatus
) -> StrategyStatus:
    """Validate and return ``target`` as the next status."""

    current_status = StrategyStatus(current)
    target_status = StrategyStatus(target)
    if not can_transition(current_status, target_status):
        raise StatusTransitionError(current_status, target_status)
    return target_status


def is_terminal(status: StrategyStatus) -> bool:
    """Return whether a strategy cannot move to another execution state."""

    return StrategyStatus(status) in {
        StrategyStatus.COMPLETED,
        StrategyStatus.COMPLETED_WITH_WARNING,
        StrategyStatus.UNAVAILABLE,
        StrategyStatus.FAILED,
    }


def is_success(status: StrategyStatus) -> bool:
    """Completed results include zero-trade runs; warnings remain successful."""

    return StrategyStatus(status) in {
        StrategyStatus.COMPLETED,
        StrategyStatus.COMPLETED_WITH_WARNING,
    }

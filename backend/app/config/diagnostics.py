"""Factories for the stable diagnostic contract used by config and runs."""

from collections.abc import Mapping
from enum import StrEnum

from app.catalog.definitions import ParameterValueIssue
from app.domain.status import Diagnostic, DiagnosticCode, DiagnosticSeverity


class ConfigurationIssue(StrEnum):
    """Localized reason keys beneath the shared invalid-parameter code."""

    REQUIRED = "required_value_missing"
    EMPTY_VALUE = "empty_value"
    INVALID_TYPE = "invalid_type"
    INVALID_VALUE = "invalid_value"
    OUT_OF_RANGE = "out_of_range"
    INVALID_CHOICE = "invalid_choice"
    INVALID_COLLECTION = "invalid_collection"
    UNKNOWN_PARAMETER = "unknown_parameter"
    NOT_APPLICABLE = "not_applicable"
    CROSS_FIELD = "cross_field"
    TOO_MANY_COMBINATIONS = "too_many_combinations"
    DUPLICATE_CONDITION = "duplicate_condition"
    DUPLICATE_STRATEGY = "duplicate_strategy"
    TOO_MANY_STRATEGIES = "too_many_strategies"


_PARAMETER_ISSUES: dict[ParameterValueIssue, ConfigurationIssue] = {
    ParameterValueIssue.REQUIRED: ConfigurationIssue.REQUIRED,
    ParameterValueIssue.EMPTY_VALUE: ConfigurationIssue.EMPTY_VALUE,
    ParameterValueIssue.INVALID_TYPE: ConfigurationIssue.INVALID_TYPE,
    ParameterValueIssue.INVALID_VALUE: ConfigurationIssue.INVALID_VALUE,
    ParameterValueIssue.OUT_OF_RANGE: ConfigurationIssue.OUT_OF_RANGE,
    ParameterValueIssue.INVALID_CHOICE: ConfigurationIssue.INVALID_CHOICE,
    ParameterValueIssue.INVALID_COLLECTION: ConfigurationIssue.INVALID_COLLECTION,
}


def invalid_parameter(
    *,
    issue: ConfigurationIssue | ParameterValueIssue,
    field_path: str,
    details: Mapping[str, object] | None = None,
) -> Diagnostic:
    """Build a stable parameter diagnostic without exposing raw input values."""

    stable_issue = (
        _PARAMETER_ISSUES[issue] if isinstance(issue, ParameterValueIssue) else issue
    )
    return Diagnostic(
        code=DiagnosticCode.INVALID_PARAMETER,
        severity=DiagnosticSeverity.ERROR,
        messageKey=f"diagnostics.configuration.{stable_issue.value}",
        fieldPath=field_path,
        details={} if details is None else details,
    )


def required_data_unavailable(
    *,
    field_path: str,
    data_kind: str,
    symbol: str,
    signal_id: str,
    strategy_id: str,
) -> Diagnostic:
    """Build a missing-capability diagnostic for one enabled dependency."""

    return Diagnostic(
        code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
        severity=DiagnosticSeverity.ERROR,
        messageKey="diagnostics.data.required_unavailable",
        fieldPath=field_path,
        details={
            "dataKind": data_kind,
            "signalId": signal_id,
            "strategyId": strategy_id,
            "symbol": symbol,
        },
    )


def provider_request_failed(
    *,
    source: str,
    field_path: str | None = None,
    details: Mapping[str, object] | None = None,
) -> Diagnostic:
    """Build a provider failure diagnostic distinct from validation/missing data."""

    return Diagnostic(
        code=DiagnosticCode.PROVIDER_REQUEST_FAILED,
        severity=DiagnosticSeverity.ERROR,
        messageKey="diagnostics.provider.request_failed",
        fieldPath=field_path,
        source=source,
        details={} if details is None else details,
    )

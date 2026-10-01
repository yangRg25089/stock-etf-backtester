from datetime import date

import pytest

from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    DiagnosticSeverity,
    ResultPageState,
    SignalState,
    StatusTransitionError,
    StrategyStatus,
    can_transition,
    transition_status,
)


def test_strategy_status_values_match_the_shared_contract() -> None:
    assert [status.value for status in StrategyStatus] == [
        "queued",
        "loading",
        "running",
        "completed",
        "completed_with_warning",
        "unavailable",
        "failed",
        "cancelled",
    ]
    assert ResultPageState.EMPTY.value == "empty"


def test_valid_status_transition_advances_a_run() -> None:
    assert can_transition(StrategyStatus.QUEUED, StrategyStatus.LOADING)
    assert transition_status(StrategyStatus.QUEUED, StrategyStatus.LOADING) == (
        StrategyStatus.LOADING
    )


def test_terminal_status_cannot_return_to_running() -> None:
    assert not can_transition(StrategyStatus.COMPLETED, StrategyStatus.RUNNING)

    with pytest.raises(StatusTransitionError):
        transition_status(StrategyStatus.COMPLETED, StrategyStatus.RUNNING)


def test_signal_unavailability_carries_a_structured_reason_without_ui_copy() -> None:
    diagnostic = Diagnostic(
        code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
        severity=DiagnosticSeverity.ERROR,
        message_key="diagnostics.required_data_unavailable",
        field_path="vix.symbol",
        as_of=date(2024, 1, 2),
    )

    assert SignalState.UNAVAILABLE.value == "unavailable"
    assert diagnostic.code is DiagnosticCode.REQUIRED_DATA_UNAVAILABLE
    assert diagnostic.message_key == "diagnostics.required_data_unavailable"
    assert diagnostic.field_path == "vix.symbol"
    assert diagnostic.as_of == date(2024, 1, 2)
    assert diagnostic.model_dump(by_alias=True)["messageKey"] == (
        "diagnostics.required_data_unavailable"
    )
    assert diagnostic.model_dump_json()
    with pytest.raises(TypeError):
        diagnostic.details["sourceValue"] = 1

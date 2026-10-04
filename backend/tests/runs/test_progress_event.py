"""SSE data shares the run status and saved-summary contract."""

import pytest
from pydantic import ValidationError

from app.domain.status import StrategyStatus, is_terminal
from app.runs.types import RunProgressEvent


@pytest.mark.parametrize("status", list(StrategyStatus))
def test_each_run_phase_round_trips_without_a_second_state_enum(
    status: StrategyStatus,
) -> None:
    event = RunProgressEvent(
        runId="one",
        status=status,
        progress={
            "completedStrategies": 1 if is_terminal(status) else 0,
            "totalStrategies": 1,
        },
        strategyStatuses={"strategy-one": status},
    )
    assert RunProgressEvent.model_validate_json(event.model_dump_json()) == event


@pytest.mark.parametrize(
    "change",
    [
        {"progress": {"completedStrategies": 0, "totalStrategies": 1}},
        {"strategyStatuses": {"one": "running"}},
        {"strategySummaries": {"another": {"metrics": None}}},
        {"strategySummaries": {"one": {"metrics": None}}},
        {
            "strategyStatuses": {"one": "failed"},
            "strategySummaries": {"one": {"metrics": None, "diagnostics": []}},
        },
    ],
)
def test_terminal_events_reject_incoherent_progress_and_summaries(
    change: dict[str, object],
) -> None:
    payload: dict[str, object] = {
        "runId": "one",
        "status": "completed",
        "progress": {"completedStrategies": 1, "totalStrategies": 1},
        "strategyStatuses": {"one": "completed"},
    }
    with pytest.raises(ValidationError):
        RunProgressEvent.model_validate({**payload, **change})

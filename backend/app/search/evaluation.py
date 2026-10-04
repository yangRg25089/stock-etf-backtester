"""Shared period bounds and baseline evaluation for search modes."""

from collections.abc import Callable
from datetime import date
from typing import Literal

from app.calendar import ScheduleResult, schedule
from app.catalog.service import get_catalog
from app.config.validation import validate_draft
from app.diagnostics import calculation_diagnostic
from app.domain.cancellation import RunCancelled
from app.domain.contracts import (
    EndMode,
    ResultRole,
    SearchPeriod,
    SharedSettings,
    StrategyPresetId,
    StrategyRun,
)
from app.domain.status import (
    StrategyStatus,
)
from app.search.engine import GridSearchInput
from app.simulation import simulate_strategy


def evaluation_window(
    source: GridSearchInput, start: date, end: date, phase: Literal["train", "test"]
) -> tuple[SharedSettings, ScheduleResult, SearchPeriod]:
    run = source.config.shared.run.model_copy(
        update={"start_date": start, "end_date": end, "end_mode": EndMode.FIXED}
    )
    shared = source.config.shared.model_copy(update={"run": run})
    contributions = schedule(shared, source.exchange_calendar)
    return (
        shared,
        contributions,
        SearchPeriod(
            phase=phase,
            startDate=start,
            endDate=end,
            effectiveStartDate=contributions.effective_start_date,
            effectiveEndDate=contributions.effective_end_date,
        ),
    )


def period_baselines(
    source: GridSearchInput,
    shared: SharedSettings,
    contributions: ScheduleResult,
    period: SearchPeriod,
    *,
    check_cancelled: Callable[[], None] | None,
) -> tuple[StrategyRun, ...]:
    rows = []
    for preset in (StrategyPresetId.MONTHLY_DCA, StrategyPresetId.LUMP_SUM):
        identifier = f"{source.strategy.id}:{period.phase}:benchmark:{preset.value}"
        validated = validate_draft(
            {
                "shared": shared.model_dump(mode="python", by_alias=True),
                "strategies": [
                    {"id": identifier, "presetId": preset.value, "params": {}}
                ],
            },
            catalog=source.catalog or get_catalog(),
        )
        config = validated.config_for((identifier,))
        if config is None:
            raise ValueError("period baseline configuration is invalid")
        try:
            row = simulate_strategy(
                config,
                config.strategies[0],
                contributions,
                source.snapshot,
                source.exchange_calendar,
                check_cancelled=check_cancelled,
            ).as_run(config.strategies[0], role=ResultRole.BENCHMARK)
        except RunCancelled:
            raise
        except Exception as error:
            row = StrategyRun(
                id=identifier,
                presetId=preset,
                role=ResultRole.BENCHMARK,
                status=StrategyStatus.FAILED,
                diagnostics=(
                    calculation_diagnostic(
                        error,
                        stage="search_period_baseline",
                        strategy_id=source.strategy.id,
                        result_id=identifier,
                    ),
                ),
            )
        rows.append(row.model_copy(update={"evaluation_period": period}))
    return tuple(rows)

"""Independent Train/Test windows reuse ordinary search and simulation."""

from collections.abc import Callable
from dataclasses import replace
from datetime import date, timedelta
from typing import Literal

from app.domain.contracts import (
    SearchPeriod,
    SearchResult,
    SearchTestResult,
    StrategyRun,
)
from app.search.engine import GridSearchInput, _CalculationCache, run_grid_search
from app.search.evaluation import evaluation_window, period_baselines


def run_train_test(
    source: GridSearchInput,
    *,
    calculation_cache: _CalculationCache | None,
    check_cancelled: Callable[[], None] | None,
    save_candidate: Callable[[StrategyRun], None] | None,
    load_candidate: Callable[[str], StrategyRun | None] | None,
) -> SearchResult:
    cutoff = source.strategy.params["search.trainEndDate"]
    assert isinstance(cutoff, date)
    periods: list[SearchPeriod] = []
    results: list[SearchResult] = []
    baselines: list[StrategyRun] = []
    windows: tuple[tuple[Literal["train", "test"], date, date], ...] = (
        ("train", source.config.shared.run.start_date, cutoff),
        ("test", cutoff + timedelta(days=1), source.config.shared.run.end_date),
    )
    for phase, start, end in windows:
        if check_cancelled is not None:
            check_cancelled()
        shared, window_schedule, period = evaluation_window(source, start, end, phase)
        periods.append(period)
        strategy = (
            source.strategy
            if phase == "train"
            else source.strategy.model_copy(update={"id": f"{source.strategy.id}:test"})
        )

        def save_detail(
            detail: StrategyRun, *, saved_period: SearchPeriod = period
        ) -> None:
            assert save_candidate is not None
            save_candidate(
                detail.model_copy(update={"evaluation_period": saved_period})
            )

        results.append(
            run_grid_search(
                replace(
                    source,
                    config=source.config.model_copy(update={"strategies": (strategy,)}),
                    strategy=strategy,
                    schedule=window_schedule,
                    evaluation_run=shared.run,
                ),
                calculation_cache=calculation_cache,
                check_cancelled=check_cancelled,
                save_candidate=save_detail if save_candidate is not None else None,
                load_candidate=load_candidate,
            )
        )
        baselines.extend(
            period_baselines(
                source, shared, window_schedule, period, check_cancelled=check_cancelled
            )
        )
    training, testing = results
    candidates = tuple(
        row.model_copy(
            update={
                "test_result": SearchTestResult(
                    resultId=test.candidate_id,
                    status=test.status,
                    metrics=test.metrics,
                    diagnostics=test.diagnostics,
                ),
            }
        )
        for row, test in zip(training.candidates, testing.candidates, strict=True)
    )
    return SearchResult(
        strategyId=source.strategy.id,
        dimensions=training.dimensions,
        totalCandidateCount=training.total_candidate_count,
        candidates=candidates,
        rankedCandidateIds=training.ranked_candidate_ids,
        optimizationMode="train_test",
        trainPeriod=periods[0],
        testPeriod=periods[1],
        periodBenchmarks=tuple(baselines),
    )

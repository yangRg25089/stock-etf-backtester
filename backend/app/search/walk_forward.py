"""Select on past training data and run one continuous out-of-sample account."""

from collections.abc import Callable
from dataclasses import replace
from datetime import date
from math import prod

from app.catalog.service import get_catalog
from app.diagnostics import calculation_diagnostic
from app.domain.cancellation import RunCancelled
from app.domain.contracts import (
    FrozenStrategyInstance,
    ResultRole,
    SearchCandidate,
    SearchPeriod,
    SearchResult,
    SearchResultDimension,
    SearchTestResult,
    StrategyRun,
    WalkForwardWindow,
)
from app.domain.search_windows import walk_forward_periods
from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    DiagnosticSeverity,
    StrategyStatus,
)
from app.search.engine import (
    GridSearchInput,
    _CalculationCache,
    _dimension_keys,
    _hard_combination_limit,
    _integer_parameter,
    _validate_candidate_config,
    run_grid_search,
)
from app.search.evaluation import evaluation_window, period_baselines
from app.simulation import simulate_strategy


def run_walk_forward(
    source: GridSearchInput,
    *,
    calculation_cache: _CalculationCache | None,
    check_cancelled: Callable[[], None] | None,
    save_candidate: Callable[[StrategyRun], None] | None,
    load_candidate: Callable[[str], StrategyRun | None] | None,
) -> SearchResult:
    catalog = source.catalog or get_catalog()
    periods = walk_forward_periods(
        source.config.shared.run.start_date, source.config.shared.run.end_date
    )
    if not periods:
        raise ValueError("walk-forward requires five years before its testing")
    definitions = {
        dimension.key: dimension
        for dimension in catalog.preset(source.strategy.preset_id).search_dimensions
    }
    combinations = prod(
        len(definitions[key].configured_values(source.strategy.params))
        for key in _dimension_keys(source.strategy)
    )
    limit = min(
        _integer_parameter(source.strategy.params, "search.maxCombinations"),
        _hard_combination_limit(catalog),
    )
    if combinations * len(periods) > limit:
        raise ValueError("walk-forward total candidate work exceeds its limit")

    oos_id = f"{source.strategy.id}:out-of-sample"
    windows: list[WalkForwardWindow] = []
    candidates: list[SearchCandidate] = []
    policies: dict[date, FrozenStrategyInstance] = {}
    dimensions: tuple[SearchResultDimension, ...] = ()
    for sequence, (train, test) in enumerate(periods, start=1):
        if check_cancelled is not None:
            check_cancelled()
        train_shared, train_schedule, train = evaluation_window(
            source, train.start_date, train.end_date, "train"
        )
        _, test_schedule, test = evaluation_window(
            source, test.start_date, test.end_date, "test"
        )
        strategy = source.strategy.model_copy(
            update={"id": f"{source.strategy.id}:walk:{sequence:03d}"}
        )

        def save_training(
            detail: StrategyRun, *, saved_period: SearchPeriod = train
        ) -> None:
            assert save_candidate is not None
            save_candidate(
                detail.model_copy(update={"evaluation_period": saved_period})
            )

        training = run_grid_search(
            replace(
                source,
                config=source.config.model_copy(update={"strategies": (strategy,)}),
                strategy=strategy,
                schedule=train_schedule,
                evaluation_run=train_shared.run,
            ),
            calculation_cache=calculation_cache,
            check_cancelled=check_cancelled,
            save_candidate=save_training if save_candidate is not None else None,
            load_candidate=load_candidate,
        )
        dimensions = training.dimensions
        preceding_count = len(candidates)
        candidates.extend(
            row.model_copy(update={"sequence": preceding_count + index})
            for index, row in enumerate(training.candidates, start=1)
        )
        winner_id = (
            training.ranked_candidate_ids[0] if training.ranked_candidate_ids else None
        )
        windows.append(
            WalkForwardWindow(
                sequence=sequence,
                trainPeriod=train,
                testPeriod=test,
                candidateIds=tuple(row.candidate_id for row in training.candidates),
                rankedCandidateIds=training.ranked_candidate_ids,
                selectedCandidateId=winner_id,
            )
        )
        if winner_id is not None:
            winner = next(
                row for row in training.candidates if row.candidate_id == winner_id
            )
            selected = _validate_candidate_config(
                source.config,
                source.strategy,
                oos_id,
                winner.parameter_values,
                catalog,
            )
            if not selected.valid or selected.strategy is None:
                raise RuntimeError("completed training winner has invalid parameters")
            policies.update(
                dict.fromkeys(test_schedule.trading_dates, selected.strategy)
            )

    shared, contributions, oos_period = evaluation_window(
        source, periods[0][1].start_date, periods[-1][1].end_date, "test"
    )
    if (
        any(window.selected_candidate_id is None for window in windows)
        or not contributions.trading_dates
    ):
        oos = StrategyRun(
            id=oos_id,
            presetId=source.strategy.preset_id,
            role=ResultRole.STRATEGY,
            status=StrategyStatus.UNAVAILABLE,
            diagnostics=(
                Diagnostic(
                    code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE
                    if contributions.trading_dates
                    else DiagnosticCode.NO_VALID_CONTRIBUTION,
                    severity=DiagnosticSeverity.ERROR,
                    messageKey="search.no_training_candidate"
                    if contributions.trading_dates
                    else "calendar.no_valid_contribution",
                    fieldPath="strategies[0].params.search.optimizationMode",
                    details={
                        "windowSequences": tuple(
                            window.sequence
                            for window in windows
                            if window.selected_candidate_id is None
                        ),
                    },
                ),
            ),
        )
    else:
        first = policies[contributions.trading_dates[0]]
        config = source.config.model_copy(
            update={"shared": shared, "strategies": (first,)}
        )
        try:
            oos = simulate_strategy(
                config,
                first,
                contributions,
                source.snapshot,
                source.exchange_calendar,
                check_cancelled=check_cancelled,
                strategy_by_date=policies,
            ).as_run(first)
        except RunCancelled:
            raise
        except Exception as error:
            oos = StrategyRun(
                id=oos_id,
                presetId=source.strategy.preset_id,
                role=ResultRole.STRATEGY,
                status=StrategyStatus.FAILED,
                diagnostics=(
                    calculation_diagnostic(
                        error,
                        stage="walk_forward_oos",
                        strategy_id=source.strategy.id,
                        result_id=oos_id,
                    ),
                ),
            )
    oos = oos.model_copy(update={"evaluation_period": oos_period})
    if save_candidate is not None:
        save_candidate(oos)
    return SearchResult(
        strategyId=source.strategy.id,
        dimensions=dimensions,
        totalCandidateCount=len(candidates),
        candidates=tuple(candidates),
        rankedCandidateIds=tuple(
            identifier
            for window in windows
            for identifier in window.ranked_candidate_ids
        ),
        optimizationMode="walk_forward",
        walkForwardWindows=tuple(windows),
        outOfSample=SearchTestResult(
            resultId=oos.id,
            status=oos.status,
            metrics=oos.metrics,
            diagnostics=oos.diagnostics,
        ),
        outOfSamplePeriod=oos_period,
        periodBenchmarks=period_baselines(
            source, shared, contributions, oos_period, check_cancelled=check_cancelled
        ),
    )

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest

from app.calendar import ExchangeCalendar, schedule
from app.catalog.presets import SearchDimension
from app.catalog.service import Catalog, get_catalog
from app.config.validation import validate_draft
from app.domain.contracts import (
    DataSnapshot,
    FrozenStrategyInstance,
    MacroObservation,
    MarketBar,
    MarketSnapshot,
    MetricSummary,
    ResultRole,
    StrategyPresetId,
    StrategyRun,
)
from app.domain.status import Diagnostic, DiagnosticCode, StrategyStatus
from app.ledger import run_strategy
from app.metrics import MetricsInput, calculate_metrics
from app.search.engine import (
    GridSearchInput,
    build_heatmap_slice,
    calculation_fingerprint,
    rank_candidates,
    run_grid_search,
)
from app.search.types import SearchCandidate
from app.signals import evaluate_signals

_DATES = (date(2024, 1, 2), date(2024, 1, 3))


def _params(
    dimensions: list[str],
    *,
    maximum: int = 1000,
    overrides: dict[str, object] | None = None,
) -> dict[str, object]:
    values: dict[str, object] = {
        "accumulation.cashSafetyLimit": Decimal("1200"),
        "accumulation.maxSignalBuysPerMonth": None,
        "accumulation.conditionLogic": "OR",
        "accumulation.fixedDcaEnabled": False,
        "accumulation.fixedDcaRatio": Decimal("0.7"),
        "vix.buyEnabled": True,
        "vix.symbol": "^VIX",
        "rsi.buyEnabled": False,
        "ma.buyEnabled": False,
        "bollinger.buyEnabled": False,
        "rate.buyEnabled": False,
        "pe.buyEnabled": False,
        "exit.enabled": False,
        "search.dimensions": dimensions,
        "search.maxCombinations": maximum,
    }
    if overrides is not None:
        values.update(overrides)
    return values


def _catalog() -> Catalog:
    return get_catalog()


def _config(
    *,
    strategy_id: str = "grid-1",
    dimensions: list[str] | None = None,
    maximum: int = 1000,
    overrides: dict[str, object] | None = None,
    catalog: Catalog | None = None,
):
    source_catalog = _catalog() if catalog is None else catalog
    result = validate_draft(
        {
            "shared": {
                "run": {
                    "symbol": "QQQ",
                    "startDate": date(2024, 1, 1),
                    "endDate": _DATES[-1],
                    "endMode": "fixed",
                },
                "contribution": {"day": 2, "amount": Decimal("100")},
            },
            "strategies": [
                {
                    "id": strategy_id,
                    "presetId": "grid_search",
                    "enabled": True,
                    "params": _params(
                        ["vix.buyThreshold"] if dimensions is None else dimensions,
                        maximum=maximum,
                        overrides=overrides,
                    ),
                }
            ],
        },
        catalog=source_catalog,
    )
    assert result.diagnostics_for() == ()
    config = result.config_for((strategy_id,))
    assert config is not None
    return config


def _snapshot(*, include_vix: bool = True) -> DataSnapshot:
    bars = tuple(
        MarketBar(
            date=day,
            symbol="QQQ",
            simulationPrice=Decimal("100"),
            valuationPrice=Decimal("95"),
            currency="USD",
            source="fixture",
            observedAt=datetime.combine(day, datetime.min.time(), UTC),
        )
        for day in _DATES
    )
    macro = (
        tuple(
            MacroObservation(
                date=day - timedelta(days=1),
                symbol="^VIX",
                value=Decimal("30"),
                unit="index_points",
                source="fixture",
                observedAt=datetime.combine(
                    day - timedelta(days=1), datetime.min.time(), UTC
                ),
                alignedSessionDate=day,
            )
            for day in _DATES
        )
        if include_vix
        else ()
    )
    return DataSnapshot(
        market=MarketSnapshot(
            symbol="QQQ",
            currency="USD",
            bars=bars,
            source="fixture",
            fingerprint="market-fixture-v1",
        ),
        macro=macro,
        fingerprint="snapshot-fixture-v1",
    )


def _input(
    config,
    *,
    catalog: Catalog | None = None,
    snapshot: DataSnapshot | None = None,
) -> GridSearchInput:
    calendar = ExchangeCalendar.from_dates(
        _DATES,
        as_of_date=_DATES[-1],
        latest_complete_date=_DATES[-1],
        calendar_coverage_end_date=_DATES[-1],
    )
    return GridSearchInput(
        config=config,
        strategy=config.strategies[0],
        schedule=schedule(config.shared, calendar),
        exchange_calendar=calendar,
        snapshot=_snapshot() if snapshot is None else snapshot,
        catalog=_catalog() if catalog is None else catalog,
    )


def test_grid_search_covers_each_selected_value_and_keeps_base_parameters() -> None:
    config = _config(
        dimensions=["vix.buyThreshold"],
        overrides={"accumulation.fixedDcaRatio": Decimal("0.4")},
    )

    result = run_grid_search(_input(config))

    assert result.total_candidate_count == 4
    assert len(result.candidates) == 4
    assert [candidate.sequence for candidate in result.candidates] == [1, 2, 3, 4]
    assert [
        candidate.parameter_values["vix.buyThreshold"]
        for candidate in result.candidates
    ] == [Decimal("25"), Decimal("28"), Decimal("30"), Decimal("35")]
    assert all(
        candidate.parameter_values["accumulation.fixedDcaRatio"] == Decimal("0.4")
        for candidate in result.candidates
    )
    assert all(candidate.metrics is not None for candidate in result.candidates)
    assert all(candidate.role is ResultRole.STRATEGY for candidate in result.candidates)
    assert len(set(result.ranked_candidate_ids)) == 4


def test_search_candidate_matches_ordinary_strategy_and_monthly_dca_benchmark() -> None:
    grid_config = _config(
        dimensions=["accumulation.fixedDcaRatio"],
        overrides={
            "accumulation.fixedDcaEnabled": True,
            "vix.buyEnabled": False,
            "rsi.buyEnabled": False,
            "ma.buyEnabled": False,
            "bollinger.buyEnabled": False,
            "rate.buyEnabled": False,
            "pe.buyEnabled": False,
            "exit.enabled": False,
        },
    )
    source = _input(grid_config)

    search = run_grid_search(source)

    candidate = next(
        candidate
        for candidate in search.candidates
        if candidate.parameter_values["accumulation.fixedDcaRatio"] == Decimal("1")
    )
    assert candidate.status is StrategyStatus.COMPLETED
    assert candidate.role is ResultRole.STRATEGY
    candidate_params = {
        key: value
        for key, value in candidate.parameter_values.items()
        if not key.startswith("search.")
    }
    ordinary_validation = validate_draft(
        {
            "shared": source.config.shared.model_dump(mode="python", by_alias=True),
            "strategies": [
                {
                    "id": candidate.candidate_id,
                    "presetId": "composite_dca",
                    "enabled": True,
                    "params": candidate_params,
                }
            ],
        }
    )
    assert ordinary_validation.diagnostics_for() == ()
    ordinary_config = ordinary_validation.config_for((candidate.candidate_id,))
    assert ordinary_config is not None
    ordinary_strategy = ordinary_config.strategies[0]
    ordinary_signal_batch = evaluate_signals(
        ordinary_config,
        source.snapshot,
        sessions=source.exchange_calendar.trading_dates,
    )
    ordinary_ledger = run_strategy(
        ordinary_config,
        ordinary_strategy,
        source.schedule,
        source.snapshot,
        ordinary_signal_batch.strategy(candidate.candidate_id),
        exchange_calendar=source.exchange_calendar,
    )
    ordinary_metrics = calculate_metrics(
        MetricsInput(
            strategy=ordinary_strategy,
            schedule=source.schedule,
            ledger=ordinary_ledger,
            data_fingerprint=source.snapshot.fingerprint,
        )
    )

    benchmark_validation = validate_draft(
        {
            "shared": source.config.shared.model_dump(mode="python", by_alias=True),
            "strategies": [
                {
                    "id": "benchmark-monthly-dca",
                    "presetId": "monthly_dca",
                    "enabled": True,
                    "params": {},
                }
            ],
        }
    )
    assert benchmark_validation.diagnostics_for() == ()
    benchmark_config = benchmark_validation.config_for(("benchmark-monthly-dca",))
    assert benchmark_config is not None
    benchmark_strategy = benchmark_config.strategies[0]
    benchmark_signal_batch = evaluate_signals(
        benchmark_config,
        source.snapshot,
        sessions=source.exchange_calendar.trading_dates,
    )
    benchmark_ledger = run_strategy(
        benchmark_config,
        benchmark_strategy,
        source.schedule,
        source.snapshot,
        benchmark_signal_batch.strategy("benchmark-monthly-dca"),
        exchange_calendar=source.exchange_calendar,
    )
    benchmark_metrics = calculate_metrics(
        MetricsInput(
            strategy=benchmark_strategy,
            schedule=source.schedule,
            ledger=benchmark_ledger,
            data_fingerprint=source.snapshot.fingerprint,
        )
    )
    ordinary_run = StrategyRun(
        id=candidate.candidate_id,
        presetId=StrategyPresetId.COMPOSITE_DCA,
        role=ResultRole.STRATEGY,
        status=StrategyStatus.COMPLETED,
        trades=ordinary_ledger.trades,
        dailyAssets=ordinary_metrics.daily_assets,
        metrics=ordinary_metrics.summary,
    )
    benchmark_run = StrategyRun(
        id="benchmark:monthly-dca",
        presetId=StrategyPresetId.MONTHLY_DCA,
        role=ResultRole.BENCHMARK,
        status=StrategyStatus.COMPLETED,
        trades=benchmark_ledger.trades,
        dailyAssets=benchmark_metrics.daily_assets,
        metrics=benchmark_metrics.summary,
    )

    assert ordinary_ledger.trades == benchmark_ledger.trades
    assert ordinary_ledger.daily_assets == benchmark_ledger.daily_assets
    assert ordinary_metrics.summary == benchmark_metrics.summary
    assert candidate.metrics == ordinary_metrics.summary
    assert ordinary_run.role is ResultRole.STRATEGY
    assert benchmark_run.role is ResultRole.BENCHMARK
    assert ordinary_run.daily_assets == benchmark_run.daily_assets
    assert ordinary_run.metrics == benchmark_run.metrics


def test_unavailable_candidates_keep_their_diagnostic_and_are_not_ranked() -> None:
    config = _config(dimensions=["vix.buyThreshold"])

    result = run_grid_search(_input(config, snapshot=_snapshot(include_vix=False)))

    assert all(
        candidate.status is StrategyStatus.UNAVAILABLE
        for candidate in result.candidates
    )
    assert all(candidate.metrics is None for candidate in result.candidates)
    assert all(
        any(
            diagnostic.code is DiagnosticCode.REQUIRED_DATA_UNAVAILABLE
            for diagnostic in candidate.diagnostics
        )
        for candidate in result.candidates
    )
    assert result.ranked_candidate_ids == ()


def test_malformed_candidate_value_is_retained_with_its_validation_reason() -> None:
    catalog = _catalog()
    grid = catalog.preset("grid_search")
    dimensions = tuple(
        SearchDimension(key=item.key, values=(Decimal("25"), Decimal("300")))
        if item.key == "vix.buyThreshold"
        else item
        for item in grid.search_dimensions
    )
    malformed_grid = grid.model_copy(update={"search_dimensions": dimensions})
    malformed_catalog = catalog.model_copy(
        update={
            "version": "catalog-with-bad-dimension-v1",
            "presets": tuple(
                malformed_grid if preset.id == grid.id else preset
                for preset in catalog.presets
            ),
        }
    )
    config = _config(dimensions=["vix.buyThreshold"], catalog=malformed_catalog)

    result = run_grid_search(_input(config, catalog=malformed_catalog))

    assert [candidate.status for candidate in result.candidates] == [
        StrategyStatus.COMPLETED,
        StrategyStatus.FAILED,
    ]
    invalid = result.candidates[1]
    assert invalid.parameter_values["vix.buyThreshold"] == Decimal("300")
    assert invalid.metrics is None
    assert invalid.diagnostics[0].code is DiagnosticCode.INVALID_PARAMETER
    assert invalid.diagnostics[0].field_path == (
        "strategies[0].params.vix.buyThreshold"
    )
    assert result.ranked_candidate_ids == (result.candidates[0].candidate_id,)


def test_candidate_limit_uses_catalog_maximum_and_selected_dimensions() -> None:
    config = _config(dimensions=["vix.buyThreshold", "rsi.buyThreshold"])
    params = dict(config.strategies[0].params)
    params["search.maxCombinations"] = 10
    validation = validate_draft(
        {
            "shared": config.shared.model_dump(mode="python", by_alias=True),
            "strategies": [
                {
                    "id": config.strategies[0].id,
                    "presetId": "grid_search",
                    "enabled": True,
                    "params": params,
                }
            ],
        }
    )

    diagnostics = validation.diagnostics_for((config.strategies[0].id,))
    assert len(diagnostics) == 1
    assert diagnostics[0].code is DiagnosticCode.INVALID_PARAMETER
    assert diagnostics[0].field_path == ("strategies[0].params.search.maxCombinations")


def test_search_reuses_calculations_without_merging_candidate_identity() -> None:
    cache = {}
    first_config = _config(strategy_id="grid-alpha", dimensions=["vix.buyThreshold"])
    first = run_grid_search(_input(first_config), calculation_cache=cache)
    second_config = _config(strategy_id="grid-beta", dimensions=["vix.buyThreshold"])
    second = run_grid_search(_input(second_config), calculation_cache=cache)

    assert first.candidates[0].candidate_id != second.candidates[0].candidate_id
    assert first.candidates[0].calculation_fingerprint == (
        second.candidates[0].calculation_fingerprint
    )
    assert first.candidates[0].reused_calculation is False
    assert all(candidate.reused_calculation for candidate in second.candidates)
    assert first.candidates[0].metrics == second.candidates[0].metrics


def test_grid_search_fingerprint_matches_the_equivalent_accumulation_config() -> None:
    search_config = _config(dimensions=["vix.buyThreshold"])
    search_input = _input(search_config)
    candidate = run_grid_search(search_input).candidates[0]
    catalog = _catalog()
    composite_keys = catalog.preset("composite_dca").parameter_keys
    composite = FrozenStrategyInstance(
        id="ordinary-composite",
        presetId="composite_dca",
        enabled=True,
        params={key: candidate.parameter_values[key] for key in composite_keys},
    )

    fingerprint = calculation_fingerprint(
        search_input,
        strategy=composite,
    )

    assert fingerprint == candidate.calculation_fingerprint


def test_heatmap_slice_records_fixed_values_for_every_other_dimension() -> None:
    config = _config(
        dimensions=[
            "vix.buyThreshold",
            "accumulation.fixedDcaRatio",
            "accumulation.cashSafetyLimit",
        ]
    )
    result = run_grid_search(_input(config))

    heatmap = build_heatmap_slice(
        result,
        x_dimension="vix.buyThreshold",
        y_dimension="accumulation.fixedDcaRatio",
        fixed_values={"accumulation.cashSafetyLimit": Decimal("600")},
    )

    assert heatmap.fixed_values == {"accumulation.cashSafetyLimit": Decimal("600")}
    assert len(heatmap.candidates) == 16
    assert all(
        candidate.parameter_values["accumulation.cashSafetyLimit"] == Decimal("600")
        for candidate in heatmap.candidates
    )
    with pytest.raises(ValueError, match="fixed values"):
        build_heatmap_slice(
            result,
            x_dimension="vix.buyThreshold",
            y_dimension="accumulation.fixedDcaRatio",
            fixed_values={},
        )


def test_ranking_uses_ending_equity_drawdown_and_stable_sequence() -> None:
    def candidate(
        candidate_id: str,
        sequence: int,
        status: StrategyStatus,
        ending: str | None,
        drawdown: str = "0",
    ) -> SearchCandidate:
        metrics = (
            None
            if ending is None
            else MetricSummary(
                totalContributed=Decimal("100"),
                endingEquity=Decimal(ending),
                netProfit=Decimal(ending) - Decimal("100"),
                returnOnContributions=Decimal("0"),
                capitalMultiple=Decimal("1"),
                maximumDrawdown=Decimal(drawdown),
                currency="USD",
            )
        )
        return SearchCandidate(
            candidateId=candidate_id,
            sequence=sequence,
            status=status,
            metrics=metrics,
            calculationFingerprint=f"fingerprint-{candidate_id}",
            parameterValues={},
            diagnostics=(
                (
                    Diagnostic(
                        code=DiagnosticCode.CALCULATION_FAILED,
                        messageKey="diagnostics.calculation_failed",
                    ),
                )
                if status is StrategyStatus.FAILED
                else ()
            ),
        )

    candidates = (
        candidate("lower-equity", 1, StrategyStatus.COMPLETED, "110", "0"),
        candidate("higher-risk", 4, StrategyStatus.COMPLETED, "120", "0.3"),
        candidate("tie-later", 3, StrategyStatus.COMPLETED, "120", "0.1"),
        candidate("tie-first", 2, StrategyStatus.COMPLETED, "120", "0.1"),
        candidate("failed", 5, StrategyStatus.FAILED, None),
    )

    ranked = rank_candidates(candidates)

    assert ranked == ("tie-first", "tie-later", "higher-risk", "lower-equity")

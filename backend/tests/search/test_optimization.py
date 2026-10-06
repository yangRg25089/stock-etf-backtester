from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest

from app.calendar import ExchangeCalendar, schedule
from app.config.validation import validate_draft
from app.domain.contracts import (
    DataSnapshot,
    MacroObservation,
    MarketBar,
    MarketSnapshot,
)
from app.domain.status import StrategyStatus
from app.search import GridSearchInput, run_grid_search


def split_source(*, cutoff="2024-01-31", final_price="10.15") -> GridSearchInput:
    dates = tuple(
        date.fromisoformat(day)
        for day in (
            "2024-01-02",
            "2024-01-03",
            "2024-01-31",
            "2024-02-01",
            "2024-02-02",
            "2024-02-05",
        )
    )
    validation = validate_draft(
        {
            "shared": {
                "run": {
                    "symbol": "QQQ",
                    "startDate": "2024-01-01",
                    "endDate": "2024-02-05",
                },
                "contribution": {"amount": 100, "day": 1},
                "execution": {
                    "commission": "0.2",
                    "slippagePct": "0.1",
                    "spreadPct": "0.2",
                },
            },
            "strategies": [
                {
                    "id": "split",
                    "presetId": "grid_search",
                    "enabled": True,
                    "params": {
                        "search.optimizationMode": "train_test",
                        "search.trainEndDate": cutoff,
                        "search.dimensions": ["vix.buyThreshold"],
                        "search.values.vix.buyThreshold": [20, 30],
                        "rsi.buyEnabled": False,
                        "ma.buyEnabled": False,
                        "bollinger.buyEnabled": False,
                        "rate.buyEnabled": False,
                        "exit.enabled": False,
                    },
                }
            ],
        }
    )
    assert validation.diagnostics_for() == ()
    config = validation.config_for(("split",))
    assert config is not None
    prices = ("10", "10.1", "10.2", "10.1", "10.12", final_price)
    market = MarketSnapshot(
        symbol="QQQ",
        currency="USD",
        source="fixture",
        fingerprint="split-market",
        bars=tuple(
            MarketBar(
                date=day,
                symbol="QQQ",
                currency="USD",
                source="fixture",
                simulationPrice=Decimal(price),
                observedAt=datetime.combine(day, datetime.min.time(), UTC),
            )
            for day, price in zip(dates, prices, strict=True)
        ),
    )
    data = DataSnapshot(
        market=market,
        fingerprint=f"split-{final_price}",
        macro=tuple(
            MacroObservation(
                date=day - timedelta(days=1),
                symbol="^VIX",
                value=value,
                unit="index_points",
                source="fixture",
                observedAt=datetime.combine(
                    day - timedelta(days=1), datetime.min.time(), UTC
                ),
                alignedSessionDate=day,
            )
            for day, value in zip(dates, (25, 15, 25, 25, 15, 15), strict=True)
        ),
    )
    calendar = ExchangeCalendar.from_dates(
        dates, as_of_date=dates[-1], latest_complete_date=dates[-1]
    )
    return GridSearchInput(
        config=config,
        strategy=config.strategies[0],
        schedule=schedule(config.shared, calendar),
        exchange_calendar=calendar,
        snapshot=data,
    )


def test_split_ranks_only_training_and_preserves_both_periods_and_costs() -> None:
    source = split_source()
    details = {}
    result = run_grid_search(
        source,
        save_candidate=lambda row: details.update({row.id: row}),
        load_candidate=details.get,
    )
    assert result.optimization_mode == "train_test"
    assert result.train_period.start_date == date(2024, 1, 1)
    assert result.train_period.end_date == date(2024, 1, 31)
    assert result.test_period.start_date == date(2024, 2, 1)
    assert result.test_period.end_date == date(2024, 2, 5)
    assert result.ranked_candidate_ids[0] == result.candidates[0].candidate_id
    assert len(details) == 4
    for row in result.candidates:
        training = details[row.candidate_id]
        testing = details[row.test_result.result_id]
        assert training.metrics == row.metrics
        assert testing.metrics == row.test_result.metrics
        assert training.evaluation_period == result.train_period
        assert testing.evaluation_period == result.test_period
        assert (
            training.metrics.total_contributed
            == testing.metrics.total_contributed
            == 100
        )
        assert max(item.date for item in training.daily_assets) <= date(2024, 1, 31)
        assert min(item.date for item in testing.daily_assets) >= date(2024, 2, 1)
        assert testing.daily_assets[0].total_contributed == 100
        assert all(trade.date >= date(2024, 2, 1) for trade in testing.trades)
        assert training.metrics.trading_costs is not None
        assert testing.metrics.trading_costs is not None
    assert len(result.period_benchmarks) == 4
    for baseline in result.period_benchmarks:
        assert baseline.role == "benchmark"
        assert baseline.metrics.total_contributed == 100
        assert baseline.evaluation_period in (result.train_period, result.test_period)


def test_future_testing_prices_cannot_change_training_values_or_ranking() -> None:
    first = run_grid_search(split_source(final_price="10.15"))
    altered = run_grid_search(split_source(final_price="8"))
    assert first.ranked_candidate_ids == altered.ranked_candidate_ids
    assert [row.metrics for row in first.candidates] == [
        row.metrics for row in altered.candidates
    ]
    assert (
        first.candidates[0].test_result.metrics.ending_equity
        != altered.candidates[0].test_result.metrics.ending_equity
    )


def test_test_without_funding_keeps_train_success_and_a_precise_test_diagnostic() -> (
    None
):
    result = run_grid_search(split_source(cutoff="2024-02-01"))
    assert result.ranked_candidate_ids
    for row in result.candidates:
        assert row.metrics is not None
        assert row.test_result.status is StrategyStatus.UNAVAILABLE
        assert row.test_result.metrics is None
        assert any(
            item.code == "no_valid_contribution" for item in row.test_result.diagnostics
        )


@pytest.mark.parametrize(
    "cutoff", [None, "2023-12-31", "2024-02-05", "2024-02-31", "20240131"]
)
def test_split_cutoff_errors_are_bound_to_the_actual_field(cutoff) -> None:
    result = validate_draft(
        {
            "shared": {
                "run": {
                    "symbol": "QQQ",
                    "startDate": "2024-01-01",
                    "endDate": "2024-02-05",
                },
                "contribution": {"amount": 100, "day": 1},
            },
            "strategies": [
                {
                    "id": "grid",
                    "presetId": "grid_search",
                    "enabled": True,
                    "params": {
                        "search.optimizationMode": "train_test",
                        "search.trainEndDate": cutoff,
                    },
                }
            ],
        }
    )
    assert any(
        item.field_path == "strategies[0].params.search.trainEndDate"
        for item in result.diagnostics_for()
    )


def test_split_period_fingerprints_cannot_reuse_training_metrics_for_test() -> None:
    details = {}
    result = run_grid_search(
        split_source(),
        save_candidate=lambda row: details.update({row.id: row}),
        load_candidate=details.get,
    )
    for row in result.candidates:
        assert row.test_result is not None
        assert row.metrics != row.test_result.metrics
        assert (
            details[row.candidate_id].daily_assets
            != details[row.test_result.result_id].daily_assets
        )


def test_split_cancellation_propagates_after_train_and_preserves_saved_training() -> (
    None
):
    from app.domain.cancellation import RunCancelled

    details = {}

    def cancelled() -> None:
        if len(details) >= 2:
            raise RunCancelled

    with pytest.raises(RunCancelled):
        run_grid_search(
            split_source(),
            save_candidate=lambda row: details.update({row.id: row}),
            load_candidate=details.get,
            check_cancelled=cancelled,
        )
    assert len(details) == 2
    assert all(row.evaluation_period.phase == "train" for row in details.values())


def test_failed_period_baseline_cannot_discard_successful_candidate_results(
    monkeypatch,
) -> None:
    from app.search import evaluation

    original = evaluation.simulate_strategy

    def fail_dca(config, strategy, *args, **kwargs):
        if strategy.preset_id == "monthly_dca":
            raise ArithmeticError("baseline-only-failure")
        return original(config, strategy, *args, **kwargs)

    monkeypatch.setattr(evaluation, "simulate_strategy", fail_dca)
    result = run_grid_search(split_source())
    assert result.ranked_candidate_ids
    assert all(
        row.metrics is not None and row.test_result.metrics is not None
        for row in result.candidates
    )
    assert len(result.period_benchmarks) == 4
    assert (
        sum(row.status is StrategyStatus.FAILED for row in result.period_benchmarks)
        == 2
    )

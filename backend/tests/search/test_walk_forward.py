from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest

from app.calendar import ExchangeCalendar, schedule
from app.config.validation import validate_draft
from app.domain.cancellation import RunCancelled
from app.domain.contracts import (
    DataSnapshot,
    MacroObservation,
    MarketBar,
    MarketSnapshot,
)
from app.domain.search_windows import walk_forward_periods
from app.domain.status import StrategyStatus
from app.search import GridSearchInput, run_grid_search


def source(*, final_price=7, future_training_price=5):
    days = tuple(
        day
        for year in range(2015, 2022)
        for day in (
            date(year, 1, 2),
            date(year, 1, 3),
            date(year, 2, 1),
            date(year, 2, 2),
            date(year, 12, 31),
        )
        if day <= date(2021, 2, 5)
    )
    prices = [
        Decimal(
            10 + day.year - 2015
            if day.year < 2020
            else future_training_price
            if day.year == 2020
            else final_price
        )
        for day in days
    ]
    validation = validate_draft(
        {
            "shared": {
                "run": {
                    "symbol": "QQQ",
                    "startDate": "2015-01-01",
                    "endDate": "2021-02-05",
                },
                "contribution": {"amount": 100, "day": 1},
            },
            "strategies": [
                {
                    "id": "walk",
                    "presetId": "grid_search",
                    "params": {
                        "search.optimizationMode": "walk_forward",
                        "search.dimensions": ["vix.buyThreshold"],
                        "search.values.vix.buyThreshold": [20, 30],
                        "accumulation.cashSafetyLimit": 10000,
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
    config = validation.config_for()
    market = MarketSnapshot(
        symbol="QQQ",
        currency="USD",
        source="fixture",
        fingerprint="walk-market",
        bars=tuple(
            MarketBar(
                date=day,
                symbol="QQQ",
                simulationPrice=price,
                currency="USD",
                source="fixture",
                observedAt=datetime.combine(day, datetime.min.time(), UTC),
            )
            for day, price in zip(days, prices, strict=True)
        ),
    )
    snapshot = DataSnapshot(
        market=market,
        fingerprint=f"walk-{final_price}-{future_training_price}",
        macro=tuple(
            MacroObservation(
                date=day - timedelta(days=1),
                symbol="^VIX",
                value=25,
                unit="index_points",
                source="fixture",
                observedAt=datetime.combine(
                    day - timedelta(days=1), datetime.min.time(), UTC
                ),
                alignedSessionDate=day,
            )
            for day in days
        ),
    )
    calendar = ExchangeCalendar.from_dates(
        days,
        as_of_date=config.shared.run.end_date,
        latest_complete_date=days[-1],
        calendar_coverage_end_date=config.shared.run.end_date,
    )
    return GridSearchInput(
        config=config,
        strategy=config.strategies[0],
        schedule=schedule(config.shared, calendar),
        snapshot=snapshot,
        exchange_calendar=calendar,
    )


def run(source):
    details = {}
    result = run_grid_search(
        source,
        save_candidate=lambda row: details.update({row.id: row}),
        load_candidate=details.get,
    )
    return result, details


def test_walk_forward_selects_each_training_winner_and_preserves_oos_account():
    result, details = run(source())
    assert result.optimization_mode == "walk_forward"
    assert len(result.walk_forward_windows) == 2
    assert result.total_candidate_count == 4
    selected = [
        next(
            row
            for row in result.candidates
            if row.candidate_id == window.selected_candidate_id
        )
        for window in result.walk_forward_windows
    ]
    assert [row.parameter_values["vix.buyThreshold"] for row in selected] == [20, 30]
    first, second = result.walk_forward_windows
    assert first.train_period.start_date == date(2015, 1, 1)
    assert first.train_period.end_date == date(2019, 12, 31)
    assert first.test_period.start_date == date(2020, 1, 1)
    assert first.test_period.end_date == date(2020, 12, 31)
    assert second.train_period.start_date == date(2016, 1, 1)
    assert second.train_period.end_date == date(2020, 12, 31)
    assert second.test_period.end_date == date(2021, 2, 5)
    oos = details[result.out_of_sample.result_id]
    assert oos.metrics == result.out_of_sample.metrics
    assert oos.evaluation_period == result.out_of_sample_period
    assert oos.metrics.total_contributed == 500
    assert abs(oos.metrics.ending_equity - 620) < Decimal("1e-20")
    assert all(day.date >= date(2020, 1, 1) for day in oos.daily_assets)
    assert all(trade.date >= date(2020, 1, 1) for trade in oos.trades)
    first_new_year = next(day for day in oos.daily_assets if day.date.year == 2021)
    assert first_new_year.timing_quantity > 60
    assert len(details) == 5
    assert len(result.period_benchmarks) == 2
    assert all(row.metrics.total_contributed == 500 for row in result.period_benchmarks)


def test_future_oos_data_cannot_change_any_earlier_training_choice():
    first, _ = run(source(final_price=7))
    changed, _ = run(source(final_price=700))
    assert first.walk_forward_windows == changed.walk_forward_windows
    assert [row.metrics for row in first.candidates] == [
        row.metrics for row in changed.candidates
    ]
    assert first.out_of_sample.metrics != changed.out_of_sample.metrics
    changed_train, _ = run(source(future_training_price=50))
    assert first.walk_forward_windows[0] == changed_train.walk_forward_windows[0]
    assert [row.metrics for row in first.candidates[:2]] == [
        row.metrics for row in changed_train.candidates[:2]
    ]


def test_short_range_has_actionable_preflight_diagnostic():
    original = source()
    draft = {
        "shared": original.config.shared.model_dump(by_alias=True),
        "strategies": [original.strategy.model_dump(by_alias=True)],
    }
    draft["shared"]["run"]["endDate"] = "2019-12-31"
    result = validate_draft(draft)
    assert not result.valid
    assert any(
        row.field_path.endswith("search.optimizationMode")
        for row in result.diagnostics_for()
    )


def test_work_limit_counts_all_training_windows_before_execution():
    original = source()
    draft = {
        "shared": original.config.shared.model_dump(by_alias=True),
        "strategies": [original.strategy.model_dump(by_alias=True)],
    }
    draft["strategies"][0]["params"]["search.maxCombinations"] = 3
    result = validate_draft(draft)
    assert not result.valid
    assert any(
        row.field_path.endswith("search.maxCombinations")
        and row.details["combinationCount"] == 4
        for row in result.diagnostics_for()
    )
    draft["strategies"][0]["params"]["search.maxCombinations"] = 4
    assert validate_draft(draft).valid


def test_windows_clamp_leap_anniversaries_and_extreme_last_year():
    windows = walk_forward_periods(date(2016, 2, 29), date(2022, 3, 1))
    assert windows[0][1].start_date == date(2021, 2, 28)
    assert windows[1][0].start_date == date(2017, 2, 28)
    assert (windows[1][1].start_date - windows[0][1].end_date).days == 1
    assert windows[-1][1].end_date == date(2022, 3, 1)
    assert walk_forward_periods(date(9994, 1, 1), date.max)[-1][1].end_date == date.max


def test_unavailable_training_preserves_summaries_without_inventing_oos_parameters():
    from dataclasses import replace

    original = source()
    result, details = run(
        replace(original, snapshot=original.snapshot.model_copy(update={"macro": ()}))
    )
    assert not result.ranked_candidate_ids
    assert all(
        window.selected_candidate_id is None for window in result.walk_forward_windows
    )
    assert result.out_of_sample.status is StrategyStatus.UNAVAILABLE
    assert result.out_of_sample.metrics is None
    assert all(row.metrics is not None for row in result.period_benchmarks)
    assert len(details) == 1 and result.out_of_sample.result_id in details


def test_cancellation_stops_before_creating_a_finished_oos_snapshot():
    calls = 0
    saved = {}

    def cancel():
        nonlocal calls
        calls += 1
        if calls == 4:
            raise RunCancelled()

    with pytest.raises(RunCancelled):
        run_grid_search(
            source(),
            check_cancelled=cancel,
            save_candidate=lambda row: saved.update({row.id: row}),
            load_candidate=saved.get,
        )
    assert calls == 4
    assert all(not key.endswith(":out-of-sample") for key in saved)

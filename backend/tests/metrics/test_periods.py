from datetime import date, timedelta
from decimal import Decimal

import pytest

from app.domain.contracts import DailyAsset
from app.domain.performance import PerformanceAnalysis
from app.metrics.analysis import calculate_analysis
from app.metrics.periods import calculate_drawdown_episodes, calculate_period_returns


def rows(navs, dates=None, contributions=None):
    peak = Decimal(1)
    result = []
    for index, value in enumerate(navs):
        nav = Decimal(value) if value is not None else None
        if nav is not None:
            peak = max(peak, nav)
        amount = Decimal(contributions[index] if contributions else "100")
        result.append(
            DailyAsset(
                date=dates[index]
                if dates
                else date(2024, 1, 1) + timedelta(days=index),
                cash=amount,
                timingQuantity=0,
                fixedQuantity=0,
                simulationPrice=100 * (nav if nav and nav > 0 else Decimal(1)),
                totalAsset=amount,
                totalContributed=amount,
                currency="USD",
                unitNav=nav,
                drawdown=nav / peak - 1 if nav is not None else None,
            )
        )
    return tuple(result)


def test_year_and_month_boundaries_compound_saved_nav_and_price_with_actual_dates():
    dates = tuple(
        date.fromisoformat(day)
        for day in (
            "2023-12-29",
            "2023-12-30",
            "2024-01-02",
            "2024-01-31",
            "2024-02-01",
            "2024-02-29",
        )
    )
    source = rows(("1", "1.1", "1.21", "1.21", "1.089", "1.1979"), dates)
    annual = calculate_period_returns(source, monthly=False)
    monthly = calculate_period_returns(source, monthly=True)
    assert [(item.year, item.month, item.nav_return) for item in annual] == [
        (2023, None, Decimal("0.1")),
        (2024, None, Decimal("0.089")),
    ]
    assert [(item.year, item.month, item.nav_return) for item in monthly] == [
        (2023, 12, Decimal("0.1")),
        (2024, 1, Decimal("0.1")),
        (2024, 2, Decimal("-0.01")),
    ]
    assert annual[0].start_date == dates[0]
    assert annual[0].end_date == dates[1]
    assert annual[1].end_date == dates[-1]
    assert (1 + monthly[0].nav_return) * (1 + monthly[1].nav_return) * (
        1 + monthly[2].nav_return
    ) == Decimal("1.1979")
    assert [item.price_return for item in monthly] == [
        item.nav_return for item in monthly
    ]
    assert (
        calculate_period_returns(
            rows(
                ("1", "1.1", "1.21", "1.21", "1.089", "1.1979"),
                dates,
                ("100", "500", "1000", "10000", "20000", "30000"),
            ),
            monthly=True,
        )
        == monthly
    )


def test_initial_issue_loss_is_included_but_no_funding_is_not_zero_performance():
    assert calculate_period_returns(rows(("0.99",)), monthly=True)[
        0
    ].nav_return == Decimal("-0.01")
    source = rows(
        ("1", "1", "1.1"),
        (date(2023, 12, 29), date(2024, 1, 2), date(2024, 1, 31)),
        ("0", "100", "100"),
    )
    annual = calculate_period_returns(source, monthly=False)
    assert annual[0].nav_return is None
    assert annual[0].unavailable_reason == "no_funding"
    assert annual[0].price_return == 0
    assert annual[1].nav_return == Decimal("0.1")


@pytest.mark.parametrize(
    "navs,expected",
    [(("1", None, "1.1"), "missing_nav"), (("1", "0", "1.1"), "undefined_nav")],
)
def test_missing_or_zero_boundary_nav_never_imputes_a_period(navs, expected):
    source = rows(navs, (date(2023, 12, 28), date(2023, 12, 29), date(2024, 1, 2)))
    annual = calculate_period_returns(source, monthly=False)
    assert annual[1].nav_return is None
    assert annual[1].unavailable_reason == expected
    assert annual[1].price_return is not None
    if expected == "missing_nav":
        assert annual[0].nav_return is None
    else:
        assert annual[0].nav_return == -1


def test_missing_intermediate_nav_invalidates_only_its_observed_period():
    source = rows(
        ("1", None, "1.1", "1.21"),
        (date(2023, 12, 27), date(2023, 12, 28), date(2023, 12, 29), date(2024, 1, 2)),
    )
    annual = calculate_period_returns(source, monthly=False)
    assert annual[0].unavailable_reason == "missing_nav"
    assert annual[1].nav_return == Decimal("0.1")


def test_episodes_rank_depth_with_latest_peak_first_bottom_and_stable_equal_depth():
    source = rows(("1", "1", "0.8", "1", "1", "0.8", "0.85", "0.9", "1", "0.95"))
    episodes = calculate_drawdown_episodes(source)
    assert len(episodes) == 3
    first, second, ongoing = episodes
    assert first.peak_date == source[1].date
    assert first.bottom_date == source[2].date
    assert first.recovered_date == source[3].date
    assert first.duration_days == 2
    assert first.recovery_days == 1
    assert first.drawdown == second.drawdown == Decimal("-0.2")
    assert second.peak_date == source[4].date
    assert second.duration_days == 4
    assert second.recovery_days == 3
    assert ongoing.state == "ongoing"
    assert ongoing.recovered_date is ongoing.recovery_days is None
    assert ongoing.end_date == source[-1].date
    assert ongoing.duration_days == 1
    plateau = calculate_drawdown_episodes(rows(("1", "0.8", "0.8", "1")))[0]
    assert plateau.bottom_date == date(2024, 1, 2)


def test_missing_drawdown_is_unavailable_and_no_drawdown_is_empty():
    assert calculate_drawdown_episodes(rows(("1", None))) is None
    assert calculate_drawdown_episodes(rows(("1", "1.1"))) == ()
    assert calculate_period_returns((), monthly=True) == ()


def test_out_of_order_or_duplicate_observations_are_rejected():
    source = rows(("1", "1.1"))
    for invalid in [(source[1], source[0]), (source[0], source[0])]:
        with pytest.raises(ValueError, match="strictly increasing"):
            calculate_period_returns(invalid, monthly=True)


def test_saved_period_contracts_reject_wrong_dates_order_ranges_and_recovery():
    from copy import deepcopy

    saved = calculate_analysis(rows(("1", "0.8", "1")), (), Decimal(0)).model_dump(
        mode="json", by_alias=True
    )
    mutations = (
        lambda value: value["annualReturns"][0].update(year=2023),
        lambda value: value["annualReturns"][0].update(month=1),
        lambda value: value["monthlyReturns"][0].update(month=None),
        lambda value: value["monthlyReturns"][0].update(
            navReturn=None, unavailableReason=None
        ),
        lambda value: value["monthlyReturns"][0].update(navReturn="-1.1"),
        lambda value: value["monthlyReturns"].append(value["monthlyReturns"][0]),
        lambda value: value["drawdownEpisodes"][0].update(durationDays=999),
        lambda value: value["drawdownEpisodes"][0].update(recoveryDays=None),
        lambda value: value["drawdownEpisodes"][0].update(state="ongoing"),
    )
    for mutate in mutations:
        invalid = deepcopy(saved)
        mutate(invalid)
        with pytest.raises(ValueError):
            PerformanceAnalysis.model_validate(invalid)
    assert (
        PerformanceAnalysis.model_validate(saved).model_dump(mode="json", by_alias=True)
        == saved
    )

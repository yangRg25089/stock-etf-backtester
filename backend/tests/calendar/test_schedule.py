from datetime import date
from decimal import Decimal

import pytest

from app.calendar import ExchangeCalendar, ScheduleResult, schedule
from app.domain.contracts import (
    ContributionSettings,
    EndMode,
    RunSettings,
    SharedSettings,
)
from app.domain.status import DiagnosticCode, DiagnosticSeverity


def _settings(
    *,
    start: date,
    end: date,
    day: int = 1,
    amount: str = "100",
    end_mode: EndMode = EndMode.FIXED,
) -> SharedSettings:
    return SharedSettings(
        run=RunSettings(
            symbol="QQQ",
            startDate=start,
            endDate=end,
            endMode=end_mode,
        ),
        contribution=ContributionSettings(day=day, amount=Decimal(amount)),
    )


def test_schedule_rolls_monthly_day_31_and_month_end_holiday_within_month() -> None:
    settings = _settings(
        start=date(2024, 1, 1), end=date(2024, 3, 31), day=31
    )
    calendar = ExchangeCalendar.from_dates(
        [
            date(2024, 1, 30),  # January 31 is a month-end holiday.
            date(2024, 2, 28),  # February 29 is absent in this fixture.
            date(2024, 3, 29),
        ]
    )

    result = schedule(settings, calendar)

    assert [item.date for item in result.contributions] == [
        date(2024, 1, 30),
        date(2024, 2, 28),
        date(2024, 3, 29),
    ]
    assert [item.scheduled_date for item in result.contributions] == [
        date(2024, 1, 31),
        date(2024, 2, 29),
        date(2024, 3, 31),
    ]
    assert result.total_amount == Decimal("300")


def test_schedule_rolls_a_non_trading_day_to_the_next_trading_day_in_same_month() -> None:
    settings = _settings(
        start=date(2024, 1, 1), end=date(2024, 1, 31), day=15
    )
    calendar = ExchangeCalendar.from_dates([date(2024, 1, 16), date(2024, 1, 31)])

    result = schedule(settings, calendar)

    assert result.contributions[0].date == date(2024, 1, 16)
    assert result.contributions[0].scheduled_date == date(2024, 1, 15)


def test_schedule_does_not_backfill_start_month_or_prepay_end_month() -> None:
    settings = _settings(
        start=date(2024, 1, 15), end=date(2024, 2, 15), day=1
    )
    calendar = ExchangeCalendar.from_dates(
        [date(2024, 1, 16), date(2024, 2, 1), date(2024, 2, 16)]
    )

    result = schedule(settings, calendar)

    assert [item.date for item in result.contributions] == [date(2024, 2, 1)]
    assert result.effective_start_date == date(2024, 1, 16)
    assert result.effective_end_date == date(2024, 2, 1)


def test_schedule_clamps_a_future_fixed_end_to_latest_complete_exchange_date() -> None:
    settings = _settings(
        start=date(2024, 1, 1), end=date(2024, 12, 31), day=1
    )
    calendar = ExchangeCalendar.from_dates(
        [date(2024, 1, 2), date(2024, 2, 1), date(2024, 3, 1)]
    )

    result = schedule(settings, calendar)

    assert result.requested_end_date == date(2024, 12, 31)
    assert result.effective_end_date == date(2024, 3, 1)
    assert any(
        diagnostic.code is DiagnosticCode.STALE_DATA
        and diagnostic.severity is DiagnosticSeverity.WARNING
        for diagnostic in result.diagnostics
    )


def test_latest_end_mode_uses_latest_complete_exchange_date_and_exposes_actual_value() -> None:
    settings = _settings(
        start=date(2024, 1, 1),
        end=date(2024, 12, 31),
        day=1,
        end_mode=EndMode.LATEST,
    )
    calendar = ExchangeCalendar.from_dates([date(2024, 1, 2), date(2024, 3, 1)])

    result = schedule(settings, calendar)

    assert result.effective_end_date == date(2024, 3, 1)
    assert result.contributions[-1].date == date(2024, 3, 1)


def test_schedule_reports_no_valid_contribution_when_range_has_no_exchange_date() -> None:
    settings = _settings(
        start=date(2024, 4, 1), end=date(2024, 4, 30), day=1
    )

    result = schedule(settings, ExchangeCalendar.from_dates([date(2024, 3, 29)]))

    assert isinstance(result, ScheduleResult)
    assert result.contributions == ()
    assert result.effective_start_date is None
    assert result.effective_end_date is None
    assert any(
        diagnostic.code is DiagnosticCode.NO_VALID_CONTRIBUTION
        for diagnostic in result.diagnostics
    )


def test_zero_amount_is_not_a_valid_contribution() -> None:
    settings = _settings(
        start=date(2024, 1, 1), end=date(2024, 1, 31), day=1, amount="0"
    )

    result = schedule(settings, ExchangeCalendar.from_dates([date(2024, 1, 2)]))

    assert result.contributions == ()
    assert result.total_amount == Decimal("0")
    assert any(
        diagnostic.code is DiagnosticCode.NO_VALID_CONTRIBUTION
        for diagnostic in result.diagnostics
    )


def test_upfront_plan_uses_the_same_total_and_first_backtest_trading_day() -> None:
    settings = _settings(
        start=date(2024, 1, 15), end=date(2024, 3, 31), day=1, amount="125"
    )
    calendar = ExchangeCalendar.from_dates(
        [date(2024, 1, 16), date(2024, 2, 1), date(2024, 3, 1)]
    )

    result = schedule(settings, calendar)

    assert result.total_amount == Decimal("250")
    assert result.upfront_amount == result.total_amount
    assert result.upfront_date == date(2024, 2, 1)
    assert result.first_trading_date == date(2024, 2, 1)


@pytest.mark.parametrize(
    "dates",
    [
        [date(2024, 1, 2), date(2024, 1, 2)],
        [date(2024, 1, 3), date(2024, 1, 2)],
    ],
)
def test_exchange_calendar_normalizes_duplicate_and_unsorted_dates(
    dates: list[date],
) -> None:
    calendar = ExchangeCalendar.from_dates(dates)

    assert calendar.trading_dates == (date(2024, 1, 2), date(2024, 1, 3))[: len(set(dates))]

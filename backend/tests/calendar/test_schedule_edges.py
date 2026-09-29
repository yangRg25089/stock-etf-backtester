from datetime import date
from decimal import Decimal

from app.calendar import ExchangeCalendar, schedule
from app.domain.contracts import (
    ContributionSettings,
    DataSettings,
    EndMode,
    RunSettings,
    SharedSettings,
)
from app.domain.status import DiagnosticCode, DiagnosticSeverity


def _settings(*, start: date, end: date, day: int = 1) -> SharedSettings:
    return SharedSettings(
        run=RunSettings(
            symbol="QQQ",
            startDate=start,
            endDate=end,
            endMode=EndMode.FIXED,
        ),
        contribution=ContributionSettings(day=day, amount=Decimal("100")),
        data=DataSettings(macroStalenessSessions=3),
    )


def test_month_without_later_session_uses_last_session_in_that_month() -> None:
    result = schedule(
        _settings(start=date(2024, 1, 1), end=date(2024, 1, 31), day=31),
        ExchangeCalendar.from_dates(
            [date(2024, 1, 29), date(2024, 1, 30)],
            as_of_date=date(2024, 1, 31),
            latest_complete_date=date(2024, 1, 30),
            calendar_coverage_end_date=date(2024, 1, 31),
        ),
    )

    assert result.contributions[0].scheduled_date == date(2024, 1, 31)
    assert result.contributions[0].date == date(2024, 1, 30)


def test_midmonth_end_does_not_fallback_before_the_nominal_date() -> None:
    result = schedule(
        _settings(start=date(2024, 2, 1), end=date(2024, 2, 15), day=15),
        ExchangeCalendar.from_dates(
            [date(2024, 2, 14)],
            as_of_date=date(2024, 4, 1),
            latest_complete_date=date(2024, 2, 14),
        ),
    )

    assert result.contributions == ()
    assert result.effective_end_date == date(2024, 2, 14)
    assert any(
        diagnostic.code is DiagnosticCode.NO_VALID_CONTRIBUTION
        for diagnostic in result.diagnostics
    )


def test_partial_end_month_does_not_prepay_a_later_nominal_contribution() -> None:
    result = schedule(
        _settings(start=date(2024, 1, 1), end=date(2024, 2, 15), day=31),
        ExchangeCalendar.from_dates(
            [date(2024, 1, 31), date(2024, 2, 15), date(2024, 2, 16)],
            as_of_date=date(2024, 2, 16),
            latest_complete_date=date(2024, 2, 16),
        ),
    )

    assert [item.date for item in result.contributions] == [date(2024, 1, 31)]
    assert result.effective_end_date == date(2024, 2, 15)


def test_effective_boundaries_are_first_and_last_sessions_inside_requested_range() -> (
    None
):
    result = schedule(
        _settings(start=date(2024, 1, 3), end=date(2024, 1, 8), day=1),
        ExchangeCalendar.from_dates(
            [date(2024, 1, 2), date(2024, 1, 4), date(2024, 1, 5), date(2024, 1, 9)],
            as_of_date=date(2024, 1, 9),
            latest_complete_date=date(2024, 1, 9),
        ),
    )

    assert result.requested_start_date == date(2024, 1, 3)
    assert result.requested_end_date == date(2024, 1, 8)
    assert result.trading_dates == (date(2024, 1, 4), date(2024, 1, 5))
    assert result.effective_start_date == date(2024, 1, 4)
    assert result.effective_end_date == date(2024, 1, 5)


def test_zero_amount_has_no_upfront_deposit_but_keeps_actual_interval() -> None:
    settings = _settings(start=date(2024, 1, 1), end=date(2024, 1, 31))
    settings = settings.model_copy(
        update={
            "contribution": ContributionSettings(day=1, amount=Decimal("0")),
        }
    )

    result = schedule(
        settings,
        ExchangeCalendar.from_dates(
            [date(2024, 1, 2)],
            as_of_date=date(2024, 1, 31),
            latest_complete_date=date(2024, 1, 2),
        ),
    )

    assert result.effective_start_date == date(2024, 1, 2)
    assert result.effective_end_date == date(2024, 1, 2)
    assert result.upfront_amount == Decimal("0")
    assert result.upfront_date is None
    assert any(
        diagnostic.code is DiagnosticCode.NO_VALID_CONTRIBUTION
        and diagnostic.severity is DiagnosticSeverity.ERROR
        for diagnostic in result.diagnostics
    )


def test_empty_trading_interval_has_no_fabricated_effective_boundaries() -> None:
    result = schedule(
        _settings(start=date(2024, 4, 1), end=date(2024, 4, 30)),
        ExchangeCalendar.from_dates(
            [date(2024, 3, 29), date(2024, 5, 1)],
            as_of_date=date(2024, 5, 1),
            latest_complete_date=date(2024, 5, 1),
        ),
    )

    assert result.trading_dates == ()
    assert result.effective_start_date is None
    assert result.effective_end_date is None
    assert result.first_trading_date is None
    assert result.upfront_date is None


def test_future_end_clamp_does_not_prepay_after_latest_complete_session() -> None:
    result = schedule(
        _settings(start=date(2024, 1, 1), end=date(2024, 12, 31), day=31),
        ExchangeCalendar.from_dates(
            [
                date(2024, 1, 2),
                date(2024, 1, 31),
                date(2024, 2, 1),
                date(2024, 2, 29),
                date(2024, 3, 1),
            ],
            as_of_date=date(2024, 3, 1),
            latest_complete_date=date(2024, 3, 1),
        ),
    )

    assert [item.scheduled_date for item in result.contributions] == [
        date(2024, 1, 31),
        date(2024, 2, 29),
    ]
    assert result.effective_end_date == date(2024, 3, 1)
    assert result.total_amount == Decimal("200")


def test_future_end_without_complete_data_reports_both_limitations() -> None:
    result = schedule(
        _settings(start=date(2024, 1, 1), end=date(2024, 12, 31)),
        ExchangeCalendar.from_dates(
            [],
            as_of_date=date(2024, 3, 1),
            latest_complete_date=None,
        ),
    )

    codes = {diagnostic.code for diagnostic in result.diagnostics}
    assert DiagnosticCode.REQUIRED_DATA_UNAVAILABLE in codes
    assert DiagnosticCode.STALE_DATA in codes
    assert result.effective_end_date is None
    assert result.contributions == ()


def test_future_end_diagnostic_preserves_requested_and_effective_dates() -> None:
    result = schedule(
        _settings(start=date(2024, 1, 1), end=date(2024, 12, 31)),
        ExchangeCalendar.from_dates(
            [date(2024, 1, 2), date(2024, 3, 1)],
            as_of_date=date(2024, 3, 1),
            latest_complete_date=date(2024, 3, 1),
        ),
    )

    warning = next(
        diagnostic
        for diagnostic in result.diagnostics
        if diagnostic.code is DiagnosticCode.STALE_DATA
    )
    assert result.requested_end_date == date(2024, 12, 31)
    assert result.effective_end_date == date(2024, 3, 1)
    assert warning.severity is DiagnosticSeverity.WARNING
    assert warning.details["requestedEndDate"] == "2024-12-31"
    assert warning.details["effectiveEndDate"] == "2024-03-01"

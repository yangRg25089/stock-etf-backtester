"""Provider-neutral exchange sessions and shared contribution scheduling."""

from calendar import monthrange
from collections.abc import Iterable
from datetime import date as Date
from decimal import Decimal

from pydantic import Field, model_validator

from app.domain.contracts import SharedSettings
from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    DiagnosticSeverity,
    DomainModel,
)


class ExchangeCalendar(DomainModel):
    """Exchange sessions with explicit data and calendar coverage context."""

    trading_dates: tuple[Date, ...] = Field(alias="tradingDates")
    latest_complete_date: Date | None = Field(alias="latestCompleteDate")
    as_of_date: Date = Field(alias="asOfDate")
    calendar_coverage_end_date: Date = Field(alias="calendarCoverageEndDate")

    @model_validator(mode="after")
    def validate_sessions(self) -> "ExchangeCalendar":
        if self.trading_dates != tuple(sorted(set(self.trading_dates))):
            raise ValueError("trading dates must be sorted and unique")
        if (
            self.latest_complete_date is not None
            and self.latest_complete_date not in self.trading_dates
        ):
            raise ValueError("latest complete date must be an exchange session")
        if (
            self.latest_complete_date is not None
            and self.latest_complete_date > self.as_of_date
        ):
            raise ValueError("latest complete date must not be after as-of date")
        if (
            self.trading_dates
            and self.trading_dates[-1] > self.calendar_coverage_end_date
        ):
            raise ValueError("calendar sessions must not exceed calendar coverage")
        if (
            self.latest_complete_date is not None
            and self.latest_complete_date > self.calendar_coverage_end_date
        ):
            raise ValueError("calendar coverage must include the latest complete date")
        return self

    @classmethod
    def from_dates(
        cls,
        dates: Iterable[Date],
        *,
        as_of_date: Date,
        latest_complete_date: Date | None,
        calendar_coverage_end_date: Date | None = None,
    ) -> "ExchangeCalendar":
        """Normalize sessions and freeze calendar/data coverage context."""

        normalized_dates = tuple(sorted(set(dates)))
        resolved_coverage = calendar_coverage_end_date or (
            normalized_dates[-1] if normalized_dates else as_of_date
        )
        return cls(
            tradingDates=normalized_dates,
            latestCompleteDate=latest_complete_date,
            asOfDate=as_of_date,
            calendarCoverageEndDate=resolved_coverage,
        )


class ScheduledContribution(DomainModel):
    """A monthly contribution's actual session and its nominal calendar date."""

    date: Date
    scheduled_date: Date = Field(alias="scheduledDate")
    amount: Decimal = Field(gt=0)


class ScheduleResult(DomainModel):
    """The effective backtest sessions and its shared monthly/upfront funding."""

    requested_start_date: Date = Field(alias="requestedStartDate")
    requested_end_date: Date = Field(alias="requestedEndDate")
    effective_start_date: Date | None = Field(alias="effectiveStartDate")
    effective_end_date: Date | None = Field(alias="effectiveEndDate")
    trading_dates: tuple[Date, ...] = Field(alias="tradingDates")
    contributions: tuple[ScheduledContribution, ...]
    total_amount: Decimal = Field(alias="totalAmount", ge=0)
    upfront_amount: Decimal = Field(alias="upfrontAmount", ge=0)
    upfront_date: Date | None = Field(alias="upfrontDate")
    diagnostics: tuple[Diagnostic, ...] = ()

    @model_validator(mode="after")
    def validate_schedule(self) -> "ScheduleResult":
        if self.trading_dates != tuple(sorted(set(self.trading_dates))):
            raise ValueError("schedule trading dates must be sorted and unique")
        if self.trading_dates:
            if self.effective_start_date != self.trading_dates[0]:
                raise ValueError("effective start must be the first trading date")
            if self.effective_end_date != self.trading_dates[-1]:
                raise ValueError("effective end must be the last trading date")
        elif (
            self.effective_start_date is not None or self.effective_end_date is not None
        ):
            raise ValueError("empty schedules must not fabricate effective boundaries")
        if self.contributions != tuple(
            sorted(self.contributions, key=lambda item: item.date)
        ):
            raise ValueError("contributions must be sorted by date")
        if any(item.date not in self.trading_dates for item in self.contributions):
            raise ValueError("contributions must fall on backtest trading dates")
        expected_total = sum((item.amount for item in self.contributions), Decimal("0"))
        if self.total_amount != expected_total:
            raise ValueError("total amount must equal the monthly contribution total")
        if self.upfront_amount != self.total_amount:
            raise ValueError("upfront amount must equal the monthly contribution total")
        expected_upfront_date = (
            self.trading_dates[0]
            if self.total_amount > 0 and self.trading_dates
            else None
        )
        if self.upfront_date != expected_upfront_date:
            raise ValueError("upfront funding must use the first trading date")
        return self

    @property
    def first_trading_date(self) -> Date | None:
        """The first actual session in the effective backtest interval, if any."""

        return self.trading_dates[0] if self.trading_dates else None


def schedule(
    run_settings: SharedSettings,
    exchange_calendar: ExchangeCalendar,
) -> ScheduleResult:
    """Build the shared monthly contribution plan without external I/O.

    The configured day is clamped to each month's calendar end and then rolled
    to the next exchange session in that month. The last-session fallback is
    used only when the calendar confirms that month is complete. A contribution's
    nominal date must be in range and its actual session must be in the effective
    interval.
    """

    run = run_settings.run
    latest_complete = exchange_calendar.latest_complete_date
    as_of_date = exchange_calendar.as_of_date
    diagnostics: list[Diagnostic] = []

    if latest_complete is None:
        diagnostics.append(
            Diagnostic(
                code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                messageKey="calendar.latest_complete_date_unavailable",
                fieldPath="run.endDate",
                details={
                    "requestedEndDate": run.end_date.isoformat(),
                    "asOfDate": as_of_date.isoformat(),
                },
            )
        )

    is_future_end = run.end_date > as_of_date
    if is_future_end and latest_complete is None:
        diagnostics.append(
            Diagnostic(
                code=DiagnosticCode.STALE_DATA,
                severity=DiagnosticSeverity.WARNING,
                messageKey="calendar.future_end_date_unresolved",
                fieldPath="run.endDate",
                details={
                    "requestedEndDate": run.end_date.isoformat(),
                    "effectiveEndDate": None,
                    "asOfDate": as_of_date.isoformat(),
                },
            )
        )

    end_limit = (
        min(run.end_date, latest_complete) if latest_complete is not None else None
    )
    if latest_complete is not None and is_future_end:
        diagnostics.append(
            Diagnostic(
                code=DiagnosticCode.STALE_DATA,
                severity=DiagnosticSeverity.WARNING,
                messageKey="calendar.end_date_clamped",
                fieldPath="run.endDate",
                details={
                    "requestedEndDate": run.end_date.isoformat(),
                    "effectiveEndDate": latest_complete.isoformat(),
                    "asOfDate": as_of_date.isoformat(),
                },
            )
        )

    schedule_end_date = end_limit
    if (
        not is_future_end
        and end_limit is not None
        and run.end_date.year == end_limit.year
        and run.end_date.month == end_limit.month
    ):
        # A historical month-end can follow the last exchange session, e.g. a
        # Sunday end date after the preceding Friday's complete bar.
        schedule_end_date = run.end_date

    trading_dates = (
        tuple(
            session
            for session in exchange_calendar.trading_dates
            if run.start_date <= session <= end_limit
        )
        if end_limit is not None
        else ()
    )
    effective_start = trading_dates[0] if trading_dates else None
    effective_end = trading_dates[-1] if trading_dates else None
    contributions = (
        _monthly_contributions(
            start_date=run.start_date,
            schedule_end_date=schedule_end_date,
            contribution_day=run_settings.contribution.day,
            amount=run_settings.contribution.amount,
            exchange_dates=exchange_calendar.trading_dates,
            backtest_dates=trading_dates,
            calendar_coverage_end_date=exchange_calendar.calendar_coverage_end_date,
        )
        if schedule_end_date is not None
        else ()
    )
    total_amount = sum((item.amount for item in contributions), Decimal("0"))
    upfront_date = trading_dates[0] if total_amount > 0 and trading_dates else None

    if total_amount == 0:
        diagnostics.append(
            Diagnostic(
                code=DiagnosticCode.NO_VALID_CONTRIBUTION,
                messageKey="calendar.no_valid_contribution",
                fieldPath="contribution.amount",
                details={
                    "requestedStartDate": run.start_date.isoformat(),
                    "requestedEndDate": run.end_date.isoformat(),
                    "effectiveStartDate": (
                        effective_start.isoformat() if effective_start else None
                    ),
                    "effectiveEndDate": (
                        effective_end.isoformat() if effective_end else None
                    ),
                    "contributionDay": run_settings.contribution.day,
                    "contributionAmount": str(run_settings.contribution.amount),
                },
            )
        )

    return ScheduleResult(
        requestedStartDate=run.start_date,
        requestedEndDate=run.end_date,
        effectiveStartDate=effective_start,
        effectiveEndDate=effective_end,
        tradingDates=trading_dates,
        contributions=contributions,
        totalAmount=total_amount,
        upfrontAmount=total_amount,
        upfrontDate=upfront_date,
        diagnostics=tuple(diagnostics),
    )


def _monthly_contributions(
    *,
    start_date: Date,
    schedule_end_date: Date,
    contribution_day: int,
    amount: Decimal,
    exchange_dates: tuple[Date, ...],
    backtest_dates: tuple[Date, ...],
    calendar_coverage_end_date: Date,
) -> tuple[ScheduledContribution, ...]:
    if amount <= 0 or start_date > schedule_end_date:
        return ()

    sessions_by_month: dict[tuple[int, int], list[Date]] = {}
    for session in exchange_dates:
        sessions_by_month.setdefault((session.year, session.month), []).append(session)

    backtest_date_set = set(backtest_dates)
    result: list[ScheduledContribution] = []
    month = Date(start_date.year, start_date.month, 1)
    final_month = Date(schedule_end_date.year, schedule_end_date.month, 1)

    while month <= final_month:
        last_calendar_day = monthrange(month.year, month.month)[1]
        scheduled_date = Date(
            month.year, month.month, min(contribution_day, last_calendar_day)
        )
        month_sessions = sessions_by_month.get((month.year, month.month), [])
        if start_date <= scheduled_date <= schedule_end_date and month_sessions:
            actual_date = next(
                (session for session in month_sessions if session >= scheduled_date),
                None,
            )
            if actual_date is None and calendar_coverage_end_date >= Date(
                month.year, month.month, last_calendar_day
            ):
                # Only use the month's last session when the supplied calendar
                # covers the whole month; otherwise the last known session may be
                # mid-month.
                actual_date = month_sessions[-1]
            if actual_date is not None and actual_date in backtest_date_set:
                result.append(
                    ScheduledContribution(
                        date=actual_date,
                        scheduledDate=scheduled_date,
                        amount=amount,
                    )
                )

        if month.month == 12:
            if month.year == Date.max.year:
                break
            month = Date(month.year + 1, 1, 1)
        else:
            month = Date(month.year, month.month + 1, 1)

    return tuple(result)

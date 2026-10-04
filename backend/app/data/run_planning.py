"""Pure interval, warm-up and quote-gap planning; no network requests."""

from bisect import bisect_left
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from datetime import date as Date
from typing import Literal

from app.calendar import ExchangeCalendar
from app.catalog.service import Catalog
from app.config.validation import DataRequirement
from app.data.contracts import MarketDataResult
from app.data.market_data import MarketDataRequest
from app.domain.contracts import (
    FrozenStrategyInstance,
    RunDateAdjustment,
    SharedSettings,
)
from app.domain.status import Diagnostic, DiagnosticCode


def _prewarm_start(
    sessions: tuple[Date, ...], start_date: Date, lookback_sessions: int
) -> Date | None:
    if lookback_sessions <= 0:
        return None
    first_backtest_index = bisect_left(sessions, start_date)
    prewarm_index = max(0, first_backtest_index - lookback_sessions)
    if prewarm_index >= first_backtest_index:
        return None
    return sessions[prewarm_index]


def _indicator_lookback(
    strategy: FrozenStrategyInstance,
    requirements: Sequence[DataRequirement],
    catalog: Catalog,
) -> int:
    period_keys = {
        requirement.period_key
        for requirement in requirements
        if requirement.period_key is not None
    }
    periods = [requirement.lookback_sessions for requirement in requirements]

    if strategy.preset_id.value == "grid_search":
        preset = catalog.preset(strategy.preset_id)
        dimensions = {
            dimension.key: dimension for dimension in preset.search_dimensions
        }
        dimension_keys = strategy.params.get("search.dimensions", ())
        if isinstance(dimension_keys, (list, tuple)):
            for key in period_keys.intersection(dimension_keys):
                dimension = dimensions.get(key)
                if dimension is None:
                    continue
                for value in dimension.configured_values(strategy.params):
                    if isinstance(value, int) and not isinstance(value, bool):
                        periods.append(value + (1 if key == "rsi.period" else 0))
    return max(periods, default=0)


def _apply_market_gap_policy(
    calendar_dates: tuple[Date, ...],
    diagnostics: tuple[Diagnostic, ...],
    *,
    scheduled_end: Date,
    latest_quote: Date | None,
    available_from: Date | None = None,
) -> tuple[tuple[Date, ...], tuple[Diagnostic, ...]]:
    """Skip isolated gaps and trim unreported final quotes without filling."""

    has_quote = latest_quote is not None
    if has_quote:
        assert latest_quote is not None
        effective_dates = tuple(day for day in calendar_dates if day <= latest_quote)
    else:
        effective_dates = calendar_dates
    if available_from is not None:
        effective_dates = tuple(day for day in effective_dates if day >= available_from)
    if not effective_dates:
        return calendar_dates, diagnostics

    date_indices = {day: index for index, day in enumerate(calendar_dates)}
    effective_date_set = set(effective_dates)
    skipped_dates: set[Date] = set()
    retained: list[Diagnostic] = []
    for diagnostic in diagnostics:
        if (
            has_quote
            and diagnostic.code is DiagnosticCode.PRICE_BASIS_UNAVAILABLE
            and diagnostic.as_of is not None
            and latest_quote is not None
            and latest_quote < diagnostic.as_of <= scheduled_end
        ):
            continue

        if (
            diagnostic.code is DiagnosticCode.REQUIRED_DATA_UNAVAILABLE
            and diagnostic.message_key == "market.missing_sessions"
        ):
            raw_missing = diagnostic.details.get("missingSessions")
            if not isinstance(raw_missing, (list, tuple)) or not raw_missing:
                retained.append(diagnostic)
                continue
            missing_dates = tuple(
                parsed
                for item in raw_missing
                if (parsed := _parse_diagnostic_date(item)) is not None
            )
            if len(missing_dates) != len(raw_missing) or len(set(missing_dates)) != len(
                missing_dates
            ):
                retained.append(diagnostic)
                continue

            unresolved: set[Date] = set()
            missing_indices: list[int] = []
            for missing_date in missing_dates:
                if available_from is not None and missing_date < available_from:
                    continue
                if (
                    has_quote
                    and latest_quote is not None
                    and latest_quote < missing_date <= scheduled_end
                ):
                    continue
                index = date_indices.get(missing_date)
                if index is None or missing_date not in effective_date_set:
                    unresolved.add(missing_date)
                    continue
                missing_indices.append(index)

            missing_indices.sort()
            gap_run: list[int] = []
            for index in missing_indices:
                if gap_run and index != gap_run[-1] + 1:
                    if len(gap_run) == 1:
                        skipped_dates.add(calendar_dates[gap_run[0]])
                    else:
                        unresolved.update(calendar_dates[item] for item in gap_run)
                    gap_run = []
                gap_run.append(index)
            if gap_run:
                if len(gap_run) == 1:
                    skipped_dates.add(calendar_dates[gap_run[0]])
                else:
                    unresolved.update(calendar_dates[item] for item in gap_run)

            if unresolved:
                details = dict(diagnostic.details)
                details["missingSessions"] = [
                    item.isoformat() for item in missing_dates if item in unresolved
                ]
                retained.append(
                    Diagnostic(
                        code=diagnostic.code,
                        severity=diagnostic.severity,
                        messageKey=diagnostic.message_key,
                        fieldPath=diagnostic.field_path,
                        asOf=diagnostic.as_of,
                        source=diagnostic.source,
                        details=details,
                    )
                )
            continue

        retained.append(diagnostic)

    adjusted_dates = tuple(day for day in effective_dates if day not in skipped_dates)
    if not adjusted_dates:
        return calendar_dates, diagnostics
    return adjusted_dates, tuple(retained)


def _parse_diagnostic_date(value: object) -> Date | None:
    if not isinstance(value, str):
        return None
    try:
        return Date.fromisoformat(value)
    except ValueError:
        return None


@dataclass(frozen=True, slots=True)
class MarketRequestPlan:
    request: MarketDataRequest
    calendar_dates: tuple[Date, ...]
    latest_closed_session: Date


@dataclass(frozen=True, slots=True)
class EffectiveMarketPlan:
    request: MarketDataRequest
    market_diagnostics: tuple[Diagnostic, ...]
    date_adjustments: tuple[RunDateAdjustment, ...]


def plan_market_request(
    shared: SharedSettings,
    sessions: tuple[tuple[Date, datetime], ...],
    *,
    now: datetime,
    lookback_sessions: int,
    publication_delay: timedelta,
) -> MarketRequestPlan | Diagnostic:
    as_of_date = now.date()
    now_utc = now.astimezone(UTC)
    completed_before_request = tuple(
        (
            session_date
            for session_date, close_at in sessions
            if close_at <= now_utc - publication_delay
        )
    )
    if not completed_before_request:
        return Diagnostic(
            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
            messageKey="calendar.latest_complete_date_unavailable",
            fieldPath="run.endDate",
            source="yahoo",
            details={
                "requestedStartDate": shared.run.start_date.isoformat(),
                "asOfDate": as_of_date.isoformat(),
            },
        )
    latest_closed_session = completed_before_request[-1]
    request_end = min(shared.run.end_date, latest_closed_session)
    if request_end < shared.run.start_date:
        return Diagnostic(
            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
            messageKey="calendar.latest_complete_date_unavailable",
            fieldPath="run.endDate",
            source="yahoo",
            details={
                "requestedStartDate": shared.run.start_date.isoformat(),
                "effectiveEndDate": request_end.isoformat(),
            },
        )
    calendar_dates = tuple(
        (
            session_date
            for session_date, _close_at in sessions
            if session_date <= request_end
        )
    )
    if not calendar_dates:
        return Diagnostic(
            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
            messageKey="calendar.latest_complete_date_unavailable",
            fieldPath="run.endDate",
            source="yahoo",
            details={"effectiveEndDate": request_end.isoformat()},
        )
    scheduled_latest = max(
        (
            session_date
            for session_date, close_at in sessions
            if session_date <= request_end and close_at <= now_utc - publication_delay
        )
    )
    prewarm_start = _prewarm_start(
        calendar_dates, shared.run.start_date, lookback_sessions
    )
    exchange_calendar = ExchangeCalendar.from_dates(
        calendar_dates,
        as_of_date=as_of_date,
        latest_complete_date=scheduled_latest,
        calendar_coverage_end_date=as_of_date,
    )
    request = MarketDataRequest(
        symbol=shared.run.symbol,
        startDate=shared.run.start_date,
        endDate=request_end,
        prewarmStartDate=prewarm_start,
        exchangeCalendar=exchange_calendar,
        macroStalenessSessions=shared.data.macro_staleness_sessions,
    )
    return MarketRequestPlan(request, calendar_dates, latest_closed_session)


def resolve_market_request(
    shared: SharedSettings,
    request: MarketDataRequest,
    market_result: MarketDataResult,
    *,
    calendar_dates: tuple[Date, ...],
    as_of_date: Date,
    strategy_lookbacks: Mapping[str, int],
) -> EffectiveMarketPlan:
    base_snapshot = market_result.snapshot
    assert base_snapshot is not None
    request_end = request.end_date
    lookback_sessions = max(strategy_lookbacks.values(), default=0)
    quote_dates = {bar.date for bar in base_snapshot.market.bars}
    actual_latest_quote = max(quote_dates, default=None)
    effective_calendar_dates, effective_market_diagnostics = _apply_market_gap_policy(
        calendar_dates,
        market_result.diagnostics,
        scheduled_end=request_end,
        latest_quote=(
            actual_latest_quote
            if actual_latest_quote is not None
            and actual_latest_quote >= shared.run.start_date
            else None
        ),
        available_from=market_result.available_from,
    )
    macro_prefix = (
        tuple(day for day in calendar_dates if day < market_result.available_from)[
            -shared.data.macro_staleness_sessions :
        ]
        if market_result.available_from is not None
        and shared.data.macro_staleness_sessions > 0
        else ()
    )
    # Index observations may predate the asset's listing. Keep their as-of
    # calendar context, without requesting or inventing pre-listing prices.
    final_calendar = ExchangeCalendar.from_dates(
        (*macro_prefix, *effective_calendar_dates),
        as_of_date=as_of_date,
        latest_complete_date=actual_latest_quote,
        calendar_coverage_end_date=as_of_date,
    )
    resolved_start = max(
        shared.run.start_date, market_result.available_from or shared.run.start_date
    )
    resolution_reason: Literal["market_available_from", "indicator_warmup"] = (
        "market_available_from"
    )
    if (
        lookback_sessions > 0
        and market_result.available_from is not None
        and request.data_start_date < market_result.available_from
    ):
        quoted_sessions = tuple(
            day for day in effective_calendar_dates if day in quote_dates
        )
        ready_lookback = max(
            (
                period
                for period in strategy_lookbacks.values()
                if period <= len(quoted_sessions)
            ),
            default=0,
        )
        if ready_lookback > 0:
            first_ready = quoted_sessions[ready_lookback - 1]
            if first_ready > resolved_start:
                resolved_start = first_ready
                resolution_reason = "indicator_warmup"
    date_adjustments = (
        (
            RunDateAdjustment(
                field="startDate",
                requestedDate=shared.run.start_date,
                effectiveDate=resolved_start,
                reason=resolution_reason,
            ),
        )
        if resolved_start != shared.run.start_date
        else ()
    )
    effective_request = request.model_copy(
        update={
            "start_date": resolved_start,
            "end_date": effective_calendar_dates[-1],
            "exchange_calendar": final_calendar,
            "prewarm_start_date": _prewarm_start(
                effective_calendar_dates, resolved_start, lookback_sessions
            ),
        }
    )

    return EffectiveMarketPlan(
        effective_request, effective_market_diagnostics, date_adjustments
    )

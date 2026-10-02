"""Yahoo-backed run data loading, kept outside the calculation modules."""

from __future__ import annotations

import logging
from bisect import bisect_left
from collections.abc import Callable, Iterable, Mapping, Sequence
from datetime import UTC, datetime, timedelta
from datetime import date as Date
from importlib import import_module
from importlib.metadata import PackageNotFoundError, version
from threading import RLock
from typing import Protocol, cast

from app.calendar import ExchangeCalendar
from app.catalog.service import Catalog, get_catalog
from app.config.validation import DataKind, DataRequirement
from app.data.cache import (
    CachedMacroDataProvider,
    CachedMarketDataProvider,
    InMemoryDataCache,
)
from app.data.contracts import MacroDataResult
from app.data.market_data import (
    MacroSeriesType,
    MarketDataRequest,
    compose_data_snapshot,
)
from app.data.providers.yahoo import YahooFinanceAdapter
from app.domain.contracts import (
    DataSnapshot,
    FrozenStrategyInstance,
    InstrumentMetadata,
    SharedSettings,
)
from app.domain.status import Diagnostic, DiagnosticCode
from app.runs.data import StrategyDataLoad

_LOGGER = logging.getLogger(__name__)
_CLOSE_PUBLICATION_DELAY = timedelta(minutes=30)
_EXCHANGE_CALENDARS: dict[str, str] = {
    # Yahoo's US listing codes share the NYSE holiday/session calendar. XNAS is
    # an upstream exchange_calendars alias for XNYS.
    "NMS": "XNAS",
    "NAS": "XNAS",
    "NGM": "XNAS",
    "NCM": "XNAS",
    "NASDAQ": "XNAS",
    "NASDAQGS": "XNAS",
    "NASDAQGM": "XNAS",
    "NASDAQCM": "XNAS",
    "NYQ": "XNYS",
    "NYS": "XNYS",
    "NYSE": "XNYS",
    "ASE": "XNYS",
    "AMEX": "XNYS",
    "PCX": "XNYS",
    "BTS": "XNYS",
    "PNK": "XNYS",
}


class _VendorCalendar(Protocol):
    def sessions_in_range(self, start: str, end: str) -> Iterable[object]: ...

    def session_close(self, session: object) -> object: ...


CalendarFactory = Callable[[str, Date, Date], _VendorCalendar]
Clock = Callable[[], datetime]
MacroKey = tuple[str, str, str]


class YahooRunDataProvider:
    """Load one consistent market context and each strategy's enabled signals."""

    def __init__(
        self,
        *,
        adapter: YahooFinanceAdapter | None = None,
        calendar_factory: CalendarFactory | None = None,
        clock: Clock | None = None,
        catalog: Catalog | None = None,
    ) -> None:
        self._adapter = adapter or YahooFinanceAdapter()
        self._calendar_factory = calendar_factory
        self._clock = clock or (lambda: datetime.now(UTC))
        self._catalog = get_catalog() if catalog is None else catalog
        self._cache = InMemoryDataCache(max_entries=128)
        self._market = CachedMarketDataProvider(self._adapter, self._cache)
        self._macro = CachedMacroDataProvider(self._adapter, self._cache)
        self._exchange_codes: dict[str, str] = {}
        self._exchange_lock = RLock()
        try:
            calendar_version = version("exchange-calendars")
        except PackageNotFoundError:
            calendar_version = "uninstalled"
        self.version = (
            f"{self._adapter.data_version}+exchange-calendars-{calendar_version}"
        )

    def instrument_metadata(self, symbol: str) -> InstrumentMetadata:
        currency, diagnostic = self._adapter.quote_currency(symbol)
        return InstrumentMetadata(
            symbol=symbol,
            currency=currency,
            diagnostics=() if diagnostic is None else (diagnostic,),
        )

    def load_for_strategy(
        self,
        *,
        shared: SharedSettings,
        strategy: FrozenStrategyInstance,
        requirements: Sequence[DataRequirement],
    ) -> StrategyDataLoad:
        """Support the single-strategy provider contract used by test providers."""

        loaded = self.load_for_run(
            shared=shared,
            strategies=(strategy,),
            requirements={strategy.id: requirements},
        )
        return loaded[strategy.id]

    def load_for_run(
        self,
        *,
        shared: SharedSettings,
        strategies: Sequence[FrozenStrategyInstance],
        requirements: Mapping[str, Sequence[DataRequirement]],
    ) -> Mapping[str, StrategyDataLoad]:
        """Load shared prices once so selected strategies use identical bars."""

        if not strategies:
            return {}

        exchange_code, exchange_diagnostic = self._exchange_code(shared.run.symbol)
        if exchange_diagnostic is not None:
            return _failed_loads(strategies, exchange_diagnostic)
        assert exchange_code is not None
        calendar_name = _EXCHANGE_CALENDARS.get(_normalize_exchange_code(exchange_code))
        if calendar_name is None:
            return _failed_loads(
                strategies,
                Diagnostic(
                    code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    messageKey="data.exchange_calendar_unsupported",
                    fieldPath="run.symbol",
                    source="yahoo",
                    details={"symbol": shared.run.symbol, "exchange": exchange_code},
                ),
            )

        strategy_requirements = {
            strategy.id: tuple(requirements.get(strategy.id, ()))
            for strategy in strategies
        }
        lookback_sessions = max(
            (
                _indicator_lookback(
                    strategy, strategy_requirements[strategy.id], self._catalog
                )
                for strategy in strategies
            ),
            default=0,
        )
        calendar_lookback = max(lookback_sessions, shared.data.macro_staleness_sessions)
        now = self._clock()
        if now.tzinfo is None or now.utcoffset() is None:
            return _failed_loads(
                strategies,
                Diagnostic(
                    code=DiagnosticCode.PROVIDER_REQUEST_FAILED,
                    messageKey="data.exchange_calendar_unavailable",
                    fieldPath="run.symbol",
                    source="exchange_calendars",
                    details={"reason": "clock_timezone_unavailable"},
                ),
            )
        now_utc = now.astimezone(UTC)
        as_of_date = now_utc.date()
        calendar_start = shared.run.start_date - timedelta(
            days=max(14, calendar_lookback * 2 + 14)
        )

        try:
            vendor_calendar = self._get_calendar(
                calendar_name, calendar_start, as_of_date
            )
            sessions = _session_records(vendor_calendar, calendar_start, as_of_date)
        except Exception as error:
            _LOGGER.warning(
                "Exchange calendar request failed",
                extra={
                    "event": "exchange_calendar_failed",
                    "exchange": exchange_code,
                    "exception_type": type(error).__name__,
                },
            )
            return _failed_loads(
                strategies,
                Diagnostic(
                    code=DiagnosticCode.PROVIDER_REQUEST_FAILED,
                    messageKey="data.exchange_calendar_unavailable",
                    fieldPath="run.symbol",
                    source="exchange_calendars",
                    details={
                        "symbol": shared.run.symbol,
                        "exchange": exchange_code,
                        "exceptionType": type(error).__name__,
                    },
                ),
            )

        completed_before_request = tuple(
            session_date
            for session_date, close_at in sessions
            if close_at <= now_utc - _CLOSE_PUBLICATION_DELAY
        )
        if not completed_before_request:
            return _failed_loads(
                strategies,
                Diagnostic(
                    code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    messageKey="calendar.latest_complete_date_unavailable",
                    fieldPath="run.endDate",
                    source="yahoo",
                    details={
                        "requestedStartDate": shared.run.start_date.isoformat(),
                        "asOfDate": as_of_date.isoformat(),
                    },
                ),
            )

        latest_closed_session = completed_before_request[-1]
        request_end = min(shared.run.end_date, latest_closed_session)
        if request_end < shared.run.start_date:
            return _failed_loads(
                strategies,
                Diagnostic(
                    code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    messageKey="calendar.latest_complete_date_unavailable",
                    fieldPath="run.endDate",
                    source="yahoo",
                    details={
                        "requestedStartDate": shared.run.start_date.isoformat(),
                        "effectiveEndDate": request_end.isoformat(),
                    },
                ),
            )

        calendar_dates = tuple(
            session_date
            for session_date, _close_at in sessions
            if session_date <= request_end
        )
        if not calendar_dates:
            return _failed_loads(
                strategies,
                Diagnostic(
                    code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    messageKey="calendar.latest_complete_date_unavailable",
                    fieldPath="run.endDate",
                    source="yahoo",
                    details={"effectiveEndDate": request_end.isoformat()},
                ),
            )
        scheduled_latest = max(
            session_date
            for session_date, close_at in sessions
            if session_date <= request_end
            and close_at <= now_utc - _CLOSE_PUBLICATION_DELAY
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
        market_result = self._market.load(request)
        base_snapshot = market_result.snapshot
        if base_snapshot is None:
            diagnostics = market_result.diagnostics or (
                Diagnostic(
                    code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    messageKey="market.no_valid_bars",
                    source="yahoo",
                    details={"symbol": shared.run.symbol},
                ),
            )
            return {
                strategy.id: StrategyDataLoad(diagnostics=diagnostics)
                for strategy in strategies
            }

        actual_latest_quote = max(
            (bar.date for bar in base_snapshot.market.bars), default=None
        )
        effective_calendar_dates, effective_market_diagnostics = (
            _apply_market_gap_policy(
                calendar_dates,
                market_result.diagnostics,
                scheduled_end=request_end,
                latest_quote=(
                    actual_latest_quote
                    if actual_latest_quote is not None
                    and actual_latest_quote >= shared.run.start_date
                    else None
                ),
            )
        )
        final_calendar = ExchangeCalendar.from_dates(
            effective_calendar_dates,
            as_of_date=as_of_date,
            latest_complete_date=actual_latest_quote,
            calendar_coverage_end_date=as_of_date,
        )
        effective_request = request.model_copy(
            update={
                "end_date": effective_calendar_dates[-1],
                "exchange_calendar": final_calendar,
            }
        )
        macro_results = self._load_macro_results(
            effective_request, strategies, strategy_requirements
        )
        return self._build_strategy_loads(
            strategies=strategies,
            strategy_requirements=strategy_requirements,
            base_snapshot=base_snapshot,
            calendar=final_calendar,
            market_diagnostics=effective_market_diagnostics,
            macro_results=macro_results,
        )

    def _exchange_code(self, symbol: str) -> tuple[str | None, Diagnostic | None]:
        with self._exchange_lock:
            cached = self._exchange_codes.get(symbol)
        if cached is not None:
            return cached, None
        code, diagnostic = self._adapter.exchange_code(symbol)
        if code is not None:
            with self._exchange_lock:
                self._exchange_codes[symbol] = code
        return code, diagnostic

    def _get_calendar(
        self, calendar_name: str, start: Date, end: Date
    ) -> _VendorCalendar:
        if self._calendar_factory is not None:
            return self._calendar_factory(calendar_name, start, end)
        module = import_module("exchange_calendars")
        get_calendar = getattr(module, "get_calendar", None)
        if not callable(get_calendar):
            raise RuntimeError("exchange_calendars has no get_calendar function")
        return cast(
            _VendorCalendar,
            get_calendar(calendar_name, start=start.isoformat(), end=end.isoformat()),
        )

    def _load_macro_results(
        self,
        request: MarketDataRequest,
        strategies: Sequence[FrozenStrategyInstance],
        requirements: Mapping[str, tuple[DataRequirement, ...]],
    ) -> Mapping[MacroKey, MacroDataResult]:
        required: set[MacroKey] = set()
        for strategy in strategies:
            for requirement in requirements[strategy.id]:
                if requirement.kind is not DataKind.MACRO:
                    continue
                required.add(_macro_key(strategy, requirement))

        loaded: dict[MacroKey, MacroDataResult] = {}
        for symbol, series_type, source_unit in sorted(required):
            macro_request = request.model_copy(update={"symbol": symbol})
            loaded[(symbol, series_type, source_unit)] = self._macro.load(
                macro_request,
                series_type=series_type,
                source_unit=source_unit,
            )
        return loaded

    def _build_strategy_loads(
        self,
        *,
        strategies: Sequence[FrozenStrategyInstance],
        strategy_requirements: Mapping[str, tuple[DataRequirement, ...]],
        base_snapshot: DataSnapshot,
        calendar: ExchangeCalendar,
        market_diagnostics: tuple[Diagnostic, ...],
        macro_results: Mapping[MacroKey, MacroDataResult],
    ) -> Mapping[str, StrategyDataLoad]:
        loaded: dict[str, StrategyDataLoad] = {}
        run_macros = tuple(
            result
            for _key, result in sorted(macro_results.items())
            if result.observations
        )
        try:
            shared_snapshot = compose_data_snapshot(base_snapshot, run_macros)
        except (TypeError, ValueError):
            # A conflicting unit/source for the same ticker must not block
            # unrelated strategies. In that rare case each strategy receives
            # only the macro series it explicitly requires below.
            shared_snapshot = None

        for strategy in strategies:
            macros: list[MacroDataResult] = []
            diagnostics = list(market_diagnostics)
            macro_keys: set[MacroKey] = set()
            for requirement in strategy_requirements[strategy.id]:
                if requirement.kind is DataKind.MACRO:
                    key = _macro_key(strategy, requirement)
                    if key in macro_keys:
                        continue
                    macro_keys.add(key)
                    result = macro_results.get(key)
                    if result is None:
                        diagnostics.append(_required_macro_diagnostic(requirement))
                        continue
                    macros.append(result)
                    diagnostics.extend(result.diagnostics)
                    if not result.observations and not result.diagnostics:
                        diagnostics.append(_required_macro_diagnostic(requirement))
                elif requirement.kind is DataKind.VALUATION:
                    diagnostics.append(
                        Diagnostic(
                            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                            messageKey="data.sec_valuation_provider_unavailable",
                            fieldPath=requirement.field_path,
                            source="sec",
                            details={
                                "symbol": requirement.symbol,
                                "strategyId": strategy.id,
                            },
                        )
                    )

            try:
                snapshot = (
                    shared_snapshot
                    if shared_snapshot is not None
                    else compose_data_snapshot(base_snapshot, macros)
                )
            except (TypeError, ValueError) as error:
                _LOGGER.warning(
                    "Strategy macro data could not be composed",
                    extra={
                        "event": "strategy_macro_composition_failed",
                        "strategy_id": strategy.id,
                        "exception_type": type(error).__name__,
                    },
                )
                diagnostics.append(
                    Diagnostic(
                        code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                        messageKey="data.macro_snapshot_composition_failed",
                        source="yahoo",
                        details={"strategyId": strategy.id},
                    )
                )
                loaded[strategy.id] = StrategyDataLoad(
                    diagnostics=_unique_diagnostics(diagnostics)
                )
                continue

            loaded[strategy.id] = StrategyDataLoad(
                calendar=calendar,
                snapshot=snapshot,
                diagnostics=_unique_diagnostics(diagnostics),
            )
        return loaded


def _normalize_exchange_code(value: str) -> str:
    return "".join(character for character in value.upper() if character.isalnum())


def _session_records(
    calendar: _VendorCalendar, start: Date, end: Date
) -> tuple[tuple[Date, datetime], ...]:
    # Vendor bounds are actual sessions: a requested weekend can fall outside
    # them even though the calendar was built for that exact date interval.
    first = _as_date(getattr(calendar, "first_session", None))
    last = _as_date(getattr(calendar, "last_session", None))
    if first is not None:
        start = max(start, first)
    if last is not None:
        end = min(end, last)
    if start > end:
        return ()
    records: list[tuple[Date, datetime]] = []
    for session in calendar.sessions_in_range(start.isoformat(), end.isoformat()):
        session_date = _as_date(session)
        close_at = _as_datetime(calendar.session_close(session))
        if session_date is None or close_at is None:
            raise ValueError("exchange calendar returned an invalid session")
        records.append((session_date, close_at.astimezone(UTC)))
    return tuple(sorted(records, key=lambda item: item[0]))


def _as_date(value: object) -> Date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, Date):
        return value
    converter = getattr(value, "to_pydatetime", None)
    if callable(converter):
        converted = converter()
        if isinstance(converted, datetime):
            return converted.date()
        if isinstance(converted, Date):
            return converted
    return None


def _as_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return (
            value
            if value.tzinfo is not None and value.utcoffset() is not None
            else None
        )
    converter = getattr(value, "to_pydatetime", None)
    if callable(converter):
        converted = converter()
        if isinstance(converted, datetime):
            return converted if converted.tzinfo is not None else None
    return None


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


def _macro_key(
    strategy: FrozenStrategyInstance, requirement: DataRequirement
) -> MacroKey:
    series_type = (
        MacroSeriesType.RATE.value
        if requirement.signal_id.startswith("rate.")
        else MacroSeriesType.INDEX.value
    )
    source_unit = (
        requirement.source_unit or str(strategy.params.get("rate.sourceUnit", "auto"))
        if series_type == MacroSeriesType.RATE.value
        else "index_points"
    )
    return requirement.symbol, series_type, source_unit


def _required_macro_diagnostic(requirement: DataRequirement) -> Diagnostic:
    return Diagnostic(
        code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
        messageKey="data.required_macro_unavailable",
        fieldPath=requirement.field_path,
        source="yahoo",
        details={"symbol": requirement.symbol, "signalId": requirement.signal_id},
    )


def _failed_loads(
    strategies: Sequence[FrozenStrategyInstance], diagnostic: Diagnostic
) -> Mapping[str, StrategyDataLoad]:
    return {
        strategy.id: StrategyDataLoad(diagnostics=(diagnostic,))
        for strategy in strategies
    }


def _unique_diagnostics(
    diagnostics: Sequence[Diagnostic],
) -> tuple[Diagnostic, ...]:
    seen: set[tuple[DiagnosticCode, str, Date | None, str | None]] = set()
    unique: list[Diagnostic] = []
    for diagnostic in diagnostics:
        key = (
            diagnostic.code,
            diagnostic.message_key,
            diagnostic.as_of,
            diagnostic.source,
        )
        if key in seen:
            continue
        seen.add(key)
        unique.append(diagnostic)
    return tuple(unique)


def _apply_market_gap_policy(
    calendar_dates: tuple[Date, ...],
    diagnostics: tuple[Diagnostic, ...],
    *,
    scheduled_end: Date,
    latest_quote: Date | None,
) -> tuple[tuple[Date, ...], tuple[Diagnostic, ...]]:
    """Skip isolated gaps and trim unreported final quotes without filling."""

    has_quote = latest_quote is not None
    if has_quote:
        assert latest_quote is not None
        effective_dates = tuple(day for day in calendar_dates if day <= latest_quote)
    else:
        effective_dates = calendar_dates
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


__all__ = ["YahooRunDataProvider"]

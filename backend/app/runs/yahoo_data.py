"""Yahoo-backed run data loading, kept outside the calculation modules."""

from __future__ import annotations

import logging
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
from app.data.contracts import MacroDataResult, MarketDataResult
from app.data.market_data import (
    MacroSeriesType,
    MarketDataRequest,
    compose_data_snapshot,
)
from app.data.providers.yahoo import YahooFinanceAdapter
from app.data.run_planning import (
    _indicator_lookback,
    plan_market_request,
    resolve_market_request,
)
from app.domain.contracts import (
    FrozenStrategyInstance,
    InstrumentMetadata,
    RunDateAdjustment,
    SharedSettings,
)
from app.domain.immutability import freeze_mapping
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
        self._clock = clock or (lambda: datetime.now().astimezone())
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
        strategy_lookbacks = {
            strategy.id: _indicator_lookback(
                strategy, strategy_requirements[strategy.id], self._catalog
            )
            for strategy in strategies
        }
        lookback_sessions = max(strategy_lookbacks.values(), default=0)
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
        as_of_date = now.date()
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
                        "stage": "exchange_calendar",
                    },
                ),
            )

        plan = plan_market_request(
            shared,
            sessions,
            now=now,
            lookback_sessions=lookback_sessions,
            publication_delay=_CLOSE_PUBLICATION_DELAY,
        )
        if isinstance(plan, Diagnostic):
            return _failed_loads(strategies, plan)
        request = plan.request
        calendar_dates = plan.calendar_dates
        latest_closed_session = plan.latest_closed_session
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
            diagnostics = tuple(
                Diagnostic.model_validate(
                    {
                        **diagnostic.model_dump(by_alias=True),
                        "details": {
                            **diagnostic.details,
                            "requestedStartDate": shared.run.start_date.isoformat(),
                            "requestedEndDate": shared.run.end_date.isoformat(),
                            "suggestedStartDate": (
                                market_result.available_from.isoformat()
                            ),
                            "suggestedEndDate": latest_closed_session.isoformat(),
                        },
                    }
                )
                if diagnostic.message_key == "market.period_before_listing"
                and market_result.available_from is not None
                else diagnostic
                for diagnostic in diagnostics
            )
            return {
                strategy.id: StrategyDataLoad(diagnostics=diagnostics)
                for strategy in strategies
            }

        resolved = resolve_market_request(
            shared,
            request,
            market_result,
            calendar_dates=calendar_dates,
            as_of_date=as_of_date,
            strategy_lookbacks=strategy_lookbacks,
        )
        effective_request = resolved.request
        final_calendar = effective_request.exchange_calendar
        effective_market_diagnostics = resolved.market_diagnostics
        date_adjustments = resolved.date_adjustments
        macro_results = self._load_macro_results(
            effective_request, strategies, strategy_requirements
        )
        return self._build_strategy_loads(
            strategies=strategies,
            strategy_requirements=strategy_requirements,
            market_result=market_result.model_copy(
                update={"context": effective_request.snapshot_context}
            ),
            calendar=final_calendar,
            market_diagnostics=effective_market_diagnostics,
            macro_results=macro_results,
            date_adjustments=date_adjustments,
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
        market_result: MarketDataResult,
        calendar: ExchangeCalendar,
        market_diagnostics: tuple[Diagnostic, ...],
        macro_results: Mapping[MacroKey, MacroDataResult],
        date_adjustments: tuple[RunDateAdjustment, ...] = (),
    ) -> Mapping[str, StrategyDataLoad]:
        loaded: dict[str, StrategyDataLoad] = {}
        run_macros = tuple(
            result
            for _key, result in sorted(macro_results.items())
            if result.observations
        )
        try:
            shared_snapshot = compose_data_snapshot(
                market_result,
                run_macros,
            )
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
                    for diagnostic in result.diagnostics:
                        # Cached supplier diagnostics have no instance identity.
                        # Bind the unit field to this immutable condition path so
                        # the UI can open the correct buy/sell editor.
                        if diagnostic.code is DiagnosticCode.UNKNOWN_SOURCE_UNIT:
                            condition_path, separator, _ = (
                                requirement.field_path.rpartition(".params.")
                            )
                            if separator:
                                diagnostic = diagnostic.model_copy(
                                    update={
                                        "field_path": (
                                            f"{condition_path}.params.rate.sourceUnit"
                                        ),
                                        "details": freeze_mapping(
                                            {
                                                **dict(diagnostic.details or {}),
                                                "strategyId": strategy.id,
                                            }
                                        ),
                                    }
                                )
                        diagnostics.append(diagnostic)
                    if not result.observations and not result.diagnostics:
                        diagnostics.append(_required_macro_diagnostic(requirement))
            try:
                snapshot = (
                    shared_snapshot
                    if shared_snapshot is not None
                    else compose_data_snapshot(
                        market_result,
                        macros,
                    )
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
                dateAdjustments=date_adjustments,
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


__all__ = ["YahooRunDataProvider"]

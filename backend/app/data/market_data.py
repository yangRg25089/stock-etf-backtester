"""Provider-neutral market and macro normalization boundaries."""

from __future__ import annotations

import hashlib
import json
from bisect import bisect_left, bisect_right
from collections.abc import Iterable
from datetime import date as Date
from decimal import Decimal
from enum import StrEnum

from pydantic import Field, field_validator, model_validator

from app.calendar.schedule import ExchangeCalendar
from app.data.contracts import (
    DataCacheKey,
    MacroAlignmentResult,
    MacroDataResult,
    MarketDataResult,
    SnapshotContext,
)
from app.data.fixtures import FixtureBundle, load_fixture
from app.domain.contracts import (
    DataSnapshot,
    MacroObservation,
    MarketBar,
    MarketSnapshot,
    ValuationSnapshot,
)
from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    DomainModel,
)
from app.domain.values import Symbol


class MarketDataRequest(DomainModel):
    """Inclusive backtest range with an optional data-only prewarm interval."""

    symbol: Symbol
    start_date: Date = Field(alias="startDate")
    end_date: Date = Field(alias="endDate")
    frequency: str = Field(default="1d", min_length=1)
    prewarm_start_date: Date | None = Field(default=None, alias="prewarmStartDate")
    exchange_calendar: ExchangeCalendar = Field(alias="exchangeCalendar")
    macro_staleness_sessions: int = Field(
        alias="macroStalenessSessions",
        strict=True,
        ge=0,
    )

    @field_validator("frequency")
    @classmethod
    def validate_daily_frequency(cls, value: str) -> str:
        if value != "1d":
            raise ValueError("only daily frequency is supported")
        return value

    @model_validator(mode="after")
    def validate_range(self) -> MarketDataRequest:
        if self.start_date > self.end_date:
            raise ValueError("startDate must not be after inclusive endDate")
        if (
            self.prewarm_start_date is not None
            and self.prewarm_start_date >= self.start_date
        ):
            raise ValueError("prewarmStartDate must be before startDate")
        return self

    @property
    def data_start_date(self) -> Date:
        """First requested data date; this does not alter the backtest start."""

        return self.prewarm_start_date or self.start_date

    @property
    def data_sessions(self) -> tuple[Date, ...]:
        """Exchange sessions covered by the data request, including prewarm."""

        return tuple(
            session
            for session in self.exchange_calendar.trading_dates
            if self.data_start_date <= session <= self.end_date
        )

    @property
    def macro_source_start_date(self) -> Date:
        """Earliest session needed to align macro data on the first target date."""

        sessions = self.exchange_calendar.trading_dates
        first_target_index = bisect_left(sessions, self.start_date)
        if (
            first_target_index >= len(sessions)
            or sessions[first_target_index] > self.end_date
        ):
            return self.data_start_date
        source_index = max(0, first_target_index - self.macro_staleness_sessions)
        return sessions[source_index]

    @property
    def target_sessions(self) -> tuple[Date, ...]:
        """Actual backtest sessions; prewarm sessions are never included."""

        return tuple(
            session
            for session in self.exchange_calendar.trading_dates
            if self.start_date <= session <= self.end_date
        )

    @property
    def context_fingerprint(self) -> str:
        """Identify only the calendar inputs affecting normalized market bars."""

        payload = {
            "startDate": self.start_date.isoformat(),
            "prewarmStartDate": (
                self.prewarm_start_date.isoformat()
                if self.prewarm_start_date is not None
                else None
            ),
            "exchangeSessions": [session.isoformat() for session in self.data_sessions],
        }
        return _fingerprint(payload)

    @property
    def macro_context_fingerprint(self) -> str:
        """Include macro availability lookback and staleness without later sessions."""

        payload = {
            "startDate": self.start_date.isoformat(),
            "targetSessions": [session.isoformat() for session in self.target_sessions],
            "sourceSessions": [
                session.isoformat()
                for session in self.exchange_calendar.trading_dates
                if self.macro_source_start_date <= session <= self.end_date
            ],
            "macroStalenessSessions": self.macro_staleness_sessions,
        }
        return _fingerprint(payload)

    @property
    def snapshot_context(self) -> SnapshotContext:
        return SnapshotContext(
            startDate=self.start_date,
            endDate=self.end_date,
            frequency=self.frequency,
            sessions=self.target_sessions,
        )


class MacroSeriesType(StrEnum):
    """Stable labels used to distinguish index levels from interest rates."""

    INDEX = "index"
    RATE = "rate"


def _fingerprint(value: object) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def build_cache_key(
    request: MarketDataRequest,
    *,
    provider: str,
    data_version: str,
    price_basis: str,
    start_date: Date | None = None,
    context_fingerprint: str | None = None,
) -> DataCacheKey:
    """Create an identity using the actual inclusive data interval."""

    return DataCacheKey(
        provider=provider,
        symbol=request.symbol,
        frequency=request.frequency,
        startDate=request.data_start_date if start_date is None else start_date,
        endDate=request.end_date,
        dataVersion=data_version,
        priceBasis=price_basis,
        contextFingerprint=(
            request.context_fingerprint
            if context_fingerprint is None
            else context_fingerprint
        ),
    )


def normalize_rate_value(value: Decimal, source_unit: str) -> Decimal | None:
    """Convert only an explicit known source unit to percentage points."""

    if not value.is_finite():
        raise ValueError("rate value must be finite")
    if source_unit == "percent_point":
        return value
    if source_unit == "decimal":
        return value * Decimal("100")
    if source_unit == "basis_points":
        return value / Decimal("100")
    # ``auto`` and all unknown metadata are deliberately not inferred from symbols.
    return None


def align_macro_observations(
    observations: Iterable[MacroObservation],
    *,
    exchange_calendar: ExchangeCalendar,
    target_sessions: Iterable[Date],
    max_staleness_sessions: int,
) -> MacroAlignmentResult:
    """Select only observations known by each session and within session age.

    Source ``date``, ``observedAt``, ``publishedAt``, and ``sourceUnit`` remain
    untouched.  The target is recorded separately in ``alignedSessionDate``.
    When a provider has no distinct publication timestamp, its source observation
    timestamp is the earliest known availability marker; a later explicit
    ``publishedAt`` always takes precedence. Because this calendar has no session
    close cutoff, observations dated on a target session are conservatively made
    available starting with the next session.
    """

    if max_staleness_sessions < 0:
        raise ValueError("max_staleness_sessions must be non-negative")

    sessions = exchange_calendar.trading_dates
    session_indexes = {session: index for index, session in enumerate(sessions)}
    targets = tuple(target_sessions)
    if targets != tuple(sorted(set(targets))):
        raise ValueError("target sessions must be sorted and unique")
    if any(target not in session_indexes for target in targets):
        raise ValueError("target sessions must belong to the exchange calendar")

    by_symbol: dict[str, list[MacroObservation]] = {}
    for observation in observations:
        by_symbol.setdefault(observation.symbol, []).append(observation)

    aligned: list[MacroObservation] = []
    diagnostics: list[Diagnostic] = []
    for symbol, source_rows in sorted(by_symbol.items()):
        source_rows.sort(
            key=lambda row: (
                row.date,
                _availability_sort_key(row),
                row.source,
            )
        )
        ready_rows = sorted(
            source_rows,
            key=lambda row: (
                max(row.date, (row.published_at or row.observed_at).date()),
                row.date,
                _availability_sort_key(row),
                row.source,
            ),
        )
        ready_index = 0
        selected: MacroObservation | None = None
        selected_key: tuple[Date, str] | None = None

        for target in targets:
            # Sweep the source series once as target sessions advance. A row is
            # ready only when both its source date and availability date precede
            # the target date; no per-session rescan of the full history is needed.
            while ready_index < len(ready_rows):
                candidate = ready_rows[ready_index]
                availability = candidate.published_at or candidate.observed_at
                ready_date = max(candidate.date, availability.date())
                if ready_date >= target:
                    break
                ready_index += 1

                candidate_key = (
                    candidate.date,
                    _availability_sort_key(candidate),
                )
                if selected_key is None or candidate_key > selected_key:
                    selected = candidate
                    selected_key = candidate_key

            target_index = session_indexes[target]
            if selected is not None:
                source_index = bisect_right(sessions, selected.date) - 1
                age = (
                    target_index - source_index
                    if source_index >= 0
                    else target_index + 1
                )
                if age <= max_staleness_sessions:
                    aligned.append(
                        selected.model_copy(update={"aligned_session_date": target})
                    )
                    continue

                diagnostics.append(
                    Diagnostic(
                        code=DiagnosticCode.STALE_DATA,
                        messageKey="macro.observation_stale",
                        asOf=target,
                        source=source_rows[-1].source,
                        details={
                            "symbol": symbol,
                            "targetSession": target.isoformat(),
                            "maxStalenessSessions": max_staleness_sessions,
                            "ageSessions": age,
                        },
                    )
                )
                continue

            diagnostics.append(
                Diagnostic(
                    code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    messageKey="macro.not_published_as_of_session",
                    asOf=target,
                    source=source_rows[-1].source,
                    details={
                        "symbol": symbol,
                        "targetSession": target.isoformat(),
                    },
                )
            )

    aligned.sort(
        key=lambda row: (
            row.aligned_session_date or row.date,
            row.symbol,
            row.date,
            _availability_sort_key(row),
        )
    )
    return MacroAlignmentResult(
        observations=tuple(aligned), diagnostics=tuple(diagnostics)
    )


def _availability_sort_key(observation: MacroObservation) -> str:
    availability = observation.published_at or observation.observed_at
    return availability.isoformat()


def _normalize_fixture_macro(
    observations: Iterable[MacroObservation],
) -> tuple[tuple[MacroObservation, ...], tuple[Diagnostic, ...]]:
    normalized: list[MacroObservation] = []
    diagnostics: list[Diagnostic] = []
    rate_units = {"percent_point", "decimal", "basis_points"}

    for observation in observations:
        source_unit = observation.source_unit or observation.unit
        if source_unit in rate_units:
            converted = normalize_rate_value(observation.value, source_unit)
            if converted is None:
                diagnostics.append(
                    _unknown_rate_unit(
                        observation.symbol, observation.source, source_unit
                    )
                )
                continue
            normalized.append(
                observation.model_copy(
                    update={
                        "value": converted,
                        "unit": "percent_point",
                        "source_unit": source_unit,
                        "aligned_session_date": None,
                    }
                )
            )
        elif source_unit in {"index_point", "index_points"}:
            normalized.append(
                observation.model_copy(
                    update={
                        "unit": "index_points",
                        "source_unit": source_unit,
                        "aligned_session_date": None,
                    }
                )
            )
        else:
            diagnostics.append(
                _unknown_rate_unit(observation.symbol, observation.source, source_unit)
            )

    return tuple(normalized), tuple(diagnostics)


def _unknown_rate_unit(symbol: str, source: str, source_unit: str) -> Diagnostic:
    return Diagnostic(
        code=DiagnosticCode.UNKNOWN_SOURCE_UNIT,
        messageKey="rate.unknown_source_unit",
        fieldPath="rate.sourceUnit",
        source=source,
        details={"symbol": symbol, "sourceUnit": source_unit},
    )


def compose_data_snapshot(
    market_result: MarketDataResult,
    macro_results: Iterable[MacroDataResult],
) -> DataSnapshot:
    """Compose cached market and macro provider results into one domain snapshot.

    Provider results should be cached independently before composition because a
    combined snapshot has more than one source cache identity. Conflicting values
    for one macro symbol/session are rejected instead of merged silently.
    Diagnostics stay on their provider results and must be aggregated by the caller.
    """

    base_snapshot = market_result.snapshot
    context = market_result.context
    if base_snapshot is None or context is None:
        raise ValueError("composition requires available market data and context")
    market_result.cache_key.validate_context(context)
    available_sessions = {bar.date for bar in base_snapshot.market.bars}.intersection(
        context.sessions
    )
    macro_by_session: dict[tuple[str, Date], MacroObservation] = {}
    for observation in base_snapshot.macro:
        _add_macro_observation(macro_by_session, observation, available_sessions)

    for result in macro_results:
        if result.context != context:
            raise ValueError("macro and market snapshot contexts must match")
        result.cache_key.validate_context(context)
        for observation in result.observations:
            if observation.symbol != result.symbol:
                raise ValueError("macro result observations must match its symbol")
            _add_macro_observation(macro_by_session, observation, available_sessions)

    return _build_data_snapshot(
        market=base_snapshot.market,
        macro=tuple(macro_by_session.values()),
        valuation=base_snapshot.valuation,
    )


def _add_macro_observation(
    macro_by_session: dict[tuple[str, Date], MacroObservation],
    observation: MacroObservation,
    available_sessions: set[Date],
) -> None:
    aligned_session_date = observation.aligned_session_date
    if aligned_session_date is None:
        raise ValueError("macro observations must be session-aligned")
    if aligned_session_date not in available_sessions:
        raise ValueError(
            "macro observations must align to available target market sessions"
        )

    key = (observation.symbol, aligned_session_date)
    existing = macro_by_session.get(key)
    if existing is not None and existing != observation:
        raise ValueError(
            "conflicting macro observations for "
            f"{observation.symbol} on {aligned_session_date}"
        )
    macro_by_session[key] = observation


def _build_data_snapshot(
    *,
    market: MarketSnapshot,
    macro: tuple[MacroObservation, ...],
    valuation: ValuationSnapshot | None,
) -> DataSnapshot:
    ordered_macro = tuple(
        sorted(
            macro,
            key=lambda row: (
                row.aligned_session_date or row.date,
                row.symbol,
                row.date,
                _availability_sort_key(row),
            ),
        )
    )
    payload: dict[str, object] = {
        "market": market.model_dump(mode="json", by_alias=True),
        "macro": [
            item.model_dump(mode="json", by_alias=True) for item in ordered_macro
        ],
    }
    if valuation is not None:
        payload["valuation"] = valuation.model_dump(mode="json", by_alias=True)
    fingerprint = _fingerprint(payload)
    return DataSnapshot(
        market=market,
        macro=ordered_macro,
        valuation=valuation,
        fingerprint=fingerprint,
    )


def _market_data_result(
    *,
    symbol: str,
    currency: str,
    source: str,
    bars: tuple[MarketBar, ...],
    macro: tuple[MacroObservation, ...],
    cache_key: DataCacheKey,
    context: SnapshotContext,
    missing_sessions: tuple[Date, ...],
    diagnostics: tuple[Diagnostic, ...],
    available_from: Date | None = None,
) -> MarketDataResult:
    if not bars:
        return MarketDataResult(
            snapshot=None,
            fingerprint=None,
            cacheKey=cache_key,
            availableFrom=available_from,
            missingMarketSessions=missing_sessions,
            diagnostics=diagnostics,
        )

    market_payload = {
        "symbol": symbol,
        "currency": currency,
        "bars": [bar.model_dump(mode="json", by_alias=True) for bar in bars],
        "source": source,
    }
    market = MarketSnapshot(
        symbol=symbol,
        currency=currency,
        bars=bars,
        source=source,
        fingerprint=_fingerprint(market_payload),
    )
    snapshot = _build_data_snapshot(
        market=market,
        macro=macro,
        valuation=None,
    )
    normalized_fingerprint = snapshot.fingerprint
    return MarketDataResult(
        snapshot=snapshot,
        fingerprint=normalized_fingerprint,
        cacheKey=cache_key,
        context=context,
        availableFrom=available_from,
        missingMarketSessions=missing_sessions,
        diagnostics=diagnostics,
    )


def _missing_sessions(
    request: MarketDataRequest, quote_dates: set[Date]
) -> tuple[Date, ...]:
    return tuple(
        session for session in request.data_sessions if session not in quote_dates
    )


def _outside_calendar_diagnostic(
    *, session_date: Date, symbol: str, source: str
) -> Diagnostic:
    return Diagnostic(
        code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
        messageKey="market.observation_outside_calendar",
        asOf=session_date,
        source=source,
        details={"symbol": symbol, "date": session_date.isoformat()},
    )


def _missing_session_diagnostic(missing: tuple[Date, ...], source: str) -> Diagnostic:
    return Diagnostic(
        code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
        messageKey="market.missing_sessions",
        source=source,
        details={"missingSessions": [item.isoformat() for item in missing]},
    )


def _required_market_unavailable(
    *,
    cache_key: DataCacheKey,
    diagnostic: Diagnostic,
    missing_sessions: tuple[Date, ...] = (),
) -> MarketDataResult:
    return MarketDataResult(
        snapshot=None,
        fingerprint=None,
        cacheKey=cache_key,
        missingMarketSessions=missing_sessions,
        diagnostics=(diagnostic,),
    )


class FixtureMarketDataAdapter:
    """Deterministic offline adapter over the checked-in Task 4 fixture."""

    provider = "fixture"
    price_basis = "fixture-dual-normalized-price-v1"

    def __init__(
        self,
        fixture_id: str = "task4_core",
        *,
        bundle: FixtureBundle | None = None,
    ) -> None:
        self._bundle = bundle or load_fixture(fixture_id)

    def cache_identity(self, request: MarketDataRequest) -> DataCacheKey:
        version = (
            f"{self._bundle.fixture_id}:{self._bundle.version}:"
            f"{self._bundle.fingerprint}"
        )
        return build_cache_key(
            request,
            provider=self.provider,
            data_version=version,
            price_basis=self.price_basis,
            context_fingerprint=_fingerprint(
                (request.context_fingerprint, request.macro_context_fingerprint)
            ),
        )

    def load(self, request: MarketDataRequest) -> MarketDataResult:
        cache_key = self.cache_identity(request)
        fixture_market = self._bundle.snapshot.market
        if fixture_market.symbol != request.symbol:
            return _required_market_unavailable(
                cache_key=cache_key,
                diagnostic=Diagnostic(
                    code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    messageKey="market.fixture_symbol_unavailable",
                    source=fixture_market.source,
                    details={
                        "requestedSymbol": request.symbol,
                        "fixtureSymbol": fixture_market.symbol,
                    },
                ),
            )

        expected_sessions = set(request.data_sessions)
        interval_bars = tuple(
            bar
            for bar in fixture_market.bars
            if request.data_start_date <= bar.date <= request.end_date
        )
        outside_calendar = tuple(
            bar for bar in interval_bars if bar.date not in expected_sessions
        )
        bars = tuple(bar for bar in interval_bars if bar.date in expected_sessions)
        quote_dates = {bar.date for bar in bars}
        missing = _missing_sessions(request, quote_dates)
        diagnostics: list[Diagnostic] = [
            _outside_calendar_diagnostic(
                session_date=bar.date,
                symbol=request.symbol,
                source=fixture_market.source,
            )
            for bar in outside_calendar
        ]
        if missing:
            diagnostics.append(
                _missing_session_diagnostic(missing, fixture_market.source)
            )

        macro_source_rows = tuple(
            observation
            for observation in self._bundle.snapshot.macro
            if request.macro_source_start_date <= observation.date <= request.end_date
        )
        macro_rows, macro_diagnostics = _normalize_fixture_macro(macro_source_rows)
        diagnostics.extend(macro_diagnostics)
        alignment = align_macro_observations(
            macro_rows,
            exchange_calendar=request.exchange_calendar,
            target_sessions=request.target_sessions,
            max_staleness_sessions=request.macro_staleness_sessions,
        )
        diagnostics.extend(alignment.diagnostics)

        if not bars:
            diagnostics.append(
                Diagnostic(
                    code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    messageKey="market.no_overlap",
                    source=fixture_market.source,
                    details={
                        "startDate": request.data_start_date.isoformat(),
                        "endDate": request.end_date.isoformat(),
                    },
                )
            )
            return MarketDataResult(
                snapshot=None,
                fingerprint=None,
                cacheKey=cache_key,
                missingMarketSessions=missing,
                diagnostics=tuple(diagnostics),
            )

        return _market_data_result(
            symbol=request.symbol,
            currency=fixture_market.currency,
            source=fixture_market.source,
            bars=bars,
            macro=alignment.observations,
            cache_key=cache_key,
            context=request.snapshot_context,
            missing_sessions=missing,
            diagnostics=tuple(diagnostics),
        )


__all__ = [
    "FixtureMarketDataAdapter",
    "MacroAlignmentResult",
    "MacroSeriesType",
    "MarketDataRequest",
    "MarketDataResult",
    "align_macro_observations",
    "build_cache_key",
    "compose_data_snapshot",
    "normalize_rate_value",
]

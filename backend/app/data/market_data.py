"""Provider-neutral market and macro normalization boundaries."""

from __future__ import annotations

import hashlib
import json
import re
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
    MarketDataResult,
)
from app.data.fixtures import FixtureBundle, load_fixture
from app.domain.contracts import (
    DataSettings,
    DataSnapshot,
    MacroObservation,
    MarketBar,
    MarketSnapshot,
)
from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    DomainModel,
)


class MarketDataRequest(DomainModel):
    """Inclusive backtest range with an optional data-only prewarm interval."""

    symbol: str = Field(min_length=1)
    start_date: Date = Field(alias="startDate")
    end_date: Date = Field(alias="endDate")
    frequency: str = Field(default="1d", min_length=1)
    prewarm_start_date: Date | None = Field(default=None, alias="prewarmStartDate")
    exchange_calendar: ExchangeCalendar = Field(alias="exchangeCalendar")
    macro_staleness_sessions: int = Field(
        default_factory=lambda: DataSettings().macro_staleness_sessions,
        alias="macroStalenessSessions",
        strict=True,
    )

    @field_validator("symbol")
    @classmethod
    def validate_symbol(cls, value: str) -> str:
        if re.fullmatch(r"[A-Za-z0-9.^=_-]{1,32}", value) is None:
            raise ValueError("symbol contains unsupported characters")
        return value

    @field_validator("macro_staleness_sessions")
    @classmethod
    def validate_macro_staleness_policy(cls, value: int) -> int:
        return DataSettings(macroStalenessSessions=value).macro_staleness_sessions

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
        """Identify calendar and as-of policy inputs affecting normalized output."""

        payload = {
            "startDate": self.start_date.isoformat(),
            "prewarmStartDate": (
                self.prewarm_start_date.isoformat()
                if self.prewarm_start_date is not None
                else None
            ),
            "exchangeSessions": [
                session.isoformat() for session in self.exchange_calendar.trading_dates
            ],
            "macroStalenessSessions": self.macro_staleness_sessions,
        }
        return _fingerprint(payload)


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
        contextFingerprint=request.context_fingerprint,
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
    ``publishedAt`` always takes precedence.
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
        for target in targets:
            target_index = session_indexes[target]
            eligible: list[tuple[int, MacroObservation]] = []
            stale_ages: list[int] = []
            for row in source_rows:
                availability = row.published_at or row.observed_at
                if row.date > target or availability.date() > target:
                    continue
                source_index = bisect_right(sessions, row.date) - 1
                if source_index < 0:
                    stale_ages.append(target_index + 1)
                    continue
                age = target_index - source_index
                if age <= max_staleness_sessions:
                    eligible.append((age, row))
                else:
                    stale_ages.append(age)

            if eligible:
                # Newest source observation wins; later publication breaks ties.
                _, selected = max(
                    eligible,
                    key=lambda item: (
                        item[1].date,
                        _availability_sort_key(item[1]),
                    ),
                )
                aligned.append(
                    selected.model_copy(update={"aligned_session_date": target})
                )
                continue

            if stale_ages:
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
                            "ageSessions": min(stale_ages),
                        },
                    )
                )
            else:
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


def _market_data_result(
    *,
    symbol: str,
    currency: str,
    source: str,
    bars: tuple[MarketBar, ...],
    macro: tuple[MacroObservation, ...],
    cache_key: DataCacheKey,
    missing_sessions: tuple[Date, ...],
    diagnostics: tuple[Diagnostic, ...],
) -> MarketDataResult:
    if not bars:
        return MarketDataResult(
            snapshot=None,
            fingerprint=None,
            cacheKey=cache_key,
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
    macro_payload = [item.model_dump(mode="json", by_alias=True) for item in macro]
    normalized_fingerprint = _fingerprint(
        {
            "market": market.model_dump(mode="json", by_alias=True),
            "macro": macro_payload,
        }
    )
    snapshot = DataSnapshot(
        market=market,
        macro=macro,
        valuation=None,
        fingerprint=normalized_fingerprint,
    )
    return MarketDataResult(
        snapshot=snapshot,
        fingerprint=normalized_fingerprint,
        cacheKey=cache_key,
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
    "normalize_rate_value",
]

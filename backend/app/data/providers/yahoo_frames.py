"""Pure Yahoo response normalization; callers own network and metadata requests."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from datetime import date as Date
from datetime import datetime
from decimal import Decimal, DecimalException
from typing import Protocol

from app.data.contracts import DataCacheKey, MacroDataResult, MarketDataResult
from app.data.market_data import (
    MacroSeriesType,
    MarketDataRequest,
    _market_data_result,
    _missing_session_diagnostic,
    _missing_sessions,
    _outside_calendar_diagnostic,
    _required_market_unavailable,
    align_macro_observations,
    build_cache_key,
    normalize_rate_value,
)
from app.domain.contracts import MacroObservation, MarketBar
from app.domain.status import Diagnostic, DiagnosticCode


class _HistoryFrame(Protocol):
    columns: Iterable[object]

    def iterrows(self) -> Iterable[tuple[object, object]]: ...


def normalize_market_frame(
    frame: _HistoryFrame,
    request: MarketDataRequest,
    *,
    currency: str,
    cache_key: DataCacheKey,
    available_from: Date | None,
    provider: str,
) -> MarketDataResult:
    close_column = _resolve_column(frame, "Close", request.symbol)
    adjusted_column = _resolve_column(frame, "Adj Close", request.symbol)
    ohlc_columns = {
        name: _resolve_column(frame, name, request.symbol)
        for name in ("Open", "High", "Low")
    }
    if adjusted_column is None:
        return _required_market_unavailable(
            cache_key=cache_key,
            diagnostic=Diagnostic(
                code=DiagnosticCode.PRICE_BASIS_UNAVAILABLE,
                messageKey="market.price_basis_unavailable",
                source=provider,
                details={
                    "symbol": request.symbol,
                    "requiredValues": ["simulationPrice"],
                },
            ),
            missing_sessions=request.data_sessions,
        )

    bars_by_date: dict[Date, list[MarketBar]] = {}
    diagnostics: list[Diagnostic] = []
    expected_sessions = set(request.data_sessions)
    for index, row in frame.iterrows():
        observed_at = _as_datetime(index)
        if observed_at is None:
            diagnostics.append(
                Diagnostic(
                    code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    messageKey="market.observation_timestamp_unavailable",
                    source=provider,
                    details={"symbol": request.symbol},
                )
            )
            continue
        session_date = observed_at.date()
        if not request.data_start_date <= session_date <= request.end_date:
            continue
        if session_date not in expected_sessions:
            diagnostics.append(
                _outside_calendar_diagnostic(
                    session_date=session_date,
                    symbol=request.symbol,
                    source=provider,
                )
            )
            continue
        simulation_price = _as_positive_decimal(_row_value(row, adjusted_column))
        close_price = (
            _as_positive_decimal(_row_value(row, close_column))
            if close_column is not None and close_column != adjusted_column
            else None
        )
        if simulation_price is None:
            diagnostics.append(
                Diagnostic(
                    code=DiagnosticCode.PRICE_BASIS_UNAVAILABLE,
                    messageKey="market.price_basis_unavailable",
                    source=provider,
                    asOf=session_date,
                    details={
                        "symbol": request.symbol,
                        "date": session_date.isoformat(),
                        "missingFields": ["simulationPrice"],
                    },
                )
            )
            continue
        simulation_ohlc = (
            _simulation_ohlc(
                row,
                ohlc_columns,
                simulation_price=simulation_price,
                close_price=close_price,
            )
            if close_price is not None
            else (None, None, None)
        )
        bars_by_date.setdefault(session_date, []).append(
            MarketBar(
                date=session_date,
                symbol=request.symbol,
                simulationOpen=simulation_ohlc[0],
                simulationHigh=simulation_ohlc[1],
                simulationLow=simulation_ohlc[2],
                simulationPrice=simulation_price,
                currency=currency,
                source=provider,
                observedAt=observed_at,
            )
        )

    bars: list[MarketBar] = []
    for session_date, rows_for_date in sorted(bars_by_date.items()):
        if len(rows_for_date) != 1:
            diagnostics.append(
                Diagnostic(
                    code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    messageKey="market.duplicate_observation_date",
                    source=provider,
                    asOf=session_date,
                    details={
                        "symbol": request.symbol,
                        "date": session_date.isoformat(),
                        "rowCount": len(rows_for_date),
                    },
                )
            )
            continue
        bars.append(rows_for_date[0])

    quote_dates = {bar.date for bar in bars}
    if available_from is not None and bars and bars[0].date < available_from:
        available_from = None
    missing = _missing_sessions(request, quote_dates)
    if missing:
        diagnostics.append(_missing_session_diagnostic(missing, provider))
    if not bars:
        diagnostics.append(
            Diagnostic(
                code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                messageKey="market.no_valid_bars",
                source=provider,
                details={
                    "symbol": request.symbol,
                    "startDate": request.data_start_date.isoformat(),
                    "endDate": request.end_date.isoformat(),
                },
            )
        )
        return MarketDataResult(
            snapshot=None,
            fingerprint=None,
            cacheKey=cache_key,
            availableFrom=available_from,
            missingMarketSessions=missing,
            diagnostics=tuple(diagnostics),
        )

    return _market_data_result(
        symbol=request.symbol,
        currency=currency,
        source=provider,
        bars=tuple(bars),
        macro=(),
        cache_key=cache_key,
        context=request.snapshot_context,
        missing_sessions=missing,
        diagnostics=tuple(diagnostics),
        available_from=available_from,
    )


def _resolve_column(frame: _HistoryFrame, name: str, symbol: str) -> object | None:
    columns_value = frame.columns
    columns = list(columns_value)

    expected = name.casefold()
    candidates: list[object] = []
    for column in columns:
        tokens = column if isinstance(column, tuple) else (column,)
        if any(str(token).strip().casefold() == expected for token in tokens):
            candidates.append(column)
    tuple_candidates = [column for column in candidates if isinstance(column, tuple)]
    if not tuple_candidates and len(candidates) == 1:
        return candidates[0]
    symbol_candidates = [
        column
        for column in candidates
        if isinstance(column, tuple)
        and any(str(token).strip().casefold() == symbol.casefold() for token in column)
    ]
    if len(symbol_candidates) == 1:
        return symbol_candidates[0]
    return None


def _simulation_ohlc(
    row: object,
    columns: Mapping[str, object | None],
    *,
    simulation_price: Decimal,
    close_price: Decimal,
) -> tuple[Decimal | None, Decimal | None, Decimal | None]:
    raw_values = tuple(
        _as_positive_decimal(_row_value(row, columns[name]))
        if columns[name] is not None
        else None
        for name in ("Open", "High", "Low")
    )
    if any(value is None for value in raw_values):
        return None, None, None
    raw_open, raw_high, raw_low = raw_values
    assert raw_open is not None and raw_high is not None and raw_low is not None

    adjustment = simulation_price / close_price
    adjusted_open = raw_open * adjustment
    adjusted_high = raw_high * adjustment
    adjusted_low = raw_low * adjustment
    if (
        adjusted_high < max(adjusted_open, simulation_price)
        or adjusted_low > min(adjusted_open, simulation_price)
        or adjusted_high < adjusted_low
    ):
        return None, None, None
    return adjusted_open, adjusted_high, adjusted_low


def _row_value(row: object, column: object) -> object:
    getter = getattr(row, "__getitem__", None)
    if not callable(getter):
        return None
    try:
        return getter(column)
    except (KeyError, TypeError, IndexError, AttributeError):
        return None


def _as_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return value if _has_timezone(value) else None
    converter = getattr(value, "to_pydatetime", None)
    if callable(converter):
        converted = converter()
        if isinstance(converted, datetime) and _has_timezone(converted):
            return converted
    return None


def _has_timezone(value: datetime) -> bool:
    return value.tzinfo is not None and value.utcoffset() is not None


def _as_decimal(value: object) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        decimal_value = Decimal(str(value))
    except (DecimalException, ValueError):
        return None
    if not decimal_value.is_finite():
        return None
    return decimal_value


def _as_positive_decimal(value: object) -> Decimal | None:
    decimal_value = _as_decimal(value)
    return decimal_value if decimal_value is not None and decimal_value > 0 else None


def _macro_result(
    *,
    symbol: str,
    request: MarketDataRequest,
    series_type: str,
    source_unit: str,
    cache_source_unit: str,
    observations: tuple[MacroObservation, ...],
    data_version: str,
    diagnostics: tuple[Diagnostic, ...],
) -> MacroDataResult:
    cache_key = build_cache_key(
        request,
        provider="yahoo",
        data_version=data_version,
        price_basis=f"macro-{series_type}-{cache_source_unit}",
        start_date=request.macro_source_start_date,
        context_fingerprint=request.macro_context_fingerprint,
    )
    encoded = json.dumps(
        {
            "symbol": symbol,
            "seriesType": series_type,
            "sourceUnit": source_unit,
            "observations": [
                item.model_dump(mode="json", by_alias=True) for item in observations
            ],
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return MacroDataResult(
        symbol=symbol,
        observations=observations,
        fingerprint=hashlib.sha256(encoded).hexdigest(),
        cacheKey=cache_key,
        context=request.snapshot_context,
        diagnostics=diagnostics,
    )


def normalize_macro_frame(
    frame: _HistoryFrame,
    request: MarketDataRequest,
    *,
    close_column: object,
    normalized_type: MacroSeriesType,
    source_unit: str,
    effective_unit: str,
    data_version: str,
    provider: str,
) -> MacroDataResult:
    if (
        normalized_type is MacroSeriesType.RATE
        and normalize_rate_value(Decimal("0"), effective_unit) is None
    ):
        return _macro_result(
            symbol=request.symbol,
            request=request,
            series_type=normalized_type.value,
            source_unit=effective_unit,
            cache_source_unit=source_unit,
            observations=(),
            data_version=data_version,
            diagnostics=(
                Diagnostic(
                    code=DiagnosticCode.UNKNOWN_SOURCE_UNIT,
                    messageKey="rate.unknown_source_unit",
                    fieldPath="rate.sourceUnit",
                    source=provider,
                    details={
                        "symbol": request.symbol,
                        "sourceUnit": effective_unit,
                    },
                ),
            ),
        )

    source_rows: list[MacroObservation] = []
    diagnostics: list[Diagnostic] = []
    trading_sessions = set(request.exchange_calendar.trading_dates)
    for index, row in frame.iterrows():
        observed_at = _as_datetime(index)
        if observed_at is None:
            diagnostics.append(
                Diagnostic(
                    code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    messageKey="macro.observation_timestamp_unavailable",
                    source=provider,
                    details={"symbol": request.symbol},
                )
            )
            continue
        observation_date = observed_at.date()
        if not request.macro_source_start_date <= observation_date <= request.end_date:
            continue
        if observation_date not in trading_sessions:
            # Yahoo can include non-trading calendar dates (for example
            # Labor Day) with an empty row. Only a missing observation
            # on an expected exchange session is a data-quality error.
            continue
        raw_value = _as_decimal(_row_value(row, close_column))
        if raw_value is None:
            diagnostics.append(
                Diagnostic(
                    code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    messageKey="macro.invalid_observation",
                    asOf=observation_date,
                    source=provider,
                    details={"symbol": request.symbol},
                )
            )
            continue

        if normalized_type is MacroSeriesType.RATE:
            converted = normalize_rate_value(raw_value, effective_unit)
            assert converted is not None
            output_value = converted
            output_unit = "percent_point"
            row_source_unit = effective_unit
        else:
            output_value = raw_value
            output_unit = "index_points"
            row_source_unit = "index_points"

        source_rows.append(
            MacroObservation(
                date=observation_date,
                symbol=request.symbol,
                value=output_value,
                unit=output_unit,
                source=provider,
                observedAt=observed_at,
                publishedAt=None,
                sourceUnit=row_source_unit,
            )
        )

    if not source_rows and not diagnostics:
        diagnostics.append(
            Diagnostic(
                code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                messageKey="macro.no_observations",
                source=provider,
                details={"symbol": request.symbol},
            )
        )
    alignment = align_macro_observations(
        source_rows,
        exchange_calendar=request.exchange_calendar,
        target_sessions=request.target_sessions,
        max_staleness_sessions=request.macro_staleness_sessions,
    )
    diagnostics.extend(alignment.diagnostics)
    if not alignment.observations and not diagnostics:
        diagnostics.append(
            Diagnostic(
                code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                messageKey="macro.no_usable_observations",
                source=provider,
                details={"symbol": request.symbol},
            )
        )
    return _macro_result(
        symbol=request.symbol,
        request=request,
        series_type=normalized_type.value,
        source_unit=effective_unit,
        cache_source_unit=source_unit,
        observations=alignment.observations,
        data_version=data_version,
        diagnostics=tuple(diagnostics),
    )

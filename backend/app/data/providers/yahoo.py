"""Yahoo Finance/yfinance adapter with a strict normalized-data boundary.

The adapter intentionally imports yfinance only when a live request is made.
Deterministic tests inject a small ticker factory and never access the network.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Callable, Iterable, Mapping
from datetime import date as Date
from datetime import datetime, timedelta
from decimal import Decimal, DecimalException
from importlib import import_module
from importlib.metadata import PackageNotFoundError, version
from math import isfinite
from typing import Protocol, cast

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


TickerFactory = Callable[[str], object]
_LOGGER = logging.getLogger(__name__)

_YAHOO_DUAL_PRICE_BASIS = "adj-close-simulation+split-close-valuation-v1"
_NORMALIZER_VERSION = "yfinance-adapter-v1"


class YahooFinanceAdapter:
    """Normalize yfinance daily history without exposing its response objects."""

    provider = "yahoo"

    def __init__(
        self,
        *,
        ticker_factory: TickerFactory | None = None,
        request_timeout_seconds: float = 10.0,
        data_version: str | None = None,
    ) -> None:
        if (
            isinstance(request_timeout_seconds, bool)
            or not isinstance(request_timeout_seconds, (int, float))
            or not isfinite(request_timeout_seconds)
            or request_timeout_seconds <= 0
        ):
            raise ValueError("request timeout must be a finite positive number")
        self._ticker_factory = ticker_factory
        self._request_timeout_seconds = float(request_timeout_seconds)
        self._configured_data_version = data_version

    @property
    def data_version(self) -> str:
        if self._configured_data_version is not None:
            return self._configured_data_version
        try:
            package_version = version("yfinance")
        except PackageNotFoundError:
            package_version = "uninstalled"
        return f"yfinance-{package_version}-{_NORMALIZER_VERSION}"

    def cache_identity(self, request: MarketDataRequest) -> DataCacheKey:
        """Return the vendor, interval, version, basis, and policy cache identity."""

        return build_cache_key(
            request,
            provider=self.provider,
            data_version=self.data_version,
            price_basis=_YAHOO_DUAL_PRICE_BASIS,
        )

    def macro_cache_identity(
        self,
        request: MarketDataRequest,
        *,
        series_type: MacroSeriesType | str,
        source_unit: str,
    ) -> DataCacheKey:
        try:
            normalized_type = MacroSeriesType(series_type).value
        except ValueError:
            normalized_type = str(series_type)
        return build_cache_key(
            request,
            provider=self.provider,
            data_version=self.data_version,
            price_basis=f"macro-{normalized_type}-{source_unit}",
            start_date=request.macro_source_start_date,
        )

    def load(self, request: MarketDataRequest) -> MarketDataResult:
        cache_key = self.cache_identity(request)
        try:
            ticker = self._ticker(request.symbol)
            frame = _history_frame(
                ticker,
                request,
                timeout_seconds=self._request_timeout_seconds,
            )
        except Exception as error:
            return _required_market_unavailable(
                cache_key=cache_key,
                diagnostic=_provider_error(error, request.symbol),
                missing_sessions=request.data_sessions,
            )

        try:
            currency, currency_error = _quote_currency(ticker)
        except Exception as error:
            return _required_market_unavailable(
                cache_key=cache_key,
                diagnostic=_provider_error(error, request.symbol),
                missing_sessions=request.data_sessions,
            )
        if currency_error is not None:
            return _required_market_unavailable(
                cache_key=cache_key,
                diagnostic=currency_error,
                missing_sessions=request.data_sessions,
            )
        assert currency is not None

        try:
            close_column = _resolve_column(frame, "Close", request.symbol)
            adjusted_column = _resolve_column(frame, "Adj Close", request.symbol)
        except Exception as error:
            return _required_market_unavailable(
                cache_key=cache_key,
                diagnostic=_provider_error(error, request.symbol),
                missing_sessions=request.data_sessions,
            )
        if (
            close_column is None
            or adjusted_column is None
            or close_column == adjusted_column
        ):
            return _required_market_unavailable(
                cache_key=cache_key,
                diagnostic=Diagnostic(
                    code=DiagnosticCode.PRICE_BASIS_UNAVAILABLE,
                    messageKey="market.price_basis_unavailable",
                    source=self.provider,
                    details={
                        "symbol": request.symbol,
                        "requiredValues": ["simulationPrice", "valuationPrice"],
                    },
                ),
                missing_sessions=request.data_sessions,
            )

        bars_by_date: dict[Date, list[MarketBar]] = {}
        diagnostics: list[Diagnostic] = []
        expected_sessions = set(request.data_sessions)
        try:
            for index, row in frame.iterrows():
                observed_at = _as_datetime(index)
                if observed_at is None:
                    diagnostics.append(
                        Diagnostic(
                            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                            messageKey="market.observation_timestamp_unavailable",
                            source=self.provider,
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
                            source=self.provider,
                        )
                    )
                    continue
                simulation_price = _as_positive_decimal(
                    _row_value(row, adjusted_column)
                )
                valuation_price = _as_positive_decimal(_row_value(row, close_column))
                if simulation_price is None or valuation_price is None:
                    diagnostics.append(
                        Diagnostic(
                            code=DiagnosticCode.PRICE_BASIS_UNAVAILABLE,
                            messageKey="market.price_basis_unavailable",
                            source=self.provider,
                            asOf=session_date,
                            details={
                                "symbol": request.symbol,
                                "date": session_date.isoformat(),
                                "missingFields": [
                                    field
                                    for field, value in (
                                        ("simulationPrice", simulation_price),
                                        ("valuationPrice", valuation_price),
                                    )
                                    if value is None
                                ],
                            },
                        )
                    )
                    continue
                bars_by_date.setdefault(session_date, []).append(
                    MarketBar(
                        date=session_date,
                        symbol=request.symbol,
                        simulationPrice=simulation_price,
                        valuationPrice=valuation_price,
                        currency=currency,
                        source=self.provider,
                        observedAt=observed_at,
                    )
                )
        except Exception as error:
            return _required_market_unavailable(
                cache_key=cache_key,
                diagnostic=_provider_error(error, request.symbol),
                missing_sessions=request.data_sessions,
            )

        bars: list[MarketBar] = []
        for session_date, rows_for_date in sorted(bars_by_date.items()):
            if len(rows_for_date) != 1:
                diagnostics.append(
                    Diagnostic(
                        code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                        messageKey="market.duplicate_observation_date",
                        source=self.provider,
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
        missing = _missing_sessions(request, quote_dates)
        if missing:
            diagnostics.append(_missing_session_diagnostic(missing, self.provider))
        if not bars:
            diagnostics.append(
                Diagnostic(
                    code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    messageKey="market.no_valid_bars",
                    source=self.provider,
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
                missingMarketSessions=missing,
                diagnostics=tuple(diagnostics),
            )

        return _market_data_result(
            symbol=request.symbol,
            currency=currency,
            source=self.provider,
            bars=tuple(bars),
            macro=(),
            cache_key=cache_key,
            missing_sessions=missing,
            diagnostics=tuple(diagnostics),
        )

    def load_macro(
        self,
        request: MarketDataRequest,
        *,
        series_type: MacroSeriesType | str,
        source_unit: str = "auto",
    ) -> MacroDataResult:
        """Load and normalize one daily index or rate series as-of each session."""

        try:
            normalized_type = MacroSeriesType(series_type)
        except ValueError:
            return _macro_result(
                symbol=request.symbol,
                request=request,
                series_type=str(series_type),
                source_unit=source_unit,
                cache_source_unit=source_unit,
                observations=(),
                data_version=self.data_version,
                diagnostics=(
                    Diagnostic(
                        code=DiagnosticCode.INVALID_PARAMETER,
                        messageKey="data.invalid_macro_series_type",
                        fieldPath="data.seriesType",
                        source=self.provider,
                        details={"seriesType": str(series_type)},
                    ),
                ),
            )

        try:
            ticker = self._ticker(request.symbol)
            frame = _history_frame(
                ticker,
                request,
                start_date=request.macro_source_start_date,
                timeout_seconds=self._request_timeout_seconds,
            )
        except Exception as error:
            return _macro_result(
                symbol=request.symbol,
                request=request,
                series_type=normalized_type.value,
                source_unit=source_unit,
                cache_source_unit=source_unit,
                observations=(),
                data_version=self.data_version,
                diagnostics=(_provider_error(error, request.symbol),),
            )

        try:
            close_column = _resolve_column(frame, "Close", request.symbol)
        except Exception as error:
            return _macro_result(
                symbol=request.symbol,
                request=request,
                series_type=normalized_type.value,
                source_unit=source_unit,
                cache_source_unit=source_unit,
                observations=(),
                data_version=self.data_version,
                diagnostics=(_provider_error(error, request.symbol),),
            )
        if close_column is None:
            return _macro_result(
                symbol=request.symbol,
                request=request,
                series_type=normalized_type.value,
                source_unit=source_unit,
                cache_source_unit=source_unit,
                observations=(),
                data_version=self.data_version,
                diagnostics=(
                    Diagnostic(
                        code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                        messageKey="macro.value_field_unavailable",
                        source=self.provider,
                        details={
                            "symbol": request.symbol,
                        },
                    ),
                ),
            )

        effective_unit = source_unit
        if normalized_type is MacroSeriesType.RATE and source_unit == "auto":
            try:
                metadata = _safe_attribute(ticker, "history_metadata")
                metadata_unit = _metadata_value(metadata, "unit")
            except Exception as error:
                return _macro_result(
                    symbol=request.symbol,
                    request=request,
                    series_type=normalized_type.value,
                    source_unit=source_unit,
                    cache_source_unit=source_unit,
                    observations=(),
                    data_version=self.data_version,
                    diagnostics=(_provider_error(error, request.symbol),),
                )
            effective_unit = metadata_unit if isinstance(metadata_unit, str) else "auto"

        source_rows: list[MacroObservation] = []
        diagnostics: list[Diagnostic] = []
        try:
            for index, row in frame.iterrows():
                observed_at = _as_datetime(index)
                if observed_at is None:
                    diagnostics.append(
                        Diagnostic(
                            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                            messageKey="macro.observation_timestamp_unavailable",
                            source=self.provider,
                            details={"symbol": request.symbol},
                        )
                    )
                    continue
                observation_date = observed_at.date()
                if (
                    not request.macro_source_start_date
                    <= observation_date
                    <= request.end_date
                ):
                    continue
                raw_value = _as_decimal(_row_value(row, close_column))
                if raw_value is None:
                    diagnostics.append(
                        Diagnostic(
                            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                            messageKey="macro.invalid_observation",
                            asOf=observation_date,
                            source=self.provider,
                            details={"symbol": request.symbol},
                        )
                    )
                    continue

                if normalized_type is MacroSeriesType.RATE:
                    converted = normalize_rate_value(raw_value, effective_unit)
                    if converted is None:
                        diagnostics.append(
                            Diagnostic(
                                code=DiagnosticCode.UNKNOWN_SOURCE_UNIT,
                                messageKey="rate.unknown_source_unit",
                                fieldPath="rate.sourceUnit",
                                asOf=observation_date,
                                source=self.provider,
                                details={
                                    "symbol": request.symbol,
                                    "sourceUnit": effective_unit,
                                },
                            )
                        )
                        continue
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
                        source=self.provider,
                        observedAt=observed_at,
                        publishedAt=None,
                        sourceUnit=row_source_unit,
                    )
                )
        except Exception as error:
            return _macro_result(
                symbol=request.symbol,
                request=request,
                series_type=normalized_type.value,
                source_unit=effective_unit,
                cache_source_unit=source_unit,
                observations=(),
                data_version=self.data_version,
                diagnostics=(_provider_error(error, request.symbol),),
            )

        if not source_rows and not diagnostics:
            diagnostics.append(
                Diagnostic(
                    code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    messageKey="macro.no_observations",
                    source=self.provider,
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
                    source=self.provider,
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
            data_version=self.data_version,
            diagnostics=tuple(diagnostics),
        )

    def _ticker(self, symbol: str) -> object:
        if self._ticker_factory is not None:
            return self._ticker_factory(symbol)
        # Lazy import keeps normal tests and application startup fully offline.
        yfinance = import_module("yfinance")
        ticker_constructor = getattr(yfinance, "Ticker", None)
        if not callable(ticker_constructor):
            raise RuntimeError("installed yfinance package has no Ticker API")
        return ticker_constructor(symbol)


def _history_frame(
    ticker: object,
    request: MarketDataRequest,
    *,
    start_date: Date | None = None,
    timeout_seconds: float,
) -> _HistoryFrame:
    end_exclusive = request.end_date + timedelta(days=1)
    history = _safe_attribute(ticker, "history")
    if not callable(history):
        raise ValueError("yfinance ticker has no history method")
    # Upstream documents start as inclusive, end as exclusive, and auto_adjust=True
    # by default. We pass the next date and disable adjustment explicitly so the
    # original Adj Close and Close columns remain distinct.
    # Source: https://github.com/ranaroussi/yfinance/blob/1.7.0/yfinance/scrapers/history.py
    frame = history(
        start=(
            request.data_start_date if start_date is None else start_date
        ).isoformat(),
        end=end_exclusive.isoformat(),
        interval=request.frequency,
        auto_adjust=False,
        back_adjust=False,
        actions=False,
        keepna=True,
        repair=False,
        rounding=False,
        raise_errors=True,
        timeout=timeout_seconds,
    )
    if not hasattr(frame, "columns") or not callable(getattr(frame, "iterrows", None)):
        raise ValueError("yfinance history response is not a tabular history frame")
    return cast(_HistoryFrame, frame)


def _quote_currency(ticker: object) -> tuple[str | None, Diagnostic | None]:
    values: list[tuple[str, str]] = []
    for attribute in ("fast_info", "history_metadata"):
        metadata = _safe_attribute(ticker, attribute)
        value = _metadata_value(metadata, "currency")
        if isinstance(value, str) and value and value.strip() == value:
            values.append((attribute, value))

    currencies = {value for _, value in values}
    if len(currencies) > 1:
        return None, Diagnostic(
            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
            messageKey="market.quote_currency_conflict",
            source="yahoo",
            details={"currencySources": [name for name, _ in values]},
        )
    if not values:
        return None, Diagnostic(
            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
            messageKey="market.quote_currency_unavailable",
            source="yahoo",
        )
    # fast_info is the primary quote source; history metadata is a safe fallback
    # only when the returned currency code is explicit.
    # Source: https://github.com/ranaroussi/yfinance/blob/1.7.0/yfinance/scrapers/quote.py
    return values[0][1], None


def _safe_attribute(target: object, name: str) -> object | None:
    try:
        return cast(object, getattr(target, name))
    except (AttributeError, KeyError):
        return None


def _metadata_value(metadata: object | None, key: str) -> object | None:
    if metadata is None:
        return None
    if isinstance(metadata, Mapping):
        try:
            return metadata.get(key)
        except (AttributeError, KeyError):
            return None
    getter = getattr(metadata, "__getitem__", None)
    if not callable(getter):
        return None
    try:
        return cast(object, getter(key))
    except (KeyError, IndexError):
        return None


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


def _provider_error(error: Exception, symbol: str) -> Diagnostic:
    failure_kind = _provider_failure_kind(error)
    exception_type = type(error).__name__
    message_key = {
        "rate_limited": "market.provider_rate_limited",
        "timeout": "market.provider_timeout",
    }.get(failure_kind, "market.provider_request_failed")
    _LOGGER.warning(
        "Market data provider request failed",
        extra={
            "provider": "yahoo",
            "failure_kind": failure_kind,
            "exception_type": exception_type,
        },
    )
    return Diagnostic(
        code=DiagnosticCode.PROVIDER_REQUEST_FAILED,
        messageKey=message_key,
        source="yahoo",
        details={
            "symbol": symbol,
            "exceptionType": exception_type,
            "failureKind": failure_kind,
        },
    )


def _provider_failure_kind(error: Exception) -> str:
    exception_names = tuple(
        base.__name__.casefold() for base in type(error).__mro__ if base.__name__
    )
    if (
        any("ratelimit" in name or "rate_limit" in name for name in exception_names)
        or _http_status(error) == 429
    ):
        return "rate_limited"
    if isinstance(error, TimeoutError) or any(
        "timeout" in name for name in exception_names
    ):
        return "timeout"
    return "request_failed"


def _http_status(error: Exception) -> int | None:
    for target in (error, _safe_attribute(error, "response")):
        if target is None:
            continue
        for name in ("status_code", "status", "code"):
            value = _safe_attribute(target, name)
            if isinstance(value, int) and not isinstance(value, bool):
                return value
    return None


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
        diagnostics=diagnostics,
    )


__all__ = ["YahooFinanceAdapter"]

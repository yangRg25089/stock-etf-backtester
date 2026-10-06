"""Yahoo Finance/yfinance adapter with a strict normalized-data boundary.

The adapter intentionally imports yfinance only when a live request is made.
Deterministic tests inject a small ticker factory and never access the network.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable, Mapping
from datetime import date as Date
from datetime import datetime, timedelta
from importlib import import_module
from importlib.metadata import PackageNotFoundError, version
from math import isfinite
from typing import cast
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.data.contracts import DataCacheKey, MacroDataResult, MarketDataResult
from app.data.market_data import (
    MacroSeriesType,
    MarketDataRequest,
    _required_market_unavailable,
    build_cache_key,
)
from app.domain.status import Diagnostic, DiagnosticCode

from .yahoo_frames import (
    _as_datetime,
    _HistoryFrame,
    _macro_result,
    _resolve_column,
    normalize_macro_frame,
    normalize_market_frame,
)

TickerFactory = Callable[[str], object]
_LOGGER = logging.getLogger(__name__)

_YAHOO_PRICE_BASIS = "adjusted-close-simulation-v1"
_NORMALIZER_VERSION = "yfinance-adapter-v4"


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
            price_basis=_YAHOO_PRICE_BASIS,
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
            context_fingerprint=request.macro_context_fingerprint,
        )

    def quote_currency(self, symbol: str) -> tuple[str | None, Diagnostic | None]:
        """Use the same normalized currency lookup as market snapshots."""
        try:
            ticker = self._ticker(symbol)
        except Exception as error:
            return None, _provider_error(error, symbol)
        return _quote_currency(ticker, symbol)

    def exchange_code(self, symbol: str) -> tuple[str | None, Diagnostic | None]:
        """Read Yahoo's exchange identifier without retaining vendor objects."""

        try:
            ticker = self._ticker(symbol)
        except Exception as error:
            return None, _provider_error(error, symbol)
        for attribute in ("fast_info", "history_metadata"):
            for key in ("exchange", "exchangeName"):
                value, diagnostic = _read_metadata(ticker, attribute, key, symbol)
                if diagnostic is not None:
                    return None, diagnostic
                if isinstance(value, str) and value.strip():
                    return value.strip(), None
        return None, Diagnostic(
            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
            messageKey="market.exchange_metadata_unavailable",
            fieldPath="run.symbol",
            source=self.provider,
            details={"symbol": symbol},
        )

    def load(self, request: MarketDataRequest) -> MarketDataResult:
        cache_key = self.cache_identity(request)
        try:
            ticker = self._ticker(request.symbol)
        except Exception as error:
            return _required_market_unavailable(
                cache_key=cache_key,
                diagnostic=_provider_error(error, request.symbol),
                missing_sessions=request.data_sessions,
            )

        available_from, metadata_error = _available_from(ticker, request.symbol)
        if metadata_error is not None:
            return _required_market_unavailable(
                cache_key=cache_key,
                diagnostic=metadata_error,
                missing_sessions=request.data_sessions,
            )
        if available_from is not None and request.end_date < available_from:
            return MarketDataResult(
                cacheKey=cache_key,
                availableFrom=available_from,
                diagnostics=(
                    Diagnostic(
                        code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                        messageKey="market.period_before_listing",
                        fieldPath="run.startDate",
                        source=self.provider,
                        asOf=available_from,
                        details={
                            "symbol": request.symbol,
                            "availableFrom": available_from.isoformat(),
                        },
                    ),
                ),
            )

        frame, history_error = _history_frame(
            ticker, request, timeout_seconds=self._request_timeout_seconds
        )
        if history_error is not None:
            return _required_market_unavailable(
                cache_key=cache_key,
                diagnostic=history_error,
                missing_sessions=request.data_sessions,
            )
        assert frame is not None
        currency, currency_error = _quote_currency(ticker, request.symbol)
        if currency_error is not None:
            return _required_market_unavailable(
                cache_key=cache_key,
                diagnostic=currency_error,
                missing_sessions=request.data_sessions,
            )
        assert currency is not None
        return normalize_market_frame(
            frame,
            request,
            currency=currency,
            cache_key=cache_key,
            available_from=available_from,
            provider=self.provider,
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

        frame, history_error = _history_frame(
            ticker,
            request,
            start_date=request.macro_source_start_date,
            timeout_seconds=self._request_timeout_seconds,
        )
        if history_error is not None:
            return _macro_result(
                symbol=request.symbol,
                request=request,
                series_type=normalized_type.value,
                source_unit=source_unit,
                cache_source_unit=source_unit,
                observations=(),
                data_version=self.data_version,
                diagnostics=(history_error,),
            )
        assert frame is not None
        close_column = _resolve_column(frame, "Close", request.symbol)
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
            metadata_unit, metadata_error = _read_metadata(
                ticker, "history_metadata", "unit", request.symbol
            )
            if metadata_error is not None:
                return _macro_result(
                    symbol=request.symbol,
                    request=request,
                    series_type=normalized_type.value,
                    source_unit=source_unit,
                    cache_source_unit=source_unit,
                    observations=(),
                    data_version=self.data_version,
                    diagnostics=(metadata_error,),
                )
            effective_unit = metadata_unit if isinstance(metadata_unit, str) else "auto"

        return normalize_macro_frame(
            frame,
            request,
            close_column=close_column,
            normalized_type=normalized_type,
            source_unit=source_unit,
            effective_unit=effective_unit,
            data_version=self.data_version,
            provider=self.provider,
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
) -> tuple[_HistoryFrame | None, Diagnostic | None]:
    return _fetch_history(
        ticker,
        symbol=request.symbol,
        start=request.data_start_date if start_date is None else start_date,
        end=request.end_date,
        frequency=request.frequency,
        actions=False,
        timeout_seconds=timeout_seconds,
    )


def _fetch_history(
    ticker: object,
    *,
    symbol: str,
    start: Date,
    end: Date,
    frequency: str,
    actions: bool,
    timeout_seconds: float,
) -> tuple[_HistoryFrame | None, Diagnostic | None]:
    end_exclusive = end + timedelta(days=1)
    history = _safe_attribute(ticker, "history")
    if not callable(history):
        return None, _invalid_history_response(symbol)
    # Upstream documents start as inclusive, end as exclusive, and auto_adjust=True
    # by default. We pass the next date and disable adjustment explicitly so the
    # original Adj Close and Close columns remain distinct.
    # Source: https://github.com/ranaroussi/yfinance/blob/1.7.0/yfinance/scrapers/history.py
    try:
        frame = history(
            start=start.isoformat(),
            end=end_exclusive.isoformat(),
            interval=frequency,
            auto_adjust=False,
            back_adjust=False,
            actions=actions,
            keepna=True,
            repair=False,
            rounding=False,
            raise_errors=True,
            timeout=timeout_seconds,
        )
    except Exception as error:
        return None, _provider_error(error, symbol)
    if not isinstance(_safe_attribute(frame, "columns"), Iterable) or not callable(
        _safe_attribute(frame, "iterrows")
    ):
        return None, _invalid_history_response(symbol)
    return cast(_HistoryFrame, frame), None


def _invalid_history_response(symbol: str) -> Diagnostic:
    return Diagnostic(
        code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
        messageKey="data.invalid_history_response",
        source="yahoo",
        details={"symbol": symbol},
    )


def _read_metadata(
    ticker: object, attribute: str, key: str, symbol: str
) -> tuple[object, Diagnostic | None]:
    # yfinance properties and mapping getters can perform lazy vendor requests.
    try:
        value = _metadata_value(_safe_attribute(ticker, attribute), key)
    except Exception as error:
        return None, _provider_error(error, symbol)
    return value, None


def _available_from(
    ticker: object, symbol: str
) -> tuple[Date | None, Diagnostic | None]:
    """Normalize the vendor's first trade timestamp, never infer it from gaps."""

    value, error = _read_metadata(ticker, "history_metadata", "firstTradeDate", symbol)
    if error is not None:
        return None, error
    timezone, error = _read_metadata(
        ticker, "history_metadata", "exchangeTimezoneName", symbol
    )
    if error is not None:
        return None, error
    try:
        zone = ZoneInfo(timezone) if isinstance(timezone, str) else None
        timestamp = _as_datetime(value)
        if timestamp is not None:
            return (timestamp.astimezone(zone) if zone else timestamp).date(), None
        if isinstance(value, int) and not isinstance(value, bool) and zone is not None:
            return datetime.fromtimestamp(value, zone).date(), None
    except (ZoneInfoNotFoundError, ValueError, OverflowError, OSError):
        return None, None
    return None, None


def _quote_currency(
    ticker: object, symbol: str
) -> tuple[str | None, Diagnostic | None]:
    values: list[tuple[str, str]] = []
    for attribute in ("fast_info", "history_metadata"):
        value, diagnostic = _read_metadata(ticker, attribute, "currency", symbol)
        if diagnostic is not None:
            return None, diagnostic
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


def _provider_error(error: Exception, symbol: str) -> Diagnostic:
    failure_kind = _provider_failure_kind(error)
    exception_type = type(error).__name__
    message_key = {
        "rate_limited": "market.provider_rate_limited",
        "timeout": "market.provider_timeout",
    }.get(failure_kind, "data.provider_request_failed")
    _LOGGER.warning(
        "Data provider request failed",
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


__all__ = ["YahooFinanceAdapter"]

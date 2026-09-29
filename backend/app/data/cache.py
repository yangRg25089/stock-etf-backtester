"""Cache boundary for provider-neutral normalized market and macro data."""

from __future__ import annotations

import logging
from collections import OrderedDict
from threading import RLock
from typing import TYPE_CHECKING, Protocol

from app.data.contracts import DataCacheKey, MacroDataResult, MarketDataResult
from app.domain.status import DiagnosticSeverity

if TYPE_CHECKING:
    from app.data.market_data import MarketDataRequest


NormalizedDataResult = MarketDataResult | MacroDataResult
_LOGGER = logging.getLogger(__name__)


class NormalizedDataCache(Protocol):
    """Minimal cache interface; provider response objects never enter it."""

    def get(self, key: DataCacheKey) -> NormalizedDataResult | None: ...

    def put(self, key: DataCacheKey, value: NormalizedDataResult) -> None: ...


class InMemoryDataCache:
    """Process-local cache containing immutable, normalized results only."""

    def __init__(self, *, max_entries: int = 128) -> None:
        if (
            isinstance(max_entries, bool)
            or not isinstance(max_entries, int)
            or max_entries < 1
        ):
            raise ValueError("max_entries must be a positive integer")
        self._max_entries = max_entries
        self._values: OrderedDict[DataCacheKey, NormalizedDataResult] = OrderedDict()
        self._lock = RLock()

    def get(self, key: DataCacheKey) -> NormalizedDataResult | None:
        with self._lock:
            value = self._values.get(key)
            if value is not None:
                self._values.move_to_end(key)
            return value

    def put(self, key: DataCacheKey, value: NormalizedDataResult) -> None:
        if value.cache_key != key:
            raise ValueError("cache entry identity does not match its key")
        with self._lock:
            self._values[key] = value
            self._values.move_to_end(key)
            while len(self._values) > self._max_entries:
                self._values.popitem(last=False)

    def clear(self) -> None:
        """Discard normalized in-memory entries."""

        with self._lock:
            self._values.clear()


class CacheableMarketDataProvider(Protocol):
    """Provider contract consumed by the cache decorator."""

    def cache_identity(self, request: MarketDataRequest) -> DataCacheKey: ...

    def load(self, request: MarketDataRequest) -> MarketDataResult: ...


class CacheableMacroDataProvider(Protocol):
    """Provider contract for one explicitly typed macro series."""

    def macro_cache_identity(
        self,
        request: MarketDataRequest,
        *,
        series_type: str,
        source_unit: str,
    ) -> DataCacheKey: ...

    def load_macro(
        self,
        request: MarketDataRequest,
        *,
        series_type: str,
        source_unit: str,
    ) -> MacroDataResult: ...


class CachedMarketDataProvider:
    """Reuse normalized results from a bounded cache or explicitly refresh them."""

    def __init__(
        self,
        provider: CacheableMarketDataProvider,
        cache: NormalizedDataCache,
    ) -> None:
        self._provider = provider
        self._cache = cache

    def load(
        self, request: MarketDataRequest, *, refresh: bool = False
    ) -> MarketDataResult:
        key = self._provider.cache_identity(request)
        provider_name = _provider_name(self._provider)
        if refresh:
            _log_cache_event("refresh", provider_name, "market")
        else:
            cached = self._cache.get(key)
            if isinstance(cached, MarketDataResult):
                _log_cache_event("hit", provider_name, "market")
                return cached
            if cached is not None:
                raise ValueError(
                    "cache identity contains a different normalized result"
                )
            _log_cache_event("miss", provider_name, "market")

        result = self._provider.load(request)
        # A failed/unavailable result may be transient, so only snapshots without
        # error diagnostics are cached. No vendor-specific response is retained.
        if result.snapshot is not None and not any(
            item.severity is DiagnosticSeverity.ERROR for item in result.diagnostics
        ):
            self._cache.put(key, result)
        return result


class CachedMacroDataProvider:
    """Cache usable macro data with explicit units in the request identity.

    Auto-detected rate units bypass the cache because the resolved provider unit
    is not known until after the cache lookup.
    """

    def __init__(
        self,
        provider: CacheableMacroDataProvider,
        cache: NormalizedDataCache,
    ) -> None:
        self._provider = provider
        self._cache = cache

    def load(
        self,
        request: MarketDataRequest,
        *,
        series_type: str,
        source_unit: str = "auto",
        refresh: bool = False,
    ) -> MacroDataResult:
        if series_type == "rate" and source_unit == "auto":
            _log_cache_event(
                "bypass_auto_unit", _provider_name(self._provider), "macro"
            )
            return self._provider.load_macro(
                request, series_type=series_type, source_unit=source_unit
            )

        key = self._provider.macro_cache_identity(
            request, series_type=series_type, source_unit=source_unit
        )
        provider_name = _provider_name(self._provider)
        if refresh:
            _log_cache_event("refresh", provider_name, "macro")
        else:
            cached = self._cache.get(key)
            if isinstance(cached, MacroDataResult):
                _log_cache_event("hit", provider_name, "macro")
                return cached
            if cached is not None:
                raise ValueError(
                    "cache identity contains a different normalized result"
                )
            _log_cache_event("miss", provider_name, "macro")

        result = self._provider.load_macro(
            request, series_type=series_type, source_unit=source_unit
        )
        # Empty/partial unavailable data may be transient and must not poison cache.
        if result.observations and not any(
            item.severity is DiagnosticSeverity.ERROR for item in result.diagnostics
        ):
            self._cache.put(key, result)
        return result


def _provider_name(provider: object) -> str:
    name = getattr(provider, "provider", None)
    return name if isinstance(name, str) and name else type(provider).__name__


def _log_cache_event(event: str, provider: str, cache_kind: str) -> None:
    _LOGGER.info(
        "Normalized data cache event",
        extra={
            "cache_event": event,
            "provider": provider,
            "cache_kind": cache_kind,
        },
    )

"""Cache boundary for provider-neutral normalized market and macro data."""

from __future__ import annotations

from threading import RLock
from typing import TYPE_CHECKING, Protocol

from app.data.contracts import DataCacheKey, MacroDataResult, MarketDataResult
from app.domain.status import DiagnosticSeverity

if TYPE_CHECKING:
    from app.data.market_data import MarketDataRequest


NormalizedDataResult = MarketDataResult | MacroDataResult


class NormalizedDataCache(Protocol):
    """Minimal cache interface; provider response objects never enter it."""

    def get(self, key: DataCacheKey) -> NormalizedDataResult | None: ...

    def put(self, key: DataCacheKey, value: NormalizedDataResult) -> None: ...


class InMemoryDataCache:
    """Process-local cache containing immutable, normalized results only."""

    def __init__(self) -> None:
        self._values: dict[DataCacheKey, NormalizedDataResult] = {}
        self._lock = RLock()

    def get(self, key: DataCacheKey) -> NormalizedDataResult | None:
        with self._lock:
            return self._values.get(key)

    def put(self, key: DataCacheKey, value: NormalizedDataResult) -> None:
        if value.cache_key != key:
            raise ValueError("cache entry identity does not match its key")
        with self._lock:
            self._values[key] = value

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
    """Decorate one normalized provider with identity-safe cache reuse."""

    def __init__(
        self,
        provider: CacheableMarketDataProvider,
        cache: NormalizedDataCache,
    ) -> None:
        self._provider = provider
        self._cache = cache

    def load(self, request: MarketDataRequest) -> MarketDataResult:
        key = self._provider.cache_identity(request)
        cached = self._cache.get(key)
        if isinstance(cached, MarketDataResult):
            return cached
        if cached is not None:
            raise ValueError("cache identity contains a different normalized result")

        result = self._provider.load(request)
        # A failed/unavailable result may be transient, so only snapshots without
        # error diagnostics are cached. No vendor-specific response is retained.
        if result.snapshot is not None and not any(
            item.severity is DiagnosticSeverity.ERROR for item in result.diagnostics
        ):
            self._cache.put(key, result)
        return result


class CachedMacroDataProvider:
    """Cache usable normalized macro observations under their complete request key."""

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
    ) -> MacroDataResult:
        key = self._provider.macro_cache_identity(
            request, series_type=series_type, source_unit=source_unit
        )
        cached = self._cache.get(key)
        if isinstance(cached, MacroDataResult):
            return cached
        if cached is not None:
            raise ValueError("cache identity contains a different normalized result")

        result = self._provider.load_macro(
            request, series_type=series_type, source_unit=source_unit
        )
        # Empty/partial unavailable data may be transient and must not poison cache.
        if result.observations and not any(
            item.severity is DiagnosticSeverity.ERROR for item in result.diagnostics
        ):
            self._cache.put(key, result)
        return result

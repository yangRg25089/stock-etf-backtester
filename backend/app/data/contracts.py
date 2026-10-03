"""Provider-neutral data-boundary results and cache identities."""

from __future__ import annotations

import hashlib
import json
from datetime import date as Date

from pydantic import Field, model_validator

from app.domain.contracts import DataSnapshot, MacroObservation
from app.domain.status import Diagnostic, DomainModel


class SnapshotContext(DomainModel):
    """The shared simulation window, independent of provider cache policies."""

    start_date: Date = Field(alias="startDate")
    end_date: Date = Field(alias="endDate")
    frequency: str = "1d"
    sessions: tuple[Date, ...]
    normalization_version: str = Field(
        default="normalized-data-v1", alias="normalizationVersion", min_length=1
    )

    @model_validator(mode="after")
    def validate_sessions(self) -> SnapshotContext:
        if self.start_date > self.end_date:
            raise ValueError("snapshot context start must not follow its end")
        if self.sessions != tuple(sorted(set(self.sessions))) or any(
            not self.start_date <= day <= self.end_date for day in self.sessions
        ):
            raise ValueError(
                "snapshot context sessions must be ordered within its range"
            )
        return self


class DataCacheKey(DomainModel):
    """Identity for a normalized provider request with inclusive date bounds."""

    provider: str = Field(min_length=1)
    symbol: str = Field(min_length=1)
    frequency: str = Field(min_length=1)
    start_date: Date = Field(alias="startDate")
    end_date: Date = Field(alias="endDate")
    data_version: str = Field(alias="dataVersion", min_length=1)
    price_basis: str = Field(alias="priceBasis", min_length=1)
    context_fingerprint: str = Field(default="", alias="contextFingerprint")
    normalization_version: str = Field(
        default="normalized-data-v1", alias="normalizationVersion", min_length=1
    )

    @model_validator(mode="after")
    def validate_range(self) -> DataCacheKey:
        if self.start_date > self.end_date:
            raise ValueError("cache startDate must not be after inclusive endDate")
        return self

    def validate_context(self, context: SnapshotContext) -> None:
        if (
            self.frequency != context.frequency
            or self.normalization_version != context.normalization_version
            or any(
                not self.start_date <= day <= self.end_date for day in context.sessions
            )
        ):
            raise ValueError("cache identity does not cover the snapshot context")

    @property
    def fingerprint(self) -> str:
        """Return a stable digest over every cache-identity dimension."""

        encoded = json.dumps(
            self.model_dump(mode="json", by_alias=True),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()


class MarketDataResult(DomainModel):
    """Normalized market/indicator snapshot plus visible data diagnostics."""

    snapshot: DataSnapshot | None = None
    fingerprint: str | None = None
    cache_key: DataCacheKey = Field(alias="cacheKey")
    context: SnapshotContext | None = None
    available_from: Date | None = Field(default=None, alias="availableFrom")
    missing_market_sessions: tuple[Date, ...] = Field(
        default=(), alias="missingMarketSessions"
    )
    diagnostics: tuple[Diagnostic, ...] = ()

    @model_validator(mode="after")
    def validate_snapshot_fingerprint(self) -> MarketDataResult:
        if self.snapshot is not None and self.snapshot.fingerprint != self.fingerprint:
            raise ValueError("result fingerprint must match normalized snapshot")
        if self.snapshot is None and self.fingerprint is not None:
            raise ValueError("unavailable data results must not have a fingerprint")
        if self.missing_market_sessions != tuple(
            sorted(set(self.missing_market_sessions))
        ):
            raise ValueError("missing market sessions must be sorted and unique")
        if self.snapshot is not None:
            if self.context is None:
                raise ValueError("available market data must include its context")
            if self.snapshot.market.symbol != self.cache_key.symbol:
                raise ValueError("market result must match its cache symbol")
        if self.context is not None:
            self.cache_key.validate_context(self.context)
        return self


class MacroDataResult(DomainModel):
    """Normalized macro observations with source and availability metadata."""

    symbol: str = Field(min_length=1)
    observations: tuple[MacroObservation, ...] = ()
    fingerprint: str = Field(min_length=1)
    cache_key: DataCacheKey = Field(alias="cacheKey")
    context: SnapshotContext | None = None
    diagnostics: tuple[Diagnostic, ...] = ()

    @model_validator(mode="after")
    def validate_observation_context(self) -> MacroDataResult:
        if self.cache_key.symbol != self.symbol or any(
            observation.symbol != self.symbol for observation in self.observations
        ):
            raise ValueError("macro observations and cache must use its symbol")
        if self.observations and self.context is None:
            raise ValueError("available macro data must include its context")
        if self.context is not None:
            self.cache_key.validate_context(self.context)
        return self


class MacroAlignmentResult(DomainModel):
    """As-of macro values aligned to sessions without overwriting source dates."""

    observations: tuple[MacroObservation, ...] = ()
    diagnostics: tuple[Diagnostic, ...] = ()

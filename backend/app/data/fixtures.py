"""Deterministic, provider-neutral fixture loading for offline tests.

The loader intentionally accepts a fixture name rather than an arbitrary path.  It
ships with the application package and never imports or reads a notebook, so
normal tests and production code cannot accidentally depend on a developer's
external workspace.
"""

from __future__ import annotations

import hashlib
import json
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any, ClassVar

from pydantic import Field

from app.domain.contracts import (
    DataSnapshot,
    MacroObservation,
    MarketSnapshot,
    ValuationSnapshot,
)
from app.domain.status import DomainModel

_FIXTURE_DIR = Path(__file__).with_name("fixtures")
_FIXTURE_FILES: dict[str, str] = {"task4_core": "task4_core.json"}


class FixtureCorporateAction(DomainModel):
    date: date
    symbol: str = Field(min_length=1)
    type: str = Field(min_length=1)
    factor: Decimal = Field(gt=0)
    source: str = Field(min_length=1)


class FixtureCompanyFact(DomainModel):
    fact: str = Field(min_length=1)
    symbol: str = Field(min_length=1)
    period_start: date = Field(alias="periodStart")
    period_end: date = Field(alias="periodEnd")
    filed: date
    frame: str = Field(min_length=1)
    value: Decimal | None = None
    unit: str = Field(min_length=1)
    split_basis: str = Field(alias="splitBasis", min_length=1)
    accession: str = Field(min_length=1)


class FixtureHolding(DomainModel):
    case: str = Field(min_length=1)
    snapshot_date: date = Field(alias="snapshotDate")
    fund: str = Field(min_length=1)
    symbol: str = Field(min_length=1)
    weight: Decimal = Field(ge=0, le=1)
    eps: Decimal | None = None
    valuation_price: Decimal | None = Field(default=None, alias="valuationPrice")
    identity_matched: bool = Field(alias="identityMatched")
    financials_matched: bool = Field(alias="financialsMatched")
    price_matched: bool = Field(alias="priceMatched")

    @property
    def matches_all(self) -> bool:
        """Whether this holding can contribute to an ETF earnings yield."""

        return (
            self.identity_matched
            and self.financials_matched
            and self.price_matched
            and self.eps is not None
            and self.valuation_price is not None
        )


class FixtureBundle(DomainModel):
    """Normalized data plus calendar and valuation edge-case fixture records."""

    fixture_id: str = Field(alias="fixtureId", min_length=1)
    version: str = Field(min_length=1)
    snapshot: DataSnapshot
    exchange_dates: tuple[date, ...] = Field(alias="exchangeDates")
    holidays: tuple[date, ...] = ()
    corporate_actions: tuple[FixtureCorporateAction, ...] = Field(
        alias="corporateActions"
    )
    company_facts: tuple[FixtureCompanyFact, ...] = Field(alias="companyFacts")
    holdings: tuple[FixtureHolding, ...] = ()
    fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    # The path is an internal loading detail, not part of the serialized data
    # contract.  Excluding it prevents local filesystem paths from leaking into
    # snapshots or API responses while keeping it available for integrity tests.
    path: Path = Field(exclude=True)

    _fixture_directory: ClassVar[Path] = _FIXTURE_DIR


def _canonical_fingerprint(payload: object) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _load_payload(name: str) -> tuple[dict[str, Any], Path, str]:
    if not isinstance(name, str):
        raise ValueError(f"unknown fixture: {name}")
    filename = _FIXTURE_FILES.get(name)
    if filename is None:
        raise ValueError(f"unknown fixture: {name}")
    path = _FIXTURE_DIR / filename
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"fixture payload must be an object: {name}")
    return payload, path, _canonical_fingerprint(payload)


def load_fixture(name: str = "task4_core") -> FixtureBundle:
    """Load a checked-in fixture and return normalized immutable records."""

    payload, path, fingerprint = _load_payload(name)
    market_payload = payload["market"]
    valuation_payload = payload.get("valuation")
    market = MarketSnapshot(
        **market_payload,
        fingerprint=f"{fingerprint}:market",
    )
    valuation = (
        None
        if valuation_payload is None
        else ValuationSnapshot(
            **valuation_payload,
            fingerprint=f"{fingerprint}:valuation",
        )
    )
    snapshot = DataSnapshot(
        market=market,
        macro=tuple(
            MacroObservation.model_validate(item) for item in payload.get("macro", [])
        ),
        valuation=valuation,
        fingerprint=fingerprint,
    )
    bundle_payload: dict[str, Any] = {
        "fixtureId": payload["fixtureId"],
        "version": payload["version"],
        "snapshot": snapshot,
        "exchangeDates": payload["exchangeDates"],
        "holidays": payload.get("holidays", []),
        "corporateActions": payload.get("corporateActions", []),
        "companyFacts": payload.get("companyFacts", []),
        "holdings": payload.get("holdings", []),
        "fingerprint": fingerprint,
        "path": path,
    }
    return FixtureBundle.model_validate(bundle_payload)


__all__ = [
    "FixtureBundle",
    "FixtureCompanyFact",
    "FixtureCorporateAction",
    "FixtureHolding",
    "load_fixture",
]

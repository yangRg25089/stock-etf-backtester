"""Provider-neutral financial facts and valuation result contracts."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from datetime import date as Date
from decimal import Decimal

from pydantic import Field, field_validator, model_validator

from app.domain.status import DomainModel


class FinancialFact(DomainModel):
    """One per-share XBRL fact with filing provenance and optional verified class."""

    symbol: str = Field(min_length=1)
    cik: str = Field(pattern=r"^\d{10}$")
    concept: str = Field(min_length=1)
    value: Decimal
    unit: str = Field(min_length=1)
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    period_start: Date = Field(alias="periodStart")
    period_end: Date = Field(alias="periodEnd")
    filed: Date
    published_at: datetime | None = Field(default=None, alias="publishedAt")
    form: str = Field(min_length=1)
    accession: str = Field(min_length=1)
    split_basis: str | None = Field(default=None, alias="splitBasis")
    stock_class_id: str | None = Field(default=None, alias="stockClassId", min_length=1)
    source: str = Field(min_length=1)
    source_version: str = Field(alias="sourceVersion", min_length=1)

    @field_validator("value")
    @classmethod
    def finite_value(cls, value: Decimal) -> Decimal:
        if not value.is_finite():
            raise ValueError("financial fact value must be finite")
        return value

    @field_validator("published_at")
    @classmethod
    def timezone_aware_publication(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("publishedAt must include a timezone")
        return value.astimezone(UTC) if value is not None else None

    @model_validator(mode="after")
    def validate_period(self) -> FinancialFact:
        if self.period_start > self.period_end:
            raise ValueError("financial fact period start must not follow its end")
        if self.filed < self.period_end:
            raise ValueError("financial fact cannot be filed before its report period")
        return self


class ETFProfile(DomainModel):
    """Explicit, fail-closed evidence about an ETF's valuation capabilities."""

    instrument_type: str = Field(alias="instrumentType", min_length=1)
    physical: bool | None = Field(strict=True)
    long_only: bool | None = Field(alias="longOnly", strict=True)
    leveraged: bool | None = Field(strict=True)
    inverse: bool | None = Field(strict=True)
    synthetic: bool | None = Field(strict=True)
    fund_of_funds: bool | None = Field(alias="fundOfFunds", strict=True)
    has_derivatives: bool | None = Field(alias="hasDerivatives", strict=True)

    @property
    def supports_equity_pe(self) -> bool:
        """Return true only when every required fund capability is confirmed."""

        return (
            self.instrument_type == "etf"
            and self.physical is True
            and self.long_only is True
            and self.leveraged is False
            and self.inverse is False
            and self.synthetic is False
            and self.fund_of_funds is False
            and self.has_derivatives is False
        )


class SecurityIdentity(DomainModel):
    """Resolved issuer and optional share class tied to an N-PORT identifier."""

    symbol: str = Field(min_length=1)
    cik: str = Field(pattern=r"^\d{10}$")
    cusip: str | None = None
    isin: str | None = None
    stock_class_id: str | None = Field(default=None, alias="stockClassId", min_length=1)

    @model_validator(mode="after")
    def require_source_identifier(self) -> SecurityIdentity:
        if self.cusip is None and self.isin is None:
            raise ValueError("resolved identity must include CUSIP or ISIN")
        return self


class NportHolding(DomainModel):
    """One normalized as-filed N-PORT position; no provider row is retained."""

    holding_id: str = Field(alias="holdingId", min_length=1)
    weight: Decimal | None = None
    asset_type: str = Field(alias="assetType", min_length=1)
    issuer_type: str = Field(alias="issuerType", min_length=1)
    payoff_profile: str | None = Field(default=None, alias="payoffProfile")
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    ticker: str | None = None
    cusip: str | None = None
    isin: str | None = None
    symbol: str | None = None
    cik: str | None = Field(default=None, pattern=r"^\d{10}$")
    stock_class_id: str | None = Field(default=None, alias="stockClassId", min_length=1)
    identity_matched: bool = Field(default=False, alias="identityMatched", strict=True)
    source: str = Field(min_length=1)

    @field_validator("weight")
    @classmethod
    def finite_weight(cls, value: Decimal | None) -> Decimal | None:
        if value is not None and not value.is_finite():
            raise ValueError("holding weight must be finite")
        return value

    @model_validator(mode="after")
    def validate_identity(self) -> NportHolding:
        if self.identity_matched and (self.symbol is None or self.cik is None):
            raise ValueError(
                "matched N-PORT holdings require a resolved symbol and CIK"
            )
        return self

    @property
    def is_direct_common_equity(self) -> bool:
        """Whether the reported row is a direct common-equity position."""

        asset_type = _normalize_code(self.asset_type)
        issuer_type = _normalize_code(self.issuer_type)
        return (
            asset_type in {"equity-common", "common-equity"}
            and issuer_type in {"corporate", "corp"}
            and _normalize_code(self.payoff_profile or "") == "long"
        )


class NportSnapshot(DomainModel):
    """An as-filed N-PORT holdings snapshot with report and publication dates."""

    fund: str = Field(min_length=1)
    report_date: Date = Field(alias="reportDate")
    filed: Date
    published_at: datetime | None = Field(default=None, alias="publishedAt")
    accession: str = Field(min_length=1)
    form: str = Field(min_length=1)
    source: str = Field(min_length=1)
    source_version: str = Field(alias="sourceVersion", min_length=1)
    capabilities: ETFProfile
    holdings: tuple[NportHolding, ...] = ()

    @field_validator("published_at")
    @classmethod
    def timezone_aware_publication(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("publishedAt must include a timezone")
        return value.astimezone(UTC) if value is not None else None

    @model_validator(mode="after")
    def validate_dates(self) -> NportSnapshot:
        if self.filed < self.report_date:
            raise ValueError("N-PORT filing date cannot precede report date")
        return self


class PriceReference(DomainModel):
    """Valuation price with explicit currency, share basis, and verified class."""

    date: Date
    symbol: str = Field(min_length=1)
    value: Decimal = Field(gt=0)
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    split_basis: str = Field(alias="splitBasis", min_length=1)
    stock_class_id: str | None = Field(default=None, alias="stockClassId", min_length=1)
    source: str = Field(min_length=1)

    @field_validator("value")
    @classmethod
    def finite_value(cls, value: Decimal) -> Decimal:
        if not value.is_finite():
            raise ValueError("valuation price must be finite")
        return value


class ValuationFactReference(DomainModel):
    """Provenance retained for one selected EPS fact."""

    symbol: str = Field(min_length=1)
    value: Decimal
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    report_period_start: Date = Field(alias="reportPeriodStart")
    report_period_end: Date = Field(alias="reportPeriodEnd")
    filed: Date
    published_at: datetime | None = Field(default=None, alias="publishedAt")
    form: str = Field(min_length=1)
    accession: str = Field(min_length=1)
    split_basis: str | None = Field(default=None, alias="splitBasis")
    stock_class_id: str | None = Field(default=None, alias="stockClassId", min_length=1)
    source: str = Field(min_length=1)
    source_version: str = Field(alias="sourceVersion", min_length=1)


class ValuationContribution(DomainModel):
    """One matched constituent's signed contribution to ETF earnings yield."""

    symbol: str = Field(min_length=1)
    stock_class_id: str = Field(alias="stockClassId", min_length=1)
    weight: Decimal = Field(ge=0, le=1)
    eps: Decimal
    eps_method: str = Field(alias="epsMethod", min_length=1)
    valuation_price: Decimal = Field(alias="valuationPrice", gt=0)
    earnings_yield: Decimal = Field(alias="earningsYield")
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    fact_references: tuple[ValuationFactReference, ...] = Field(alias="factReferences")

    @field_validator("eps", "earnings_yield")
    @classmethod
    def finite_contribution_value(cls, value: Decimal) -> Decimal:
        if not value.is_finite():
            raise ValueError("valuation contribution must be finite")
        return value


class ValuationObservation(DomainModel):
    """One provider-neutral PE observation with calculation provenance."""

    date: Date
    symbol: str = Field(min_length=1)
    stock_class_id: str | None = Field(default=None, alias="stockClassId", min_length=1)
    valuation_price: Decimal = Field(alias="valuationPrice", gt=0)
    eps: Decimal | None = None
    pe: Decimal | None = Field(default=None, gt=0)
    earnings_yield: Decimal | None = Field(default=None, alias="earningsYield")
    coverage: Decimal | None = Field(default=None, ge=0, le=1)
    stock_weight: Decimal | None = Field(default=None, alias="stockWeight", ge=0, le=1)
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    method: str = Field(min_length=1)
    source: str = Field(min_length=1)
    source_version: str | None = Field(default=None, alias="sourceVersion")
    as_of: Date = Field(alias="asOf")
    report_period_start: Date | None = Field(default=None, alias="reportPeriodStart")
    report_period_end: Date | None = Field(default=None, alias="reportPeriodEnd")
    published_at: datetime | None = Field(default=None, alias="publishedAt")
    accession: str | None = None
    snapshot_date: Date | None = Field(default=None, alias="snapshotDate")
    fact_references: tuple[ValuationFactReference, ...] = Field(
        default=(), alias="factReferences"
    )
    contributors: tuple[ValuationContribution, ...] = ()

    @field_validator("eps", "earnings_yield")
    @classmethod
    def finite_optional_value(cls, value: Decimal | None) -> Decimal | None:
        if value is not None and not value.is_finite():
            raise ValueError("valuation value must be finite")
        return value

    @field_validator("published_at")
    @classmethod
    def timezone_aware_publication(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("publishedAt must include a timezone")
        return value.astimezone(UTC) if value is not None else None

    @model_validator(mode="after")
    def validate_report_period(self) -> ValuationObservation:
        if (self.report_period_start is None) != (self.report_period_end is None):
            raise ValueError("report period start and end must be provided together")
        if (
            self.report_period_start is not None
            and self.report_period_end is not None
            and self.report_period_start > self.report_period_end
        ):
            raise ValueError("report period start must not follow its end")
        return self


def _normalize_code(value: str) -> str:
    normalized = re.sub(r"[_\s]+", "-", value.strip().lower())
    return normalized

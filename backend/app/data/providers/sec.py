"""Schema-checked SEC CompanyFacts and N-PORT normalization adapters.

These adapters accept already retrieved SEC payloads and perform no network I/O.
CompanyFacts uses the documented ``facts -> us-gaap -> concept -> units`` shape;
N-PORT uses the SEC quarterly data-set tables and joins by accession/holding id.
See https://www.sec.gov/search-filings/edgar-application-programming-interfaces
and https://www.sec.gov/files/nport_readme.pdf.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from datetime import date, datetime
from decimal import Decimal, DecimalException
from typing import Final

from app.domain.valuation import (
    ETFProfile,
    FinancialFact,
    NportHolding,
    NportSnapshot,
    SecurityIdentity,
)

SEC_COMPANYFACTS_SOURCE: Final[str] = "sec:companyfacts"
SEC_NPORT_SOURCE: Final[str] = "sec:nport"
_ACCESSION_RE: Final[re.Pattern[str]] = re.compile(r"^\d{10}-\d{2}-\d{6}$")
_EPS_UNIT_RE: Final[re.Pattern[str]] = re.compile(r"^([A-Z]{3})\s*/\s*shares?$", re.I)

_ASSET_TYPES: Final[dict[str, str]] = {
    "STIV": "short-term-investment-vehicle",
    "RA": "repurchase-agreement",
    "EC": "equity-common",
    "EP": "equity-preferred",
    "DBT": "debt",
    "DCO": "derivative-commodity",
    "DCR": "derivative-credit",
    "DE": "derivative-equity",
    "DFX": "derivative-foreign-exchange",
    "DIR": "derivative-interest-rate",
    "DO": "derivative-other",
    "SN": "structured-note",
    "LOAN": "loan",
    "ABS-MBS": "abs-mbs",
    "ABS-ABCP": "abs-abcp",
    "ABS-CB": "abs-collateralized-debt",
    "ABS-O": "abs-other",
    "COMM": "commodity",
    "RE": "real-estate",
    "OTHER": "other",
    "EQUITY-COMMON": "equity-common",
    "COMMON-EQUITY": "equity-common",
    "DEBT": "debt",
}
_ISSUER_TYPES: Final[dict[str, str]] = {
    "CORP": "corporate",
    "UST": "us-treasury",
    "AGY": "us-government-agency",
    "GOVT": "government-sponsored-entity",
    "GSE": "government-sponsored-entity",
    "MUNI": "municipal",
    "NSOV": "non-us-sovereign",
    "PF": "private-fund",
    "PRIV": "private-fund",
    "RF": "registered-fund",
    "REGF": "registered-fund",
    "OTH": "other",
    "CORPORATE": "corporate",
}


class SecCompanyFactsAdapter:
    """Validate and normalize SEC's CompanyFacts diluted EPS concept."""

    provider = SEC_COMPANYFACTS_SOURCE
    concept = "us-gaap:EarningsPerShareDiluted"

    def __init__(
        self,
        *,
        data_version: str = "sec-companyfacts-v1",
        max_fact_rows: int = 100_000,
    ) -> None:
        self.data_version = _version(data_version)
        self.max_fact_rows = _row_limit(max_fact_rows, "max_fact_rows")

    def parse(
        self,
        payload: Mapping[str, object],
        *,
        symbol: str,
        expected_cik: str,
        published_at_by_accession: Mapping[str, datetime] | None = None,
        split_basis_by_accession: Mapping[str, str] | None = None,
        verified_stock_class_by_accession: Mapping[str, str] | None = None,
    ) -> tuple[FinancialFact, ...]:
        """Convert one SEC CompanyFacts JSON document into normalized facts.

        The SEC CompanyFacts API does not provide the per-share split basis or
        filing acceptance timestamp or exact listed share class for each fact.
        Callers may join those from separate point-in-time sources. The requested
        symbol is not evidence of a share class; absent verified class metadata
        stays unknown.
        """

        if not _valid_symbol(symbol):
            raise ValueError("symbol has unsupported characters")
        normalized_expected_cik = _cik(expected_cik)
        if not isinstance(payload, Mapping):
            raise ValueError("CompanyFacts payload must be an object")
        payload_cik = _cik(payload.get("cik"))
        if payload_cik != normalized_expected_cik:
            raise ValueError("CompanyFacts CIK does not match the requested issuer")

        facts = _mapping(payload.get("facts"), "CompanyFacts facts")
        us_gaap = _mapping(facts.get("us-gaap"), "CompanyFacts us-gaap taxonomy")
        concept_payload = _mapping(
            us_gaap.get("EarningsPerShareDiluted"),
            "CompanyFacts diluted EPS concept",
        )
        units = _mapping(concept_payload.get("units"), "CompanyFacts EPS units")
        published_by_accession = published_at_by_accession or {}
        split_basis_by_accession = split_basis_by_accession or {}
        stock_class_by_accession = verified_stock_class_by_accession or {}
        result: list[FinancialFact] = []
        row_count = 0

        for unit, unit_rows in units.items():
            if not isinstance(unit, str):
                raise ValueError("CompanyFacts EPS unit must be text")
            unit_match = _EPS_UNIT_RE.fullmatch(unit.strip())
            if unit_match is None:
                raise ValueError(f"unsupported CompanyFacts EPS unit: {unit}")
            currency = unit_match.group(1).upper()
            if not isinstance(unit_rows, list):
                raise ValueError("CompanyFacts EPS unit values must be a list")
            for raw_row in unit_rows:
                row_count += 1
                if row_count > self.max_fact_rows:
                    raise ValueError("CompanyFacts fact row limit exceeded")
                row = _mapping(raw_row, "CompanyFacts row")
                start = _source_date(row.get("start"), "CompanyFacts start")
                end = _source_date(row.get("end"), "CompanyFacts end")
                filed = _source_date(row.get("filed"), "CompanyFacts filed")
                accession = _accession(row.get("accn"), "CompanyFacts accn")
                form = _source_text(row.get("form"), "CompanyFacts form", maximum=20)
                value = _source_decimal(row.get("val"), "CompanyFacts val")
                published_at = published_by_accession.get(accession)
                if published_at is not None and (
                    published_at.tzinfo is None or published_at.utcoffset() is None
                ):
                    raise ValueError(
                        "CompanyFacts publication timestamp must include a timezone"
                    )
                split_basis = split_basis_by_accession.get(accession)
                if split_basis is not None:
                    split_basis = _source_text(split_basis, "split basis", maximum=100)
                stock_class_id = stock_class_by_accession.get(accession)
                if stock_class_id is not None:
                    stock_class_id = _source_text(
                        stock_class_id, "verified stock class id", maximum=100
                    )
                result.append(
                    FinancialFact(
                        symbol=symbol,
                        cik=normalized_expected_cik,
                        concept=self.concept,
                        value=value,
                        unit=unit.strip(),
                        currency=currency,
                        periodStart=start,
                        periodEnd=end,
                        filed=filed,
                        publishedAt=published_at,
                        form=form,
                        accession=accession,
                        splitBasis=split_basis,
                        stockClassId=stock_class_id,
                        source=self.provider,
                        sourceVersion=self.data_version,
                    )
                )
        return tuple(
            sorted(
                result,
                key=lambda item: (
                    item.period_end,
                    item.period_start,
                    item.filed,
                    item.accession,
                ),
            )
        )


class SecNportAdapter:
    """Join SEC N-PORT quarterly flat-file rows into one immutable snapshot."""

    provider = SEC_NPORT_SOURCE

    def __init__(
        self,
        *,
        data_version: str = "sec-nport-v1",
        max_holding_rows: int = 100_000,
        max_identifier_rows: int = 200_000,
    ) -> None:
        self.data_version = _version(data_version)
        self.max_holding_rows = _row_limit(max_holding_rows, "max_holding_rows")
        self.max_identifier_rows = _row_limit(
            max_identifier_rows, "max_identifier_rows"
        )

    def parse(
        self,
        submission: Mapping[str, object],
        holdings: Iterable[Mapping[str, object]],
        identifiers: Iterable[Mapping[str, object]],
        *,
        fund: str,
        capabilities: ETFProfile | None = None,
        published_at: datetime | None = None,
        security_identities: Mapping[str, SecurityIdentity] | None = None,
    ) -> NportSnapshot:
        """Normalize one NPORT-P filing using SEC's documented TSV columns.

        When parsing a quarterly data-set release, ``published_at`` must be the
        release availability time, which can be later than the filing date.
        """

        if not _valid_symbol(fund):
            raise ValueError("fund symbol has unsupported characters")
        filing = _mapping(submission, "N-PORT submission")
        accession = _accession(filing.get("ACCESSION_NUMBER"), "N-PORT accession")
        form = _source_text(filing.get("SUB_TYPE"), "N-PORT filing type", maximum=20)
        if form.upper() not in {"NPORT-P", "NPORT-P/A"}:
            raise ValueError("unsupported N-PORT filing type")
        filed = _source_date(filing.get("FILING_DATE"), "N-PORT filing date")
        report_date = _source_date(filing.get("REPORT_DATE"), "N-PORT report date")
        if published_at is not None and (
            published_at.tzinfo is None or published_at.utcoffset() is None
        ):
            raise ValueError("N-PORT publication timestamp must include a timezone")

        holding_rows = _bounded_rows(
            holdings,
            max_rows=self.max_holding_rows,
            label="N-PORT holding",
        )
        identifier_rows = _bounded_rows(
            identifiers,
            max_rows=self.max_identifier_rows,
            label="N-PORT identifier",
        )
        ticker_by_holding = self._tickers_for_accession(
            identifier_rows, accession=accession
        )
        identity_by_holding = security_identities or {}
        normalized_holdings: list[NportHolding] = []
        seen_holding_ids: set[str] = set()

        for raw_row in holding_rows:
            row = _mapping(raw_row, "N-PORT holding row")
            row_accession = _accession(
                row.get("ACCESSION_NUMBER"), "N-PORT holding accession"
            )
            if row_accession != accession:
                continue
            holding_id = _source_text(
                row.get("HOLDING_ID"), "N-PORT holding id", maximum=80
            )
            if holding_id in seen_holding_ids:
                raise ValueError(
                    "N-PORT contains duplicate holding ids for one accession"
                )
            seen_holding_ids.add(holding_id)

            cusip = _optional_source_text(row.get("ISSUER_CUSIP"), maximum=9)
            isin, ticker = ticker_by_holding.get(holding_id, (None, None))
            resolved = identity_by_holding.get(holding_id)
            compared_identifiers = (
                (
                    (resolved.cusip, cusip),
                    (resolved.isin, isin),
                )
                if resolved is not None
                else ()
            )
            available_identifiers = tuple(
                (expected, reported)
                for expected, reported in compared_identifiers
                if expected is not None and reported is not None
            )
            identity_matches = bool(available_identifiers) and all(
                expected == reported for expected, reported in available_identifiers
            )
            weight = _nport_percentage(row.get("PERCENTAGE"))
            currency = _optional_currency(row.get("CURRENCY_CODE"))
            normalized_holdings.append(
                NportHolding(
                    holdingId=holding_id,
                    weight=weight,
                    assetType=_asset_type(row.get("ASSET_CAT")),
                    issuerType=_issuer_type(row.get("ISSUER_TYPE")),
                    payoffProfile=_payoff_profile(row.get("PAYOFF_PROFILE")),
                    currency=currency,
                    ticker=ticker,
                    cusip=cusip,
                    isin=isin,
                    symbol=resolved.symbol if identity_matches and resolved else None,
                    cik=resolved.cik if identity_matches and resolved else None,
                    stockClassId=(
                        resolved.stock_class_id
                        if identity_matches and resolved
                        else None
                    ),
                    identityMatched=identity_matches,
                    source=self.provider,
                )
            )

        if not normalized_holdings:
            raise ValueError("N-PORT filing has no holding rows for the accession")
        profile = capabilities or _unknown_profile()
        asset_types = {item.asset_type for item in normalized_holdings}
        issuer_types = {item.issuer_type for item in normalized_holdings}
        updates: dict[str, object] = {}
        if any(item.startswith("derivative-") for item in asset_types):
            updates["has_derivatives"] = True
        if {"registered-fund", "private-fund"} & issuer_types:
            updates["fund_of_funds"] = True
        if any(
            (item.payoff_profile or "").lower() == "short"
            for item in normalized_holdings
        ):
            updates["long_only"] = False
        if any(
            item.weight is not None and item.weight < 0 for item in normalized_holdings
        ):
            updates["long_only"] = False
        if updates:
            profile_values = profile.model_dump(mode="python", by_alias=False)
            profile_values.update(updates)
            profile = ETFProfile.model_validate(profile_values)

        return NportSnapshot(
            fund=fund,
            reportDate=report_date,
            filed=filed,
            publishedAt=published_at,
            accession=accession,
            form=form.upper(),
            source=self.provider,
            sourceVersion=self.data_version,
            capabilities=profile,
            holdings=tuple(normalized_holdings),
        )

    def _tickers_for_accession(
        self,
        rows: tuple[Mapping[str, object], ...],
        *,
        accession: str,
    ) -> dict[str, tuple[str | None, str | None]]:
        result: dict[str, tuple[str | None, str | None]] = {}
        for raw_row in rows:
            row = _mapping(raw_row, "N-PORT identifier row")
            row_accession = row.get("ACCESSION_NUMBER")
            if (
                row_accession is not None
                and _accession(row_accession, "N-PORT identifier accession")
                != accession
            ):
                continue
            holding_id = _source_text(
                row.get("HOLDING_ID"), "N-PORT identifier holding id", maximum=80
            )
            isin = _optional_source_text(row.get("IDENTIFIER_ISIN"), maximum=12)
            ticker = _optional_source_text(row.get("IDENTIFIER_TICKER"), maximum=50)
            if holding_id in result:
                current_isin, current_ticker = result[holding_id]
                if current_isin and isin and current_isin != isin:
                    raise ValueError("N-PORT holding has conflicting ISIN identifiers")
                if current_ticker and ticker and current_ticker != ticker:
                    raise ValueError(
                        "N-PORT holding has conflicting ticker identifiers"
                    )
                result[holding_id] = (current_isin or isin, current_ticker or ticker)
            else:
                result[holding_id] = (isin, ticker)
        return result


def _unknown_profile() -> ETFProfile:
    return ETFProfile(
        instrumentType="unknown",
        physical=None,
        longOnly=None,
        leveraged=None,
        inverse=None,
        synthetic=None,
        fundOfFunds=None,
        hasDerivatives=None,
    )


def _asset_type(value: object) -> str:
    raw = _source_text(value, "N-PORT asset category", maximum=40).upper()
    return _ASSET_TYPES.get(raw, f"unknown:{raw.lower()}")


def _issuer_type(value: object) -> str:
    raw = _source_text(value, "N-PORT issuer type", maximum=40).upper()
    return _ISSUER_TYPES.get(raw, f"unknown:{raw.lower()}")


def _payoff_profile(value: object) -> str | None:
    raw = _optional_source_text(value, maximum=20)
    if raw is None:
        return None
    normalized = raw.strip().lower()
    aliases = {"long": "long", "short": "short", "na": "na", "n/a": "na"}
    return aliases.get(normalized, f"unknown:{normalized}")


def _optional_currency(value: object) -> str | None:
    raw = _optional_source_text(value, maximum=3)
    if raw is None:
        return None
    normalized = raw.upper()
    if re.fullmatch(r"[A-Z]{3}", normalized) is None:
        raise ValueError("N-PORT holding currency is invalid")
    return normalized


def _mapping(value: object, label: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping) or any(not isinstance(key, str) for key in value):
        raise ValueError(f"{label} must be an object with string keys")
    return value


def _source_text(value: object, label: str, *, maximum: int) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be text")
    normalized = value.strip()
    if not normalized or len(normalized) > maximum:
        raise ValueError(f"{label} length is invalid")
    return normalized


def _optional_source_text(value: object, *, maximum: int) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise ValueError("optional SEC field must be text")
    normalized = value.strip()
    if not normalized:
        return None
    if len(normalized) > maximum:
        raise ValueError("optional SEC field exceeds the length limit")
    return normalized


def _source_date(value: object, label: str) -> date:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be an ISO date")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as error:
        raise ValueError(f"{label} must be an ISO date") from error
    if parsed.isoformat() != value:
        raise ValueError(f"{label} must use YYYY-MM-DD")
    return parsed


def _source_decimal(value: object, label: str) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        raise ValueError(f"{label} must be numeric")
    try:
        parsed = Decimal(str(value))
    except (DecimalException, ValueError) as error:
        raise ValueError(f"{label} must be numeric") from error
    if not parsed.is_finite():
        raise ValueError(f"{label} must be finite")
    return parsed


def _optional_source_decimal(value: object, label: str) -> Decimal | None:
    if value is None or value == "":
        return None
    return _source_decimal(value, label)


def _nport_percentage(value: object) -> Decimal | None:
    """Convert SEC's signed PERCENTAGE value into a NAV ratio."""

    percent = _optional_source_decimal(value, "N-PORT percentage")
    if percent is None:
        return None
    return percent / Decimal("100")


def _bounded_rows(
    rows: Iterable[Mapping[str, object]], *, max_rows: int, label: str
) -> tuple[Mapping[str, object], ...]:
    """Consume at most the configured maximum plus one row before rejecting."""

    result: list[Mapping[str, object]] = []
    for row in rows:
        if len(result) >= max_rows:
            raise ValueError(f"{label} row limit exceeded")
        result.append(row)
    return tuple(result)


def _accession(value: object, label: str) -> str:
    raw = _source_text(value, label, maximum=20)
    if _ACCESSION_RE.fullmatch(raw) is None:
        raise ValueError(f"{label} is not an SEC accession number")
    return raw


def _cik(value: object) -> str:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise ValueError("CIK must be a 10-digit string or integer")
    raw = str(value).strip()
    if not raw.isdigit() or len(raw) > 10:
        raise ValueError("CIK must contain at most 10 digits")
    return raw.zfill(10)


def _version(value: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 100:
        raise ValueError("SEC data version must be a bounded non-empty string")
    return value.strip()


def _row_limit(value: int, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{label} must be a non-negative integer")
    return value


def _valid_symbol(value: str) -> bool:
    return (
        isinstance(value, str)
        and re.fullmatch(r"[A-Za-z0-9.^=_-]{1,32}", value) is not None
    )

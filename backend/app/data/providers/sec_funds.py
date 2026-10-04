"""Normalize native SEC fund XML through the existing N-PORT row adapter."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal, DecimalException
from xml.etree import ElementTree as ET

from app.domain.valuation import ETFProfile, NportSnapshot

from .sec import SecNportAdapter
from .sec_evidence import FilingEvidence

_FIELDS = ("cik", "seriesId", "classId", "symbol")
_BORROWINGS = (
    "amtPayOneYrBanksBorr",
    "amtPayOneYrCtrldComp",
    "amtPayOneYrOthAffil",
    "amtPayOneYrOther",
    "amtPayAftOneYrBanksBorr",
    "amtPayAftOneYrCtrldComp",
    "amtPayAftOneYrOthAffil",
    "amtPayAftOneYrOther",
    "delayDeliv",
    "standByCommit",
    "liquidPref",
)


@dataclass(frozen=True)
class FundIdentity:
    cik: str
    series_id: str
    class_id: str
    symbol: str


def fund_identity(payload: Mapping[str, object], symbol: str) -> FundIdentity | None:
    fields, rows = payload.get("fields"), payload.get("data")
    if fields != list(_FIELDS) or not isinstance(rows, list) or len(rows) > 100_000:
        raise ValueError("invalid SEC fund ticker table")
    matches: set[FundIdentity] = set()
    for row in rows:
        if not isinstance(row, list) or len(row) != len(_FIELDS):
            raise ValueError("invalid SEC fund ticker row")
        if row[-1] != symbol:
            continue
        cik, series, share_class, _ = row
        if (
            not isinstance(cik, int)
            or isinstance(cik, bool)
            or not 0 < cik < 10**10
            or not isinstance(series, str)
            or not re.fullmatch(r"S[0-9]{9}", series)
            or not isinstance(share_class, str)
            or not re.fullmatch(r"C[0-9]{9}", share_class)
        ):
            raise ValueError("invalid SEC fund identity")
        matches.add(FundIdentity(str(cik).zfill(10), series, share_class, symbol))
    return next(iter(matches)) if len(matches) == 1 else None


def _root(document: str, family: str) -> tuple[ET.Element, dict[str, str]]:
    if len(document) > 16_000_000 or re.search(
        r"<!\s*(DOCTYPE|ENTITY)\b", document, re.I
    ):
        raise ValueError("unsafe SEC XML")
    try:
        root = ET.fromstring(document)
    except ET.ParseError:
        raise ValueError("invalid SEC XML") from None
    namespace = f"http://www.sec.gov/edgar/{family}"
    if root.tag != f"{{{namespace}}}edgarSubmission":
        raise ValueError("unknown SEC XML namespace")
    return root, {"n": namespace}


def _text(element: ET.Element, path: str, ns: dict[str, str]) -> str:
    values = element.findall(path, ns)
    if len(values) != 1 or not values[0].text:
        raise ValueError("missing or ambiguous SEC XML field")
    return values[0].text.strip()


def _decimal(value: object) -> Decimal:
    try:
        result = Decimal(str(value))
        exponent = result.as_tuple().exponent
        if result.is_finite() and isinstance(exponent, int) and abs(exponent) <= 4096:
            return result
    except DecimalException:
        pass
    raise ValueError("invalid N-PORT numeric evidence")


def ncen_etf_identity(document: str, fund: FundIdentity) -> bool:
    root, ns = _root(document, "ncen")
    if (
        _text(root, "n:headerData/n:filerInfo/n:filer/n:issuerCredentials/n:cik", ns)
        != fund.cik
    ):
        return False
    management = [
        e
        for e in root.findall(".//n:managementInvestmentQuestion", ns)
        if _text(e, "n:mgmtInvSeriesId", ns) == fund.series_id
    ]
    listings = [
        e
        for e in root.findall(".//n:exchangeTradedFund", ns)
        if _text(e, "n:etfSeriesId", ns) == fund.series_id
    ]
    if len(management) != 1 or len(listings) != 1:
        return False
    classes = {
        (e.get("sharesOutstandingClassId"), e.get("sharesOutstandingTickerSymbol"))
        for e in management[0].findall("n:sharesOutstandings/n:sharesOutstanding", ns)
    }
    types = {e.text for e in management[0].findall("n:fundTypes/n:fundType", ns)}
    tickers = {
        e.get("fundsTickerSymbol")
        for e in listings[0].findall("n:securityExchanges/n:securityExchange", ns)
    }
    return (
        (fund.class_id, fund.symbol) in classes
        and "Exchange-Traded Fund" in types
        and fund.symbol in tickers
    )


def nport_xml(
    document: str,
    *,
    fund: FundIdentity,
    filing: FilingEvidence,
    registered_etf: bool,
) -> NportSnapshot | None:
    root, ns = _root(document, "nport")
    header = "n:headerData/n:filerInfo"
    if (
        _text(root, f"{header}/n:filer/n:issuerCredentials/n:cik", ns) != fund.cik
        or _text(root, f"{header}/n:seriesClassInfo/n:seriesId", ns) != fund.series_id
        or _text(root, f"{header}/n:seriesClassInfo/n:classId", ns) != fund.class_id
    ):
        return None
    general = root.find("n:formData/n:genInfo", ns)
    financials = root.find("n:formData/n:fundInfo", ns)
    if general is None or financials is None:
        raise ValueError("missing N-PORT fund information")
    if (
        _text(general, "n:regCik", ns) != fund.cik
        or _text(general, "n:seriesId", ns) != fund.series_id
    ):
        raise ValueError("conflicting N-PORT identity")
    form = _text(root, "n:headerData/n:submissionType", ns)
    if form != filing.form:
        raise ValueError("N-PORT form differs from its SEC filing")
    raw = root.findall("n:formData/n:invstOrSecs/n:invstOrSec", ns)
    if not raw or len(raw) > 2_000:
        raise ValueError("unsupported N-PORT holding count")
    holdings: list[dict[str, object]] = []
    identifiers: list[dict[str, object]] = []
    for i, item in enumerate(raw):
        row: dict[str, object] = {
            "ACCESSION_NUMBER": filing.accession,
            "HOLDING_ID": str(i),
        }
        for field, tag in (
            ("ISSUER_CUSIP", "cusip"),
            ("PERCENTAGE", "pctVal"),
            ("CURRENCY_CODE", "curCd"),
            ("PAYOFF_PROFILE", "payoffProfile"),
            ("ASSET_CAT", "assetCat"),
            ("ISSUER_TYPE", "issuerCat"),
        ):
            row[field] = _text(item, f"n:{tag}", ns)
        holdings.append(row)
        identity: dict[str, object] = {
            "ACCESSION_NUMBER": filing.accession,
            "HOLDING_ID": str(i),
        }
        for key, tag in (("IDENTIFIER_ISIN", "isin"), ("IDENTIFIER_TICKER", "ticker")):
            values = item.findall(f"n:identifiers/n:{tag}", ns)
            if len(values) > 1:
                raise ValueError("ambiguous N-PORT security identifier")
            identity[key] = values[0].get("value") if values else None
        identifiers.append(identity)
    # All positions, including unmatched securities, determine capabilities.
    # A missing liability disclosure is unknown, never proof of zero leverage.
    liabilities = [financials.find(f"n:{tag}", ns) for tag in _BORROWINGS]
    amounts = [_decimal(e.text) for e in liabilities if e is not None and e.text]
    if any(not v.is_finite() or v < 0 for v in amounts):
        raise ValueError("invalid N-PORT liability amount")
    weights = [_decimal(row["PERCENTAGE"]) for row in holdings]
    if any(not v.is_finite() for v in weights):
        raise ValueError("invalid N-PORT holding weight")
    long_only = all(
        row["PAYOFF_PROFILE"] == "Long" and w >= 0
        for row, w in zip(holdings, weights, strict=True)
    )
    physical = all(row["ASSET_CAT"] in {"EC", "STIV"} for row in holdings)
    derivative = any(
        str(row["ASSET_CAT"]).startswith("D") and row["ASSET_CAT"] != "DBT"
        for row in holdings
    )
    borrowed = None if len(amounts) != len(_BORROWINGS) else any(amounts)
    leveraged = (
        True if sum(weights) > 100 or borrowed else False if borrowed is False else None
    )
    profile = ETFProfile(
        instrumentType="etf" if registered_etf else "unknown",
        physical=physical,
        longOnly=long_only,
        leveraged=leveraged,
        inverse=False if physical and long_only else None,
        synthetic=False if physical and not derivative else None,
        fundOfFunds=any(row["ISSUER_TYPE"] in {"RF", "PF"} for row in holdings),
        hasDerivatives=derivative,
    )
    return SecNportAdapter(data_version="sec-nport-xml-v1").parse(
        {
            "ACCESSION_NUMBER": filing.accession,
            "FILING_DATE": filing.filed.isoformat(),
            "REPORT_DATE": _text(general, "n:repPdDate", ns),
            "SUB_TYPE": filing.form,
        },
        holdings,
        identifiers,
        fund=fund.symbol,
        capabilities=profile,
        published_at=filing.published_at,
    )

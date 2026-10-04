"""Public filing metadata and registered common-share evidence, without I/O."""

from __future__ import annotations

import re
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime
from html.parser import HTMLParser


@dataclass(frozen=True)
class FilingEvidence:
    accession: str
    filed: date
    published_at: datetime | None
    form: str
    document: str


def parse_filings(
    value: Mapping[str, object],
    *,
    financial_accessions: Collection[str] = (),
    filed_from: date | None = None,
    filed_through: date | None = None,
) -> dict[str, FilingEvidence]:
    """Read SEC submissions arrays; acceptance time is never inferred."""
    keys = (
        "accessionNumber",
        "filingDate",
        "acceptanceDateTime",
        "form",
        "primaryDocument",
    )
    arrays = [value.get(key) for key in keys]
    if any(not isinstance(items, list) for items in arrays):
        raise ValueError("SEC submissions fields must be arrays")
    rows = [items for items in arrays if isinstance(items, list)]
    if len({len(items) for items in rows}) != 1:
        raise ValueError("SEC submissions array lengths differ")
    result: dict[str, FilingEvidence] = {}
    for accession, filed, accepted, form, document in zip(*rows, strict=True):
        if form not in {"10-K", "10-Q", "10-K/A", "10-Q/A"} and not (
            form in {"8-K", "8-K/A"} and accession in financial_accessions
        ):
            continue
        if not isinstance(filed, str):
            raise ValueError("SEC filing dates must be text")
        filing_date = date.fromisoformat(filed)
        if filing_date.isoformat() != filed:
            raise ValueError("SEC filing date must use YYYY-MM-DD")
        if (filed_from is not None and filing_date < filed_from) or (
            filed_through is not None and filing_date > filed_through
        ):
            continue
        if not isinstance(accession, str) or not re.fullmatch(
            r"[0-9]{10}-[0-9]{2}-[0-9]{6}", accession
        ):
            raise ValueError("invalid SEC accession")
        if not isinstance(document, str) or not re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9._-]{0,255}", document
        ):
            raise ValueError("invalid SEC primary document")
        if not isinstance(accepted, str):
            raise ValueError("SEC filing dates must be text")
        publication = datetime.fromisoformat(accepted) if accepted else None
        if publication is not None:
            if publication.tzinfo is None or publication.utcoffset() is None:
                raise ValueError("SEC acceptance time must include a timezone")
            publication = publication.astimezone(UTC)
        evidence = FilingEvidence(accession, filing_date, publication, form, document)
        if accession in result and result[accession] != evidence:
            raise ValueError("conflicting SEC filing metadata")
        result[accession] = evidence
    return result


class _RegisteredSecurities(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.values: dict[str, dict[str, set[str]]] = {}
        self._active: tuple[str, str] | None = None
        self._text: list[str] = []
        self.stock_members: set[str] = set()
        self.members_by_context: dict[str, set[str]] = {}
        self._context_id = ""
        self._member_axis: str | None = None
        self._member_text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        name = attributes.get("name", "")
        context = attributes.get("contextref", "")
        if tag == "xbrli:context":
            self._context_id = attributes.get("id") or ""
        if tag == "xbrldi:explicitmember":
            self._member_axis = attributes.get("dimension") or ""
            self._member_text = []
        if (
            tag == "ix:nonnumeric"
            and name
            in {
                "dei:Security12bTitle",
                "dei:TradingSymbol",
            }
            and context
        ):
            self._active = (context, name)
            self._text = []

    def handle_data(self, data: str) -> None:
        if self._active is not None:
            self._text.append(data)
        if self._member_axis is not None:
            self._member_text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "xbrldi:explicitmember" and self._member_axis is not None:
            member = "".join(self._member_text).strip()
            if (
                "classofstock" in self._member_axis.lower()
                or "classesofstock" in self._member_axis.lower()
                or "shareclass" in self._member_axis.lower()
                or re.search(r":Class[A-Z0-9].*Member$", member)
            ):
                self.stock_members.add(member)
                self.members_by_context.setdefault(self._context_id, set()).add(member)
            self._member_axis = None
        if tag == "xbrli:context":
            self._context_id = ""
        if tag == "ix:nonnumeric" and self._active is not None:
            context, name = self._active
            text = " ".join("".join(self._text).split())
            self.values.setdefault(context, {}).setdefault(name, set()).add(text)
            self._active = None


def verified_common_class(source: str, *, symbol: str, cik: str) -> str | None:
    """Prove a single common class from the filing's registered securities.

    A current ticker lookup, a bond symbol, or a consolidated EPS concept alone
    cannot identify a historical share class. Multi-class issuers stay unknown.
    """
    if not re.fullmatch(r"[0-9]{10}", cik):
        raise ValueError("SEC issuer must be a ten-digit CIK")
    parser = _RegisteredSecurities()
    parser.feed(source)
    debt_members = {
        member
        for context, fields in parser.values.items()
        if any(
            re.search(r"\bnotes?\b|\bbonds?\b|\bdebentures?\b", title, re.I)
            for title in fields.get("dei:Security12bTitle", set())
        )
        for member in parser.members_by_context.get(context, set())
    }
    if parser.stock_members - debt_members - {"us-gaap:CommonStockMember"}:
        return None
    common: set[tuple[str, str]] = set()
    for fields in parser.values.values():
        titles = fields.get("dei:Security12bTitle", set())
        symbols = fields.get("dei:TradingSymbol", set())
        if any(
            re.search(r"common\s+stock|ordinary\s+shares", title, re.I)
            for title in titles
        ):
            if len(titles) != 1 or len(symbols) != 1:
                return None
            common.add((next(iter(titles)), next(iter(symbols))))
    if len(common) != 1 or next(iter(common))[1] != symbol:
        return None
    if re.search(r"\bclass\b", next(iter(common))[0], re.I):
        return None
    return f"sec:{cik}:common:{symbol}"

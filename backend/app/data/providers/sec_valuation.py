"""Join identified EDGAR reads to the existing point-in-time valuation kernel."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from functools import partial
from importlib import import_module
from typing import Protocol, TypeVar, cast

from app.data.fundamentals import _available_on_session, estimate_stock_pe
from app.data.market_data import MarketDataRequest, _fingerprint
from app.domain.contracts import MarketSnapshot, ValuationSnapshot
from app.domain.status import Diagnostic, DiagnosticCode
from app.domain.valuation import PriceReference

from .sec import SecCompanyFactsAdapter
from .sec_client import SecEdgarClient, SecRequestError
from .sec_evidence import FilingEvidence, parse_filings, verified_common_class
from .yahoo import YahooFinanceAdapter
from .yahoo_splits import StockSplitEvidence

_T = TypeVar("_T")


class _EvidenceError(ValueError):
    pass


def _validated(parse: Callable[[], _T]) -> _T:
    try:
        return parse()
    except (ValueError, TypeError):
        raise _EvidenceError("invalid SEC evidence") from None


class EdgarReads(Protocol):
    def company_tickers(self) -> dict[str, object]: ...
    def company_facts(self, cik: str) -> dict[str, object]: ...
    def submissions(self, cik: str) -> dict[str, object]: ...
    def submissions_file(self, name: str) -> dict[str, object]: ...
    def filing_document(self, cik: str, accession: str, name: str) -> str: ...


class SplitReads(Protocol):
    def split_evidence(
        self,
        symbol: str,
        *,
        sessions: tuple[date, ...],
    ) -> tuple[StockSplitEvidence | None, Diagnostic | None]: ...


@dataclass(frozen=True)
class ValuationLoad:
    snapshot: ValuationSnapshot | None = None
    diagnostics: tuple[Diagnostic, ...] = ()


class SecValuationProvider:
    """No current P/E substitutions; class and split basis need real evidence."""

    def __init__(
        self,
        *,
        client: EdgarReads | None = None,
        adapter: SplitReads | None = None,
        split_sessions: Callable[[date, datetime], tuple[date, ...]] | None = None,
    ) -> None:
        # A fresh identified client per load prevents an old CompanyFacts cache
        # from hiding later disclosures. Each load shares reads across instances.
        self._client = client
        self._adapter = adapter or YahooFinanceAdapter()
        self._sessions = split_sessions or _us_sessions

    def load(
        self,
        *,
        request: MarketDataRequest,
        market: MarketSnapshot,
        max_fact_age_days: int,
        session_closes: Mapping[date, datetime],
        now: datetime,
    ) -> ValuationLoad:
        try:
            return self._load(
                client=self._client or SecEdgarClient(),
                request=request,
                market=market,
                max_fact_age_days=max_fact_age_days,
                session_closes=session_closes,
                now=now,
            )
        except SecRequestError as error:
            return ValuationLoad(
                diagnostics=(
                    _error(
                        "data.sec_request_unavailable",
                        request.symbol,
                        reason=error.reason,
                        status=error.status,
                        code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE
                        if error.reason == "contact_required"
                        else DiagnosticCode.PROVIDER_REQUEST_FAILED,
                    ),
                )
            )
        except _EvidenceError:
            return ValuationLoad(
                diagnostics=(
                    _error(
                        "data.sec_evidence_invalid",
                        request.symbol,
                    ),
                )
            )

    def _load(
        self,
        *,
        client: EdgarReads,
        request: MarketDataRequest,
        market: MarketSnapshot,
        max_fact_age_days: int,
        session_closes: Mapping[date, datetime],
        now: datetime,
    ) -> ValuationLoad:
        matches = {
            str(row["cik_str"]).zfill(10)
            for row in client.company_tickers().values()
            if isinstance(row, dict)
            and row.get("ticker") == request.symbol
            and isinstance(row.get("cik_str"), int)
            and not isinstance(row["cik_str"], bool)
        }
        if len(matches) != 1:
            return ValuationLoad(
                diagnostics=(_error("valuation.issuer_unverified", request.symbol),)
            )
        cik = matches.pop()
        facts_payload = client.company_facts(cik)
        taxonomy = _object(_object(facts_payload.get("facts")).get("us-gaap"))
        if "EarningsPerShareDiluted" not in taxonomy:
            return ValuationLoad(
                diagnostics=(_error("valuation.eps_unavailable", request.symbol),)
            )
        normalizer = SecCompanyFactsAdapter()
        raw_facts = _validated(
            lambda: normalizer.parse(
                facts_payload, symbol=request.symbol, expected_cik=cik
            )
        )
        oldest = request.start_date - timedelta(days=max_fact_age_days)
        relevant = tuple(
            fact
            for fact in raw_facts
            if fact.period_end >= oldest and fact.filed <= request.end_date
        )
        if not relevant:
            return ValuationLoad(
                diagnostics=(_error("valuation.fact_not_public_as_of", request.symbol),)
            )
        needed = {fact.accession for fact in relevant}
        if len(needed) > 96:
            return ValuationLoad(
                diagnostics=(_error("data.sec_request_limit", request.symbol),)
            )
        filings = _filings(
            client,
            cik,
            needed,
            filed_from=min(fact.filed for fact in relevant),
            filed_through=request.end_date,
        )
        class_by_accession: dict[str, str] = {}
        published: dict[str, datetime] = {}
        for accession in sorted(needed):
            evidence = filings.get(accession)
            if evidence is None or any(
                fact.filed != evidence.filed
                for fact in relevant
                if fact.accession == accession
            ):
                continue
            if evidence.published_at is not None:
                published[accession] = evidence.published_at
            common_class = verified_common_class(
                client.filing_document(cik, accession, evidence.document),
                symbol=request.symbol,
                cik=cik,
            )
            if common_class is not None:
                class_by_accession[accession] = common_class
        source_start = min(fact.period_start for fact in relevant)
        sessions = self._sessions(source_start, now.astimezone(UTC))
        proof, diagnostic = self._adapter.split_evidence(
            request.symbol, sessions=sessions
        )
        if proof is None:
            return ValuationLoad(
                diagnostics=(
                    diagnostic
                    or _error("valuation.split_basis_unavailable", request.symbol),
                )
            )
        prices = dict(proof.prices)
        if any(
            prices.get(bar.date) != bar.valuation_price
            for bar in market.bars
            if bar.date in request.target_sessions
        ):
            return ValuationLoad(
                diagnostics=(_error("valuation.price_basis_mismatch", request.symbol),)
            )
        basis = (
            f"yahoo-close:{sessions[-1].isoformat()}:since:{source_start.isoformat()}"
        )
        split_basis = {
            accession: basis
            for accession in needed
            if all(
                proof.is_unsplit_since(fact.period_start)
                for fact in relevant
                if fact.accession == accession
            )
        }
        joined = _validated(
            lambda: normalizer.parse(
                facts_payload,
                symbol=request.symbol,
                expected_cik=cik,
                published_at_by_accession=published,
                split_basis_by_accession=split_basis,
                verified_stock_class_by_accession=class_by_accession,
            )
        )
        facts = tuple(
            fact
            for fact in joined
            if fact.accession in needed and fact.period_end >= oldest
        )
        observations = []
        diagnostics: dict[tuple[DiagnosticCode, str], Diagnostic] = {}
        for bar in market.bars:
            if bar.date not in request.target_sessions:
                continue
            public_filings = tuple(
                evidence
                for evidence in filings.values()
                if _available_on_session(
                    filed=evidence.filed,
                    published_at=evidence.published_at,
                    sessions=request.exchange_calendar.trading_dates,
                    session_closes=session_closes,
                )
                <= bar.date
            )
            latest_filing = max(
                public_filings,
                key=lambda item: (
                    item.filed,
                    item.published_at or datetime.min.replace(tzinfo=UTC),
                    item.accession,
                ),
                default=None,
            )
            common_class = (
                class_by_accession.get(latest_filing.accession)
                if latest_filing
                else None
            )
            result = estimate_stock_pe(
                as_of=bar.date,
                symbol=request.symbol,
                expected_cik=cik,
                exchange_calendar=request.exchange_calendar,
                session_closes=session_closes,
                price=PriceReference(
                    date=bar.date,
                    symbol=request.symbol,
                    value=bar.valuation_price,
                    currency=bar.currency,
                    splitBasis=basis,
                    stockClassId=common_class,
                    source=bar.source,
                ),
                facts=facts,
                max_fact_age_days=max_fact_age_days,
            )
            if result.observation is not None:
                observations.append(result.observation)
            for diagnostic in result.diagnostics:
                diagnostics.setdefault(
                    (diagnostic.code, diagnostic.message_key), diagnostic
                )
        return ValuationLoad(
            snapshot=ValuationSnapshot(
                symbol=request.symbol,
                observations=tuple(observations),
                fingerprint=_fingerprint(
                    {
                        "facts": [
                            fact.model_dump(mode="json", by_alias=True)
                            for fact in facts
                        ],
                        "observations": [
                            item.model_dump(mode="json", by_alias=True)
                            for item in observations
                        ],
                    }
                ),
            ),
            diagnostics=tuple(diagnostics.values()),
        )


def _object(value: object) -> Mapping[str, object]:
    if not isinstance(value, dict):
        raise _EvidenceError("SEC field must be an object")
    return value


def _filings(
    client: EdgarReads,
    cik: str,
    needed: set[str],
    *,
    filed_from: date,
    filed_through: date,
) -> dict[str, FilingEvidence]:
    source = _object(client.submissions(cik).get("filings"))
    recent = _object(source.get("recent"))
    parse = partial(
        parse_filings,
        financial_accessions=needed,
        filed_from=filed_from,
        filed_through=filed_through,
    )
    filings = _validated(partial(parse, recent))
    history = source.get("files", [])
    if not isinstance(history, list):
        raise _EvidenceError("SEC submissions history must be an array")
    for item in history[:4]:
        if needed <= filings.keys():
            break
        page = _object(item)
        if isinstance(page.get("filingFrom"), str) and isinstance(
            page.get("filingTo"), str
        ):
            first = _validated(partial(date.fromisoformat, str(page["filingFrom"])))
            last = _validated(partial(date.fromisoformat, str(page["filingTo"])))
            if last < filed_from or first > filed_through:
                continue
        name = page.get("name")
        if not isinstance(name, str):
            raise _EvidenceError("SEC submissions file name must be text")
        history_file = client.submissions_file(name)
        filings.update(_validated(partial(parse, history_file)))
    return filings


class _Calendar(Protocol):
    sessions: Iterable[object]

    def session_close(self, session: object) -> object: ...


def _us_sessions(start: date, now: datetime) -> tuple[date, ...]:
    get_calendar = import_module("exchange_calendars").get_calendar
    calendar = cast(
        _Calendar,
        get_calendar("XNYS", start=start.isoformat(), end=now.date().isoformat()),
    )
    return tuple(
        date.fromisoformat(str(session)[:10])
        for session in calendar.sessions
        if datetime.fromisoformat(str(calendar.session_close(session)))
        + timedelta(minutes=30)
        <= now
    )


def _error(
    message: str,
    symbol: str,
    *,
    code: DiagnosticCode = DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
    **details: object,
) -> Diagnostic:
    return Diagnostic(
        code=code,
        messageKey=message,
        source="sec",
        details={"symbol": symbol, **details},
    )

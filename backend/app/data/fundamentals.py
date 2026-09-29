"""As-of company EPS and ETF equity earnings-yield valuation logic."""

from __future__ import annotations

from bisect import bisect_right
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal, DecimalException

from pydantic import field_validator

from app.calendar.schedule import ExchangeCalendar
from app.domain.status import Diagnostic, DiagnosticCode, DomainModel
from app.domain.valuation import (
    FinancialFact,
    NportHolding,
    NportSnapshot,
    PriceReference,
    ValuationContribution,
    ValuationFactReference,
    ValuationObservation,
)

_DILUTED_EPS_CONCEPT = "us-gaap:EarningsPerShareDiluted"


class FundamentalsResult(DomainModel):
    """A single-session valuation or explicit reasons it cannot be calculated."""

    observation: ValuationObservation | None = None
    diagnostics: tuple[Diagnostic, ...] = ()

    @field_validator("diagnostics")
    @classmethod
    def diagnostics_are_unique(
        cls, value: tuple[Diagnostic, ...]
    ) -> tuple[Diagnostic, ...]:
        keys = tuple(
            (item.code, item.message_key, item.as_of, item.source) for item in value
        )
        if len(keys) != len(set(keys)):
            raise ValueError("valuation diagnostics must be unique")
        return value


@dataclass(frozen=True)
class _SelectedEPS:
    value: Decimal
    method: str
    stock_class_id: str
    period_start: date
    period_end: date
    facts: tuple[FinancialFact, ...]


def estimate_stock_pe(
    *,
    as_of: date,
    symbol: str,
    expected_cik: str,
    exchange_calendar: ExchangeCalendar,
    session_closes: Mapping[date, datetime],
    price: PriceReference,
    facts: Iterable[FinancialFact],
    max_fact_age_days: int,
) -> FundamentalsResult:
    """Estimate one stock's trailing PE from as-of diluted EPS facts.

    Standalone quarters are selected from their own reported durations. The
    function never subtracts year-to-date values to manufacture quarters.
    """

    _validate_policy(max_fact_age_days, "max_fact_age_days")
    _validate_as_of(as_of, exchange_calendar, session_closes)
    if not symbol:
        raise ValueError("symbol must not be empty")
    price_error = _validate_price(price, as_of=as_of, symbol=symbol)
    if price_error is not None:
        return FundamentalsResult(diagnostics=(price_error,))
    if len(expected_cik) != 10 or not expected_cik.isdigit():
        raise ValueError("expected_cik must be a 10-digit CIK")

    selected, diagnostics = _select_eps(
        symbol=symbol,
        expected_cik=expected_cik,
        as_of=as_of,
        price=price,
        facts=tuple(facts),
        sessions=exchange_calendar.trading_dates,
        session_closes=session_closes,
        max_fact_age_days=max_fact_age_days,
    )
    if selected is None:
        return FundamentalsResult(diagnostics=diagnostics)
    if selected.value <= 0:
        return FundamentalsResult(
            diagnostics=(
                _diagnostic(
                    DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    "valuation.eps_nonpositive",
                    as_of,
                    source="sec:companyfacts",
                    details={
                        "symbol": price.symbol,
                        "eps": str(selected.value),
                        "method": selected.method,
                        "accessions": [fact.accession for fact in selected.facts],
                    },
                ),
            )
        )

    try:
        pe = price.value / selected.value
    except DecimalException:
        return FundamentalsResult(
            diagnostics=(
                _diagnostic(
                    DiagnosticCode.CALCULATION_FAILED,
                    "valuation.pe_calculation_failed",
                    as_of,
                    source="sec:companyfacts",
                ),
            )
        )
    references = tuple(_fact_reference(fact) for fact in selected.facts)
    latest_fact = max(
        selected.facts,
        key=lambda fact: (fact.period_end, fact.filed, fact.accession),
    )
    return FundamentalsResult(
        observation=ValuationObservation(
            date=as_of,
            symbol=price.symbol,
            stockClassId=selected.stock_class_id,
            valuationPrice=price.value,
            eps=selected.value,
            pe=pe,
            currency=price.currency,
            method=selected.method,
            source="sec:companyfacts",
            sourceVersion=_source_versions(selected.facts),
            asOf=as_of,
            reportPeriodStart=selected.period_start,
            reportPeriodEnd=selected.period_end,
            publishedAt=latest_fact.published_at,
            accession=(
                selected.facts[0].accession if len(selected.facts) == 1 else None
            ),
            factReferences=references,
        )
    )


def estimate_etf_pe(
    *,
    as_of: date,
    fund: str,
    exchange_calendar: ExchangeCalendar,
    session_closes: Mapping[date, datetime],
    fund_price: PriceReference,
    snapshots: Iterable[NportSnapshot],
    constituent_prices: Mapping[str, PriceReference],
    constituent_facts: Iterable[FinancialFact],
    max_fact_age_days: int,
    max_holdings_age_days: int,
    min_coverage: Decimal,
) -> FundamentalsResult:
    """Estimate ETF PE from the last public eligible direct-stock holdings.

    SEC position weights are first normalized over the fund's complete direct
    common-equity sleeve. The matched sleeve is then re-normalized by its
    coverage, preserving negative EPS contributions.
    """

    _validate_policy(max_fact_age_days, "max_fact_age_days")
    _validate_policy(max_holdings_age_days, "max_holdings_age_days")
    if not min_coverage.is_finite() or min_coverage < 0 or min_coverage > 1:
        raise ValueError("min_coverage must be finite and in 0..1")
    _validate_as_of(as_of, exchange_calendar, session_closes)
    if not fund:
        raise ValueError("fund must not be empty")
    price_error = _validate_price(fund_price, as_of=as_of, symbol=fund)
    if price_error is not None:
        return FundamentalsResult(diagnostics=(price_error,))

    sessions = exchange_calendar.trading_dates
    known_snapshots = [
        snapshot
        for snapshot in snapshots
        if snapshot.fund == fund
        and snapshot.report_date <= as_of
        and _available_on_session(
            filed=snapshot.filed,
            published_at=snapshot.published_at,
            sessions=sessions,
            session_closes=session_closes,
        )
        <= as_of
    ]
    if not known_snapshots:
        return FundamentalsResult(
            diagnostics=(
                _diagnostic(
                    DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    "valuation.holdings_not_public_as_of",
                    as_of,
                    source="sec:nport",
                    details={"fund": fund_price.symbol},
                ),
            )
        )
    snapshot = max(
        known_snapshots,
        key=lambda item: (
            item.report_date,
            _available_on_session(
                filed=item.filed,
                published_at=item.published_at,
                sessions=sessions,
                session_closes=session_closes,
            ),
            _timestamp_sort_key(item.published_at),
            item.accession,
        ),
    )
    if (as_of - snapshot.report_date).days > max_holdings_age_days:
        return FundamentalsResult(
            diagnostics=(
                _diagnostic(
                    DiagnosticCode.STALE_DATA,
                    "valuation.holdings_stale",
                    as_of,
                    source=snapshot.source,
                    details={
                        "fund": fund,
                        "snapshotDate": snapshot.report_date.isoformat(),
                        "maxAgeDays": max_holdings_age_days,
                    },
                ),
            )
        )
    if not snapshot.capabilities.supports_equity_pe:
        return FundamentalsResult(
            diagnostics=(
                _diagnostic(
                    DiagnosticCode.SOURCE_QUALITY_WARNING,
                    "valuation.etf_capability_unsupported",
                    as_of,
                    source=snapshot.source,
                    details={
                        "fund": fund,
                        "capabilities": snapshot.capabilities.model_dump(
                            mode="json", by_alias=True
                        ),
                    },
                ),
            )
        )

    all_holdings_error = _validate_holding_capabilities(snapshot.holdings, as_of)
    if all_holdings_error is not None:
        return FundamentalsResult(diagnostics=(all_holdings_error,))

    direct_positions = tuple(
        item for item in snapshot.holdings if item.is_direct_common_equity
    )
    if not direct_positions:
        return FundamentalsResult(
            diagnostics=(
                _diagnostic(
                    DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    "valuation.direct_equity_holdings_unavailable",
                    as_of,
                    source=snapshot.source,
                    details={"fund": fund},
                ),
            )
        )
    if any(item.weight is None for item in direct_positions):
        return FundamentalsResult(
            diagnostics=(
                _diagnostic(
                    DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    "valuation.holding_weight_unavailable",
                    as_of,
                    source=snapshot.source,
                    details={"fund": fund},
                ),
            )
        )
    direct_total = sum(
        (item.weight for item in direct_positions if item.weight is not None),
        Decimal("0"),
    )
    if direct_total == 0:
        return FundamentalsResult(
            diagnostics=(
                _diagnostic(
                    DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    "valuation.etf_matched_weight_unavailable",
                    as_of,
                    source=snapshot.source,
                    details={"fund": fund, "directEquityWeight": str(direct_total)},
                ),
            )
        )
    if direct_total < 0 or direct_total > 1:
        return FundamentalsResult(
            diagnostics=(
                _diagnostic(
                    DiagnosticCode.SOURCE_QUALITY_WARNING,
                    "valuation.direct_equity_weight_invalid",
                    as_of,
                    source=snapshot.source,
                    details={"fund": fund, "directEquityWeight": str(direct_total)},
                ),
            )
        )

    facts_tuple = tuple(constituent_facts)
    matched: list[tuple[NportHolding, _SelectedEPS, PriceReference]] = []
    match_diagnostics: list[Diagnostic] = []
    for holding in direct_positions:
        if (
            not holding.identity_matched
            or holding.symbol is None
            or holding.cik is None
        ):
            continue
        if holding.stock_class_id is None:
            match_diagnostics.append(
                _diagnostic(
                    DiagnosticCode.PRICE_BASIS_UNAVAILABLE,
                    "valuation.stock_class_unverified",
                    as_of,
                    source=snapshot.source,
                    details={"holdingId": holding.holding_id},
                )
            )
            continue
        price = constituent_prices.get(holding.symbol)
        if price is None or price.date != as_of or price.symbol != holding.symbol:
            continue
        if price.stock_class_id != holding.stock_class_id:
            match_diagnostics.append(
                _diagnostic(
                    DiagnosticCode.PRICE_BASIS_UNAVAILABLE,
                    "valuation.stock_class_mismatch",
                    as_of,
                    source=price.source,
                    details={
                        "holdingId": holding.holding_id,
                        "holdingStockClassId": holding.stock_class_id,
                        "priceStockClassId": price.stock_class_id,
                    },
                )
            )
            continue
        selected, diagnostics = _select_eps(
            symbol=holding.symbol,
            expected_cik=holding.cik,
            as_of=as_of,
            price=price,
            facts=facts_tuple,
            sessions=sessions,
            session_closes=session_closes,
            max_fact_age_days=max_fact_age_days,
        )
        if selected is None:
            match_diagnostics.extend(diagnostics)
            continue
        matched.append((holding, selected, price))

    matched_weight = sum(
        (holding.weight for holding, _, _ in matched if holding.weight is not None),
        Decimal("0"),
    )
    if matched_weight <= 0:
        return FundamentalsResult(
            diagnostics=(
                _diagnostic(
                    DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    "valuation.etf_matched_weight_unavailable",
                    as_of,
                    source=snapshot.source,
                    details={
                        "fund": fund,
                        "directEquityWeight": str(direct_total),
                        "matchedWeight": str(matched_weight),
                    },
                ),
                *tuple(_unique_diagnostics(match_diagnostics)),
            )
        )
    coverage = matched_weight / direct_total
    if coverage < min_coverage:
        return FundamentalsResult(
            diagnostics=(
                _diagnostic(
                    DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    "valuation.etf_coverage_below_minimum",
                    as_of,
                    source=snapshot.source,
                    details={
                        "fund": fund,
                        "coverage": str(coverage),
                        "minimumCoverage": str(min_coverage),
                        "directEquityWeight": str(direct_total),
                    },
                ),
                *tuple(_unique_diagnostics(match_diagnostics)),
            )
        )

    try:
        earnings_yield = sum(
            (
                (holding.weight / matched_weight) * (selected.value / price.value)
                for holding, selected, price in matched
                if holding.weight is not None
            ),
            Decimal("0"),
        )
    except DecimalException:
        return FundamentalsResult(
            diagnostics=(
                _diagnostic(
                    DiagnosticCode.CALCULATION_FAILED,
                    "valuation.etf_yield_calculation_failed",
                    as_of,
                    source=snapshot.source,
                ),
            )
        )
    if not earnings_yield.is_finite() or earnings_yield <= 0:
        return FundamentalsResult(
            diagnostics=(
                _diagnostic(
                    DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    "valuation.etf_nonpositive_earnings_yield",
                    as_of,
                    source=snapshot.source,
                    details={"fund": fund, "earningsYield": str(earnings_yield)},
                ),
            )
        )

    contributors = tuple(
        ValuationContribution(
            symbol=holding.symbol,
            stockClassId=selected.stock_class_id,
            weight=holding.weight / direct_total,
            eps=selected.value,
            epsMethod=selected.method,
            valuationPrice=price.value,
            earningsYield=selected.value / price.value,
            currency=price.currency,
            factReferences=tuple(_fact_reference(fact) for fact in selected.facts),
        )
        for holding, selected, price in matched
        if holding.weight is not None and holding.symbol is not None
    )
    all_references = tuple(
        reference
        for contribution in contributors
        for reference in contribution.fact_references
    )
    return FundamentalsResult(
        observation=ValuationObservation(
            date=as_of,
            symbol=fund_price.symbol,
            stockClassId=fund_price.stock_class_id,
            valuationPrice=fund_price.value,
            pe=Decimal("1") / earnings_yield,
            earningsYield=earnings_yield,
            coverage=coverage,
            stockWeight=direct_total,
            currency=fund_price.currency,
            method="etf_equity_earnings_yield",
            source=f"{snapshot.source}+sec:companyfacts",
            sourceVersion=snapshot.source_version,
            asOf=as_of,
            publishedAt=snapshot.published_at,
            accession=snapshot.accession,
            snapshotDate=snapshot.report_date,
            factReferences=all_references,
            contributors=contributors,
        )
    )


def _select_eps(
    *,
    symbol: str,
    expected_cik: str,
    as_of: date,
    price: PriceReference,
    facts: tuple[FinancialFact, ...],
    sessions: tuple[date, ...],
    session_closes: Mapping[date, datetime],
    max_fact_age_days: int,
) -> tuple[_SelectedEPS | None, tuple[Diagnostic, ...]]:
    matching_identity = tuple(
        fact
        for fact in facts
        if fact.symbol == symbol
        and fact.cik == expected_cik
        and fact.concept == _DILUTED_EPS_CONCEPT
    )
    if not matching_identity:
        return None, (
            _diagnostic(
                DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                "valuation.eps_unavailable",
                as_of,
                source="sec:companyfacts",
                details={"symbol": symbol, "cik": expected_cik},
            ),
        )

    available = tuple(
        fact
        for fact in matching_identity
        if _available_on_session(
            filed=fact.filed,
            published_at=fact.published_at,
            sessions=sessions,
            session_closes=session_closes,
        )
        <= as_of
        and fact.period_end <= as_of
    )
    if not available:
        return None, (
            _diagnostic(
                DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                "valuation.fact_not_public_as_of",
                as_of,
                source="sec:companyfacts",
                details={"symbol": symbol, "cik": expected_cik},
            ),
        )

    price_stock_class_id = price.stock_class_id
    if price_stock_class_id is None or not any(
        fact.stock_class_id is not None for fact in available
    ):
        return None, (
            _diagnostic(
                DiagnosticCode.PRICE_BASIS_UNAVAILABLE,
                "valuation.stock_class_unverified",
                as_of,
                source="sec:companyfacts",
                details={"symbol": symbol, "cik": expected_cik},
            ),
        )
    class_matched = tuple(
        fact for fact in available if fact.stock_class_id == price_stock_class_id
    )
    if not class_matched:
        return None, (
            _diagnostic(
                DiagnosticCode.PRICE_BASIS_UNAVAILABLE,
                "valuation.stock_class_mismatch",
                as_of,
                source="sec:companyfacts",
                details={
                    "symbol": symbol,
                    "priceStockClassId": price_stock_class_id,
                    "factStockClassIds": sorted(
                        {
                            fact.stock_class_id
                            for fact in available
                            if fact.stock_class_id is not None
                        }
                    ),
                },
            ),
        )
    available = class_matched

    by_period: dict[tuple[date, date], list[FinancialFact]] = defaultdict(list)
    for fact in available:
        by_period[(fact.period_start, fact.period_end)].append(fact)
    latest_by_period = [
        max(
            period_facts,
            key=lambda fact: (
                _available_on_session(
                    filed=fact.filed,
                    published_at=fact.published_at,
                    sessions=sessions,
                    session_closes=session_closes,
                ),
                _timestamp_sort_key(fact.published_at),
                fact.filed,
                fact.accession,
            ),
        )
        for period_facts in by_period.values()
    ]
    currency_rows = [
        fact for fact in latest_by_period if fact.currency == price.currency
    ]
    if not currency_rows:
        return None, (
            _diagnostic(
                DiagnosticCode.PRICE_BASIS_UNAVAILABLE,
                "valuation.currency_mismatch",
                as_of,
                source="sec:companyfacts",
                details={"symbol": symbol, "priceCurrency": price.currency},
            ),
        )

    basis_rows = [
        fact for fact in currency_rows if fact.split_basis == price.split_basis
    ]
    if not basis_rows:
        return None, (
            _diagnostic(
                DiagnosticCode.PRICE_BASIS_UNAVAILABLE,
                "valuation.split_basis_mismatch",
                as_of,
                source="sec:companyfacts",
                details={
                    "symbol": symbol,
                    "priceSplitBasis": price.split_basis,
                    "factSplitBases": sorted(
                        {fact.split_basis or "unknown" for fact in currency_rows}
                    ),
                },
            ),
        )

    fresh = [
        fact
        for fact in basis_rows
        if (as_of - fact.period_end).days <= max_fact_age_days
    ]
    if not fresh:
        return None, (
            _diagnostic(
                DiagnosticCode.STALE_DATA,
                "valuation.fact_stale",
                as_of,
                source="sec:companyfacts",
                details={
                    "symbol": symbol,
                    "maxAgeDays": max_fact_age_days,
                    "latestReportPeriodEnd": max(
                        fact.period_end for fact in basis_rows
                    ).isoformat(),
                },
            ),
        )

    quarters = sorted(
        (fact for fact in fresh if _duration_days(fact) in range(70, 111)),
        key=lambda fact: (fact.period_end, fact.period_start),
    )
    quarter_candidates: list[_SelectedEPS] = []
    for index in range(len(quarters) - 3):
        window = tuple(quarters[index : index + 4])
        if all(
            left.period_end.toordinal() + 1 == right.period_start.toordinal()
            for left, right in zip(window, window[1:], strict=False)
        ):
            quarter_candidates.append(
                _SelectedEPS(
                    value=sum((fact.value for fact in window), Decimal("0")),
                    method="quarter_sum_estimate",
                    stock_class_id=price_stock_class_id,
                    period_start=window[0].period_start,
                    period_end=window[-1].period_end,
                    facts=window,
                )
            )

    annual_candidates = [
        _SelectedEPS(
            value=fact.value,
            method="annual_report",
            stock_class_id=price_stock_class_id,
            period_start=fact.period_start,
            period_end=fact.period_end,
            facts=(fact,),
        )
        for fact in fresh
        if _duration_days(fact) in range(335, 396)
    ]
    all_candidates = quarter_candidates + annual_candidates
    if not all_candidates:
        return None, (
            _diagnostic(
                DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                "valuation.eps_period_unqualified",
                as_of,
                source="sec:companyfacts",
                details={"symbol": symbol},
            ),
        )

    selected = max(
        all_candidates,
        key=lambda candidate: (
            candidate.period_end,
            candidate.method == "annual_report",
            max(fact.filed for fact in candidate.facts),
        ),
    )
    return selected, ()


def _available_on_session(
    *,
    filed: date,
    published_at: datetime | None,
    sessions: tuple[date, ...],
    session_closes: Mapping[date, datetime],
) -> date:
    """Resolve conservative first-use session from public metadata and close."""

    availability_date = filed
    if published_at is not None and published_at.date() > availability_date:
        availability_date = published_at.date()
    if published_at is not None and published_at.date() >= filed:
        close = session_closes.get(availability_date)
        if (
            close is not None
            and close.tzinfo is not None
            and close.utcoffset() is not None
        ):
            if published_at <= close:
                return availability_date
    next_index = bisect_right(sessions, availability_date)
    if next_index >= len(sessions):
        return date.max
    return sessions[next_index]


def _validate_as_of(
    as_of: date,
    exchange_calendar: ExchangeCalendar,
    session_closes: Mapping[date, datetime],
) -> None:
    sessions = exchange_calendar.trading_dates
    if as_of not in sessions:
        raise ValueError("as_of must belong to the exchange calendar")
    if any(session not in sessions for session in session_closes):
        raise ValueError("session close keys must belong to the exchange calendar")
    if any(
        close.tzinfo is None or close.utcoffset() is None
        for close in session_closes.values()
    ):
        raise ValueError("session close timestamps must include a timezone")


def _validate_price(
    price: PriceReference,
    *,
    as_of: date,
    symbol: str,
) -> Diagnostic | None:
    if price.date != as_of or price.symbol != symbol:
        return _diagnostic(
            DiagnosticCode.PRICE_BASIS_UNAVAILABLE,
            "valuation.price_unavailable",
            as_of,
            source=price.source,
            details={
                "expectedSymbol": symbol,
                "priceSymbol": price.symbol,
                "expectedDate": as_of.isoformat(),
                "priceDate": price.date.isoformat(),
            },
        )
    return None


def _validate_holding_capabilities(
    holdings: tuple[NportHolding, ...], as_of: date
) -> Diagnostic | None:
    for holding in holdings:
        if holding.weight is not None and holding.weight < 0:
            return _diagnostic(
                DiagnosticCode.SOURCE_QUALITY_WARNING,
                "valuation.etf_negative_holding_weight_unsupported",
                as_of,
                source=holding.source,
                details={"holdingId": holding.holding_id},
            )
        asset_type = holding.asset_type.strip().lower().replace("_", "-")
        issuer_type = holding.issuer_type.strip().lower().replace("_", "-")
        if asset_type.startswith("unknown:") or issuer_type.startswith("unknown:"):
            return _diagnostic(
                DiagnosticCode.SOURCE_QUALITY_WARNING,
                "valuation.holding_classification_unavailable",
                as_of,
                source=holding.source,
                details={
                    "holdingId": holding.holding_id,
                    "assetType": holding.asset_type,
                    "issuerType": holding.issuer_type,
                },
            )
        is_common_equity = asset_type in {
            "equity-common",
            "common-equity",
            "ec",
        }
        if is_common_equity and issuer_type not in {"corporate", "corp"}:
            return _diagnostic(
                DiagnosticCode.SOURCE_QUALITY_WARNING,
                "valuation.holding_classification_unavailable",
                as_of,
                source=holding.source,
                details={
                    "holdingId": holding.holding_id,
                    "assetType": holding.asset_type,
                    "issuerType": holding.issuer_type,
                },
            )
        if asset_type.startswith("derivative") or asset_type in {"der", "derivative"}:
            return _diagnostic(
                DiagnosticCode.SOURCE_QUALITY_WARNING,
                "valuation.etf_derivative_holdings_unsupported",
                as_of,
                source=holding.source,
                details={"holdingId": holding.holding_id},
            )
        if issuer_type in {"registered-fund", "regf", "private-fund", "privf"}:
            return _diagnostic(
                DiagnosticCode.SOURCE_QUALITY_WARNING,
                "valuation.etf_fund_of_funds_unsupported",
                as_of,
                source=holding.source,
                details={"holdingId": holding.holding_id},
            )
        payoff_profile = (holding.payoff_profile or "").strip().lower()
        if payoff_profile.startswith("unknown:"):
            return _diagnostic(
                DiagnosticCode.SOURCE_QUALITY_WARNING,
                "valuation.holding_payoff_unavailable",
                as_of,
                source=holding.source,
                details={
                    "holdingId": holding.holding_id,
                    "payoffProfile": holding.payoff_profile,
                },
            )
        if payoff_profile == "short":
            return _diagnostic(
                DiagnosticCode.SOURCE_QUALITY_WARNING,
                "valuation.etf_short_holding_unsupported",
                as_of,
                source=holding.source,
                details={"holdingId": holding.holding_id},
            )
        if is_common_equity and payoff_profile not in {"long", "l"}:
            return _diagnostic(
                DiagnosticCode.SOURCE_QUALITY_WARNING,
                "valuation.etf_non_long_equity_unsupported",
                as_of,
                source=holding.source,
                details={"holdingId": holding.holding_id},
            )
    return None


def _duration_days(fact: FinancialFact) -> int:
    return (fact.period_end - fact.period_start).days + 1


def _timestamp_sort_key(value: datetime | None) -> datetime:
    return value if value is not None else datetime.min.replace(tzinfo=UTC)


def _fact_reference(fact: FinancialFact) -> ValuationFactReference:
    return ValuationFactReference(
        symbol=fact.symbol,
        value=fact.value,
        currency=fact.currency,
        reportPeriodStart=fact.period_start,
        reportPeriodEnd=fact.period_end,
        filed=fact.filed,
        publishedAt=fact.published_at,
        form=fact.form,
        accession=fact.accession,
        splitBasis=fact.split_basis,
        stockClassId=fact.stock_class_id,
        source=fact.source,
        sourceVersion=fact.source_version,
    )


def _source_versions(facts: tuple[FinancialFact, ...]) -> str:
    return "+".join(sorted({fact.source_version for fact in facts}))


def _validate_policy(value: int, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{name} must be a positive integer")


def _diagnostic(
    code: DiagnosticCode,
    message_key: str,
    as_of: date,
    *,
    source: str,
    details: Mapping[str, object] | None = None,
) -> Diagnostic:
    return Diagnostic(
        code=code,
        messageKey=message_key,
        fieldPath="pe",
        asOf=as_of,
        source=source,
        details={} if details is None else details,
    )


def _unique_diagnostics(diagnostics: Iterable[Diagnostic]) -> tuple[Diagnostic, ...]:
    seen: set[tuple[DiagnosticCode, str, date | None, str | None]] = set()
    unique: list[Diagnostic] = []
    for item in diagnostics:
        key = (item.code, item.message_key, item.as_of, item.source)
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return tuple(unique)

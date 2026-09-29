from __future__ import annotations

from datetime import UTC, date, datetime, time
from decimal import Decimal

import pytest

from app.calendar.schedule import ExchangeCalendar
from app.catalog.service import default_data_settings, get_parameter_definition
from app.data.fundamentals import (
    FundamentalsResult,
    PriceReference,
    estimate_etf_pe,
    estimate_stock_pe,
)
from app.domain.status import DiagnosticCode
from app.domain.valuation import (
    ETFProfile,
    FinancialFact,
    NportHolding,
    NportSnapshot,
)

_DATA_SETTINGS = default_data_settings()
_DEFAULT_MIN_COVERAGE = get_parameter_definition("pe.etfMinCoverage").default
assert isinstance(_DEFAULT_MIN_COVERAGE, Decimal)


def _calendar(*days: date) -> ExchangeCalendar:
    return ExchangeCalendar.from_dates(
        days,
        as_of_date=days[-1],
        latest_complete_date=days[-1],
        calendar_coverage_end_date=days[-1],
    )


def _fact(
    *,
    start: date,
    end: date,
    value: str,
    filed: date = date(2024, 5, 1),
    published_at: datetime | None = None,
    form: str = "10-Q",
    accession: str | None = None,
    currency: str = "USD",
    split_basis: str | None = "post-split",
    symbol: str = "ABC",
    stock_class_id: str | None = "common",
) -> FinancialFact:
    return FinancialFact(
        symbol=symbol,
        cik="0000123456",
        concept="us-gaap:EarningsPerShareDiluted",
        value=Decimal(value),
        unit=f"{currency} / shares",
        currency=currency,
        periodStart=start,
        periodEnd=end,
        filed=filed,
        publishedAt=published_at,
        form=form,
        accession=accession or f"accn-{start.isoformat()}-{end.isoformat()}",
        splitBasis=split_basis,
        stockClassId=(None if stock_class_id is None else f"{symbol}:{stock_class_id}"),
        source="sec:companyfacts",
        sourceVersion="companyfacts-fixture-v1",
    )


def _price(
    symbol: str = "ABC",
    *,
    on: date = date(2024, 5, 2),
    value: str = "100",
    currency: str = "USD",
    split_basis: str = "post-split",
    stock_class_id: str | None = "common",
) -> PriceReference:
    return PriceReference(
        date=on,
        symbol=symbol,
        value=Decimal(value),
        currency=currency,
        splitBasis=split_basis,
        stockClassId=(None if stock_class_id is None else f"{symbol}:{stock_class_id}"),
        source="fixture:market",
    )


def _stock_pe(
    *,
    as_of: date,
    exchange_calendar: ExchangeCalendar,
    session_closes: dict[date, datetime],
    price: PriceReference,
    facts: tuple[FinancialFact, ...],
) -> FundamentalsResult:
    return estimate_stock_pe(
        as_of=as_of,
        symbol=price.symbol,
        expected_cik="0000123456",
        exchange_calendar=exchange_calendar,
        session_closes=session_closes,
        price=price,
        facts=facts,
        max_fact_age_days=_DATA_SETTINGS.financial_fact_max_age_days,
    )


def _etf_pe(
    *,
    as_of: date,
    exchange_calendar: ExchangeCalendar,
    session_closes: dict[date, datetime],
    fund_price: PriceReference,
    snapshots: tuple[NportSnapshot, ...],
    constituent_prices: dict[str, PriceReference],
    constituent_facts: tuple[FinancialFact, ...],
    min_coverage: Decimal = _DEFAULT_MIN_COVERAGE,
) -> FundamentalsResult:
    return estimate_etf_pe(
        as_of=as_of,
        fund=fund_price.symbol,
        exchange_calendar=exchange_calendar,
        session_closes=session_closes,
        fund_price=fund_price,
        snapshots=snapshots,
        constituent_prices=constituent_prices,
        constituent_facts=constituent_facts,
        max_fact_age_days=_DATA_SETTINGS.financial_fact_max_age_days,
        max_holdings_age_days=_DATA_SETTINGS.etf_holdings_max_age_days,
        min_coverage=min_coverage,
    )


def test_stock_pe_sums_only_four_reported_standalone_quarters() -> None:
    target = date(2024, 5, 2)
    sessions = (date(2024, 5, 1), target)
    facts = (
        _fact(
            start=date(2023, 4, 1),
            end=date(2023, 6, 30),
            value="1.0",
            filed=date(2023, 8, 1),
        ),
        _fact(
            start=date(2023, 7, 1),
            end=date(2023, 9, 30),
            value="1.2",
            filed=date(2023, 11, 1),
        ),
        _fact(
            start=date(2023, 10, 1),
            end=date(2023, 12, 31),
            value="1.3",
            filed=date(2024, 2, 1),
        ),
        _fact(
            start=date(2024, 1, 1),
            end=date(2024, 3, 31),
            value="1.5",
            filed=date(2024, 5, 1),
        ),
        # An XBRL year-to-date duration must not be subtracted into quarters.
        _fact(
            start=date(2023, 1, 1),
            end=date(2023, 6, 30),
            value="99",
            filed=date(2023, 8, 1),
            accession="ytd-q2",
        ),
    )

    result = _stock_pe(
        as_of=target,
        exchange_calendar=_calendar(*sessions),
        session_closes={
            day: datetime.combine(day, time(16), tzinfo=UTC) for day in sessions
        },
        price=_price(on=target),
        facts=facts,
    )

    assert result.observation is not None
    assert result.observation.eps == Decimal("5.0")
    assert result.observation.pe == Decimal("20")
    assert result.observation.method == "quarter_sum_estimate"
    assert result.observation.report_period_start == date(2023, 4, 1)
    assert result.observation.report_period_end == date(2024, 3, 31)
    assert result.observation.stock_class_id == "ABC:common"
    assert all(
        reference.stock_class_id == "ABC:common"
        for reference in result.observation.fact_references
    )


def test_stock_pe_falls_back_to_latest_annual_eps_and_prefers_annual_on_tie() -> None:
    target = date(2024, 5, 2)
    annual = _fact(
        start=date(2023, 1, 1),
        end=date(2023, 12, 31),
        value="4.25",
        filed=date(2024, 3, 1),
        form="10-K",
        accession="annual-2023",
    )
    facts = (
        _fact(
            start=date(2023, 10, 1),
            end=date(2023, 12, 31),
            value="1.1",
            filed=date(2024, 2, 1),
        ),
        annual,
    )

    result = _stock_pe(
        as_of=target,
        exchange_calendar=_calendar(date(2024, 5, 1), target),
        session_closes={
            day: datetime.combine(day, time(16), tzinfo=UTC)
            for day in (date(2024, 5, 1), target)
        },
        price=_price(on=target),
        facts=facts,
    )

    assert result.observation is not None
    assert result.observation.eps == Decimal("4.25")
    assert result.observation.method == "annual_report"
    assert result.observation.accession == "annual-2023"


@pytest.mark.parametrize("missing_class_side", ["fact", "price"])
def test_stock_pe_is_unavailable_without_verified_share_class_identity(
    missing_class_side: str,
) -> None:
    target = date(2024, 5, 2)
    fact = _fact(
        start=date(2023, 1, 1),
        end=date(2023, 12, 31),
        value="5",
        filed=date(2024, 3, 1),
        form="10-K",
        stock_class_id=None if missing_class_side == "fact" else "common",
    )

    result = _stock_pe(
        as_of=target,
        exchange_calendar=_calendar(date(2024, 5, 1), target),
        session_closes={
            day: datetime.combine(day, time(20), tzinfo=UTC)
            for day in (date(2024, 5, 1), target)
        },
        price=_price(
            on=target,
            stock_class_id=None if missing_class_side == "price" else "common",
        ),
        facts=(fact,),
    )

    assert result.observation is None
    assert any(
        item.message_key == "valuation.stock_class_unverified"
        for item in result.diagnostics
    )


def test_stock_pe_is_unavailable_when_price_and_eps_classes_differ() -> None:
    target = date(2024, 5, 2)
    fact = _fact(
        start=date(2023, 1, 1),
        end=date(2023, 12, 31),
        value="5",
        filed=date(2024, 3, 1),
        form="10-K",
        stock_class_id="class-b",
    )

    result = _stock_pe(
        as_of=target,
        exchange_calendar=_calendar(date(2024, 5, 1), target),
        session_closes={
            day: datetime.combine(day, time(20), tzinfo=UTC)
            for day in (date(2024, 5, 1), target)
        },
        price=_price(on=target, stock_class_id="class-a"),
        facts=(fact,),
    )

    assert result.observation is None
    assert any(
        item.message_key == "valuation.stock_class_mismatch"
        for item in result.diagnostics
    )


def test_fact_published_after_close_is_available_on_next_exchange_session() -> None:
    first = date(2024, 5, 2)
    next_session = date(2024, 5, 3)
    sessions = (first, next_session)
    fact = _fact(
        start=date(2023, 1, 1),
        end=date(2023, 12, 31),
        value="5",
        filed=first,
        published_at=datetime(2024, 5, 2, 21, 1, tzinfo=UTC),
        form="10-K",
    )
    closes = {
        first: datetime(2024, 5, 2, 20, 0, tzinfo=UTC),
        next_session: datetime(2024, 5, 3, 20, 0, tzinfo=UTC),
    }

    before = _stock_pe(
        as_of=first,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        price=_price(on=first),
        facts=(fact,),
    )
    after = _stock_pe(
        as_of=next_session,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        price=_price(on=next_session),
        facts=(fact,),
    )

    assert before.observation is None
    assert after.observation is not None
    assert after.observation.published_at == fact.published_at
    assert after.observation.accession == fact.accession


def test_fact_published_before_close_is_available_on_that_session() -> None:
    target = date(2024, 5, 2)
    fact = _fact(
        start=date(2023, 1, 1),
        end=date(2023, 12, 31),
        value="5",
        filed=target,
        published_at=datetime(2024, 5, 2, 19, 59, tzinfo=UTC),
        form="10-K",
    )

    result = _stock_pe(
        as_of=target,
        exchange_calendar=_calendar(target),
        session_closes={target: datetime(2024, 5, 2, 20, 0, tzinfo=UTC)},
        price=_price(on=target),
        facts=(fact,),
    )

    assert result.observation is not None
    assert result.observation.published_at == fact.published_at


def test_date_only_fact_is_not_available_on_filing_day() -> None:
    first = date(2024, 5, 2)
    next_session = date(2024, 5, 3)
    fact = _fact(
        start=date(2023, 1, 1),
        end=date(2023, 12, 31),
        value="5",
        filed=first,
        published_at=None,
        form="10-K",
    )
    sessions = (first, next_session)
    closes = {day: datetime.combine(day, time(20), tzinfo=UTC) for day in sessions}

    before = _stock_pe(
        as_of=first,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        price=_price(on=first),
        facts=(fact,),
    )
    after = _stock_pe(
        as_of=next_session,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        price=_price(on=next_session),
        facts=(fact,),
    )

    assert before.observation is None
    assert after.observation is not None


def test_publication_timestamp_after_filing_date_controls_as_of_availability() -> None:
    filed = date(2024, 5, 1)
    publication_day = date(2024, 5, 2)
    next_session = date(2024, 5, 3)
    sessions = (publication_day, next_session)
    fact = _fact(
        start=date(2023, 1, 1),
        end=date(2023, 12, 31),
        value="5",
        filed=filed,
        published_at=datetime(2024, 5, 2, 21, 1, tzinfo=UTC),
        form="10-K",
    )
    closes = {day: datetime.combine(day, time(20), tzinfo=UTC) for day in sessions}

    before_publication = _stock_pe(
        as_of=publication_day,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        price=_price(on=publication_day),
        facts=(fact,),
    )
    next_day = _stock_pe(
        as_of=next_session,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        price=_price(on=next_session),
        facts=(fact,),
    )

    assert before_publication.observation is None
    assert next_day.observation is not None


def test_etf_holdings_use_actual_dataset_publication_time() -> None:
    publication_day = date(2024, 5, 3)
    next_session = date(2024, 5, 6)
    sessions = (date(2024, 5, 2), publication_day, next_session)
    closes = {day: datetime.combine(day, time(20), tzinfo=UTC) for day in sessions}
    snapshot = _nport_snapshot((_holding("AAA", "1"),)).model_copy(
        update={"published_at": datetime(2024, 5, 3, 21, 1, tzinfo=UTC)}
    )
    prices = {"AAA": _price("AAA", on=next_session)}
    facts = (_component_fact("AAA", "5"),)

    before_publication = _etf_pe(
        as_of=publication_day,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        fund_price=_price("FUND", on=publication_day),
        snapshots=(snapshot,),
        constituent_prices={"AAA": _price("AAA", on=publication_day)},
        constituent_facts=facts,
    )
    next_day = _etf_pe(
        as_of=next_session,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        fund_price=_price("FUND", on=next_session),
        snapshots=(snapshot,),
        constituent_prices=prices,
        constituent_facts=facts,
    )

    assert before_publication.observation is None
    assert next_day.observation is not None
    assert next_day.observation.snapshot_date == snapshot.report_date


def test_stock_pe_is_unavailable_for_nonpositive_eps_or_currency_mismatch() -> None:
    target = date(2024, 5, 2)
    sessions = (date(2024, 5, 1), target)
    closes = {day: datetime.combine(day, time(20), tzinfo=UTC) for day in sessions}
    loss = _fact(
        start=date(2023, 1, 1),
        end=date(2023, 12, 31),
        value="-1",
        filed=date(2024, 3, 1),
        form="10-K",
    )
    wrong_currency = _fact(
        start=date(2023, 1, 1),
        end=date(2023, 12, 31),
        value="5",
        filed=date(2024, 3, 1),
        form="10-K",
        currency="EUR",
    )

    for fact in (loss, wrong_currency):
        result = _stock_pe(
            as_of=target,
            exchange_calendar=_calendar(*sessions),
            session_closes=closes,
            price=_price(on=target),
            facts=(fact,),
        )
        assert result.observation is None
        assert result.diagnostics


def test_stock_pe_is_unavailable_for_unknown_or_mismatched_split_basis() -> None:
    target = date(2024, 5, 2)
    sessions = (date(2024, 5, 1), target)
    closes = {day: datetime.combine(day, time(20), tzinfo=UTC) for day in sessions}
    annual = _fact(
        start=date(2023, 1, 1),
        end=date(2023, 12, 31),
        value="5",
        filed=date(2024, 3, 1),
        form="10-K",
        split_basis="pre-split",
    )

    result = _stock_pe(
        as_of=target,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        price=_price(on=target, split_basis="post-split"),
        facts=(annual,),
    )

    assert result.observation is None
    assert any(
        item.message_key == "valuation.split_basis_mismatch"
        for item in result.diagnostics
    )


def test_stock_pe_is_unavailable_when_the_latest_report_is_stale() -> None:
    target = date(2025, 8, 1)
    sessions = (date(2025, 7, 31), target)
    closes = {day: datetime.combine(day, time(20), tzinfo=UTC) for day in sessions}
    stale = _fact(
        start=date(2023, 1, 1),
        end=date(2023, 12, 31),
        value="5",
        filed=date(2024, 3, 1),
        form="10-K",
    )

    result = _stock_pe(
        as_of=target,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        price=_price(on=target),
        facts=(stale,),
    )

    assert result.observation is None
    assert any(
        item.message_key == "valuation.fact_stale" for item in result.diagnostics
    )


def _eligible_profile() -> ETFProfile:
    return ETFProfile(
        instrumentType="etf",
        physical=True,
        longOnly=True,
        leveraged=False,
        inverse=False,
        synthetic=False,
        fundOfFunds=False,
        hasDerivatives=False,
    )


def _holding(
    symbol: str,
    weight: str,
    *,
    cik: str = "0000123456",
    identity_matched: bool = True,
    stock_class_id: str | None = "common",
) -> NportHolding:
    return NportHolding(
        holdingId=symbol,
        symbol=symbol if identity_matched else None,
        cik=cik if identity_matched else None,
        weight=Decimal(weight),
        assetType="equity-common",
        issuerType="corporate",
        payoffProfile="long",
        currency="USD",
        identityMatched=identity_matched,
        stockClassId=(None if stock_class_id is None else f"{symbol}:{stock_class_id}"),
        source="sec:nport",
    )


def _nport_snapshot(holdings: tuple[NportHolding, ...]) -> NportSnapshot:
    return NportSnapshot(
        fund="FUND",
        reportDate=date(2024, 4, 30),
        filed=date(2024, 5, 1),
        accession="nport-accession-1",
        form="NPORT-P",
        source="sec:nport",
        sourceVersion="nport-fixture-v1",
        capabilities=_eligible_profile(),
        holdings=holdings,
    )


def _component_fact(symbol: str, value: str) -> FinancialFact:
    return _fact(
        start=date(2023, 1, 1),
        end=date(2023, 12, 31),
        value=value,
        filed=date(2024, 3, 1),
        form="10-K",
        symbol=symbol,
        accession=f"annual-{symbol}",
    )


def test_etf_pe_renormalizes_exact_eighty_percent_coverage_and_keeps_loss() -> None:
    target = date(2024, 5, 2)
    sessions = (date(2024, 5, 1), target)
    closes = {day: datetime.combine(day, time(20), tzinfo=UTC) for day in sessions}
    holdings = (
        _holding("AAA", "0.4"),
        _holding("BBB", "0.24"),
        _holding("CCC", "0.08", identity_matched=False),
        _holding("DDD", "0.08"),
        NportHolding(
            holdingId="BOND",
            weight=Decimal("0.2"),
            assetType="debt",
            issuerType="us-treasury",
            payoffProfile="long",
            currency="USD",
            identityMatched=False,
            source="sec:nport",
        ),
    )
    prices = {
        "AAA": _price("AAA", on=target, value="100"),
        "BBB": _price("BBB", on=target, value="50"),
    }
    facts = (
        _component_fact("AAA", "10"),
        _component_fact("BBB", "-2"),
        _component_fact("DDD", "5"),
    )

    result = _etf_pe(
        as_of=target,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        fund_price=_price("FUND", on=target),
        snapshots=(_nport_snapshot(holdings),),
        constituent_prices=prices,
        constituent_facts=facts,
    )

    assert result.observation is not None
    assert result.observation.coverage == Decimal("0.8")
    assert result.observation.stock_weight == Decimal("0.8")
    assert result.observation.earnings_yield == Decimal("0.0475")
    assert result.observation.pe == Decimal(1) / Decimal("0.0475")
    assert {item.symbol for item in result.observation.contributors} == {"AAA", "BBB"}
    assert next(
        item for item in result.observation.contributors if item.symbol == "BBB"
    ).eps == Decimal("-2")
    assert {item.eps_method for item in result.observation.contributors} == {
        "annual_report"
    }
    assert all(
        item.stock_class_id == f"{item.symbol}:common"
        for item in result.observation.contributors
    )
    assert result.observation.method == "etf_equity_earnings_yield"
    assert result.observation.snapshot_date == date(2024, 4, 30)


def test_etf_contribution_retains_quarter_sum_eps_method() -> None:
    target = date(2024, 5, 2)
    sessions = (date(2024, 5, 1), target)
    closes = {day: datetime.combine(day, time(20), tzinfo=UTC) for day in sessions}
    quarter_periods = (
        (date(2023, 1, 1), date(2023, 3, 31)),
        (date(2023, 4, 1), date(2023, 6, 30)),
        (date(2023, 7, 1), date(2023, 9, 30)),
        (date(2023, 10, 1), date(2023, 12, 31)),
    )
    quarterly_facts = tuple(
        _fact(
            start=start,
            end=end,
            value="1",
            filed=date(2024, 3, 1),
            form="10-Q",
            symbol="AAA",
            accession=f"quarter-{index}",
        )
        for index, (start, end) in enumerate(quarter_periods)
    )

    result = _etf_pe(
        as_of=target,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        fund_price=_price("FUND", on=target),
        snapshots=(_nport_snapshot((_holding("AAA", "1"),)),),
        constituent_prices={"AAA": _price("AAA", on=target)},
        constituent_facts=quarterly_facts,
    )

    assert result.observation is not None
    assert result.observation.contributors[0].eps_method == "quarter_sum_estimate"


def test_etf_does_not_match_a_different_share_class_price_to_a_holding() -> None:
    target = date(2024, 5, 2)
    sessions = (date(2024, 5, 1), target)
    closes = {day: datetime.combine(day, time(20), tzinfo=UTC) for day in sessions}

    result = _etf_pe(
        as_of=target,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        fund_price=_price("FUND", on=target),
        snapshots=(_nport_snapshot((_holding("AAA", "1", stock_class_id="class-b"),)),),
        constituent_prices={"AAA": _price("AAA", on=target)},
        constituent_facts=(_component_fact("AAA", "5"),),
    )

    assert result.observation is None
    assert any(
        item.message_key == "valuation.stock_class_mismatch"
        for item in result.diagnostics
    )


def test_etf_does_not_count_a_holding_without_verified_share_class() -> None:
    target = date(2024, 5, 2)
    sessions = (date(2024, 5, 1), target)
    closes = {day: datetime.combine(day, time(20), tzinfo=UTC) for day in sessions}

    result = _etf_pe(
        as_of=target,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        fund_price=_price("FUND", on=target),
        snapshots=(_nport_snapshot((_holding("AAA", "1", stock_class_id=None),)),),
        constituent_prices={"AAA": _price("AAA", on=target)},
        constituent_facts=(_component_fact("AAA", "5"),),
    )

    assert result.observation is None
    assert any(
        item.message_key == "valuation.stock_class_unverified"
        for item in result.diagnostics
    )


def test_etf_known_other_holdings_do_not_invalidate_stock_sleeve() -> None:
    target = date(2024, 5, 2)
    sessions = (date(2024, 5, 1), target)
    closes = {day: datetime.combine(day, time(20), tzinfo=UTC) for day in sessions}
    holdings = (
        _holding("AAA", "0.8"),
        _holding("OTHER-ASSET", "0.1").model_copy(
            update={"asset_type": "other", "payoff_profile": "na"}
        ),
        _holding("OTHER-ISSUER", "0.1").model_copy(
            update={
                "asset_type": "debt",
                "issuer_type": "other",
                "payoff_profile": None,
            }
        ),
    )

    result = _etf_pe(
        as_of=target,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        fund_price=_price("FUND", on=target),
        snapshots=(_nport_snapshot(holdings),),
        constituent_prices={"AAA": _price("AAA", on=target)},
        constituent_facts=(_component_fact("AAA", "5"),),
    )

    assert result.observation is not None
    assert result.observation.stock_weight == Decimal("0.8")
    assert result.observation.coverage == Decimal("1")
    assert {item.symbol for item in result.observation.contributors} == {"AAA"}


def test_etf_fails_closed_when_common_equity_issuer_is_ambiguous() -> None:
    target = date(2024, 5, 2)
    sessions = (date(2024, 5, 1), target)
    closes = {day: datetime.combine(day, time(20), tzinfo=UTC) for day in sessions}
    ambiguous = _holding("AAA", "1").model_copy(update={"issuer_type": "other"})

    result = _etf_pe(
        as_of=target,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        fund_price=_price("FUND", on=target),
        snapshots=(_nport_snapshot((ambiguous,)),),
        constituent_prices={"AAA": _price("AAA", on=target)},
        constituent_facts=(_component_fact("AAA", "5"),),
    )

    assert result.observation is None
    assert any(
        item.message_key == "valuation.holding_classification_unavailable"
        for item in result.diagnostics
    )


def test_etf_fails_closed_on_unknown_non_equity_payoff_profile() -> None:
    target = date(2024, 5, 2)
    sessions = (date(2024, 5, 1), target)
    closes = {day: datetime.combine(day, time(20), tzinfo=UTC) for day in sessions}
    unknown_payoff = _holding("BOND", "0.2").model_copy(
        update={"asset_type": "debt", "payoff_profile": "unknown:covered"}
    )

    result = _etf_pe(
        as_of=target,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        fund_price=_price("FUND", on=target),
        snapshots=(_nport_snapshot((_holding("AAA", "0.8"), unknown_payoff)),),
        constituent_prices={"AAA": _price("AAA", on=target)},
        constituent_facts=(_component_fact("AAA", "5"),),
    )

    assert result.observation is None
    assert any(
        item.message_key == "valuation.holding_payoff_unavailable"
        for item in result.diagnostics
    )


def test_etf_rejects_short_holding_from_provider_neutral_snapshot() -> None:
    target = date(2024, 5, 2)
    sessions = (date(2024, 5, 1), target)
    closes = {day: datetime.combine(day, time(20), tzinfo=UTC) for day in sessions}
    short_holding = _holding("SHORT-BOND", "0.2").model_copy(
        update={"asset_type": "debt", "payoff_profile": "short"}
    )

    result = _etf_pe(
        as_of=target,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        fund_price=_price("FUND", on=target),
        snapshots=(_nport_snapshot((_holding("AAA", "0.8"), short_holding)),),
        constituent_prices={"AAA": _price("AAA", on=target)},
        constituent_facts=(_component_fact("AAA", "5"),),
    )

    assert result.observation is None
    assert any(
        item.message_key == "valuation.etf_short_holding_unsupported"
        for item in result.diagnostics
    )


@pytest.mark.parametrize(
    ("classification_field", "classification"),
    [
        ("asset_type", "unknown:new_asset_category"),
        ("issuer_type", "unknown:new_issuer_category"),
    ],
)
def test_etf_fails_closed_on_unclassified_holding_weight(
    classification_field: str, classification: str
) -> None:
    target = date(2024, 5, 2)
    sessions = (date(2024, 5, 1), target)
    closes = {day: datetime.combine(day, time(20), tzinfo=UTC) for day in sessions}
    hidden = _holding("HIDDEN", "0.2").model_copy(
        update={classification_field: classification}
    )

    result = _etf_pe(
        as_of=target,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        fund_price=_price("FUND", on=target),
        snapshots=(_nport_snapshot((_holding("AAA", "0.8"), hidden)),),
        constituent_prices={"AAA": _price("AAA", on=target)},
        constituent_facts=(_component_fact("AAA", "5"),),
    )

    assert result.observation is None
    assert any(
        item.message_key == "valuation.holding_classification_unavailable"
        for item in result.diagnostics
    )


def test_etf_retains_zero_weight_matched_contributor() -> None:
    target = date(2024, 5, 2)
    sessions = (date(2024, 5, 1), target)
    closes = {day: datetime.combine(day, time(20), tzinfo=UTC) for day in sessions}

    result = _etf_pe(
        as_of=target,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        fund_price=_price("FUND", on=target),
        snapshots=(_nport_snapshot((_holding("AAA", "1"), _holding("ZERO", "0"))),),
        constituent_prices={
            "AAA": _price("AAA", on=target),
            "ZERO": _price("ZERO", on=target),
        },
        constituent_facts=(
            _component_fact("AAA", "5"),
            _component_fact("ZERO", "3"),
        ),
    )

    assert result.observation is not None
    assert result.observation.coverage == Decimal("1")
    zero = next(
        item for item in result.observation.contributors if item.symbol == "ZERO"
    )
    assert zero.weight == Decimal("0")
    assert zero.eps_method == "annual_report"


def test_etf_zero_matched_weight_is_unavailable_even_when_minimum_is_zero() -> None:
    target = date(2024, 5, 2)
    sessions = (date(2024, 5, 1), target)
    closes = {day: datetime.combine(day, time(20), tzinfo=UTC) for day in sessions}

    result = _etf_pe(
        as_of=target,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        fund_price=_price("FUND", on=target),
        snapshots=(
            _nport_snapshot((_holding("MISSING", "1", identity_matched=False),)),
        ),
        constituent_prices={},
        constituent_facts=(),
        min_coverage=Decimal("0"),
    )

    assert result.observation is None
    unavailable = next(
        item
        for item in result.diagnostics
        if item.message_key == "valuation.etf_matched_weight_unavailable"
    )
    assert unavailable.code is DiagnosticCode.REQUIRED_DATA_UNAVAILABLE


def test_etf_pe_rejects_coverage_below_default_but_allows_configured_threshold() -> (
    None
):
    target = date(2024, 5, 2)
    sessions = (date(2024, 5, 1), target)
    closes = {day: datetime.combine(day, time(20), tzinfo=UTC) for day in sessions}
    holding = _holding("AAA", "0.79")
    unmatched = _holding("UNKNOWN", "0.21", identity_matched=False)
    snapshot = _nport_snapshot((holding, unmatched))
    prices = {"AAA": _price("AAA", on=target)}
    facts = (_component_fact("AAA", "5"),)

    default_result = _etf_pe(
        as_of=target,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        fund_price=_price("FUND", on=target),
        snapshots=(snapshot,),
        constituent_prices=prices,
        constituent_facts=facts,
    )
    configured_result = _etf_pe(
        as_of=target,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        fund_price=_price("FUND", on=target),
        snapshots=(snapshot,),
        constituent_prices=prices,
        constituent_facts=facts,
        min_coverage=Decimal("0.75"),
    )

    assert default_result.observation is None
    assert configured_result.observation is not None
    assert configured_result.observation.coverage == Decimal("0.79")
    assert configured_result.observation.contributors[0].weight == Decimal("0.79")


def test_etf_pe_rejects_ineligible_fund_structure_and_nonpositive_yield() -> None:
    target = date(2024, 5, 2)
    sessions = (date(2024, 5, 1), target)
    closes = {day: datetime.combine(day, time(20), tzinfo=UTC) for day in sessions}
    holding = _holding("AAA", "1")
    supported = _nport_snapshot((holding,))
    unsupported = supported.model_copy(
        update={
            "capabilities": ETFProfile(
                instrumentType="etf",
                physical=True,
                longOnly=True,
                leveraged=True,
                inverse=False,
                synthetic=False,
                fundOfFunds=False,
                hasDerivatives=False,
            )
        }
    )
    common = {
        "as_of": target,
        "exchange_calendar": _calendar(*sessions),
        "session_closes": closes,
        "fund_price": _price("FUND", on=target),
        "constituent_prices": {"AAA": _price("AAA", on=target)},
    }

    unsupported_result = _etf_pe(
        **common,
        snapshots=(unsupported,),
        constituent_facts=(_component_fact("AAA", "5"),),
    )
    nonpositive_yield_result = _etf_pe(
        **common,
        snapshots=(supported,),
        constituent_facts=(_component_fact("AAA", "-5"),),
    )

    assert unsupported_result.observation is None
    assert any(
        item.message_key == "valuation.etf_capability_unsupported"
        for item in unsupported_result.diagnostics
    )
    assert nonpositive_yield_result.observation is None
    assert any(
        item.message_key == "valuation.etf_nonpositive_earnings_yield"
        for item in nonpositive_yield_result.diagnostics
    )


def test_etf_uses_last_published_historical_holdings_and_rejects_stale_snapshot() -> (
    None
):
    target = date(2024, 7, 2)
    sessions = (date(2024, 5, 2), date(2024, 7, 1), target)
    closes = {day: datetime.combine(day, time(20), tzinfo=UTC) for day in sessions}
    earlier = _nport_snapshot((_holding("AAA", "1"),))
    later = earlier.model_copy(
        update={
            "report_date": date(2024, 6, 30),
            "filed": date(2024, 7, 1),
            "accession": "nport-accession-2",
            "holdings": (_holding("BBB", "1"),),
        }
    )
    prices = {
        "AAA": _price("AAA", on=target),
        "BBB": _price("BBB", on=target),
    }
    facts = (_component_fact("AAA", "5"), _component_fact("BBB", "10"))

    selected = _etf_pe(
        as_of=target,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        fund_price=_price("FUND", on=target),
        snapshots=(earlier, later),
        constituent_prices=prices,
        constituent_facts=facts,
    )

    assert selected.observation is not None
    assert {item.symbol for item in selected.observation.contributors} == {"BBB"}
    assert selected.observation.snapshot_date == date(2024, 6, 30)

    stale = later.model_copy(
        update={"report_date": date(2023, 12, 31), "filed": date(2024, 1, 1)}
    )
    stale_result = _etf_pe(
        as_of=target,
        exchange_calendar=_calendar(*sessions),
        session_closes=closes,
        fund_price=_price("FUND", on=target),
        snapshots=(stale,),
        constituent_prices=prices,
        constituent_facts=facts,
    )

    assert stale_result.observation is None
    assert any(
        item.message_key == "valuation.holdings_stale"
        for item in stale_result.diagnostics
    )

from datetime import UTC, date, datetime
from decimal import Decimal

import pytest

from app.calendar import ExchangeCalendar
from app.data.market_data import MarketDataRequest
from app.data.providers.sec_client import SecRequestError
from app.data.providers.sec_valuation import SecValuationProvider, _us_sessions
from app.data.providers.yahoo_splits import StockSplitEvidence
from app.domain.contracts import MarketBar, MarketSnapshot
from app.domain.status import DiagnosticCode

DAYS = (date(2024, 2, 15), date(2024, 2, 16), date(2024, 2, 20))


class Client:
    def __init__(self, title="Common stock", symbol="ABC"):
        self.title, self.symbol = title, symbol
        self.document_calls = []

    def company_tickers(self):
        return {"0": {"ticker": "ABC", "cik_str": 123456, "title": "ABC Inc."}}

    def company_facts(self, cik):
        return {
            "cik": 123456,
            "facts": {
                "us-gaap": {
                    "EarningsPerShareDiluted": {
                        "units": {
                            "USD/shares": [
                                {
                                    "start": "2023-01-01",
                                    "end": "2023-12-31",
                                    "val": Decimal("5"),
                                    "filed": "2024-02-15",
                                    "accn": "0000123456-24-000001",
                                    "form": "10-K",
                                }
                            ]
                        }
                    }
                }
            },
        }

    def submissions(self, cik):
        return {
            "filings": {
                "recent": {
                    "accessionNumber": ["0000123456-24-000001"],
                    "filingDate": ["2024-02-15"],
                    "acceptanceDateTime": ["2024-02-15T21:04:00Z"],
                    "form": ["10-K"],
                    "primaryDocument": ["abc-20231231.htm"],
                },
                "files": [],
            }
        }

    def filing_document(self, cik, accession, name):
        self.document_calls.append(accession)
        return (
            '<ix:nonNumeric name="dei:Security12bTitle" contextRef="one">'
            f'{self.title}</ix:nonNumeric><ix:nonNumeric name="dei:TradingSymbol" '
            f'contextRef="one">{self.symbol}</ix:nonNumeric>'
        )


class Adapter:
    def __init__(self, split=None, wrong_price=False):
        self.split, self.wrong_price = split, wrong_price

    def split_evidence(self, symbol, *, sessions):
        prices = tuple(
            (day, Decimal(99 if self.wrong_price else 100)) for day in sessions
        )
        return StockSplitEvidence(
            () if self.split is None else ((self.split, Decimal(4)),), prices
        ), None


def context():
    calendar = ExchangeCalendar(
        tradingDates=DAYS,
        latestCompleteDate=DAYS[-1],
        asOfDate=date(2024, 2, 21),
        calendarCoverageEndDate=DAYS[-1],
    )
    request = MarketDataRequest(
        symbol="ABC",
        startDate=DAYS[0],
        endDate=DAYS[-1],
        exchangeCalendar=calendar,
        macroStalenessSessions=3,
    )
    market = MarketSnapshot(
        symbol="ABC",
        currency="USD",
        source="yahoo",
        fingerprint="market",
        bars=tuple(
            MarketBar(
                date=day,
                symbol="ABC",
                simulationPrice=98,
                valuationPrice=100,
                currency="USD",
                source="yahoo",
                observedAt=datetime.combine(day, datetime.min.time(), UTC),
            )
            for day in DAYS
        ),
    )
    return request, market


def load(client=None, adapter=None):
    request, market = context()
    return SecValuationProvider(
        client=client or Client(),
        adapter=adapter or Adapter(),
        split_sessions=lambda start, end: (date(2023, 1, 3), *DAYS, date(2025, 1, 2)),
    ).load(
        request=request,
        market=market,
        max_fact_age_days=550,
        session_closes={
            day: datetime.combine(day, datetime.min.time(), UTC).replace(hour=21)
            for day in DAYS
        },
        now=datetime(2025, 1, 3, tzinfo=UTC),
    )


def test_verified_annual_eps_becomes_available_only_after_acceptance():
    result = load()
    assert result.snapshot is not None
    assert [item.date for item in result.snapshot.observations] == list(DAYS[1:])
    value = result.snapshot.observations[0]
    assert value.pe == 20 and value.eps == 5 and value.valuation_price == 100
    assert value.method == "annual_report"
    assert value.fact_references[0].published_at == datetime(
        2024, 2, 15, 21, 4, tzinfo=UTC
    )
    assert value.fact_references[0].stock_class_id == "sec:0000123456:common:ABC"
    assert result.diagnostics[0].as_of == DAYS[0]


def test_latest_ticker_cannot_prove_a_different_historical_class():
    for client in (Client(symbol="OLD"), Client(title="Preferred stock")):
        result = load(client=client)
        assert result.snapshot is not None and not result.snapshot.observations
        assert any(
            item.message_key == "valuation.stock_class_unverified"
            for item in result.diagnostics
        )


def test_split_after_backtest_end_still_invalidates_unadjusted_historical_eps():
    result = load(adapter=Adapter(split=date(2024, 12, 31)))
    assert result.snapshot is not None and not result.snapshot.observations
    assert any(
        item.message_key == "valuation.split_basis_mismatch"
        for item in result.diagnostics
    )


def test_cached_market_prices_must_match_verified_current_share_basis():
    result = load(adapter=Adapter(wrong_price=True))
    assert result.snapshot is None
    assert result.diagnostics[0].message_key == "valuation.price_basis_mismatch"


def test_eps_8k_is_joined_without_fetching_unrelated_legacy_submissions():
    class Disclosure(Client):
        def company_facts(self, cik):
            value = super().company_facts(cik)
            rows = value["facts"]["us-gaap"]["EarningsPerShareDiluted"]["units"][
                "USD/shares"
            ]
            rows.append(
                {
                    **rows[0],
                    "val": Decimal("6"),
                    "filed": "2024-02-16",
                    "accn": "0000123456-24-000002",
                    "form": "8-K",
                }
            )
            return value

        def submissions(self, cik):
            value = super().submissions(cik)
            rows = value["filings"]["recent"]
            for key, item in (
                ("accessionNumber", "0000123456-24-000002"),
                ("filingDate", "2024-02-16"),
                ("acceptanceDateTime", "2024-02-16T21:04:00Z"),
                ("form", "8-K"),
                ("primaryDocument", "abc-disclosure.htm"),
            ):
                rows[key].append(item)
            value["filings"]["files"] = [
                {
                    "name": "CIK0000123456-submissions-001.json",
                    "filingFrom": "1994-01-01",
                    "filingTo": "2000-01-01",
                }
            ]
            return value

        def submissions_file(self, name):
            raise AssertionError("unrelated legacy filings must not be requested")

    client = Disclosure()
    result = load(client=client)
    assert result.snapshot is not None
    assert [item.eps for item in result.snapshot.observations] == [
        Decimal("5"),
        Decimal("6"),
    ]
    assert set(client.document_calls) == {
        "0000123456-24-000001",
        "0000123456-24-000002",
    }


def test_action_history_excludes_unclosed_sessions_and_accepts_weekend_bounds():
    assert _us_sessions(date(2026, 10, 1), datetime(2026, 10, 4, tzinfo=UTC)) == (
        date(2026, 10, 1),
        date(2026, 10, 2),
    )
    assert _us_sessions(
        date(2026, 10, 1), datetime(2026, 10, 2, 20, 10, tzinfo=UTC)
    ) == (date(2026, 10, 1),)


def test_provider_request_errors_and_local_programming_errors_are_distinct():
    class Failed(Client):
        def company_tickers(self):
            raise SecRequestError("connection_failed")

    assert (
        load(client=Failed()).diagnostics[0].code
        is DiagnosticCode.PROVIDER_REQUEST_FAILED
    )

    class Broken(Client):
        def company_tickers(self):
            raise ValueError("local programming defect")

    with pytest.raises(ValueError, match="local programming defect"):
        load(client=Broken())

from datetime import UTC, date, datetime

from app.calendar import ExchangeCalendar
from app.config.validation import validate_draft
from app.data.fixtures import load_fixture
from app.data.market_data import FixtureMarketDataAdapter, MarketDataRequest
from app.data.providers.sec_valuation import ValuationLoad
from app.domain.contracts import ValuationSnapshot
from app.domain.status import Diagnostic, DiagnosticCode
from app.runs.yahoo_data import YahooRunDataProvider


def test_valuation_composes_once_and_failure_only_binds_dependent_strategies():
    fixture = load_fixture("task4_core")
    calendar = ExchangeCalendar.from_dates(
        fixture.exchange_dates,
        as_of_date=fixture.exchange_dates[-1],
        latest_complete_date=fixture.exchange_dates[-1],
        calendar_coverage_end_date=fixture.exchange_dates[-1],
    )
    request = MarketDataRequest(
        symbol="QQQ",
        startDate=date(2024, 1, 31),
        endDate=date(2024, 2, 2),
        exchangeCalendar=calendar,
        macroStalenessSessions=3,
    )
    market = FixtureMarketDataAdapter(bundle=fixture).load(request)
    validation = validate_draft(
        {
            "shared": {},
            "strategies": [
                {"id": "pe", "presetId": "pe_dca"},
                {"id": "dca", "presetId": "monthly_dca"},
            ],
        }
    )
    config = validation.config_for()
    provider = YahooRunDataProvider()
    valuation = ValuationSnapshot(symbol="QQQ", fingerprint="verified-valuations")
    error = Diagnostic(
        code=DiagnosticCode.PRICE_BASIS_UNAVAILABLE,
        messageKey="valuation.stock_class_unverified",
        source="sec",
    )
    loads = provider._build_strategy_loads(
        strategies=config.strategies,
        strategy_requirements={
            row.id: tuple(
                req for req in validation.data_requirements if req.strategy_id == row.id
            )
            for row in config.strategies
        },
        market_result=market,
        calendar=calendar,
        market_diagnostics=(),
        macro_results={},
        valuation_result=ValuationLoad(snapshot=valuation, diagnostics=(error,)),
    )
    assert loads["pe"].snapshot.valuation == valuation
    assert loads["pe"].snapshot == loads["dca"].snapshot
    assert loads["pe"].snapshot.fingerprint != market.snapshot.fingerprint
    assert not loads["dca"].diagnostics
    assert loads["pe"].diagnostics[0].details["strategyId"] == "pe"
    assert loads["pe"].diagnostics[0].field_path == next(
        req.field_path
        for req in validation.data_requirements
        if req.strategy_id == "pe" and req.kind.value == "valuation"
    )
    assert all(
        item.message_key != "data.sec_valuation_provider_unavailable"
        for item in loads["pe"].diagnostics
    )


def test_local_sec_exception_returns_an_isolated_calculation_diagnostic(caplog):
    class Broken:
        def load(self, **values):
            raise RuntimeError("local parser bug")

    provider = YahooRunDataProvider(valuation_provider=Broken())
    result = provider._load_valuation(
        request=None,
        market=None,
        max_fact_age_days=550,
        session_closes={},
        now=datetime.now(UTC),
    )
    assert result.snapshot is None
    assert len(result.diagnostics) == 1
    assert result.diagnostics[0].code is DiagnosticCode.CALCULATION_FAILED
    assert result.diagnostics[0].details == {"stage": "sec_normalization"}
    assert any(record.exception_type == "RuntimeError" for record in caplog.records)

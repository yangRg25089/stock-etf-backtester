from datetime import UTC, date, datetime

import pytest
from pydantic import ValidationError

from app.calendar import ExchangeCalendar
from app.catalog.definitions import ParameterValidationError, validate_parameter_value
from app.catalog.service import get_parameter_definition
from app.data.fixtures import load_fixture
from app.data.market_data import MarketDataRequest
from app.domain.contracts import RunSettings


@pytest.mark.parametrize("symbol", ["Q Q", "QQQ/", "QQQ!", "A" * 33, "あ"])
def test_symbol_format_is_shared_by_catalog_run_and_data_request(symbol):
    with pytest.raises(ParameterValidationError):
        validate_parameter_value(get_parameter_definition("run.symbol"), symbol)
    with pytest.raises(ValidationError):
        RunSettings(
            symbol=symbol, startDate=date(2024, 1, 1), endDate=date(2024, 1, 31)
        )
    fixture = load_fixture("task4_core")
    calendar = ExchangeCalendar.from_dates(
        fixture.exchange_dates,
        as_of_date=fixture.exchange_dates[-1],
        latest_complete_date=fixture.exchange_dates[-1],
        calendar_coverage_end_date=fixture.exchange_dates[-1],
    )
    with pytest.raises(ValidationError):
        MarketDataRequest(
            symbol=symbol,
            startDate=date(2024, 1, 30),
            endDate=date(2024, 2, 2),
            exchangeCalendar=calendar,
            macroStalenessSessions=3,
        )


@pytest.mark.parametrize("key", ["run.symbol", "rate.symbol"])
def test_symbol_catalog_exposes_the_shared_format_constraint(key):
    assert (
        getattr(get_parameter_definition(key), "pattern", None)
        == r"^[A-Za-z0-9.^=_-]{1,32}$"
    )


@pytest.mark.parametrize("symbol", ["QQQ", "^VIX", "0700.HK", "BRK-B", "EURUSD=X"])
def test_valid_provider_symbols_pass_the_catalog(symbol):
    validate_parameter_value(get_parameter_definition("run.symbol"), symbol)


@pytest.mark.parametrize(
    "value", [datetime(2024, 1, 1), datetime(2024, 1, 1, tzinfo=UTC)]
)
def test_registered_date_rejects_datetime_subclasses(value):
    with pytest.raises(ParameterValidationError):
        validate_parameter_value(get_parameter_definition("run.startDate"), value)


@pytest.mark.parametrize(
    "key,value",
    [
        ("search.dimensions", ()),
        ("search.dimensions", ("vix.buyThreshold", "vix.buyThreshold")),
        ("search.values.vix.buyThreshold", ()),
        ("search.values.vix.buyThreshold", (25, 25)),
    ],
)
def test_search_collections_remain_nonempty_and_unique(key, value):
    with pytest.raises(ParameterValidationError):
        validate_parameter_value(get_parameter_definition(key), value)

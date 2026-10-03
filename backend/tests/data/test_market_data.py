from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from pydantic import ValidationError

from app.calendar.schedule import ExchangeCalendar
from app.catalog.service import default_data_settings
from app.data.cache import (
    CachedMacroDataProvider,
    CachedMarketDataProvider,
    DataCacheKey,
    InMemoryDataCache,
)
from app.data.contracts import MacroDataResult
from app.data.fixtures import FixtureBundle, load_fixture
from app.data.market_data import (
    FixtureMarketDataAdapter,
    MarketDataRequest,
    align_macro_observations,
    compose_data_snapshot,
    normalize_rate_value,
)
from app.data.providers.yahoo import YahooFinanceAdapter
from app.domain.contracts import (
    ContributionSettings,
    MacroObservation,
    RunConfig,
    RunSettings,
    RunSnapshot,
    SharedSettings,
)
from app.domain.status import DiagnosticCode


def _calendar(*days: date) -> ExchangeCalendar:
    sessions = tuple(days)
    return ExchangeCalendar.from_dates(
        sessions,
        as_of_date=sessions[-1],
        latest_complete_date=sessions[-1],
        calendar_coverage_end_date=sessions[-1],
    )


def _request(
    calendar: ExchangeCalendar,
    *,
    start: date = date(2024, 1, 31),
    end: date = date(2024, 2, 2),
    prewarm_start: date | None = date(2024, 1, 30),
    max_staleness: object = 3,
    frequency: str = "1d",
) -> MarketDataRequest:
    return MarketDataRequest(
        symbol="QQQ",
        startDate=start,
        endDate=end,
        prewarmStartDate=prewarm_start,
        frequency=frequency,
        exchangeCalendar=calendar,
        macroStalenessSessions=max_staleness,
    )


class _Frame:
    def __init__(
        self,
        columns: list[object],
        rows: list[tuple[datetime, dict[object, object]]],
    ):
        self.columns = columns
        self._rows = rows

    def iterrows(self):
        return iter(self._rows)


class _Ticker:
    def __init__(
        self,
        frame: _Frame,
        *,
        currency: str | None = "USD",
        metadata: dict[str, object] | None = None,
        history_error: Exception | None = None,
    ) -> None:
        self.frame = frame
        self.fast_info: dict[str, object] = (
            {} if currency is None else {"currency": currency}
        )
        self.history_metadata = {} if metadata is None else metadata
        self.history_kwargs: dict[str, object] | None = None
        self.history_error = history_error

    def history(self, **kwargs: object) -> _Frame:
        self.history_kwargs = kwargs
        if self.history_error is not None:
            raise self.history_error
        return self.frame


def _yahoo_adapter(ticker: _Ticker) -> YahooFinanceAdapter:
    return YahooFinanceAdapter(
        ticker_factory=lambda _symbol: ticker,
        data_version="yfinance-test-1.7.0",
    )


def test_yahoo_adapter_passes_an_explicit_timeout_to_history() -> None:
    ticker = _Ticker(_Frame(["Close", "Adj Close"], []))
    adapter = YahooFinanceAdapter(
        ticker_factory=lambda _symbol: ticker,
        request_timeout_seconds=4.5,
        data_version="yfinance-test-1.7.0",
    )

    adapter.load(_request(_calendar(date(2024, 1, 31))))

    assert ticker.history_kwargs is not None
    assert ticker.history_kwargs["timeout"] == 4.5


@pytest.mark.parametrize("timeout", [0, -1, float("inf"), float("nan"), True])
def test_yahoo_adapter_rejects_invalid_request_timeouts(timeout: object) -> None:
    with pytest.raises(ValueError, match="finite positive"):
        YahooFinanceAdapter(request_timeout_seconds=timeout)  # type: ignore[arg-type]


def test_yahoo_rate_limit_diagnostic_is_specific_and_omits_exception_text() -> None:
    class YFRateLimitError(Exception):
        pass

    ticker = _Ticker(
        _Frame(["Close", "Adj Close"], []),
        history_error=YFRateLimitError("token=must-not-escape"),
    )

    result = _yahoo_adapter(ticker).load(_request(_calendar(date(2024, 1, 31))))

    diagnostic = result.diagnostics[0]
    assert result.snapshot is None
    assert diagnostic.message_key == "market.provider_rate_limited"
    assert diagnostic.details == {
        "symbol": "QQQ",
        "exceptionType": "YFRateLimitError",
        "failureKind": "rate_limited",
    }
    assert "token=must-not-escape" not in result.model_dump_json()


def test_yahoo_rate_limit_log_omits_provider_exception_text(caplog) -> None:
    class YFRateLimitError(Exception):
        pass

    ticker = _Ticker(
        _Frame(["Close", "Adj Close"], []),
        history_error=YFRateLimitError("secret=must-not-escape"),
    )

    _yahoo_adapter(ticker).load(_request(_calendar(date(2024, 1, 31))))

    records = [record for record in caplog.records if record.name.endswith("yahoo")]
    assert len(records) == 1
    assert records[0].failure_kind == "rate_limited"
    assert records[0].exception_type == "YFRateLimitError"
    assert "secret=must-not-escape" not in caplog.text


def test_yahoo_http_429_diagnostic_is_classified_as_rate_limited() -> None:
    class _Response:
        status_code = 429

    class ProviderHttpError(Exception):
        response = _Response()

    ticker = _Ticker(
        _Frame(["Close", "Adj Close"], []),
        history_error=ProviderHttpError("response body must not escape"),
    )

    result = _yahoo_adapter(ticker).load(_request(_calendar(date(2024, 1, 31))))

    assert result.diagnostics[0].message_key == "market.provider_rate_limited"
    assert result.diagnostics[0].details["failureKind"] == "rate_limited"
    assert "response body must not escape" not in result.model_dump_json()


def test_yahoo_timeout_diagnostic_is_specific_and_omits_exception_text() -> None:
    ticker = _Ticker(
        _Frame(["Close", "Adj Close"], []),
        history_error=TimeoutError("authorization=must-not-escape"),
    )

    result = _yahoo_adapter(ticker).load(_request(_calendar(date(2024, 1, 31))))

    diagnostic = result.diagnostics[0]
    assert result.snapshot is None
    assert diagnostic.message_key == "market.provider_timeout"
    assert diagnostic.details["failureKind"] == "timeout"
    assert "authorization=must-not-escape" not in result.model_dump_json()


def test_market_request_receives_catalog_materialized_staleness_default() -> None:
    calendar = _calendar(date(2024, 1, 30), date(2024, 1, 31))
    settings = default_data_settings()
    request = MarketDataRequest(
        symbol="QQQ",
        startDate=date(2024, 1, 30),
        endDate=date(2024, 1, 31),
        exchangeCalendar=calendar,
        macroStalenessSessions=settings.macro_staleness_sessions,
    )

    assert request.macro_staleness_sessions == settings.macro_staleness_sessions


@pytest.mark.parametrize("value", [-1, True, "3"])
def test_market_request_rejects_invalid_staleness_value(value: object) -> None:
    calendar = _calendar(date(2024, 1, 30), date(2024, 1, 31))

    with pytest.raises(ValidationError):
        _request(calendar, max_staleness=value)


def test_shared_macro_staleness_setting_uses_registry_default_and_is_adjustable() -> (
    None
):
    settings = SharedSettings(
        run=RunSettings(
            symbol="QQQ",
            startDate=date(2024, 1, 30),
            endDate=date(2024, 2, 2),
            endMode="fixed",
        ),
        contribution=ContributionSettings(day=1, amount=Decimal("100")),
        data=default_data_settings(),
    )
    adjusted = SharedSettings(
        run=settings.run,
        contribution=settings.contribution,
        data=default_data_settings().model_copy(update={"macro_staleness_sessions": 7}),
    )

    assert settings.data.macro_staleness_sessions == 3
    assert adjusted.data.macro_staleness_sessions == 7
    snapshot = RunSnapshot.from_config(
        run_id="macro-policy-run",
        config=RunConfig(shared=adjusted),
        catalog_version="catalog-test",
        data_fingerprint="fixture-test",
        engine_version="engine-test",
    )
    assert snapshot.config.shared.data.macro_staleness_sessions == 7


def test_fixture_adapter_keeps_pre_warm_bars_sparse_and_provider_neutral() -> None:
    fixture = load_fixture("task4_core")
    calendar = _calendar(*fixture.exchange_dates)
    adapter = FixtureMarketDataAdapter(bundle=fixture)

    request = _request(
        calendar,
        start=date(2024, 1, 31),
        end=date(2024, 2, 2),
        prewarm_start=date(2024, 1, 30),
    )
    result = adapter.load(request)

    assert result.snapshot is not None
    assert result.snapshot.valuation is None
    assert result.snapshot.market.currency == "USD"
    assert result.snapshot.market.source == "fixture:task4-core"
    assert request.target_sessions[0] == date(2024, 1, 31)
    assert tuple(bar.date for bar in result.snapshot.market.bars) == (
        date(2024, 1, 30),
        date(2024, 1, 31),
        date(2024, 2, 1),
        date(2024, 2, 2),
    )
    assert result.snapshot.market.bars[1].simulation_price == Decimal("200")
    assert result.snapshot.market.bars[1].valuation_price == Decimal("400")
    assert result.snapshot.market.bars[1].observed_at == datetime(
        2024, 1, 31, 21, tzinfo=UTC
    )
    rate_rows = [item for item in result.snapshot.macro if item.symbol == "^TNX"]
    assert rate_rows == []
    assert any(
        diagnostic.message_key == "macro.not_published_as_of_session"
        for diagnostic in result.diagnostics
    )
    assert all(
        item.aligned_session_date != date(2024, 1, 30) for item in result.snapshot.macro
    )
    assert result.missing_market_sessions == ()
    assert len(result.snapshot.fingerprint) == 64
    assert (
        result.snapshot.fingerprint
        == adapter.load(_request(calendar)).snapshot.fingerprint
    )


def test_fixture_adapter_diagnoses_bars_outside_the_exchange_calendar() -> None:
    fixture = load_fixture("task4_core")
    calendar = _calendar(
        date(2024, 1, 30),
        date(2024, 1, 31),
        date(2024, 2, 2),
    )

    result = FixtureMarketDataAdapter(bundle=fixture).load(
        _request(
            calendar,
            start=date(2024, 1, 30),
            end=date(2024, 2, 2),
            prewarm_start=None,
        )
    )

    assert result.snapshot is not None
    assert date(2024, 2, 1) not in {bar.date for bar in result.snapshot.market.bars}
    assert any(
        diagnostic.message_key == "market.observation_outside_calendar"
        and diagnostic.as_of == date(2024, 2, 1)
        for diagnostic in result.diagnostics
    )
    assert result.missing_market_sessions == ()


def test_yahoo_market_and_macro_results_compose_into_provider_neutral_snapshot() -> (
    None
):
    sessions = (date(2024, 1, 30), date(2024, 1, 31))
    calendar = _calendar(*sessions)
    market_ticker = _Ticker(
        _Frame(
            ["Close", "Adj Close"],
            [
                (datetime(2024, 1, 30, 21, tzinfo=UTC), {"Close": 10, "Adj Close": 9}),
                (datetime(2024, 1, 31, 21, tzinfo=UTC), {"Close": 11, "Adj Close": 10}),
            ],
        )
    )
    macro_ticker = _Ticker(
        _Frame(
            ["Close"],
            [(datetime(2024, 1, 30, 20, tzinfo=UTC), {"Close": 25})],
        )
    )
    adapter = YahooFinanceAdapter(
        ticker_factory=lambda symbol: {
            "QQQ": market_ticker,
            "^VIX": macro_ticker,
        }[symbol],
        data_version="yfinance-test-1.7.0",
    )
    market_request = _request(
        calendar,
        start=date(2024, 1, 31),
        end=date(2024, 1, 31),
        prewarm_start=date(2024, 1, 30),
    )

    market_result = adapter.load(market_request)
    macro_result = adapter.load_macro(
        market_request.model_copy(update={"symbol": "^VIX"}),
        series_type="index",
    )

    assert market_result.snapshot is not None
    assert macro_result.observations
    snapshot = compose_data_snapshot(market_result, (macro_result,))

    assert snapshot.market.symbol == "QQQ"
    assert snapshot.macro[0].symbol == "^VIX"
    assert snapshot.macro[0].aligned_session_date == date(2024, 1, 31)
    assert (
        snapshot.fingerprint
        == compose_data_snapshot(market_result, (macro_result,)).fingerprint
    )


def test_composition_rejects_conflicting_fixture_and_yahoo_macro_values() -> None:
    fixture = load_fixture("task4_core")
    calendar = _calendar(*fixture.exchange_dates)
    request = _request(
        calendar,
        start=date(2024, 1, 31),
        end=date(2024, 1, 31),
        prewarm_start=date(2024, 1, 30),
    )
    fixture_result = FixtureMarketDataAdapter(bundle=fixture).load(request)
    yahoo_result = _yahoo_adapter(
        _Ticker(
            _Frame(
                ["Close"],
                [(datetime(2024, 1, 30, 20, tzinfo=UTC), {"Close": 25})],
            )
        )
    ).load_macro(
        request.model_copy(update={"symbol": "^VIX"}),
        series_type="index",
    )

    assert fixture_result.snapshot is not None
    assert yahoo_result.observations[0].aligned_session_date == date(2024, 1, 31)
    with pytest.raises(ValueError, match="conflicting macro observations"):
        compose_data_snapshot(fixture_result, (yahoo_result,))


def test_fixture_adapter_reports_missing_sessions_without_filling_or_dropping() -> None:
    fixture = load_fixture("task4_core")
    market = fixture.snapshot.market.model_copy(
        update={
            "bars": tuple(
                bar
                for bar in fixture.snapshot.market.bars
                if bar.date != date(2024, 1, 31)
            )
        }
    )
    snapshot = fixture.snapshot.model_copy(update={"market": market})
    sparse_fixture: FixtureBundle = fixture.model_copy(update={"snapshot": snapshot})
    calendar = _calendar(*fixture.exchange_dates)

    result = FixtureMarketDataAdapter(bundle=sparse_fixture).load(
        _request(
            calendar,
            start=date(2024, 1, 30),
            end=date(2024, 2, 2),
            prewarm_start=None,
        )
    )

    assert result.snapshot is not None
    assert date(2024, 1, 31) in result.missing_market_sessions
    assert date(2024, 1, 31) not in {bar.date for bar in result.snapshot.market.bars}
    assert any(
        diagnostic.code is DiagnosticCode.REQUIRED_DATA_UNAVAILABLE
        for diagnostic in result.diagnostics
    )


def test_macro_as_of_alignment_preserves_source_dates_and_publication_metadata() -> (
    None
):
    observation = MacroObservation(
        date=date(2024, 1, 30),
        symbol="^VIX",
        value=Decimal("25.1"),
        unit="index_points",
        source="fixture:test",
        observedAt=datetime(2024, 1, 30, 20, tzinfo=UTC),
        publishedAt=datetime(2024, 2, 1, 12, tzinfo=UTC),
    )
    calendar = _calendar(
        date(2024, 1, 30),
        date(2024, 1, 31),
        date(2024, 2, 1),
        date(2024, 2, 2),
    )

    aligned = align_macro_observations(
        (observation,),
        exchange_calendar=calendar,
        target_sessions=calendar.trading_dates,
        max_staleness_sessions=3,
    )

    assert tuple(item.aligned_session_date for item in aligned.observations) == (
        date(2024, 2, 2),
    )
    assert all(item.date == date(2024, 1, 30) for item in aligned.observations)
    assert all(
        item.published_at == datetime(2024, 2, 1, 12, tzinfo=UTC)
        for item in aligned.observations
    )


@pytest.mark.parametrize("publication_hour", [13, 23])
def test_macro_published_on_session_date_waits_until_next_session(
    publication_hour: int,
) -> None:
    sessions = (
        date(2024, 1, 31),
        date(2024, 2, 1),
        date(2024, 2, 2),
    )
    calendar = _calendar(*sessions)
    observation = MacroObservation(
        date=sessions[0],
        symbol="^VIX",
        value=Decimal("25"),
        unit="index_points",
        source="fixture:test",
        observedAt=datetime(2024, 1, 31, 21, tzinfo=UTC),
        publishedAt=datetime(2024, 1, 31, publication_hour, tzinfo=UTC),
    )

    aligned = align_macro_observations(
        (observation,),
        exchange_calendar=calendar,
        target_sessions=sessions,
        max_staleness_sessions=3,
    )

    assert tuple(item.aligned_session_date for item in aligned.observations) == (
        date(2024, 2, 1),
        date(2024, 2, 2),
    )


def test_macro_alignment_uses_prior_observation_until_later_value_is_available() -> (
    None
):
    sessions = (
        date(2024, 1, 30),
        date(2024, 1, 31),
        date(2024, 2, 1),
        date(2024, 2, 2),
        date(2024, 2, 5),
    )
    calendar = _calendar(*sessions)
    observations = (
        MacroObservation(
            date=sessions[0],
            symbol="^VIX",
            value=Decimal("20"),
            unit="index_points",
            source="fixture:test",
            observedAt=datetime(2024, 1, 30, 20, tzinfo=UTC),
        ),
        MacroObservation(
            date=sessions[1],
            symbol="^VIX",
            value=Decimal("25"),
            unit="index_points",
            source="fixture:test",
            observedAt=datetime(2024, 1, 31, 20, tzinfo=UTC),
            publishedAt=datetime(2024, 2, 2, 23, tzinfo=UTC),
        ),
    )

    aligned = align_macro_observations(
        observations,
        exchange_calendar=calendar,
        target_sessions=sessions,
        max_staleness_sessions=3,
    )

    assert tuple(
        (item.aligned_session_date, item.value) for item in aligned.observations
    ) == (
        (date(2024, 1, 31), Decimal("20")),
        (date(2024, 2, 1), Decimal("20")),
        (date(2024, 2, 2), Decimal("20")),
        (date(2024, 2, 5), Decimal("25")),
    )


def test_macro_staleness_uses_exchange_sessions_and_stops_at_configured_limit() -> None:
    sessions = (
        date(2024, 1, 30),
        date(2024, 1, 31),
        date(2024, 2, 1),
        date(2024, 2, 2),
        date(2024, 2, 5),
    )
    calendar = _calendar(*sessions)
    observation = MacroObservation(
        date=sessions[0],
        symbol="^VIX",
        value=Decimal("25"),
        unit="index_points",
        source="fixture:test",
        observedAt=datetime(2024, 1, 30, 20, tzinfo=UTC),
    )

    aligned = align_macro_observations(
        (observation,),
        exchange_calendar=calendar,
        target_sessions=sessions,
        max_staleness_sessions=3,
    )

    assert (
        tuple(item.aligned_session_date for item in aligned.observations)
        == sessions[1:4]
    )
    assert any(
        diagnostic.code is DiagnosticCode.STALE_DATA
        for diagnostic in aligned.diagnostics
    )


def test_rates_are_converted_only_from_explicit_source_units() -> None:
    assert normalize_rate_value(Decimal("0.025"), "decimal") == Decimal("2.500")
    assert normalize_rate_value(Decimal("250"), "basis_points") == Decimal("2.5")
    assert normalize_rate_value(Decimal("2.5"), "percent_point") == Decimal("2.5")
    assert normalize_rate_value(Decimal("2.5"), "auto") is None


def test_yahoo_market_adapter_uses_explicit_price_bases_and_inclusive_range() -> None:
    dates = (
        date(2024, 1, 30),
        date(2024, 1, 31),
        date(2024, 2, 1),
        date(2024, 2, 2),
    )
    calendar = _calendar(*dates)
    rows = [
        (datetime(2024, 1, 30, 21, tzinfo=UTC), {"Close": 395, "Adj Close": 394}),
        (datetime(2024, 1, 31, 21, tzinfo=UTC), {"Close": 400, "Adj Close": 200}),
        (datetime(2024, 2, 1, 21, tzinfo=UTC), {"Close": 404, "Adj Close": 202}),
        # An unexpected provider row must be diagnosed, not used as a trade date.
        (datetime(2024, 2, 3, 21, tzinfo=UTC), {"Close": 410, "Adj Close": 205}),
    ]
    ticker = _Ticker(_Frame(["Close", "Adj Close"], rows), metadata={"currency": "USD"})

    result = _yahoo_adapter(ticker).load(
        _request(
            calendar,
            start=date(2024, 1, 31),
            end=date(2024, 2, 3),
            prewarm_start=date(2024, 1, 30),
        )
    )

    assert ticker.history_kwargs is not None
    assert ticker.history_kwargs["start"] == "2024-01-30"
    assert ticker.history_kwargs["end"] == "2024-02-04"
    assert ticker.history_kwargs["auto_adjust"] is False
    assert ticker.history_kwargs["back_adjust"] is False
    assert ticker.history_kwargs["rounding"] is False
    assert ticker.history_kwargs["keepna"] is True
    assert ticker.history_kwargs["actions"] is False
    assert ticker.history_kwargs["repair"] is False
    assert ticker.history_kwargs["raise_errors"] is True
    assert result.snapshot is not None
    bars = {bar.date: bar for bar in result.snapshot.market.bars}
    assert bars[date(2024, 1, 31)].simulation_price == Decimal("200")
    assert bars[date(2024, 1, 31)].valuation_price == Decimal("400")
    assert bars[date(2024, 1, 31)].simulation_open is None
    assert bars[date(2024, 1, 31)].currency == "USD"
    assert bars[date(2024, 1, 31)].source == "yahoo"
    assert "Adj Close" not in result.snapshot.model_dump_json()
    assert date(2024, 2, 3) not in bars
    assert any(
        diagnostic.message_key == "market.observation_outside_calendar"
        for diagnostic in result.diagnostics
    )
    assert date(2024, 2, 2) in result.missing_market_sessions


@pytest.mark.parametrize(
    "first_trade",
    [
        datetime(2024, 1, 31, 9, 30, tzinfo=ZoneInfo("America/New_York")),
        int(
            datetime(
                2024, 1, 31, 9, 30, tzinfo=ZoneInfo("America/New_York")
            ).timestamp()
        ),
    ],
)
def test_yahoo_normalizes_verified_listing_date(first_trade: object) -> None:
    ticker = _Ticker(
        _Frame(
            ["Close", "Adj Close"],
            [
                (
                    datetime(2024, 1, 31, 21, tzinfo=UTC),
                    {"Close": 100, "Adj Close": 100},
                ),
                (
                    datetime(2024, 2, 1, 21, tzinfo=UTC),
                    {"Close": 101, "Adj Close": 101},
                ),
            ],
        ),
        metadata={
            "firstTradeDate": first_trade,
            "exchangeTimezoneName": "America/New_York",
        },
    )
    result = _yahoo_adapter(ticker).load(
        _request(
            _calendar(date(2024, 1, 30), date(2024, 1, 31), date(2024, 2, 1)),
            end=date(2024, 2, 1),
        )
    )
    assert result.available_from == date(2024, 1, 31)
    assert result.snapshot is not None
    # The adapter reports missing sessions; the run layer applies the verified range.
    assert result.missing_market_sessions == (date(2024, 1, 30),)


@pytest.mark.parametrize(
    "metadata",
    [
        {},
        {"firstTradeDate": datetime(2024, 1, 31, 9, 30)},
        {"firstTradeDate": "2024-01-31"},
        {"firstTradeDate": True},
        {"firstTradeDate": 1706707800},
        {"firstTradeDate": 1706707800, "exchangeTimezoneName": "bad/timezone"},
    ],
)
def test_yahoo_never_infers_listing_date_from_incomplete_metadata(metadata) -> None:
    ticker = _Ticker(
        _Frame(
            ["Close", "Adj Close"],
            [
                (
                    datetime(2024, 1, 31, 21, tzinfo=UTC),
                    {"Close": 100, "Adj Close": 100},
                ),
            ],
        ),
        metadata=metadata,
    )
    result = _yahoo_adapter(ticker).load(
        _request(
            _calendar(date(2024, 1, 30), date(2024, 1, 31)),
            end=date(2024, 1, 31),
        )
    )
    assert result.available_from is None
    assert result.missing_market_sessions == (date(2024, 1, 30),)


def test_yahoo_known_pre_listing_range_never_requests_nonexistent_history() -> None:
    ticker = _Ticker(
        _Frame(["Close", "Adj Close"], []),
        metadata={"firstTradeDate": datetime(2024, 1, 31, 14, 30, tzinfo=UTC)},
        history_error=RuntimeError("history must not be requested before listing"),
    )
    result = _yahoo_adapter(ticker).load(
        _request(
            _calendar(date(2024, 1, 29), date(2024, 1, 30)),
            start=date(2024, 1, 29),
            end=date(2024, 1, 30),
            prewarm_start=None,
        )
    )
    assert result.snapshot is None
    assert result.available_from == date(2024, 1, 31)
    assert result.diagnostics[0].message_key == "market.period_before_listing"
    assert result.diagnostics[0].code is DiagnosticCode.REQUIRED_DATA_UNAVAILABLE
    assert ticker.history_kwargs is None


def test_yahoo_does_not_trust_listing_metadata_that_contradicts_real_bars() -> None:
    ticker = _Ticker(
        _Frame(
            ["Close", "Adj Close"],
            [
                (
                    datetime(2024, 1, 30, 21, tzinfo=UTC),
                    {"Close": 100, "Adj Close": 100},
                ),
                (
                    datetime(2024, 1, 31, 21, tzinfo=UTC),
                    {"Close": 101, "Adj Close": 101},
                ),
            ],
        ),
        metadata={"firstTradeDate": datetime(2024, 1, 31, 14, 30, tzinfo=UTC)},
    )
    result = _yahoo_adapter(ticker).load(
        _request(
            _calendar(date(2024, 1, 30), date(2024, 1, 31)),
            end=date(2024, 1, 31),
        )
    )
    assert result.available_from is None
    assert result.snapshot is not None
    assert len(result.snapshot.market.bars) == 2


def test_yahoo_market_adapter_normalizes_ohlc_to_the_simulation_price_basis() -> None:
    session = date(2024, 1, 31)
    ticker = _Ticker(
        _Frame(
            ["Open", "High", "Low", "Close", "Adj Close"],
            [
                (
                    datetime(2024, 1, 31, 21, tzinfo=UTC),
                    {
                        "Open": 390,
                        "High": 410,
                        "Low": 380,
                        "Close": 400,
                        "Adj Close": 200,
                    },
                )
            ],
        ),
        metadata={"currency": "USD"},
    )

    result = _yahoo_adapter(ticker).load(
        _request(_calendar(session), start=session, end=session, prewarm_start=None)
    )

    assert result.snapshot is not None
    bar = result.snapshot.market.bars[0]
    assert bar.simulation_open == Decimal("195.0")
    assert bar.simulation_high == Decimal("205.0")
    assert bar.simulation_low == Decimal("190.0")
    assert bar.simulation_price == Decimal("200")


def test_yahoo_adapter_refuses_missing_or_ambiguous_price_basis() -> None:
    calendar = _calendar(date(2024, 1, 30), date(2024, 1, 31))
    missing_adjusted = _Ticker(
        _Frame(["Close"], [(datetime(2024, 1, 30, tzinfo=UTC), {"Close": 10})])
    )

    result = _yahoo_adapter(missing_adjusted).load(
        _request(
            calendar,
            start=date(2024, 1, 30),
            end=date(2024, 1, 31),
            prewarm_start=None,
        )
    )

    assert result.snapshot is None
    assert any(
        diagnostic.code is DiagnosticCode.PRICE_BASIS_UNAVAILABLE
        for diagnostic in result.diagnostics
    )


def test_yahoo_adapter_rejects_timezone_naive_observation_timestamps() -> None:
    calendar = _calendar(date(2024, 1, 30), date(2024, 1, 31))
    ticker = _Ticker(
        _Frame(
            ["Close", "Adj Close"],
            [(datetime(2024, 1, 30, 20), {"Close": 10, "Adj Close": 9})],
        )
    )

    result = _yahoo_adapter(ticker).load(
        _request(
            calendar,
            start=date(2024, 1, 30),
            end=date(2024, 1, 31),
            prewarm_start=None,
        )
    )

    assert result.snapshot is None
    assert any(
        diagnostic.message_key == "market.observation_timestamp_unavailable"
        for diagnostic in result.diagnostics
    )


def test_yahoo_adapter_rejects_price_columns_for_another_symbol() -> None:
    calendar = _calendar(date(2024, 1, 30), date(2024, 1, 31))
    columns = [("Close", "SPY"), ("Adj Close", "SPY")]
    ticker = _Ticker(
        _Frame(
            columns,
            [
                (
                    datetime(2024, 1, 30, tzinfo=UTC),
                    {("Close", "SPY"): 10, ("Adj Close", "SPY"): 9},
                )
            ],
        )
    )

    result = _yahoo_adapter(ticker).load(
        _request(
            calendar,
            start=date(2024, 1, 30),
            end=date(2024, 1, 31),
            prewarm_start=None,
        )
    )

    assert result.snapshot is None
    assert any(
        diagnostic.code is DiagnosticCode.PRICE_BASIS_UNAVAILABLE
        for diagnostic in result.diagnostics
    )


def test_yahoo_adapter_reports_non_positive_price_values_as_unavailable() -> None:
    calendar = _calendar(date(2024, 1, 30), date(2024, 1, 31))
    ticker = _Ticker(
        _Frame(
            ["Close", "Adj Close"],
            [
                (
                    datetime(2024, 1, 30, tzinfo=UTC),
                    {"Close": 0, "Adj Close": 9},
                )
            ],
        )
    )

    result = _yahoo_adapter(ticker).load(
        _request(
            calendar,
            start=date(2024, 1, 30),
            end=date(2024, 1, 31),
            prewarm_start=None,
        )
    )

    assert result.snapshot is None
    assert any(
        diagnostic.message_key == "market.price_basis_unavailable"
        for diagnostic in result.diagnostics
    )


def test_yahoo_adapter_reports_metadata_property_failures_as_provider_errors() -> None:
    class BrokenMetadataTicker:
        history_metadata: dict[str, object] = {}

        def __init__(self) -> None:
            self.history_kwargs: dict[str, object] | None = None

        @property
        def fast_info(self) -> object:
            raise RuntimeError("metadata request failed")

        def history(self, **kwargs: object) -> _Frame:
            self.history_kwargs = kwargs
            return _Frame(
                ["Close", "Adj Close"],
                [
                    (
                        datetime(2024, 1, 30, 21, tzinfo=UTC),
                        {"Close": 10, "Adj Close": 9},
                    )
                ],
            )

    calendar = _calendar(date(2024, 1, 30), date(2024, 1, 31))
    ticker = BrokenMetadataTicker()

    result = _yahoo_adapter(ticker).load(
        _request(
            calendar,
            start=date(2024, 1, 30),
            end=date(2024, 1, 31),
            prewarm_start=None,
        )
    )

    assert result.snapshot is None
    assert any(
        diagnostic.code is DiagnosticCode.PROVIDER_REQUEST_FAILED
        for diagnostic in result.diagnostics
    )


def test_yahoo_adapter_never_assumes_usd_when_quote_currency_is_missing() -> None:
    calendar = _calendar(date(2024, 1, 30), date(2024, 1, 31))
    ticker = _Ticker(
        _Frame(
            ["Close", "Adj Close"],
            [(datetime(2024, 1, 30, tzinfo=UTC), {"Close": 10, "Adj Close": 9})],
        ),
        currency=None,
    )

    result = _yahoo_adapter(ticker).load(
        _request(
            calendar,
            start=date(2024, 1, 30),
            end=date(2024, 1, 31),
            prewarm_start=None,
        )
    )

    assert result.snapshot is None
    assert any(
        diagnostic.message_key == "market.quote_currency_unavailable"
        for diagnostic in result.diagnostics
    )


def test_yahoo_macro_fetches_and_aligns_the_configured_staleness_window() -> None:
    sessions = (
        date(2024, 1, 29),
        date(2024, 1, 30),
        date(2024, 1, 31),
        date(2024, 2, 1),
        date(2024, 2, 2),
    )
    calendar = _calendar(*sessions)
    ticker = _Ticker(
        _Frame(
            ["Close"],
            [(datetime(2024, 1, 31, 21, tzinfo=UTC), {"Close": 17.5})],
        )
    )
    request = _request(
        calendar,
        start=date(2024, 2, 2),
        end=date(2024, 2, 2),
        prewarm_start=None,
        max_staleness=3,
    )

    result = _yahoo_adapter(ticker).load_macro(
        request, series_type="index", source_unit="auto"
    )

    assert ticker.history_kwargs is not None
    assert ticker.history_kwargs["start"] == "2024-01-30"
    assert result.cache_key.start_date == date(2024, 1, 30)
    assert tuple(
        (item.date, item.aligned_session_date, item.value)
        for item in result.observations
    ) == ((date(2024, 1, 31), date(2024, 2, 2), Decimal("17.5")),)


def test_yahoo_adapter_rejects_conflicting_explicit_currency_metadata() -> None:
    calendar = _calendar(date(2024, 1, 30), date(2024, 1, 31))
    ticker = _Ticker(
        _Frame(
            ["Close", "Adj Close"],
            [(datetime(2024, 1, 30, tzinfo=UTC), {"Close": 10, "Adj Close": 9})],
        ),
        currency="USD",
        metadata={"currency": "JPY"},
    )

    result = _yahoo_adapter(ticker).load(
        _request(
            calendar,
            start=date(2024, 1, 30),
            end=date(2024, 1, 31),
            prewarm_start=None,
        )
    )

    assert result.snapshot is None
    assert any(
        diagnostic.message_key == "market.quote_currency_conflict"
        for diagnostic in result.diagnostics
    )


def test_yahoo_macro_reports_unit_metadata_failure_as_provider_error() -> None:
    class BrokenUnitMetadataTicker:
        fast_info = {"currency": "USD"}

        @property
        def history_metadata(self) -> object:
            raise RuntimeError("metadata request failed")

        def history(self, **_kwargs: object) -> _Frame:
            return _Frame(
                ["Close"],
                [(datetime(2024, 1, 30, 20, tzinfo=UTC), {"Close": 2.5})],
            )

    calendar = _calendar(date(2024, 1, 30), date(2024, 1, 31))
    result = _yahoo_adapter(BrokenUnitMetadataTicker()).load_macro(
        _request(
            calendar,
            start=date(2024, 1, 30),
            end=date(2024, 1, 31),
            prewarm_start=None,
        ),
        series_type="rate",
        source_unit="auto",
    )

    assert result.observations == ()
    assert any(
        diagnostic.code is DiagnosticCode.PROVIDER_REQUEST_FAILED
        for diagnostic in result.diagnostics
    )


def test_yahoo_rate_unit_auto_does_not_infer_from_ticker_symbol() -> None:
    calendar = _calendar(date(2024, 1, 30), date(2024, 1, 31))
    ticker = _Ticker(
        _Frame(
            ["Close"],
            [(datetime(2024, 1, 30, 20, tzinfo=UTC), {"Close": 4.2})],
        ),
        metadata={"currency": "USD"},
    )
    adapter = _yahoo_adapter(ticker)

    result = adapter.load_macro(
        _request(
            calendar,
            start=date(2024, 1, 30),
            end=date(2024, 1, 31),
            prewarm_start=None,
        ),
        series_type="rate",
        source_unit="auto",
    )

    assert result.observations == ()
    assert any(
        diagnostic.code is DiagnosticCode.UNKNOWN_SOURCE_UNIT
        and diagnostic.field_path == "rate.sourceUnit"
        for diagnostic in result.diagnostics
    )


def test_unknown_rate_unit_has_one_actionable_diagnostic_not_one_per_date() -> None:
    days = tuple(date(2024, 1, day) for day in (29, 30, 31))
    ticker = _Ticker(
        _Frame(
            ["Close"],
            [
                (datetime(2024, 1, day.day, 20, tzinfo=UTC), {"Close": 4.2})
                for day in days
            ],
        ),
        metadata={"currency": "USD"},
    )
    result = _yahoo_adapter(ticker).load_macro(
        _request(_calendar(*days), start=days[0], end=days[-1], prewarm_start=None),
        series_type="rate",
        source_unit="auto",
    )
    assert result.observations == ()
    assert len(result.diagnostics) == 1
    assert result.diagnostics[0].code is DiagnosticCode.UNKNOWN_SOURCE_UNIT
    assert result.diagnostics[0].field_path == "rate.sourceUnit"


def test_yahoo_rate_explicit_basis_points_are_normalized_and_aligned() -> None:
    calendar = _calendar(date(2024, 1, 30), date(2024, 1, 31))
    ticker = _Ticker(
        _Frame(
            ["Close"],
            [(datetime(2024, 1, 30, 20, tzinfo=UTC), {"Close": 250})],
        ),
    )

    result = _yahoo_adapter(ticker).load_macro(
        _request(
            calendar,
            start=date(2024, 1, 30),
            end=date(2024, 1, 31),
            prewarm_start=None,
        ),
        series_type="rate",
        source_unit="basis_points",
    )

    assert result.observations
    assert result.observations[0].value == Decimal("2.5")
    assert result.observations[0].unit == "percent_point"
    assert result.observations[0].source_unit == "basis_points"
    assert result.observations[0].aligned_session_date == date(2024, 1, 31)


@pytest.mark.parametrize(
    "field, value",
    [
        ("provider", "fixture"),
        ("symbol", "SPY"),
        ("frequency", "1wk"),
        ("start_date", date(2024, 1, 31)),
        ("end_date", date(2024, 2, 3)),
        ("data_version", "fixture-2"),
        ("price_basis", "other-basis"),
    ],
)
def test_cache_identity_includes_each_required_data_dimension(
    field: str, value: object
) -> None:
    key = DataCacheKey(
        provider="yahoo",
        symbol="QQQ",
        frequency="1d",
        startDate=date(2024, 1, 30),
        endDate=date(2024, 2, 2),
        dataVersion="fixture-1",
        priceBasis="fixture-dual-price",
    )

    assert key.fingerprint != key.model_copy(update={field: value}).fingerprint


def test_cached_market_provider_reuses_normalized_result() -> None:
    fixture = load_fixture("task4_core")
    snapshot = fixture.snapshot.model_copy(
        update={
            "macro": tuple(
                item for item in fixture.snapshot.macro if item.symbol == "^VIX"
            )
        }
    )
    fixture = fixture.model_copy(update={"snapshot": snapshot})
    calendar = _calendar(*fixture.exchange_dates)
    delegate = FixtureMarketDataAdapter(bundle=fixture)

    class CountingProvider:
        def __init__(self) -> None:
            self.load_count = 0

        def cache_identity(self, request: MarketDataRequest) -> DataCacheKey:
            return delegate.cache_identity(request)

        def load(self, request: MarketDataRequest):
            self.load_count += 1
            return delegate.load(request)

    provider = CountingProvider()
    cached = CachedMarketDataProvider(provider, InMemoryDataCache())
    request = _request(
        calendar,
        start=date(2024, 1, 31),
        end=date(2024, 1, 31),
        prewarm_start=None,
    )

    first = cached.load(request)
    second = cached.load(request)

    assert first.snapshot is not None
    assert second.snapshot is not None
    assert first.snapshot.fingerprint == second.snapshot.fingerprint
    assert first.cache_key == second.cache_key
    assert provider.load_count == 1

    refreshed = cached.load(request, refresh=True)

    assert refreshed.snapshot is not None
    assert provider.load_count == 2


def test_cached_market_provider_logs_miss_hit_and_refresh_without_data(caplog) -> None:
    caplog.set_level("INFO")
    fixture = load_fixture("task4_core")
    snapshot = fixture.snapshot.model_copy(
        update={
            "macro": tuple(
                item for item in fixture.snapshot.macro if item.symbol == "^VIX"
            )
        }
    )
    fixture = fixture.model_copy(update={"snapshot": snapshot})
    calendar = _calendar(*fixture.exchange_dates)
    delegate = FixtureMarketDataAdapter(bundle=fixture)
    cached = CachedMarketDataProvider(delegate, InMemoryDataCache())
    request = _request(
        calendar,
        start=date(2024, 1, 31),
        end=date(2024, 1, 31),
        prewarm_start=None,
    )

    cached.load(request)
    cached.load(request)
    cached.load(request, refresh=True)

    events = [
        record.cache_event for record in caplog.records if record.name.endswith("cache")
    ]
    assert events == ["miss", "hit", "refresh"]
    assert all(
        record.provider == "fixture"
        for record in caplog.records
        if record.name.endswith("cache")
    )
    assert "fingerprint" not in caplog.text


def test_in_memory_data_cache_evicts_least_recently_used_entry() -> None:
    cache = InMemoryDataCache(max_entries=2)
    keys = tuple(
        DataCacheKey(
            provider="yahoo",
            symbol=f"^VIX{index}",
            frequency="1d",
            startDate=date(2024, 1, 30),
            endDate=date(2024, 1, 31),
            dataVersion="test-v1",
            priceBasis="macro-index-index_points",
        )
        for index in range(3)
    )
    results = tuple(
        MacroDataResult(
            symbol=key.symbol,
            fingerprint=f"fingerprint-{index}",
            cacheKey=key,
        )
        for index, key in enumerate(keys)
    )

    cache.put(keys[0], results[0])
    cache.put(keys[1], results[1])
    assert cache.get(keys[0]) == results[0]
    cache.put(keys[2], results[2])

    assert cache.get(keys[0]) == results[0]
    assert cache.get(keys[1]) is None
    assert cache.get(keys[2]) == results[2]


def test_cached_auto_rate_reloads_when_provider_unit_metadata_changes() -> None:
    sessions = (date(2024, 1, 30), date(2024, 1, 31))
    calendar = _calendar(*sessions)
    frame = _Frame(
        ["Close"],
        [(datetime(2024, 1, 30, 21, tzinfo=UTC), {"Close": 0.025})],
    )
    units = iter(("decimal", "percent_point"))
    adapter = YahooFinanceAdapter(
        ticker_factory=lambda _symbol: _Ticker(
            frame,
            metadata={"unit": next(units)},
        ),
        data_version="yfinance-test-1.7.0",
    )
    cached = CachedMacroDataProvider(adapter, InMemoryDataCache())
    request = _request(
        calendar,
        start=date(2024, 1, 31),
        end=date(2024, 1, 31),
        prewarm_start=None,
    )

    first = cached.load(request, series_type="rate", source_unit="auto")
    second = cached.load(request, series_type="rate", source_unit="auto")

    assert first.observations[0].value == Decimal("2.500")
    assert second.observations[0].value == Decimal("0.025")


def test_cached_macro_provider_reuses_normalized_observations() -> None:
    calendar = _calendar(date(2024, 1, 30), date(2024, 1, 31))
    ticker = _Ticker(
        _Frame(
            ["Close"],
            [(datetime(2024, 1, 30, 21, tzinfo=UTC), {"Close": 20})],
        )
    )
    delegate = _yahoo_adapter(ticker)

    class CountingProvider:
        def __init__(self) -> None:
            self.load_count = 0

        def macro_cache_identity(
            self,
            request: MarketDataRequest,
            *,
            series_type: str,
            source_unit: str,
        ) -> DataCacheKey:
            return delegate.macro_cache_identity(
                request, series_type=series_type, source_unit=source_unit
            )

        def load_macro(
            self,
            request: MarketDataRequest,
            *,
            series_type: str,
            source_unit: str,
        ):
            self.load_count += 1
            return delegate.load_macro(
                request, series_type=series_type, source_unit=source_unit
            )

    provider = CountingProvider()
    cached = CachedMacroDataProvider(provider, InMemoryDataCache())
    request = _request(
        calendar,
        start=date(2024, 1, 31),
        end=date(2024, 1, 31),
        prewarm_start=None,
    )

    first = cached.load(request, series_type="index")
    second = cached.load(request, series_type="index")

    assert first.observations
    assert first.fingerprint == second.fingerprint
    assert first.cache_key == second.cache_key
    assert provider.load_count == 1

    refreshed = cached.load(request, series_type="index", refresh=True)

    assert refreshed.observations
    assert provider.load_count == 2


def test_market_request_rejects_non_daily_frequency() -> None:
    calendar = _calendar(date(2024, 1, 30), date(2024, 1, 31))

    with pytest.raises(ValidationError, match="daily frequency"):
        _request(calendar, frequency="1wk")


def test_market_request_rejects_prewarm_after_backtest_start() -> None:
    calendar = _calendar(date(2024, 1, 30), date(2024, 1, 31))

    with pytest.raises(ValueError, match="prewarmStartDate"):
        _request(
            calendar,
            start=date(2024, 1, 30),
            end=date(2024, 1, 31),
            prewarm_start=date(2024, 1, 31),
        )


@pytest.mark.parametrize("currency", ["USD", "JPY"])
def test_quote_currency_uses_real_adapter_metadata_without_requiring_price_history(
    currency,
):
    ticker = _Ticker(_Frame([], []), currency=currency, metadata={"currency": currency})
    adapter = YahooFinanceAdapter(ticker_factory=lambda _symbol: ticker)
    resolved, diagnostic = adapter.quote_currency("instrument")
    assert resolved == currency
    assert diagnostic is None


def test_quote_currency_never_invents_a_currency_for_missing_or_conflicting_metadata():
    for currency, metadata in ((None, {}), ("USD", {"currency": "JPY"})):
        ticker = _Ticker(_Frame([], []), currency=currency, metadata=metadata)
        adapter = YahooFinanceAdapter(
            ticker_factory=lambda _symbol, current=ticker: current
        )
        resolved, diagnostic = adapter.quote_currency("instrument")
        assert resolved is None
        assert diagnostic is not None


def _composition_results():
    calendar = _calendar(date(2024, 1, 30), date(2024, 1, 31), date(2024, 2, 1))
    request = _request(calendar, start=date(2024, 1, 31), end=date(2024, 1, 31))
    ticker = _Ticker(
        _Frame(
            ["Close", "Adj Close"],
            [
                (datetime(2024, 1, 30, 20, tzinfo=UTC), {"Close": 25, "Adj Close": 24}),
                (datetime(2024, 1, 31, 20, tzinfo=UTC), {"Close": 26, "Adj Close": 25}),
            ],
        )
    )
    adapter = _yahoo_adapter(ticker)
    return adapter, request, adapter.load(request)


@pytest.mark.parametrize("change", ["range", "calendar", "frequency", "normalization"])
def test_composition_rejects_macro_from_another_request_context(change):
    adapter, request, market = _composition_results()
    macro_request = request.model_copy(update={"symbol": "^VIX"})
    if change == "range":
        macro_request = macro_request.model_copy(update={"end_date": date(2024, 2, 1)})
    elif change == "calendar":
        macro_request = macro_request.model_copy(
            update={"exchange_calendar": _calendar(date(2024, 1, 30), date(2024, 2, 1))}
        )
    macro = adapter.load_macro(macro_request, series_type="index")
    if change in {"frequency", "normalization"}:
        field = "frequency" if change == "frequency" else "normalization_version"
        macro = macro.model_copy(
            update={
                "cache_key": macro.cache_key.model_copy(update={field: "other-version"})
            }
        )
    with pytest.raises(ValueError, match="context"):
        compose_data_snapshot(market, (macro,))


@pytest.mark.parametrize("aligned", [date(2024, 1, 30), date(2024, 2, 1)])
def test_composition_rejects_macro_outside_target_market_sessions(aligned):
    adapter, request, market = _composition_results()
    macro = adapter.load_macro(
        request.model_copy(update={"symbol": "^VIX"}), series_type="index"
    )
    assert macro.observations
    macro = macro.model_copy(
        update={
            "observations": (
                macro.observations[0].model_copy(
                    update={"aligned_session_date": aligned}
                ),
            )
        }
    )
    with pytest.raises(ValueError, match="session"):
        compose_data_snapshot(market, (macro,))


def test_quote_cache_is_stable_when_calendar_grows_outside_the_requested_window():
    adapter, request, _ = _composition_results()
    extended = request.model_copy(
        update={
            "exchange_calendar": _calendar(
                date(2024, 1, 29),
                date(2024, 1, 30),
                date(2024, 1, 31),
                date(2024, 2, 1),
                date(2024, 2, 2),
            )
        }
    )
    assert adapter.cache_identity(request) == adapter.cache_identity(extended)


def test_macro_staleness_changes_macro_cache_but_does_not_invalidate_quotes():
    adapter, request, _ = _composition_results()
    changed = request.model_copy(update={"macro_staleness_sessions": 2})
    assert adapter.cache_identity(request) == adapter.cache_identity(changed)
    assert adapter.macro_cache_identity(
        request, series_type="index", source_unit="index_points"
    ) != (
        adapter.macro_cache_identity(
            changed, series_type="index", source_unit="index_points"
        )
    )


@pytest.mark.parametrize("macro", [False, True])
@pytest.mark.parametrize("stage", ["columns", "model"])
def test_yahoo_local_normalization_errors_are_not_provider_failures(
    monkeypatch, macro, stage
):
    adapter, request, _ = _composition_results()
    function = (
        "_resolve_column"
        if stage == "columns"
        else ("MacroObservation" if macro else "MarketBar")
    )

    def broken_normalizer(*_args, **_kwargs):
        raise ValueError("local-normalization-bug")

    monkeypatch.setattr(f"app.data.providers.yahoo.{function}", broken_normalizer)
    with pytest.raises(ValueError, match="local-normalization-bug"):
        if macro:
            adapter.load_macro(request, series_type="index")
        else:
            adapter.load(request)


@pytest.mark.parametrize("macro", [False, True])
def test_yahoo_bad_history_response_is_data_unavailable_instead_of_network_failure(
    macro,
):
    ticker = _Ticker(_Frame([], []))
    ticker.frame = object()
    adapter = _yahoo_adapter(ticker)
    request = _request(_calendar(date(2024, 1, 30), date(2024, 1, 31)))
    result = (
        adapter.load_macro(request, series_type="index")
        if macro
        else adapter.load(request)
    )
    assert result.diagnostics[0].code is DiagnosticCode.REQUIRED_DATA_UNAVAILABLE
    assert result.diagnostics[0].message_key == "data.invalid_history_response"


def test_yahoo_macro_network_failure_uses_a_generic_data_message():
    ticker = _Ticker(_Frame(["Close"], []), history_error=RuntimeError("token=private"))
    request = _request(_calendar(date(2024, 1, 30), date(2024, 1, 31)))
    result = _yahoo_adapter(ticker).load_macro(request, series_type="index")
    diagnostic = result.diagnostics[0]
    assert diagnostic.code is DiagnosticCode.PROVIDER_REQUEST_FAILED
    assert diagnostic.message_key == "data.provider_request_failed"
    assert "token=private" not in result.model_dump_json()

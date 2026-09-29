from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.calendar.schedule import ExchangeCalendar
from app.data.cache import (
    CachedMacroDataProvider,
    CachedMarketDataProvider,
    DataCacheKey,
    InMemoryDataCache,
)
from app.data.fixtures import FixtureBundle, load_fixture
from app.data.market_data import (
    FixtureMarketDataAdapter,
    MarketDataRequest,
    align_macro_observations,
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
) -> MarketDataRequest:
    return MarketDataRequest(
        symbol="QQQ",
        startDate=start,
        endDate=end,
        prewarmStartDate=prewarm_start,
        frequency="1d",
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
    ) -> None:
        self.frame = frame
        self.fast_info: dict[str, object] = (
            {} if currency is None else {"currency": currency}
        )
        self.history_metadata = {} if metadata is None else metadata
        self.history_kwargs: dict[str, object] | None = None

    def history(self, **kwargs: object) -> _Frame:
        self.history_kwargs = kwargs
        return self.frame


def _yahoo_adapter(ticker: _Ticker) -> YahooFinanceAdapter:
    return YahooFinanceAdapter(
        ticker_factory=lambda _symbol: ticker,
        data_version="yfinance-test-1.7.0",
    )


def test_market_request_uses_registered_macro_staleness_default() -> None:
    calendar = _calendar(date(2024, 1, 30), date(2024, 1, 31))
    request = MarketDataRequest(
        symbol="QQQ",
        startDate=date(2024, 1, 30),
        endDate=date(2024, 1, 31),
        exchangeCalendar=calendar,
    )

    assert request.macro_staleness_sessions == 3


@pytest.mark.parametrize("value", [-1, True, "3"])
def test_market_request_validates_staleness_from_the_catalog(value: object) -> None:
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
    )
    adjusted = SharedSettings(
        run=settings.run,
        contribution=settings.contribution,
        data={"macroStalenessSessions": 7},
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
    assert [(item.date, item.aligned_session_date) for item in rate_rows] == [
        (date(2024, 2, 1), date(2024, 2, 2))
    ]
    assert rate_rows[0].unit == "percent_point"
    assert rate_rows[0].source_unit == "percent_point"
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
        date(2024, 2, 1),
        date(2024, 2, 2),
    )
    assert all(item.date == date(2024, 1, 30) for item in aligned.observations)
    assert all(
        item.published_at == datetime(2024, 2, 1, 12, tzinfo=UTC)
        for item in aligned.observations
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
        == sessions[:4]
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
    assert bars[date(2024, 1, 31)].currency == "USD"
    assert bars[date(2024, 1, 31)].source == "yahoo"
    assert "Adj Close" not in result.snapshot.model_dump_json()
    assert date(2024, 2, 3) not in bars
    assert any(
        diagnostic.message_key == "market.observation_outside_calendar"
        for diagnostic in result.diagnostics
    )
    assert date(2024, 2, 2) in result.missing_market_sessions


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
    assert result.observations[0].aligned_session_date == date(2024, 1, 30)


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
        start=date(2024, 1, 30),
        end=date(2024, 1, 30),
        prewarm_start=None,
    )

    first = cached.load(request)
    second = cached.load(request)

    assert first.snapshot is not None
    assert second.snapshot is not None
    assert first.snapshot.fingerprint == second.snapshot.fingerprint
    assert first.cache_key == second.cache_key
    assert provider.load_count == 1


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


def test_market_request_rejects_prewarm_after_backtest_start() -> None:
    calendar = _calendar(date(2024, 1, 30), date(2024, 1, 31))

    with pytest.raises(ValueError, match="prewarmStartDate"):
        _request(
            calendar,
            start=date(2024, 1, 30),
            end=date(2024, 1, 31),
            prewarm_start=date(2024, 1, 31),
        )

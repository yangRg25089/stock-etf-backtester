from datetime import UTC, date, datetime
from decimal import Decimal

import pytest

from app.calendar import ExchangeCalendar, schedule
from app.config.validation import validate_draft
from app.domain.contracts import (
    DataSnapshot,
    FrozenRunConfig,
    MarketBar,
    MarketSnapshot,
    SignalEvaluation,
    TradeReason,
)
from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    DiagnosticSeverity,
    SignalState,
)
from app.ledger.engine import run_strategy
from app.signals.evaluate import StrategySignalSeries, evaluate_signals


def _config(
    *,
    start: date,
    end: date,
    preset: str = "vix_dca",
    params: dict[str, object] | None = None,
    contribution_day: int = 1,
    contribution_amount: str = "100",
    strategy_id: str = "strategy-1",
) -> FrozenRunConfig:
    result = validate_draft(
        {
            "shared": {
                "run": {
                    "symbol": "QQQ",
                    "startDate": start,
                    "endDate": end,
                    "endMode": "fixed",
                },
                "contribution": {
                    "day": contribution_day,
                    "amount": Decimal(contribution_amount),
                },
            },
            "strategies": [
                {
                    "id": strategy_id,
                    "presetId": preset,
                    "enabled": True,
                    "params": {} if params is None else params,
                }
            ],
        }
    )
    assert result.diagnostics_for() == ()
    config = result.config_for((strategy_id,))
    assert config is not None
    return config


def _calendar(
    dates: tuple[date, ...], *, coverage_end: date | None = None
) -> ExchangeCalendar:
    return ExchangeCalendar.from_dates(
        dates,
        as_of_date=dates[-1],
        latest_complete_date=dates[-1],
        calendar_coverage_end_date=coverage_end,
    )


def _snapshot(
    dates: tuple[date, ...],
    prices: tuple[str, ...],
    valuation_prices: tuple[str, ...] | None = None,
) -> DataSnapshot:
    if valuation_prices is None:
        valuation_prices = prices
    bars = tuple(
        MarketBar(
            date=day,
            symbol="QQQ",
            simulationPrice=Decimal(price),
            valuationPrice=Decimal(valuation_price),
            currency="USD",
            source="fixture",
            observedAt=datetime.combine(day, datetime.min.time(), UTC),
        )
        for day, price, valuation_price in zip(
            dates, prices, valuation_prices, strict=True
        )
    )
    return DataSnapshot(
        market=MarketSnapshot(
            symbol="QQQ",
            currency="USD",
            bars=bars,
            source="fixture",
            fingerprint="market-fixture",
        ),
        fingerprint="snapshot-fixture",
    )


def _signals(
    config: FrozenRunConfig,
    dates: tuple[date, ...],
    triggered: dict[date, dict[str, bool]] | None = None,
) -> StrategySignalSeries:
    strategy = config.strategies[0]
    triggers = {} if triggered is None else triggered
    evaluations = tuple(
        evaluation
        for day in dates
        for signal_id, state in (
            ("market.price", True),
            *tuple(triggers.get(day, {}).items()),
        )
        for evaluation in (
            SignalEvaluation(
                date=day,
                signalId=signal_id,
                state=SignalState.TRUE if state else SignalState.FALSE,
            ),
        )
    )
    return StrategySignalSeries(strategyId=strategy.id, evaluations=evaluations)


def _run(
    config: FrozenRunConfig,
    dates: tuple[date, ...],
    prices: tuple[str, ...],
    *,
    signals: StrategySignalSeries | None = None,
    calendar: ExchangeCalendar | None = None,
    valuation_prices: tuple[str, ...] | None = None,
):
    exchange_calendar = _calendar(dates) if calendar is None else calendar
    contribution_schedule = schedule(config.shared, exchange_calendar)
    data = _snapshot(dates, prices, valuation_prices)
    signal_series = (
        _signals(config, contribution_schedule.trading_dates)
        if signals is None
        else signals
    )
    return run_strategy(
        config,
        config.strategies[0],
        contribution_schedule,
        data,
        signal_series,
        exchange_calendar=exchange_calendar,
    )


def test_signal_buy_executes_on_the_next_session_at_that_session_price() -> None:
    dates = (date(2024, 1, 2), date(2024, 1, 3), date(2024, 1, 4))
    config = _config(start=dates[0], end=dates[-1], contribution_day=2)
    signals = _signals(config, dates, {dates[0]: {"accumulation.buy": True}})

    result = _run(
        config,
        dates,
        ("10", "20", "30"),
        signals=signals,
        valuation_prices=("100", "200", "300"),
    )

    assert result.available is True
    assert len(result.trades) == 1
    trade = result.trades[0]
    assert (trade.date, trade.reason, trade.price, trade.cash_amount) == (
        dates[1],
        TradeReason.SIGNAL_BUY,
        Decimal("20"),
        Decimal("100"),
    )
    assert result.daily_assets[0].cash == Decimal("100")
    assert result.daily_assets[0].timing_quantity == 0
    assert result.daily_assets[1].timing_quantity == Decimal("5")
    assert result.daily_assets[-1].total_asset == Decimal("150")


def test_trend_buy_and_full_exit_share_the_same_next_session_ledger() -> None:
    dates = (
        date(2024, 1, 2),
        date(2024, 1, 3),
        date(2024, 1, 4),
        date(2024, 1, 5),
    )
    config = _config(
        start=date(2024, 1, 1),
        end=dates[-1],
        preset="ma_trend",
        contribution_day=1,
        params={"ma.period": 1, "trend.sellBelowOrEqualMa": True},
    )
    signals = _signals(
        config,
        dates,
        {
            dates[0]: {"ma.trend": True},
            dates[1]: {"ma.trend.sell": True},
        },
    )

    result = _run(config, dates, ("10",) * len(dates), signals=signals)

    assert [(trade.date, trade.reason, trade.signal_id) for trade in result.trades] == [
        (dates[1], TradeReason.SIGNAL_BUY, "ma.trend"),
        (dates[2], TradeReason.SIGNAL_SELL, "ma.trend.sell"),
    ]
    assert result.daily_assets[2].timing_quantity == 0
    assert result.daily_assets[2].cash == Decimal("100")


def test_zero_cash_still_keeps_daily_valuation_and_evaluated_sell_signals() -> None:
    dates = (date(2024, 1, 2), date(2024, 1, 3), date(2024, 1, 4))
    config = _config(
        start=date(2024, 1, 1),
        end=dates[-1],
        preset="composite_dca",
        contribution_day=1,
        params={
            "accumulation.fixedDcaEnabled": True,
            "accumulation.fixedDcaRatio": Decimal("1"),
            "vix.buyEnabled": False,
            "rsi.buyEnabled": False,
            "ma.buyEnabled": False,
            "bollinger.buyEnabled": False,
            "rate.buyEnabled": False,
            "pe.buyEnabled": False,
            "exit.enabled": True,
            "exit.rsi.enabled": True,
        },
    )
    signals = _signals(
        config,
        dates,
        {
            dates[0]: {"rsi.exit": True},
            dates[1]: {"rsi.exit": True},
        },
    )

    result = _run(config, dates, ("10", "11", "12"), signals=signals)

    assert result.available is True
    assert all(asset.cash == 0 for asset in result.daily_assets)
    assert [asset.total_asset for asset in result.daily_assets] == [
        Decimal("100"),
        Decimal("110"),
        Decimal("120"),
    ]
    assert result.trades[0].reason is TradeReason.FIXED_DCA
    assert not any(trade.side == "sell" for trade in result.trades)
    assert any(
        evaluation.signal_id == "rsi.exit" and evaluation.state is SignalState.TRUE
        for evaluation in result.signals
    )


def test_valid_zero_trade_ledger_retains_daily_cash_assets() -> None:
    dates = (date(2024, 1, 2), date(2024, 1, 3))
    config = _config(
        start=date(2024, 1, 1),
        end=dates[-1],
        params={"vix.buyEnabled": False, "exit.enabled": False},
        contribution_day=1,
    )
    data = _snapshot(dates, ("10", "11"))
    signals = evaluate_signals(config, data, sessions=dates).strategy("strategy-1")

    result = _run(config, dates, ("10", "11"), signals=signals)

    assert result.available is True
    assert result.trades == ()
    assert len(result.daily_assets) == 2
    assert [asset.cash for asset in result.daily_assets] == [
        Decimal("100"),
        Decimal("100"),
    ]
    assert [asset.total_asset for asset in result.daily_assets] == [
        Decimal("100"),
        Decimal("100"),
    ]


def test_sell_precedes_buy_and_safety_and_uses_only_the_largest_exit_ratio() -> None:
    dates = (date(2024, 1, 30), date(2024, 1, 31), date(2024, 2, 1))
    config = _config(
        start=dates[0],
        end=dates[-1],
        preset="composite_dca",
        contribution_day=31,
        params={
            "accumulation.cashSafetyLimit": Decimal("0"),
            "accumulation.maxSignalBuysPerMonth": None,
            "accumulation.fixedDcaEnabled": False,
            "vix.buyEnabled": False,
            "rsi.buyEnabled": False,
            "ma.buyEnabled": False,
            "bollinger.buyEnabled": False,
            "rate.buyEnabled": False,
            "pe.buyEnabled": False,
            "exit.enabled": True,
            "exit.rsi.enabled": True,
            "exit.rsi.ratio": Decimal("0.5"),
            "exit.bollinger.enabled": True,
            "exit.bollinger.ratio": Decimal("0.6"),
        },
    )
    signals = _signals(
        config,
        dates,
        {
            dates[0]: {"accumulation.buy": True},
            dates[1]: {
                "accumulation.buy": True,
                "rsi.exit": True,
                "bollinger.exit": True,
                "bollinger.exit.vix": True,
            },
        },
    )

    result = _run(config, dates, ("10", "10", "10"), signals=signals)

    assert [(trade.date, trade.side, trade.reason) for trade in result.trades] == [
        (dates[1], "buy", TradeReason.SIGNAL_BUY),
        (dates[2], "sell", TradeReason.SIGNAL_SELL),
    ]
    assert result.trades[-1].quantity == Decimal("6")
    assert result.trades[-1].cash_amount == Decimal("60")
    assert result.trades[-1].signal_id == "bollinger.exit"
    assert result.daily_assets[-1].cash == Decimal("60")


def test_fixed_dca_still_runs_on_a_timing_sell_day() -> None:
    dates = (date(2024, 1, 2), date(2024, 1, 31), date(2024, 2, 1))
    config = _config(
        start=date(2024, 1, 1),
        end=dates[-1],
        preset="composite_dca",
        contribution_day=1,
        params={
            "accumulation.cashSafetyLimit": Decimal("0"),
            "accumulation.maxSignalBuysPerMonth": None,
            "accumulation.fixedDcaEnabled": True,
            "accumulation.fixedDcaRatio": Decimal("0.5"),
            "vix.buyEnabled": False,
            "rsi.buyEnabled": False,
            "ma.buyEnabled": False,
            "bollinger.buyEnabled": False,
            "rate.buyEnabled": False,
            "pe.buyEnabled": False,
            "exit.enabled": True,
            "exit.rsi.enabled": True,
            "exit.rsi.ratio": Decimal("0.5"),
        },
    )
    signals = _signals(
        config,
        dates,
        {
            dates[0]: {"accumulation.buy": True},
            dates[1]: {"accumulation.buy": True, "rsi.exit": True},
        },
    )

    result = _run(config, dates, ("10", "10", "10"), signals=signals)

    assert [(trade.date, trade.reason) for trade in result.trades] == [
        (dates[0], TradeReason.FIXED_DCA),
        (dates[1], TradeReason.SIGNAL_BUY),
        (dates[2], TradeReason.FIXED_DCA),
        (dates[2], TradeReason.SIGNAL_SELL),
    ]
    assert result.trades[2].cash_amount == Decimal("50")
    assert result.trades[3].quantity == Decimal("2.5")
    assert result.daily_assets[-1].fixed_quantity == Decimal("10")
    assert result.daily_assets[-1].cash == Decimal("75")


def test_signal_buy_limit_counts_filled_trades_by_execution_month() -> None:
    dates = (
        date(2024, 1, 2),
        date(2024, 1, 3),
        date(2024, 1, 4),
        date(2024, 2, 1),
        date(2024, 2, 2),
    )
    config = _config(
        start=date(2024, 1, 1),
        end=dates[-1],
        contribution_day=1,
        params={"accumulation.maxSignalBuysPerMonth": 1},
    )
    signals = _signals(
        config,
        dates,
        {
            dates[0]: {"accumulation.buy": True},
            dates[1]: {"accumulation.buy": True},
            dates[2]: {"accumulation.buy": True},
        },
    )

    result = _run(config, dates, ("10",) * len(dates), signals=signals)

    assert [trade.date for trade in result.trades] == [dates[1], dates[3]]
    assert [trade.reason for trade in result.trades] == [
        TradeReason.SIGNAL_BUY,
        TradeReason.SIGNAL_BUY,
    ]


def test_safety_valve_uses_actual_exchange_month_end_not_run_end() -> None:
    dates = (date(2024, 6, 3), date(2024, 6, 14), date(2024, 6, 28))
    calendar = _calendar(dates, coverage_end=date(2024, 6, 30))
    params = {
        "accumulation.cashSafetyLimit": Decimal("50"),
        "vix.buyEnabled": False,
        "exit.enabled": False,
    }
    midmonth = _config(
        start=date(2024, 6, 1), end=dates[1], params=params, contribution_day=1
    )
    midmonth_result = _run(
        midmonth,
        dates,
        ("10", "10", "10"),
        signals=_signals(midmonth, dates[:2]),
        calendar=calendar,
    )

    assert not any(
        trade.reason is TradeReason.SAFETY_VALVE for trade in midmonth_result.trades
    )

    month_end = _config(
        start=date(2024, 6, 1), end=dates[-1], params=params, contribution_day=1
    )
    month_end_result = _run(
        month_end,
        dates,
        ("10", "10", "10"),
        signals=_signals(month_end, dates),
        calendar=calendar,
    )

    assert [(trade.date, trade.reason) for trade in month_end_result.trades] == [
        (dates[-1], TradeReason.SAFETY_VALVE)
    ]


def test_empty_buy_set_does_not_block_scheduled_funding_or_month_end_safety() -> None:
    dates = (date(2024, 6, 3), date(2024, 6, 28))
    config = _config(
        start=date(2024, 6, 1),
        end=dates[-1],
        params={
            "accumulation.cashSafetyLimit": Decimal("50"),
            "vix.buyEnabled": False,
            "exit.enabled": False,
        },
        contribution_day=1,
    )
    data = _snapshot(dates, ("10", "10"))
    signal_batch = evaluate_signals(config, data, sessions=dates)

    result = run_strategy(
        config,
        config.strategies[0],
        schedule(config.shared, _calendar(dates, coverage_end=date(2024, 6, 30))),
        data,
        signal_batch.strategy("strategy-1"),
        exchange_calendar=_calendar(dates, coverage_end=date(2024, 6, 30)),
    )

    assert any(
        evaluation.signal_id == "accumulation.buy"
        and evaluation.state is SignalState.FALSE
        for evaluation in signal_batch.strategy("strategy-1").evaluations
    )
    assert [(trade.date, trade.reason) for trade in result.trades] == [
        (dates[-1], TradeReason.SAFETY_VALVE)
    ]


def test_final_day_signal_is_recorded_without_being_filled() -> None:
    dates = (date(2024, 1, 2), date(2024, 1, 3))
    config = _config(start=dates[0], end=dates[-1], contribution_day=2)
    signals = _signals(config, dates, {dates[-1]: {"accumulation.buy": True}})

    result = _run(config, dates, ("10", "10"), signals=signals)

    assert result.trades == ()
    assert len(result.unexecuted_signals) == 1
    assert result.unexecuted_signals[0].signal_date == dates[-1]
    assert result.unexecuted_signals[0].signal_id == "accumulation.buy"


def test_required_unavailable_signal_stops_the_whole_strategy_ledger() -> None:
    dates = (date(2024, 1, 2), date(2024, 1, 3))
    config = _config(start=dates[0], end=dates[-1], contribution_day=2)
    series = _signals(config, dates)
    unavailable = SignalEvaluation(
        date=dates[0],
        signalId="vix.buy",
        state=SignalState.UNAVAILABLE,
        diagnostics=(
            Diagnostic(
                code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                severity=DiagnosticSeverity.ERROR,
                messageKey="diagnostics.data.required_unavailable",
                fieldPath="strategies[0].params.vix.buyEnabled",
            ),
        ),
    )
    series = series.model_copy(
        update={"evaluations": (*series.evaluations, unavailable)}
    )

    result = _run(config, dates, ("10", "10"), signals=series)

    assert result.available is False
    assert result.trades == ()
    assert result.daily_assets == ()
    assert result.diagnostics[0].code is DiagnosticCode.REQUIRED_DATA_UNAVAILABLE


def test_no_valid_contribution_returns_unavailable_without_fabricated_assets() -> None:
    dates = (date(2024, 1, 2), date(2024, 1, 3))
    config = _config(
        start=dates[0], end=dates[-1], contribution_day=1, contribution_amount="100"
    )
    result = _run(config, dates, ("10", "11"))

    assert result.available is False
    assert result.trades == ()
    assert result.daily_assets == ()
    assert any(
        diagnostic.code is DiagnosticCode.NO_VALID_CONTRIBUTION
        for diagnostic in result.diagnostics
    )


def test_one_hundred_percent_fixed_dca_matches_monthly_dca_daily_assets() -> None:
    dates = (date(2024, 6, 3), date(2024, 6, 14), date(2024, 6, 28))
    shared = {
        "run": {
            "symbol": "QQQ",
            "startDate": date(2024, 6, 1),
            "endDate": dates[-1],
            "endMode": "fixed",
        },
        "contribution": {"day": 1, "amount": Decimal("100")},
    }
    validation = validate_draft(
        {
            "shared": shared,
            "strategies": [
                {
                    "id": "monthly",
                    "presetId": "monthly_dca",
                    "enabled": True,
                    "params": {},
                },
                {
                    "id": "composite",
                    "presetId": "composite_dca",
                    "enabled": True,
                    "params": {
                        "vix.buyEnabled": False,
                        "rsi.buyEnabled": False,
                        "ma.buyEnabled": False,
                        "bollinger.buyEnabled": False,
                        "rate.buyEnabled": False,
                        "pe.buyEnabled": False,
                        "exit.enabled": False,
                        "accumulation.fixedDcaRatio": Decimal("1"),
                    },
                },
            ],
        }
    )
    assert validation.diagnostics_for() == ()
    config = validation.config_for(("monthly", "composite"))
    assert config is not None
    calendar = _calendar(dates, coverage_end=date(2024, 6, 30))
    contribution_schedule = schedule(config.shared, calendar)
    data = _snapshot(dates, ("10", "12", "15"))
    monthly, composite = config.strategies
    monthly_result = run_strategy(
        config,
        monthly,
        contribution_schedule,
        data,
        _signals(
            config.model_copy(update={"strategies": (monthly,)}),
            dates,
        ),
        exchange_calendar=calendar,
    )
    composite_signals = evaluate_signals(
        config.model_copy(update={"strategies": (composite,)}), data, sessions=dates
    ).strategy("composite")
    composite_result = run_strategy(
        config,
        composite,
        contribution_schedule,
        data,
        composite_signals,
        exchange_calendar=calendar,
    )

    assert composite_result.daily_assets == monthly_result.daily_assets
    assert composite_result.trades == monthly_result.trades


@pytest.mark.parametrize("preset", ["lump_sum"])
def test_lump_sum_invests_the_plan_total_on_the_first_session(preset: str) -> None:
    dates = (date(2024, 1, 2), date(2024, 2, 1), date(2024, 3, 1))
    config = _config(
        start=date(2024, 1, 1), end=dates[-1], preset=preset, contribution_day=1
    )

    result = _run(config, dates, ("10", "20", "25"))

    assert len(result.trades) == 1
    assert result.trades[0].date == dates[0]
    assert result.trades[0].reason is TradeReason.UPFRONT
    assert result.trades[0].cash_amount == Decimal("300")
    assert result.daily_assets[0].timing_quantity == Decimal("30")

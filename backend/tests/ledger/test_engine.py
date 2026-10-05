from datetime import UTC, date, datetime, timedelta
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
    TradeSide,
)
from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    DiagnosticSeverity,
    SignalState,
)
from app.ledger.engine import run_strategy
from app.metrics import calculate_metrics
from app.metrics.types import MetricsInput
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
    execution: dict[str, object] | None = None,
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
                **({"execution": execution} if execution is not None else {}),
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


@pytest.mark.parametrize("preset", ["monthly_dca", "lump_sum"])
def test_execution_costs_are_budgeted_and_saved_for_planned_trades(preset: str) -> None:
    days = (date(2024, 1, 2), date(2024, 1, 3))
    config = _config(
        start=date(2024, 1, 1),
        end=days[-1],
        preset=preset,
        contribution_amount="104",
        execution={
            "commission": 2,
            "slippagePct": 1,
            "spreadPct": 2,
            "fractionalShares": True,
        },
    )
    ledger = _run(config, days, ("10", "10"))
    trade = ledger.trades[0]
    assert trade.signal_id is None
    assert trade.execution_base_price == 10
    assert trade.price == trade.execution_price == Decimal("10.2")
    assert trade.quantity == 10
    assert trade.gross_amount == 102
    assert trade.cash_amount == trade.cash_before == 104
    assert trade.cash_after == 0
    assert trade.trading_costs.commission == 2
    assert trade.trading_costs.slippage_cost == 1
    assert trade.trading_costs.spread_cost == 1
    assert trade.trading_costs.total_trading_cost == 4
    assert ledger.daily_assets[0].total_asset == 100
    assert ledger.daily_assets[0].trading_costs == trade.trading_costs


def test_same_day_contribution_does_not_erase_costs_from_unit_nav() -> None:
    days = (date(2024, 1, 2), date(2024, 2, 1))
    config = _config(
        start=date(2024, 1, 1),
        end=days[-1],
        preset="monthly_dca",
        contribution_amount="104",
        execution={
            "commission": 2,
            "slippagePct": 1,
            "spreadPct": 2,
            "fractionalShares": True,
        },
    )
    ledger = _run(config, days, ("10", "10"))
    output = calculate_metrics(
        MetricsInput(
            strategy=config.strategies[0],
            schedule=schedule(config.shared, _calendar(days)),
            ledger=ledger,
            data_fingerprint="cost-fixture",
            analysis_settings=config.shared.analysis,
        )
    )
    assert output.summary.ending_equity == 200
    assert output.summary.net_profit == -8
    assert output.summary.trading_costs.total_trading_cost == 8
    assert output.daily_assets[0].unit_nav == Decimal(100) / 104
    expected_units = Decimal(104) + Decimal(104) / (Decimal(100) / 104)
    assert abs(
        output.daily_assets[1].unit_nav - Decimal(200) / expected_units
    ) < Decimal("1e-25")
    assert output.summary.analysis.monthly_returns[0].nav_return < 0
    assert output.summary.analysis.monthly_returns[1].nav_return < 0


def test_contribution_day_cost_can_exceed_preexisting_equity() -> None:
    days = (date(2024, 1, 2), date(2024, 2, 1))
    config = _config(
        start=date(2024, 1, 1),
        end=days[-1],
        preset="monthly_dca",
        execution={"commission": 99},
    )
    ledger = _run(config, days, ("1", "1"))
    output = calculate_metrics(
        MetricsInput(
            strategy=config.strategies[0],
            schedule=schedule(config.shared, _calendar(days)),
            ledger=ledger,
            data_fingerprint="high-cost-fixture",
        )
    )
    assert output.summary.ending_equity == 2
    assert output.summary.trading_costs.commission == 198
    assert output.daily_assets[0].unit_nav == Decimal("0.01")
    assert output.daily_assets[1].unit_nav == Decimal(2) / 10100


@pytest.mark.parametrize(
    "fractional,commission,expected_quantity,expected_cash",
    [
        (True, 0, "0.5", "0"),
        (False, 0, "0", "100"),
        (True, 100, "0", "100"),
        (False, 1, "0", "100"),
    ],
)
def test_unaffordable_buys_do_not_charge_commission(
    fractional: bool, commission: int, expected_quantity: str, expected_cash: str
) -> None:
    days = (date(2024, 1, 2), date(2024, 1, 3))
    config = _config(
        start=date(2024, 1, 1),
        end=days[-1],
        preset="monthly_dca",
        execution={"commission": commission, "fractionalShares": fractional},
    )
    ledger = _run(config, days, ("200", "200"))
    assert ledger.daily_assets[-1].fixed_quantity == Decimal(expected_quantity)
    assert ledger.daily_assets[-1].cash == Decimal(expected_cash)
    assert len(ledger.trades) == (1 if Decimal(expected_quantity) else 0)


def test_integer_partial_sells_and_rebuys_keep_principal_and_cash_consistent() -> None:
    days = tuple(date(2024, 1, day) for day in (2, 3, 4, 5))
    config = _config(
        start=date(2024, 1, 1),
        end=days[-1],
        contribution_amount="104",
        params={"exit.enabled": True, "exit.vix.ratio2": Decimal("0.25")},
        execution={
            "commission": 2,
            "slippagePct": 1,
            "spreadPct": 2,
            "fractionalShares": False,
        },
    )
    signals = _signals(
        config,
        days,
        {
            days[0]: {"accumulation.buy": True},
            days[1]: {"vix.exit.low2": True, "accumulation.buy": True},
            days[2]: {"accumulation.buy": True},
        },
    )
    # Two genuine buys need an unlimited monthly cap.
    params = dict(config.strategies[0].params)
    params["accumulation.maxSignalBuysPerMonth"] = None
    strategy = config.strategies[0].model_copy(update={"params": params})
    config = config.model_copy(update={"strategies": (strategy,)})
    ledger = _run(config, days, ("10", "10", "10", "10"), signals=signals)
    assert [trade.quantity for trade in ledger.trades] == [10, 2, 1]
    assert [trade.cash_amount for trade in ledger.trades] == [
        104,
        Decimal("17.6"),
        Decimal("12.2"),
    ]
    assert ledger.trades[1].price == Decimal("9.8")
    assert ledger.daily_assets[-1].cash == Decimal("5.4")
    assert ledger.daily_assets[-1].timing_quantity == 9
    assert ledger.daily_assets[-1].total_asset == Decimal("95.4")
    output = calculate_metrics(
        MetricsInput(
            strategy=strategy,
            schedule=schedule(config.shared, _calendar(days)),
            ledger=ledger,
            data_fingerprint="cost-fixture",
        )
    )
    assert output.summary.actual_invested == 104
    assert output.summary.total_contributed == 104
    assert output.summary.trading_costs.total_trading_cost == Decimal("8.6")


def test_integer_zero_fill_does_not_consume_the_monthly_buy_limit() -> None:
    days = tuple(date(2024, 1, day) for day in (2, 3, 4))
    config = _config(
        start=date(2024, 1, 1), end=days[-1], execution={"fractionalShares": False}
    )
    signals = _signals(config, days, {day: {"accumulation.buy": True} for day in days})
    ledger = _run(config, days, ("200", "200", "50"), signals=signals)
    assert len(ledger.trades) == 1
    assert ledger.trades[0].date == days[2]
    assert ledger.trades[0].quantity == 2


def test_execution_cross_field_limit_has_a_precise_configuration_path() -> None:
    result = validate_draft(
        {
            "shared": {
                "run": {
                    "symbol": "QQQ",
                    "startDate": "2024-01-01",
                    "endDate": "2024-02-01",
                },
                "contribution": {"amount": 100, "day": 1},
                "execution": {"slippagePct": 60, "spreadPct": 80},
            },
            "strategies": [],
        }
    )
    assert any(
        item.field_path == "execution.spreadPct" for item in result.diagnostics_for()
    )


def test_exact_spread_boundary_keeps_a_positive_sell_price() -> None:
    from app.domain.execution import ExecutionSettings
    from app.ledger.execution import execute_trade

    settings = ExecutionSettings(
        commission=0,
        slippagePct="59.999999999999999999999999999",
        spreadPct=80,
        fractionalShares=True,
    )
    trade = execute_trade(
        day=date(2024, 1, 2),
        side=TradeSide.SELL,
        reason=TradeReason.SIGNAL_SELL,
        signal_id="conditions.sell",
        base_price=Decimal(1),
        currency="USD",
        cash=Decimal(0),
        held_quantity=Decimal(1),
        sell_quantity=Decimal(1),
        settings=settings,
    )
    assert trade is not None
    assert trade.price == Decimal("1e-29")
    assert trade.cash_amount == trade.price


@pytest.mark.parametrize(
    "fractional,commission,quantity",
    [(False, 0, "0.4"), (True, 1, "0.1"), (True, 2, "0.1")],
)
def test_unaffordable_sells_do_not_create_a_fill_or_charge(
    fractional: bool, commission: int, quantity: str
) -> None:
    from app.domain.execution import ExecutionSettings
    from app.ledger.execution import execute_trade

    trade = execute_trade(
        day=date(2024, 1, 2),
        side=TradeSide.SELL,
        reason=TradeReason.SIGNAL_SELL,
        signal_id="conditions.sell",
        base_price=Decimal(10),
        currency="USD",
        cash=Decimal(100),
        held_quantity=Decimal(1),
        sell_quantity=Decimal(quantity),
        settings=ExecutionSettings(
            commission=commission,
            slippagePct=0,
            spreadPct=0,
            fractionalShares=fractional,
        ),
    )
    assert trade is None


def test_a_subshare_exit_does_not_suppress_a_genuine_buy_on_funding_day() -> None:
    days = (date(2024, 1, 2), date(2024, 1, 3), date(2024, 1, 31), date(2024, 2, 1))
    config = _config(
        start=date(2024, 1, 1),
        end=days[-1],
        params={"exit.enabled": True, "exit.vix.ratio2": Decimal("0.25")},
        execution={"fractionalShares": False},
    )
    signals = _signals(
        config,
        days,
        {
            days[0]: {"accumulation.buy": True},
            days[2]: {"vix.exit.low2": True, "accumulation.buy": True},
        },
    )
    ledger = _run(config, days, ("100", "100", "100", "100"), signals=signals)
    assert [(trade.date, trade.side, trade.quantity) for trade in ledger.trades] == [
        (days[1], TradeSide.BUY, 1),
        (days[3], TradeSide.BUY, 1),
    ]
    assert ledger.daily_assets[-1].timing_quantity == 2
    assert ledger.daily_assets[-1].cash == 0


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
    ohlc: tuple[tuple[str, str, str], ...] | None = None,
) -> DataSnapshot:
    if valuation_prices is None:
        valuation_prices = prices
    bars = tuple(
        MarketBar(
            date=day,
            symbol="QQQ",
            simulationPrice=Decimal(price),
            simulationOpen=None if ohlc is None else Decimal(ohlc[index][0]),
            simulationHigh=None if ohlc is None else Decimal(ohlc[index][1]),
            simulationLow=None if ohlc is None else Decimal(ohlc[index][2]),
            valuationPrice=Decimal(valuation_price),
            currency="USD",
            source="fixture",
            observedAt=datetime.combine(day, datetime.min.time(), UTC),
        )
        for index, (day, price, valuation_price) in enumerate(
            zip(dates, prices, valuation_prices, strict=True)
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
    ohlc: tuple[tuple[str, str, str], ...] | None = None,
):
    exchange_calendar = _calendar(dates) if calendar is None else calendar
    contribution_schedule = schedule(config.shared, exchange_calendar)
    data = _snapshot(dates, prices, valuation_prices, ohlc)
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


def test_dated_rules_carry_account_and_execute_prior_sell_with_prior_ratio():
    days = (
        date(2024, 1, 2),
        date(2024, 1, 3),
        date(2024, 1, 4),
        date(2024, 2, 1),
        date(2024, 2, 2),
    )
    settings = {
        "accumulation.cashSafetyLimit": 10000,
        "exit.enabled": True,
        "exit.vix.ratio1": Decimal("0.5"),
    }
    config = _config(
        start=date(2024, 1, 1),
        end=days[-1],
        params=settings,
        execution={"commission": 1},
    )
    current = config.strategies[0]
    replacement = _config(
        start=date(2024, 1, 1), end=days[-1], params={**settings, "exit.vix.ratio1": 1}
    ).strategies[0]
    policy = {day: current if day < days[3] else replacement for day in days}
    calendar = _calendar(days)
    contributions = schedule(config.shared, calendar)
    result = run_strategy(
        config,
        current,
        contributions,
        _snapshot(days, ("10",) * 5),
        _signals(
            config,
            days,
            {
                days[0]: {"accumulation.buy": True},
                days[2]: {"vix.exit.low1": True},
                days[3]: {"accumulation.buy": True},
            },
        ),
        exchange_calendar=calendar,
        strategy_by_date=policy,
    )
    assert result.available
    assert [(trade.date, trade.side) for trade in result.trades] == [
        (days[1], "buy"),
        (days[3], "sell"),
        (days[4], "buy"),
    ]
    assert result.trades[1].quantity == Decimal("4.95")
    assert result.daily_assets[3].timing_quantity == Decimal("4.95")
    assert result.daily_assets[-1].total_asset == 197
    metrics = calculate_metrics(
        MetricsInput(
            strategy=current,
            schedule=contributions,
            ledger=result,
            data_fingerprint="dated-policy",
        )
    )
    assert metrics.summary.total_contributed == 200
    assert metrics.summary.actual_invested <= 200
    assert metrics.summary.trading_costs.total_trading_cost == 3


@pytest.mark.parametrize("missing", [True, False])
def test_dated_rules_require_full_coverage_and_stable_strategy_identity(missing):
    days = (date(2024, 1, 2), date(2024, 1, 3))
    config = _config(start=date(2024, 1, 1), end=days[-1])
    current = config.strategies[0]
    policy = (
        {days[0]: current}
        if missing
        else {days[0]: current, days[1]: current.model_copy(update={"id": "other"})}
    )
    calendar = _calendar(days)
    with pytest.raises(ValueError):
        run_strategy(
            config,
            current,
            schedule(config.shared, calendar),
            _snapshot(days, ("10", "10")),
            _signals(config, days),
            exchange_calendar=calendar,
            strategy_by_date=policy,
        )


def test_dated_simulation_keeps_prior_pending_buy_and_changes_new_signals():
    from app.domain.contracts import MacroObservation
    from app.simulation import simulate_strategy

    days = (date(2024, 1, 2), date(2024, 1, 3), date(2024, 2, 1), date(2024, 2, 2))
    params = {"vix.buyThreshold": 20, "accumulation.cashSafetyLimit": 10000}
    config = _config(start=date(2024, 1, 1), end=days[-1], params=params)
    current = config.strategies[0]
    replacement = _config(
        start=date(2024, 1, 1), end=days[-1], params={**params, "vix.buyThreshold": 30}
    ).strategies[0]
    data = _snapshot(days, ("10",) * 4).model_copy(
        update={
            "macro": tuple(
                MacroObservation(
                    date=day - timedelta(days=1),
                    symbol="^VIX",
                    value=25,
                    unit="index_points",
                    source="fixture",
                    observedAt=datetime.combine(
                        day - timedelta(days=1), datetime.min.time(), UTC
                    ),
                    alignedSessionDate=day,
                )
                for day in days
            )
        }
    )
    calendar = _calendar(days)
    result = simulate_strategy(
        config,
        current,
        schedule(config.shared, calendar),
        data,
        calendar,
        strategy_by_date={
            day: current if day < days[2] else replacement for day in days
        },
    )
    assert result.metrics is not None
    assert result.metrics.total_contributed == result.metrics.ending_equity == 200
    assert [trade.date for trade in result.trades] == [days[1], days[2]]
    signals = {
        row.date: row.state
        for row in result.signals
        if row.signal_id == "accumulation.buy"
    }
    assert signals[days[1]] is SignalState.TRUE
    assert signals[days[2]] is SignalState.FALSE


@pytest.mark.parametrize("preset", ["monthly_dca", "lump_sum"])
def test_planned_trades_capture_balances_after_funding(preset: str) -> None:
    dates = (date(2024, 1, 2), date(2024, 1, 3), date(2024, 2, 1))
    config = _config(start=date(2024, 1, 1), end=dates[-1], preset=preset)
    result = _run(config, dates, ("10", "10", "20"))
    assert len(result.trades) == (2 if preset == "monthly_dca" else 1)
    previous_quantity = Decimal("0")
    for trade in result.trades:
        assert trade.cash_before == trade.cash_amount
        assert trade.cash_after == 0
        assert trade.quantity_before == previous_quantity
        assert trade.quantity_after == previous_quantity + trade.quantity
        assert trade.execution_base_price == trade.price
        assert trade.execution_price == trade.price
        previous_quantity = trade.quantity_after


@pytest.mark.parametrize("with_funding_on_sell_day", [False, True])
def test_signal_buy_partial_sell_and_rebuy_explain_each_transaction(
    with_funding_on_sell_day: bool,
) -> None:
    dates = (
        (date(2024, 1, 2), date(2024, 1, 3), date(2024, 2, 1), date(2024, 2, 2))
        if with_funding_on_sell_day
        else tuple(date(2024, 1, day) for day in (2, 3, 4, 5))
    )
    config = _config(
        start=date(2024, 1, 1),
        end=dates[-1],
        preset="composite_dca",
        params={
            "accumulation.maxSignalBuysPerMonth": 3,
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
            dates[1]: {"rsi.exit": True},
            dates[2]: {"accumulation.buy": True},
        },
    )
    result = _run(config, dates, ("10", "10", "12", "10"), signals=signals)
    assert tuple(trade.side for trade in result.trades) == (
        TradeSide.BUY,
        TradeSide.SELL,
        TradeSide.BUY,
    )
    assert tuple(
        (
            trade.cash_before,
            trade.cash_after,
            trade.quantity_before,
            trade.quantity_after,
            trade.execution_base_price,
            trade.execution_price,
        )
        for trade in result.trades
    ) == (
        (
            Decimal("100"),
            Decimal("0"),
            Decimal("0"),
            Decimal("10"),
            Decimal("10"),
            Decimal("10"),
        ),
        (
            Decimal("100") if with_funding_on_sell_day else Decimal("0"),
            Decimal("160") if with_funding_on_sell_day else Decimal("60"),
            Decimal("10"),
            Decimal("5"),
            Decimal("12"),
            Decimal("12"),
        ),
        (
            Decimal("160") if with_funding_on_sell_day else Decimal("60"),
            Decimal("0"),
            Decimal("5"),
            Decimal("21") if with_funding_on_sell_day else Decimal("11"),
            Decimal("10"),
            Decimal("10"),
        ),
    )
    measured = calculate_metrics(
        MetricsInput(
            strategy=config.strategies[0],
            ledger=result,
            schedule=schedule(config.shared, _calendar(dates)),
            data_fingerprint="trade-explain-fixture",
        )
    )
    assert measured.summary is not None
    assert measured.summary.actual_invested == (
        Decimal("200") if with_funding_on_sell_day else Decimal("100")
    )


def test_month_end_safety_trade_has_saved_balances() -> None:
    dates = (date(2024, 1, 2), date(2024, 1, 31))
    config = _config(
        start=date(2024, 1, 1),
        end=dates[-1],
        params={"accumulation.cashSafetyLimit": 100},
    )
    trade = _run(config, dates, ("10", "20")).trades[0]
    assert trade.reason is TradeReason.SAFETY_VALVE
    assert trade.signal_id is None
    assert (
        trade.cash_before,
        trade.cash_after,
        trade.quantity_before,
        trade.quantity_after,
    ) == (
        Decimal("100"),
        Decimal("0"),
        Decimal("0"),
        Decimal("5"),
    )


@pytest.mark.parametrize(
    ("mode", "expected"),
    [
        ("cash", "0"),
        ("signal", "100"),
        ("safety", "200"),
        ("reinvest", "100"),
        ("monthly_dca", "200"),
        ("lump_sum", "200"),
    ],
)
def test_invested_principal_tracks_first_use_without_counting_reinvestment(
    mode: str,
    expected: str,
) -> None:
    dates = tuple(
        date.fromisoformat(day)
        for day in (
            "2024-01-02",
            "2024-01-03",
            "2024-01-04",
            "2024-01-31",
            "2024-02-01",
            "2024-02-02",
            "2024-02-29",
        )
    )
    params: dict[str, object] = {
        "accumulation.cashSafetyLimit": Decimal("10000"),
        "accumulation.maxSignalBuysPerMonth": 3,
        "exit.enabled": mode == "reinvest",
        "exit.rsi.enabled": mode == "reinvest",
        "exit.rsi.ratio": Decimal("1"),
    }
    preset = "composite_dca"
    if mode in ("monthly_dca", "lump_sum"):
        preset, params = mode, {}
    elif mode == "safety":
        params["accumulation.cashSafetyLimit"] = Decimal("100")
    config = _config(
        start=date(2024, 1, 1), end=dates[-1], preset=preset, params=params
    )
    triggers = (
        {dates[0]: {"accumulation.buy": True}} if mode in ("signal", "reinvest") else {}
    )
    if mode == "reinvest":
        triggers.update(
            {dates[1]: {"rsi.exit": True}, dates[2]: {"accumulation.buy": True}}
        )
    ledger = _run(
        config,
        dates,
        ("10", "10", "20", "10", "10", "10", "10"),
        signals=_signals(config, dates, triggers),
    )
    summary = calculate_metrics(
        MetricsInput(
            strategy=config.strategies[0],
            schedule=schedule(config.shared, _calendar(dates)),
            ledger=ledger,
            data_fingerprint="actual-buys-fixture",
        )
    ).summary
    assert summary.actual_invested == Decimal(expected)
    assert summary.total_contributed == Decimal("200")
    assert summary.investment_basis == "original_principal"
    if mode == "reinvest":
        assert sum(
            trade.cash_amount for trade in ledger.trades if trade.side is TradeSide.BUY
        ) == Decimal("300")
    if mode == "cash":
        assert ledger.trades == ()
        assert ledger.daily_assets[-1].cash == Decimal("200")
    if mode == "reinvest":
        assert [trade.cash_amount for trade in ledger.trades] == [
            Decimal("100"),
            Decimal("200"),
            Decimal("200"),
        ]


def test_trend_monthly_buy_cap_uses_the_shared_signal_trade_counter() -> None:
    dates = tuple(
        date.fromisoformat(day)
        for day in (
            "2024-01-02",
            "2024-01-03",
            "2024-01-04",
            "2024-01-31",
            "2024-02-01",
            "2024-02-02",
        )
    )
    config = _config(
        start=date(2024, 1, 1),
        end=dates[-1],
        preset="ma_trend",
        params={"ma.period": 1, "accumulation.maxSignalBuysPerMonth": 1},
    )
    signals = _signals(
        config,
        dates,
        {
            dates[0]: {"ma.trend": True},
            dates[1]: {"ma.trend.sell": True},
            dates[2]: {"ma.trend": True},
            dates[3]: {"ma.trend": True},
            dates[4]: {"ma.trend": True},
        },
    )
    result = _run(config, dates, ("10",) * len(dates), signals=signals)
    assert [trade.date for trade in result.trades if trade.side is TradeSide.BUY] == [
        dates[1],
        dates[4],
    ]
    assert [trade.date for trade in result.trades if trade.side is TradeSide.SELL] == [
        dates[2]
    ]


def test_ledger_preserves_normalized_ohlc_in_daily_result_snapshots() -> None:
    dates = (date(2024, 1, 31), date(2024, 2, 1))
    config = _config(
        start=dates[0],
        end=dates[-1],
        preset="monthly_dca",
        params={"scheduled.fundingMode": "monthly"},
    )

    result = _run(
        config,
        dates,
        ("100", "105"),
        ohlc=(("98", "102", "97"), ("101", "108", "100")),
    )

    assert result.daily_assets[0].simulation_open == Decimal("98")
    assert result.daily_assets[0].simulation_high == Decimal("102")
    assert result.daily_assets[0].simulation_low == Decimal("97")
    assert result.daily_assets[0].simulation_price == Decimal("100")


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


def test_signal_buy_trade_keeps_the_triggering_condition_identity() -> None:
    dates = (date(2024, 1, 2), date(2024, 1, 3))
    config = _config(start=dates[0], end=dates[-1], contribution_day=2)
    signals = _signals(config, dates, {dates[0]: {"accumulation.buy": True}})
    signals = signals.model_copy(
        update={
            "evaluations": tuple(
                item.model_copy(update={"triggered_signal_ids": ("vix.buy",)})
                if item.date == dates[0] and item.signal_id == "accumulation.buy"
                else item
                for item in signals.evaluations
            )
        }
    )

    result = _run(config, dates, ("10", "10"), signals=signals)

    assert result.trades[0].signal_id == "vix.buy"


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


def test_monthly_benchmark_ignores_timing_sell_signals_and_values_every_day() -> None:
    dates = (date(2024, 1, 2), date(2024, 1, 3), date(2024, 1, 4))
    config = _config(start=date(2024, 1, 1), end=dates[-1], preset="monthly_dca")
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


def test_contribution_precedes_sell_and_stays_in_timing_cash_on_sell_day() -> None:
    dates = (date(2024, 1, 2), date(2024, 1, 31), date(2024, 2, 1))
    config = _config(
        start=date(2024, 1, 1),
        end=dates[-1],
        preset="composite_dca",
        contribution_day=1,
        params={
            "accumulation.cashSafetyLimit": Decimal("0"),
            "accumulation.maxSignalBuysPerMonth": None,
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
        (dates[1], TradeReason.SIGNAL_BUY),
        (dates[2], TradeReason.SIGNAL_SELL),
    ]
    assert result.trades[0].cash_amount == Decimal("100")
    assert result.trades[1].quantity == Decimal("5")
    assert result.daily_assets[-1].fixed_quantity == Decimal("0")
    assert result.daily_assets[-1].cash == Decimal("150")


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


def test_final_day_unexecuted_buy_uses_its_triggering_condition_identity() -> None:
    dates = (date(2024, 1, 2), date(2024, 1, 3))
    config = _config(start=dates[0], end=dates[-1], contribution_day=2)
    signals = _signals(config, dates, {dates[-1]: {"accumulation.buy": True}})
    signals = signals.model_copy(
        update={
            "evaluations": tuple(
                item.model_copy(update={"triggered_signal_ids": ("vix.buy",)})
                if item.date == dates[-1] and item.signal_id == "accumulation.buy"
                else item
                for item in signals.evaluations
            )
        }
    )

    result = _run(config, dates, ("10", "10"), signals=signals)

    assert result.unexecuted_signals[0].signal_id == "vix.buy"


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


def test_no_signal_custom_strategy_keeps_principal_while_benchmark_buys_monthly() -> (
    None
):
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

    assert composite_result.trades == ()
    assert composite_result.daily_assets[-1].cash == Decimal("100")
    assert (
        monthly_result.daily_assets[-1].total_asset
        > composite_result.daily_assets[-1].total_asset
    )
    assert len(monthly_result.trades) == 1


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


def test_reinvestment_tax_tracks_remaining_basis_and_original_principal():
    days = tuple(date(2024, 1, day) for day in (2, 3, 4, 5, 8))
    config = _config(
        start=date(2024, 1, 1),
        end=days[-1],
        params={
            "accumulation.cashSafetyLimit": 10000,
            "accumulation.maxSignalBuysPerMonth": None,
            "exit.enabled": True,
            "exit.vix.ratio1": Decimal("0.5"),
            "exit.vix.ratio2": 1,
        },
        execution={"capitalGainsTaxEnabled": True},
    )
    ledger = _run(
        config,
        days,
        ("10", "10", "20", "15", "20"),
        signals=_signals(
            config,
            days,
            {
                days[0]: {"accumulation.buy": True},
                days[1]: {"vix.exit.low1": True},
                days[2]: {"accumulation.buy": True},
                days[3]: {"vix.exit.low2": True},
            },
        ),
    )
    assert ledger.available
    assert [trade.side for trade in ledger.trades] == ["buy", "sell", "buy", "sell"]
    assert [trade.trading_costs.capital_gains_tax for trade in ledger.trades] == [
        0,
        10,
        0,
        16,
    ]
    assert ledger.daily_assets[-1].cash == ledger.daily_assets[-1].total_asset == 204
    assert ledger.daily_assets[-1].timing_quantity == 0
    metrics = calculate_metrics(
        MetricsInput(
            strategy=config.strategies[0],
            schedule=schedule(config.shared, _calendar(days)),
            ledger=ledger,
            data_fingerprint="tax-cycle",
        )
    )
    assert metrics.summary.trading_costs.capital_gains_tax == 26
    assert metrics.summary.trading_costs.total_trading_cost == 26
    assert metrics.summary.total_contributed == metrics.summary.actual_invested == 100
    assert metrics.summary.net_profit == 104

"""Seeded ledger checks using rational operations and explicit Decimal rounding.

Unlimited exact rational arithmetic is not the contract of a finite-precision
ledger. Round each independent arithmetic operation to its declared 28 digits,
then retain the same absolute 1e-20 assertions, including large monetary values.
"""

from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal, localcontext
from fractions import Fraction
from random import Random

import pytest

from app.calendar import schedule
from app.domain.contracts import SignalEvaluation
from app.domain.status import SignalState
from app.ledger import run_strategy
from app.metrics import MetricsInput, calculate_metrics
from app.signals.evaluate import StrategySignalSeries
from tests.ledger.test_engine import _calendar, _config, _snapshot

D = Decimal
TOLERANCE = D("1e-20")
START, END = date(2019, 12, 16), date(2021, 2, 26)
DAYS = tuple(
    day
    for offset in range((END - START).days + 1)
    if (day := START + timedelta(days=offset)).weekday() < 5
)


def _source(seed, amount, contribution_day, *, scale=1, end=END):
    rng = Random(seed)
    prices = tuple(str(D(rng.randint(500, 50000)) / 97 * scale) for _ in DAYS)
    ratios = (D(0), D("0.142857"), D("0.333333"), D("0.8"), D(1))
    decisions = {day: (rng.randrange(4) != 0, rng.choice(ratios)) for day in DAYS}
    config = _config(
        start=START,
        end=end,
        contribution_amount=amount,
        contribution_day=contribution_day,
        params={"accumulation.maxSignalBuysPerMonth": None},
    )
    # The fixture covers the complete calendar, including months outside a prefix.
    calendar = _calendar(DAYS, coverage_end=date(2021, 2, 28))
    plan = schedule(config.shared, calendar)
    signals = StrategySignalSeries(
        strategyId=config.strategies[0].id,
        evaluations=tuple(
            row
            for day in plan.trading_dates
            for row in (
                SignalEvaluation(date=day, signalId="market.price", state="true"),
                SignalEvaluation(
                    date=day,
                    signalId="accumulation.buy",
                    state="true" if decisions[day][0] else "false",
                ),
                SignalEvaluation(
                    date=day,
                    signalId="conditions.sell",
                    state="true" if decisions[day][1] else "false",
                    sellRatio=decisions[day][1],
                ),
            )
        ),
    )
    data = _snapshot(DAYS, prices)
    ledger = run_strategy(
        config,
        config.strategies[0],
        plan,
        data,
        signals,
        exchange_calendar=calendar,
    )
    metrics = calculate_metrics(
        MetricsInput(config.strategies[0], plan, ledger, data.fingerprint)
    )
    return plan, ledger, metrics, decisions


def _decimal(value):
    with localcontext() as context:
        context.prec = 80
        return D(value.numerator) / D(value.denominator)


def _rounded(value):
    with localcontext() as context:
        context.prec = 28
        return Fraction(D(value.numerator) / D(value.denominator))


def _verify_rational_replay(seed, plan, ledger, metrics, decisions):
    """Recompute from deposits/prices/signals, without production accounting."""
    funding = {row.date: Fraction(row.amount) for row in plan.contributions}
    trades = defaultdict(list)
    for trade in ledger.trades:
        trades[trade.date].append(trade)
    cash = quantity = contributed = invested = unused_principal = Fraction(0)
    previous = None
    previous_invested = D(0)
    by_date = {row.date: row for row in metrics.daily_assets}
    for asset in ledger.daily_assets:
        day, price = asset.date, Fraction(asset.simulation_price)
        deposit = funding.get(day, Fraction(0))
        cash = _rounded(cash + deposit)
        contributed += deposit
        unused_principal += deposit
        expected = []
        buy, sell = decisions.get(previous, (False, D(0)))
        if sell and quantity:
            sold = _rounded(quantity * Fraction(sell))
            proceeds = _rounded(sold * price)
            quantity = _rounded(quantity - sold)
            cash = _rounded(cash + proceeds)
            expected.append(("sell", "signal_sell", proceeds, sold))
        elif buy and cash:
            bought = _rounded(cash / price)
            expected.append(("buy", "signal_buy", cash, bought))
            quantity = _rounded(quantity + bought)
            # Every buy here exhausts cash. Previously unused original deposits
            # become invested once; all subsequent sale proceeds are recycled.
            invested += unused_principal
            unused_principal = Fraction(0)
            cash = Fraction(0)
        # The safety limit is 1200; it is intentionally exercised for large inputs.
        month_end = (day + timedelta(days=1)).month != day.month or (
            day.weekday() == 4 and (day + timedelta(days=3)).month != day.month
        )
        sold_today = bool(expected and expected[0][0] == "sell")
        if month_end and not sold_today and cash >= 1200:
            bought = _rounded(cash / price)
            expected.append(("buy", "safety_valve", cash, bought))
            quantity = _rounded(quantity + bought)
            invested += unused_principal
            unused_principal = Fraction(0)
            cash = Fraction(0)
        assert len(trades[day]) == len(expected), (seed, day, expected, trades[day])
        for trade, (side, reason, amount, shares) in zip(
            trades[day], expected, strict=True
        ):
            assert (trade.side.value, trade.reason.value) == (side, reason)
            assert abs(trade.cash_amount - _decimal(amount)) < TOLERANCE, (seed, day)
            assert abs(trade.quantity - _decimal(shares)) < TOLERANCE, (seed, day)
        enriched = by_date[day]
        for field, expected_value in (
            ("cash", cash),
            ("timing_quantity", quantity),
            ("total_asset", _rounded(cash + _rounded(quantity * price))),
            ("total_contributed", contributed),
            ("actual_invested", invested),
        ):
            assert abs(getattr(enriched, field) - _decimal(expected_value)) < (
                TOLERANCE
            ), (seed, day, field, getattr(enriched, field), _decimal(expected_value))
        assert 0 <= enriched.actual_invested <= enriched.total_contributed
        assert enriched.actual_invested >= previous_invested
        assert enriched.cash >= 0 and enriched.timing_quantity >= 0
        assert enriched.fixed_quantity == 0
        assert enriched.unit_nav >= 0 and -1 <= enriched.drawdown <= 0
        previous, previous_invested = day, enriched.actual_invested
    assert metrics.summary.ending_equity == metrics.daily_assets[-1].total_asset
    assert metrics.summary.actual_invested == metrics.daily_assets[-1].actual_invested
    assert len(ledger.unexecuted_signals) == sum(
        bool(value) for value in decisions[ledger.daily_assets[-1].date]
    )


@pytest.mark.parametrize("seed", [0, 7, 19, 42, 87, 20261003])
@pytest.mark.parametrize("amount,day", [("0.01", 31), ("137.19", 15), ("1000000", 1)])
def test_long_recycling_sequences_obey_rational_accounting_and_principal_bounds(
    seed, amount, day
):
    plan, ledger, metrics, decisions = _source(seed, amount, day)
    _verify_rational_replay(seed, plan, ledger, metrics, decisions)
    assert any(trade.side.value == "sell" for trade in ledger.trades)
    assert any(trade.side.value == "buy" for trade in ledger.trades)


@pytest.mark.parametrize("seed", [0, 19, 42])
def test_price_units_do_not_change_cash_returns_and_future_bars_do_not_change_past(
    seed,
):
    _, whole, metrics, _ = _source(seed, "137.19", 31)
    _, scaled, scaled_metrics, _ = _source(seed, "137.19", 31, scale=10)
    for left, right in zip(
        metrics.daily_assets, scaled_metrics.daily_assets, strict=True
    ):
        for field in ("cash", "total_asset", "actual_invested", "unit_nav", "drawdown"):
            assert abs(getattr(left, field) - getattr(right, field)) < TOLERANCE
        assert abs(left.timing_quantity - right.timing_quantity * 10) < TOLERANCE
    assert len(whole.trades) == len(scaled.trades)
    end = date(2020, 7, 15)
    _, prefix, prefix_metrics, _ = _source(seed, "137.19", 31, end=end)
    assert prefix.trades == tuple(trade for trade in whole.trades if trade.date <= end)
    assert prefix_metrics.daily_assets == tuple(
        row for row in metrics.daily_assets if row.date <= end
    )
    assert all(row.state is not SignalState.UNAVAILABLE for row in whole.signals)

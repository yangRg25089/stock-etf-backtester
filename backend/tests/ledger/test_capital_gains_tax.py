"""The optional simplified tax is charged only on net realised gains."""

from datetime import date
from decimal import Decimal

import pytest

from app.domain.contracts import TradeReason, TradeSide
from app.domain.execution import ExecutionSettings, TradingCosts
from app.ledger.execution import execute_trade


def settings(enabled: bool = True) -> ExecutionSettings:
    return ExecutionSettings(
        commission=2,
        slippagePct=0,
        spreadPct=0,
        fractionalShares=True,
        capitalGainsTaxEnabled=enabled,
    )


@pytest.mark.parametrize(
    "price,expected_tax,expected_cash",
    [(15, "3.6", "24.4"), (8, "0.8", "13.2"), (4, "0", "6")],
)
def test_sell_tax_uses_net_profit_and_allocated_average_cost(
    price: int, expected_tax: str, expected_cash: str
) -> None:
    trade = execute_trade(
        day=date(2024, 1, 3),
        side=TradeSide.SELL,
        reason=TradeReason.SIGNAL_SELL,
        signal_id="vix.sell",
        base_price=Decimal(price),
        currency="USD",
        cash=Decimal(0),
        held_quantity=Decimal(10),
        sell_quantity=Decimal(2),
        average_cost=Decimal(5),
        settings=settings(),
    )
    assert trade is not None
    assert trade.trading_costs.capital_gains_tax == Decimal(expected_tax)
    assert trade.cash_amount == trade.cash_after == Decimal(expected_cash)
    assert trade.trading_costs.total_trading_cost == Decimal(2) + Decimal(expected_tax)
    assert trade.gross_amount == 2 * price


def test_disabled_tax_and_unrealised_gains_do_not_deduct_cash() -> None:
    buy = execute_trade(
        day=date(2024, 1, 2),
        side=TradeSide.BUY,
        reason=TradeReason.SIGNAL_BUY,
        signal_id="vix.buy",
        base_price=Decimal(5),
        currency="USD",
        cash=Decimal(52),
        held_quantity=Decimal(0),
        settings=settings(),
    )
    sell = execute_trade(
        day=date(2024, 1, 3),
        side=TradeSide.SELL,
        reason=TradeReason.SIGNAL_SELL,
        signal_id="vix.sell",
        base_price=Decimal(15),
        currency="USD",
        cash=Decimal(0),
        held_quantity=Decimal(10),
        sell_quantity=Decimal(2),
        settings=settings(False),
    )
    assert buy is not None and sell is not None
    assert (
        buy.trading_costs.capital_gains_tax == sell.trading_costs.capital_gains_tax == 0
    )
    assert sell.cash_amount == 28


def test_tax_enabled_sell_requires_saved_cost_basis_and_costs_aggregate() -> None:
    with pytest.raises(ValueError, match="average cost"):
        execute_trade(
            day=date(2024, 1, 3),
            side=TradeSide.SELL,
            reason=TradeReason.SIGNAL_SELL,
            signal_id="vix.sell",
            base_price=Decimal(15),
            currency="USD",
            cash=Decimal(0),
            held_quantity=Decimal(10),
            sell_quantity=Decimal(2),
            settings=settings(),
        )
    costs = TradingCosts.aggregate(
        [
            TradingCosts.from_components(
                Decimal(2), Decimal(1), Decimal(0), Decimal(3)
            ),
            TradingCosts.from_components(
                Decimal(1), Decimal(0), Decimal(1), Decimal(2)
            ),
        ]
    )
    assert costs.capital_gains_tax == 5 and costs.total_trading_cost == 10

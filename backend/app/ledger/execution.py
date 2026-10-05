"""One pure fill policy for planned, signal, safety and benchmark trades."""

from datetime import date
from decimal import ROUND_FLOOR, Decimal, localcontext

from app.domain.contracts import Trade, TradeReason, TradeSide
from app.domain.execution import ExecutionSettings, TradingCosts


def execute_trade(
    *,
    day: date,
    side: TradeSide,
    reason: TradeReason,
    signal_id: str | None,
    base_price: Decimal,
    currency: str,
    cash: Decimal,
    held_quantity: Decimal,
    settings: ExecutionSettings | None,
    sell_quantity: Decimal | None = None,
    average_cost: Decimal | None = None,
) -> Trade | None:
    with localcontext() as context:
        context.prec = settings.rate_precision if settings else context.prec
        # Absent settings belong only to legacy frozen configurations.
        commission = settings.commission if settings else Decimal(0)
        slippage = settings.slippage_pct / 100 if settings else Decimal(0)
        half_spread = settings.spread_pct / 200 if settings else Decimal(0)
        fractional = settings.fractional_shares if settings else True
        buy = side is TradeSide.BUY
        price = base_price * (
            1 + slippage + half_spread if buy else 1 - slippage - half_spread
        )
        if buy:
            if cash <= commission:
                return None
            quantity = (cash - commission) / price
        else:
            if sell_quantity is None or sell_quantity > held_quantity:
                raise ValueError("sell quantity must belong to the current holdings")
            quantity = sell_quantity
        if not fractional:
            quantity = quantity.to_integral_value(rounding=ROUND_FLOOR)
        if quantity <= 0:
            return None
        # Fractional all-cash buys spend the budget exactly, avoiding a rounding
        # remainder from dividing and multiplying the same Decimal price.
        gross = cash - commission if buy and fractional else quantity * price
        amount = gross + commission if buy else gross - commission
        if amount <= 0:
            return None
        tax = Decimal(0)
        if not buy and settings is not None and settings.capital_gains_tax_enabled:
            if average_cost is None or not average_cost.is_finite() or average_cost < 0:
                raise ValueError("taxed sells require a non-negative average cost")
            tax = max(amount - quantity * average_cost, Decimal(0)) * Decimal("0.20")
            amount -= tax
        costs = TradingCosts.from_components(
            commission,
            quantity * base_price * slippage,
            quantity * base_price * half_spread,
            tax,
        )
        return Trade(
            date=day,
            side=side,
            reason=reason,
            quantity=quantity,
            price=price,
            cashAmount=amount,
            currency=currency,
            signalId=signal_id,
            cashBefore=cash,
            cashAfter=cash - amount if buy else cash + amount,
            quantityBefore=held_quantity,
            quantityAfter=held_quantity + quantity if buy else held_quantity - quantity,
            executionBasePrice=base_price,
            executionPrice=price,
            grossAmount=gross,
            tradingCosts=costs,
        )

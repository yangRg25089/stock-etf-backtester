"""Frozen execution inputs and saved trading cost values."""

from collections.abc import Iterable
from decimal import Decimal, localcontext

from pydantic import Field, ValidationInfo, field_validator

from .status import DomainModel


def _rate_precision(slippage: Decimal, spread: Decimal) -> int:
    return max(
        28, 6 - min(int(slippage.as_tuple().exponent), int(spread.as_tuple().exponent))
    )


class ExecutionSettings(DomainModel):
    commission: Decimal = Field(ge=0)
    slippage_pct: Decimal = Field(alias="slippagePct", ge=0, lt=100)
    spread_pct: Decimal = Field(alias="spreadPct", ge=0, lt=200)
    fractional_shares: bool = Field(alias="fractionalShares", strict=True)

    @field_validator("spread_pct")
    @classmethod
    def require_positive_sell_price(
        cls, value: Decimal, info: ValidationInfo
    ) -> Decimal:
        slippage = info.data.get("slippage_pct", Decimal(0))
        with localcontext() as context:
            context.prec = _rate_precision(slippage, value)
            if slippage + value / 2 >= 100:
                raise ValueError(
                    "slippage plus half the spread must be below 100 percent"
                )
        return value

    @property
    def rate_precision(self) -> int:
        return _rate_precision(self.slippage_pct, self.spread_pct)


class TradingCosts(DomainModel):
    commission: Decimal = Field(ge=0)
    slippage_cost: Decimal = Field(alias="slippageCost", ge=0)
    spread_cost: Decimal = Field(alias="spreadCost", ge=0)
    total_trading_cost: Decimal = Field(alias="totalTradingCost", ge=0)

    @classmethod
    def from_components(
        cls, commission: Decimal, slippage: Decimal, spread: Decimal
    ) -> "TradingCosts":
        return cls(
            commission=commission,
            slippageCost=slippage,
            spreadCost=spread,
            totalTradingCost=commission + slippage + spread,
        )

    @classmethod
    def aggregate(cls, values: Iterable["TradingCosts"]) -> "TradingCosts":
        rows = tuple(values)
        return cls.from_components(
            sum((row.commission for row in rows), Decimal(0)),
            sum((row.slippage_cost for row in rows), Decimal(0)),
            sum((row.spread_cost for row in rows), Decimal(0)),
        )

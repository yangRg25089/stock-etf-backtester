"""Condition metadata references the one parameter registry."""

from typing import Literal

from pydantic import Field

from app.catalog.definitions import PARAMETER_DEFINITIONS
from app.domain.conditions import ConditionKind, ConditionLeaf
from app.domain.status import DomainModel


class ConditionDefinition(DomainModel):
    kind: ConditionKind
    name_key: str = Field(alias="nameKey")
    buy_parameter_keys: tuple[str, ...] = Field(alias="buyParameterKeys")
    sell_parameter_keys: tuple[str, ...] = Field(alias="sellParameterKeys")

    def parameter_keys(self, side: Literal["buy", "sell"]) -> tuple[str, ...]:
        return self.buy_parameter_keys if side == "buy" else self.sell_parameter_keys


def _definition(
    kind: ConditionKind, buy: tuple[str, ...], sell: tuple[str, ...]
) -> ConditionDefinition:
    return ConditionDefinition(
        kind=kind,
        nameKey=f"conditions.{kind.value}",
        buyParameterKeys=buy,
        sellParameterKeys=sell,
    )


CONDITION_DEFINITIONS = (
    _definition(
        ConditionKind.VIX,
        ("vix.symbol", "vix.buyThreshold"),
        (
            "vix.symbol",
            "exit.vix.low1",
            "exit.vix.ratio1",
            "exit.vix.low2",
            "exit.vix.ratio2",
        ),
    ),
    _definition(
        ConditionKind.RSI,
        ("rsi.period", "rsi.buyThreshold"),
        ("rsi.period", "exit.rsi.threshold", "exit.rsi.ratio"),
    ),
    _definition(
        ConditionKind.MA_DEVIATION,
        ("ma.period", "ma.buyDeviationPct"),
        ("ma.period", "ma.buyDeviationPct", "exit.ratio"),
    ),
    _definition(ConditionKind.MA_TREND, ("ma.period",), ("ma.period", "exit.ratio")),
    _definition(
        ConditionKind.BOLLINGER,
        ("bollinger.period", "bollinger.stddev"),
        (
            "bollinger.period",
            "bollinger.stddev",
            "vix.symbol",
            "exit.bollinger.vixCeiling",
            "exit.bollinger.ratio",
        ),
    ),
    _definition(
        ConditionKind.RATE,
        ("rate.symbol", "rate.sourceUnit", "rate.thresholdPct"),
        ("rate.symbol", "rate.sourceUnit", "rate.thresholdPct", "exit.ratio"),
    ),
    _definition(
        ConditionKind.PE,
        ("pe.threshold", "pe.etfMinCoverage"),
        ("pe.threshold", "pe.etfMinCoverage", "exit.ratio"),
    ),
)


def condition_definition(kind: ConditionKind) -> ConditionDefinition:
    return next(item for item in CONDITION_DEFINITIONS if item.kind is kind)


def default_condition(
    kind: ConditionKind, side: Literal["buy", "sell"], *, enabled: bool = True
) -> ConditionLeaf:
    return ConditionLeaf(
        id=f"{side}-{kind.value}",
        kind=kind,
        enabled=enabled,
        params={
            key: PARAMETER_DEFINITIONS[key].default
            for key in condition_definition(kind).parameter_keys(side)
        },
    )

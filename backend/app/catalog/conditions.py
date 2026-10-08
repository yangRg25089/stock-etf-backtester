"""Condition metadata references the one parameter registry."""

from __future__ import annotations

from typing import Literal

from pydantic import Field, model_validator

from app.catalog.definitions import PARAMETER_DEFINITIONS
from app.domain.conditions import (
    ConditionComparator,
    ConditionDisplayClause,
    ConditionDisplayOperand,
    ConditionDisplayRule,
    ConditionKind,
    ConditionLeaf,
    ConditionLogic,
)
from app.domain.status import DomainModel


class ConditionDefinition(DomainModel):
    kind: ConditionKind
    name_key: str = Field(alias="nameKey")
    buy_parameter_keys: tuple[str, ...] = Field(alias="buyParameterKeys")
    sell_parameter_keys: tuple[str, ...] = Field(alias="sellParameterKeys")
    buy_display_rule: ConditionDisplayRule = Field(alias="buyDisplayRule")
    sell_display_rule: ConditionDisplayRule = Field(alias="sellDisplayRule")

    @model_validator(mode="after")
    def validate_display_parameter_bindings(self) -> ConditionDefinition:
        for side in ("buy", "sell"):
            allowed = set(self.parameter_keys(side))
            rule = self.display_rule(side)
            if side == "buy" and rule.sell_ratio_parameter_key:
                raise ValueError("buy display rules cannot include sell ratios")
            referenced: set[str] = set()
            if rule.sell_ratio_parameter_key:
                referenced.add(rule.sell_ratio_parameter_key)
            for clause in rule.clauses:
                for operand in (clause.left, clause.right):
                    if operand.parameter_key:
                        referenced.add(operand.parameter_key)
                    referenced.update(operand.metric_parameters.values())
                if clause.sell_tier_ratio_parameter_key:
                    if side != "sell":
                        raise ValueError(
                            "buy display rules cannot include sell-tier ratios"
                        )
                    referenced.add(clause.sell_tier_ratio_parameter_key)
            unknown = referenced - allowed
            if unknown:
                raise ValueError(
                    f"{side} display rules reference unsupported parameters: "
                    f"{sorted(unknown)}"
                )
        return self

    def parameter_keys(self, side: Literal["buy", "sell"]) -> tuple[str, ...]:
        return self.buy_parameter_keys if side == "buy" else self.sell_parameter_keys

    def display_rule(self, side: Literal["buy", "sell"]) -> ConditionDisplayRule:
        return self.buy_display_rule if side == "buy" else self.sell_display_rule

    @property
    def legacy_buy_enabled_key(self) -> str | None:
        if self.kind is ConditionKind.MA_TREND:
            return None
        family = "ma" if self.kind is ConditionKind.MA_DEVIATION else self.kind.value
        return f"{family}.buyEnabled"


def _definition(
    kind: ConditionKind,
    buy: tuple[str, ...],
    sell: tuple[str, ...],
    buy_rule: ConditionDisplayRule,
    sell_rule: ConditionDisplayRule,
) -> ConditionDefinition:
    return ConditionDefinition(
        kind=kind,
        nameKey=f"conditions.{kind.value}",
        buyParameterKeys=buy,
        sellParameterKeys=sell,
        buyDisplayRule=buy_rule,
        sellDisplayRule=sell_rule,
    )


def _metric(key: str, **parameters: str) -> ConditionDisplayOperand:
    return ConditionDisplayOperand(metricKey=key, metricParameters=parameters)


def _parameter(key: str) -> ConditionDisplayOperand:
    return ConditionDisplayOperand(parameterKey=key)


def _clause(
    left: ConditionDisplayOperand,
    operator: ConditionComparator,
    right: ConditionDisplayOperand,
    *,
    tier_ratio: str | None = None,
) -> ConditionDisplayClause:
    return ConditionDisplayClause(
        left=left,
        operator=operator,
        right=right,
        sellTierRatioParameterKey=tier_ratio,
    )


def _rule(
    *clauses: ConditionDisplayClause,
    logic: ConditionLogic = ConditionLogic.AND,
    sell_ratio: str | None = None,
    note: str | None = None,
) -> ConditionDisplayRule:
    return ConditionDisplayRule(
        logic=logic, clauses=clauses, sellRatioParameterKey=sell_ratio, noteKey=note
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
        _rule(
            _clause(
                _metric("conditions.metric.vix", symbol="vix.symbol"),
                ConditionComparator.GREATER_THAN_OR_EQUAL,
                _parameter("vix.buyThreshold"),
            )
        ),
        _rule(
            _clause(
                _metric("conditions.metric.vix", symbol="vix.symbol"),
                ConditionComparator.LESS_THAN_OR_EQUAL,
                _parameter("exit.vix.low1"),
                tier_ratio="exit.vix.ratio1",
            ),
            _clause(
                _metric("conditions.metric.vix", symbol="vix.symbol"),
                ConditionComparator.LESS_THAN_OR_EQUAL,
                _parameter("exit.vix.low2"),
                tier_ratio="exit.vix.ratio2",
            ),
            logic=ConditionLogic.OR,
            note="conditions.ruleNote.vixSell",
        ),
    ),
    _definition(
        ConditionKind.RSI,
        ("rsi.period", "rsi.buyThreshold"),
        ("rsi.period", "exit.rsi.threshold", "exit.rsi.ratio"),
        _rule(
            _clause(
                _metric("conditions.metric.rsi", period="rsi.period"),
                ConditionComparator.LESS_THAN_OR_EQUAL,
                _parameter("rsi.buyThreshold"),
            )
        ),
        _rule(
            _clause(
                _metric("conditions.metric.rsi", period="rsi.period"),
                ConditionComparator.GREATER_THAN_OR_EQUAL,
                _parameter("exit.rsi.threshold"),
            ),
            sell_ratio="exit.rsi.ratio",
        ),
    ),
    _definition(
        ConditionKind.MA_DEVIATION,
        ("ma.period", "ma.buyDeviationPct"),
        ("ma.period", "ma.buyDeviationPct", "exit.ratio"),
        _rule(
            _clause(
                _metric("conditions.metric.maDeviation", period="ma.period"),
                ConditionComparator.LESS_THAN_OR_EQUAL,
                _parameter("ma.buyDeviationPct"),
            )
        ),
        _rule(
            _clause(
                _metric("conditions.metric.maDeviation", period="ma.period"),
                ConditionComparator.GREATER_THAN_OR_EQUAL,
                _parameter("ma.buyDeviationPct"),
            ),
            sell_ratio="exit.ratio",
        ),
    ),
    _definition(
        ConditionKind.MA_TREND,
        ("ma.period",),
        ("ma.period", "exit.ratio"),
        _rule(
            _clause(
                _metric("conditions.metric.close"),
                ConditionComparator.GREATER_THAN,
                _metric("conditions.metric.movingAverage", period="ma.period"),
            )
        ),
        _rule(
            _clause(
                _metric("conditions.metric.close"),
                ConditionComparator.LESS_THAN_OR_EQUAL,
                _metric("conditions.metric.movingAverage", period="ma.period"),
            )
        ),
    ),
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
        _rule(
            _clause(
                _metric("conditions.metric.close"),
                ConditionComparator.LESS_THAN_OR_EQUAL,
                _metric(
                    "conditions.metric.bollingerLower",
                    period="bollinger.period",
                    stddev="bollinger.stddev",
                ),
            )
        ),
        _rule(
            _clause(
                _metric("conditions.metric.close"),
                ConditionComparator.GREATER_THAN_OR_EQUAL,
                _metric(
                    "conditions.metric.bollingerUpper",
                    period="bollinger.period",
                    stddev="bollinger.stddev",
                ),
            ),
            _clause(
                _metric("conditions.metric.vix", symbol="vix.symbol"),
                ConditionComparator.LESS_THAN,
                _parameter("exit.bollinger.vixCeiling"),
            ),
            sell_ratio="exit.bollinger.ratio",
        ),
    ),
    _definition(
        ConditionKind.RATE,
        ("rate.symbol", "rate.sourceUnit", "rate.thresholdPct"),
        ("rate.symbol", "rate.sourceUnit", "rate.thresholdPct", "exit.ratio"),
        _rule(
            _clause(
                _metric("conditions.metric.rate", symbol="rate.symbol"),
                ConditionComparator.LESS_THAN_OR_EQUAL,
                _parameter("rate.thresholdPct"),
            )
        ),
        _rule(
            _clause(
                _metric("conditions.metric.rate", symbol="rate.symbol"),
                ConditionComparator.GREATER_THAN_OR_EQUAL,
                _parameter("rate.thresholdPct"),
            ),
            sell_ratio="exit.ratio",
        ),
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

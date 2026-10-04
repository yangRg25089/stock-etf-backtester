"""Immutable condition trees shared by presets, drafts and execution."""

from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import Field, field_serializer, field_validator, model_validator

from app.domain.immutability import FrozenMap, freeze_mapping, thaw_mapping
from app.domain.status import DomainModel


class ConditionLogic(StrEnum):
    AND = "AND"
    OR = "OR"


class ConditionKind(StrEnum):
    VIX = "vix"
    RSI = "rsi"
    MA_DEVIATION = "ma_deviation"
    MA_TREND = "ma_trend"
    BOLLINGER = "bollinger"
    RATE = "rate"
    PE = "pe"


class ConditionLimits(DomainModel):
    max_depth: int = Field(default=8, alias="maxDepth", ge=1)
    max_nodes: int = Field(default=96, alias="maxNodes", ge=1)
    max_instances_per_kind: int = Field(default=1, alias="maxInstancesPerKind", ge=1)


CONDITION_LIMITS = ConditionLimits()


class ConditionLeaf(DomainModel):
    type: Literal["condition"] = "condition"
    id: str = Field(min_length=1, max_length=96, pattern=r"^[A-Za-z0-9_-]+$")
    kind: ConditionKind
    enabled: bool = True
    params: Mapping[str, object] = Field(default_factory=dict, validate_default=True)

    @field_validator("params", mode="after")
    @classmethod
    def freeze_params(cls, value: Mapping[str, object]) -> FrozenMap:
        return freeze_mapping(value)

    @field_serializer("params")
    def serialize_params(self, value: Mapping[str, object]) -> dict[str, object]:
        return thaw_mapping(value)


class ConditionGroup(DomainModel):
    type: Literal["group"] = "group"
    id: str = Field(min_length=1, max_length=96, pattern=r"^[A-Za-z0-9_-]+$")
    enabled: bool = True
    operator: ConditionLogic = ConditionLogic.AND
    children: tuple[ConditionNode, ...] = ()


ConditionNode = Annotated[ConditionLeaf | ConditionGroup, Field(discriminator="type")]
ConditionGroup.model_rebuild()


def condition_signal_id(node: ConditionLeaf, side: Literal["buy", "sell"]) -> str:
    """Retain canonical IDs for old templates; independent nodes add their ID."""
    names = {
        ConditionKind.VIX: ("vix.buy", "vix.exit"),
        ConditionKind.RSI: ("rsi.buy", "rsi.exit"),
        ConditionKind.MA_DEVIATION: ("ma.buy", "ma.exit"),
        ConditionKind.MA_TREND: ("ma.trend", "ma.trend.sell"),
        ConditionKind.BOLLINGER: ("bollinger.buy", "bollinger.exit"),
        ConditionKind.RATE: ("rate.buy", "rate.exit"),
        ConditionKind.PE: ("pe.buy", "pe.exit"),
    }
    base = names[node.kind][0 if side == "buy" else 1]
    return base if node.id == f"{side}-{node.kind.value}" else f"{base}:{node.id}"


class StrategyRules(DomainModel):
    buy: ConditionNode | None = None
    sell: ConditionNode | None = None

    @model_validator(mode="after")
    def validate_structure(self) -> StrategyRules:
        stack = [(root, 1) for root in (self.buy, self.sell) if root is not None]
        seen: set[str] = set()
        while stack:
            node, depth = stack.pop()
            if depth > CONDITION_LIMITS.max_depth:
                raise ValueError("condition tree exceeds maxDepth")
            if node.id in seen:
                raise ValueError(f"condition IDs must be unique: {node.id}")
            seen.add(node.id)
            if len(seen) > CONDITION_LIMITS.max_nodes:
                raise ValueError("condition tree exceeds maxNodes")
            if isinstance(node, ConditionGroup):
                stack.extend((child, depth + 1) for child in node.children)
        return self


def override_rule_parameters(
    rules: StrategyRules | None, values: Mapping[str, object]
) -> StrategyRules | None:
    """Grid dimensions replace matching stable keys, retaining all other values."""
    if rules is None:
        return None

    def override(node: ConditionNode | None) -> ConditionNode | None:
        if node is None:
            return None
        if isinstance(node, ConditionLeaf):
            return node.model_copy(
                update={
                    "params": freeze_mapping(
                        {
                            key: values.get(key, value)
                            for key, value in node.params.items()
                        }
                    )
                }
            )
        return node.model_copy(
            update={
                "children": tuple(
                    child
                    for item in node.children
                    if (child := override(item)) is not None
                )
            }
        )

    return StrategyRules(buy=override(rules.buy), sell=override(rules.sell))

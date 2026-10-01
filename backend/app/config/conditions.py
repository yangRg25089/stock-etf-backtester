"""Validate leaf parameters and fixed templates through catalog definitions."""

from collections.abc import Callable
from decimal import Decimal
from typing import Literal

from app.catalog.conditions import condition_definition
from app.catalog.definitions import (
    ParameterType,
    ParameterValidationError,
    validate_parameter_value,
)
from app.catalog.presets import PresetDefinition
from app.catalog.service import Catalog
from app.config.diagnostics import ConfigurationIssue, invalid_parameter
from app.domain.conditions import (
    ConditionGroup,
    ConditionKind,
    ConditionLeaf,
    ConditionLogic,
    ConditionNode,
    StrategyRules,
)
from app.domain.contracts import StrategyPresetId
from app.domain.status import Diagnostic


def materialize_legacy_rules(
    preset: PresetDefinition, params: dict[str, object]
) -> StrategyRules | None:
    """Convert flat input once; calculation modules receive condition objects."""
    if preset.default_rules is None:
        return None

    def leaf(
        kind: ConditionKind, side: Literal["buy", "sell"], enabled: bool
    ) -> ConditionLeaf:
        metadata = condition_definition(kind)
        values = {
            key: params[key] for key in metadata.parameter_keys(side) if key in params
        }
        if kind is ConditionKind.MA_TREND and side == "sell":
            values["exit.ratio"] = Decimal("1")
        return ConditionLeaf(
            id=f"{side}-{kind.value}", kind=kind, enabled=enabled, params=values
        )

    if preset.editor_mode == "fixed":
        expected = preset.default_rules.buy
        if not isinstance(expected, ConditionLeaf):
            return None
        buy_enabled = (
            params.get("vix.buyEnabled", True) is True
            if preset.id is StrategyPresetId.VIX_DCA
            else True
        )
        sell_enabled = (
            params.get("trend.sellBelowOrEqualMa", False) is True
            if preset.execution_module.value == "trend"
            else params.get("exit.enabled", False) is True
        )
        return StrategyRules(
            buy=leaf(expected.kind, "buy", buy_enabled),
            sell=leaf(expected.kind, "sell", sell_enabled)
            if preset.default_rules.sell is not None
            else None,
        )
    buy_kinds = (
        (ConditionKind.VIX, "vix.buyEnabled"),
        (ConditionKind.RSI, "rsi.buyEnabled"),
        (ConditionKind.MA_DEVIATION, "ma.buyEnabled"),
        (ConditionKind.BOLLINGER, "bollinger.buyEnabled"),
        (ConditionKind.RATE, "rate.buyEnabled"),
        (ConditionKind.PE, "pe.buyEnabled"),
    )
    sell_enabled = params.get("exit.enabled", False) is True
    return StrategyRules(
        buy=ConditionGroup(
            id="buy-root",
            operator=ConditionLogic(
                str(params.get("accumulation.conditionLogic", "OR"))
            ),
            children=tuple(
                leaf(kind, "buy", params.get(key, False) is True)
                for kind, key in buy_kinds
            ),
        ),
        sell=ConditionGroup(
            id="sell-root",
            operator=ConditionLogic.OR,
            children=(
                leaf(ConditionKind.VIX, "sell", sell_enabled),
                leaf(
                    ConditionKind.RSI,
                    "sell",
                    sell_enabled and params.get("exit.rsi.enabled", False) is True,
                ),
                leaf(
                    ConditionKind.BOLLINGER,
                    "sell",
                    sell_enabled
                    and params.get("exit.bollinger.enabled", False) is True,
                ),
            ),
        ),
    )


def normalize_rules(
    rules: StrategyRules,
    preset: PresetDefinition,
    catalog: Catalog,
    field_path: str,
    normalize_value: Callable[[ParameterType, object], object],
) -> tuple[StrategyRules, tuple[Diagnostic, ...]]:
    diagnostics: list[Diagnostic] = []

    def normalize_node(
        node: ConditionNode | None, side: Literal["buy", "sell"], path: str
    ) -> ConditionNode | None:
        if node is None:
            return None
        if isinstance(node, ConditionGroup):
            return ConditionGroup(
                id=node.id,
                enabled=node.enabled,
                operator=node.operator,
                children=tuple(
                    child
                    for index, item in enumerate(node.children)
                    if (
                        child := normalize_node(item, side, f"{path}.children[{index}]")
                    )
                    is not None
                ),
            )
        metadata = next(
            (item for item in catalog.conditions if item.kind is node.kind), None
        )
        if metadata is None:
            diagnostics.append(
                invalid_parameter(
                    issue=ConfigurationIssue.NOT_APPLICABLE,
                    field_path=f"{path}.kind",
                    details={"conditionId": node.id},
                )
            )
            return node
        keys = metadata.parameter_keys(side)
        resolved: dict[str, object] = {}
        for key in node.params.keys() - set(keys):
            diagnostics.append(
                invalid_parameter(
                    issue=ConfigurationIssue.NOT_APPLICABLE,
                    field_path=f"{path}.params.{key}",
                    details={"conditionId": node.id, "parameterKey": key},
                )
            )
        for key in keys:
            definition = catalog.parameter(key)
            value = node.params.get(key, definition.default)
            try:
                validate_parameter_value(definition, value)
            except ParameterValidationError as error:
                diagnostics.append(
                    invalid_parameter(
                        issue=error.issue,
                        field_path=f"{path}.params.{key}",
                        details={"conditionId": node.id, "parameterKey": key},
                    )
                )
            else:
                resolved[key] = normalize_value(definition.type, value)
        return ConditionLeaf(
            id=node.id, kind=node.kind, enabled=node.enabled, params=resolved
        )

    for side in ("buy", "sell"):
        node = getattr(rules, side)
        expected = getattr(preset.default_rules, side) if preset.default_rules else None
        if (
            preset.editor_mode == "fixed"
            and node is not None
            and (
                not isinstance(node, ConditionLeaf)
                or not isinstance(expected, ConditionLeaf)
                or node.kind is not expected.kind
            )
        ):
            diagnostics.append(
                invalid_parameter(
                    issue=ConfigurationIssue.NOT_APPLICABLE,
                    field_path=f"{field_path}.{side}",
                )
            )
    return StrategyRules(
        buy=normalize_node(rules.buy, "buy", f"{field_path}.buy"),
        sell=normalize_node(rules.sell, "sell", f"{field_path}.sell"),
    ), tuple(diagnostics)

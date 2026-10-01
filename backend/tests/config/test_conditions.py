from decimal import Decimal
from operator import setitem

import pytest
from pydantic import ValidationError

from app.catalog.service import get_catalog
from app.config.validation import validate_draft
from app.domain.conditions import ConditionGroup, ConditionLeaf, StrategyRules
from app.domain.contracts import FrozenRunConfig


def leaf(node_id: str, kind: str, **params: object) -> dict[str, object]:
    return {
        "type": "condition",
        "id": node_id,
        "kind": kind,
        "enabled": True,
        "params": params,
    }


def draft(rules: object, preset: str = "composite_dca") -> dict[str, object]:
    return {
        "shared": {
            "run": {
                "symbol": "QQQ",
                "startDate": "2024-01-01",
                "endDate": "2024-02-02",
                "endMode": "fixed",
            }
        },
        "strategies": [
            {
                "id": "custom",
                "presetId": preset,
                "enabled": True,
                "params": {},
                "rules": rules,
            }
        ],
    }


def test_nested_conditions_are_catalog_normalized_and_independent() -> None:
    buy = {
        "type": "group",
        "id": "buy",
        "operator": "AND",
        "children": [
            leaf("slow", "ma_trend", **{"ma.period": 200}),
            {
                "type": "group",
                "id": "entry",
                "operator": "OR",
                "children": [
                    leaf("vix-25", "vix", **{"vix.buyThreshold": 25}),
                    leaf("vix-35", "vix", **{"vix.buyThreshold": 35}),
                ],
            },
        ],
    }
    result = validate_draft(draft({"buy": buy, "sell": None}))
    assert result.valid, result.diagnostics_for()
    frozen = result.config_for()
    assert frozen is not None
    rules = frozen.strategies[0].rules
    assert rules is not None and isinstance(rules.buy, ConditionGroup)
    entry = rules.buy.children[1]
    assert isinstance(entry, ConditionGroup)
    first, second = entry.children
    assert isinstance(first, ConditionLeaf) and isinstance(second, ConditionLeaf)
    assert first.params["vix.buyThreshold"] == Decimal("25")
    assert second.params["vix.buyThreshold"] == Decimal("35")
    assert first.params["vix.symbol"] == "^VIX"
    with pytest.raises(TypeError):
        setitem(first.params, "vix.buyThreshold", Decimal("0"))
    restored = FrozenRunConfig.model_validate(
        frozen.model_dump(mode="python", by_alias=True)
    )
    assert restored == frozen


@pytest.mark.parametrize(
    "parameter,value",
    [("vix.buyThreshold", -1), ("vix.buyThreshold", True), ("ma.period", 2)],
)
def test_condition_fields_use_the_one_parameter_registry(
    parameter: str, value: object
) -> None:
    result = validate_draft(
        draft({"buy": leaf("vix", "vix", **{parameter: value}), "sell": None})
    )
    assert not result.valid
    paths = [error.field_path for error in result.diagnostics_for()]
    assert any("rules.buy" in path and parameter in path for path in paths)


def test_condition_ids_are_unique_across_both_sides() -> None:
    with pytest.raises(ValidationError):
        StrategyRules.model_validate(
            {"buy": leaf("same", "rsi"), "sell": leaf("same", "rsi")}
        )


def test_condition_depth_is_bounded_by_shared_catalog_limits() -> None:
    node = leaf("vix", "vix")
    limits = get_catalog().condition_limits
    for index in range(limits.max_depth + 1):
        node = {
            "type": "group",
            "id": f"group-{index}",
            "operator": "AND",
            "children": [node],
        }
    with pytest.raises(ValidationError):
        StrategyRules.model_validate({"buy": node, "sell": None})


def test_fixed_templates_reject_added_groups_and_other_condition_types() -> None:
    bad = validate_draft(
        draft({"buy": leaf("rsi", "rsi"), "sell": None}, preset="vix_dca")
    )
    assert not bad.valid
    grouped = validate_draft(
        draft(
            {
                "buy": {
                    "type": "group",
                    "id": "group",
                    "operator": "OR",
                    "children": [leaf("vix", "vix")],
                },
                "sell": None,
            },
            preset="vix_dca",
        )
    )
    assert not grouped.valid


def test_catalog_exposes_reusable_conditions_and_single_condition_presets() -> None:
    catalog = get_catalog()
    assert {item.kind.value for item in catalog.conditions} == {
        "vix",
        "rsi",
        "ma_deviation",
        "ma_trend",
        "bollinger",
        "rate",
        "pe",
    }
    for name in ("rsi_dca", "ma_deviation_dca", "bollinger_dca", "rate_dca", "pe_dca"):
        preset = catalog.preset(name)
        assert preset.editor_mode == "fixed"
        assert preset.default_rules is not None
        assert isinstance(preset.default_rules.buy, ConditionLeaf)
    assert catalog.preset("composite_dca").editor_mode == "custom"
    for condition in catalog.conditions:
        for key in (*condition.buy_parameter_keys, *condition.sell_parameter_keys):
            assert catalog.parameter(key).key == key


def test_flat_input_materializes_conditions_only_at_the_config_boundary() -> None:
    result = validate_draft(
        {
            "shared": {
                "run": {
                    "symbol": "QQQ",
                    "startDate": "2024-01-01",
                    "endDate": "2024-02-02",
                    "endMode": "fixed",
                }
            },
            "strategies": [
                {
                    "id": "legacy",
                    "presetId": "vix_dca",
                    "enabled": True,
                    "params": {"vix.buyEnabled": False, "vix.buyThreshold": 32},
                }
            ],
        }
    )
    frozen = result.config_for()
    assert frozen is not None
    rules = frozen.strategies[0].rules
    assert rules is not None and isinstance(rules.buy, ConditionLeaf)
    assert rules.buy.enabled is False
    assert rules.buy.params["vix.buyThreshold"] == Decimal("32")
    assert isinstance(rules.sell, ConditionLeaf) and not rules.sell.enabled

from datetime import date

from app.catalog.service import get_catalog
from app.config.validation import validate_draft


def _draft(strategies):
    return {
        "shared": {
            "run": {
                "symbol": "QQQ",
                "startDate": "2024-01-01",
                "endDate": "2024-02-01",
            }
        },
        "strategies": strategies,
    }


def _strategy(preset, number=1):
    return {
        "id": f"{preset}-{number}",
        "presetId": preset,
        "enabled": True,
        "params": {},
    }


def test_current_catalog_defaults_to_today_and_removes_obsolete_features():
    catalog = get_catalog()
    assert catalog.parameter("run.endDate").default == date.today()
    keys = {parameter.key for parameter in catalog.parameters}
    assert "run.endMode" not in keys
    assert "accumulation.fixedDcaEnabled" not in keys
    assert "accumulation.fixedDcaRatio" not in keys
    assert not any(
        group.id == "fixed_contribution" for group in catalog.parameter_groups
    )
    assert all(
        dimension.key != "accumulation.fixedDcaRatio"
        for preset in catalog.presets
        for dimension in preset.search_dimensions
    )
    assert {item.symbol for item in catalog.symbol_suggestions} >= {
        "QQQ",
        "SPY",
        "VOO",
        "VTI",
        "IVV",
    }
    assert all(item.currency == "USD" for item in catalog.symbol_suggestions)
    assert catalog.strategy_limits.max_custom_instances == 10


def test_custom_instances_allow_ten_and_fixed_presets_do_not_repeat():
    ten = [_strategy("composite_dca", number) for number in range(1, 11)]
    assert validate_draft(_draft(ten)).valid
    assert not validate_draft(_draft([*ten, _strategy("composite_dca", 11)])).valid
    assert not validate_draft(
        _draft([_strategy("vix_dca", 1), _strategy("vix_dca", 2)])
    ).valid


def test_conditions_cannot_repeat_within_one_side_but_buy_sell_are_independent():
    strategy = _strategy("composite_dca")
    first = {"type": "condition", "id": "first", "kind": "vix", "params": {}}
    second = {"type": "condition", "id": "second", "kind": "vix", "params": {}}
    strategy["rules"] = {"buy": first, "sell": second}
    assert validate_draft(_draft([strategy])).valid
    strategy["rules"] = {
        "buy": {
            "type": "group",
            "id": "root",
            "operator": "AND",
            "children": [first, second],
        },
        "sell": None,
    }
    result = validate_draft(_draft([strategy]))
    assert not result.valid
    assert any(
        item.details.get("issue") == "duplicate_condition"
        for item in result.diagnostics_for()
    )


def test_removed_fixed_contribution_parameters_are_rejected():
    strategy = _strategy("composite_dca")
    strategy["params"] = {
        "accumulation.fixedDcaEnabled": True,
        "accumulation.fixedDcaRatio": "0.5",
    }
    result = validate_draft(_draft([strategy]))
    assert not result.valid
    assert {item.details.get("parameterKey") for item in result.diagnostics_for()} == {
        "accumulation.fixedDcaEnabled",
        "accumulation.fixedDcaRatio",
    }

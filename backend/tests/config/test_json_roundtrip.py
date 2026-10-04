"""Saved JSON inputs must remain runnable without losing decimal precision."""

from decimal import Decimal

import pytest

from app.catalog.presets import PresetDefinition
from app.catalog.service import get_catalog
from app.config.validation import validate_draft


@pytest.mark.parametrize("preset", get_catalog().presets, ids=lambda preset: preset.id)
def test_every_preset_frozen_json_can_be_submitted_again(
    preset: PresetDefinition,
) -> None:
    original = validate_draft(
        {
            "shared": {
                "run": {
                    "symbol": "QQQ",
                    "startDate": "2024-01-01",
                    "endDate": "2024-12-31",
                }
            },
            "strategies": [{"id": "saved-strategy", "presetId": preset.id}],
        }
    )
    assert original.valid, original.diagnostics_for()
    config = original.config_for()
    assert config is not None
    restored = validate_draft(config.model_dump(mode="json", by_alias=True))
    assert restored.valid, restored.diagnostics_for()
    assert restored.config_for() == config


def test_numeric_json_strings_preserve_exact_decimal_and_condition_values() -> None:
    threshold = "25.1234567890123456789012345678"
    result = validate_draft(
        {
            "shared": {
                "run": {
                    "symbol": "QQQ",
                    "startDate": "2024-01-01",
                    "endDate": "2024-12-31",
                }
            },
            "strategies": [
                {
                    "id": "precise",
                    "presetId": "vix_dca",
                    "params": {"vix.buyThreshold": threshold},
                }
            ],
        }
    )
    assert result.valid, result.diagnostics_for()
    config = result.config_for()
    assert config is not None
    strategy = config.strategies[0]
    assert strategy.params["vix.buyThreshold"] == Decimal(threshold)
    assert strategy.rules is not None
    assert strategy.rules.buy is not None
    assert strategy.rules.buy.params["vix.buyThreshold"] == Decimal(threshold)


def test_search_decimal_lists_survive_frozen_json_with_their_exact_values() -> None:
    values = ["25.000000000000000000000001", "26"]
    result = validate_draft(
        {
            "shared": {
                "run": {
                    "symbol": "QQQ",
                    "startDate": "2024-01-01",
                    "endDate": "2024-12-31",
                }
            },
            "strategies": [
                {
                    "id": "search",
                    "presetId": "grid_search",
                    "params": {
                        "search.dimensions": ["vix.buyThreshold"],
                        "search.values.vix.buyThreshold": values,
                    },
                }
            ],
        }
    )
    assert result.valid, result.diagnostics_for()
    config = result.config_for()
    assert config is not None
    assert config.strategies[0].params["search.values.vix.buyThreshold"] == tuple(
        Decimal(item) for item in values
    )
    restored = validate_draft(config.model_dump(mode="json", by_alias=True))
    assert restored.valid, restored.diagnostics_for()
    assert restored.config_for() == config


@pytest.mark.parametrize(
    "value", ["", " 25 ", "NaN", "Infinity", "1_000", "25 USD", True, "1e5000"]
)
def test_invalid_numeric_text_remains_a_located_configuration_error(
    value: object,
) -> None:
    result = validate_draft(
        {
            "shared": {
                "run": {
                    "symbol": "QQQ",
                    "startDate": "2024-01-01",
                    "endDate": "2024-12-31",
                }
            },
            "strategies": [
                {
                    "id": "invalid",
                    "presetId": "vix_dca",
                    "params": {"vix.buyThreshold": value},
                }
            ],
        }
    )
    assert not result.valid
    assert any(
        diagnostic.field_path == "strategies[0].params.vix.buyThreshold"
        for diagnostic in result.diagnostics_for()
    )

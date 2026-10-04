from app.catalog import definitions, presets, service
from app.domain import conditions


def test_only_repository_used_snake_case_catalog_interfaces_remain() -> None:
    for module, names in (
        (
            service,
            (
                "getCatalog",
                "getSearchableParameters",
                "parameterKeysForPreset",
                "presetDefaults",
                "catalogAsDict",
            ),
        ),
        (definitions, ("getParameterDefinition", "iterParameterDefinitions")),
        (presets, ("getPresetDefinition",)),
        (conditions, ("walk_conditions",)),
    ):
        for name in names:
            assert not hasattr(module, name), name
    assert service.catalog_as_dict() == service.get_catalog().model_dump(
        mode="json", by_alias=True
    )
    definition = definitions.get_parameter_definition("vix.buyThreshold")
    for name in ("default_value", "min_value", "max_value"):
        assert not hasattr(definition, name), name
    assert definition.default == service.preset_defaults("vix_dca")["vix.buyThreshold"]

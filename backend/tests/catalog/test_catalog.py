from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.catalog.definitions import (
    PARAMETER_DEFINITIONS,
    PARAMETER_GROUP_DEFINITIONS,
    ParameterDefinition,
    ParameterGroupDefinition,
    ParameterLevel,
    ParameterType,
    ParameterValidationError,
    ParameterValueIssue,
    validate_parameter_value,
)
from app.catalog.presets import (
    EXECUTION_MODULES,
    PRESET_DEFINITIONS,
    ExecutionModule,
    PresetDefinition,
)
from app.catalog.service import (
    CATALOG_VERSION,
    Catalog,
    default_data_settings,
    get_catalog,
    get_parameter_definition,
    get_preset_definition,
    get_searchable_parameters,
    parameter_keys_for_preset,
    preset_defaults,
)
from app.domain.contracts import StrategyPresetId

EXPECTED_PRESETS = (
    StrategyPresetId.VIX_DCA,
    StrategyPresetId.COMPOSITE_DCA,
    StrategyPresetId.MA_TREND,
    StrategyPresetId.MA_BUY_ONLY,
    StrategyPresetId.MONTHLY_DCA,
    StrategyPresetId.LUMP_SUM,
    StrategyPresetId.GRID_SEARCH,
    StrategyPresetId.RSI_DCA,
    StrategyPresetId.MA_DEVIATION_DCA,
    StrategyPresetId.BOLLINGER_DCA,
    StrategyPresetId.RATE_DCA,
    StrategyPresetId.PE_DCA,
)

EXPECTED_PARAMETER_KEYS = {
    "run.symbol",
    "run.startDate",
    "run.endDate",
    "run.endMode",
    "contribution.day",
    "contribution.amount",
    "data.macroStalenessSessions",
    "data.financialFactMaxAgeDays",
    "data.etfHoldingsMaxAgeDays",
    "accumulation.cashSafetyLimit",
    "accumulation.maxSignalBuysPerMonth",
    "accumulation.conditionLogic",
    "accumulation.fixedDcaEnabled",
    "accumulation.fixedDcaRatio",
    "vix.buyEnabled",
    "vix.symbol",
    "vix.buyThreshold",
    "rsi.buyEnabled",
    "rsi.period",
    "rsi.buyThreshold",
    "ma.buyEnabled",
    "ma.period",
    "ma.buyDeviationPct",
    "bollinger.buyEnabled",
    "bollinger.period",
    "bollinger.stddev",
    "rate.buyEnabled",
    "rate.symbol",
    "rate.thresholdPct",
    "rate.sourceUnit",
    "pe.buyEnabled",
    "pe.threshold",
    "pe.etfMinCoverage",
    "exit.enabled",
    "exit.ratio",
    "exit.vix.low1",
    "exit.vix.ratio1",
    "exit.vix.low2",
    "exit.vix.ratio2",
    "exit.rsi.enabled",
    "exit.rsi.threshold",
    "exit.rsi.ratio",
    "exit.bollinger.enabled",
    "exit.bollinger.ratio",
    "exit.bollinger.vixCeiling",
    "trend.sellBelowOrEqualMa",
    "scheduled.fundingMode",
    "search.dimensions",
    "search.maxCombinations",
    "run.scope",
    "display.showChart",
}


def test_catalog_version_advances_for_shared_condition_templates() -> None:
    assert CATALOG_VERSION == "catalog-v6"


def test_removed_trade_visibility_is_not_a_catalog_parameter() -> None:
    assert "display.showTrades" not in PARAMETER_DEFINITIONS


def test_catalog_exposes_stable_presets_and_five_single_condition_templates() -> None:
    assert tuple(PRESET_DEFINITIONS) == EXPECTED_PRESETS
    assert tuple(EXECUTION_MODULES[preset] for preset in EXPECTED_PRESETS) == (
        ExecutionModule.ACCUMULATION,
        ExecutionModule.ACCUMULATION,
        ExecutionModule.TREND,
        ExecutionModule.TREND,
        ExecutionModule.SCHEDULED,
        ExecutionModule.SCHEDULED,
        ExecutionModule.SEARCH,
        *([ExecutionModule.ACCUMULATION] * 5),
    )


def test_every_notebook_input_and_new_field_has_one_registered_key() -> None:
    assert set(PARAMETER_DEFINITIONS) == EXPECTED_PARAMETER_KEYS


def test_every_parameter_has_complete_stable_metadata() -> None:
    allowed_types = {member.value for member in ParameterType}
    assert PARAMETER_DEFINITIONS
    assert len(PARAMETER_DEFINITIONS) == len(set(PARAMETER_DEFINITIONS))

    for key, definition in PARAMETER_DEFINITIONS.items():
        assert key == definition.key
        assert definition.type.value in allowed_types
        assert definition.translation_key.startswith("parameters.")
        assert definition.group_id in {
            group.id for group in PARAMETER_GROUP_DEFINITIONS
        }
        assert definition.applicable_presets
        if definition.minimum is not None and definition.maximum is not None:
            assert definition.minimum <= definition.maximum
        if definition.step is not None:
            assert definition.step > 0
        if definition.default is not None and definition.minimum is not None:
            assert definition.default >= definition.minimum
        if definition.default is not None and definition.maximum is not None:
            assert definition.default <= definition.maximum


def test_parameter_groups_are_unique_and_every_catalog_field_uses_one() -> None:
    catalog = get_catalog()
    group_ids = [group.id for group in catalog.parameter_groups]
    translation_keys = [group.translation_key for group in catalog.parameter_groups]

    assert len(group_ids) == len(set(group_ids))
    assert len(translation_keys) == len(set(translation_keys))
    assert {parameter.group_id for parameter in catalog.parameters} <= set(group_ids)
    assert catalog.parameter("vix.symbol").group_id == "vix"
    assert catalog.parameter("exit.rsi.threshold").group_id == "sell_signals"


def test_catalog_rejects_duplicate_or_unknown_parameter_groups() -> None:
    definition = ParameterDefinition(
        key="x.foo",
        type=ParameterType.DECIMAL,
        default=Decimal("1"),
        minimum=0,
        translationKey="parameters.x.foo",
        groupId="general",
        applicablePresets=[StrategyPresetId.VIX_DCA],
    )
    general = ParameterGroupDefinition(
        id="general", translationKey="parameterGroups.general"
    )

    with pytest.raises(ValidationError, match="group IDs must be unique"):
        Catalog(
            version="test", parameters=(definition,), parameterGroups=(general, general)
        )
    with pytest.raises(ValidationError, match="unknown group"):
        Catalog(version="test", parameters=(definition,), parameterGroups=())


def test_default_data_settings_materializes_the_registered_staleness_default() -> None:
    settings = default_data_settings()
    definition = get_parameter_definition("data.macroStalenessSessions")
    fact_age = get_parameter_definition("data.financialFactMaxAgeDays")
    holdings_age = get_parameter_definition("data.etfHoldingsMaxAgeDays")

    assert settings.macro_staleness_sessions == definition.default
    assert settings.financial_fact_max_age_days == fact_age.default
    assert settings.etf_holdings_max_age_days == holdings_age.default


def test_macro_staleness_is_a_registered_shared_data_setting() -> None:
    staleness = get_parameter_definition("data.macroStalenessSessions")

    assert staleness.type is ParameterType.INTEGER
    assert staleness.default == 3
    assert staleness.unit == "exchange_session"
    assert staleness.minimum == Decimal("0")
    assert staleness.step == Decimal("1")
    assert staleness.level is ParameterLevel.SHARED
    assert get_parameter_definition("rate.sourceUnit").default == "auto"


def test_valuation_staleness_policies_are_registered_shared_data_settings() -> None:
    fact_age = get_parameter_definition("data.financialFactMaxAgeDays")
    holdings_age = get_parameter_definition("data.etfHoldingsMaxAgeDays")

    assert (fact_age.type, fact_age.default, fact_age.unit, fact_age.minimum) == (
        ParameterType.INTEGER,
        550,
        "calendar_day",
        Decimal("1"),
    )
    assert (
        holdings_age.type,
        holdings_age.default,
        holdings_age.unit,
        holdings_age.minimum,
    ) == (
        ParameterType.INTEGER,
        180,
        "calendar_day",
        Decimal("1"),
    )
    assert fact_age.level is ParameterLevel.SHARED
    assert holdings_age.level is ParameterLevel.SHARED


def test_ratio_and_percent_point_conventions_are_explicit() -> None:
    ratio = get_parameter_definition("accumulation.fixedDcaRatio")
    assert ratio.type is ParameterType.RATIO
    assert ratio.unit == "ratio"
    assert ratio.minimum == Decimal("0")
    assert ratio.maximum == Decimal("1")
    assert ratio.default == Decimal("0.5")

    rate_threshold = get_parameter_definition("rate.thresholdPct")
    assert rate_threshold.type is ParameterType.PERCENT_POINT
    assert rate_threshold.default == Decimal("2.5")


def test_parameter_value_validator_keeps_ratio_range_and_percent_point_scale() -> None:
    ratio = get_parameter_definition("accumulation.fixedDcaRatio")
    rate = get_parameter_definition("rate.thresholdPct")

    validate_parameter_value(ratio, Decimal("0.5"))
    validate_parameter_value(rate, Decimal("2.5"))

    for value in (Decimal("-0.01"), Decimal("1.01")):
        with pytest.raises(ParameterValidationError) as error:
            validate_parameter_value(ratio, value)
        assert error.value.issue is ParameterValueIssue.OUT_OF_RANGE


def test_parameter_value_validator_distinguishes_empty_required_value() -> None:
    symbol = get_parameter_definition("vix.symbol")

    with pytest.raises(ParameterValidationError) as error:
        validate_parameter_value(symbol, "   ")

    assert error.value.issue is ParameterValueIssue.EMPTY_VALUE


def test_periods_are_positive_and_composite_exit_defaults_on() -> None:
    for key in ("rsi.period", "ma.period", "bollinger.period"):
        assert get_parameter_definition(key).minimum == Decimal("1")

    assert get_parameter_definition("exit.enabled").default is True
    assert preset_defaults(StrategyPresetId.VIX_DCA).get("exit.enabled", False) is False


def test_default_vix_preset_uses_shared_parameters_and_expected_defaults() -> None:
    defaults = preset_defaults(StrategyPresetId.VIX_DCA)
    vix_index = get_parameter_definition("vix.symbol")

    assert vix_index.type is ParameterType.ENUM
    assert vix_index.allowed_values == ("^VIX", "^VXN", "^VXD")
    with pytest.raises(ParameterValidationError) as error:
        validate_parameter_value(vix_index, "^RVX")
    assert error.value.issue is ParameterValueIssue.INVALID_CHOICE
    assert defaults["vix.buyEnabled"] is True
    assert defaults["vix.symbol"] == "^VIX"
    assert defaults["vix.buyThreshold"] == Decimal("25")
    assert defaults["accumulation.maxSignalBuysPerMonth"] == 1
    assert defaults["accumulation.cashSafetyLimit"] == Decimal("1200")
    assert defaults.get("exit.enabled", False) is False
    assert "contribution.amount" not in defaults

    assert "vix.buyThreshold" in parameter_keys_for_preset(StrategyPresetId.VIX_DCA)
    assert "contribution.amount" not in parameter_keys_for_preset(
        StrategyPresetId.VIX_DCA
    )


def test_composite_and_trend_presets_share_definitions_without_copying_fields() -> None:
    composite = parameter_keys_for_preset(StrategyPresetId.COMPOSITE_DCA)
    trend = parameter_keys_for_preset(StrategyPresetId.MA_TREND)
    buy_only = parameter_keys_for_preset(StrategyPresetId.MA_BUY_ONLY)

    assert "rsi.buyThreshold" in composite
    assert "pe.threshold" in composite
    assert "ma.period" in composite
    assert "ma.period" in trend
    assert "ma.period" in buy_only
    assert "ma.buyThreshold" not in PARAMETER_DEFINITIONS
    assert (
        get_preset_definition(StrategyPresetId.MA_TREND).default_params[
            "trend.sellBelowOrEqualMa"
        ]
        is True
    )
    assert (
        get_preset_definition(StrategyPresetId.MA_BUY_ONLY).default_params[
            "trend.sellBelowOrEqualMa"
        ]
        is False
    )


def test_grid_search_references_registered_numeric_keys_and_default_ranges() -> None:
    preset = get_preset_definition(StrategyPresetId.GRID_SEARCH)
    assert preset.search_dimensions
    for dimension in preset.search_dimensions:
        definition = get_parameter_definition(dimension.key)
        assert definition.searchable is True
        assert definition.type in {
            ParameterType.INTEGER,
            ParameterType.DECIMAL,
            ParameterType.RATIO,
            ParameterType.PERCENT_POINT,
        }
        assert dimension.values
        assert all(value is not None for value in dimension.values)

    assert preset.default_params["search.maxCombinations"] == 1000
    assert preset.default_params["search.maxCombinations"] <= 10000
    assert {dimension.key for dimension in preset.search_dimensions} == {
        "vix.buyThreshold",
        "rsi.buyThreshold",
        "accumulation.cashSafetyLimit",
        "accumulation.fixedDcaRatio",
    }


def test_catalog_service_returns_a_serializable_snapshot_and_isolation() -> None:
    catalog = get_catalog()
    assert catalog.version == CATALOG_VERSION
    assert tuple(preset.id for preset in catalog.presets) == EXPECTED_PRESETS
    assert {parameter.key for parameter in catalog.parameters} == set(
        PARAMETER_DEFINITIONS
    )

    first = preset_defaults(StrategyPresetId.VIX_DCA)
    first["vix.symbol"] = "CHANGED"
    assert preset_defaults(StrategyPresetId.VIX_DCA)["vix.symbol"] == "^VIX"
    assert catalog.model_dump(by_alias=True)["version"] == CATALOG_VERSION


def test_searchable_parameters_are_filtered_by_preset_applicability() -> None:
    keys = {definition.key for definition in get_searchable_parameters()}
    assert "vix.buyThreshold" in keys
    assert "accumulation.fixedDcaRatio" in keys
    assert "run.symbol" not in keys

    trend_keys = {
        definition.key
        for definition in get_searchable_parameters(StrategyPresetId.MA_TREND)
    }
    assert "vix.buyThreshold" not in trend_keys


def test_catalog_lookups_use_the_snapshot_being_queried() -> None:
    definition = ParameterDefinition(
        key="x.foo",
        type=ParameterType.DECIMAL,
        default=Decimal("1"),
        minimum=0,
        translationKey="parameters.x.foo",
        groupId="general",
        applicablePresets=[StrategyPresetId.VIX_DCA],
    )
    preset = PresetDefinition(
        id=StrategyPresetId.VIX_DCA,
        nameKey="presets.test.name",
        descriptionKey="presets.test.description",
        executionModule=ExecutionModule.SCHEDULED,
        parameterKeys=("x.foo",),
        defaultParams={"x.foo": Decimal("1")},
    )
    snapshot = Catalog(version="test", parameters=(definition,), presets=(preset,))

    assert snapshot.parameter("x.foo") is definition
    assert snapshot.preset(StrategyPresetId.VIX_DCA) is preset
    with pytest.raises(KeyError):
        snapshot.parameter("run.symbol")


def test_parameter_definition_rejects_invalid_metadata() -> None:
    with pytest.raises(ValidationError):
        ParameterDefinition(
            key="x.invalid",
            type="ratio",
            default=2,
            minimum=0,
            maximum=1,
            translationKey="parameters.invalid",
            groupId="general",
            applicablePresets=[StrategyPresetId.VIX_DCA],
        )

    with pytest.raises(ValidationError):
        ParameterDefinition(
            key="x.invalid",
            type="boolean",
            default="enabled",
            translationKey="parameters.invalid",
            groupId="general",
            applicablePresets=[StrategyPresetId.VIX_DCA],
        )

    with pytest.raises(ValidationError):
        ParameterDefinition(
            key="x.invalid",
            type="number_list",
            default=[1, float("nan")],
            translationKey="parameters.invalid",
            groupId="general",
            applicablePresets=[StrategyPresetId.VIX_DCA],
        )

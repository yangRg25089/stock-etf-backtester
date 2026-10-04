from datetime import UTC, date, datetime
from decimal import Decimal

from app.config.diagnostics import provider_request_failed
from app.config.validation import (
    DataKind,
    DraftValidationResult,
    diagnose_capabilities,
    validate_draft,
)
from app.domain.contracts import (
    DataSnapshot,
    MacroObservation,
    MarketBar,
    MarketSnapshot,
    ValuationSnapshot,
)
from app.domain.status import Diagnostic, DiagnosticCode


def _draft(
    *,
    preset_id: str = "composite_dca",
    params: dict[str, object] | None = None,
    include_data_settings: bool = False,
) -> dict[str, object]:
    shared: dict[str, object] = {
        "run": {
            "symbol": "QQQ",
            "startDate": date(2020, 1, 1),
            "endDate": date(2024, 1, 31),
            "endMode": "fixed",
        }
    }
    if include_data_settings:
        from app.catalog.service import default_data_settings

        shared["data"] = default_data_settings().model_dump(by_alias=True)
    return {
        "shared": shared,
        "strategies": [
            {
                "id": "strategy-1",
                "presetId": preset_id,
                "enabled": True,
                "params": {} if params is None else params,
            }
        ],
    }


def _requirement_signals(result: DraftValidationResult) -> set[str]:
    return {requirement.signal_id for requirement in result.data_requirements}


def _data_snapshot(
    *, macro_symbols: tuple[str, ...] = (), include_valuation: bool = False
) -> DataSnapshot:
    market = MarketSnapshot(
        symbol="QQQ",
        currency="USD",
        bars=(
            MarketBar(
                date=date(2024, 1, 2),
                symbol="QQQ",
                simulationPrice=Decimal("400"),
                valuationPrice=Decimal("400"),
                currency="USD",
                source="fixture",
                observedAt=datetime(2024, 1, 2, tzinfo=UTC),
            ),
        ),
        source="fixture",
        fingerprint="market-1",
    )
    macro = tuple(
        MacroObservation(
            date=date(2024, 1, 2),
            symbol=symbol,
            value=Decimal("25"),
            unit="index_point",
            source="fixture",
            observedAt=datetime(2024, 1, 2, tzinfo=UTC),
        )
        for symbol in macro_symbols
    )
    valuation = (
        ValuationSnapshot(
            symbol="QQQ",
            observations=(),
            fingerprint="valuation-1",
        )
        if include_valuation
        else None
    )
    return DataSnapshot(
        market=market,
        macro=macro,
        valuation=valuation,
        fingerprint="data-1",
    )


def test_validation_materializes_defaults_and_keeps_percent_points() -> None:
    result = validate_draft(_draft())

    assert result.valid is True
    config = result.config_for(("strategy-1",))
    assert config is not None
    assert config.shared.data.financial_fact_max_age_days == 550
    assert config.strategies[0].params["rate.thresholdPct"] == Decimal("2.5")


def test_python_field_names_are_not_overwritten_by_catalog_alias_defaults() -> None:
    draft = _draft(include_data_settings=True)
    shared = draft["shared"]
    assert isinstance(shared, dict)
    data = shared["data"]
    assert isinstance(data, dict)
    data.pop("financialFactMaxAgeDays")
    data["financial_fact_max_age_days"] = 123

    result = validate_draft(draft)

    config = result.config_for(("strategy-1",))
    assert config is not None
    assert config.shared.data.financial_fact_max_age_days == 123


def test_ordinary_and_grid_configs_share_ratio_boundaries_and_error_paths() -> None:
    for preset_id in ("composite_dca", "grid_search"):
        draft = _draft(
            preset_id=preset_id,
            params={"exit.ratio": Decimal("1.01")},
        )
        result = validate_draft(draft)
        diagnostics = result.diagnostics_for(("strategy-1",))

        assert result.valid is False
        assert len(diagnostics) == 1
        assert diagnostics[0].code is DiagnosticCode.INVALID_PARAMETER
        assert diagnostics[0].message_key == "diagnostics.configuration.out_of_range"
        assert diagnostics[0].field_path == ("strategies[0].params.exit.ratio")


def test_validation_distinguishes_empty_and_non_applicable_fields() -> None:
    empty_symbol = validate_draft(
        _draft(preset_id="vix_dca", params={"vix.symbol": "   "})
    )
    not_applicable = validate_draft(
        _draft(preset_id="vix_dca", params={"rsi.buyThreshold": Decimal("30")})
    )

    assert empty_symbol.diagnostics_for(("strategy-1",))[0].message_key == (
        "diagnostics.configuration.empty_value"
    )
    assert not_applicable.diagnostics_for(("strategy-1",))[0].message_key == (
        "diagnostics.configuration.not_applicable"
    )


def test_shared_blank_symbol_uses_the_same_empty_value_diagnostic() -> None:
    draft = _draft()
    shared = draft["shared"]
    assert isinstance(shared, dict)
    run = shared["run"]
    assert isinstance(run, dict)
    run["symbol"] = "   "

    result = validate_draft(draft)

    assert result.valid is False
    assert result.diagnostics[0].message_key == (
        "diagnostics.configuration.empty_value"
    )
    assert result.diagnostics[0].field_path == "run.symbol"


def test_validation_distinguishes_missing_and_unknown_parameters() -> None:
    missing = validate_draft(
        _draft(preset_id="vix_dca", params={"vix.buyThreshold": None})
    )
    unknown = validate_draft(
        _draft(preset_id="vix_dca", params={"vix.buyThreshhold": Decimal("25")})
    )

    assert missing.diagnostics_for(("strategy-1",))[0].message_key == (
        "diagnostics.configuration.required_value_missing"
    )
    assert unknown.diagnostics_for(("strategy-1",))[0].message_key == (
        "diagnostics.configuration.unknown_parameter"
    )


def test_explicit_null_shared_group_is_invalid_instead_of_defaulted() -> None:
    draft = _draft()
    shared = draft["shared"]
    assert isinstance(shared, dict)
    shared["data"] = None

    result = validate_draft(draft)

    assert result.valid is False
    assert result.diagnostics[0].message_key == (
        "diagnostics.configuration.invalid_type"
    )
    assert result.diagnostics[0].field_path == "shared.data"


def test_structural_range_errors_map_back_to_catalog_field_keys() -> None:
    draft = _draft(include_data_settings=True)
    shared = draft["shared"]
    assert isinstance(shared, dict)
    data = shared["data"]
    assert isinstance(data, dict)
    data["macroStalenessSessions"] = -1

    result = validate_draft(draft)

    assert result.valid is False
    assert result.diagnostics[0].message_key == (
        "diagnostics.configuration.out_of_range"
    )
    assert result.diagnostics[0].field_path == "data.macroStalenessSessions"


def test_cross_field_errors_use_the_configuration_diagnostic_category() -> None:
    draft = _draft()
    shared = draft["shared"]
    assert isinstance(shared, dict)
    run = shared["run"]
    assert isinstance(run, dict)
    run["startDate"] = date(2024, 1, 31)
    run["endDate"] = date(2024, 1, 1)

    result = validate_draft(draft)

    assert result.valid is False
    assert result.diagnostics[0].message_key == "diagnostics.configuration.cross_field"


def test_invalid_unselected_strategy_does_not_block_selected_valid_strategy() -> None:
    draft = _draft(preset_id="vix_dca")
    draft["strategies"] = [
        {
            "id": "selected",
            "presetId": "vix_dca",
            "enabled": True,
            "params": {},
        },
        {
            "id": "unused-invalid",
            "presetId": "composite_dca",
            "enabled": True,
            "params": {"exit.ratio": Decimal("1.1")},
        },
    ]

    result = validate_draft(draft)

    assert result.valid is False
    assert result.config_for(("selected",)) is not None
    assert result.config_for(("unused-invalid",)) is None
    assert result.diagnostics_for(("selected",)) == ()


def test_grid_combination_limit_uses_selected_registered_dimensions() -> None:
    result = validate_draft(
        _draft(
            preset_id="grid_search",
            params={
                "search.dimensions": ["vix.buyThreshold"],
                "search.maxCombinations": 3,
            },
        )
    )

    diagnostics = result.diagnostics_for(("strategy-1",))
    assert result.valid is False
    assert diagnostics[0].message_key == (
        "diagnostics.configuration.too_many_combinations"
    )
    assert diagnostics[0].field_path == ("strategies[0].params.search.maxCombinations")


def test_grid_limits_use_configured_values_and_ignore_unselected_value_buffers() -> (
    None
):
    result = validate_draft(
        _draft(
            preset_id="grid_search",
            params={
                "search.dimensions": ["vix.buyThreshold"],
                "search.values.vix.buyThreshold": [29, 31],
                "search.values.rsi.buyThreshold": [],
                "search.maxCombinations": 2,
            },
        )
    )
    assert result.valid is True
    config = result.config_for(("strategy-1",))
    assert config is not None
    assert config.strategies[0].params["search.values.vix.buyThreshold"] == (29, 31)
    assert config.strategies[0].params["search.values.rsi.buyThreshold"] == ()


def test_invalid_selected_grid_values_have_registered_error_paths() -> None:
    for values in ([], [25, 25], [-1], ["25 USD"], [True], [float("inf")]):
        result = validate_draft(
            _draft(
                preset_id="grid_search",
                params={
                    "search.dimensions": ["vix.buyThreshold"],
                    "search.values.vix.buyThreshold": values,
                },
            )
        )
        diagnostics = result.diagnostics_for(("strategy-1",))
        assert result.valid is False
        assert any(
            d.field_path == "strategies[0].params.search.values.vix.buyThreshold"
            and d.message_key != "diagnostics.configuration.unknown_parameter"
            for d in diagnostics
        )


def test_enabled_signal_requirements_do_not_depend_on_and_or_logic() -> None:
    params: dict[str, object] = {
        "accumulation.conditionLogic": "OR",
        "vix.buyEnabled": True,
        "rsi.buyEnabled": True,
        "ma.buyEnabled": False,
        "bollinger.buyEnabled": False,
        "rate.buyEnabled": True,
        "pe.buyEnabled": True,
        "exit.enabled": True,
        "exit.rsi.enabled": True,
        "exit.bollinger.enabled": False,
    }
    disjunction = validate_draft(_draft(params=params))
    params["accumulation.conditionLogic"] = "AND"
    conjunction = validate_draft(_draft(params=params))

    expected = {
        "market.price",
        "vix.buy",
        "vix.exit",
        "rsi.buy",
        "rsi.exit",
        "rate.buy",
        "pe.buy",
    }
    assert disjunction.valid is True
    assert conjunction.valid is True
    assert _requirement_signals(disjunction) == expected
    assert _requirement_signals(conjunction) == expected


def test_disabling_buy_does_not_disable_an_independent_sell_dependency() -> None:
    result = validate_draft(
        _draft(
            params={
                "vix.buyEnabled": False,
                "exit.enabled": True,
                "rsi.buyEnabled": False,
                "ma.buyEnabled": False,
                "bollinger.buyEnabled": False,
                "exit.rsi.enabled": True,
                "rate.buyEnabled": False,
                "pe.buyEnabled": False,
            }
        )
    )

    assert result.valid is True
    assert _requirement_signals(result) == {
        "market.price",
        "vix.exit",
        "rsi.exit",
    }


def test_disabled_vix_signal_creates_no_macro_requirement() -> None:
    result = validate_draft(
        _draft(
            preset_id="vix_dca",
            params={"vix.buyEnabled": False, "exit.enabled": False},
        )
    )
    snapshot = _data_snapshot()

    assert result.valid is True
    assert _requirement_signals(result) == {"market.price"}
    assert diagnose_capabilities(result, snapshot) == ()


def test_or_does_not_hide_missing_enabled_rate_or_pe_capabilities() -> None:
    result = validate_draft(
        _draft(
            params={
                "accumulation.conditionLogic": "OR",
                "vix.buyEnabled": True,
                "rate.buyEnabled": True,
                "pe.buyEnabled": True,
            }
        )
    )
    diagnostics = diagnose_capabilities(
        result,
        _data_snapshot(macro_symbols=("^VIX",)),
        strategy_ids=("strategy-1",),
    )

    assert {diagnostic.field_path for diagnostic in diagnostics} == {
        "strategies[0].rules.buy.children[4].params.rate.symbol",
        "strategies[0].rules.buy.children[5].params.pe.threshold",
    }
    assert all(
        diagnostic.code is DiagnosticCode.REQUIRED_DATA_UNAVAILABLE
        for diagnostic in diagnostics
    )


def test_provider_failure_and_diagnostics_have_a_stable_json_contract() -> None:
    provider_error = provider_request_failed(
        source="sec:companyfacts",
        field_path="run.symbol",
    )
    diagnostic_schema = Diagnostic.model_json_schema(by_alias=True)
    validation_schema = DraftValidationResult.model_json_schema(by_alias=True)

    assert provider_error.code is DiagnosticCode.PROVIDER_REQUEST_FAILED
    assert provider_error.message_key == "diagnostics.provider.request_failed"
    assert {"code", "messageKey", "fieldPath"}.issubset(diagnostic_schema["properties"])
    assert "dataRequirements" in validation_schema["properties"]
    assert DataKind.MACRO.value == "macro"

"""Catalog-backed draft validation and enabled data dependency resolution."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from decimal import Decimal
from enum import StrEnum
from math import prod

from pydantic import BaseModel, Field, ValidationError

from app.catalog.definitions import (
    ParameterLevel,
    ParameterType,
    ParameterValidationError,
    validate_parameter_value,
)
from app.catalog.presets import ExecutionModule, PresetDefinition
from app.catalog.service import Catalog, get_catalog
from app.domain.contracts import (
    ContributionSettings,
    DataSettings,
    DataSnapshot,
    FrozenRunConfig,
    FrozenStrategyInstance,
    RunConfig,
    RunSettings,
    SharedSettings,
    StrategyInstance,
    StrategyPresetId,
)
from app.domain.immutability import thaw_value
from app.domain.status import Diagnostic, DomainModel

from .conditions import materialize_legacy_rules, normalize_rules
from .diagnostics import (
    ConfigurationIssue,
    invalid_parameter,
    required_data_unavailable,
)

_SHARED_MODEL_TYPES: dict[str, type[BaseModel]] = {
    "run": RunSettings,
    "contribution": ContributionSettings,
    "data": DataSettings,
}


class DataKind(StrEnum):
    MARKET = "market"
    MACRO = "macro"
    VALUATION = "valuation"


class DataRequirement(DomainModel):
    """One enabled signal dependency resolved to a normalized data source."""

    strategy_id: str = Field(alias="strategyId", min_length=1)
    signal_id: str = Field(alias="signalId", min_length=1)
    kind: DataKind
    symbol: str = Field(min_length=1)
    field_path: str = Field(alias="fieldPath", min_length=1)


class StrategyValidationResult(DomainModel):
    """Independent validation outcome so unused strategies cannot block a run."""

    strategy_id: str = Field(alias="strategyId", min_length=1)
    preset_id: StrategyPresetId = Field(alias="presetId")
    enabled: bool
    normalized: FrozenStrategyInstance | None = None
    diagnostics: tuple[Diagnostic, ...] = ()


class DraftValidationResult(DomainModel):
    """Shared and per-strategy validation results plus enabled data needs."""

    shared_settings: SharedSettings | None = Field(default=None, alias="sharedSettings")
    diagnostics: tuple[Diagnostic, ...] = ()
    strategies: tuple[StrategyValidationResult, ...] = ()
    data_requirements: tuple[DataRequirement, ...] = Field(
        default=(), alias="dataRequirements"
    )

    @property
    def valid(self) -> bool:
        return (
            self.shared_settings is not None
            and not self.diagnostics
            and all(not strategy.diagnostics for strategy in self.strategies)
        )

    def diagnostics_for(
        self, strategy_ids: Iterable[str] | None = None
    ) -> tuple[Diagnostic, ...]:
        """Return shared errors and errors for the selected strategy subset."""

        selected = None if strategy_ids is None else set(strategy_ids)
        return (
            *self.diagnostics,
            *(
                diagnostic
                for strategy in self.strategies
                if selected is None or strategy.strategy_id in selected
                for diagnostic in strategy.diagnostics
            ),
        )

    def config_for(
        self, strategy_ids: Iterable[str] | None = None
    ) -> FrozenRunConfig | None:
        """Build a frozen config for valid selected instances only."""

        if self.shared_settings is None or self.diagnostics:
            return None
        selected = None if strategy_ids is None else set(strategy_ids)
        strategies = tuple(
            strategy
            for strategy in self.strategies
            if selected is None or strategy.strategy_id in selected
        )
        if not strategies or any(
            strategy.normalized is None or strategy.diagnostics
            for strategy in strategies
        ):
            return None
        if selected is not None and selected.difference(
            strategy.strategy_id for strategy in strategies
        ):
            return None
        return FrozenRunConfig(
            shared=self.shared_settings,
            strategies=tuple(
                strategy.normalized
                for strategy in strategies
                if strategy.normalized is not None
            ),
        )


def validate_draft(
    draft: RunConfig | Mapping[str, object],
    catalog: Catalog | None = None,
) -> DraftValidationResult:
    """Validate a draft using catalog metadata and materialize its defaults.

    Structural errors are returned separately from strategy errors, allowing
    run orchestration to validate only the instances selected by run scope.
    """

    source = get_catalog() if catalog is None else catalog
    parsed = draft
    if not isinstance(draft, RunConfig):
        if not isinstance(draft, Mapping):
            raise TypeError("draft must be a RunConfig or mapping")
        try:
            parsed = RunConfig.model_validate(
                _materialize_shared_defaults(draft, source)
            )
        except ValidationError as error:
            return DraftValidationResult(
                diagnostics=_pydantic_diagnostics(error, source)
            )

    if not isinstance(parsed, RunConfig):
        raise TypeError("draft must be a RunConfig or mapping")

    shared_diagnostics = _validate_shared(parsed.shared, source)
    strategy_results: list[StrategyValidationResult] = []
    requirements: list[DataRequirement] = []
    for index, strategy in enumerate(parsed.strategies):
        result = _validate_strategy(index, strategy, source)
        strategy_results.append(result)
        if result.enabled and result.normalized is not None:
            requirements.extend(
                _requirements_for_strategy(
                    index,
                    result.normalized,
                    parsed.shared.run.symbol,
                    source,
                )
            )
    return DraftValidationResult(
        sharedSettings=parsed.shared,
        diagnostics=shared_diagnostics,
        strategies=tuple(strategy_results),
        dataRequirements=tuple(requirements),
    )


def diagnose_capabilities(
    validation: DraftValidationResult,
    snapshot: DataSnapshot,
    *,
    strategy_ids: Iterable[str] | None = None,
) -> tuple[Diagnostic, ...]:
    """Report missing normalized data capabilities for selected valid strategies."""

    selected = None if strategy_ids is None else set(strategy_ids)
    missing: dict[tuple[str, DataKind, str], DataRequirement] = {}
    for requirement in validation.data_requirements:
        if selected is not None and requirement.strategy_id not in selected:
            continue
        key = (requirement.strategy_id, requirement.kind, requirement.symbol)
        if key in missing or _has_capability(snapshot, requirement):
            continue
        missing[key] = requirement
    return tuple(
        required_data_unavailable(
            field_path=requirement.field_path,
            data_kind=requirement.kind.value,
            symbol=requirement.symbol,
            signal_id=requirement.signal_id,
            strategy_id=requirement.strategy_id,
        )
        for requirement in missing.values()
    )


def _materialize_shared_defaults(
    draft: Mapping[str, object], catalog: Catalog
) -> Mapping[str, object]:
    """Fill absent shared fields from their one catalog definition."""

    values = dict(draft)
    raw_shared = values.get("shared")
    if not isinstance(raw_shared, Mapping):
        return values
    shared = dict(raw_shared)
    for group in ("run", "contribution", "data"):
        if group in shared and not isinstance(shared[group], Mapping):
            continue
        raw_group = shared.get(group, {})
        group_values = dict(raw_group)
        for definition in catalog.parameters:
            if definition.level is not ParameterLevel.SHARED:
                continue
            parameter_group, separator, field_name = definition.key.partition(".")
            if not separator or parameter_group != group:
                continue
            if definition.default is None or _has_field_value(
                group_values, group, field_name
            ):
                continue
            group_values[field_name] = thaw_value(definition.default)
        shared[group] = group_values
    values["shared"] = shared
    return values


def _has_field_value(values: Mapping[str, object], group: str, alias: str) -> bool:
    if alias in values:
        return True
    model_type = _SHARED_MODEL_TYPES[group]
    return any(
        name in values and (info.alias or name) == alias
        for name, info in model_type.model_fields.items()
    )


def _validate_shared(
    shared: SharedSettings, catalog: Catalog
) -> tuple[Diagnostic, ...]:
    diagnostics: list[Diagnostic] = []
    groups = {
        "run": shared.run,
        "contribution": shared.contribution,
        "data": shared.data,
    }
    for definition in catalog.parameters:
        if definition.level is not ParameterLevel.SHARED:
            continue
        group, separator, field_name = definition.key.partition(".")
        if not separator or group not in groups:
            continue
        value = _model_field_value(groups[group], field_name)
        if value is _MISSING:
            continue
        try:
            validate_parameter_value(definition, value)
        except ParameterValidationError as error:
            diagnostics.append(
                invalid_parameter(
                    issue=error.issue,
                    field_path=definition.key,
                    details={"parameterKey": definition.key},
                )
            )
    return tuple(diagnostics)


_MISSING = object()


def _model_field_value(model: object, alias: str) -> object:
    model_fields = getattr(type(model), "model_fields", {})
    for field_name, field in model_fields.items():
        if (field.alias or field_name) == alias or field_name == alias:
            return getattr(model, field_name)
    return _MISSING


def _validate_strategy(
    index: int, strategy: StrategyInstance, catalog: Catalog
) -> StrategyValidationResult:
    diagnostics: list[Diagnostic] = []
    try:
        preset = catalog.preset(strategy.preset_id)
    except KeyError:
        return StrategyValidationResult(
            strategyId=strategy.id,
            presetId=strategy.preset_id,
            enabled=strategy.enabled,
            diagnostics=(
                invalid_parameter(
                    issue=ConfigurationIssue.INVALID_CHOICE,
                    field_path=f"strategies[{index}].presetId",
                ),
            ),
        )

    definitions = {definition.key: definition for definition in catalog.parameters}
    applicable_keys = set(preset.parameter_keys)
    valid_overrides: dict[str, object] = {}
    for key, value in strategy.params.items():
        path = f"strategies[{index}].params.{key}"
        definition = definitions.get(key)
        if definition is None:
            diagnostics.append(
                invalid_parameter(
                    issue=ConfigurationIssue.UNKNOWN_PARAMETER,
                    field_path=path,
                    details={"parameterKey": key},
                )
            )
        elif (
            key not in applicable_keys or preset.id not in definition.applicable_presets
        ):
            diagnostics.append(
                invalid_parameter(
                    issue=ConfigurationIssue.NOT_APPLICABLE,
                    field_path=path,
                    details={"parameterKey": key, "presetId": preset.id.value},
                )
            )
        else:
            valid_overrides[key] = value

    resolved: dict[str, object] = {}
    for key in preset.parameter_keys:
        definition = definitions.get(key)
        if definition is None:
            diagnostics.append(
                invalid_parameter(
                    issue=ConfigurationIssue.UNKNOWN_PARAMETER,
                    field_path=f"strategies[{index}].params.{key}",
                    details={"parameterKey": key},
                )
            )
            continue
        value = valid_overrides.get(
            key,
            preset.default_params.get(key, definition.default),
        )
        try:
            validate_parameter_value(definition, value)
        except ParameterValidationError as error:
            diagnostics.append(
                invalid_parameter(
                    issue=error.issue,
                    field_path=f"strategies[{index}].params.{key}",
                    details={"parameterKey": key},
                )
            )
            continue
        resolved[key] = _normalize_value(definition.type, value)

    if not diagnostics and preset.execution_module is ExecutionModule.SEARCH:
        diagnostics.extend(
            _validate_search_dimensions(index, resolved, preset, catalog)
        )
    rules = None
    submitted_rules = (
        strategy.rules
        if strategy.rules is not None
        else materialize_legacy_rules(preset, resolved)
    )
    if submitted_rules is not None:
        rules, rule_diagnostics = normalize_rules(
            submitted_rules,
            preset,
            catalog,
            f"strategies[{index}].rules",
            _normalize_value,
        )
        diagnostics.extend(rule_diagnostics)
    if diagnostics:
        return StrategyValidationResult(
            strategyId=strategy.id,
            presetId=strategy.preset_id,
            enabled=strategy.enabled,
            diagnostics=tuple(diagnostics),
        )

    normalized = FrozenStrategyInstance(
        id=strategy.id,
        presetId=strategy.preset_id,
        enabled=strategy.enabled,
        params=resolved,
        rules=rules,
    )
    return StrategyValidationResult(
        strategyId=strategy.id,
        presetId=strategy.preset_id,
        enabled=strategy.enabled,
        normalized=normalized,
    )


def _normalize_value(parameter_type: ParameterType, value: object) -> object:
    if parameter_type in {
        ParameterType.DECIMAL,
        ParameterType.RATIO,
        ParameterType.PERCENT_POINT,
    }:
        return Decimal(str(value))
    if parameter_type is ParameterType.SYMBOL and isinstance(value, str):
        return value.strip()
    if parameter_type in {ParameterType.ENUM_LIST, ParameterType.NUMBER_LIST}:
        return tuple(value)  # type: ignore[arg-type]
    return thaw_value(value)


def _validate_search_dimensions(
    index: int,
    params: Mapping[str, object],
    preset: PresetDefinition,
    catalog: Catalog,
) -> tuple[Diagnostic, ...]:
    raw_dimension_keys = params.get("search.dimensions", ())
    if not isinstance(raw_dimension_keys, (list, tuple)) or any(
        not isinstance(key, str) for key in raw_dimension_keys
    ):
        return ()
    dimension_keys = tuple(raw_dimension_keys)
    dimensions = {dimension.key: dimension for dimension in preset.search_dimensions}
    diagnostics: list[Diagnostic] = []
    for key in dimension_keys:
        dimension = dimensions.get(key)
        definition = next(
            (item for item in catalog.parameters if item.key == key),
            None,
        )
        if (
            dimension is None
            or definition is None
            or not definition.searchable
            or definition.type
            not in {
                ParameterType.INTEGER,
                ParameterType.DECIMAL,
                ParameterType.RATIO,
                ParameterType.PERCENT_POINT,
            }
            or preset.id not in definition.applicable_presets
        ):
            diagnostics.append(
                invalid_parameter(
                    issue=ConfigurationIssue.INVALID_CHOICE,
                    field_path=f"strategies[{index}].params.search.dimensions",
                    details={"dimensionKey": key},
                )
            )
    if diagnostics:
        return tuple(diagnostics)
    combinations = prod(len(dimensions[key].values) for key in dimension_keys)
    maximum = params.get("search.maxCombinations")
    if isinstance(maximum, int) and combinations > maximum:
        diagnostics.append(
            invalid_parameter(
                issue=ConfigurationIssue.TOO_MANY_COMBINATIONS,
                field_path=f"strategies[{index}].params.search.maxCombinations",
                details={"combinationCount": combinations, "maximum": maximum},
            )
        )
    return tuple(diagnostics)


def _requirements_for_strategy(
    index: int,
    strategy: FrozenStrategyInstance,
    symbol: str,
    catalog: Catalog,
) -> tuple[DataRequirement, ...]:
    preset = catalog.preset(strategy.preset_id)
    keys = set(preset.parameter_keys)
    params = strategy.params
    requirements = [
        DataRequirement(
            strategyId=strategy.id,
            signalId="market.price",
            kind=DataKind.MARKET,
            symbol=symbol,
            fieldPath="run.symbol",
        )
    ]

    def enabled(key: str) -> bool:
        return key in keys and params.get(key) is True

    def add(
        signal_id: str,
        kind: DataKind,
        data_symbol: str,
        enabled_key: str,
    ) -> None:
        requirements.append(
            DataRequirement(
                strategyId=strategy.id,
                signalId=signal_id,
                kind=kind,
                symbol=data_symbol,
                fieldPath=f"strategies[{index}].params.{enabled_key}",
            )
        )

    vix_symbol = str(params.get("vix.symbol", ""))
    if enabled("vix.buyEnabled"):
        add("vix.buy", DataKind.MACRO, vix_symbol, "vix.buyEnabled")
    if enabled("exit.enabled") and "exit.vix.low1" in keys:
        add("vix.exit", DataKind.MACRO, vix_symbol, "exit.enabled")
    if enabled("rsi.buyEnabled"):
        add("rsi.buy", DataKind.MARKET, symbol, "rsi.buyEnabled")
    if enabled("exit.enabled") and enabled("exit.rsi.enabled"):
        add("rsi.exit", DataKind.MARKET, symbol, "exit.rsi.enabled")
    if enabled("ma.buyEnabled"):
        add("ma.buy", DataKind.MARKET, symbol, "ma.buyEnabled")
    if preset.execution_module is ExecutionModule.TREND:
        add("ma.trend", DataKind.MARKET, symbol, "ma.period")
    if enabled("bollinger.buyEnabled"):
        add("bollinger.buy", DataKind.MARKET, symbol, "bollinger.buyEnabled")
    if enabled("exit.enabled") and enabled("exit.bollinger.enabled"):
        add(
            "bollinger.exit",
            DataKind.MARKET,
            symbol,
            "exit.bollinger.enabled",
        )
        add(
            "bollinger.exit.vix",
            DataKind.MACRO,
            vix_symbol,
            "exit.bollinger.enabled",
        )
    if enabled("rate.buyEnabled"):
        add(
            "rate.buy",
            DataKind.MACRO,
            str(params.get("rate.symbol", "")),
            "rate.buyEnabled",
        )
    if enabled("pe.buyEnabled"):
        add("pe.buy", DataKind.VALUATION, symbol, "pe.buyEnabled")
    return tuple(requirements)


def _has_capability(snapshot: DataSnapshot, requirement: DataRequirement) -> bool:
    if requirement.kind is DataKind.MARKET:
        return snapshot.market.symbol == requirement.symbol and bool(
            snapshot.market.bars
        )
    if requirement.kind is DataKind.MACRO:
        return any(
            observation.symbol == requirement.symbol for observation in snapshot.macro
        )
    return (
        snapshot.valuation is not None
        and snapshot.valuation.symbol == requirement.symbol
        and bool(snapshot.valuation.observations)
    )


def _pydantic_diagnostics(
    error: ValidationError, catalog: Catalog
) -> tuple[Diagnostic, ...]:
    diagnostics: list[Diagnostic] = []
    for item in error.errors():
        error_type = str(item.get("type", "value_error"))
        diagnostics.append(
            invalid_parameter(
                issue=_pydantic_issue(error_type, item.get("loc", ())),
                field_path=_pydantic_field_path(item.get("loc", ()), catalog),
                details={"validationType": error_type},
            )
        )
    return tuple(diagnostics)


def _pydantic_issue(error_type: str, loc: object) -> ConfigurationIssue:
    if error_type == "missing":
        return ConfigurationIssue.REQUIRED
    if error_type == "extra_forbidden":
        return ConfigurationIssue.UNKNOWN_PARAMETER
    if error_type in {"enum", "literal_error"}:
        return ConfigurationIssue.INVALID_CHOICE
    if error_type == "string_too_short":
        return ConfigurationIssue.EMPTY_VALUE
    if (
        error_type == "value_error"
        and isinstance(loc, (list, tuple))
        and len(loc) >= 2
        and loc[0] == "shared"
        and loc[1] == "run"
    ):
        return ConfigurationIssue.CROSS_FIELD
    if "greater_than" in error_type or "less_than" in error_type:
        return ConfigurationIssue.OUT_OF_RANGE
    if error_type.endswith("_type"):
        return ConfigurationIssue.INVALID_TYPE
    return ConfigurationIssue.INVALID_VALUE


def _pydantic_field_path(loc: object, catalog: Catalog) -> str:
    if not isinstance(loc, (list, tuple)):
        return "config"
    parts = list(loc)
    if len(parts) >= 3 and parts[0] == "shared":
        group = str(parts[1])
        field = str(parts[2])
        model_type = _SHARED_MODEL_TYPES.get(group)
        model_fields = {} if model_type is None else model_type.model_fields
        field_alias = next(
            (
                info.alias or name
                for name, info in model_fields.items()
                if name == field or (info.alias or name) == field
            ),
            field,
        )
        for definition in catalog.parameters:
            key_group, separator, key_field = definition.key.partition(".")
            if key_group == group and separator and key_field == field_alias:
                return definition.key
    output = ""
    for part in parts:
        if isinstance(part, int):
            output += f"[{part}]"
        else:
            output += ("." if output else "") + str(part)
    return output or "config"

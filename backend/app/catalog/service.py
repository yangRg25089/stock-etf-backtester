"""Catalog assembly and read-only lookup helpers."""

from copy import deepcopy
from datetime import date
from functools import lru_cache
from typing import Final

from pydantic import Field, model_validator

from app.domain.conditions import CONDITION_LIMITS, ConditionLimits
from app.domain.contracts import DataSettings, StrategyPresetId
from app.domain.immutability import thaw_value
from app.domain.status import DomainModel

from .conditions import CONDITION_DEFINITIONS, ConditionDefinition
from .definitions import (
    ALL_PARAMETER_DEFINITIONS,
    PARAMETER_DEFINITIONS,
    PARAMETER_GROUP_DEFINITIONS,
    ParameterDefinition,
    ParameterGroupDefinition,
    ParameterLevel,
    ParameterType,
    get_parameter_definition,
    validate_parameter_value,
)
from .presets import (
    PRESET_DEFINITIONS,
    PresetDefinition,
    get_preset_definition,
)

CATALOG_VERSION: Final[str] = "catalog-v19"


class SymbolSuggestion(DomainModel):
    symbol: str
    name: str
    currency: str
    source: str


SYMBOL_SUGGESTIONS = (
    SymbolSuggestion(
        symbol="QQQ",
        name="Nasdaq-100",
        currency="USD",
        source="https://www.invesco.com/qqq-etf/en/home.html",
    ),
    SymbolSuggestion(
        symbol="SPY",
        name="S&P 500",
        currency="USD",
        source="https://www.ssga.com/us/en/individual/etfs/state-street-spdr-sp-500-etf-trust-spy",
    ),
    SymbolSuggestion(
        symbol="VOO",
        name="S&P 500",
        currency="USD",
        source="https://investor.vanguard.com/investment-products/etfs/profile/voo",
    ),
    SymbolSuggestion(
        symbol="VTI",
        name="Total Stock Market",
        currency="USD",
        source="https://investor.vanguard.com/investment-products/etfs/profile/vti",
    ),
    SymbolSuggestion(
        symbol="IVV",
        name="S&P 500",
        currency="USD",
        source="https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf-ivv",
    ),
)


class StrategyLimits(DomainModel):
    max_instances_per_preset: int = Field(
        default=5, alias="maxInstancesPerPreset", ge=1
    )
    max_total_instances: int = Field(default=10, alias="maxTotalInstances", ge=1)


class Catalog(DomainModel):
    """Serializable immutable catalog snapshot consumed by API/UI layers."""

    version: str = Field(min_length=1)
    parameters: tuple[ParameterDefinition, ...] = ()
    parameter_groups: tuple[ParameterGroupDefinition, ...] = Field(
        default=PARAMETER_GROUP_DEFINITIONS, alias="parameterGroups"
    )
    presets: tuple[PresetDefinition, ...] = ()
    conditions: tuple[ConditionDefinition, ...] = ()
    condition_limits: ConditionLimits = Field(
        default=CONDITION_LIMITS, alias="conditionLimits"
    )
    symbol_suggestions: tuple[SymbolSuggestion, ...] = Field(
        default=SYMBOL_SUGGESTIONS, alias="symbolSuggestions"
    )
    strategy_limits: StrategyLimits = Field(
        default_factory=StrategyLimits, alias="strategyLimits"
    )

    @model_validator(mode="after")
    def validate_references(self) -> "Catalog":
        definitions = {parameter.key: parameter for parameter in self.parameters}
        if len(definitions) != len(self.parameters):
            raise ValueError("catalog parameter keys must be unique")
        groups = {group.id: group for group in self.parameter_groups}
        if len(groups) != len(self.parameter_groups):
            raise ValueError("catalog parameter group IDs must be unique")
        group_translation_keys = {
            group.translation_key for group in self.parameter_groups
        }
        if len(group_translation_keys) != len(self.parameter_groups):
            raise ValueError("catalog parameter group translation keys must be unique")
        for parameter in self.parameters:
            if parameter.group_id not in groups:
                raise ValueError(
                    "parameter references unknown group: "
                    f"{parameter.key} -> {parameter.group_id}"
                )
        for condition in self.conditions:
            for key in (*condition.buy_parameter_keys, *condition.sell_parameter_keys):
                if key not in definitions:
                    raise ValueError(f"condition references unknown parameter: {key}")
        if len({condition.kind for condition in self.conditions}) != len(
            self.conditions
        ):
            raise ValueError("catalog condition kinds must be unique")
        preset_ids = {preset.id for preset in self.presets}
        if len(preset_ids) != len(self.presets):
            raise ValueError("catalog preset IDs must be unique")
        for preset in self.presets:
            for key in preset.parameter_keys:
                definition = definitions.get(key)
                if definition is None:
                    raise ValueError(f"preset references unknown parameter: {key}")
                if preset.id not in definition.applicable_presets:
                    raise ValueError(
                        f"parameter {key} is not applicable to {preset.id.value}"
                    )
                validate_parameter_value(
                    definition, preset.default_params.get(key, definition.default)
                )
            for dimension in preset.search_dimensions:
                if dimension.values_parameter_key:
                    values_definition = definitions.get(dimension.values_parameter_key)
                    if (
                        values_definition is None
                        or values_definition.type is not ParameterType.NUMBER_LIST
                        or values_definition.key not in preset.parameter_keys
                    ):
                        raise ValueError(
                            "search values reference an invalid number list: "
                            f"{dimension.key}"
                        )
                definition = definitions.get(dimension.key)
                if definition is None:
                    raise ValueError(
                        f"search references unknown parameter: {dimension.key}"
                    )
                if not definition.searchable:
                    raise ValueError(
                        f"search parameter is not searchable: {dimension.key}"
                    )
                if definition.type not in {
                    ParameterType.INTEGER,
                    ParameterType.DECIMAL,
                    ParameterType.RATIO,
                    ParameterType.PERCENT_POINT,
                }:
                    raise ValueError(
                        f"search parameter is not numeric: {dimension.key}"
                    )
                if preset.id not in definition.applicable_presets:
                    raise ValueError(
                        "search parameter "
                        f"{dimension.key} is not applicable to {preset.id.value}"
                    )
                for value in dimension.values:
                    validate_parameter_value(definition, value)
            if preset.execution_module.value == "search":
                declared = preset.default_params.get("search.dimensions", ())
                dimension_keys = tuple(
                    dimension.key for dimension in preset.search_dimensions
                )
                if not isinstance(declared, (list, tuple)):
                    raise ValueError(
                        f"search defaults are not a list: {preset.id.value}"
                    )
                if tuple(declared) != dimension_keys:
                    raise ValueError(
                        f"search defaults and dimensions differ: {preset.id.value}"
                    )
        return self

    def parameter(self, key: str) -> ParameterDefinition:
        """Look up a definition within this immutable catalog snapshot."""

        for definition in self.parameters:
            if definition.key == key:
                return definition
        raise KeyError(f"unknown parameter key: {key}")

    def preset(self, preset_id: StrategyPresetId | str) -> PresetDefinition:
        """Look up a preset within this immutable catalog snapshot."""

        try:
            stable_id = StrategyPresetId(preset_id)
        except ValueError as error:
            raise KeyError(f"unknown strategy preset: {preset_id}") from error
        for preset in self.presets:
            if preset.id == stable_id:
                return preset
        raise KeyError(f"unknown strategy preset: {stable_id.value}")

    @property
    def catalog_version(self) -> str:
        """Alias used by snapshot contracts that name the version explicitly."""

        return self.version

    def __getitem__(self, key: str) -> object:
        """Provide read-only mapping-style access for API adapters."""

        if key not in {
            "version",
            "parameters",
            "parameterGroups",
            "presets",
            "conditions",
            "conditionLimits",
            "symbolSuggestions",
            "strategyLimits",
        }:
            raise KeyError(key)
        return getattr(
            self,
            {
                "parameterGroups": "parameter_groups",
                "conditionLimits": "condition_limits",
                "symbolSuggestions": "symbol_suggestions",
                "strategyLimits": "strategy_limits",
            }.get(key, key),
        )


def get_catalog() -> Catalog:
    """Resolve today's default without retaining yesterday across midnight."""
    return _catalog_for_day(date.today())


@lru_cache(maxsize=2)
def _catalog_for_day(today: date) -> Catalog:

    catalog = Catalog(
        version=CATALOG_VERSION,
        parameters=tuple(
            parameter.model_copy(update={"default": today})
            if parameter.key == "run.endDate"
            else parameter
            for parameter in ALL_PARAMETER_DEFINITIONS
        ),
        presets=tuple(PRESET_DEFINITIONS.values()),
        conditions=CONDITION_DEFINITIONS,
    )
    # Keep this check close to assembly so a future edit cannot quietly create a
    # second set of search-only fields or a dangling preset reference.
    for preset in catalog.presets:
        for key in preset.default_params:
            if key not in PARAMETER_DEFINITIONS:
                raise RuntimeError(f"unknown preset default parameter: {key}")
    return catalog


def default_data_settings() -> DataSettings:
    """Materialize shared data-policy defaults from their catalog definition."""

    values: dict[str, int] = {}
    setting_keys = {
        "data.macroStalenessSessions": "macroStalenessSessions",
    }
    for key, setting_name in setting_keys.items():
        definition = get_parameter_definition(key)
        default = definition.default
        if isinstance(default, bool) or not isinstance(default, int):
            raise RuntimeError(f"{key} catalog default must be an integer")
        validate_parameter_value(definition, default)
        values[setting_name] = default
    return DataSettings.model_validate(values)


def parameter_keys_for_preset(
    preset_id: StrategyPresetId | str,
    *,
    include_shared: bool = False,
    include_ui: bool = False,
) -> tuple[str, ...]:
    """Return stable editable keys in the preset's declared order.

    Shared run/contribution values are normally owned by ``SharedSettings`` and
    UI-only state never enters a strategy calculation.  Callers can opt into
    either category for catalog editors that need the complete form.
    """

    preset = get_preset_definition(preset_id)
    keys: list[str] = []
    for key in preset.parameter_keys:
        definition = get_parameter_definition(key)
        if definition.level is ParameterLevel.SHARED and not include_shared:
            continue
        if definition.level is ParameterLevel.UI and not include_ui:
            continue
        keys.append(key)
    return tuple(keys)


def get_searchable_parameters(
    preset_id: StrategyPresetId | str | None = None,
) -> tuple[ParameterDefinition, ...]:
    """List searchable scalar numeric definitions, optionally by preset."""

    if preset_id is None:
        return tuple(
            definition
            for definition in ALL_PARAMETER_DEFINITIONS
            if definition.searchable
        )
    stable_id = get_preset_definition(preset_id).id
    return tuple(
        definition
        for definition in ALL_PARAMETER_DEFINITIONS
        if definition.searchable and stable_id in definition.applicable_presets
    )


def preset_defaults(preset_id: StrategyPresetId | str) -> dict[str, object]:
    """Return an isolated mutable copy of one preset's defaults."""

    defaults = {
        key: thaw_value(value)
        for key, value in get_preset_definition(preset_id).default_params.items()
    }
    return deepcopy(defaults)


def catalog_as_dict() -> dict[str, object]:
    """Return a JSON-compatible catalog payload for API adapters."""

    return get_catalog().model_dump(mode="json", by_alias=True)


# Frozen process-local snapshot; get_catalog remains the injectable accessor.
CATALOG: Final[Catalog] = get_catalog()

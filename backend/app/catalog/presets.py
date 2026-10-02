"""Strategy presets and their execution-module metadata.

Presets select a shared execution module and provide configuration defaults.  No
preset contains a second copy of trading or search logic.
"""

from collections.abc import Iterable, Mapping
from decimal import Decimal
from enum import StrEnum
from types import MappingProxyType
from typing import Final, Literal

from pydantic import Field, field_serializer, field_validator, model_validator

from app.domain.conditions import (
    ConditionGroup,
    ConditionKind,
    ConditionLogic,
    StrategyRules,
)
from app.domain.contracts import StrategyPresetId
from app.domain.immutability import FrozenMap, freeze_mapping, thaw_value
from app.domain.status import DomainModel

from .conditions import CONDITION_DEFINITIONS, condition_definition, default_condition
from .definitions import PARAMETER_DEFINITIONS, SEARCH_DIMENSION_KEYS


class ExecutionModule(StrEnum):
    ACCUMULATION = "accumulation"
    TREND = "trend"
    SCHEDULED = "scheduled"
    SEARCH = "search"


class SearchDimension(DomainModel):
    """A grid dimension whose key points to a normal parameter definition."""

    key: str = Field(min_length=1)
    values: tuple[object, ...] = Field(min_length=1)
    values_parameter_key: str | None = Field(
        default=None, alias="valuesParameterKey", min_length=1
    )
    translation_key: str = Field(
        default="", alias="translationKey", validate_default=True
    )

    @model_validator(mode="after")
    def complete_metadata(self) -> "SearchDimension":
        if not self.translation_key:
            object.__setattr__(
                self,
                "translation_key",
                f"parameters.{self.key}",
            )
        if len(set(self.values)) != len(self.values):
            raise ValueError(f"search values must be unique: {self.key}")
        return self

    def configured_values(self, params: Mapping[str, object]) -> tuple[object, ...]:
        """Read frozen user values, falling back only for legacy catalog metadata."""
        values = (
            params.get(self.values_parameter_key, self.values)
            if self.values_parameter_key
            else self.values
        )
        if not isinstance(values, (list, tuple)) or not values:
            raise ValueError(f"search values must be a non-empty list: {self.key}")
        return tuple(values)


def _grid_dimensions() -> tuple[SearchDimension, ...]:
    dimensions = []
    for key in SEARCH_DIMENSION_KEYS:
        value_key = f"search.values.{key}"
        values = PARAMETER_DEFINITIONS[value_key].default
        if not isinstance(values, tuple):
            raise RuntimeError(f"search default is not a number list: {value_key}")
        dimensions.append(
            SearchDimension(key=key, valuesParameterKey=value_key, values=values)
        )
    return tuple(dimensions)


class PresetDefinition(DomainModel):
    """Catalog metadata for one strategy type."""

    id: StrategyPresetId
    name_key: str = Field(alias="nameKey")
    description_key: str = Field(alias="descriptionKey")
    execution_module: ExecutionModule = Field(alias="executionModule")
    parameter_keys: tuple[str, ...] = Field(alias="parameterKeys")
    default_params: Mapping[str, object] = Field(
        default_factory=dict, alias="defaultParams", validate_default=True
    )
    search_dimensions: tuple[SearchDimension, ...] = Field(
        default=(), alias="searchDimensions"
    )
    supports_benchmark: bool = Field(default=False, alias="supportsBenchmark")
    editor_mode: Literal["fixed", "custom", "search"] = Field(
        default="fixed", alias="editorMode"
    )
    default_rules: StrategyRules | None = Field(default=None, alias="defaultRules")

    @field_validator("default_params", mode="after")
    @classmethod
    def freeze_defaults(cls, value: Mapping[str, object]) -> FrozenMap:
        return freeze_mapping(value)

    @field_serializer("default_params")
    def serialize_defaults(self, value: Mapping[str, object]) -> object:
        return thaw_value(value)

    @model_validator(mode="after")
    def validate_defaults_and_dimensions(self) -> "PresetDefinition":
        parameter_set = set(self.parameter_keys)
        if len(parameter_set) != len(self.parameter_keys):
            raise ValueError(f"duplicate parameter key in preset: {self.id.value}")
        if not set(self.default_params).issubset(parameter_set):
            raise ValueError(
                f"preset defaults contain an unlisted key: {self.id.value}"
            )
        dimension_keys = [dimension.key for dimension in self.search_dimensions]
        if self.execution_module is ExecutionModule.SEARCH and not dimension_keys:
            raise ValueError("search presets require at least one dimension")
        if self.execution_module is not ExecutionModule.SEARCH and dimension_keys:
            raise ValueError("only search presets may define dimensions")
        if len(dimension_keys) != len(set(dimension_keys)):
            raise ValueError(f"duplicate search dimension: {self.id.value}")
        return self


# Shared run and contribution settings live in the shared config and are not
# copied into strategy defaults.  Every value below is obtained from the one
# parameter registry; a preset only supplies intentional overrides.
def _defaults_for(
    parameter_keys: Iterable[str],
    overrides: Mapping[str, object] | None = None,
) -> Mapping[str, object]:
    override_values = {} if overrides is None else dict(overrides)
    defaults: dict[str, object] = {}
    for key in parameter_keys:
        if key not in PARAMETER_DEFINITIONS:
            raise RuntimeError(f"unknown preset parameter: {key}")
        defaults[key] = override_values.get(key, PARAMETER_DEFINITIONS[key].default)
    unknown_overrides = set(override_values).difference(defaults)
    if unknown_overrides:
        raise RuntimeError(
            f"preset overrides contain unlisted keys: {sorted(unknown_overrides)}"
        )
    return MappingProxyType(defaults)


_VIX_KEYS: Final[tuple[str, ...]] = (
    "accumulation.cashSafetyLimit",
    "accumulation.maxSignalBuysPerMonth",
    "accumulation.conditionLogic",
    "vix.buyEnabled",
    "vix.symbol",
    "vix.buyThreshold",
    "exit.enabled",
    "exit.vix.low1",
    "exit.vix.ratio1",
    "exit.vix.low2",
    "exit.vix.ratio2",
)
_COMPOSITE_KEYS: Final[tuple[str, ...]] = (
    "accumulation.cashSafetyLimit",
    "accumulation.maxSignalBuysPerMonth",
    "accumulation.conditionLogic",
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
    "exit.ratio",
)
_TREND_KEYS: Final[tuple[str, ...]] = (
    "accumulation.maxSignalBuysPerMonth",
    "ma.period",
    "trend.sellBelowOrEqualMa",
)
_SCHEDULED_KEYS: Final[tuple[str, ...]] = ("scheduled.fundingMode",)
_GRID_KEYS: Final[tuple[str, ...]] = (
    *_COMPOSITE_KEYS,
    "search.dimensions",
    "search.maxCombinations",
    *(f"search.values.{key}" for key in SEARCH_DIMENSION_KEYS),
)

_VIX_DEFAULTS = _defaults_for(_VIX_KEYS, {"exit.enabled": False})
# ``None`` means unlimited for the multi-condition preset; the VIX preset
# retains its notebook default of one signal buy per month.
_COMPOSITE_DEFAULTS = _defaults_for(
    _COMPOSITE_KEYS, {"accumulation.maxSignalBuysPerMonth": None}
)
_GRID_DEFAULTS = _defaults_for(_GRID_KEYS, {"accumulation.maxSignalBuysPerMonth": None})

_FIXED_KINDS: Final[Mapping[StrategyPresetId, ConditionKind]] = MappingProxyType(
    {
        StrategyPresetId.VIX_DCA: ConditionKind.VIX,
        StrategyPresetId.MA_TREND: ConditionKind.MA_TREND,
        StrategyPresetId.MA_BUY_ONLY: ConditionKind.MA_TREND,
        StrategyPresetId.RSI_DCA: ConditionKind.RSI,
        StrategyPresetId.MA_DEVIATION_DCA: ConditionKind.MA_DEVIATION,
        StrategyPresetId.BOLLINGER_DCA: ConditionKind.BOLLINGER,
        StrategyPresetId.RATE_DCA: ConditionKind.RATE,
        StrategyPresetId.PE_DCA: ConditionKind.PE,
    }
)


def _default_rules(preset_id: StrategyPresetId) -> StrategyRules | None:
    kind = _FIXED_KINDS.get(preset_id)
    if kind is not None:
        sell = (
            None
            if preset_id is StrategyPresetId.MA_BUY_ONLY
            else default_condition(
                kind, "sell", enabled=preset_id is StrategyPresetId.MA_TREND
            )
        )
        if sell is not None and kind is ConditionKind.MA_TREND:
            sell = sell.model_copy(
                update={
                    "params": freeze_mapping(
                        {**sell.params, "exit.ratio": Decimal("1")}
                    )
                }
            )
        return StrategyRules(buy=default_condition(kind, "buy"), sell=sell)
    if preset_id in {StrategyPresetId.COMPOSITE_DCA, StrategyPresetId.GRID_SEARCH}:
        defaults = (
            _GRID_DEFAULTS
            if preset_id is StrategyPresetId.GRID_SEARCH
            else _COMPOSITE_DEFAULTS
        )
        children = (
            tuple(
                default_condition(
                    metadata.kind,
                    "buy",
                    enabled=defaults.get(metadata.legacy_buy_enabled_key, False)
                    is True,
                )
                for metadata in CONDITION_DEFINITIONS
                if metadata.legacy_buy_enabled_key is not None
            )
            if preset_id is StrategyPresetId.GRID_SEARCH
            else (default_condition(ConditionKind.VIX, "buy"),)
        )
        return StrategyRules(
            buy=ConditionGroup(
                id="buy-root",
                operator=ConditionLogic(str(defaults["accumulation.conditionLogic"])),
                children=children,
            ),
            sell=ConditionGroup(id="sell-root", enabled=False),
        )
    return None


def _single_condition_keys(kind: ConditionKind) -> tuple[str, ...]:
    definition = condition_definition(kind)
    return tuple(
        dict.fromkeys(
            (
                "accumulation.cashSafetyLimit",
                "accumulation.maxSignalBuysPerMonth",
                *definition.buy_parameter_keys,
                *definition.sell_parameter_keys,
                "exit.enabled",
            )
        )
    )


def _preset(
    preset_id: StrategyPresetId,
    execution_module: ExecutionModule,
    parameter_keys: Iterable[str],
    defaults: Mapping[str, object],
    *,
    dimensions: Iterable[SearchDimension] = (),
    supports_benchmark: bool = False,
) -> PresetDefinition:
    return PresetDefinition(
        id=preset_id,
        nameKey=f"presets.{preset_id.value}.name",
        descriptionKey=f"presets.{preset_id.value}.description",
        executionModule=execution_module,
        parameterKeys=tuple(parameter_keys),
        defaultParams=defaults,
        searchDimensions=tuple(dimensions),
        supportsBenchmark=supports_benchmark,
        editorMode="custom"
        if preset_id is StrategyPresetId.COMPOSITE_DCA
        else "search"
        if execution_module is ExecutionModule.SEARCH
        else "fixed",
        defaultRules=_default_rules(preset_id),
    )


# Registry order is part of the UI contract and is intentionally the same as
# StrategyPresetId's declaration order in the domain contract.
PRESET_DEFINITIONS: Final[Mapping[StrategyPresetId, PresetDefinition]] = (
    MappingProxyType(
        {
            StrategyPresetId.VIX_DCA: _preset(
                StrategyPresetId.VIX_DCA,
                ExecutionModule.ACCUMULATION,
                _VIX_KEYS,
                _VIX_DEFAULTS,
            ),
            StrategyPresetId.COMPOSITE_DCA: _preset(
                StrategyPresetId.COMPOSITE_DCA,
                ExecutionModule.ACCUMULATION,
                _COMPOSITE_KEYS,
                _COMPOSITE_DEFAULTS,
            ),
            StrategyPresetId.MA_TREND: _preset(
                StrategyPresetId.MA_TREND,
                ExecutionModule.TREND,
                _TREND_KEYS,
                _defaults_for(
                    _TREND_KEYS,
                    {
                        "trend.sellBelowOrEqualMa": True,
                        "accumulation.maxSignalBuysPerMonth": None,
                    },
                ),
            ),
            StrategyPresetId.MA_BUY_ONLY: _preset(
                StrategyPresetId.MA_BUY_ONLY,
                ExecutionModule.TREND,
                _TREND_KEYS,
                _defaults_for(
                    _TREND_KEYS,
                    {
                        "trend.sellBelowOrEqualMa": False,
                        "accumulation.maxSignalBuysPerMonth": None,
                    },
                ),
            ),
            StrategyPresetId.MONTHLY_DCA: _preset(
                StrategyPresetId.MONTHLY_DCA,
                ExecutionModule.SCHEDULED,
                _SCHEDULED_KEYS,
                _defaults_for(_SCHEDULED_KEYS),
                supports_benchmark=True,
            ),
            StrategyPresetId.LUMP_SUM: _preset(
                StrategyPresetId.LUMP_SUM,
                ExecutionModule.SCHEDULED,
                _SCHEDULED_KEYS,
                _defaults_for(_SCHEDULED_KEYS, {"scheduled.fundingMode": "upfront"}),
                supports_benchmark=True,
            ),
            StrategyPresetId.GRID_SEARCH: _preset(
                StrategyPresetId.GRID_SEARCH,
                ExecutionModule.SEARCH,
                _GRID_KEYS,
                _GRID_DEFAULTS,
                dimensions=_grid_dimensions(),
            ),
            **{
                preset_id: _preset(
                    preset_id,
                    ExecutionModule.ACCUMULATION,
                    _single_condition_keys(kind),
                    _defaults_for(
                        _single_condition_keys(kind), {"exit.enabled": False}
                    ),
                )
                for preset_id, kind in _FIXED_KINDS.items()
                if preset_id
                not in {
                    StrategyPresetId.VIX_DCA,
                    StrategyPresetId.MA_TREND,
                    StrategyPresetId.MA_BUY_ONLY,
                }
            },
        }
    )
)

# Stable aliases for callers that prefer a short name or a module mapping.
STRATEGY_PRESETS = PRESET_DEFINITIONS
EXECUTION_MODULES: Final[Mapping[StrategyPresetId, ExecutionModule]] = MappingProxyType(
    {
        preset_id: preset.execution_module
        for preset_id, preset in PRESET_DEFINITIONS.items()
    }
)


def get_preset_definition(preset_id: StrategyPresetId | str) -> PresetDefinition:
    """Return one preset by stable ID."""

    try:
        stable_id = StrategyPresetId(preset_id)
    except ValueError as error:
        raise KeyError(f"unknown strategy preset: {preset_id}") from error
    try:
        return PRESET_DEFINITIONS[stable_id]
    except KeyError as error:
        raise KeyError(f"unknown strategy preset: {stable_id.value}") from error


getPresetDefinition = get_preset_definition

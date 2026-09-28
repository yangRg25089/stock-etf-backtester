"""The seven strategy presets and their execution-module metadata.

Presets select a shared execution module and provide configuration defaults.  No
preset contains a second copy of trading or search logic.
"""

from collections.abc import Iterable, Mapping
from decimal import Decimal
from enum import StrEnum
from types import MappingProxyType
from typing import Final

from pydantic import Field, field_serializer, field_validator, model_validator

from app.domain.contracts import StrategyPresetId
from app.domain.immutability import FrozenMap, freeze_mapping, thaw_value
from app.domain.status import DomainModel

from .definitions import PARAMETER_DEFINITIONS


class ExecutionModule(StrEnum):
    ACCUMULATION = "accumulation"
    TREND = "trend"
    SCHEDULED = "scheduled"
    SEARCH = "search"


class SearchDimension(DomainModel):
    """A grid dimension whose key points to a normal parameter definition."""

    key: str = Field(min_length=1)
    values: tuple[object, ...] = Field(min_length=1)
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
)
_COMPOSITE_KEYS: Final[tuple[str, ...]] = (
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
)
_TREND_KEYS: Final[tuple[str, ...]] = ("ma.period", "trend.sellBelowOrEqualMa")
_SCHEDULED_KEYS: Final[tuple[str, ...]] = ("scheduled.fundingMode",)
_GRID_KEYS: Final[tuple[str, ...]] = (
    *_COMPOSITE_KEYS,
    "search.dimensions",
    "search.maxCombinations",
)

_VIX_DEFAULTS = _defaults_for(_VIX_KEYS, {"exit.enabled": False})
# ``None`` means unlimited for the multi-condition preset; the VIX preset
# retains its notebook default of one signal buy per month.
_COMPOSITE_DEFAULTS = _defaults_for(
    _COMPOSITE_KEYS, {"accumulation.maxSignalBuysPerMonth": None}
)
_GRID_DEFAULTS = _defaults_for(_GRID_KEYS, {"accumulation.maxSignalBuysPerMonth": None})


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
                _defaults_for(_TREND_KEYS, {"trend.sellBelowOrEqualMa": True}),
            ),
            StrategyPresetId.MA_BUY_ONLY: _preset(
                StrategyPresetId.MA_BUY_ONLY,
                ExecutionModule.TREND,
                _TREND_KEYS,
                _defaults_for(_TREND_KEYS, {"trend.sellBelowOrEqualMa": False}),
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
                dimensions=(
                    SearchDimension(
                        key="vix.buyThreshold",
                        values=(
                            Decimal("25"),
                            Decimal("28"),
                            Decimal("30"),
                            Decimal("35"),
                        ),
                    ),
                    SearchDimension(
                        key="rsi.buyThreshold",
                        values=(Decimal("25"), Decimal("28"), Decimal("30")),
                    ),
                    SearchDimension(
                        key="accumulation.cashSafetyLimit",
                        values=(Decimal("400"), Decimal("600"), Decimal("800")),
                    ),
                    SearchDimension(
                        key="accumulation.fixedDcaRatio",
                        values=(
                            Decimal("0.3"),
                            Decimal("0.5"),
                            Decimal("0.7"),
                            Decimal("1"),
                        ),
                    ),
                ),
            ),
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

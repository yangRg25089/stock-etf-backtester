"""The single source of truth for user-editable configuration fields.

Only stable machine keys live in this module.  Labels and explanatory text are
translation keys so that the catalog can be consumed by either UI locale without
changing a run configuration.
"""

from collections.abc import Iterable, Mapping
from datetime import date
from decimal import Decimal, DecimalException
from enum import StrEnum
from types import MappingProxyType
from typing import Final

from pydantic import Field, model_validator

from app.domain.contracts import StrategyPresetId
from app.domain.status import DomainModel


class ParameterType(StrEnum):
    """Allowed input/value shapes exposed by the catalog contract."""

    SYMBOL = "symbol"
    DATE = "date"
    INTEGER = "integer"
    DECIMAL = "decimal"
    RATIO = "ratio"
    PERCENT_POINT = "percent_point"
    BOOLEAN = "boolean"
    ENUM = "enum"
    ENUM_LIST = "enum_list"
    NUMBER_LIST = "number_list"


# A descriptive alias for callers that call the field's type a value type.
ParameterValueType = ParameterType


class ParameterLevel(StrEnum):
    """Where a parameter is edited in the run model."""

    SHARED = "shared"
    STRATEGY = "strategy"
    PRESET = "preset"
    SEARCH = "search"
    UI = "ui"


_NUMERIC_TYPES: Final[frozenset[ParameterType]] = frozenset(
    {
        ParameterType.INTEGER,
        ParameterType.DECIMAL,
        ParameterType.RATIO,
        ParameterType.PERCENT_POINT,
        ParameterType.NUMBER_LIST,
    }
)


def _as_finite_decimal(value: object, key: str) -> Decimal:
    """Convert a scalar number and reject NaN/infinite metadata values."""

    try:
        numeric_value = Decimal(str(value))
    except (DecimalException, ValueError) as error:
        raise ValueError(f"numeric parameter has an invalid value: {key}") from error
    if not numeric_value.is_finite():
        raise ValueError(f"numeric parameter must be finite: {key}")
    return numeric_value


def validate_parameter_value(definition: "ParameterDefinition", value: object) -> None:
    """Validate one registered value using the definition's type and bounds.

    Preset defaults and search candidates cross the same validation boundary as
    user configuration.  Keeping this check beside the registry prevents
    catalog assembly from accepting a value that a later editor cannot safely
    represent.
    """

    if value is None:
        if not definition.nullable:
            raise ValueError(f"non-nullable parameter has no value: {definition.key}")
        return

    parameter_type = definition.type
    if parameter_type is ParameterType.SYMBOL:
        if not isinstance(value, str):
            raise ValueError(
                f"symbol parameter has a non-string value: {definition.key}"
            )
    elif parameter_type is ParameterType.DATE:
        if not isinstance(value, date):
            raise ValueError(f"date parameter has a non-date value: {definition.key}")
    elif parameter_type is ParameterType.INTEGER:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(
                f"integer parameter has a non-integer value: {definition.key}"
            )
        numeric_value = _as_finite_decimal(value, definition.key)
        if definition.minimum is not None and numeric_value < definition.minimum:
            raise ValueError(f"value is below minimum: {definition.key}")
        if definition.maximum is not None and numeric_value > definition.maximum:
            raise ValueError(f"value is above maximum: {definition.key}")
    elif parameter_type in {
        ParameterType.DECIMAL,
        ParameterType.RATIO,
        ParameterType.PERCENT_POINT,
    }:
        if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
            raise ValueError(
                f"numeric parameter has a non-numeric value: {definition.key}"
            )
        numeric_value = _as_finite_decimal(value, definition.key)
        if definition.minimum is not None and numeric_value < definition.minimum:
            raise ValueError(f"value is below minimum: {definition.key}")
        if definition.maximum is not None and numeric_value > definition.maximum:
            raise ValueError(f"value is above maximum: {definition.key}")
    elif parameter_type is ParameterType.BOOLEAN:
        if not isinstance(value, bool):
            raise ValueError(
                f"boolean parameter has a non-boolean value: {definition.key}"
            )
    elif parameter_type is ParameterType.ENUM:
        if value not in definition.allowed_values:
            raise ValueError(f"enum value is not allowed: {definition.key}")
    elif parameter_type is ParameterType.ENUM_LIST:
        if not isinstance(value, (list, tuple)) or any(
            item not in definition.allowed_values for item in value
        ):
            raise ValueError(f"enum_list value is not allowed: {definition.key}")
    elif parameter_type is ParameterType.NUMBER_LIST:
        if not isinstance(value, (list, tuple)):
            raise ValueError(f"number_list value is not a list: {definition.key}")
        for item in value:
            if isinstance(item, bool) or not isinstance(item, (int, float, Decimal)):
                raise ValueError(
                    f"number_list contains a non-numeric value: {definition.key}"
                )
            numeric_value = _as_finite_decimal(item, definition.key)
            if definition.minimum is not None and numeric_value < definition.minimum:
                raise ValueError(f"value is below minimum: {definition.key}")
            if definition.maximum is not None and numeric_value > definition.maximum:
                raise ValueError(f"value is above maximum: {definition.key}")


class ParameterDefinition(DomainModel):
    """Metadata and validation hints for one stable configuration key.

    The catalog deliberately stores metadata, not executable strategy logic.  A
    consumer can render an editor, validate a candidate, and enumerate search
    dimensions from this one object.  ``default`` is intentionally JSON-like so
    that dates, decimals, and list defaults can be serialized without a second
    frontend schema.
    """

    key: str = Field(pattern=r"^[a-z][a-z0-9]*(?:\.[A-Za-z0-9]+)+$")
    type: ParameterType
    default: object = None
    unit: str | None = None
    minimum: Decimal | None = None
    maximum: Decimal | None = None
    step: Decimal | None = None
    allowed_values: tuple[object, ...] = Field(default=(), alias="allowedValues")
    applicable_presets: tuple[StrategyPresetId, ...] = Field(alias="applicablePresets")
    searchable: bool = False
    dependencies: tuple[str, ...] = ()
    translation_key: str = Field(alias="translationKey")
    level: ParameterLevel = ParameterLevel.STRATEGY
    nullable: bool = False

    @model_validator(mode="after")
    def validate_metadata(self) -> "ParameterDefinition":
        if not self.applicable_presets:
            raise ValueError("applicablePresets must not be empty")
        if self.minimum is not None:
            _as_finite_decimal(self.minimum, self.key)
        if self.maximum is not None:
            _as_finite_decimal(self.maximum, self.key)
        if self.minimum is not None and self.maximum is not None:
            if self.minimum > self.maximum:
                raise ValueError("minimum must not be greater than maximum")
        if self.step is not None:
            if _as_finite_decimal(self.step, self.key) <= 0:
                raise ValueError("step must be positive")
        if self.type is ParameterType.RATIO:
            if self.minimum != Decimal("0") or self.maximum != Decimal("1"):
                raise ValueError("ratio parameters must use the 0..1 range")
        if self.searchable and self.type not in _NUMERIC_TYPES - {
            ParameterType.NUMBER_LIST
        }:
            raise ValueError("only scalar numeric parameters may be searchable")
        if self.type in {ParameterType.ENUM, ParameterType.ENUM_LIST}:
            if not self.allowed_values:
                raise ValueError("enum parameters require allowedValues")
        validate_parameter_value(self, self.default)
        if not self.translation_key.startswith("parameters."):
            raise ValueError("translationKey must use the parameters namespace")
        return self

    @property
    def default_value(self) -> object:
        """Compatibility/readability alias for catalog consumers."""

        return self.default

    @property
    def min_value(self) -> Decimal | None:
        return self.minimum

    @property
    def max_value(self) -> Decimal | None:
        return self.maximum


_ALL_PRESETS: Final[tuple[StrategyPresetId, ...]] = tuple(StrategyPresetId)
_ACCUMULATION_PRESETS: Final[tuple[StrategyPresetId, ...]] = (
    StrategyPresetId.VIX_DCA,
    StrategyPresetId.COMPOSITE_DCA,
    StrategyPresetId.GRID_SEARCH,
)
_COMPOSITE_PRESETS: Final[tuple[StrategyPresetId, ...]] = (
    StrategyPresetId.COMPOSITE_DCA,
    StrategyPresetId.GRID_SEARCH,
)
_TREND_PRESETS: Final[tuple[StrategyPresetId, ...]] = (
    StrategyPresetId.MA_TREND,
    StrategyPresetId.MA_BUY_ONLY,
)
_SCHEDULED_PRESETS: Final[tuple[StrategyPresetId, ...]] = (
    StrategyPresetId.MONTHLY_DCA,
    StrategyPresetId.LUMP_SUM,
)
_GRID_PRESET: Final[tuple[StrategyPresetId, ...]] = (StrategyPresetId.GRID_SEARCH,)


def _d(
    key: str,
    type: ParameterType,
    default: object,
    *,
    presets: Iterable[StrategyPresetId] = _ALL_PRESETS,
    unit: str | None = None,
    minimum: int | float | str | Decimal | None = None,
    maximum: int | float | str | Decimal | None = None,
    step: int | float | str | Decimal | None = None,
    allowed_values: Iterable[object] = (),
    searchable: bool = False,
    dependencies: Iterable[str] = (),
    level: ParameterLevel = ParameterLevel.STRATEGY,
    nullable: bool = False,
) -> ParameterDefinition:
    """Construct a definition while deriving its translation key from its key."""

    return ParameterDefinition(
        key=key,
        type=type,
        default=default,
        unit=unit,
        minimum=None if minimum is None else Decimal(str(minimum)),
        maximum=None if maximum is None else Decimal(str(maximum)),
        step=None if step is None else Decimal(str(step)),
        allowedValues=tuple(allowed_values),
        applicablePresets=tuple(presets),
        searchable=searchable,
        dependencies=tuple(dependencies),
        translationKey=f"parameters.{key}",
        level=level,
        nullable=nullable,
    )


_DEFINITION_LIST: tuple[ParameterDefinition, ...] = (
    # Shared run and contribution settings.
    _d(
        "run.symbol",
        ParameterType.SYMBOL,
        "QQQ",
        unit="symbol",
        level=ParameterLevel.SHARED,
    ),
    _d(
        "run.startDate",
        ParameterType.DATE,
        date(2020, 1, 1),
        unit="date",
        level=ParameterLevel.SHARED,
    ),
    _d(
        "run.endDate",
        ParameterType.DATE,
        None,
        unit="date",
        level=ParameterLevel.SHARED,
        nullable=True,
    ),
    _d(
        "run.endMode",
        ParameterType.ENUM,
        "latest",
        allowed_values=("fixed", "latest"),
        level=ParameterLevel.SHARED,
    ),
    _d(
        "contribution.day",
        ParameterType.INTEGER,
        1,
        unit="day_of_month",
        minimum=1,
        maximum=31,
        step=1,
        level=ParameterLevel.SHARED,
    ),
    _d(
        "contribution.amount",
        ParameterType.DECIMAL,
        Decimal("100"),
        unit="currency",
        minimum=0,
        step="0.01",
        level=ParameterLevel.SHARED,
    ),
    _d(
        "data.macroStalenessSessions",
        ParameterType.INTEGER,
        3,
        unit="exchange_session",
        minimum=0,
        step=1,
        level=ParameterLevel.SHARED,
    ),
    _d(
        "data.financialFactMaxAgeDays",
        ParameterType.INTEGER,
        550,
        unit="calendar_day",
        minimum=1,
        step=1,
        level=ParameterLevel.SHARED,
    ),
    _d(
        "data.etfHoldingsMaxAgeDays",
        ParameterType.INTEGER,
        180,
        unit="calendar_day",
        minimum=1,
        step=1,
        level=ParameterLevel.SHARED,
    ),
    # Shared accumulation settings.
    _d(
        "accumulation.cashSafetyLimit",
        ParameterType.DECIMAL,
        Decimal("1200"),
        presets=_ACCUMULATION_PRESETS,
        unit="currency",
        minimum=0,
        step="0.01",
        searchable=True,
    ),
    _d(
        "accumulation.maxSignalBuysPerMonth",
        ParameterType.INTEGER,
        1,
        presets=_ACCUMULATION_PRESETS,
        unit="count",
        minimum=1,
        step=1,
        nullable=True,
    ),
    _d(
        "accumulation.conditionLogic",
        ParameterType.ENUM,
        "OR",
        presets=_ACCUMULATION_PRESETS,
        allowed_values=("AND", "OR"),
    ),
    _d(
        "accumulation.fixedDcaEnabled",
        ParameterType.BOOLEAN,
        True,
        presets=_COMPOSITE_PRESETS,
    ),
    _d(
        "accumulation.fixedDcaRatio",
        ParameterType.RATIO,
        Decimal("0.5"),
        presets=_COMPOSITE_PRESETS,
        unit="ratio",
        minimum=0,
        maximum=1,
        step="0.01",
        searchable=True,
    ),
    # Signal parameters.  These definitions are shared by normal and search
    # configurations; a search dimension only supplies candidate values.
    _d(
        "vix.buyEnabled",
        ParameterType.BOOLEAN,
        True,
        presets=_ACCUMULATION_PRESETS,
        dependencies=("vix.symbol", "vix.buyThreshold"),
    ),
    _d(
        "vix.symbol",
        ParameterType.SYMBOL,
        "^VIX",
        presets=_ACCUMULATION_PRESETS,
        unit="symbol",
        dependencies=("vix.buyEnabled",),
    ),
    _d(
        "vix.buyThreshold",
        ParameterType.DECIMAL,
        Decimal("25"),
        presets=_ACCUMULATION_PRESETS,
        unit="index_point",
        minimum=0,
        maximum=200,
        step="0.01",
        searchable=True,
        dependencies=("vix.buyEnabled",),
    ),
    _d(
        "rsi.buyEnabled",
        ParameterType.BOOLEAN,
        True,
        presets=_COMPOSITE_PRESETS,
        dependencies=("rsi.period", "rsi.buyThreshold"),
    ),
    _d(
        "rsi.period",
        ParameterType.INTEGER,
        14,
        presets=_COMPOSITE_PRESETS,
        unit="period",
        minimum=1,
        maximum=500,
        step=1,
    ),
    _d(
        "rsi.buyThreshold",
        ParameterType.DECIMAL,
        Decimal("30"),
        presets=_COMPOSITE_PRESETS,
        unit="index_point",
        minimum=0,
        maximum=100,
        step="0.01",
        searchable=True,
    ),
    _d(
        "ma.buyEnabled",
        ParameterType.BOOLEAN,
        True,
        presets=_COMPOSITE_PRESETS,
        dependencies=("ma.period", "ma.buyDeviationPct"),
    ),
    _d(
        "ma.period",
        ParameterType.INTEGER,
        200,
        presets=(*_COMPOSITE_PRESETS, *_TREND_PRESETS),
        unit="period",
        minimum=1,
        maximum=2000,
        step=1,
    ),
    _d(
        "ma.buyDeviationPct",
        ParameterType.PERCENT_POINT,
        Decimal("-1"),
        presets=_COMPOSITE_PRESETS,
        unit="percent_point",
        minimum=-100,
        maximum=100,
        step="0.01",
    ),
    _d(
        "bollinger.buyEnabled",
        ParameterType.BOOLEAN,
        True,
        presets=_COMPOSITE_PRESETS,
        dependencies=("bollinger.period", "bollinger.stddev"),
    ),
    _d(
        "bollinger.period",
        ParameterType.INTEGER,
        20,
        presets=_COMPOSITE_PRESETS,
        unit="period",
        minimum=1,
        maximum=500,
        step=1,
    ),
    _d(
        "bollinger.stddev",
        ParameterType.DECIMAL,
        Decimal("2"),
        presets=_COMPOSITE_PRESETS,
        unit="standard_deviation",
        minimum="0.01",
        maximum=20,
        step="0.01",
    ),
    _d(
        "rate.buyEnabled",
        ParameterType.BOOLEAN,
        False,
        presets=_COMPOSITE_PRESETS,
        dependencies=("rate.symbol", "rate.thresholdPct", "rate.sourceUnit"),
    ),
    _d(
        "rate.symbol",
        ParameterType.SYMBOL,
        "^TNX",
        presets=_COMPOSITE_PRESETS,
        unit="symbol",
        dependencies=("rate.buyEnabled",),
    ),
    _d(
        "rate.thresholdPct",
        ParameterType.PERCENT_POINT,
        Decimal("2.5"),
        presets=_COMPOSITE_PRESETS,
        unit="percent_point",
        minimum=-100,
        maximum=100,
        step="0.01",
    ),
    _d(
        "rate.sourceUnit",
        ParameterType.ENUM,
        "auto",
        presets=_COMPOSITE_PRESETS,
        allowed_values=("auto", "percent_point", "decimal", "basis_points"),
        dependencies=("rate.buyEnabled",),
    ),
    _d(
        "pe.buyEnabled",
        ParameterType.BOOLEAN,
        False,
        presets=_COMPOSITE_PRESETS,
        dependencies=("pe.threshold", "pe.etfMinCoverage"),
    ),
    _d(
        "pe.threshold",
        ParameterType.DECIMAL,
        Decimal("25"),
        presets=_COMPOSITE_PRESETS,
        unit="multiple",
        minimum="0.000001",
        maximum=1000,
        step="0.01",
    ),
    _d(
        "pe.etfMinCoverage",
        ParameterType.RATIO,
        Decimal("0.80"),
        presets=_COMPOSITE_PRESETS,
        unit="ratio",
        minimum=0,
        maximum=1,
        step="0.01",
    ),
    # Exit settings.  Buy and sell switches remain separate dependencies.
    _d(
        "exit.enabled",
        ParameterType.BOOLEAN,
        True,
        presets=_ACCUMULATION_PRESETS,
    ),
    _d(
        "exit.vix.low1",
        ParameterType.DECIMAL,
        Decimal("12"),
        presets=_COMPOSITE_PRESETS,
        unit="index_point",
        minimum=0,
        maximum=200,
        step="0.01",
        dependencies=("exit.enabled", "vix.symbol"),
    ),
    _d(
        "exit.vix.ratio1",
        ParameterType.RATIO,
        Decimal("0.20"),
        presets=_COMPOSITE_PRESETS,
        unit="ratio",
        minimum=0,
        maximum=1,
        step="0.01",
        dependencies=("exit.enabled", "vix.symbol"),
    ),
    _d(
        "exit.vix.low2",
        ParameterType.DECIMAL,
        Decimal("10"),
        presets=_COMPOSITE_PRESETS,
        unit="index_point",
        minimum=0,
        maximum=200,
        step="0.01",
        dependencies=("exit.enabled", "vix.symbol"),
    ),
    _d(
        "exit.vix.ratio2",
        ParameterType.RATIO,
        Decimal("0.30"),
        presets=_COMPOSITE_PRESETS,
        unit="ratio",
        minimum=0,
        maximum=1,
        step="0.01",
        dependencies=("exit.enabled", "vix.symbol"),
    ),
    _d(
        "exit.rsi.enabled",
        ParameterType.BOOLEAN,
        False,
        presets=_COMPOSITE_PRESETS,
        dependencies=("rsi.period",),
    ),
    _d(
        "exit.rsi.threshold",
        ParameterType.DECIMAL,
        Decimal("70"),
        presets=_COMPOSITE_PRESETS,
        unit="index_point",
        minimum=0,
        maximum=100,
        step="0.01",
        dependencies=("exit.rsi.enabled",),
    ),
    _d(
        "exit.rsi.ratio",
        ParameterType.RATIO,
        Decimal("0.25"),
        presets=_COMPOSITE_PRESETS,
        unit="ratio",
        minimum=0,
        maximum=1,
        step="0.01",
        dependencies=("exit.rsi.enabled",),
    ),
    _d(
        "exit.bollinger.enabled",
        ParameterType.BOOLEAN,
        False,
        presets=_COMPOSITE_PRESETS,
        dependencies=("bollinger.period", "bollinger.stddev"),
    ),
    _d(
        "exit.bollinger.ratio",
        ParameterType.RATIO,
        Decimal("0.25"),
        presets=_COMPOSITE_PRESETS,
        unit="ratio",
        minimum=0,
        maximum=1,
        step="0.01",
        dependencies=("exit.bollinger.enabled",),
    ),
    _d(
        "exit.bollinger.vixCeiling",
        ParameterType.DECIMAL,
        Decimal("20"),
        presets=_COMPOSITE_PRESETS,
        unit="index_point",
        minimum=0,
        maximum=200,
        step="0.01",
        dependencies=("exit.bollinger.enabled", "vix.symbol"),
    ),
    # Preset-only execution switches.
    _d(
        "trend.sellBelowOrEqualMa",
        ParameterType.BOOLEAN,
        True,
        presets=_TREND_PRESETS,
        level=ParameterLevel.PRESET,
    ),
    _d(
        "scheduled.fundingMode",
        ParameterType.ENUM,
        "monthly",
        presets=_SCHEDULED_PRESETS,
        allowed_values=("monthly", "upfront"),
        level=ParameterLevel.PRESET,
    ),
    # Search controls.  Values for a dimension are held by the preset below;
    # the dimension key itself always points back to a normal definition.
    _d(
        "search.dimensions",
        ParameterType.ENUM_LIST,
        (
            "vix.buyThreshold",
            "rsi.buyThreshold",
            "accumulation.cashSafetyLimit",
            "accumulation.fixedDcaRatio",
        ),
        presets=_GRID_PRESET,
        allowed_values=(
            "vix.buyThreshold",
            "rsi.buyThreshold",
            "accumulation.cashSafetyLimit",
            "accumulation.fixedDcaRatio",
        ),
        level=ParameterLevel.SEARCH,
    ),
    _d(
        "search.maxCombinations",
        ParameterType.INTEGER,
        1000,
        presets=_GRID_PRESET,
        unit="count",
        minimum=1,
        maximum=10000,
        step=1,
        level=ParameterLevel.SEARCH,
    ),
    # UI state is catalogued for a complete snapshot contract but is not a
    # strategy parameter and must not enter the calculation hash.
    _d(
        "run.scope",
        ParameterType.ENUM,
        "active",
        allowed_values=("active", "all_enabled"),
        level=ParameterLevel.UI,
    ),
    _d(
        "display.showTrades",
        ParameterType.BOOLEAN,
        True,
        level=ParameterLevel.UI,
    ),
    _d(
        "display.showChart",
        ParameterType.BOOLEAN,
        True,
        level=ParameterLevel.UI,
    ),
)


def _build_registry(
    definitions: Iterable[ParameterDefinition],
) -> Mapping[str, ParameterDefinition]:
    registry: dict[str, ParameterDefinition] = {}
    for definition in definitions:
        if definition.key in registry:
            raise RuntimeError(f"duplicate parameter key: {definition.key}")
        registry[definition.key] = definition
    for definition in registry.values():
        for dependency in definition.dependencies:
            if dependency not in registry:
                raise RuntimeError(
                    f"unknown parameter dependency: {definition.key} -> {dependency}"
                )
    return MappingProxyType(registry)


PARAMETER_DEFINITIONS: Final[Mapping[str, ParameterDefinition]] = _build_registry(
    _DEFINITION_LIST
)
# Explicit aliases keep the registry discoverable for callers that prefer a
# registry noun or a tuple of definitions.
PARAMETER_REGISTRY = PARAMETER_DEFINITIONS
ALL_PARAMETER_DEFINITIONS: Final[tuple[ParameterDefinition, ...]] = tuple(
    PARAMETER_DEFINITIONS.values()
)


def get_parameter_definition(key: str) -> ParameterDefinition:
    """Return the registered definition or raise a stable ``KeyError``."""

    try:
        return PARAMETER_DEFINITIONS[key]
    except KeyError as error:
        raise KeyError(f"unknown parameter key: {key}") from error


def iter_parameter_definitions() -> tuple[ParameterDefinition, ...]:
    """Return definitions in their stable catalog order."""

    return ALL_PARAMETER_DEFINITIONS


# Camel-case aliases are useful for generated/OpenAPI-adjacent callers while
# Python consumers can use the snake-case names above.
getParameterDefinition = get_parameter_definition
iterParameterDefinitions = iter_parameter_definitions

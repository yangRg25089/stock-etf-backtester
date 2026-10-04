"""The single source of truth for user-editable configuration fields.

Only stable machine keys live in this module.  Labels and explanatory text are
translation keys so that the catalog can be consumed by either UI locale without
changing a run configuration.
"""

import re
from collections.abc import Iterable, Mapping
from datetime import date, datetime
from decimal import Decimal, DecimalException
from enum import StrEnum
from types import MappingProxyType
from typing import Final

from pydantic import Field, model_validator

from app.domain.contracts import StrategyPresetId
from app.domain.status import DomainModel
from app.domain.values import SYMBOL_PATTERN


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


class ParameterGroupDefinition(DomainModel):
    """Localized display metadata for one stable family of form fields."""

    id: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    translation_key: str = Field(alias="translationKey")

    @model_validator(mode="after")
    def validate_translation_key(self) -> "ParameterGroupDefinition":
        if not self.translation_key.startswith("parameterGroups."):
            raise ValueError("translationKey must use the parameterGroups namespace")
        return self


PARAMETER_GROUP_DEFINITIONS: Final[tuple[ParameterGroupDefinition, ...]] = (
    ParameterGroupDefinition(id="general", translationKey="parameterGroups.general"),
    ParameterGroupDefinition(id="run", translationKey="parameterGroups.run"),
    ParameterGroupDefinition(
        id="contribution", translationKey="parameterGroups.contribution"
    ),
    ParameterGroupDefinition(id="data", translationKey="parameterGroups.data"),
    ParameterGroupDefinition(id="analysis", translationKey="parameterGroups.analysis"),
    ParameterGroupDefinition(
        id="execution", translationKey="parameterGroups.execution"
    ),
    ParameterGroupDefinition(
        id="buy_limits", translationKey="parameterGroups.buy_limits"
    ),
    ParameterGroupDefinition(
        id="signal_combination", translationKey="parameterGroups.signal_combination"
    ),
    ParameterGroupDefinition(id="vix", translationKey="parameterGroups.vix"),
    ParameterGroupDefinition(id="rsi", translationKey="parameterGroups.rsi"),
    ParameterGroupDefinition(
        id="moving_average", translationKey="parameterGroups.moving_average"
    ),
    ParameterGroupDefinition(
        id="bollinger", translationKey="parameterGroups.bollinger"
    ),
    ParameterGroupDefinition(
        id="interest_rate", translationKey="parameterGroups.interest_rate"
    ),
    ParameterGroupDefinition(
        id="valuation", translationKey="parameterGroups.valuation"
    ),
    ParameterGroupDefinition(
        id="sell_signals", translationKey="parameterGroups.sell_signals"
    ),
    ParameterGroupDefinition(id="trend", translationKey="parameterGroups.trend"),
    ParameterGroupDefinition(
        id="scheduled_funding", translationKey="parameterGroups.scheduled_funding"
    ),
    ParameterGroupDefinition(id="search", translationKey="parameterGroups.search"),
    ParameterGroupDefinition(id="display", translationKey="parameterGroups.display"),
)


class ParameterValueIssue(StrEnum):
    """Stable reason categories for a rejected catalog-backed value."""

    REQUIRED = "required"
    EMPTY_VALUE = "empty_value"
    INVALID_TYPE = "invalid_type"
    INVALID_VALUE = "invalid_value"
    OUT_OF_RANGE = "out_of_range"
    INVALID_CHOICE = "invalid_choice"
    INVALID_COLLECTION = "invalid_collection"


class ParameterValidationError(ValueError):
    """A value error that retains its catalog key and machine-readable cause."""

    def __init__(
        self,
        key: str,
        issue: ParameterValueIssue,
        message: str,
    ) -> None:
        self.key = key
        self.issue = issue
        super().__init__(message)


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
            raise ParameterValidationError(
                definition.key,
                ParameterValueIssue.REQUIRED,
                f"non-nullable parameter has no value: {definition.key}",
            )
        return

    if isinstance(value, str) and not value.strip():
        raise ParameterValidationError(
            definition.key,
            ParameterValueIssue.EMPTY_VALUE,
            f"string parameter is empty: {definition.key}",
        )

    parameter_type = definition.type
    if parameter_type is ParameterType.SYMBOL:
        if not isinstance(value, str):
            raise ParameterValidationError(
                definition.key,
                ParameterValueIssue.INVALID_TYPE,
                f"symbol parameter has a non-string value: {definition.key}",
            )
        if re.fullmatch(SYMBOL_PATTERN, value) is None:
            raise ParameterValidationError(
                definition.key,
                ParameterValueIssue.INVALID_VALUE,
                f"symbol parameter has an unsupported format: {definition.key}",
            )
    elif parameter_type is ParameterType.DATE:
        if not isinstance(value, date) or isinstance(value, datetime):
            raise ParameterValidationError(
                definition.key,
                ParameterValueIssue.INVALID_TYPE,
                f"date parameter has a non-date value: {definition.key}",
            )
    elif parameter_type is ParameterType.INTEGER:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ParameterValidationError(
                definition.key,
                ParameterValueIssue.INVALID_TYPE,
                f"integer parameter has a non-integer value: {definition.key}",
            )
        _validate_numeric_value(definition, value)
    elif parameter_type in {
        ParameterType.DECIMAL,
        ParameterType.RATIO,
        ParameterType.PERCENT_POINT,
    }:
        if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
            raise ParameterValidationError(
                definition.key,
                ParameterValueIssue.INVALID_TYPE,
                f"numeric parameter has a non-numeric value: {definition.key}",
            )
        _validate_numeric_value(definition, value)
    elif parameter_type is ParameterType.BOOLEAN:
        if not isinstance(value, bool):
            raise ParameterValidationError(
                definition.key,
                ParameterValueIssue.INVALID_TYPE,
                f"boolean parameter has a non-boolean value: {definition.key}",
            )
    elif parameter_type is ParameterType.ENUM:
        if value not in definition.allowed_values:
            raise ParameterValidationError(
                definition.key,
                ParameterValueIssue.INVALID_CHOICE,
                f"enum value is not allowed: {definition.key}",
            )
    elif parameter_type is ParameterType.ENUM_LIST:
        if (
            not isinstance(value, (list, tuple))
            or not value
            or any(item not in definition.allowed_values for item in value)
        ):
            raise ParameterValidationError(
                definition.key,
                ParameterValueIssue.INVALID_COLLECTION,
                f"enum_list value is not allowed: {definition.key}",
            )
        if len(value) != len(set(value)):
            raise ParameterValidationError(
                definition.key,
                ParameterValueIssue.INVALID_COLLECTION,
                f"enum_list values must be unique: {definition.key}",
            )
    elif parameter_type is ParameterType.NUMBER_LIST:
        if not isinstance(value, (list, tuple)) or not value:
            raise ParameterValidationError(
                definition.key,
                ParameterValueIssue.INVALID_COLLECTION,
                f"number_list value is not a valid list: {definition.key}",
            )
        for item in value:
            if isinstance(item, bool) or not isinstance(item, (int, float, Decimal)):
                raise ParameterValidationError(
                    definition.key,
                    ParameterValueIssue.INVALID_TYPE,
                    f"number_list contains a non-numeric value: {definition.key}",
                )
            _validate_numeric_value(definition, item)
        if len(value) != len(set(value)):
            raise ParameterValidationError(
                definition.key,
                ParameterValueIssue.INVALID_COLLECTION,
                f"number_list values must be unique: {definition.key}",
            )


def _validate_numeric_value(definition: "ParameterDefinition", value: object) -> None:
    try:
        numeric_value = _as_finite_decimal(value, definition.key)
    except ValueError as error:
        raise ParameterValidationError(
            definition.key,
            ParameterValueIssue.INVALID_VALUE,
            str(error),
        ) from error
    if definition.minimum is not None and numeric_value < definition.minimum:
        raise ParameterValidationError(
            definition.key,
            ParameterValueIssue.OUT_OF_RANGE,
            f"value is below minimum: {definition.key}",
        )
    if definition.maximum is not None and numeric_value > definition.maximum:
        raise ParameterValidationError(
            definition.key,
            ParameterValueIssue.OUT_OF_RANGE,
            f"value is above maximum: {definition.key}",
        )


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
    pattern: str | None = None
    group_id: str = Field(alias="groupId", pattern=r"^[a-z][a-z0-9_]*$")

    @model_validator(mode="after")
    def validate_metadata(self) -> "ParameterDefinition":
        if self.type is ParameterType.SYMBOL:
            if self.pattern is not None and self.pattern != SYMBOL_PATTERN:
                raise ValueError("symbol parameters must use the shared format")
            object.__setattr__(self, "pattern", SYMBOL_PATTERN)
        elif self.pattern is not None:
            raise ValueError("only symbol parameters have a format pattern")
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
_SINGLE_CONDITION_PRESETS: Final[tuple[StrategyPresetId, ...]] = (
    StrategyPresetId.RSI_DCA,
    StrategyPresetId.MA_DEVIATION_DCA,
    StrategyPresetId.BOLLINGER_DCA,
    StrategyPresetId.RATE_DCA,
    StrategyPresetId.PE_DCA,
)


def _condition_applicability(key: str) -> tuple[StrategyPresetId, ...]:
    if (
        key.startswith("accumulation.")
        and key
        not in {
            "accumulation.conditionLogic",
        }
        or key == "exit.enabled"
    ):
        return _SINGLE_CONDITION_PRESETS
    if key.startswith(("rsi.", "exit.rsi.")):
        return (StrategyPresetId.RSI_DCA,)
    if key.startswith("ma."):
        return (StrategyPresetId.MA_DEVIATION_DCA,)
    if key.startswith(("bollinger.", "exit.bollinger.")):
        return (StrategyPresetId.BOLLINGER_DCA,)
    if key.startswith("rate."):
        return (StrategyPresetId.RATE_DCA,)
    if key.startswith("pe."):
        return (StrategyPresetId.PE_DCA,)
    if key.startswith("exit.vix."):
        return (StrategyPresetId.VIX_DCA,)
    if key == "vix.symbol":
        return (StrategyPresetId.BOLLINGER_DCA,)
    return ()


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
    group_id: str,
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
        applicablePresets=tuple(
            dict.fromkeys((*presets, *_condition_applicability(key)))
        ),
        searchable=searchable,
        dependencies=tuple(dependencies),
        translationKey=f"parameters.{key}",
        level=level,
        nullable=nullable,
        groupId=group_id,
    )


_SEARCH_DEFAULT_VALUES: Final[Mapping[str, tuple[Decimal, ...]]] = MappingProxyType(
    {
        "vix.buyThreshold": tuple(Decimal(value) for value in (25, 28, 30, 35)),
        "rsi.buyThreshold": tuple(Decimal(value) for value in (25, 28, 30)),
        "accumulation.cashSafetyLimit": tuple(
            Decimal(value) for value in (400, 600, 800)
        ),
    }
)
SEARCH_DIMENSION_KEYS: Final[tuple[str, ...]] = tuple(_SEARCH_DEFAULT_VALUES)


_DEFINITION_LIST: tuple[ParameterDefinition, ...] = (
    # Shared run and contribution settings.
    _d(
        "run.symbol",
        ParameterType.SYMBOL,
        "QQQ",
        group_id="run",
        unit="symbol",
        level=ParameterLevel.SHARED,
    ),
    _d(
        "run.startDate",
        ParameterType.DATE,
        date(2020, 1, 1),
        group_id="run",
        unit="date",
        level=ParameterLevel.SHARED,
    ),
    _d(
        "run.endDate",
        ParameterType.DATE,
        date.today(),
        group_id="run",
        unit="date",
        level=ParameterLevel.SHARED,
    ),
    _d(
        "contribution.day",
        ParameterType.INTEGER,
        1,
        group_id="contribution",
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
        group_id="contribution",
        unit="currency",
        minimum=0,
        step="0.01",
        level=ParameterLevel.SHARED,
    ),
    _d(
        "data.macroStalenessSessions",
        ParameterType.INTEGER,
        3,
        group_id="data",
        unit="exchange_session",
        minimum=0,
        step=1,
        level=ParameterLevel.SHARED,
    ),
    _d(
        "data.financialFactMaxAgeDays",
        ParameterType.INTEGER,
        550,
        group_id="data",
        unit="calendar_day",
        minimum=1,
        step=1,
        level=ParameterLevel.SHARED,
    ),
    _d(
        "data.etfHoldingsMaxAgeDays",
        ParameterType.INTEGER,
        180,
        group_id="data",
        unit="calendar_day",
        minimum=1,
        step=1,
        level=ParameterLevel.SHARED,
    ),
    _d(
        "analysis.riskFreeAnnualRatePct",
        ParameterType.PERCENT_POINT,
        Decimal("0"),
        group_id="analysis",
        unit="percent_point",
        minimum="-99.99",
        maximum="100",
        step="0.01",
        level=ParameterLevel.SHARED,
    ),
    _d(
        "execution.commission",
        ParameterType.DECIMAL,
        Decimal("0"),
        unit="currency",
        minimum=0,
        step="0.01",
        level=ParameterLevel.SHARED,
        group_id="execution",
    ),
    _d(
        "execution.slippagePct",
        ParameterType.PERCENT_POINT,
        Decimal("0"),
        unit="percent_point",
        minimum=0,
        maximum="99.99",
        step="0.01",
        level=ParameterLevel.SHARED,
        group_id="execution",
    ),
    _d(
        "execution.spreadPct",
        ParameterType.PERCENT_POINT,
        Decimal("0"),
        unit="percent_point",
        minimum=0,
        maximum="199.98",
        step="0.01",
        level=ParameterLevel.SHARED,
        group_id="execution",
    ),
    _d(
        "execution.fractionalShares",
        ParameterType.BOOLEAN,
        True,
        level=ParameterLevel.SHARED,
        group_id="execution",
    ),
    # Shared accumulation settings.
    _d(
        "accumulation.cashSafetyLimit",
        ParameterType.DECIMAL,
        Decimal("1200"),
        group_id="buy_limits",
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
        group_id="buy_limits",
        presets=(*_ACCUMULATION_PRESETS, *_TREND_PRESETS),
        unit="count",
        minimum=1,
        step=1,
        nullable=True,
    ),
    _d(
        "accumulation.conditionLogic",
        ParameterType.ENUM,
        "OR",
        group_id="signal_combination",
        presets=_ACCUMULATION_PRESETS,
        allowed_values=("AND", "OR"),
    ),
    _d(
        "vix.buyEnabled",
        ParameterType.BOOLEAN,
        True,
        group_id="vix",
        presets=_ACCUMULATION_PRESETS,
        dependencies=("vix.symbol", "vix.buyThreshold"),
    ),
    _d(
        "vix.symbol",
        ParameterType.ENUM,
        "^VIX",
        group_id="vix",
        presets=_ACCUMULATION_PRESETS,
        allowed_values=("^VIX", "^VXN", "^VXD"),
        dependencies=("vix.buyEnabled",),
    ),
    _d(
        "vix.buyThreshold",
        ParameterType.DECIMAL,
        Decimal("25"),
        group_id="vix",
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
        group_id="rsi",
        presets=_COMPOSITE_PRESETS,
        dependencies=("rsi.period", "rsi.buyThreshold"),
    ),
    _d(
        "rsi.period",
        ParameterType.INTEGER,
        14,
        group_id="rsi",
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
        group_id="rsi",
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
        group_id="moving_average",
        presets=_COMPOSITE_PRESETS,
        dependencies=("ma.period", "ma.buyDeviationPct"),
    ),
    _d(
        "ma.period",
        ParameterType.INTEGER,
        200,
        group_id="moving_average",
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
        group_id="moving_average",
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
        group_id="bollinger",
        presets=_COMPOSITE_PRESETS,
        dependencies=("bollinger.period", "bollinger.stddev"),
    ),
    _d(
        "bollinger.period",
        ParameterType.INTEGER,
        20,
        group_id="bollinger",
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
        group_id="bollinger",
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
        group_id="interest_rate",
        presets=_COMPOSITE_PRESETS,
        dependencies=("rate.symbol", "rate.thresholdPct", "rate.sourceUnit"),
    ),
    _d(
        "rate.symbol",
        ParameterType.SYMBOL,
        "^TNX",
        group_id="interest_rate",
        presets=_COMPOSITE_PRESETS,
        unit="symbol",
        dependencies=("rate.buyEnabled",),
    ),
    _d(
        "rate.thresholdPct",
        ParameterType.PERCENT_POINT,
        Decimal("2.5"),
        group_id="interest_rate",
        presets=_COMPOSITE_PRESETS,
        unit="percent_point",
        minimum=-100,
        maximum=100,
        step="0.01",
    ),
    _d(
        "rate.sourceUnit",
        ParameterType.ENUM,
        "percent_point",
        group_id="interest_rate",
        presets=_COMPOSITE_PRESETS,
        allowed_values=("auto", "percent_point", "decimal", "basis_points"),
        dependencies=("rate.buyEnabled",),
    ),
    _d(
        "pe.buyEnabled",
        ParameterType.BOOLEAN,
        False,
        group_id="valuation",
        presets=_COMPOSITE_PRESETS,
        dependencies=("pe.threshold", "pe.etfMinCoverage"),
    ),
    _d(
        "pe.threshold",
        ParameterType.DECIMAL,
        Decimal("25"),
        group_id="valuation",
        presets=_COMPOSITE_PRESETS,
        unit="multiple",
        minimum="0.000001",
        maximum=1000,
        step="0.000001",
    ),
    _d(
        "pe.etfMinCoverage",
        ParameterType.RATIO,
        Decimal("0.80"),
        group_id="valuation",
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
        group_id="sell_signals",
        presets=_ACCUMULATION_PRESETS,
    ),
    _d(
        "exit.vix.low1",
        ParameterType.DECIMAL,
        Decimal("12"),
        group_id="sell_signals",
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
        group_id="sell_signals",
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
        group_id="sell_signals",
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
        group_id="sell_signals",
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
        group_id="sell_signals",
        presets=_COMPOSITE_PRESETS,
        dependencies=("rsi.period",),
    ),
    _d(
        "exit.rsi.threshold",
        ParameterType.DECIMAL,
        Decimal("70"),
        group_id="sell_signals",
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
        group_id="sell_signals",
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
        group_id="sell_signals",
        presets=_COMPOSITE_PRESETS,
        dependencies=("bollinger.period", "bollinger.stddev"),
    ),
    _d(
        "exit.bollinger.ratio",
        ParameterType.RATIO,
        Decimal("0.25"),
        group_id="sell_signals",
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
        group_id="sell_signals",
        presets=_COMPOSITE_PRESETS,
        unit="index_point",
        minimum=0,
        maximum=200,
        step="0.01",
        dependencies=("exit.bollinger.enabled", "vix.symbol"),
    ),
    # Preset-only execution switches.
    _d(
        "exit.ratio",
        ParameterType.RATIO,
        Decimal("0.25"),
        group_id="sell_signals",
        unit="ratio",
        minimum=0,
        maximum=1,
        step="0.01",
        presets=(
            *_COMPOSITE_PRESETS,
            *_TREND_PRESETS,
            StrategyPresetId.MA_DEVIATION_DCA,
            StrategyPresetId.RATE_DCA,
            StrategyPresetId.PE_DCA,
        ),
    ),
    _d(
        "trend.sellBelowOrEqualMa",
        ParameterType.BOOLEAN,
        True,
        group_id="trend",
        presets=_TREND_PRESETS,
        level=ParameterLevel.PRESET,
    ),
    _d(
        "scheduled.fundingMode",
        ParameterType.ENUM,
        "monthly",
        group_id="scheduled_funding",
        presets=_SCHEDULED_PRESETS,
        allowed_values=("monthly", "upfront"),
        level=ParameterLevel.PRESET,
    ),
    # Search controls reference ordinary definitions; value lists are registered below.
    _d(
        "search.optimizationMode",
        ParameterType.ENUM,
        "full_period",
        group_id="search",
        presets=_GRID_PRESET,
        allowed_values=("full_period", "train_test", "walk_forward"),
        level=ParameterLevel.SEARCH,
    ),
    _d(
        "search.trainEndDate",
        ParameterType.DATE,
        None,
        group_id="search",
        presets=_GRID_PRESET,
        nullable=True,
        level=ParameterLevel.SEARCH,
    ),
    _d(
        "search.dimensions",
        ParameterType.ENUM_LIST,
        SEARCH_DIMENSION_KEYS,
        group_id="search",
        presets=_GRID_PRESET,
        allowed_values=SEARCH_DIMENSION_KEYS,
        level=ParameterLevel.SEARCH,
    ),
    _d(
        "search.maxCombinations",
        ParameterType.INTEGER,
        1000,
        group_id="search",
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
        "display.showChart",
        ParameterType.BOOLEAN,
        True,
        group_id="display",
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


def _search_value_definitions() -> tuple[ParameterDefinition, ...]:
    ordinary = {definition.key: definition for definition in _DEFINITION_LIST}
    return tuple(
        _d(
            f"search.values.{key}",
            ParameterType.NUMBER_LIST,
            values,
            presets=_GRID_PRESET,
            group_id="search",
            level=ParameterLevel.SEARCH,
            unit=ordinary[key].unit,
            minimum=ordinary[key].minimum,
            maximum=ordinary[key].maximum,
            step=ordinary[key].step,
        )
        for key, values in _SEARCH_DEFAULT_VALUES.items()
    )


PARAMETER_DEFINITIONS: Final[Mapping[str, ParameterDefinition]] = _build_registry(
    (*_DEFINITION_LIST, *_search_value_definitions())
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

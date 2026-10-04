"""Decode JSON parameter values using their catalog type, then validate."""

import re
from datetime import date
from decimal import Decimal, DecimalException

from app.catalog.definitions import (
    ParameterDefinition,
    ParameterType,
    validate_parameter_value,
)
from app.domain.immutability import thaw_value

_DECIMAL_TEXT = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_DECIMAL_TYPES = {
    ParameterType.DECIMAL,
    ParameterType.RATIO,
    ParameterType.PERCENT_POINT,
}


def _json_decimal(value: object) -> object:
    if not isinstance(value, str) or not _DECIMAL_TEXT.fullmatch(value):
        return value
    try:
        parsed = Decimal(value)
        exponent = parsed.as_tuple().exponent
        if parsed.is_finite() and isinstance(exponent, int) and abs(exponent) <= 4096:
            return parsed
    except DecimalException:
        pass
    return value  # Preserve invalid input for the existing located diagnostic.


def decode_parameter_value(definition: ParameterDefinition, value: object) -> object:
    """Decode catalog-declared JSON shapes, retaining invalid/inactive values."""
    kind = definition.type
    if kind in _DECIMAL_TYPES:
        value = _json_decimal(value)
    elif kind is ParameterType.NUMBER_LIST and isinstance(value, (list, tuple)):
        value = tuple(_json_decimal(item) for item in value)
    elif kind is ParameterType.DATE and isinstance(value, str):
        try:
            parsed = date.fromisoformat(value)
            if parsed.isoformat() == value:
                value = parsed
        except ValueError:
            pass
    return value


def parse_parameter_value(definition: ParameterDefinition, value: object) -> object:
    """Accept exact Decimal JSON text without guessing types of symbols/enums."""
    kind = definition.type
    value = decode_parameter_value(definition, value)
    validate_parameter_value(definition, value)
    if kind in _DECIMAL_TYPES and value is not None:
        return Decimal(str(value))
    if kind is ParameterType.SYMBOL and isinstance(value, str):
        return value.strip()
    if kind in {ParameterType.NUMBER_LIST, ParameterType.ENUM_LIST} and isinstance(
        value, (list, tuple)
    ):
        return tuple(value)
    return thaw_value(value)

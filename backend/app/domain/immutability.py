"""Small immutable containers used by saved domain snapshots."""

from collections.abc import Iterator, Mapping
from types import MappingProxyType
from typing import TypeAlias

FrozenValue: TypeAlias = object


class FrozenMap(Mapping[str, FrozenValue]):
    """A read-only, recursively frozen mapping with normal mapping semantics."""

    __slots__ = ("_values",)
    _values: Mapping[str, FrozenValue]

    def __init__(self, values: Mapping[str, object]) -> None:
        frozen = {
            key: freeze_value(value)
            for key, value in values.items()
            if isinstance(key, str)
        }
        if len(frozen) != len(values):
            raise TypeError("frozen mappings require string keys")
        object.__setattr__(self, "_values", MappingProxyType(frozen))

    def __getitem__(self, key: str) -> FrozenValue:
        return self._values[key]

    def __iter__(self) -> Iterator[str]:
        return iter(self._values)

    def __len__(self) -> int:
        return len(self._values)

    def __repr__(self) -> str:
        return f"FrozenMap({dict(self._values)!r})"


def freeze_value(value: object) -> FrozenValue:
    """Recursively convert mutable JSON-like containers to immutable values."""

    if isinstance(value, FrozenMap):
        return value
    if isinstance(value, Mapping):
        return FrozenMap(value)
    if isinstance(value, (list, tuple)):
        return tuple(freeze_value(item) for item in value)
    if isinstance(value, (set, frozenset)):
        raise TypeError("unordered values are not stable snapshot parameters")
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    # Domain parameter values may include scalar date/Decimal values; both are
    # immutable already and Pydantic serializes them through its normal encoder.
    from datetime import date, datetime
    from decimal import Decimal

    if isinstance(value, (date, datetime, Decimal)):
        return value
    raise TypeError(f"unsupported snapshot value: {type(value).__name__}")


def freeze_mapping(value: Mapping[str, object]) -> FrozenMap:
    """Freeze a mapping while preserving its keys for stable parameter names."""

    return value if isinstance(value, FrozenMap) else FrozenMap(value)


def thaw_value(value: object) -> object:
    """Return JSON-serializable mutable containers for Pydantic serializers."""

    if isinstance(value, Mapping):
        return {key: thaw_value(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [thaw_value(item) for item in value]
    return value

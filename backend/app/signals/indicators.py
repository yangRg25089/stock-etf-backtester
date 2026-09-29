"""Deterministic, Decimal-based technical indicators with explicit warmup."""

from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal

INDICATOR_METHOD_VERSION = "indicators-v1"


@dataclass(frozen=True, slots=True)
class BollingerBands:
    middle: Decimal
    lower: Decimal
    upper: Decimal


def simple_moving_average(
    values: Sequence[Decimal | None], *, period: int
) -> tuple[Decimal | None, ...]:
    """Return a trailing simple average; incomplete windows are unavailable."""

    _require_period(period)
    output: list[Decimal | None] = [None] * len(values)
    for end in range(period - 1, len(values)):
        window = values[end - period + 1 : end + 1]
        if all(value is not None for value in window):
            output[end] = sum(
                (value for value in window if value is not None), Decimal("0")
            ) / Decimal(period)
    return tuple(output)


def relative_strength_index(
    values: Sequence[Decimal | None], *, period: int
) -> tuple[Decimal | None, ...]:
    """Compute RSI from rolling arithmetic means of gains and losses.

    This matches the notebook's ``rolling(period).mean()`` calculation. A flat
    window remains unavailable because that formula divides zero by zero.
    """

    _require_period(period)
    deltas: list[Decimal | None] = [None]
    for previous, current in zip(values[:-1], values[1:], strict=True):
        deltas.append(
            None if previous is None or current is None else current - previous
        )

    gains = tuple(
        None if value is None else max(value, Decimal("0")) for value in deltas
    )
    losses = tuple(
        None if value is None else max(-value, Decimal("0")) for value in deltas
    )
    output: list[Decimal | None] = [None] * len(values)
    for end in range(period, len(values)):
        gain_window = gains[end - period + 1 : end + 1]
        loss_window = losses[end - period + 1 : end + 1]
        if any(value is None for value in (*gain_window, *loss_window)):
            continue
        average_gain = sum(
            (value for value in gain_window if value is not None), Decimal("0")
        ) / Decimal(period)
        average_loss = sum(
            (value for value in loss_window if value is not None), Decimal("0")
        ) / Decimal(period)
        if average_loss == 0:
            if average_gain > 0:
                output[end] = Decimal("100")
            continue
        relative_strength = average_gain / average_loss
        output[end] = Decimal("100") - Decimal("100") / (
            Decimal("1") + relative_strength
        )
    return tuple(output)


def bollinger_bands(
    values: Sequence[Decimal | None], *, period: int, deviations: Decimal
) -> tuple[BollingerBands | None, ...]:
    """Return a simple-average band using the sample standard deviation."""

    _require_period(period)
    if not deviations.is_finite() or deviations <= 0:
        raise ValueError("deviations must be a positive finite number")
    output: list[BollingerBands | None] = [None] * len(values)
    if period < 2:
        return tuple(output)
    for end in range(period - 1, len(values)):
        window = values[end - period + 1 : end + 1]
        if any(value is None for value in window):
            continue
        average = sum(
            (value for value in window if value is not None), Decimal("0")
        ) / Decimal(period)
        variance = sum(
            ((value - average) ** 2 for value in window if value is not None),
            Decimal("0"),
        ) / Decimal(period - 1)
        spread = variance.sqrt() * deviations
        output[end] = BollingerBands(
            middle=average,
            lower=average - spread,
            upper=average + spread,
        )
    return tuple(output)


def _require_period(period: int) -> None:
    if isinstance(period, bool) or not isinstance(period, int) or period <= 0:
        raise ValueError("period must be a positive integer")

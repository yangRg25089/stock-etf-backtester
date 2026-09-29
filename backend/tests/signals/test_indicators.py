from decimal import Decimal

import pytest

from app.signals.indicators import (
    INDICATOR_METHOD_VERSION,
    bollinger_bands,
    relative_strength_index,
    simple_moving_average,
)


def test_indicator_methods_have_a_versioned_contract() -> None:
    assert INDICATOR_METHOD_VERSION == "indicators-v1"


def test_simple_moving_average_uses_trailing_values_and_reports_warmup() -> None:
    result = simple_moving_average(tuple(map(Decimal, ("1", "2", "3", "4"))), period=3)

    assert result == (None, None, Decimal("2"), Decimal("3"))


def test_rsi_uses_rolling_arithmetic_mean_and_not_wilder_smoothing() -> None:
    result = relative_strength_index(
        tuple(map(Decimal, ("100", "98", "96", "97", "99"))), period=2
    )

    assert result[0:2] == (None, None)
    assert result[2] == Decimal("0")
    assert result[3] == Decimal(100) / Decimal(3)
    assert result[4] == Decimal("100")


def test_rsi_is_unavailable_for_flat_window_like_the_notebook_formula() -> None:
    result = relative_strength_index(tuple(map(Decimal, ("5", "5", "5"))), period=2)

    assert result == (None, None, None)


def test_bollinger_bands_use_sample_standard_deviation() -> None:
    result = bollinger_bands(
        tuple(map(Decimal, ("1", "2", "3"))), period=3, deviations=Decimal("1")
    )

    assert result[0] is None
    assert result[1] is None
    assert result[2] is not None
    assert result[2].middle == Decimal("2")
    assert result[2].lower == Decimal("1")
    assert result[2].upper == Decimal("3")


@pytest.mark.parametrize(
    "calculate",
    [
        lambda: simple_moving_average((Decimal("1"),), period=0),
        lambda: relative_strength_index((Decimal("1"),), period=0),
        lambda: bollinger_bands((Decimal("1"),), period=0, deviations=Decimal("1")),
    ],
)
def test_indicators_reject_non_positive_periods(calculate: object) -> None:
    with pytest.raises(ValueError, match="period"):
        calculate()  # type: ignore[operator]

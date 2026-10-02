from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.domain.contracts import StrategyRun
from app.signals import evaluate_signals
from app.signals.indicators import bollinger_bands, relative_strength_index
from tests.signals.test_condition_trees import config, group, leaf
from tests.signals.test_evaluate import _SESSIONS, _snapshot


def test_ma_values_reuse_signal_cache_and_deduplicate_equal_periods(monkeypatch):
    import app.signals.evaluate as module

    calls = []
    original = module.simple_moving_average

    def counted(values, *, period):
        calls.append(period)
        return original(values, period=period)

    monkeypatch.setattr(module, "simple_moving_average", counted)
    frozen, _ = config(
        group(
            "entry",
            "AND",
            leaf("ma", "ma_trend", {"ma.period": 2}),
            leaf("deviation", "ma_deviation", {"ma.period": 2}),
        ),
        leaf("exit", "ma_trend", {"ma.period": 3}),
    )
    series = evaluate_signals(
        frozen,
        _snapshot(("10", "12", "11", "15", "16", "17", "18")),
        sessions=_SESSIONS,
    ).strategies[0]
    assert calls == [2, 3]
    assert [(item.kind, item.period) for item in series.technical_indicators] == [
        ("ma", 2),
        ("ma", 3),
    ]
    assert [sample.date for sample in series.technical_indicators[0].samples] == list(
        _SESSIONS[2:]
    )
    assert series.technical_indicators[0].samples[0].value == Decimal("11.5")
    assert series.technical_indicators[1].samples[0].value == Decimal("11")


def test_bollinger_and_rsi_keep_exact_shared_values_and_saved_parameters():
    frozen, _ = config(
        group(
            "entry",
            "OR",
            leaf(
                "band",
                "bollinger",
                {"bollinger.period": 3, "bollinger.stddev": Decimal("2.5")},
            ),
            leaf("strength", "rsi", {"rsi.period": 2}),
        )
    )
    prices = ("10", "12", "11", "15", "16", "17", "18")
    series = evaluate_signals(frozen, _snapshot(prices), sessions=_SESSIONS).strategies[
        0
    ]
    band = next(
        item for item in series.technical_indicators if item.kind == "bollinger"
    )
    strength = next(item for item in series.technical_indicators if item.kind == "rsi")
    assert band.period == 3 and band.deviations == Decimal("2.5")
    expected_bands = bollinger_bands(
        tuple(map(Decimal, prices)), period=3, deviations=Decimal("2.5")
    )[2:]
    expected_rsi = relative_strength_index(tuple(map(Decimal, prices)), period=2)[2:]
    for sample, expected in zip(band.samples, expected_bands, strict=True):
        assert (sample.value, sample.lower, sample.upper) == (
            expected.middle,
            expected.lower,
            expected.upper,
        )
    assert tuple(sample.value for sample in strength.samples) == expected_rsi


def test_warmup_nulls_and_disabled_conditions_are_not_fabricated():
    frozen, _ = config(
        group(
            "entry",
            "AND",
            leaf("ma", "ma_trend", {"ma.period": 5}),
            leaf("off", "rsi", {"rsi.period": 2}, enabled=False),
        )
    )
    series = evaluate_signals(
        frozen,
        _snapshot(("10", "12", "11", "15", "16", "17", "18")),
        sessions=_SESSIONS,
    ).strategies[0]
    assert len(series.technical_indicators) == 1
    assert [sample.value for sample in series.technical_indicators[0].samples[:3]] == [
        None,
        None,
        Decimal("12.8"),
    ]


def test_saved_technical_series_roundtrip_and_old_results_default_empty():
    frozen, _ = config(leaf("ma", "ma_trend", {"ma.period": 2}))
    series = evaluate_signals(
        frozen,
        _snapshot(("10", "12", "11", "15", "16", "17", "18")),
        sessions=_SESSIONS,
    ).strategies[0]
    saved = StrategyRun(
        id="saved",
        presetId="ma_trend",
        role="strategy",
        technicalIndicators=series.technical_indicators,
    )
    assert (
        StrategyRun.model_validate_json(saved.model_dump_json()).technical_indicators
        == series.technical_indicators
    )
    assert (
        StrategyRun(id="old", presetId="ma_trend", role="strategy").technical_indicators
        == ()
    )


def test_invalid_technical_parameters_and_values_are_rejected():
    from app.domain.contracts import TechnicalIndicatorSeries

    for data in [
        {"kind": "ma", "period": 0},
        {"kind": "ma", "period": 2, "deviations": 2},
        {"kind": "bollinger", "period": 2},
        {"kind": "bollinger", "period": 2, "deviations": -2},
        {
            "kind": "rsi",
            "period": 2,
            "samples": [{"date": _SESSIONS[0], "value": "NaN"}],
        },
        {
            "kind": "rsi",
            "period": 2,
            "samples": [{"date": _SESSIONS[0], "value": "101"}],
        },
        {
            "kind": "ma",
            "period": 2,
            "samples": [{"date": _SESSIONS[0], "value": 10, "upper": 12}],
        },
    ]:
        with pytest.raises(ValidationError):
            TechnicalIndicatorSeries.model_validate(data)

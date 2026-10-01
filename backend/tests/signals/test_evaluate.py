from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest

from app.config.validation import validate_draft
from app.domain.contracts import (
    DataSnapshot,
    FrozenRunConfig,
    MacroObservation,
    MarketBar,
    MarketSnapshot,
    ValuationSnapshot,
)
from app.domain.status import DiagnosticCode, SignalState
from app.signals.evaluate import StrategySignalSeries, evaluate_signals

_SESSIONS = tuple(date(2024, 1, day) for day in range(1, 8))


def _config(
    *, preset: str = "composite_dca", params: dict[str, object] | None = None
) -> FrozenRunConfig:
    return _config_for_strategies(
        [
            {
                "id": "strategy-1",
                "presetId": preset,
                "enabled": True,
                "params": {} if params is None else params,
            }
        ],
        ("strategy-1",),
    )


def test_legacy_instance_flag_does_not_skip_signal_evaluation() -> None:
    config = _config(preset="vix_dca")
    legacy = config.strategies[0].model_copy(update={"enabled": False})
    config = config.model_copy(update={"strategies": (legacy,)})
    batch = evaluate_signals(
        config,
        _snapshot(
            tuple("100" for _ in _SESSIONS), vix_values={day: "30" for day in _SESSIONS}
        ),
        sessions=_SESSIONS,
    )
    assert tuple(item.strategy_id for item in batch.strategies) == (legacy.id,)
    assert batch.strategy(legacy.id).evaluations


def _config_for_strategies(
    strategies: list[dict[str, object]], strategy_ids: tuple[str, ...]
) -> FrozenRunConfig:
    result = validate_draft(
        {
            "shared": {
                "run": {
                    "symbol": "QQQ",
                    "startDate": _SESSIONS[2],
                    "endDate": _SESSIONS[-1],
                    "endMode": "fixed",
                }
            },
            "strategies": strategies,
        }
    )
    assert result.diagnostics_for() == ()
    config = result.config_for(strategy_ids)
    assert config is not None
    return config


def _snapshot(
    prices: tuple[str | None, ...],
    *,
    valuation_prices: tuple[str, ...] | None = None,
    vix_values: dict[date, str] | None = None,
    rate_values: dict[date, str] | None = None,
    pe_values: dict[date, str] | None = None,
    vix_unit: str = "index_points",
    rate_unit: str = "percent_point",
) -> DataSnapshot:
    valuation_prices = prices if valuation_prices is None else valuation_prices
    bars = tuple(
        MarketBar(
            date=day,
            symbol="QQQ",
            simulationPrice=Decimal(value),
            valuationPrice=Decimal(valuation_price),
            currency="USD",
            source="fixture",
            observedAt=datetime.combine(day, datetime.min.time(), UTC),
        )
        for day, value, valuation_price in zip(
            _SESSIONS, prices, valuation_prices, strict=True
        )
        if value is not None
    )
    macros = tuple(
        MacroObservation(
            date=day - timedelta(days=1),
            symbol=symbol,
            value=Decimal(value),
            unit=vix_unit if symbol == "^VIX" else rate_unit,
            source="fixture",
            observedAt=datetime.combine(
                day - timedelta(days=1), datetime.min.time(), UTC
            ),
            alignedSessionDate=day,
        )
        for symbol, values in (("^VIX", vix_values), ("^TNX", rate_values))
        if values is not None
        for day, value in values.items()
    )
    valuations = tuple(
        {
            "date": day,
            "symbol": "QQQ",
            "valuationPrice": Decimal("100"),
            "eps": Decimal("4"),
            "pe": Decimal(value),
            "currency": "USD",
            "method": "fixture",
            "source": "fixture",
            "asOf": day,
        }
        for day, value in ({} if pe_values is None else pe_values).items()
    )
    return DataSnapshot(
        market=MarketSnapshot(
            symbol="QQQ",
            currency="USD",
            bars=bars,
            source="fixture",
            fingerprint="market-fixture",
        ),
        macro=macros,
        valuation=(
            None
            if pe_values is None
            else ValuationSnapshot(
                symbol="QQQ",
                observations=valuations,
                fingerprint="valuation-fixture",
            )
        ),
        fingerprint="snapshot-fixture",
    )


def _states(series: StrategySignalSeries, on: date) -> dict[str, SignalState]:
    return {
        evaluation.signal_id: evaluation.state
        for evaluation in series.evaluations
        if evaluation.date == on
    }


def test_vix_boundary_is_inclusive_and_aggregate_buy_uses_the_enabled_set() -> None:
    day = _SESSIONS[2]
    config = _config(
        params={
            "vix.buyEnabled": True,
            "rsi.buyEnabled": False,
            "ma.buyEnabled": False,
            "bollinger.buyEnabled": False,
            "rate.buyEnabled": False,
            "pe.buyEnabled": False,
            "exit.enabled": False,
        }
    )

    result = evaluate_signals(
        config,
        _snapshot(
            ("10", "11", "12", "13", "14", "15", "16"),
            vix_values={session: "25" for session in _SESSIONS[2:]},
        ),
        sessions=_SESSIONS,
    )

    states = _states(result.strategies[0], day)
    assert states["vix.buy"] is SignalState.TRUE
    assert states["accumulation.buy"] is SignalState.TRUE
    observed_vix = next(
        evaluation
        for evaluation in result.strategies[0].evaluations
        if evaluation.date == day and evaluation.signal_id == "vix.buy"
    )
    assert observed_vix.observed_value == Decimal("25")
    assert result.strategies[0].available is True


def test_rsi_buy_threshold_is_inclusive_and_uses_rolling_average() -> None:
    day = _SESSIONS[2]
    config = _config(
        params={
            "vix.buyEnabled": False,
            "rsi.buyEnabled": True,
            "rsi.period": 2,
            "rsi.buyThreshold": Decimal("0"),
            "ma.buyEnabled": False,
            "bollinger.buyEnabled": False,
            "rate.buyEnabled": False,
            "pe.buyEnabled": False,
            "exit.enabled": False,
        }
    )

    result = evaluate_signals(
        config,
        _snapshot(("100", "98", "96", "94", "92", "90", "88")),
        sessions=_SESSIONS,
    )

    assert _states(result.strategies[0], day)["rsi.buy"] is SignalState.TRUE
    assert result.strategies[0].available is True


def test_ma_deviation_buy_threshold_is_inclusive() -> None:
    day = _SESSIONS[2]
    config = _config(
        params={
            "vix.buyEnabled": False,
            "rsi.buyEnabled": False,
            "ma.buyEnabled": True,
            "ma.period": 3,
            "ma.buyDeviationPct": Decimal("0"),
            "bollinger.buyEnabled": False,
            "rate.buyEnabled": False,
            "pe.buyEnabled": False,
            "exit.enabled": False,
        }
    )

    result = evaluate_signals(
        config,
        _snapshot(("10", "10", "10", "10", "10", "10", "10")),
        sessions=_SESSIONS,
    )

    assert _states(result.strategies[0], day)["ma.buy"] is SignalState.TRUE


def test_bollinger_buy_and_sell_use_inclusive_price_edges_and_vix_ceiling() -> None:
    day = _SESSIONS[2]
    config = _config(
        params={
            "vix.buyEnabled": False,
            "rsi.buyEnabled": False,
            "ma.buyEnabled": False,
            "bollinger.buyEnabled": True,
            "bollinger.period": 3,
            "bollinger.stddev": Decimal("1"),
            "rate.buyEnabled": False,
            "pe.buyEnabled": False,
            "exit.enabled": True,
            "exit.bollinger.enabled": True,
            "exit.bollinger.vixCeiling": Decimal("20"),
        }
    )
    snapshot = _snapshot(
        ("10", "10", "10", "10", "10", "10", "10"),
        vix_values={
            session: "20" if session == _SESSIONS[3] else "19.99"
            for session in _SESSIONS[2:]
        },
    )

    result = evaluate_signals(config, snapshot, sessions=_SESSIONS)

    states = _states(result.strategies[0], day)
    assert states["bollinger.buy"] is SignalState.TRUE
    assert states["bollinger.exit"] is SignalState.TRUE
    assert states["bollinger.exit.vix"] is SignalState.TRUE
    assert (
        _states(result.strategies[0], _SESSIONS[3])["bollinger.exit.vix"]
        is SignalState.FALSE
    )
    assert result.strategies[0].available is True


def test_vix_sell_levels_check_the_lower_tier_first() -> None:
    days = _SESSIONS[2:]
    config = _config(
        params={
            "vix.buyEnabled": False,
            "rsi.buyEnabled": False,
            "ma.buyEnabled": False,
            "bollinger.buyEnabled": False,
            "rate.buyEnabled": False,
            "pe.buyEnabled": False,
            "exit.enabled": True,
        }
    )
    snapshot = _snapshot(
        ("10", "10", "10", "10", "10", "10", "10"),
        vix_values=dict(zip(days, ("10", "12", "13", "9", "14"), strict=True)),
    )

    result = evaluate_signals(config, snapshot, sessions=_SESSIONS)

    assert _states(result.strategies[0], days[0])["vix.exit.low2"] is SignalState.TRUE
    assert _states(result.strategies[0], days[0])["vix.exit.low1"] is SignalState.FALSE
    assert _states(result.strategies[0], days[1])["vix.exit.low1"] is SignalState.TRUE
    assert _states(result.strategies[0], days[1])["vix.exit.low2"] is SignalState.FALSE


def test_rsi_sell_threshold_is_inclusive_when_rsi_buy_is_disabled() -> None:
    day = _SESSIONS[2]
    config = _config(
        params={
            "vix.buyEnabled": False,
            "rsi.buyEnabled": False,
            "rsi.period": 2,
            "ma.buyEnabled": False,
            "bollinger.buyEnabled": False,
            "rate.buyEnabled": False,
            "pe.buyEnabled": False,
            "exit.enabled": True,
            "exit.rsi.enabled": True,
            "exit.rsi.threshold": Decimal("100"),
        }
    )
    snapshot = _snapshot(
        ("10", "12", "14", "16", "18", "20", "22"),
        vix_values={session: "15" for session in _SESSIONS[2:]},
    )

    result = evaluate_signals(config, snapshot, sessions=_SESSIONS)

    states = _states(result.strategies[0], day)
    assert "rsi.buy" not in states
    assert states["rsi.exit"] is SignalState.TRUE


def test_unnormalized_rate_unit_is_unavailable_instead_of_guessed() -> None:
    day = _SESSIONS[2]
    config = _config(
        params={
            "vix.buyEnabled": False,
            "rsi.buyEnabled": False,
            "ma.buyEnabled": False,
            "bollinger.buyEnabled": False,
            "rate.buyEnabled": True,
            "pe.buyEnabled": False,
            "exit.enabled": False,
        }
    )
    snapshot = _snapshot(
        ("10", "11", "12", "13", "14", "15", "16"),
        rate_values={session: "0.025" for session in _SESSIONS[2:]},
        rate_unit="decimal",
    )

    result = evaluate_signals(config, snapshot, sessions=_SESSIONS)

    signal = next(
        evaluation
        for evaluation in result.strategies[0].evaluations
        if evaluation.date == day and evaluation.signal_id == "rate.buy"
    )
    assert signal.state is SignalState.UNAVAILABLE
    assert signal.diagnostics[0].code is DiagnosticCode.UNKNOWN_SOURCE_UNIT


def test_unavailable_signal_only_marks_the_strategy_that_depends_on_it() -> None:
    enabled_buy_params = {
        "vix.buyEnabled": True,
        "rsi.buyEnabled": False,
        "ma.buyEnabled": False,
        "bollinger.buyEnabled": False,
        "rate.buyEnabled": False,
        "pe.buyEnabled": True,
        "exit.enabled": False,
    }
    config = _config_for_strategies(
        [
            {
                "id": "signal-dependent",
                "presetId": "composite_dca",
                "enabled": True,
                "params": enabled_buy_params,
            },
            {
                "id": "independent",
                "presetId": "monthly_dca",
                "enabled": True,
                "params": {},
            },
        ],
        ("signal-dependent", "independent"),
    )
    snapshot = _snapshot(
        ("10", "11", "12", "13", "14", "15", "16"),
        vix_values={session: "25" for session in _SESSIONS[2:]},
    )

    result = evaluate_signals(config, snapshot, sessions=_SESSIONS)

    assert result.strategy("signal-dependent").available is False
    assert len(result.strategy("signal-dependent").diagnostics) == len(_SESSIONS[2:])
    assert result.strategy("independent").available is True


@pytest.mark.parametrize("logic", ["AND", "OR"])
def test_any_enabled_unavailable_buy_blocks_the_whole_strategy_even_with_vix_true(
    logic: str,
) -> None:
    day = _SESSIONS[2]
    config = _config(
        params={
            "accumulation.conditionLogic": logic,
            "vix.buyEnabled": True,
            "rsi.buyEnabled": False,
            "ma.buyEnabled": False,
            "bollinger.buyEnabled": False,
            "rate.buyEnabled": False,
            "pe.buyEnabled": True,
            "exit.enabled": False,
        }
    )

    result = evaluate_signals(
        config,
        _snapshot(
            ("10", "11", "12", "13", "14", "15", "16"),
            vix_values={day: "30"},
        ),
        sessions=_SESSIONS,
    )

    series = result.strategies[0]
    states = _states(series, day)
    assert states["vix.buy"] is SignalState.TRUE
    assert states["pe.buy"] is SignalState.UNAVAILABLE
    assert states["accumulation.buy"] is SignalState.UNAVAILABLE
    assert series.available is False
    assert any(
        diagnostic.code is DiagnosticCode.REQUIRED_DATA_UNAVAILABLE
        for diagnostic in series.diagnostics
    )


def test_no_enabled_buy_signals_evaluates_false_without_creating_dependencies() -> None:
    day = _SESSIONS[2]
    config = _config(
        params={
            "vix.buyEnabled": False,
            "rsi.buyEnabled": False,
            "ma.buyEnabled": False,
            "bollinger.buyEnabled": False,
            "rate.buyEnabled": False,
            "pe.buyEnabled": False,
            "exit.enabled": False,
        }
    )

    result = evaluate_signals(
        config,
        _snapshot(("10", "11", "12", "13", "14", "15", "16")),
        sessions=_SESSIONS,
    )

    states = _states(result.strategies[0], day)
    assert states["accumulation.buy"] is SignalState.FALSE
    assert "vix.buy" not in states
    assert result.strategies[0].available is True


def test_buy_switch_does_not_disable_an_independent_vix_sell_signal() -> None:
    day = _SESSIONS[2]
    config = _config(
        params={
            "vix.buyEnabled": False,
            "rsi.buyEnabled": False,
            "ma.buyEnabled": False,
            "bollinger.buyEnabled": False,
            "rate.buyEnabled": False,
            "pe.buyEnabled": False,
            "exit.enabled": True,
        }
    )

    result = evaluate_signals(
        config,
        _snapshot(("10", "11", "12", "13", "14", "15", "16")),
        sessions=_SESSIONS,
    )

    states = _states(result.strategies[0], day)
    assert "vix.buy" not in states
    assert states["vix.exit.low1"] is SignalState.UNAVAILABLE
    assert states["vix.exit.low2"] is SignalState.UNAVAILABLE
    assert states["accumulation.buy"] is SignalState.FALSE
    assert result.strategies[0].available is False


def test_trend_uses_simulation_price_and_requires_price_above_average() -> None:
    day = _SESSIONS[2]
    config = _config(preset="ma_trend", params={"ma.period": 2})
    snapshot = _snapshot(
        ("10", "12", "11", "15", "16", "17", "18"),
        valuation_prices=("100", "100", "1000", "100", "100", "100", "100"),
    )

    result = evaluate_signals(config, snapshot, sessions=_SESSIONS)

    states = _states(result.strategies[0], day)
    assert states["ma.trend"] is SignalState.FALSE
    assert states["ma.trend.sell"] is SignalState.TRUE
    assert result.strategies[0].available is True


def test_rate_and_pe_use_normalized_values_and_inclusive_thresholds() -> None:
    day = _SESSIONS[2]
    config = _config(
        params={
            "vix.buyEnabled": False,
            "rsi.buyEnabled": False,
            "ma.buyEnabled": False,
            "bollinger.buyEnabled": False,
            "rate.buyEnabled": True,
            "pe.buyEnabled": True,
            "rate.thresholdPct": Decimal("2.5"),
            "pe.threshold": Decimal("25"),
            "exit.enabled": False,
        }
    )
    snapshot = _snapshot(
        ("10", "11", "12", "13", "14", "15", "16"),
        rate_values={day: "2.5"},
        pe_values={day: "25"},
    )

    result = evaluate_signals(config, snapshot, sessions=_SESSIONS)

    states = _states(result.strategies[0], day)
    assert states["rate.buy"] is SignalState.TRUE
    assert states["pe.buy"] is SignalState.TRUE
    assert states["accumulation.buy"] is SignalState.TRUE


def test_valuation_snapshot_for_a_different_symbol_is_unavailable() -> None:
    day = _SESSIONS[2]
    config = _config(
        params={
            "vix.buyEnabled": False,
            "rsi.buyEnabled": False,
            "ma.buyEnabled": False,
            "bollinger.buyEnabled": False,
            "rate.buyEnabled": False,
            "pe.buyEnabled": True,
            "exit.enabled": False,
        }
    )
    snapshot = _snapshot(
        ("10", "11", "12", "13", "14", "15", "16"),
        pe_values={session: "20" for session in _SESSIONS[2:]},
    )
    market = snapshot.market.model_copy(
        update={
            "symbol": "SPY",
            "bars": tuple(
                bar.model_copy(update={"symbol": "SPY"}) for bar in snapshot.market.bars
            ),
        }
    )
    valuation = snapshot.valuation
    assert valuation is not None
    snapshot = DataSnapshot(
        market=market,
        macro=snapshot.macro,
        valuation=valuation.model_copy(
            update={
                "symbol": "SPY",
                "observations": tuple(
                    observation.model_copy(update={"symbol": "SPY"})
                    for observation in valuation.observations
                ),
            }
        ),
        fingerprint="other-symbol-snapshot",
    )

    result = evaluate_signals(config, snapshot, sessions=_SESSIONS)

    assert _states(result.strategies[0], day)["pe.buy"] is SignalState.UNAVAILABLE


def test_missing_market_session_is_unavailable_instead_of_silently_skipped() -> None:
    missing_day = _SESSIONS[3]
    config = _config(preset="monthly_dca")
    prices: tuple[str | None, ...] = ("10", "11", "12", None, "14", "15", "16")

    result = evaluate_signals(
        config,
        _snapshot(prices),
        sessions=_SESSIONS,
    )

    states = _states(result.strategies[0], missing_day)
    assert states["market.price"] is SignalState.UNAVAILABLE
    assert result.strategies[0].available is False


def test_duplicate_market_dates_are_rejected_instead_of_overwritten() -> None:
    config = _config(preset="monthly_dca")
    snapshot = _snapshot(("10", "11", "12", "13", "14", "15", "16"))
    market = snapshot.market.model_copy(
        update={"bars": (*snapshot.market.bars, snapshot.market.bars[-1])}
    )

    with pytest.raises(ValueError, match="duplicate market bar"):
        evaluate_signals(
            config,
            snapshot.model_copy(update={"market": market}),
            sessions=_SESSIONS,
        )


def test_only_run_sessions_are_emitted_while_earlier_bars_warm_the_ma() -> None:
    day = _SESSIONS[2]
    config = _config(preset="ma_buy_only", params={"ma.period": 2})

    result = evaluate_signals(
        config,
        _snapshot(("10", "12", "11", "15", "16", "17", "18")),
        sessions=_SESSIONS,
    )

    series = result.strategies[0]
    assert {evaluation.date for evaluation in series.evaluations} == set(_SESSIONS[2:])
    assert _states(series, day)["ma.trend"] is SignalState.FALSE


def test_non_sorted_session_input_is_rejected() -> None:
    config = _config(preset="monthly_dca")

    with pytest.raises(ValueError, match="sorted and unique"):
        evaluate_signals(
            config,
            _snapshot(("10", "11", "12", "13", "14", "15", "16")),
            sessions=(_SESSIONS[1], _SESSIONS[0]),
        )

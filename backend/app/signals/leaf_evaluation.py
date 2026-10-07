"""Atomic condition evaluation and observation decoration; no tree traversal."""

from collections.abc import Callable
from datetime import date
from decimal import Decimal
from operator import ge, le, lt
from typing import Literal

from app.domain.conditions import (
    ConditionKind,
    ConditionLeaf,
    ConditionLogic,
    condition_signal_id,
)
from app.domain.contracts import (
    SignalEvaluation,
)
from app.domain.immutability import freeze_mapping
from app.domain.status import (
    SignalState,
)

from .conditions import combine_conditions
from .context import LeafContext
from .indicators import (
    bollinger_bands,
    relative_strength_index,
    simple_moving_average,
)
from .observations import (
    _append_vix_exit_signals,
    _decimal_parameter,
    _macro_threshold_evaluation,
    _period_parameter,
    _price_threshold_evaluation,
)


def evaluate_leaf(
    node: ConditionLeaf,
    side: Literal["buy", "sell"],
    day: date,
    path: str,
    state: LeafContext,
) -> SignalEvaluation:
    index, strategy, context = state.index, state.strategy, state.context
    symbol, prices, positions = state.symbol, state.prices, state.positions
    moving_averages, strength_indices = state.moving_averages, state.strength_indices
    band_cache, evaluations = state.band_cache, state.evaluations
    params = node.params
    signal_id = condition_signal_id(node, side)
    leaf_strategy = strategy.model_copy(update={"params": params})
    position = positions[day]
    price = prices[position]
    is_buy = side == "buy"

    def decorate(
        evaluation: SignalEvaluation, key: str, source_symbol: str = symbol
    ) -> SignalEvaluation:
        diagnostics = tuple(
            diagnostic.model_copy(
                update={
                    "field_path": f"{path}.params.{key}",
                    "details": freeze_mapping(
                        {
                            **diagnostic.details,
                            "conditionId": node.id,
                            "signalId": evaluation.signal_id,
                        }
                    ),
                }
            )
            for diagnostic in evaluation.diagnostics
        )
        return evaluation.model_copy(
            update={
                "condition_id": node.id,
                "condition_kind": node.kind,
                "source_symbol": source_symbol,
                "diagnostics": diagnostics,
            }
        )

    def market(
        value: Decimal | None,
        key: str,
        compare: Callable[[Decimal], bool],
        name: str = signal_id,
    ) -> SignalEvaluation:
        evaluation = _price_threshold_evaluation(
            index, leaf_strategy, day, name, key, value, compare, symbol
        )
        return decorate(evaluation.model_copy(update={"observed_value": value}), key)

    def moving_average() -> Decimal | None:
        period = _period_parameter(params, "ma.period")
        if period not in moving_averages:
            moving_averages[period] = simple_moving_average(prices, period=period)
        return moving_averages[period][position]

    if node.kind is ConditionKind.VIX:
        source_symbol = str(params["vix.symbol"])
        if is_buy:
            evaluation = decorate(
                _macro_threshold_evaluation(
                    index,
                    leaf_strategy,
                    context,
                    day,
                    signal_id=signal_id,
                    parameter_key="vix.buyThreshold",
                    symbol=source_symbol,
                    unit="index_points",
                    threshold=_decimal_parameter(params, "vix.buyThreshold"),
                    compare=ge,
                ),
                "vix.buyThreshold",
                source_symbol,
            )
        else:
            tiers: list[SignalEvaluation] = []
            _append_vix_exit_signals(index, leaf_strategy, context, day, params, tiers)
            decorated = tuple(
                decorate(
                    tier.model_copy(
                        update={
                            "signal_id": f"{signal_id}.low{number}",
                            "sell_ratio": _decimal_parameter(
                                params, f"exit.vix.ratio{number}"
                            )
                            if tier.state is SignalState.TRUE
                            else Decimal("0"),
                            "triggered_signal_ids": (f"{signal_id}.low{number}",)
                            if tier.state is SignalState.TRUE
                            else (),
                        }
                    ),
                    f"exit.vix.low{number}",
                    source_symbol,
                )
                for number, tier in enumerate(tiers, 1)
            )
            evaluations.extend(decorated)
            evaluation = decorate(
                combine_conditions(
                    day, signal_id, ConditionLogic.OR, decorated
                ).model_copy(
                    update={
                        "observed_value": decorated[0].observed_value,
                        "observed_unit": "index_points",
                    }
                ),
                "vix.symbol",
                source_symbol,
            )
    elif node.kind is ConditionKind.RATE:
        source_symbol = str(params["rate.symbol"])
        evaluation = decorate(
            _macro_threshold_evaluation(
                index,
                leaf_strategy,
                context,
                day,
                signal_id=signal_id,
                parameter_key="rate.thresholdPct",
                symbol=source_symbol,
                unit="percent_point",
                threshold=_decimal_parameter(params, "rate.thresholdPct"),
                compare=le if is_buy else ge,
            ),
            "rate.thresholdPct",
            source_symbol,
        )
    elif node.kind is ConditionKind.RSI:
        period = _period_parameter(params, "rsi.period")
        if period not in strength_indices:
            strength_indices[period] = relative_strength_index(prices, period=period)
        threshold_key = "rsi.buyThreshold" if is_buy else "exit.rsi.threshold"
        threshold = _decimal_parameter(params, threshold_key)
        evaluation = market(
            strength_indices[period][position],
            threshold_key,
            lambda value: value <= threshold if is_buy else value >= threshold,
        )
    elif node.kind in {ConditionKind.MA_DEVIATION, ConditionKind.MA_TREND}:
        average = moving_average()
        if node.kind is ConditionKind.MA_TREND:
            value = None if price is None or average is None else price - average
            evaluation = market(
                value,
                "ma.period",
                lambda difference: difference > 0 if is_buy else difference <= 0,
            )
        else:
            value = (
                None
                if price is None or average is None or average == 0
                else (price - average) / average * Decimal("100")
            )
            threshold = _decimal_parameter(params, "ma.buyDeviationPct")
            evaluation = market(
                value,
                "ma.buyDeviationPct",
                lambda deviation: (
                    deviation <= threshold if is_buy else deviation >= threshold
                ),
            )
    else:
        period = _period_parameter(params, "bollinger.period")
        deviations = _decimal_parameter(params, "bollinger.stddev")
        if (period, deviations) not in band_cache:
            band_cache[(period, deviations)] = bollinger_bands(
                prices, period=period, deviations=deviations
            )
        band = band_cache[(period, deviations)][position]
        boundary = None if band is None else band.lower if is_buy else band.upper
        difference = None if price is None or boundary is None else price - boundary
        evaluation = market(
            difference,
            "bollinger.period",
            lambda value: value <= 0 if is_buy else value >= 0,
            signal_id if is_buy else f"{signal_id}.price",
        )
        if not is_buy:
            price_signal = evaluation
            source_symbol = str(params["vix.symbol"])
            vix_signal = decorate(
                _macro_threshold_evaluation(
                    index,
                    leaf_strategy,
                    context,
                    day,
                    signal_id=f"{signal_id}.vix",
                    parameter_key="exit.bollinger.vixCeiling",
                    symbol=source_symbol,
                    unit="index_points",
                    threshold=_decimal_parameter(params, "exit.bollinger.vixCeiling"),
                    compare=lt,
                ),
                "exit.bollinger.vixCeiling",
                source_symbol,
            )
            evaluations.extend((price_signal, vix_signal))
            evaluation = decorate(
                combine_conditions(
                    day, signal_id, ConditionLogic.AND, (price_signal, vix_signal)
                ),
                "exit.bollinger.vixCeiling",
            )

    if not is_buy and node.kind is not ConditionKind.VIX:
        ratio_key = (
            "exit.rsi.ratio"
            if node.kind is ConditionKind.RSI
            else "exit.bollinger.ratio"
            if node.kind is ConditionKind.BOLLINGER
            else "exit.ratio"
        )
        hit = evaluation.state is SignalState.TRUE
        evaluation = evaluation.model_copy(
            update={
                "sell_ratio": _decimal_parameter(params, ratio_key)
                if hit
                else Decimal("0"),
                "triggered_signal_ids": (signal_id,) if hit else (),
            }
        )
    elif is_buy:
        evaluation = evaluation.model_copy(
            update={
                "triggered_signal_ids": (signal_id,)
                if evaluation.state is SignalState.TRUE
                else ()
            }
        )
    evaluations.append(evaluation)
    return evaluation

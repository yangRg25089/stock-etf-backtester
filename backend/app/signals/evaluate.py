"""Evaluate enabled strategy dependencies into dated three-state signals."""

from collections.abc import Iterable
from datetime import date
from decimal import Decimal
from typing import Literal

from pydantic import Field

from app.catalog.presets import (
    ExecutionModule,
    get_preset_definition,
)
from app.domain.conditions import (
    ConditionGroup,
    ConditionLogic,
    ConditionNode,
)
from app.domain.contracts import (
    DataSnapshot,
    FrozenRunConfig,
    FrozenStrategyInstance,
    SignalEvaluation,
    TechnicalIndicatorSample,
    TechnicalIndicatorSeries,
)
from app.domain.status import (
    Diagnostic,
    DomainModel,
    SignalState,
    unique_diagnostics,
)

from .conditions import combine_conditions
from .context import EvaluationContext, LeafContext, make_context
from .indicators import (
    BollingerBands,
)
from .leaf_evaluation import evaluate_leaf
from .observations import _price_evaluation, _simulation_price

SIGNAL_METHOD_VERSION = "signals-v2"


class StrategySignalSeries(DomainModel):
    """One strategy's evaluations; unavailable dependencies are strict."""

    strategy_id: str = Field(alias="strategyId", min_length=1)
    evaluations: tuple[SignalEvaluation, ...] = ()
    technical_indicators: tuple[TechnicalIndicatorSeries, ...] = Field(
        default=(), alias="technicalIndicators"
    )

    @property
    def available(self) -> bool:
        return all(
            evaluation.state is not SignalState.UNAVAILABLE
            for evaluation in self.evaluations
        )

    @property
    def diagnostics(self) -> tuple[Diagnostic, ...]:
        return unique_diagnostics(
            diagnostic
            for evaluation in self.evaluations
            for diagnostic in evaluation.diagnostics
        )


class SignalBatch(DomainModel):
    """Signal series for every strategy in a frozen run config."""

    strategies: tuple[StrategySignalSeries, ...] = ()

    def strategy(self, strategy_id: str) -> StrategySignalSeries:
        for series in self.strategies:
            if series.strategy_id == strategy_id:
                return series
        raise KeyError(f"no strategy signal series: {strategy_id}")


def evaluate_signals(
    config: FrozenRunConfig,
    snapshot: DataSnapshot,
    *,
    sessions: Iterable[date],
) -> SignalBatch:
    """Evaluate each enabled strategy on run sessions using earlier bars to warm up.

    ``sessions`` is the exchange calendar interval including any prewarm dates.
    Requiring it explicitly means a missing market bar remains visible instead
    of silently disappearing from a signal series.
    """

    all_sessions = tuple(sessions)
    if all_sessions != tuple(sorted(set(all_sessions))):
        raise ValueError("sessions must be sorted and unique")
    run = config.shared.run
    run_sessions = tuple(
        day for day in all_sessions if run.start_date <= day <= run.end_date
    )
    context = make_context(config, snapshot, all_sessions, run_sessions)
    series = tuple(
        _evaluate_strategy(index, strategy, context)
        for index, strategy in enumerate(config.strategies)
    )
    return SignalBatch(strategies=series)


def _evaluate_strategy(
    index: int,
    strategy: FrozenStrategyInstance,
    context: EvaluationContext,
) -> StrategySignalSeries:
    preset = get_preset_definition(strategy.preset_id)
    rules = strategy.rules
    if rules is None and preset.execution_module is not ExecutionModule.SCHEDULED:
        raise ValueError(
            "condition rules must be materialized by configuration validation"
        )
    symbol = context.config.shared.run.symbol
    prices = tuple(_simulation_price(context, day, symbol) for day in context.sessions)
    positions = {day: position for position, day in enumerate(context.sessions)}
    moving_averages: dict[int, tuple[Decimal | None, ...]] = {}
    strength_indices: dict[int, tuple[Decimal | None, ...]] = {}
    band_cache: dict[tuple[int, Decimal], tuple[BollingerBands | None, ...]] = {}
    evaluations: list[SignalEvaluation] = []
    leaf_context = LeafContext(
        index=index,
        strategy=strategy,
        context=context,
        symbol=symbol,
        prices=prices,
        positions=positions,
        moving_averages=moving_averages,
        strength_indices=strength_indices,
        band_cache=band_cache,
        evaluations=evaluations,
    )

    def evaluate_node(
        node: ConditionNode | None, side: Literal["buy", "sell"], day: date, path: str
    ) -> SignalEvaluation | None:
        if node is None or not node.enabled:
            return None
        if isinstance(node, ConditionGroup):
            children = tuple(
                child
                for position, item in enumerate(node.children)
                if (
                    child := evaluate_node(
                        item, side, day, f"{path}.children[{position}]"
                    )
                )
                is not None
            )
            evaluation = combine_conditions(
                day, f"conditions.{side}:{node.id}", node.operator, children
            ).model_copy(update={"condition_id": node.id})
            evaluations.append(evaluation)
            return evaluation

        return evaluate_leaf(node, side, day, path, leaf_context)

    for day in context.run_sessions:
        evaluations.append(
            _price_evaluation(index, strategy, day, prices[positions[day]], symbol)
        )
        if rules is None:
            continue
        buy = evaluate_node(rules.buy, "buy", day, f"strategies[{index}].rules.buy")
        buy_id = (
            "ma.trend"
            if preset.execution_module is ExecutionModule.TREND
            else "accumulation.buy"
        )
        if buy is None or buy.signal_id != buy_id:
            evaluations.append(
                combine_conditions(
                    day, buy_id, ConditionLogic.AND, () if buy is None else (buy,)
                )
            )
        sell = evaluate_node(rules.sell, "sell", day, f"strategies[{index}].rules.sell")
        evaluations.append(
            combine_conditions(
                day,
                "conditions.sell",
                ConditionLogic.AND,
                () if sell is None else (sell,),
            )
        )
    indicator_caches: tuple[
        tuple[Literal["ma", "rsi"], dict[int, tuple[Decimal | None, ...]]], ...
    ] = (("ma", moving_averages), ("rsi", strength_indices))
    technical = [
        TechnicalIndicatorSeries(
            kind=kind,
            period=period,
            samples=tuple(
                TechnicalIndicatorSample(date=day, value=values[positions[day]])
                for day in context.run_sessions
            ),
        )
        for kind, cache in indicator_caches
        for period, values in sorted(cache.items())
    ]
    for (period, deviations), bands in sorted(band_cache.items()):
        technical.append(
            TechnicalIndicatorSeries(
                kind="bollinger",
                period=period,
                deviations=deviations,
                samples=tuple(
                    TechnicalIndicatorSample(
                        date=day,
                        value=None
                        if (band := bands[positions[day]]) is None
                        else band.middle,
                        lower=None if band is None else band.lower,
                        upper=None if band is None else band.upper,
                    )
                    for day in context.run_sessions
                ),
            )
        )
    return StrategySignalSeries(
        strategyId=strategy.id,
        evaluations=tuple(evaluations),
        technicalIndicators=tuple(technical),
    )

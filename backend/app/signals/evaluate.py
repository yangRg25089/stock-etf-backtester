"""Evaluate enabled strategy dependencies into dated three-state signals."""

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from operator import ge, le, lt
from typing import Literal

from pydantic import Field

from app.catalog.presets import (
    ExecutionModule,
    get_preset_definition,
)
from app.config.validation import DataKind
from app.domain.conditions import (
    ConditionGroup,
    ConditionKind,
    ConditionLogic,
    ConditionNode,
    condition_signal_id,
)
from app.domain.contracts import (
    DataSnapshot,
    FrozenRunConfig,
    FrozenStrategyInstance,
    MacroObservation,
    MarketBar,
    SignalEvaluation,
    ValuationObservation,
)
from app.domain.immutability import freeze_mapping
from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    DiagnosticSeverity,
    DomainModel,
    SignalState,
)

from .conditions import combine_conditions
from .indicators import (
    BollingerBands,
    bollinger_bands,
    relative_strength_index,
    simple_moving_average,
)

SIGNAL_METHOD_VERSION = "signals-v1"


class StrategySignalSeries(DomainModel):
    """One strategy's evaluations; unavailable dependencies are strict."""

    strategy_id: str = Field(alias="strategyId", min_length=1)
    evaluations: tuple[SignalEvaluation, ...] = ()

    @property
    def available(self) -> bool:
        return all(
            evaluation.state is not SignalState.UNAVAILABLE
            for evaluation in self.evaluations
        )

    @property
    def diagnostics(self) -> tuple[Diagnostic, ...]:
        diagnostics: list[Diagnostic] = []
        for evaluation in self.evaluations:
            for diagnostic in evaluation.diagnostics:
                if diagnostic not in diagnostics:
                    diagnostics.append(diagnostic)
        return tuple(diagnostics)


class SignalBatch(DomainModel):
    """Signal series for every strategy in a frozen run config."""

    strategies: tuple[StrategySignalSeries, ...] = ()

    def strategy(self, strategy_id: str) -> StrategySignalSeries:
        for series in self.strategies:
            if series.strategy_id == strategy_id:
                return series
        raise KeyError(f"no strategy signal series: {strategy_id}")


@dataclass(frozen=True, slots=True)
class _EvaluationContext:
    config: FrozenRunConfig
    snapshot: DataSnapshot
    sessions: tuple[date, ...]
    run_sessions: tuple[date, ...]
    bars: Mapping[date, MarketBar]
    macro: Mapping[tuple[str, date], tuple[MacroObservation, ...]]
    valuations: Mapping[date, tuple[ValuationObservation, ...]]


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
    context = _make_context(config, snapshot, all_sessions, run_sessions)
    series = tuple(
        _evaluate_strategy(index, strategy, context)
        for index, strategy in enumerate(config.strategies)
    )
    return SignalBatch(strategies=series)


def _make_context(
    config: FrozenRunConfig,
    snapshot: DataSnapshot,
    sessions: tuple[date, ...],
    run_sessions: tuple[date, ...],
) -> _EvaluationContext:
    bars: dict[date, MarketBar] = {}
    for bar in snapshot.market.bars:
        if bar.date in bars:
            raise ValueError(f"duplicate market bar for {bar.date}")
        bars[bar.date] = bar
    macro: dict[tuple[str, date], list[MacroObservation]] = {}
    for macro_observation in snapshot.macro:
        if macro_observation.aligned_session_date is not None:
            key = (
                macro_observation.symbol,
                macro_observation.aligned_session_date,
            )
            macro.setdefault(key, []).append(macro_observation)
    valuation_rows: dict[date, list[ValuationObservation]] = {}
    if snapshot.valuation is not None:
        for valuation_observation in snapshot.valuation.observations:
            valuation_rows.setdefault(valuation_observation.date, []).append(
                valuation_observation
            )
    return _EvaluationContext(
        config=config,
        snapshot=snapshot,
        sessions=sessions,
        run_sessions=run_sessions,
        bars=bars,
        macro={key: tuple(rows) for key, rows in macro.items()},
        valuations={key: tuple(rows) for key, rows in valuation_rows.items()},
    )


def _evaluate_strategy(
    index: int,
    strategy: FrozenStrategyInstance,
    context: _EvaluationContext,
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
            return decorate(
                evaluation.model_copy(update={"observed_value": value}), key
            )

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
                _append_vix_exit_signals(
                    index, leaf_strategy, context, day, params, tiers
                )
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
        elif node.kind is ConditionKind.PE:
            evaluation = decorate(
                _valuation_threshold_evaluation(
                    index,
                    leaf_strategy,
                    context,
                    day,
                    threshold=_decimal_parameter(params, "pe.threshold"),
                    signal_id=signal_id,
                    compare=le if is_buy else ge,
                ),
                "pe.threshold",
            )
        elif node.kind is ConditionKind.RSI:
            period = _period_parameter(params, "rsi.period")
            if period not in strength_indices:
                strength_indices[period] = relative_strength_index(
                    prices, period=period
                )
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
                        threshold=_decimal_parameter(
                            params, "exit.bollinger.vixCeiling"
                        ),
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
        evaluations.append(evaluation)
        return evaluation

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
    return StrategySignalSeries(strategyId=strategy.id, evaluations=tuple(evaluations))


def _append_vix_exit_signals(
    index: int,
    strategy: FrozenStrategyInstance,
    context: _EvaluationContext,
    day: date,
    params: Mapping[str, object],
    evaluations: list[SignalEvaluation],
) -> None:
    symbol = str(params["vix.symbol"])
    value, diagnostic = _macro_value(
        context,
        day,
        strategy_id=strategy.id,
        signal_id="vix.exit",
        field_path=_field_path(index, "exit.enabled"),
        symbol=symbol,
        expected_unit="index_points",
    )
    if diagnostic is not None or value is None:
        missing_diagnostic = diagnostic or _missing_data_diagnostic(
            day,
            strategy.id,
            "vix.exit",
            _field_path(index, "exit.enabled"),
            DataKind.MACRO,
            symbol,
        )
        evaluations.extend(
            _unavailable_evaluation(
                day,
                signal_id,
                missing_diagnostic,
            )
            for signal_id in ("vix.exit.low1", "vix.exit.low2")
        )
        return

    thresholds = {
        number: _decimal_parameter(params, f"exit.vix.low{number}") for number in (2, 1)
    }
    # Stable ordering keeps the previous second-tier priority when values tie.
    priority = sorted(thresholds, key=thresholds.__getitem__)
    winner = next((number for number in priority if value <= thresholds[number]), None)
    evaluations.extend(
        (
            _state_evaluation(
                day,
                "vix.exit.low1",
                winner == 1,
                observed_value=value,
                observed_unit="index_points",
            ),
            _state_evaluation(
                day,
                "vix.exit.low2",
                winner == 2,
                observed_value=value,
                observed_unit="index_points",
            ),
        )
    )


def _macro_threshold_evaluation(
    index: int,
    strategy: FrozenStrategyInstance,
    context: _EvaluationContext,
    day: date,
    *,
    signal_id: str,
    parameter_key: str,
    symbol: str,
    unit: str,
    threshold: Decimal,
    compare: Callable[[Decimal, Decimal], bool],
) -> SignalEvaluation:
    value, diagnostic = _macro_value(
        context,
        day,
        strategy_id=strategy.id,
        signal_id=signal_id,
        field_path=_field_path(index, parameter_key),
        symbol=symbol,
        expected_unit=unit,
    )
    if diagnostic is not None:
        return _unavailable_evaluation(day, signal_id, diagnostic)
    if value is None:
        return _unavailable_evaluation(
            day,
            signal_id,
            _missing_data_diagnostic(
                day,
                strategy.id,
                signal_id,
                _field_path(index, parameter_key),
                DataKind.MACRO,
                symbol,
            ),
        )
    return _state_evaluation(
        day,
        signal_id,
        compare(value, threshold),
        observed_value=value,
        observed_unit=unit,
    )


def _macro_value(
    context: _EvaluationContext,
    day: date,
    *,
    strategy_id: str,
    signal_id: str,
    field_path: str,
    symbol: str,
    expected_unit: str,
) -> tuple[Decimal | None, Diagnostic | None]:
    rows = context.macro.get((symbol, day), ())
    if len(rows) != 1 or _macro_available_date(rows[0]) >= day:
        return None, _missing_data_diagnostic(
            day,
            strategy_id,
            signal_id,
            field_path,
            DataKind.MACRO,
            symbol,
        )
    observation = rows[0]
    allowed_units = {expected_unit}
    if expected_unit in {"index_point", "index_points"}:
        allowed_units.update({"index_point", "index_points"})
    if observation.unit not in allowed_units:
        return None, Diagnostic(
            code=DiagnosticCode.UNKNOWN_SOURCE_UNIT,
            severity=DiagnosticSeverity.ERROR,
            messageKey="diagnostics.data.unknown_source_unit",
            fieldPath=field_path,
            asOf=day,
            source=observation.source,
            details={
                "expectedUnit": expected_unit,
                "signalId": signal_id,
                "sourceUnit": observation.source_unit or observation.unit,
                "strategyId": strategy_id,
                "symbol": symbol,
            },
        )
    if not observation.value.is_finite() or (
        expected_unit == "index_points" and observation.value < 0
    ):
        return None, Diagnostic(
            code=DiagnosticCode.CALCULATION_FAILED,
            severity=DiagnosticSeverity.ERROR,
            messageKey="diagnostics.signal.invalid_input",
            fieldPath=field_path,
            asOf=day,
            source=observation.source,
            details={"signalId": signal_id, "strategyId": strategy_id},
        )
    return observation.value, None


def _valuation_threshold_evaluation(
    index: int,
    strategy: FrozenStrategyInstance,
    context: _EvaluationContext,
    day: date,
    *,
    threshold: Decimal,
    signal_id: str = "pe.buy",
    compare: Callable[[Decimal, Decimal], bool] = le,
) -> SignalEvaluation:
    field_path = _field_path(index, "pe.buyEnabled")
    symbol = context.config.shared.run.symbol
    rows = context.valuations.get(day, ())
    if (
        len(rows) != 1
        or context.snapshot.valuation is None
        or context.snapshot.valuation.symbol != symbol
    ):
        return _unavailable_evaluation(
            day,
            signal_id,
            _missing_data_diagnostic(
                day,
                strategy.id,
                signal_id,
                field_path,
                DataKind.VALUATION,
                symbol,
            ),
        )
    observation = rows[0]
    minimum_coverage = _decimal_parameter(strategy.params, "pe.etfMinCoverage")
    if observation.method == "etf_equity_earnings_yield" and (
        observation.coverage is None or observation.coverage < minimum_coverage
    ):
        diagnostic = _missing_data_diagnostic(
            day, strategy.id, signal_id, field_path, DataKind.VALUATION, symbol
        )
        return _unavailable_evaluation(
            day,
            signal_id,
            diagnostic.model_copy(
                update={
                    "details": freeze_mapping(
                        {
                            **diagnostic.details,
                            "reason": "etf_coverage_below_minimum",
                            "coverage": None
                            if observation.coverage is None
                            else str(observation.coverage),
                            "minimumCoverage": str(minimum_coverage),
                        }
                    )
                }
            ),
        )
    if (
        observation.as_of > day
        or observation.pe is None
        or not observation.pe.is_finite()
        or observation.pe <= 0
    ):
        return _unavailable_evaluation(
            day,
            signal_id,
            _missing_data_diagnostic(
                day,
                strategy.id,
                signal_id,
                field_path,
                DataKind.VALUATION,
                symbol,
            ),
        )
    return _state_evaluation(
        day,
        signal_id,
        compare(observation.pe, threshold),
        observed_value=observation.pe,
    )


def _price_threshold_evaluation(
    index: int,
    strategy: FrozenStrategyInstance,
    day: date,
    signal_id: str,
    parameter_key: str,
    value: Decimal | None,
    compare: Callable[[Decimal], bool],
    symbol: str,
) -> SignalEvaluation:
    if value is None or not value.is_finite():
        return _unavailable_evaluation(
            day,
            signal_id,
            _missing_data_diagnostic(
                day,
                strategy.id,
                signal_id,
                _field_path(index, parameter_key),
                DataKind.MARKET,
                symbol,
            ),
        )
    return _state_evaluation(day, signal_id, compare(value))


def _price_evaluation(
    index: int,
    strategy: FrozenStrategyInstance,
    day: date,
    price: Decimal | None,
    symbol: str,
) -> SignalEvaluation:
    if price is None:
        return _unavailable_evaluation(
            day,
            "market.price",
            _missing_data_diagnostic(
                day,
                strategy.id,
                "market.price",
                _field_path(index, "run.symbol"),
                DataKind.MARKET,
                symbol,
            ),
        )
    return _state_evaluation(day, "market.price", True)


def _simulation_price(
    context: _EvaluationContext, day: date, symbol: str
) -> Decimal | None:
    if context.snapshot.market.symbol != symbol:
        return None
    bar = context.bars.get(day)
    if bar is None or not bar.simulation_price.is_finite():
        return None
    return bar.simulation_price if bar.simulation_price > 0 else None


def _state_evaluation(
    day: date,
    signal_id: str,
    triggered: bool,
    *,
    observed_value: Decimal | None = None,
    observed_unit: str | None = None,
) -> SignalEvaluation:
    return SignalEvaluation(
        date=day,
        signalId=signal_id,
        state=SignalState.TRUE if triggered else SignalState.FALSE,
        observedValue=observed_value,
        observedUnit=observed_unit,
    )


def _unavailable_evaluation(
    day: date, signal_id: str, diagnostic: Diagnostic
) -> SignalEvaluation:
    return SignalEvaluation(
        date=day,
        signalId=signal_id,
        state=SignalState.UNAVAILABLE,
        diagnostics=(diagnostic,),
    )


def _missing_data_diagnostic(
    day: date,
    strategy_id: str,
    signal_id: str,
    field_path: str,
    data_kind: DataKind,
    symbol: str,
) -> Diagnostic:
    return Diagnostic(
        code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
        severity=DiagnosticSeverity.ERROR,
        messageKey="diagnostics.data.required_unavailable",
        fieldPath=field_path,
        asOf=day,
        details={
            "dataKind": data_kind.value,
            "signalId": signal_id,
            "strategyId": strategy_id,
            "symbol": symbol,
        },
    )


def _macro_available_date(observation: MacroObservation) -> date:
    availability = observation.published_at or observation.observed_at
    return max(observation.date, availability.date())


def _period_parameter(params: Mapping[str, object], key: str) -> int:
    value = params.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{key} must be a positive integer")
    return value


def _decimal_parameter(params: Mapping[str, object], key: str) -> Decimal:
    value = params.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        raise ValueError(f"{key} must be numeric")
    number = Decimal(str(value))
    if not number.is_finite():
        raise ValueError(f"{key} must be finite")
    return number


def _field_path(index: int, key: str) -> str:
    return f"strategies[{index}].params.{key}"

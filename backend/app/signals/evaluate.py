"""Evaluate enabled strategy dependencies into dated three-state signals."""

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from pydantic import Field

from app.catalog.presets import (
    ExecutionModule,
    PresetDefinition,
    get_preset_definition,
)
from app.config.validation import DataKind
from app.domain.contracts import (
    DataSnapshot,
    FrozenRunConfig,
    FrozenStrategyInstance,
    MacroObservation,
    MarketBar,
    SignalEvaluation,
    ValuationObservation,
)
from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    DiagnosticSeverity,
    DomainModel,
    SignalState,
)

from .indicators import (
    BollingerBands,
    bollinger_bands,
    relative_strength_index,
    simple_moving_average,
)


class StrategySignalSeries(DomainModel):
    """One enabled strategy's evaluations; unavailable dependencies are strict."""

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
    """Signal series for every enabled strategy in a frozen run config."""

    strategies: tuple[StrategySignalSeries, ...] = ()

    def strategy(self, strategy_id: str) -> StrategySignalSeries:
        for series in self.strategies:
            if series.strategy_id == strategy_id:
                return series
        raise KeyError(f"no enabled strategy signal series: {strategy_id}")


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
        if strategy.enabled
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
    params = strategy.params
    symbol = context.config.shared.run.symbol
    prices = tuple(_simulation_price(context, day, symbol) for day in context.sessions)
    position_by_date = {day: index for index, day in enumerate(context.sessions)}
    trend_ma: tuple[Decimal | None, ...] = ()
    rsi_values: tuple[Decimal | None, ...] = ()
    ma_buy_values: tuple[Decimal | None, ...] = ()
    bands: tuple[BollingerBands | None, ...] = ()

    if preset.execution_module is ExecutionModule.TREND:
        trend_ma = simple_moving_average(
            prices, period=_period_parameter(params, "ma.period")
        )
    if _enabled(preset, params, "rsi.buyEnabled") or (
        _enabled(preset, params, "exit.enabled")
        and _enabled(preset, params, "exit.rsi.enabled")
    ):
        rsi_values = relative_strength_index(
            prices,
            period=_period_parameter(params, "rsi.period"),
        )
    if _enabled(preset, params, "ma.buyEnabled"):
        ma_buy_values = simple_moving_average(
            prices, period=_period_parameter(params, "ma.period")
        )
    if _enabled(preset, params, "bollinger.buyEnabled") or (
        _enabled(preset, params, "exit.enabled")
        and _enabled(preset, params, "exit.bollinger.enabled")
    ):
        bands = bollinger_bands(
            prices,
            period=_period_parameter(params, "bollinger.period"),
            deviations=_decimal_parameter(params, "bollinger.stddev"),
        )

    evaluations: list[SignalEvaluation] = []
    for day in context.run_sessions:
        position = position_by_date[day]
        price = prices[position]
        price_evaluation = _price_evaluation(index, strategy, day, price, symbol)
        evaluations.append(price_evaluation)
        buy_signals: list[SignalEvaluation] = []

        if _enabled(preset, params, "vix.buyEnabled"):
            signal = _macro_threshold_evaluation(
                index,
                strategy,
                context,
                day,
                signal_id="vix.buy",
                parameter_key="vix.buyEnabled",
                symbol=str(params["vix.symbol"]),
                unit="index_points",
                threshold=_decimal_parameter(params, "vix.buyThreshold"),
                compare=lambda value, threshold: value >= threshold,
            )
            evaluations.append(signal)
            buy_signals.append(signal)

        if _enabled(preset, params, "rsi.buyEnabled"):
            signal = _price_threshold_evaluation(
                index,
                strategy,
                day,
                "rsi.buy",
                "rsi.buyEnabled",
                rsi_values[position],
                lambda value: value <= _decimal_parameter(params, "rsi.buyThreshold"),
                symbol,
            )
            evaluations.append(signal)
            buy_signals.append(signal)

        if _enabled(preset, params, "ma.buyEnabled"):
            ma_value = ma_buy_values[position]
            deviation = (
                None
                if ma_value is None or price is None or ma_value == 0
                else (price - ma_value) / ma_value * Decimal("100")
            )
            signal = _price_threshold_evaluation(
                index,
                strategy,
                day,
                "ma.buy",
                "ma.buyEnabled",
                deviation,
                lambda value: value <= _decimal_parameter(params, "ma.buyDeviationPct"),
                symbol,
            )
            evaluations.append(signal)
            buy_signals.append(signal)

        if _enabled(preset, params, "bollinger.buyEnabled"):
            band = bands[position] if bands else None
            lower = None if band is None else band.lower
            signal = _price_threshold_evaluation(
                index,
                strategy,
                day,
                "bollinger.buy",
                "bollinger.buyEnabled",
                None if price is None or lower is None else price - lower,
                lambda difference: difference <= 0,
                symbol,
            )
            evaluations.append(signal)
            buy_signals.append(signal)

        if _enabled(preset, params, "rate.buyEnabled"):
            signal = _macro_threshold_evaluation(
                index,
                strategy,
                context,
                day,
                signal_id="rate.buy",
                parameter_key="rate.buyEnabled",
                symbol=str(params["rate.symbol"]),
                unit="percent_point",
                threshold=_decimal_parameter(params, "rate.thresholdPct"),
                compare=lambda value, threshold: value <= threshold,
            )
            evaluations.append(signal)
            buy_signals.append(signal)

        if _enabled(preset, params, "pe.buyEnabled"):
            signal = _valuation_threshold_evaluation(
                index,
                strategy,
                context,
                day,
                threshold=_decimal_parameter(params, "pe.threshold"),
            )
            evaluations.append(signal)
            buy_signals.append(signal)

        if preset.execution_module in {
            ExecutionModule.ACCUMULATION,
            ExecutionModule.SEARCH,
        }:
            aggregate = _combine_buy_signals(
                day,
                buy_signals,
                str(params.get("accumulation.conditionLogic", "OR")),
            )
            evaluations.append(aggregate)

        if preset.execution_module is ExecutionModule.TREND:
            ma_value = trend_ma[position]
            trend_signal = _price_threshold_evaluation(
                index,
                strategy,
                day,
                "ma.trend",
                "ma.period",
                None if price is None or ma_value is None else price - ma_value,
                lambda difference: difference > 0,
                symbol,
            )
            evaluations.append(trend_signal)
            if params.get("trend.sellBelowOrEqualMa") is True:
                sell_signal = _price_threshold_evaluation(
                    index,
                    strategy,
                    day,
                    "ma.trend.sell",
                    "ma.period",
                    None if price is None or ma_value is None else price - ma_value,
                    lambda difference: difference <= 0,
                    symbol,
                )
                evaluations.append(sell_signal)

        if _enabled(preset, params, "exit.enabled"):
            if "exit.vix.low1" in preset.parameter_keys:
                _append_vix_exit_signals(
                    index, strategy, context, day, params, evaluations
                )
            if _enabled(preset, params, "exit.rsi.enabled"):
                evaluations.append(
                    _price_threshold_evaluation(
                        index,
                        strategy,
                        day,
                        "rsi.exit",
                        "exit.rsi.enabled",
                        rsi_values[position],
                        lambda value: (
                            value >= _decimal_parameter(params, "exit.rsi.threshold")
                        ),
                        symbol,
                    )
                )
            if _enabled(preset, params, "exit.bollinger.enabled"):
                band = bands[position] if bands else None
                upper = None if band is None else band.upper
                evaluations.append(
                    _price_threshold_evaluation(
                        index,
                        strategy,
                        day,
                        "bollinger.exit",
                        "exit.bollinger.enabled",
                        None if price is None or upper is None else price - upper,
                        lambda difference: difference >= 0,
                        symbol,
                    )
                )
                evaluations.append(
                    _macro_threshold_evaluation(
                        index,
                        strategy,
                        context,
                        day,
                        signal_id="bollinger.exit.vix",
                        parameter_key="exit.bollinger.enabled",
                        symbol=str(params["vix.symbol"]),
                        unit="index_points",
                        threshold=_decimal_parameter(
                            params, "exit.bollinger.vixCeiling"
                        ),
                        compare=lambda value, threshold: value < threshold,
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

    low2_hit = value <= _decimal_parameter(params, "exit.vix.low2")
    low1_hit = not low2_hit and value <= _decimal_parameter(params, "exit.vix.low1")
    evaluations.extend(
        (
            _state_evaluation(day, "vix.exit.low1", low1_hit),
            _state_evaluation(day, "vix.exit.low2", low2_hit),
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
    return _state_evaluation(day, signal_id, compare(value, threshold))


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
) -> SignalEvaluation:
    signal_id = "pe.buy"
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
    return _state_evaluation(day, signal_id, observation.pe <= threshold)


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


def _combine_buy_signals(
    day: date,
    signals: list[SignalEvaluation],
    logic: str,
) -> SignalEvaluation:
    if not signals:
        return _state_evaluation(day, "accumulation.buy", False)
    unavailable = tuple(
        diagnostic
        for signal in signals
        if signal.state is SignalState.UNAVAILABLE
        for diagnostic in signal.diagnostics
    )
    if unavailable:
        return SignalEvaluation(
            date=day,
            signalId="accumulation.buy",
            state=SignalState.UNAVAILABLE,
            diagnostics=unavailable,
        )
    states = tuple(signal.state is SignalState.TRUE for signal in signals)
    triggered = all(states) if logic == "AND" else any(states)
    return _state_evaluation(day, "accumulation.buy", triggered)


def _state_evaluation(day: date, signal_id: str, triggered: bool) -> SignalEvaluation:
    return SignalEvaluation(
        date=day,
        signalId=signal_id,
        state=SignalState.TRUE if triggered else SignalState.FALSE,
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


def _enabled(preset: PresetDefinition, params: Mapping[str, object], key: str) -> bool:
    return key in preset.parameter_keys and params.get(key) is True


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

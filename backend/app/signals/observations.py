"""Point-in-time observations, threshold evaluation and missing-data diagnostics."""

from collections.abc import Callable, Mapping
from datetime import date
from decimal import Decimal

from app.config.validation import DataKind
from app.domain.contracts import (
    FrozenStrategyInstance,
    MacroObservation,
    SignalEvaluation,
)
from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    DiagnosticSeverity,
    SignalState,
)

from .context import EvaluationContext


def _append_vix_exit_signals(
    index: int,
    strategy: FrozenStrategyInstance,
    context: EvaluationContext,
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
    context: EvaluationContext,
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
    context: EvaluationContext,
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
    context: EvaluationContext, day: date, symbol: str
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

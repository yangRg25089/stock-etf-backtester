"""Strict three-state condition groups with maximum, never additive, exits."""

from datetime import date
from decimal import Decimal

from app.domain.conditions import ConditionLogic
from app.domain.contracts import SignalEvaluation
from app.domain.status import SignalState


def combine_conditions(
    day: date,
    signal_id: str,
    operator: ConditionLogic,
    children: tuple[SignalEvaluation, ...],
    *,
    include_all_triggers: bool = False,
) -> SignalEvaluation:
    if any(child.state is SignalState.UNAVAILABLE for child in children):
        return SignalEvaluation(
            date=day,
            signalId=signal_id,
            state=SignalState.UNAVAILABLE,
            diagnostics=tuple(
                diagnostic for child in children for diagnostic in child.diagnostics
            ),
        )
    hits = tuple(child for child in children if child.state is SignalState.TRUE)
    triggered = bool(children) and (
        len(hits) == len(children) if operator is ConditionLogic.AND else bool(hits)
    )
    winner = (
        max(hits, key=lambda child: child.sell_ratio or Decimal("0"), default=None)
        if triggered
        else None
    )
    triggered_signal_ids = (
        tuple(
            sorted(
                {
                    signal_id
                    for child in hits
                    for signal_id in child.triggered_signal_ids
                }
            )
        )
        if include_all_triggers and triggered
        else winner.triggered_signal_ids
        if winner is not None
        else ()
    )
    return SignalEvaluation(
        date=day,
        signalId=signal_id,
        state=SignalState.TRUE if triggered else SignalState.FALSE,
        sellRatio=winner.sell_ratio
        if winner is not None and winner.sell_ratio is not None
        else Decimal("0"),
        triggeredSignalIds=triggered_signal_ids,
    )

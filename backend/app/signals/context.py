"""Read-only snapshot context and per-strategy indicator caches; no supplier I/O."""

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from app.domain.contracts import (
    DataSnapshot,
    FrozenRunConfig,
    FrozenStrategyInstance,
    MacroObservation,
    MarketBar,
    SignalEvaluation,
    ValuationObservation,
)

from .indicators import (
    BollingerBands,
)


@dataclass(frozen=True, slots=True)
class EvaluationContext:
    config: FrozenRunConfig
    snapshot: DataSnapshot
    sessions: tuple[date, ...]
    run_sessions: tuple[date, ...]
    bars: Mapping[date, MarketBar]
    macro: Mapping[tuple[str, date], tuple[MacroObservation, ...]]
    valuations: Mapping[date, tuple[ValuationObservation, ...]]


def make_context(
    config: FrozenRunConfig,
    snapshot: DataSnapshot,
    sessions: tuple[date, ...],
    run_sessions: tuple[date, ...],
) -> EvaluationContext:
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
    return EvaluationContext(
        config=config,
        snapshot=snapshot,
        sessions=sessions,
        run_sessions=run_sessions,
        bars=bars,
        macro={key: tuple(rows) for key, rows in macro.items()},
        valuations={key: tuple(rows) for key, rows in valuation_rows.items()},
    )


@dataclass(frozen=True, slots=True)
class LeafContext:
    index: int
    strategy: FrozenStrategyInstance
    context: EvaluationContext
    symbol: str
    prices: tuple[Decimal | None, ...]
    positions: Mapping[date, int]
    moving_averages: dict[int, tuple[Decimal | None, ...]]
    strength_indices: dict[int, tuple[Decimal | None, ...]]
    band_cache: dict[tuple[int, Decimal], tuple[BollingerBands | None, ...]]
    evaluations: list[SignalEvaluation]

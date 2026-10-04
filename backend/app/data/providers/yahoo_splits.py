"""Normalize corporate actions only when their price history is complete."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal, DecimalException

from .yahoo_frames import _as_datetime, _HistoryFrame, _resolve_column, _row_value


@dataclass(frozen=True)
class StockSplitEvidence:
    events: tuple[tuple[date, Decimal], ...]
    prices: tuple[tuple[date, Decimal], ...]

    def is_unsplit_since(self, period_start: date) -> bool:
        return not any(day >= period_start for day, _ratio in self.events)


def normalize_split_history(
    frame: _HistoryFrame,
    *,
    sessions: tuple[date, ...],
    symbol: str,
) -> StockSplitEvidence:
    price_column = _resolve_column(frame, "Close", symbol)
    split_column = _resolve_column(frame, "Stock Splits", symbol)
    if not sessions or price_column is None or split_column is None:
        raise ValueError("corporate action history requires prices and splits")
    expected = set(sessions)
    prices: dict[date, Decimal] = {}
    events: dict[date, Decimal] = {}
    for index, row in frame.iterrows():
        observed = _as_datetime(index)
        if observed is None:
            raise ValueError("invalid corporate action timestamp")
        day = observed.date()
        if day not in expected:
            continue
        if day in prices:
            raise ValueError("duplicate corporate action session")
        try:
            price = Decimal(str(_row_value(row, price_column)))
            split = Decimal(str(_row_value(row, split_column)))
        except (DecimalException, ValueError):
            raise ValueError("invalid corporate action value") from None
        if not price.is_finite() or price <= 0 or not split.is_finite() or split < 0:
            raise ValueError("invalid corporate action value")
        prices[day] = price
        if split > 0:
            events[day] = split
    if set(prices) != expected:
        raise ValueError("corporate action history has missing sessions")
    return StockSplitEvidence(
        tuple(sorted(events.items())), tuple(sorted(prices.items()))
    )

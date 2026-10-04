"""Ordered calendar windows; no market data or parameter selection."""

from calendar import monthrange
from datetime import date, timedelta

from app.domain.contracts import SearchPeriod


def _anniversary(start: date, years: int) -> date:
    year = start.year + years
    return start.replace(
        year=year, day=min(start.day, monthrange(year, start.month)[1])
    )


def walk_forward_periods(
    start: date, end: date
) -> tuple[tuple[SearchPeriod, SearchPeriod], ...]:
    windows = []
    offset = 0
    while start.year + offset + 5 <= end.year:
        test_start = _anniversary(start, offset + 5)
        if test_start > end:
            break
        test_end = (
            end
            if start.year + offset + 6 > date.max.year
            else min(end, _anniversary(start, offset + 6) - timedelta(days=1))
        )
        windows.append(
            (
                SearchPeriod(
                    phase="train",
                    startDate=_anniversary(start, offset),
                    endDate=test_start - timedelta(days=1),
                ),
                SearchPeriod(phase="test", startDate=test_start, endDate=test_end),
            )
        )
        offset += 1
    return tuple(windows)

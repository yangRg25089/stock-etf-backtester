"""Saved-period NAV/price returns and episodes from the existing drawdown series."""

from decimal import Decimal, localcontext
from itertools import groupby, pairwise

from app.domain.contracts import DailyAsset
from app.domain.performance import (
    DrawdownEpisode,
    PeriodReturn,
    PeriodUnavailableReason,
)


def _check_dates(rows: tuple[DailyAsset, ...]) -> None:
    if any(left.date >= right.date for left, right in pairwise(rows)):
        raise ValueError("observations must be strictly increasing")


def calculate_period_returns(
    rows: tuple[DailyAsset, ...], *, monthly: bool
) -> tuple[PeriodReturn, ...]:
    _check_dates(rows)
    previous_nav: Decimal | None = Decimal(1)
    previous_price = rows[0].simulation_price if rows else Decimal(1)
    results = []
    with localcontext() as context:
        context.prec = 40
        for (year, month), group in groupby(
            rows, key=lambda row: (row.date.year, row.date.month if monthly else None)
        ):
            period = tuple(group)
            reason: PeriodUnavailableReason | None = None
            if not any(
                row.total_contributed and row.total_contributed > 0 for row in period
            ):
                reason = "no_funding"
            elif previous_nav is None or any(row.unit_nav is None for row in period):
                reason = "missing_nav"
            elif previous_nav <= 0:
                reason = "undefined_nav"
            terminal_nav = period[-1].unit_nav
            value = None
            if reason is None:
                assert previous_nav is not None and terminal_nav is not None
                value = terminal_nav / previous_nav - 1
            results.append(
                PeriodReturn(
                    year=year,
                    month=month,
                    startDate=period[0].date,
                    endDate=period[-1].date,
                    navReturn=value,
                    priceReturn=period[-1].simulation_price / previous_price - 1,
                    unavailableReason=reason,
                )
            )
            previous_nav = terminal_nav
            previous_price = period[-1].simulation_price
    return tuple(results)


def calculate_drawdown_episodes(
    rows: tuple[DailyAsset, ...],
) -> tuple[DrawdownEpisode, ...] | None:
    _check_dates(rows)
    funded = tuple(
        row
        for row in rows
        if row.total_contributed is not None and row.total_contributed > 0
    )
    if any(row.drawdown is None for row in funded):
        return None
    if not funded:
        return ()
    peak = bottom = funded[0].date
    depth = Decimal(0)
    episodes = []

    def record(end: DailyAsset, recovered: bool) -> None:
        episodes.append(
            DrawdownEpisode(
                peakDate=peak,
                bottomDate=bottom,
                recoveredDate=end.date if recovered else None,
                endDate=end.date,
                drawdown=depth,
                durationDays=(end.date - peak).days,
                recoveryDays=(end.date - bottom).days if recovered else None,
                state="recovered" if recovered else "ongoing",
            )
        )

    for row in funded:
        assert row.drawdown is not None
        if row.drawdown < 0:
            if row.drawdown < depth:
                depth, bottom = row.drawdown, row.date
        else:
            if depth < 0:
                record(row, True)
            peak, bottom, depth = row.date, row.date, Decimal(0)
    if depth < 0:
        record(funded[-1], False)
    return tuple(sorted(episodes, key=lambda item: (item.drawdown, item.peak_date)))

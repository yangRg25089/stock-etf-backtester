"""Pure NAV analysis; inputs already own their cash-flow adjustment and drawdown."""

from decimal import Decimal, localcontext

from app.domain.contracts import DailyAsset, Trade, TradeSide
from app.domain.performance import PerformanceAnalysis

from .periods import calculate_drawdown_episodes, calculate_period_returns

_RISK_FIELDS = ("annualizedVolatility", "sharpeRatio", "sortinoRatio")


def calculate_analysis(
    daily_assets: tuple[DailyAsset, ...],
    trades: tuple[Trade, ...],
    risk_free_annual_rate: Decimal,
) -> PerformanceAnalysis:
    """ACT/365 NAV growth; sample daily risk annualized at 252 sessions.

    The initial issue NAV is one, so initial execution costs are included.
    Missing/undefined returns invalidate risk rather than being silently skipped.
    """
    if not risk_free_annual_rate.is_finite() or risk_free_annual_rate <= -1:
        raise ValueError("risk-free annual rate must be finite and greater than -1")
    rows = tuple(
        row
        for row in daily_assets
        if row.total_contributed is not None and row.total_contributed > 0
    )
    reasons: dict[str, str] = {}
    with localcontext() as context:
        context.prec = 40
        days = (rows[-1].date - rows[0].date).days if rows else 0
        growth = None
        if any(row.unit_nav is None for row in rows):
            reasons["annualizedReturn"] = "missing_nav"
        elif not rows or days <= 0:
            reasons["annualizedReturn"] = "insufficient_history"
        else:
            terminal = rows[-1].unit_nav
            assert terminal is not None
            growth = (
                (terminal.ln() * Decimal(365) / days).exp() - 1
                if terminal > 0
                else Decimal(-1)
            )

        returns: list[Decimal] = []
        previous_nav = Decimal(1)
        risk_reason = "insufficient_history" if len(rows) < 2 else None
        for row in rows:
            if row.unit_nav is None:
                risk_reason = "missing_nav"
                break
            if previous_nav <= 0:
                risk_reason = "undefined_nav"
                break
            returns.append(row.unit_nav / previous_nav - 1)
            previous_nav = row.unit_nav
        volatility = sharpe = sortino = None
        if risk_reason:
            reasons.update(dict.fromkeys(_RISK_FIELDS, risk_reason))
        else:
            daily_rf = ((Decimal(1) + risk_free_annual_rate).ln() / 252).exp() - 1
            excess = tuple(value - daily_rf for value in returns)
            mean = sum(excess, Decimal(0)) / len(excess)
            deviation = (
                sum(((value - mean) ** 2 for value in excess), Decimal(0))
                / (len(excess) - 1)
            ).sqrt()
            volatility = deviation * Decimal(252).sqrt()
            if deviation > 0:
                sharpe = mean / deviation * Decimal(252).sqrt()
            else:
                reasons["sharpeRatio"] = "zero_variance"
            downside = (
                sum((min(value, Decimal(0)) ** 2 for value in excess), Decimal(0))
                / len(excess)
            ).sqrt()
            if downside > 0:
                sortino = mean / downside * Decimal(252).sqrt()
            else:
                reasons["sortinoRatio"] = "no_downside"

        episodes = calculate_drawdown_episodes(rows)
        if episodes is None:
            reasons["drawdownEpisodes"] = "missing_nav"
        worst = episodes[0] if episodes else None
        durations = (
            (
                max((episode.duration_days for episode in episodes), default=0),
                worst.recovery_days if worst else 0,
                -worst.drawdown if worst else Decimal(0),
            )
            if rows and episodes is not None
            else None
        )
        calmar = None
        if durations is None:
            reasons.update(
                dict.fromkeys(
                    ("maximumDrawdownDuration", "recoveryDuration", "calmarRatio"),
                    "missing_nav" if rows else "insufficient_history",
                )
            )
        elif durations[2] <= 0:
            reasons["calmarRatio"] = "no_drawdown"
        elif growth is None:
            reasons["calmarRatio"] = reasons["annualizedReturn"]
        else:
            calmar = growth / durations[2]
        if durations and durations[1] is None:
            reasons["recoveryDuration"] = "not_recovered"
        average_equity = (
            sum((row.total_asset for row in rows), Decimal(0)) / len(rows)
            if rows
            else Decimal(0)
        )
        turnover = (
            sum(
                (
                    trade.gross_amount
                    if trade.gross_amount is not None
                    else trade.cash_amount
                    for trade in trades
                ),
                Decimal(0),
            )
            / average_equity
            if average_equity > 0
            else None
        )
        ratios = tuple(
            row.cash / row.total_asset for row in rows if row.total_asset > 0
        )
        cash_ratio = sum(ratios, Decimal(0)) / len(ratios) if ratios else None
        if turnover is None:
            reasons["turnover"] = "no_equity"
        if cash_ratio is None:
            reasons["averageCashRatio"] = "no_equity"
        return PerformanceAnalysis(
            analysisMethod="unit-nav-v1",
            tradingDaysPerYear=252,
            durationUnit="calendar_days",
            riskFreeAnnualRate=risk_free_annual_rate,
            annualizedReturn=growth,
            annualizedVolatility=volatility,
            sharpeRatio=sharpe,
            sortinoRatio=sortino,
            calmarRatio=calmar,
            maximumDrawdownDuration=durations[0] if durations else None,
            recoveryDuration=durations[1] if durations else None,
            buyCount=sum(trade.side is TradeSide.BUY for trade in trades),
            sellCount=sum(trade.side is TradeSide.SELL for trade in trades),
            turnover=turnover,
            averageCashRatio=cash_ratio,
            unavailableReasons=reasons,
            annualReturns=calculate_period_returns(daily_assets, monthly=False),
            monthlyReturns=calculate_period_returns(daily_assets, monthly=True),
            drawdownEpisodes=episodes,
        )

"""Unified financial metrics for ordinary strategies, benchmarks, and search."""

from collections import defaultdict
from collections.abc import Iterable
from datetime import date
from decimal import Decimal, DecimalException, localcontext

from app.catalog.presets import ExecutionModule, get_preset_definition
from app.domain.contracts import DailyAsset, MetricSummary, TradeSide
from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    DiagnosticSeverity,
)

from .types import MetricsInput, MetricsResult

_DAY_COUNT = Decimal("365")
METRIC_METHOD_VERSION = "metrics-v4"


def calculate_xirr(
    cash_flows: Iterable[tuple[date, Decimal]],
) -> tuple[Decimal | None, str | None]:
    """Solve XIRR with ACT/365 timing; return a reason when no unique root exists.

    Cash flows on a common date are combined before checking uniqueness. One
    sign change and a non-zero time span are required, which is the domain of a
    conventional investment stream with a unique economically meaningful root.
    """

    aggregated: dict[date, Decimal] = defaultdict(lambda: Decimal("0"))
    for flow_date, amount in cash_flows:
        if not amount.is_finite():
            return None, "non_finite_cash_flow"
        aggregated[flow_date] += amount
    flows = tuple(
        (flow_date, amount)
        for flow_date, amount in sorted(aggregated.items())
        if amount != 0
    )
    if len(flows) < 2:
        return None, "insufficient_time_span"
    if flows[0][0] == flows[-1][0]:
        return None, "insufficient_time_span"
    signs = tuple(amount > 0 for _, amount in flows)
    sign_changes = sum(
        left != right for left, right in zip(signs, signs[1:], strict=False)
    )
    if sign_changes == 0:
        return None, "cash_flows_do_not_change_sign"
    if sign_changes > 1:
        return None, "multiple_sign_changes"

    start_date = flows[0][0]
    with localcontext() as context:
        context.prec = 60

        def net_present_value(rate: Decimal) -> Decimal:
            base = Decimal("1") + rate
            log_base = base.ln()
            return sum(
                (
                    amount
                    * (
                        -(Decimal((flow_date - start_date).days) / _DAY_COUNT)
                        * log_base
                    ).exp()
                    for flow_date, amount in flows
                ),
                Decimal("0"),
            )

        lower = Decimal("-1") + Decimal("1e-50")
        upper = Decimal("1")
        try:
            lower_value = net_present_value(lower)
            upper_value = net_present_value(upper)
            for _ in range(512):
                if lower_value == 0:
                    return lower, None
                if upper_value == 0:
                    return upper, None
                if (lower_value > 0) != (upper_value > 0):
                    break
                upper = upper * 2 + 1
                upper_value = net_present_value(upper)
            else:
                return None, "no_root_in_domain"

            lower_sign_is_positive = lower_value > 0
            for _ in range(512):
                midpoint = (lower + upper) / 2
                if midpoint == lower or midpoint == upper:
                    break
                midpoint_value = net_present_value(midpoint)
                if midpoint_value == 0:
                    return midpoint, None
                if (midpoint_value > 0) == lower_sign_is_positive:
                    lower = midpoint
                else:
                    upper = midpoint
            return (lower + upper) / 2, None
        except (DecimalException, ValueError, OverflowError):
            return None, "xirr_calculation_failed"


def calculate_metrics(source: MetricsInput) -> MetricsResult:
    _validate_metrics_input(source)
    total_contributed = source.schedule.total_amount
    actual_invested = sum(
        (
            trade.cash_amount
            for trade in source.ledger.trades
            if trade.side is TradeSide.BUY
        ),
        Decimal("0"),
    )
    ending_equity = source.ledger.daily_assets[-1].total_asset
    if total_contributed <= 0:
        raise ValueError("metrics require a positive contribution budget")

    cash_flows = _external_cash_flows(source)
    cash_flows_with_terminal_value = (
        *((flow_date, -amount) for flow_date, amount in cash_flows),
        (source.ledger.daily_assets[-1].date, ending_equity),
    )
    xirr_value, xirr_reason = calculate_xirr(cash_flows_with_terminal_value)
    diagnostics: tuple[Diagnostic, ...] = ()
    if xirr_value is None:
        diagnostics = (
            Diagnostic(
                code=DiagnosticCode.NO_VALID_XIRR,
                severity=DiagnosticSeverity.WARNING,
                messageKey="metrics.xirr_unavailable",
                fieldPath="metrics.xirr",
                asOf=source.ledger.daily_assets[-1].date,
                details={"reason": xirr_reason or "unknown"},
            ),
        )

    daily_assets, maximum_drawdown = _with_unit_nav(
        source.ledger.daily_assets,
        {flow_date: -amount for flow_date, amount in cash_flows},
    )
    summary = MetricSummary(
        totalContributed=total_contributed,
        actualInvested=actual_invested,
        endingEquity=ending_equity,
        netProfit=ending_equity - total_contributed,
        returnOnContributions=ending_equity / total_contributed - Decimal("1"),
        capitalMultiple=ending_equity / total_contributed,
        xirr=xirr_value,
        maximumDrawdown=maximum_drawdown,
        currency=source.ledger.daily_assets[-1].currency,
        diagnostics=diagnostics,
    )
    return MetricsResult(summary=summary, daily_assets=daily_assets)


def _validate_metrics_input(source: MetricsInput) -> None:
    if not source.ledger.available:
        raise ValueError("unavailable ledgers cannot produce performance metrics")
    if source.ledger.strategy_id != source.strategy.id:
        raise ValueError("ledger result belongs to a different strategy")
    if not source.data_fingerprint.strip():
        raise ValueError("metrics require a data snapshot fingerprint")
    if not source.ledger.daily_assets:
        raise ValueError("metrics require a complete daily asset series")
    if (
        tuple(asset.date for asset in source.ledger.daily_assets)
        != source.schedule.trading_dates
    ):
        raise ValueError("ledger dates must match the contribution schedule")
    currencies = {asset.currency for asset in source.ledger.daily_assets}
    if len(currencies) != 1:
        raise ValueError("daily assets must use one reporting currency")
    if source.ledger.daily_assets[-1].total_asset < 0:
        raise ValueError("ending equity must not be negative")


def _external_cash_flows(source: MetricsInput) -> tuple[tuple[date, Decimal], ...]:
    preset = get_preset_definition(source.strategy.preset_id)
    funding_mode = source.strategy.params.get("scheduled.fundingMode")
    if (
        preset.execution_module is ExecutionModule.SCHEDULED
        and funding_mode == "upfront"
    ):
        upfront_date = source.schedule.upfront_date
        amount = source.schedule.upfront_amount
        if upfront_date is None or amount <= 0:
            raise ValueError("upfront investment requires a valid plan amount and date")
        return ((upfront_date, amount),)
    return tuple(
        (contribution.date, contribution.amount)
        for contribution in source.schedule.contributions
    )


def _with_unit_nav(
    daily_assets: tuple[DailyAsset, ...],
    cash_flows: dict[date, Decimal],
) -> tuple[tuple[DailyAsset, ...], Decimal]:
    units = Decimal("0")
    previous_nav = Decimal("1")
    peak_nav = Decimal("1")
    maximum_drawdown = Decimal("0")
    total_contributed = Decimal("0")
    result: list[DailyAsset] = []

    for asset in daily_assets:
        contribution = -cash_flows.get(asset.date, Decimal("0"))
        if contribution < 0:
            raise ValueError("external contributions must be non-negative")
        total_contributed += contribution
        if units == 0:
            if contribution > 0:
                units = contribution
                nav = asset.total_asset / units
            elif asset.total_asset == 0:
                nav = Decimal("1")
            else:
                raise ValueError("non-zero assets require a contribution history")
        else:
            value_before_contribution = asset.total_asset - contribution
            if value_before_contribution < 0:
                raise ValueError("assets cannot be lower than same-day contributions")
            if contribution > 0:
                existing_nav = value_before_contribution / units
                if existing_nav > 0:
                    units += contribution / existing_nav
                    nav = existing_nav
                else:
                    issue_price = previous_nav if previous_nav > 0 else Decimal("1")
                    units += contribution / issue_price
                    nav = asset.total_asset / units
            else:
                nav = asset.total_asset / units

        peak_nav = max(peak_nav, nav)
        drawdown = nav / peak_nav - Decimal("1") if peak_nav > 0 else Decimal("0")
        maximum_drawdown = max(maximum_drawdown, -drawdown)
        result.append(
            asset.model_copy(
                update={
                    "unit_nav": nav,
                    "drawdown": drawdown,
                    "total_contributed": total_contributed,
                }
            )
        )
        previous_nav = nav

    return tuple(result), maximum_drawdown

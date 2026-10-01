from datetime import date
from decimal import Decimal

from app.calendar import ScheduledContribution, ScheduleResult
from app.config.validation import validate_draft
from app.domain.contracts import DailyAsset, Trade, TradeReason, TradeSide
from app.domain.status import DiagnosticCode
from app.ledger import LedgerResult
from app.metrics.engine import (
    METRIC_METHOD_VERSION,
    MetricsInput,
    calculate_metrics,
    calculate_xirr,
)


def _strategy(
    preset: str,
    start: date,
    end: date,
    *,
    amount: str = "100",
    params: dict[str, object] | None = None,
    strategy_id: str = "strategy-1",
):
    result = validate_draft(
        {
            "shared": {
                "run": {
                    "symbol": "QQQ",
                    "startDate": start,
                    "endDate": end,
                    "endMode": "fixed",
                },
                "contribution": {"day": 1, "amount": Decimal(amount)},
            },
            "strategies": [
                {
                    "id": strategy_id,
                    "presetId": preset,
                    "enabled": True,
                    "params": {} if params is None else params,
                }
            ],
        }
    )
    assert result.diagnostics_for() == ()
    config = result.config_for((strategy_id,))
    assert config is not None
    return config.strategies[0]


def _input(
    strategy,
    dates: tuple[date, ...],
    contributions: tuple[tuple[date, str], ...],
    equities: tuple[str, ...],
    *,
    data_fingerprint: str = "fixture-data-v1",
) -> MetricsInput:
    amount = sum((Decimal(value) for _, value in contributions), Decimal("0"))
    schedule = ScheduleResult(
        requestedStartDate=dates[0],
        requestedEndDate=dates[-1],
        effectiveStartDate=dates[0],
        effectiveEndDate=dates[-1],
        tradingDates=dates,
        contributions=tuple(
            ScheduledContribution(date=day, scheduledDate=day, amount=Decimal(value))
            for day, value in contributions
        ),
        totalAmount=amount,
        upfrontAmount=amount,
        upfrontDate=dates[0] if amount > 0 else None,
    )
    ledger = LedgerResult(
        strategyId=strategy.id,
        dailyAssets=tuple(
            DailyAsset(
                date=day,
                cash=Decimal(equity),
                timingQuantity=Decimal("0"),
                fixedQuantity=Decimal("0"),
                simulationPrice=Decimal("10"),
                totalAsset=Decimal(equity),
                currency="USD",
            )
            for day, equity in zip(dates, equities, strict=True)
        ),
    )
    return MetricsInput(
        strategy=strategy,
        schedule=schedule,
        ledger=ledger,
        data_fingerprint=data_fingerprint,
    )


def test_return_on_contributions_is_distinct_from_capital_multiple() -> None:
    dates = (date(2021, 1, 1), date(2022, 1, 1))
    source = _input(
        _strategy("monthly_dca", *dates),
        dates,
        ((dates[0], "100"),),
        ("100", "110"),
    )

    result = calculate_metrics(source)

    assert result.summary.total_contributed == Decimal("100")
    assert result.summary.ending_equity == Decimal("110")
    assert result.summary.net_profit == Decimal("10")
    assert result.summary.return_on_contributions == Decimal("0.1")
    assert result.summary.capital_multiple == Decimal("1.1")
    assert result.summary.xirr is not None
    assert abs(result.summary.xirr - Decimal("0.1")) < Decimal("1e-55")
    assert result.summary.maximum_drawdown == 0


def test_metrics_method_version_is_stable() -> None:
    assert METRIC_METHOD_VERSION == "metrics-v4"


def test_xirr_uses_each_contribution_date_with_actual_365_day_count() -> None:
    cash_flows = (
        (date(2021, 1, 1), Decimal("-100")),
        (date(2022, 1, 1), Decimal("-100")),
        (date(2023, 1, 1), Decimal("231")),
    )

    value, reason = calculate_xirr(cash_flows)

    assert reason is None
    assert value is not None
    assert abs(value - Decimal("0.1")) < Decimal("1e-30")

    dates = (date(2021, 1, 1), date(2022, 1, 1), date(2023, 1, 1))
    monthly_source = _input(
        _strategy("monthly_dca", dates[0], dates[-1]),
        dates,
        ((dates[0], "100"), (dates[1], "100")),
        ("100", "200", "231"),
    )
    result = calculate_metrics(monthly_source)
    assert result.summary.xirr is not None
    assert abs(result.summary.xirr - Decimal("0.1")) < Decimal("1e-55")


def test_upfront_investment_uses_one_first_day_cash_flow_for_xirr() -> None:
    dates = (date(2021, 1, 1), date(2021, 2, 1), date(2022, 1, 1))
    strategy = _strategy("lump_sum", dates[0], dates[-1], amount="200")
    source = _input(
        strategy,
        dates,
        ((dates[0], "100"), (dates[1], "100")),
        ("200", "200", "220"),
    )

    result = calculate_metrics(source)

    assert result.summary.xirr is not None
    assert abs(result.summary.xirr - Decimal("0.1")) < Decimal("1e-55")


def test_unit_nav_drawdown_excludes_external_contributions() -> None:
    dates = (
        date(2021, 1, 1),
        date(2021, 1, 2),
        date(2021, 1, 3),
        date(2021, 1, 4),
    )
    source = _input(
        _strategy("monthly_dca", dates[0], dates[-1]),
        dates,
        ((dates[0], "100"), (dates[2], "100")),
        ("100", "80", "180", "162"),
    )

    result = calculate_metrics(source)

    assert [asset.unit_nav for asset in result.daily_assets] == [
        Decimal("1"),
        Decimal("0.8"),
        Decimal("0.8"),
        Decimal("0.72"),
    ]
    assert [asset.drawdown for asset in result.daily_assets] == [
        Decimal("0"),
        Decimal("-0.2"),
        Decimal("-0.2"),
        Decimal("-0.28"),
    ]
    assert result.summary.maximum_drawdown == Decimal("0.28")


def test_zero_trade_success_still_gets_complete_metrics() -> None:
    dates = (date(2021, 1, 1), date(2022, 1, 1))
    source = _input(
        _strategy("monthly_dca", *dates),
        dates,
        ((dates[0], "100"),),
        ("100", "100"),
    )

    result = calculate_metrics(source)

    assert source.ledger.trades == ()
    assert result.summary.xirr is not None
    assert abs(result.summary.xirr) < Decimal("1e-55")
    assert result.summary.return_on_contributions == 0
    assert result.summary.actual_invested == 0
    assert result.summary.maximum_drawdown == 0
    assert result.summary.diagnostics == ()


def test_actual_invested_counts_buy_turnover_separately_from_contributions() -> None:
    dates = (date(2021, 1, 1), date(2021, 1, 2), date(2021, 1, 3))
    source = _input(
        _strategy("monthly_dca", dates[0], dates[-1]),
        dates,
        ((dates[0], "100"), (dates[2], "100")),
        ("100", "95", "160"),
    )
    source = MetricsInput(
        strategy=source.strategy,
        schedule=source.schedule,
        ledger=source.ledger.model_copy(
            update={
                "trades": (
                    Trade(
                        date=dates[0],
                        side=TradeSide.BUY,
                        reason=TradeReason.FIXED_DCA,
                        quantity=Decimal("5"),
                        price=Decimal("10"),
                        cashAmount=Decimal("50"),
                        currency="USD",
                    ),
                    Trade(
                        date=dates[1],
                        side=TradeSide.BUY,
                        reason=TradeReason.SIGNAL_BUY,
                        quantity=Decimal("5"),
                        price=Decimal("11"),
                        cashAmount=Decimal("55"),
                        currency="USD",
                    ),
                    Trade(
                        date=dates[2],
                        side=TradeSide.SELL,
                        reason=TradeReason.SIGNAL_SELL,
                        quantity=Decimal("1"),
                        price=Decimal("12"),
                        cashAmount=Decimal("12"),
                        currency="USD",
                    ),
                )
            }
        ),
        data_fingerprint=source.data_fingerprint,
    )

    result = calculate_metrics(source)

    assert result.summary.total_contributed == Decimal("200")
    assert result.summary.actual_invested == Decimal("105")


def test_no_valid_xirr_is_reported_without_hiding_other_metrics() -> None:
    dates = (date(2021, 1, 1), date(2022, 1, 1))
    source = _input(
        _strategy("monthly_dca", *dates),
        dates,
        ((dates[0], "100"),),
        ("100", "0"),
    )

    result = calculate_metrics(source)

    assert result.summary.xirr is None
    assert result.summary.net_profit == Decimal("-100")
    assert result.summary.capital_multiple == 0
    assert result.summary.maximum_drawdown == 1
    assert [diagnostic.code for diagnostic in result.summary.diagnostics] == [
        DiagnosticCode.NO_VALID_XIRR
    ]


def test_xirr_rejects_multiple_sign_changes_and_zero_time_span() -> None:
    multiple_roots, multiple_reason = calculate_xirr(
        (
            (date(2021, 1, 1), Decimal("-100")),
            (date(2022, 1, 1), Decimal("230")),
            (date(2023, 1, 1), Decimal("-132")),
        )
    )
    same_day, same_day_reason = calculate_xirr(
        (
            (date(2021, 1, 1), Decimal("-100")),
            (date(2021, 1, 1), Decimal("110")),
        )
    )

    assert multiple_roots is None
    assert multiple_reason == "multiple_sign_changes"
    assert same_day is None
    assert same_day_reason == "insufficient_time_span"


def test_removed_dca_difference_is_not_calculated_or_serialized() -> None:
    dates = (date(2021, 1, 1), date(2022, 1, 1))
    source = _input(
        _strategy("vix_dca", *dates), dates, ((dates[0], "100"),), ("100", "110")
    )
    result = calculate_metrics(source)
    assert result.summary.net_profit == Decimal("10")
    assert "relativeToDca" not in result.summary.model_dump(by_alias=True)
    assert "relative_to_dca" not in type(result.summary).model_fields


def test_legacy_dca_difference_is_discarded_when_reading_saved_metrics() -> None:
    from app.domain.contracts import MetricSummary

    summary = MetricSummary.model_validate(
        {
            "totalContributed": "100",
            "endingEquity": "110",
            "netProfit": "10",
            "relativeToDca": "10",
        }
    )
    assert summary.ending_equity == Decimal("110")
    assert "relativeToDca" not in summary.model_dump(by_alias=True)


def test_daily_contributed_amount_uses_real_external_cash_flow_timing() -> None:
    dates = (date(2024, 1, 31), date(2024, 2, 1), date(2024, 3, 1))
    schedule = ((dates[1], "100"), (dates[2], "100"))
    monthly = calculate_metrics(
        _input(
            _strategy("monthly_dca", dates[0], dates[-1]),
            dates,
            schedule,
            ("0", "100", "210"),
        )
    )
    assert [asset.total_contributed for asset in monthly.daily_assets] == [
        Decimal("0"),
        Decimal("100"),
        Decimal("200"),
    ]
    upfront = calculate_metrics(
        _input(
            _strategy("lump_sum", dates[0], dates[-1]),
            dates,
            schedule,
            ("200", "210", "220"),
        )
    )
    assert [asset.total_contributed for asset in upfront.daily_assets] == [
        Decimal("200")
    ] * 3
    assert (
        monthly.daily_assets[-1].total_contributed == monthly.summary.total_contributed
    )
    assert (
        upfront.daily_assets[-1].total_contributed == upfront.summary.total_contributed
    )
    assert (
        upfront.daily_assets[-1].total_asset
        / upfront.daily_assets[-1].total_contributed
        == upfront.summary.capital_multiple
    )

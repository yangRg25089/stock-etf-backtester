from datetime import date
from decimal import Decimal

import pytest

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
    assert METRIC_METHOD_VERSION == "metrics-v7"


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
    assert result.summary.xirr == 0
    assert result.summary.return_on_contributions == 0
    assert result.summary.actual_invested == 0
    assert result.summary.maximum_drawdown == 0
    assert result.summary.diagnostics == ()


def test_partial_first_buys_count_only_spent_original_contributions() -> None:
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
                        price=Decimal("9"),
                        cashAmount=Decimal("45"),
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
    assert result.summary.actual_invested == Decimal("95")


@pytest.mark.parametrize("proceeds", ["60", "100", "140"])
def test_recycled_cash_never_counts_as_new_invested_principal(proceeds: str) -> None:
    dates = (date(2021, 1, 1), date(2021, 1, 2), date(2021, 1, 3))
    source = _input(
        _strategy("composite_dca", dates[0], dates[-1]),
        dates,
        ((dates[0], "100"),),
        ("100", proceeds, proceeds),
    )
    trades = tuple(
        Trade(
            date=day,
            side=side,
            reason=reason,
            quantity=Decimal("1"),
            price=Decimal(amount),
            cashAmount=Decimal(amount),
            currency="USD",
        )
        for day, side, reason, amount in (
            (dates[0], TradeSide.BUY, TradeReason.SIGNAL_BUY, "100"),
            (dates[1], TradeSide.SELL, TradeReason.SIGNAL_SELL, proceeds),
            (dates[2], TradeSide.BUY, TradeReason.SIGNAL_BUY, proceeds),
        )
    )
    source = MetricsInput(
        strategy=source.strategy,
        schedule=source.schedule,
        ledger=source.ledger.model_copy(update={"trades": trades}),
        data_fingerprint=source.data_fingerprint,
    )
    result = calculate_metrics(source)
    assert result.summary.actual_invested == Decimal("100")
    assert result.summary.investment_basis == "original_principal"
    assert [asset.actual_invested for asset in result.daily_assets] == [
        Decimal("100")
    ] * 3
    assert result.summary.net_profit == Decimal(proceeds) - 100
    assert result.summary.return_on_contributions == Decimal(proceeds) / 100 - 1


def test_recycled_cash_is_used_before_unspent_new_contributions() -> None:
    dates = (date(2021, 1, 1), date(2021, 1, 2), date(2021, 2, 1), date(2021, 2, 2))
    source = _input(
        _strategy("composite_dca", dates[0], dates[-1]),
        dates,
        ((dates[0], "100"), (dates[2], "100")),
        ("100", "150", "250", "250"),
    )
    trades = tuple(
        Trade(
            date=day,
            side=side,
            reason=reason,
            quantity=Decimal("1"),
            price=Decimal(amount),
            cashAmount=Decimal(amount),
            currency="USD",
        )
        for day, side, reason, amount in (
            (dates[0], TradeSide.BUY, TradeReason.SIGNAL_BUY, "100"),
            (dates[1], TradeSide.SELL, TradeReason.SIGNAL_SELL, "150"),
            (dates[2], TradeSide.BUY, TradeReason.SIGNAL_BUY, "120"),
            (dates[3], TradeSide.BUY, TradeReason.SIGNAL_BUY, "50"),
        )
    )
    source = MetricsInput(
        strategy=source.strategy,
        schedule=source.schedule,
        ledger=source.ledger.model_copy(update={"trades": trades}),
        data_fingerprint=source.data_fingerprint,
    )
    result = calculate_metrics(source)
    assert [asset.actual_invested for asset in result.daily_assets] == [
        Decimal("100"),
        Decimal("100"),
        Decimal("100"),
        Decimal("120"),
    ]
    assert result.summary.actual_invested == 120
    assert result.summary.total_contributed == 200


@pytest.mark.parametrize("amount", ["105", "100.0000000000000000000000001"])
def test_inconsistent_buy_funding_is_rejected_instead_of_clipped(amount: str) -> None:
    dates = (date(2021, 1, 1), date(2021, 1, 2))
    source = _input(
        _strategy("composite_dca", *dates), dates, ((dates[0], "100"),), ("100", "100")
    )
    trade = Trade(
        date=dates[0],
        side=TradeSide.BUY,
        reason=TradeReason.SIGNAL_BUY,
        quantity=Decimal("1"),
        price=Decimal(amount),
        cashAmount=Decimal(amount),
        currency="USD",
    )
    source = MetricsInput(
        strategy=source.strategy,
        schedule=source.schedule,
        ledger=source.ledger.model_copy(update={"trades": (trade,)}),
        data_fingerprint=source.data_fingerprint,
    )
    with pytest.raises(ValueError, match="exceeds available"):
        calculate_metrics(source)


@pytest.mark.parametrize(
    "recycled", ["90.54736460204700667003236192", "941.7037062410063841948012856"]
)
def test_full_reinvestment_preserves_original_principal_at_decimal_precision(
    recycled: str,
) -> None:
    dates = (date(2020, 1, 2), date(2020, 3, 2), date(2020, 6, 15))
    proceeds = Decimal(recycled)
    original = Decimal("200")
    available = original + proceeds
    source = _input(
        _strategy("composite_dca", dates[0], dates[-1]),
        dates,
        ((dates[0], "200"), (dates[2], "200")),
        ("200", recycled, str(available)),
    )
    trades = tuple(
        Trade(
            date=day,
            side=side,
            reason=reason,
            quantity=Decimal("1"),
            price=amount,
            cashAmount=amount,
            currency="USD",
        )
        for day, side, reason, amount in (
            (dates[0], TradeSide.BUY, TradeReason.SIGNAL_BUY, original),
            (dates[1], TradeSide.SELL, TradeReason.SIGNAL_SELL, proceeds),
            (dates[2], TradeSide.BUY, TradeReason.SIGNAL_BUY, available),
        )
    )
    source = MetricsInput(
        strategy=source.strategy,
        schedule=source.schedule,
        ledger=source.ledger.model_copy(update={"trades": trades}),
        data_fingerprint=source.data_fingerprint,
    )
    result = calculate_metrics(source)
    assert (
        result.summary.actual_invested
        == result.summary.total_contributed
        == Decimal("400")
    )
    assert result.daily_assets[-1].actual_invested == Decimal("400")


def test_interleaved_deposit_and_sale_follow_the_ledger_addition_order() -> None:
    dates = (date(2020, 1, 2), date(2020, 1, 3), date(2020, 2, 3))
    first_sale = Decimal("725998.4020618556701030927835")
    second_sale = Decimal("2851057.709677419354838709677")
    deposit = Decimal("1000000")
    available = (first_sale + deposit) + second_sale
    assert available > deposit + (first_sale + second_sale)
    source = _input(
        _strategy("composite_dca", dates[0], dates[-1], amount="1000000"),
        dates,
        ((dates[0], str(deposit)), (dates[2], str(deposit))),
        (str(deposit), str(first_sale * 2), str(available)),
    )
    trades = tuple(
        Trade(
            date=day,
            side=side,
            reason=reason,
            quantity=Decimal("2") if day == dates[0] else Decimal("1"),
            price=amount / 2 if day == dates[0] else amount,
            cashAmount=amount,
            currency="USD",
        )
        for day, side, reason, amount in (
            (dates[0], TradeSide.BUY, TradeReason.SIGNAL_BUY, deposit),
            (dates[1], TradeSide.SELL, TradeReason.SIGNAL_SELL, first_sale),
            (dates[2], TradeSide.SELL, TradeReason.SIGNAL_SELL, second_sale),
            (dates[2], TradeSide.BUY, TradeReason.SIGNAL_BUY, available),
        )
    )
    daily_assets = tuple(
        row.model_copy(
            update={
                "cash": cash,
                "timing_quantity": quantity,
                "simulation_price": price,
            }
        )
        for row, cash, quantity, price in zip(
            source.ledger.daily_assets,
            (Decimal(0), first_sale, Decimal(0)),
            (Decimal(2), Decimal(1), Decimal(1)),
            (deposit / 2, first_sale, available),
            strict=True,
        )
    )
    result = calculate_metrics(
        MetricsInput(
            strategy=source.strategy,
            schedule=source.schedule,
            ledger=source.ledger.model_copy(
                update={"trades": trades, "daily_assets": daily_assets}
            ),
            data_fingerprint=source.data_fingerprint,
        )
    )
    assert [row.actual_invested for row in result.daily_assets] == [
        deposit,
        deposit,
        deposit * 2,
    ]
    assert result.summary.actual_invested == result.summary.total_contributed


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

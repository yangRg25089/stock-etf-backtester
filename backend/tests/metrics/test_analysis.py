from datetime import date, timedelta
from decimal import Decimal, localcontext

import pytest

from app.domain.contracts import DailyAsset, Trade
from app.metrics.analysis import calculate_analysis


def assets(navs, *, start=date(2024, 1, 1), contributions=None, cash_ratio="0"):
    peak = Decimal("1")
    rows = []
    for index, value in enumerate(navs):
        nav = None if value is None else Decimal(value)
        if nav is not None:
            peak = max(peak, nav)
        contributed = Decimal(contributions[index] if contributions else "100")
        equity = contributed * (nav if nav is not None else Decimal("1"))
        rows.append(
            DailyAsset(
                date=start + timedelta(days=index),
                cash=equity * Decimal(cash_ratio),
                timingQuantity=0,
                fixedQuantity=0,
                simulationPrice=10,
                totalAsset=equity,
                totalContributed=contributed,
                currency="USD",
                unitNav=nav,
                drawdown=None if nav is None else nav / peak - 1,
            )
        )
    return tuple(rows)


def test_analysis_matches_independent_excess_return_formulas_and_injection_scale():
    rows = assets(("1", "1.02", "0.9996", "1.029588"))
    with localcontext() as context:
        context.prec = 40
        risk_free = Decimal("0.05")
        daily_rf = (Decimal("1.05").ln() / 252).exp() - 1
        returns = tuple(Decimal(value) for value in ("0", "0.02", "-0.02", "0.03"))
        excess = tuple(value - daily_rf for value in returns)
        mean = sum(excess) / len(excess)
        deviation = (sum((value - mean) ** 2 for value in excess) / 3).sqrt()
        downside = (sum(min(value, Decimal("0")) ** 2 for value in excess) / 4).sqrt()
        result = calculate_analysis(rows, (), risk_free)
        assert abs(
            result.sharpe_ratio - mean / deviation * Decimal(252).sqrt()
        ) < Decimal("1e-35")
        assert abs(
            result.sortino_ratio - mean / downside * Decimal(252).sqrt()
        ) < Decimal("1e-35")
        assert abs(
            result.annualized_volatility - deviation * Decimal(252).sqrt()
        ) < Decimal("1e-35")
        expected = (Decimal("1.029588").ln() * Decimal(365) / 3).exp() - 1
        assert abs(result.annualized_return - expected) < Decimal("1e-35")
        assert abs(result.calmar_ratio - expected / Decimal("0.02")) < Decimal("1e-30")
    changed = assets(
        ("1", "1.02", "0.9996", "1.029588"), contributions=("100", "100", "500", "1000")
    )
    scaled = calculate_analysis(changed, (), risk_free)
    assert scaled.annualized_return == result.annualized_return
    assert scaled.sharpe_ratio == result.sharpe_ratio
    assert scaled.sortino_ratio == result.sortino_ratio
    assert result.risk_free_annual_rate == risk_free
    assert result.trading_days_per_year == 252


def test_cash_only_flat_series_has_explicit_zero_denominator_reasons():
    result = calculate_analysis(assets(("1", "1", "1"), cash_ratio="1"), (), Decimal(0))
    assert result.annualized_return == 0
    assert result.annualized_volatility == 0
    assert result.sharpe_ratio is None
    assert result.sortino_ratio is None
    assert result.calmar_ratio is None
    assert result.unavailable_reasons["sharpeRatio"] == "zero_variance"
    assert result.unavailable_reasons["sortinoRatio"] == "no_downside"
    assert result.unavailable_reasons["calmarRatio"] == "no_drawdown"
    assert result.average_cash_ratio == 1
    assert result.turnover == 0
    assert result.buy_count == result.sell_count == 0
    assert result.maximum_drawdown_duration == result.recovery_duration == 0


def test_duration_includes_open_episode_and_recovery_belongs_to_deepest_episode():
    rows = assets(("1", "0.6", "0.9", "1", "0.95", "0.99", "0.97", "0.99", "0.99"))
    result = calculate_analysis(rows, (), Decimal(0))
    assert result.maximum_drawdown_duration == 5
    assert result.recovery_duration == 2
    open_result = calculate_analysis(assets(("1", "0.6", "0.9")), (), Decimal(0))
    assert open_result.maximum_drawdown_duration == 2
    assert open_result.recovery_duration is None
    assert open_result.unavailable_reasons["recoveryDuration"] == "not_recovered"


def test_trade_counts_and_gross_turnover_use_turnover_not_first_spent_principal():
    rows = assets(("1", "1", "1"), cash_ratio="0.5")
    trades = tuple(
        Trade(
            date=rows[index].date,
            side=side,
            reason=reason,
            quantity=5,
            price=10,
            cashAmount=50,
            currency="USD",
        )
        for index, (side, reason) in enumerate(
            (("buy", "signal_buy"), ("sell", "signal_sell"), ("buy", "signal_buy"))
        )
    )
    result = calculate_analysis(rows, trades, Decimal(0))
    assert result.buy_count == 2
    assert result.sell_count == 1
    assert result.turnover == Decimal("1.5")
    assert result.average_cash_ratio == Decimal("0.5")


def test_unfunded_days_do_not_dilute_risk_or_count_as_cash_exposure():
    rows = assets(("1", "1", "1", "1.1"), contributions=("0", "0", "100", "100"))
    result = calculate_analysis(rows, (), Decimal(0))
    funded = calculate_analysis(rows[2:], (), Decimal(0))
    assert result.model_dump(
        exclude={"annual_returns", "monthly_returns"}
    ) == funded.model_dump(exclude={"annual_returns", "monthly_returns"})
    # Calendar-period coverage keeps the actual run dates, including unfunded days.
    assert result.annual_returns[0].start_date == rows[0].date
    assert funded.annual_returns[0].start_date == rows[2].date


@pytest.mark.parametrize(
    "navs,reason",
    [
        (("1",), "insufficient_history"),
        (("1", None, "1.1"), "missing_nav"),
        (("1", "0", "1"), "undefined_nav"),
    ],
)
def test_risk_boundaries_keep_unavailable_values_explicit(navs, reason):
    result = calculate_analysis(assets(navs), (), Decimal(0))
    assert result.annualized_volatility is None
    assert result.sharpe_ratio is None
    assert result.sortino_ratio is None
    assert result.unavailable_reasons["annualizedVolatility"] == reason


def test_total_loss_keeps_negative_one_growth_and_missing_cash_denominator():
    result = calculate_analysis(assets(("1", "0")), (), Decimal(0))
    assert result.annualized_return == -1
    assert result.sharpe_ratio is not None
    assert result.calmar_ratio == -1
    bankrupt = calculate_analysis(assets(("0", "0")), (), Decimal(0))
    assert bankrupt.turnover is None
    assert bankrupt.average_cash_ratio is None
    assert bankrupt.unavailable_reasons["turnover"] == "no_equity"


def test_initial_execution_loss_is_included_and_risk_free_has_no_cash_yield():
    result = calculate_analysis(
        assets(("0.99", "0.99", "0.99"), cash_ratio="1"), (), Decimal("0.1")
    )
    assert result.annualized_return < 0
    assert result.annualized_volatility > 0
    assert result.average_cash_ratio == 1
    assert result.risk_free_annual_rate == Decimal("0.1")


@pytest.mark.parametrize("rate", [Decimal("-1"), Decimal("NaN"), Decimal("Infinity")])
def test_invalid_risk_free_inputs_are_rejected(rate):
    with pytest.raises(ValueError, match="risk-free"):
        calculate_analysis(assets(("1", "1")), (), rate)


def test_analysis_setting_has_one_registry_default_and_freezes_into_config():
    from app.catalog.service import get_catalog
    from app.config.validation import validate_draft

    catalog = get_catalog()
    definition = catalog.parameter("analysis.riskFreeAnnualRatePct")
    assert definition.default == Decimal(0)
    assert definition.searchable is False
    draft = {
        "shared": {
            "run": {
                "symbol": "QQQ",
                "startDate": "2024-01-01",
                "endDate": "2024-03-01",
            },
            "contribution": {"amount": 100, "day": 1},
            "analysis": {"riskFreeAnnualRatePct": "5"},
        },
        "strategies": [{"id": "vix", "presetId": "vix_dca", "params": {}}],
    }
    result = validate_draft(draft)
    assert result.diagnostics_for() == ()
    config = result.config_for(("vix",))
    assert config.shared.analysis.risk_free_annual_rate_pct == Decimal(5)
    draft["shared"]["analysis"]["riskFreeAnnualRatePct"] = "9"
    assert config.shared.analysis.risk_free_annual_rate_pct == Decimal(5)
    draft["shared"]["analysis"] = {"riskFreeAnnualRatePct": "-100"}
    invalid = validate_draft(draft)
    assert invalid.diagnostics[0].field_path == "analysis.riskFreeAnnualRatePct"

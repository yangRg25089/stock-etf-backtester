"""Every catalog preset: real suppliers, independent signals/ledger/metrics/CSV.

The oracle below uses only saved inputs and normalized supplier observations.
It never calls the production signal, ledger, calendar or metric algorithms.
"""

import asyncio
import copy
import csv
import io
import json
from calendar import monthrange
from collections import defaultdict
from datetime import date
from decimal import ROUND_FLOOR, Decimal, localcontext

import httpx
import pytest
from fastapi.encoders import jsonable_encoder

from app.catalog.conditions import default_condition
from app.catalog.presets import PRESET_DEFINITIONS
from app.domain.conditions import ConditionKind
from app.domain.contracts import StrategyPresetId
from app.domain.immutability import thaw_value
from app.main import app
from app.runs.manager import RunManager
from app.runs.store import InMemoryRunStore
from app.runs.yahoo_data import YahooRunDataProvider
from tests.runs.test_yahoo_data_live import _InlineExecutor

D = Decimal
TOLERANCE = D("1e-20")


class _ObservedYahoo(YahooRunDataProvider):
    def __init__(self):
        super().__init__()
        self.observed = {}

    def load_for_run(self, **kwargs):
        loaded = super().load_for_run(**kwargs)
        self.observed.update(loaded)
        return loaded


@pytest.fixture(scope="module")
def supplier():
    return _ObservedYahoo()


def _funding(shared, calendar):
    """Resolve nominal monthly dates independently on real exchange sessions."""
    start = date.fromisoformat(shared["run"]["startDate"])
    end = date.fromisoformat(shared["run"]["endDate"])
    amount = D(str(shared["contribution"]["amount"]))
    by_month = defaultdict(list)
    for day in calendar.trading_dates:
        by_month[day.year, day.month].append(day)
    funding = {}
    for (year, month), sessions in by_month.items():
        nominal = date(
            year, month, min(shared["contribution"]["day"], monthrange(year, month)[1])
        )
        if not start <= nominal <= end:
            continue
        resolved = next((day for day in sessions if day >= nominal), sessions[-1])
        if start <= resolved <= end:
            funding[resolved.isoformat()] = amount
    return funding


class _SignalOracle:
    def __init__(self, snapshot):
        self.bars = snapshot.market.bars
        self.positions = {bar.date.isoformat(): i for i, bar in enumerate(self.bars)}
        self.macro = {
            (row.symbol, row.aligned_session_date.isoformat()): row
            for row in snapshot.macro
        }
        self.values = {}
        self.valuation = (
            {row.date.isoformat(): row for row in snapshot.valuation.observations}
            if snapshot.valuation is not None
            else {}
        )

    def leaf(self, node, side, day):
        params, kind = node["params"], node["kind"]
        buy = side == "buy"
        i = self.positions[day]
        price = self.bars[i].simulation_price
        ratio = D(0)
        if kind in {"vix", "rate"}:
            symbol = params[f"{kind}.symbol"]
            source = self.macro[symbol, day]
            assert (
                source.date.isoformat() < day
            )  # date-only data are next-session available
            assert source.source == "yahoo"
            assert source.unit == ("index_points" if kind == "vix" else "percent_point")
            value = source.value
            if kind == "vix":
                if buy:
                    triggered = value >= D(params["vix.buyThreshold"])
                else:
                    tiers = sorted(
                        (
                            D(params[f"exit.vix.low{n}"]),
                            -n,
                            D(params[f"exit.vix.ratio{n}"]),
                        )
                        for n in (1, 2)
                    )
                    ratio = next(
                        (r for threshold, _, r in tiers if value < threshold), D(0)
                    )
                    triggered = any(value < threshold for threshold, _, _ in tiers)
            else:
                assert source.source_unit == "percent_point"
                threshold = D(params["rate.thresholdPct"])
                triggered = value <= threshold if buy else value >= threshold
        elif kind == "pe":
            observation = self.valuation[day]
            assert observation.source == "sec:companyfacts"
            assert observation.eps > 0 and observation.valuation_price > 0
            assert all(
                fact.filed.isoformat() <= day
                and fact.stock_class_id
                and fact.split_basis
                for fact in observation.fact_references
            )
            eps = sum((fact.value for fact in observation.fact_references), D(0))
            assert abs(observation.eps - eps) < TOLERANCE
            value = observation.valuation_price / eps
            assert abs(value - observation.pe) < TOLERANCE
            threshold = D(params["pe.threshold"])
            triggered = value <= threshold if buy else value >= threshold
        elif kind == "rsi":
            period = int(params["rsi.period"])
            changes = [
                self.bars[n].simulation_price - self.bars[n - 1].simulation_price
                for n in range(i - period + 1, i + 1)
            ]
            gain = sum((max(D(0), change) for change in changes), D(0))
            loss = sum((max(D(0), -change) for change in changes), D(0))
            assert gain + loss > 0
            value = 100 * gain / (gain + loss)
            threshold = D(params["rsi.buyThreshold" if buy else "exit.rsi.threshold"])
            triggered = value <= threshold if buy else value >= threshold
        else:
            period_key = "bollinger.period" if kind == "bollinger" else "ma.period"
            period = int(params[period_key])
            window = [bar.simulation_price for bar in self.bars[i - period + 1 : i + 1]]
            assert len(window) == period
            mean = sum(window) / period
            if kind == "ma_trend":
                value = price - mean
                triggered = value > 0 if buy else value <= 0
            elif kind == "ma_deviation":
                value = (price / mean - 1) * 100
                threshold = D(params["ma.buyDeviationPct"])
                triggered = value <= threshold if buy else value >= threshold
            else:
                assert kind == "bollinger"
                sd = (sum((p - mean) ** 2 for p in window) / (period - 1)).sqrt()
                edge = mean + (-1 if buy else 1) * D(params["bollinger.stddev"]) * sd
                value = price - edge
                triggered = value <= 0 if buy else value >= 0
                if not buy:
                    triggered = triggered and self.macro[
                        params["vix.symbol"], day
                    ].value < D(params["exit.bollinger.vixCeiling"])
        if not buy and kind != "vix" and triggered:
            ratio = D(params.get(f"exit.{kind}.ratio", params.get("exit.ratio", "1")))
        self.values[day, side, node["id"]] = value, triggered
        return triggered, ratio

    def evaluate(self, node, side, day):
        if node is None or not node.get("enabled", True):
            return None
        if node["type"] == "condition":
            return self.leaf(node, side, day)
        active = [
            value
            for child in node["children"]
            if (value := self.evaluate(child, side, day)) is not None
        ]
        truth = bool(active) and (
            all(v[0] for v in active)
            if node["operator"] == "AND"
            else any(v[0] for v in active)
        )
        return truth, max((v[1] for v in active if v[0]), default=D(0)) if truth else D(
            0
        )


def _verify_technical_series(result, oracle):
    """Independent rolling-window values, dates and saved band parameters."""
    for series in result.get("technicalIndicators", []):
        assert [row["date"] for row in series["samples"]] == [
            row["date"] for row in result["dailyAssets"]
        ]
        period = series["period"]
        for sample in series["samples"]:
            index = oracle.positions[sample["date"]]
            values = [
                bar.simulation_price
                for bar in oracle.bars[max(0, index - period + 1) : index + 1]
            ]
            if len(values) < period or (series["kind"] == "rsi" and index < period):
                assert sample["value"] is None
                continue
            if series["kind"] == "rsi":
                changes = [
                    oracle.bars[n].simulation_price
                    - oracle.bars[n - 1].simulation_price
                    for n in range(index - period + 1, index + 1)
                ]
                gain = sum((max(D(0), value) for value in changes), D(0))
                loss = sum((max(D(0), -value) for value in changes), D(0))
                if gain + loss == 0:
                    assert sample["value"] is None
                    continue
                expected = 100 * gain / (gain + loss)
            else:
                expected = sum(values, D(0)) / period
                if series["kind"] == "bollinger":
                    spread = (
                        D(series["deviations"])
                        * (
                            sum(((value - expected) ** 2 for value in values), D(0))
                            / (period - 1)
                        ).sqrt()
                    )
                    assert abs(D(sample["lower"]) - (expected - spread)) < TOLERANCE
                    assert abs(D(sample["upper"]) - (expected + spread)) < TOLERANCE
                else:
                    assert series["kind"] == "ma"
            assert abs(D(sample["value"]) - expected) < TOLERANCE


def _verify_result(shared, config, result, observed, *, rules_by_date=None):
    assert result["status"] == "completed", result["diagnostics"]
    assert result["metrics"]["investmentBasis"] == "original_principal"
    funding = _funding(shared, observed.calendar)
    total = sum(funding.values(), D(0))
    assert total > 0
    assets = result["dailyAssets"]
    assert len(assets) > 100
    if config["presetId"] == "lump_sum":
        funding = {assets[0]["date"]: total}
    scheduled = config["presetId"] in {"monthly_dca", "lump_sum"}
    is_trend = config["presetId"] in {"ma_trend", "ma_buy_only"}
    oracle = _SignalOracle(observed.snapshot)
    _verify_technical_series(result, oracle)
    truth = {}
    for asset in assets:
        day = asset["date"]
        rules = (rules_by_date or {}).get(day, config.get("rules") or {})
        buy = oracle.evaluate(rules.get("buy"), "buy", day)
        sell = oracle.evaluate(rules.get("sell"), "sell", day)
        truth[day] = (
            False if buy is None else buy[0],
            D(0) if sell is None or not sell[0] else sell[1],
        )
    for signal in result["signals"]:
        kind = signal.get("conditionKind")
        if kind and signal.get("observedValue") is not None:
            side = (
                "sell"
                if ".exit" in signal["signalId"] or ".sell" in signal["signalId"]
                else "buy"
            )
            expected, _ = oracle.values[signal["date"], side, signal["conditionId"]]
            # Bollinger's extra VIX dependency has its own index observation.
            if signal.get("observedUnit") == "index_points" and kind == "bollinger":
                expected = oracle.macro[signal["sourceSymbol"], signal["date"]].value
            assert abs(D(signal["observedValue"]) - expected) < TOLERANCE
    transactions = defaultdict(list)
    for trade in result["trades"]:
        transactions[trade["date"]].append(trade)
    month_ends = {
        days[-1].isoformat()
        for days in _months(observed.calendar.trading_dates).values()
    }
    limit = config["params"].get("accumulation.maxSignalBuysPerMonth")
    safety = (
        None
        if scheduled or is_trend
        else D(config["params"]["accumulation.cashSafetyLimit"])
    )
    month_buys = defaultdict(int)
    execution = shared.get("execution") or {}
    commission = D(str(execution.get("commission", 0)))
    slip = D(str(execution.get("slippagePct", 0))) / 100
    spread = D(str(execution.get("spreadPct", 0))) / 200
    fractional = execution.get("fractionalShares", True)
    total_costs = {key: D(0) for key in ("commission", "slippageCost", "spreadCost")}
    cash = quantity = fixed = contributed = invested = unused_principal = D(0)
    nav = peak = D(1)
    maximum_dd = units = D(0)
    previous_day = None
    for asset in assets:
        day, price = asset["date"], D(asset["simulationPrice"])
        deposit = funding.get(day, D(0))
        marked_equity = cash + (quantity + fixed) * price
        if deposit:
            if not units:
                units = deposit
            else:
                issue_nav = marked_equity / units if marked_equity else nav or D(1)
                units += deposit / issue_nav
        cash += deposit
        contributed += deposit
        unused_principal += deposit
        expected = []

        def buy(reason, fixed_position=False, price=price, expected=expected):
            nonlocal cash, quantity, fixed, invested, unused_principal
            if cash <= commission:
                return False
            execution_price = price * (1 + slip + spread)
            shares = (cash - commission) / execution_price
            if not fractional:
                shares = shares.to_integral_value(rounding=ROUND_FLOOR)
            if not shares:
                return False
            gross = cash - commission if fractional else shares * execution_price
            amount = gross + commission
            before = cash, quantity + fixed
            if fixed_position:
                fixed += shares
            else:
                quantity += shares
            cash -= amount
            remaining = min(unused_principal, cash)
            invested += unused_principal - remaining
            unused_principal = remaining
            costs = {
                "commission": commission,
                "slippageCost": shares * price * slip,
                "spreadCost": shares * price * spread,
            }
            expected.append(
                (
                    "buy",
                    reason,
                    amount,
                    shares,
                    execution_price,
                    gross,
                    costs,
                    before,
                    (cash, quantity + fixed),
                )
            )
            return True

        if scheduled and deposit:
            buy(
                "fixed_dca" if config["presetId"] == "monthly_dca" else "upfront",
                config["presetId"] == "monthly_dca",
            )
        should_buy, sell_ratio = truth.get(previous_day, (False, D(0)))
        month = day[:7]
        sold = False
        if sell_ratio and quantity:
            shares = quantity * sell_ratio
            if not fractional:
                shares = shares.to_integral_value(rounding=ROUND_FLOOR)
            execution_price = price * (1 - slip - spread)
            gross = shares * execution_price
            amount = gross - commission
            if shares and amount > 0:
                before = cash, quantity + fixed
                quantity -= shares
                cash += amount
                costs = {
                    "commission": commission,
                    "slippageCost": shares * price * slip,
                    "spreadCost": shares * price * spread,
                }
                expected.append(
                    (
                        "sell",
                        "signal_sell",
                        amount,
                        shares,
                        execution_price,
                        gross,
                        costs,
                        before,
                        (cash, quantity + fixed),
                    )
                )
                sold = True
        if not sold:
            if should_buy and cash > 0 and (limit is None or month_buys[month] < limit):
                if buy("signal_buy"):
                    month_buys[month] += 1
            if safety is not None and day in month_ends and cash > 0 and cash >= safety:
                buy("safety_valve")
        assert len(transactions[day]) == len(expected), (
            config["presetId"],
            day,
            transactions[day],
            expected,
        )
        daily_costs = {key: D(0) for key in total_costs}
        for trade, (
            side,
            reason,
            amount,
            shares,
            execution_price,
            gross,
            costs,
            before,
            after,
        ) in zip(transactions[day], expected, strict=True):
            assert (trade["side"], trade["reason"]) == (side, reason)
            assert D(trade["price"]) == execution_price
            assert D(trade["executionPrice"]) == execution_price
            assert D(trade["executionBasePrice"]) == price
            assert abs(D(trade["grossAmount"]) - gross) < TOLERANCE
            assert abs(D(trade["quantity"]) - shares) < TOLERANCE
            assert abs(D(trade["cashAmount"]) - amount) < TOLERANCE
            for key, value in costs.items():
                assert abs(D(trade["tradingCosts"][key]) - value) < TOLERANCE
                daily_costs[key] += value
                total_costs[key] += value
            assert (
                abs(
                    D(trade["tradingCosts"]["totalTradingCost"])
                    - sum(costs.values(), D(0))
                )
                < TOLERANCE
            )
            for key, value in zip(
                ("cashBefore", "quantityBefore", "cashAfter", "quantityAfter"),
                (*before, *after),
                strict=True,
            ):
                assert abs(D(trade[key]) - value) < TOLERANCE
        for key, value in daily_costs.items():
            assert abs(D(asset["tradingCosts"][key]) - value) < TOLERANCE
        assert (
            abs(
                D(asset["tradingCosts"]["totalTradingCost"])
                - sum(daily_costs.values(), D(0))
            )
            < TOLERANCE
        )
        equity = cash + (quantity + fixed) * price
        for field, expected_value in (
            ("cash", cash),
            ("timingQuantity", quantity),
            ("fixedQuantity", fixed),
            ("totalAsset", equity),
            ("totalContributed", contributed),
            ("actualInvested", invested),
        ):
            assert abs(D(asset[field]) - expected_value) < TOLERANCE, (day, field)
        assert 0 <= invested <= contributed
        assert 0 <= D(asset["actualInvested"]) <= D(asset["totalContributed"])
        nav = equity / units if units else D(1)
        peak = max(peak, nav)
        dd = nav / peak - 1
        maximum_dd = max(maximum_dd, -dd)
        assert abs(D(asset["unitNav"]) - nav) < TOLERANCE
        assert abs(D(asset["drawdown"]) - dd) < TOLERANCE
        previous_day = day
    metrics = result["metrics"]
    for key, value in total_costs.items():
        assert abs(D(metrics["tradingCosts"][key]) - value) < TOLERANCE
    assert (
        abs(
            D(metrics["tradingCosts"]["totalTradingCost"])
            - sum(total_costs.values(), D(0))
        )
        < TOLERANCE
    )
    for field, value in (
        ("endingEquity", equity),
        ("totalContributed", total),
        ("actualInvested", invested),
        ("netProfit", equity - total),
        ("returnOnContributions", equity / total - 1),
        ("capitalMultiple", equity / total),
        ("maximumDrawdown", maximum_dd),
    ):
        assert abs(D(metrics[field]) - value) < TOLERANCE, field
    # An independently evaluated ACT/365 NPV must vanish at the saved XIRR.
    with localcontext() as context:
        context.prec = 60
        xirr = D(metrics["xirr"])
        assert xirr > -1
        first = min(date.fromisoformat(day) for day in funding)
        residual = sum(
            (
                -amount
                / (1 + xirr) ** (D((date.fromisoformat(day) - first).days) / 365)
                for day, amount in funding.items()
            ),
            D(0),
        )
        residual += equity / (1 + xirr) ** (
            D((date.fromisoformat(assets[-1]["date"]) - first).days) / 365
        )
        assert abs(residual) < D("1e-18"), residual
    _verify_saved_periods(result)


def _verify_saved_periods(result):
    """Audit saved analysis against the independently checked real daily trace."""
    assets = result["dailyAssets"]
    analysis = result["metrics"]["analysis"]
    with localcontext() as context:
        context.prec = 60
        for field, length in (("annualReturns", 4), ("monthlyReturns", 7)):
            periods = defaultdict(list)
            for asset in assets:
                periods[asset["date"][:length]].append(asset)
            assert len(analysis[field]) == len(periods)
            previous_nav, previous_price = D(1), D(assets[0]["simulationPrice"])
            for saved, observations in zip(
                analysis[field], periods.values(), strict=True
            ):
                assert saved["startDate"] == observations[0]["date"]
                assert saved["endDate"] == observations[-1]["date"]
                if any(D(row["totalContributed"]) > 0 for row in observations):
                    expected = D(observations[-1]["unitNav"]) / previous_nav - 1
                    assert abs(D(saved["navReturn"]) - expected) < D("1e-30")
                else:
                    assert saved["navReturn"] is None
                    assert saved["unavailableReason"] == "no_funding"
                price = D(observations[-1]["simulationPrice"])
                assert abs(D(saved["priceReturn"]) - (price / previous_price - 1)) < D(
                    "1e-30"
                )
                previous_nav, previous_price = D(observations[-1]["unitNav"]), price
        episodes = analysis["drawdownEpisodes"]
        assert episodes is not None
        covered = defaultdict(int)
        for episode in episodes:
            segment = [
                row
                for row in assets
                if episode["peakDate"] <= row["date"] <= episode["endDate"]
            ]
            lowest = min(D(row["drawdown"]) for row in segment)
            assert D(episode["drawdown"]) == lowest
            assert episode["bottomDate"] == next(
                row["date"] for row in segment if D(row["drawdown"]) == lowest
            )
            assert (
                episode["durationDays"]
                == (
                    date.fromisoformat(episode["endDate"])
                    - date.fromisoformat(episode["peakDate"])
                ).days
            )
            if episode["state"] == "recovered":
                assert episode["recoveredDate"] == segment[-1]["date"]
                assert D(segment[-1]["drawdown"]) == 0
                assert (
                    episode["recoveryDays"]
                    == (
                        date.fromisoformat(episode["recoveredDate"])
                        - date.fromisoformat(episode["bottomDate"])
                    ).days
                )
            else:
                assert episode["endDate"] == assets[-1]["date"]
                assert episode["recoveredDate"] is episode["recoveryDays"] is None
            for row in segment:
                if D(row["drawdown"]) < 0:
                    covered[row["date"]] += 1
        assert covered == {row["date"]: 1 for row in assets if D(row["drawdown"]) < 0}
        assert analysis["maximumDrawdownDuration"] == max(
            (row["durationDays"] for row in episodes), default=0
        )
        assert analysis["recoveryDuration"] == (
            episodes[0]["recoveryDays"] if episodes else 0
        )


def _months(days):
    result = defaultdict(list)
    for day in days:
        result[day.year, day.month].append(day)
    return result


@pytest.mark.parametrize("preset_id", tuple(PRESET_DEFINITIONS))
def test_each_default_preset_real_data_independent_replay_and_csv(
    preset_id, supplier, tmp_path
):
    _verify_single_run(preset_id, supplier, tmp_path)


@pytest.mark.parametrize(
    "preset_id,variant",
    [
        (StrategyPresetId.VIX_DCA, "vxn_recycle"),
        (StrategyPresetId.VIX_DCA, "vxd_recycle"),
        (StrategyPresetId.VIX_DCA, "zero_trades"),
        (StrategyPresetId.VIX_DCA, "cash_safety"),
        (StrategyPresetId.RSI_DCA, "rsi_sell"),
        (StrategyPresetId.MA_DEVIATION_DCA, "ma_deviation_sell"),
        (StrategyPresetId.BOLLINGER_DCA, "bollinger_sell"),
        (StrategyPresetId.RATE_DCA, "rate_sell"),
        (StrategyPresetId.RATE_DCA, "unknown_rate_unit"),
        (StrategyPresetId.COMPOSITE_DCA, "nested_and_or"),
    ],
)
def test_signal_variants_real_data_independent_replay_and_csv(
    preset_id, variant, supplier, tmp_path
):
    _verify_single_run(preset_id, supplier, tmp_path, variant)


@pytest.mark.parametrize(
    "preset_id,variant,fractional",
    [
        (StrategyPresetId.MONTHLY_DCA, "default", True),
        (StrategyPresetId.MONTHLY_DCA, "default", False),
        (StrategyPresetId.LUMP_SUM, "default", False),
        (StrategyPresetId.VIX_DCA, "vxn_recycle", True),
        (StrategyPresetId.VIX_DCA, "vxn_recycle", False),
        (StrategyPresetId.MA_TREND, "default", False),
        (StrategyPresetId.COMPOSITE_DCA, "nested_and_or", True),
        (StrategyPresetId.GRID_SEARCH, "default", False),
    ],
)
def test_real_execution_costs_and_share_policy_have_independent_replay(
    preset_id, variant, fractional, supplier, tmp_path
):
    _verify_single_run(
        preset_id,
        supplier,
        tmp_path,
        variant,
        {
            "commission": 1.25,
            "slippagePct": 0.12,
            "spreadPct": 0.18,
            "fractionalShares": fractional,
        },
    )


def _verify_single_run(
    preset_id, supplier, tmp_path, variant="default", execution=None
):
    preset = PRESET_DEFINITIONS[preset_id]
    params = jsonable_encoder(thaw_value(preset.default_params))
    rules = (
        None
        if preset.default_rules is None
        else jsonable_encoder(
            preset.default_rules.model_dump(mode="python", by_alias=True)
        )
    )
    if preset_id.value == "grid_search":
        params = {
            **params,
            "search.dimensions": ["vix.buyThreshold"],
            "search.values.vix.buyThreshold": [20, 25],
        }
    if variant != "default":
        params["accumulation.maxSignalBuysPerMonth"] = None
    if variant in {"zero_trades", "cash_safety"}:
        rules["buy"]["enabled"] = False
        if variant == "cash_safety":
            params["accumulation.cashSafetyLimit"] = 50
    elif variant == "unknown_rate_unit":
        rules["buy"]["params"]["rate.sourceUnit"] = "auto"
    elif variant != "default":
        kind = {
            "vxn_recycle": ConditionKind.VIX,
            "vxd_recycle": ConditionKind.VIX,
            "rsi_sell": ConditionKind.RSI,
            "ma_deviation_sell": ConditionKind.MA_DEVIATION,
            "bollinger_sell": ConditionKind.BOLLINGER,
            "rate_sell": ConditionKind.RATE,
        }.get(variant)
        if kind is not None:
            rules["sell"] = _condition(kind, "sell")
        if variant in {"vxn_recycle", "vxd_recycle"}:
            symbol = "^VXN" if variant == "vxn_recycle" else "^VXD"
            for side in ("buy", "sell"):
                rules[side]["params"]["vix.symbol"] = symbol
            rules["sell"]["params"].update({"exit.vix.low1": 30, "exit.vix.low2": 40})
        elif variant == "rate_sell":
            for side in ("buy", "sell"):
                rules[side]["params"]["rate.thresholdPct"] = 1
        elif variant == "nested_and_or":
            rules = {
                "buy": {
                    "type": "group",
                    "id": "buy-root",
                    "operator": "OR",
                    "children": [
                        _condition(ConditionKind.VIX, "buy"),
                        {
                            "type": "group",
                            "id": "buy-and",
                            "operator": "AND",
                            "children": [
                                _condition(ConditionKind.RSI, "buy"),
                                _condition(ConditionKind.MA_DEVIATION, "buy"),
                            ],
                        },
                    ],
                },
                "sell": {
                    "type": "group",
                    "id": "sell-root",
                    "operator": "OR",
                    "children": [
                        _condition(ConditionKind.VIX, "sell"),
                        _condition(ConditionKind.BOLLINGER, "sell"),
                    ],
                },
            }
    if (
        execution
        and execution.get("fractionalShares") is False
        and variant.endswith("recycle")
    ):
        # Partial exits below one whole share cannot execute. Exercise a
        # genuine whole-share sell/rebuy by explicitly selecting full exits.
        rules["sell"]["params"].update({"exit.vix.ratio1": 1, "exit.vix.ratio2": 1})
    draft = {
        "shared": {
            "run": {
                "symbol": "QQQ",
                "startDate": "2020-01-01",
                "endDate": "2020-06-30",
            },
            "contribution": {"amount": 100, "day": 1},
            **({"execution": execution} if execution is not None else {}),
        },
        "strategies": [
            {
                "id": "individual",
                "presetId": preset_id.value,
                "params": params,
                "rules": rules,
            }
        ],
    }
    old_service = app.state.run_service
    store = InMemoryRunStore()
    app.state.run_service = RunManager(
        store=store, data_provider=supplier, executor=_InlineExecutor()
    )

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://single-real"
        ) as client:
            submitted = await client.post(
                "/api/v1/runs",
                headers={"Idempotency-Key": f"single-{preset_id.value}-{variant}"},
                json={"draft": draft, "scope": "all_enabled"},
            )
            assert submitted.status_code == 202, submitted.text
            saved = (
                await client.get(f"/api/v1/runs/{submitted.json()['runId']}")
            ).json()
            assert saved["snapshot"]["dataProvenance"]["sources"] == (
                ["sec", "yahoo"] if preset_id.value == "pe_dca" else ["yahoo"]
            ), saved["result"]["strategyRuns"]
            rows = saved["result"]["strategyRuns"]
            primary = next(row for row in rows if row["id"] == "individual")
            if preset_id.value != "pe_dca" and variant != "unknown_rate_unit":
                assert primary["status"] == "completed", primary["diagnostics"]
            (tmp_path / "saved-response.json").write_text(
                json.dumps(saved), encoding="utf-8"
            )
            print(
                json.dumps(
                    {
                        "preset": preset_id.value,
                        "variant": variant,
                        "status": primary["status"],
                        "buys": sum(t["side"] == "buy" for t in primary["trades"]),
                        "sells": sum(t["side"] == "sell" for t in primary["trades"]),
                        "metrics": primary["metrics"],
                    }
                )
            )
            if variant == "zero_trades":
                assert primary["trades"] == []
                assert D(primary["metrics"]["actualInvested"]) == 0
            elif variant == "cash_safety":
                assert len(primary["trades"]) == 6
                assert {t["reason"] for t in primary["trades"]} == {"safety_valve"}
            elif variant.endswith("recycle"):
                assert any(t["side"] == "sell" for t in primary["trades"])
            frozen = saved["snapshot"]["config"]
            for row in rows:
                if row["id"] == "individual" and variant == "unknown_rate_unit":
                    assert row["status"] == "failed"
                    assert row["metrics"] is None and row["dailyAssets"] == []
                    assert (
                        row["diagnostics"][0]["fieldPath"]
                        == "strategies[0].rules.buy.params.rate.sourceUnit"
                    )
                    assert (
                        sum(
                            d["code"] == "unknown_source_unit"
                            for d in row["diagnostics"]
                        )
                        == 1
                    )
                    continue
                if row["presetId"] == "pe_dca":
                    # QQQ has no verified historical EPS/holding valuation in the
                    # current provider. This is unavailable, never a zero-return pass.
                    assert row["status"] == "unavailable"
                    assert row["metrics"] is None and row["dailyAssets"] == []
                    assert row["diagnostics"][0]["source"] == "sec"
                    assert row["diagnostics"][0]["code"] == "required_data_unavailable"
                    continue
                cfg = next(
                    (
                        strategy
                        for strategy in frozen["strategies"]
                        if strategy["id"] == row["id"]
                    ),
                    None,
                )
                if cfg is None:
                    defaults = PRESET_DEFINITIONS[row["presetId"]].model_dump(
                        mode="json", by_alias=True
                    )
                    cfg = {
                        "id": row["id"],
                        "presetId": row["presetId"],
                        "params": defaults["defaultParams"],
                        "rules": defaults["defaultRules"],
                    }
                if row["presetId"] == "grid_search":
                    cfg = copy.deepcopy(cfg)
                    best = next(
                        entry
                        for entry in row["searchResult"]["candidates"]
                        if entry["candidateId"]
                        == row["searchResult"]["rankedCandidateIds"][0]
                    )
                    _override_search(
                        cfg["rules"]["buy"],
                        "vix.buyThreshold",
                        best["parameterValues"]["vix.buyThreshold"],
                    )
                _verify_result(
                    frozen["shared"],
                    cfg,
                    row,
                    supplier.observed.get(row["id"], supplier.observed["individual"]),
                )
                for kind, expected_rows in (
                    ("summary", [row["metrics"]]),
                    ("daily-assets", row["dailyAssets"]),
                    ("trades", row["trades"]),
                ):
                    exported = await client.get(
                        f"/api/v1/runs/{saved['runId']}/export/{kind}",
                        params={"focusedResultId": row["id"]},
                    )
                    assert exported.status_code == 200
                    csv_rows = list(csv.DictReader(io.StringIO(exported.text)))
                    assert len(csv_rows) == len(expected_rows)
                    for csv_row, source in zip(csv_rows, expected_rows, strict=True):
                        for key in (
                            "date",
                            "totalContributed",
                            "actualInvested",
                            "totalAsset",
                            "endingEquity",
                            "xirr",
                            "quantity",
                            "cashAmount",
                        ):
                            if key in source:
                                if key == "date":
                                    assert csv_row[key] == source[key]
                                else:
                                    assert D(csv_row[key]) == D(source[key])
            if preset_id.value == "grid_search":
                search = primary["searchResult"]
                assert len(search["candidates"]) == 2
                candidates = []
                for entry in search["candidates"]:
                    candidate = (
                        await client.get(
                            f"/api/v1/runs/{saved['runId']}/candidates/{entry['candidateId']}"
                        )
                    ).json()
                    cfg = {
                        **frozen["strategies"][0],
                        "rules": {**frozen["strategies"][0]["rules"]},
                    }
                    cfg = copy.deepcopy(cfg)
                    _override_search(
                        cfg["rules"]["buy"],
                        "vix.buyThreshold",
                        entry["parameterValues"]["vix.buyThreshold"],
                    )
                    _verify_result(
                        frozen["shared"],
                        cfg,
                        candidate,
                        supplier.observed["individual"],
                    )
                    candidates.append(candidate)
                ranked = sorted(
                    zip(search["candidates"], candidates, strict=True),
                    key=lambda pair: (
                        -D(pair[1]["metrics"]["endingEquity"]),
                        D(pair[1]["metrics"]["maximumDrawdown"]),
                        pair[0]["sequence"],
                    ),
                )
                assert search["rankedCandidateIds"] == [
                    candidate["id"] for _, candidate in ranked
                ]

    try:
        asyncio.run(run())
    finally:
        app.state.run_service = old_service


def _override_search(node, key, value):
    if node["type"] == "group":
        for child in node["children"]:
            _override_search(child, key, value)
    elif key in node["params"]:
        node["params"][key] = value


def _condition(kind, side):
    return jsonable_encoder(
        default_condition(kind, side).model_dump(mode="python", by_alias=True)
    )

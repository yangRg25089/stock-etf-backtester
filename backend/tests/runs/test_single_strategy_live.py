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
from decimal import Decimal, localcontext

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
from app.runs.sqlite_store import SQLiteRunStore
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


def _verify_result(shared, config, result, observed):
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
    truth = {}
    for asset in assets:
        day = asset["date"]
        rules = config.get("rules") or {}
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
    cash = quantity = fixed = contributed = invested = recycled = D(0)
    nav = peak = D(1)
    maximum_dd = previous_equity = D(0)
    previous_day = None
    for asset in assets:
        day, price = asset["date"], D(asset["simulationPrice"])
        deposit = funding.get(day, D(0))
        cash += deposit
        contributed += deposit
        expected = []

        def buy(reason, fixed_position=False, price=price, expected=expected):
            nonlocal cash, quantity, fixed, invested, recycled
            if cash <= 0:
                return
            amount, shares = cash, cash / price
            expected.append(("buy", reason, amount, shares))
            if fixed_position:
                fixed += shares
            else:
                quantity += shares
            reused = min(recycled, amount)
            recycled -= reused
            invested += amount - reused
            cash = D(0)

        if scheduled and deposit:
            buy(
                "fixed_dca" if config["presetId"] == "monthly_dca" else "upfront",
                config["presetId"] == "monthly_dca",
            )
        should_buy, sell_ratio = truth.get(previous_day, (False, D(0)))
        month = day[:7]
        if sell_ratio and quantity:
            shares = quantity * sell_ratio
            amount = shares * price
            quantity -= shares
            cash += amount
            recycled += amount
            expected.append(("sell", "signal_sell", amount, shares))
        else:
            if should_buy and cash > 0 and (limit is None or month_buys[month] < limit):
                buy("signal_buy")
                month_buys[month] += 1
            if safety is not None and day in month_ends and cash > 0 and cash >= safety:
                buy("safety_valve")
        assert len(transactions[day]) == len(expected), (
            config["presetId"],
            day,
            transactions[day],
            expected,
        )
        for trade, (side, reason, amount, shares) in zip(
            transactions[day], expected, strict=True
        ):
            assert (trade["side"], trade["reason"]) == (side, reason)
            assert D(trade["price"]) == price
            assert abs(D(trade["quantity"]) - shares) < TOLERANCE
            assert abs(D(trade["cashAmount"]) - amount) < TOLERANCE
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
        if previous_equity > 0:
            nav *= (equity - deposit) / previous_equity
        peak = max(peak, nav)
        dd = nav / peak - 1
        maximum_dd = max(maximum_dd, -dd)
        assert abs(D(asset["unitNav"]) - nav) < TOLERANCE
        assert abs(D(asset["drawdown"]) - dd) < TOLERANCE
        previous_day, previous_equity = day, equity
    metrics = result["metrics"]
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


def _verify_single_run(preset_id, supplier, tmp_path, variant="default"):
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
    draft = {
        "shared": {
            "run": {
                "symbol": "QQQ",
                "startDate": "2020-01-01",
                "endDate": "2020-06-30",
            },
            "contribution": {"amount": 100, "day": 1},
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
    store = SQLiteRunStore(tmp_path / "single.sqlite3")
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
        store.close()


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

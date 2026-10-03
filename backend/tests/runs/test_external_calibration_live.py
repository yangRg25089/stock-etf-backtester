"""Real Yahoo results checked against observed public calculator outputs."""

import asyncio
import csv
import io
import json
from collections import defaultdict
from datetime import date
from decimal import Decimal
from pathlib import Path

import httpx

from app.main import app
from app.metrics import calculate_xirr
from app.runs.manager import RunManager
from app.runs.sqlite_store import SQLiteRunStore
from app.runs.yahoo_data import YahooRunDataProvider
from tests.runs.test_yahoo_data_live import _InlineExecutor


async def _submit(client, draft, key):
    accepted = await client.post(
        "/api/v1/runs",
        headers={"Idempotency-Key": key},
        json={"draft": draft, "scope": "all_enabled"},
    )
    assert accepted.status_code == 202, accepted.text
    response = await client.get(f"/api/v1/runs/{accepted.json()['runId']}")
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["snapshot"]["dataProvenance"]["sources"] == ["yahoo"]
    assert saved["status"] == "completed", saved["result"]["strategyRuns"]
    return saved


def test_live_dqydj_baselines_match_after_cashflow_and_price_basis_alignment(tmp_path):
    observed = json.loads(
        (
            Path(__file__).resolve().parents[3]
            / "docs/fixtures/dqydj-observed-20261003.json"
        ).read_text()
    )
    previous_service = app.state.run_service
    store = SQLiteRunStore(tmp_path / "dqydj.sqlite3")
    app.state.run_service = RunManager(
        store=store, data_provider=YahooRunDataProvider(), executor=_InlineExecutor()
    )

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://dqydj-calibration"
        ) as client:
            saved = await _submit(
                client,
                {
                    "shared": {
                        "run": {
                            "symbol": observed["symbol"],
                            "startDate": observed["requestedStartDate"],
                            "endDate": observed["requestedEndDate"],
                        },
                        "contribution": {"amount": 100, "day": 1},
                    },
                    "strategies": [
                        {
                            "id": "reference",
                            "presetId": "ma_buy_only",
                            "params": {"ma.period": 10},
                        }
                    ],
                },
                "dqydj-real-baselines",
            )
            runs = {row["id"]: row for row in saved["result"]["strategyRuns"]}
            monthly, upfront = runs["benchmark:monthly-dca"], runs["benchmark:lump-sum"]
            prices = {row["date"]: row for row in monthly["dailyAssets"]}
            first, last = observed["requestedStartDate"], observed["lastChartPointDate"]
            assert monthly["dailyAssets"][-1]["date"] == last
            assert [row["date"] for row in monthly["trades"]] == [first, "2024-05-01"]
            assert upfront["trades"][0]["date"] == first
            terminal_price = Decimal(prices[last]["simulationPrice"])
            # Verify our fixed-calendar DCA independently, before comparing a
            # website with different cash-flow dates and periodic execution prices.
            expected_monthly = (
                sum(
                    (
                        Decimal(row["cashAmount"]) / Decimal(row["price"])
                        for row in monthly["trades"]
                    ),
                    Decimal(0),
                )
                * terminal_price
            )
            assert abs(
                expected_monthly - Decimal(monthly["metrics"]["endingEquity"])
            ) < Decimal("1e-20")
            expected_upfront = (
                Decimal(200)
                / Decimal(prices[first]["simulationPrice"])
                * terminal_price
            )
            assert abs(
                expected_upfront - Decimal(upfront["metrics"]["endingEquity"])
            ) < Decimal("1e-20")
            assert all(
                Decimal(row["metrics"]["totalContributed"]) == 200
                for row in (monthly, upfront)
            )

            periodic_day = observed["monthly"]["firstPeriodicEventDate"]
            aligned_equity = (
                Decimal(100) / Decimal(prices[first]["simulationPrice"])
                + Decimal(100) / Decimal(prices[periodic_day]["simulationOpen"])
            ) * terminal_price
            closing_only = (
                Decimal(100) / Decimal(prices[first]["simulationPrice"])
                + Decimal(100) / Decimal(prices[periodic_day]["simulationPrice"])
            ) * terminal_price
            # Two cents on a $200 scenario is the fixed display/vendor precision
            # budget, never a tolerance for the app's internal ledger.
            precision = Decimal("0.02")
            assert (
                abs(expected_upfront - Decimal(observed["lumpSum"]["finalValue"]))
                < precision
            )
            assert (
                abs(aligned_equity - Decimal(observed["monthly"]["finalValue"]))
                < precision
            )
            assert (
                abs(closing_only - Decimal(observed["monthly"]["finalValue"]))
                > precision
            )
            assert (
                abs(expected_monthly - Decimal(observed["monthly"]["finalValue"]))
                > precision
            )
            flows = (
                (date.fromisoformat(first), Decimal(-100)),
                (date.fromisoformat(periodic_day), Decimal(-100)),
            )
            aligned_xirr, reason = calculate_xirr(
                (*flows, (date.fromisoformat(last), aligned_equity))
            )
            assert reason is None and aligned_xirr is not None
            # Derive the annualized interval from terminal dollar precision:
            # short windows amplify cents into larger annualized percentages.
            lower, _ = calculate_xirr(
                (
                    *flows,
                    (
                        date.fromisoformat(last),
                        Decimal(observed["monthly"]["finalValue"]) - precision,
                    ),
                )
            )
            upper, _ = calculate_xirr(
                (
                    *flows,
                    (
                        date.fromisoformat(last),
                        Decimal(observed["monthly"]["finalValue"]) + precision,
                    ),
                )
            )
            assert lower is not None and upper is not None
            assert lower <= aligned_xirr <= upper
            assert (
                lower
                <= Decimal(observed["monthly"]["annualReturnPercent"]) / 100
                <= upper
            )
            upfront_flows = ((date.fromisoformat(first), Decimal(-200)),)
            upfront_lower, _ = calculate_xirr(
                (
                    *upfront_flows,
                    (
                        date.fromisoformat(last),
                        Decimal(observed["lumpSum"]["finalValue"]) - precision,
                    ),
                )
            )
            upfront_upper, _ = calculate_xirr(
                (
                    *upfront_flows,
                    (
                        date.fromisoformat(last),
                        Decimal(observed["lumpSum"]["finalValue"]) + precision,
                    ),
                )
            )
            assert upfront_lower is not None and upfront_upper is not None
            assert upfront_lower <= Decimal(upfront["metrics"]["xirr"]) <= upfront_upper
            assert (
                upfront_lower
                <= Decimal(observed["lumpSum"]["annualReturnPercent"]) / 100
                <= upfront_upper
            )
            for row in (monthly, upfront):
                summary = await client.get(
                    f"/api/v1/runs/{saved['runId']}/export/summary",
                    params={"focusedResultId": row["id"]},
                )
                assert summary.status_code == 200
                exported = next(csv.DictReader(io.StringIO(summary.text)))
                assert exported["resultId"] == row["id"]
                assert Decimal(exported["endingEquity"]) == Decimal(
                    row["metrics"]["endingEquity"]
                )

    try:
        asyncio.run(run())
    finally:
        app.state.run_service = previous_service
        store.close()


def _leaf(node_id, kind, params):
    return {"type": "condition", "id": node_id, "kind": kind, "params": params}


def _group(node_id, operator, *children):
    return {"type": "group", "id": node_id, "operator": operator, "children": children}


def test_live_nested_strategy_replays_signals_cash_positions_and_saved_exports(
    tmp_path,
):
    previous_service = app.state.run_service
    path = tmp_path / "nested-calibration.sqlite3"
    store = SQLiteRunStore(path)
    reopened = None
    app.state.run_service = RunManager(
        store=store, data_provider=YahooRunDataProvider(), executor=_InlineExecutor()
    )
    buy = _group(
        "entry",
        "AND",
        _leaf("volatility", "vix", {"vix.buyThreshold": 12}),
        _group(
            "alternatives",
            "OR",
            _leaf("trend", "ma_trend", {"ma.period": 10}),
            _leaf("strength", "rsi", {"rsi.period": 14, "rsi.buyThreshold": 50}),
            _leaf("band", "bollinger", {"bollinger.period": 20, "bollinger.stddev": 2}),
        ),
    )
    sell = _group(
        "exit",
        "OR",
        _leaf("trend-exit", "ma_trend", {"ma.period": 10, "exit.ratio": 0.5}),
        _leaf(
            "strength-exit",
            "rsi",
            {"rsi.period": 14, "exit.rsi.threshold": 70, "exit.rsi.ratio": 1},
        ),
    )

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://nested-calibration"
        ) as client:
            return await _submit(
                client,
                {
                    "shared": {
                        "run": {
                            "symbol": "QQQ",
                            "startDate": "2024-01-01",
                            "endDate": "2024-06-28",
                        },
                        "contribution": {"amount": 100, "day": 1},
                    },
                    "strategies": [
                        {
                            "id": "nested",
                            "presetId": "composite_dca",
                            "params": {
                                "accumulation.cashSafetyLimit": 100000000,
                                "accumulation.maxSignalBuysPerMonth": None,
                            },
                            "rules": {"buy": buy, "sell": sell},
                        }
                    ],
                },
                "nested-real-replay",
            )

    try:
        saved = asyncio.run(run())
        result = next(
            row for row in saved["result"]["strategyRuns"] if row["id"] == "nested"
        )
        baseline = next(
            row
            for row in saved["result"]["strategyRuns"]
            if row["id"] == "benchmark:monthly-dca"
        )
        assert len(result["dailyAssets"]) > 100
        assert {row["kind"] for row in result["technicalIndicators"]} == {
            "ma",
            "rsi",
            "bollinger",
        }
        # Independent arithmetic on real prices checks the indicator values,
        # including the sample (not population) deviation used by the notebooks.
        indicators = {
            row["kind"]: {sample["date"]: sample for sample in row["samples"]}
            for row in result["technicalIndicators"]
        }
        price_series = [
            Decimal(row["simulationPrice"]) for row in result["dailyAssets"]
        ]
        for index, asset in enumerate(result["dailyAssets"]):
            if index < 19:
                continue
            day = asset["date"]
            average = sum(price_series[index - 9 : index + 1]) / 10
            assert abs(Decimal(indicators["ma"][day]["value"]) - average) < Decimal(
                "1e-20"
            )
            window = price_series[index - 19 : index + 1]
            mid = sum(window) / 20
            deviation = (sum((value - mid) ** 2 for value in window) / 19).sqrt()
            band = indicators["bollinger"][day]
            assert abs(Decimal(band["value"]) - mid) < Decimal("1e-20")
            assert abs(Decimal(band["lower"]) - (mid - 2 * deviation)) < Decimal(
                "1e-20"
            )
            assert abs(Decimal(band["upper"]) - (mid + 2 * deviation)) < Decimal(
                "1e-20"
            )
            changes = [
                price_series[pos] - price_series[pos - 1]
                for pos in range(index - 13, index + 1)
            ]
            gains = sum(max(change, Decimal(0)) for change in changes)
            losses = sum(max(-change, Decimal(0)) for change in changes)
            rsi = 100 * gains / (gains + losses) if gains + losses else Decimal(50)
            assert abs(Decimal(indicators["rsi"][day]["value"]) - rsi) < Decimal(
                "1e-20"
            )
        assert sum(row["side"] == "buy" for row in result["trades"]) > 3
        assert sum(row["side"] == "sell" for row in result["trades"]) > 3
        evaluations = {(row["date"], row["signalId"]): row for row in result["signals"]}
        expected_states = {}
        for asset in result["dailyAssets"]:
            day = asset["date"]

            def observed(signal_id, day=day):
                signal = evaluations[day, signal_id]
                assert signal["state"] != "unavailable", signal["diagnostics"]
                return Decimal(signal["observedValue"])

            volatility = observed("vix.buy:volatility") >= 12
            trend = observed("ma.trend:trend") > 0
            strength = observed("rsi.buy:strength") <= 50
            band = observed("bollinger.buy:band") <= 0
            should_buy = volatility and (trend or strength or band)
            trend_exit = observed("ma.trend.sell:trend-exit") <= 0
            strength_exit = observed("rsi.exit:strength-exit") >= 70
            sell_ratio = max(
                Decimal("0.5") if trend_exit else Decimal(0),
                Decimal(1) if strength_exit else Decimal(0),
            )
            assert evaluations[day, "accumulation.buy"]["state"] == (
                "true" if should_buy else "false"
            )
            assert evaluations[day, "conditions.sell"]["state"] == (
                "true" if sell_ratio else "false"
            )
            assert (
                Decimal(evaluations[day, "conditions.sell"]["sellRatio"]) == sell_ratio
            )
            expected_states[day] = should_buy, sell_ratio

        deposits = {
            row["date"]: Decimal(row["cashAmount"]) for row in baseline["trades"]
        }
        transactions = defaultdict(list)
        for trade in result["trades"]:
            transactions[trade["date"]].append(trade)
        cash = quantity = contributed = invested = recycled = Decimal(0)
        previous_day = None
        for asset in result["dailyAssets"]:
            day, price = asset["date"], Decimal(asset["simulationPrice"])
            cash += deposits.get(day, Decimal(0))
            contributed += deposits.get(day, Decimal(0))
            orders = transactions[day]
            expected_buy, ratio = expected_states.get(previous_day, (False, Decimal(0)))
            if ratio and quantity:
                assert len(orders) == 1 and orders[0]["side"] == "sell"
                assert abs(Decimal(orders[0]["quantity"]) - quantity * ratio) < Decimal(
                    "1e-20"
                )
            elif expected_buy and cash:
                assert len(orders) == 1 and orders[0]["side"] == "buy"
                assert Decimal(orders[0]["cashAmount"]) == cash
            else:
                assert orders == []
            for trade in orders:
                amount, shares = (
                    Decimal(trade["cashAmount"]),
                    Decimal(trade["quantity"]),
                )
                assert trade["reason"] == (
                    "signal_buy" if trade["side"] == "buy" else "signal_sell"
                )
                assert Decimal(trade["price"]) == price
                assert abs(amount - shares * price) < Decimal("1e-20")
                if trade["side"] == "buy":
                    cash -= amount
                    quantity += shares
                    reused = min(recycled, amount)
                    recycled -= reused
                    invested += amount - reused
                else:
                    cash += amount
                    quantity -= shares
                    recycled += amount
            assert abs(cash - Decimal(asset["cash"])) < Decimal("1e-20")
            assert abs(quantity - Decimal(asset["timingQuantity"])) < Decimal("1e-20")
            assert Decimal(asset["fixedQuantity"]) == 0
            assert abs(
                cash + quantity * price - Decimal(asset["totalAsset"])
            ) < Decimal("1e-20")
            assert Decimal(asset["totalContributed"]) == contributed
            assert abs(Decimal(asset["actualInvested"]) - invested) < Decimal("1e-20")
            assert 0 <= invested <= contributed
            previous_day = day
        metrics = result["metrics"]
        assert Decimal(metrics["totalContributed"]) == 600
        assert abs(Decimal(metrics["actualInvested"]) - invested) < Decimal("1e-20")
        assert (
            Decimal(metrics["netProfit"])
            == Decimal(metrics["endingEquity"]) - contributed
        )
        assert abs(
            Decimal(metrics["capitalMultiple"])
            - Decimal(metrics["endingEquity"]) / contributed
        ) < Decimal("1e-20")
        store.close()
        reopened = SQLiteRunStore(path)
        app.state.run_service = RunManager(store=reopened, executor=_InlineExecutor())

        async def restore():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://nested-restored",
            ) as client:
                assert (
                    await client.get(f"/api/v1/runs/{saved['runId']}")
                ).json() == saved
                for kind, saved_rows in (
                    ("daily-assets", result["dailyAssets"]),
                    ("trades", result["trades"]),
                ):
                    response = await client.get(
                        f"/api/v1/runs/{saved['runId']}/export/{kind}",
                        params={"focusedResultId": "nested"},
                    )
                    assert response.status_code == 200
                    exported = list(csv.DictReader(io.StringIO(response.text)))
                    assert len(exported) == len(saved_rows)
                    for row, expected in zip(exported, saved_rows, strict=True):
                        assert row["date"] == expected["date"]
                        for field in (
                            ("totalAsset", "actualInvested")
                            if kind == "daily-assets"
                            else ("cashAmount", "quantity", "price")
                        ):
                            assert Decimal(row[field]) == Decimal(expected[field])

        asyncio.run(restore())
    finally:
        app.state.run_service = previous_service
        store.close()
        if reopened is not None:
            reopened.close()

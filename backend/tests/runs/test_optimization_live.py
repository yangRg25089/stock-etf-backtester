"""Real Yahoo Train/Test replay using the independent money and signal oracle."""

import asyncio
import copy
import csv
import io
from decimal import Decimal

import httpx
import pytest

from app.main import app
from app.runs.manager import RunManager
from app.runs.store import InMemoryRunStore
from tests.runs.test_single_strategy_live import (
    _ObservedYahoo,
    _override_search,
    _verify_result,
)
from tests.runs.test_yahoo_data_live import _InlineExecutor


@pytest.mark.parametrize("commission", [0, 1])
def test_real_train_test_every_curve_fee_nav_xirr_and_csv(commission) -> None:
    supplier = _ObservedYahoo()
    manager = RunManager(
        store=InMemoryRunStore(), data_provider=supplier, executor=_InlineExecutor()
    )
    old_service = app.state.run_service
    app.state.run_service = manager

    async def verify() -> None:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://split-real"
        ) as client:
            accepted = await client.post(
                "/api/v1/runs",
                headers={"Idempotency-Key": f"split-real-{commission}"},
                json={
                    "scope": "all_enabled",
                    "draft": {
                        "shared": {
                            "run": {
                                "symbol": "QQQ",
                                "startDate": "2020-01-01",
                                "endDate": "2020-12-31",
                            },
                            "contribution": {"amount": 100, "day": 1},
                            "execution": {
                                "commission": commission,
                                "slippagePct": "0.05",
                                "spreadPct": "0.1",
                            },
                        },
                        "strategies": [
                            {
                                "id": "split-real",
                                "presetId": "grid_search",
                                "params": {
                                    "search.optimizationMode": "train_test",
                                    "search.trainEndDate": "2020-06-30",
                                    "search.dimensions": ["vix.buyThreshold"],
                                    "search.values.vix.buyThreshold": [20, 30],
                                },
                                "rules": {
                                    "buy": {
                                        "type": "condition",
                                        "id": "split-buy",
                                        "kind": "vix",
                                        "params": {
                                            "vix.symbol": "^VIX",
                                            "vix.buyThreshold": 25,
                                        },
                                    },
                                    "sell": None,
                                },
                            }
                        ],
                    },
                },
            )
            assert accepted.status_code == 202, accepted.text
            saved = (
                await client.get(f"/api/v1/runs/{accepted.json()['runId']}")
            ).json()
            assert saved["status"] == "completed", saved
            primary = next(
                row
                for row in saved["result"]["strategyRuns"]
                if row["id"] == "split-real"
            )
            search = primary["searchResult"]
            assert search["optimizationMode"] == "train_test"
            assert saved["snapshot"]["dataProvenance"]["sources"] == ["yahoo"]
            details = []
            for candidate in search["candidates"]:
                for identifier, phase in (
                    (candidate["candidateId"], "train"),
                    (candidate["testResult"]["resultId"], "test"),
                ):
                    response = await client.get(
                        f"/api/v1/runs/{saved['runId']}/candidates/{identifier}"
                    )
                    assert response.status_code == 200
                    detail = response.json()
                    assert detail["evaluationPeriod"]["phase"] == phase
                    assert detail["trades"]
                    cfg = copy.deepcopy(saved["snapshot"]["config"]["strategies"][0])
                    cfg["params"].update(candidate["parameterValues"])
                    _override_search(
                        cfg["rules"]["buy"],
                        "vix.buyThreshold",
                        candidate["parameterValues"]["vix.buyThreshold"],
                    )
                    shared = copy.deepcopy(saved["snapshot"]["config"]["shared"])
                    shared["run"].update(
                        {
                            "startDate": detail["evaluationPeriod"]["startDate"],
                            "endDate": detail["evaluationPeriod"]["endDate"],
                        }
                    )
                    _verify_result(shared, cfg, detail, supplier.observed["split-real"])
                    assert Decimal(detail["metrics"]["totalContributed"]) == 600
                    assert Decimal(
                        detail["metrics"]["tradingCosts"]["commission"]
                    ) == commission * len(detail["trades"])
                    details.append(detail)
                    summary = await client.get(
                        f"/api/v1/runs/{saved['runId']}/export/summary",
                        params={"focusedResultId": identifier},
                    )
                    assert summary.status_code == 200
                    row = next(csv.DictReader(io.StringIO(summary.text)))
                    assert row["startDate"] == detail["evaluationPeriod"]["startDate"]
                    assert row["endDate"] == detail["evaluationPeriod"]["endDate"]
                    for key in (
                        "endingEquity",
                        "totalContributed",
                        "xirr",
                        "commission",
                        "totalTradingCost",
                    ):
                        actual = detail["metrics"].get(
                            key, detail["metrics"]["tradingCosts"].get(key)
                        )
                        assert Decimal(row[key]) == Decimal(actual)
            assert len(details) == 4
            assert len(search["periodBenchmarks"]) == 4
            for baseline in search["periodBenchmarks"]:
                shared = copy.deepcopy(saved["snapshot"]["config"]["shared"])
                shared["run"].update(
                    {
                        "startDate": baseline["evaluationPeriod"]["startDate"],
                        "endDate": baseline["evaluationPeriod"]["endDate"],
                    }
                )
                _verify_result(
                    shared,
                    {"presetId": baseline["presetId"], "params": {}, "rules": None},
                    baseline,
                    supplier.observed["split-real"],
                )
            exported = await client.get(
                f"/api/v1/runs/{saved['runId']}/export/search-results",
                params={"focusedResultId": primary["id"]},
            )
            assert exported.status_code == 200
            for row, candidate in zip(
                csv.DictReader(io.StringIO(exported.text)),
                search["candidates"],
                strict=True,
            ):
                assert Decimal(row["xirr"]) == Decimal(candidate["metrics"]["xirr"])
                assert Decimal(row["testXirr"]) == Decimal(
                    candidate["testResult"]["metrics"]["xirr"]
                )
                assert row["testResultId"] == candidate["testResult"]["resultId"]

    try:
        asyncio.run(verify())
    finally:
        app.state.run_service = old_service

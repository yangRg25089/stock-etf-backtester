"""Real Yahoo rolling selection and continuous independent ledger replay."""

import asyncio
import copy
from decimal import Decimal

import httpx

from app.main import app
from app.runs.manager import RunManager
from app.runs.store import InMemoryRunStore
from tests.runs.test_single_strategy_live import (
    _ObservedYahoo,
    _override_search,
    _verify_result,
)
from tests.runs.test_yahoo_data_live import _InlineExecutor


def test_real_walk_forward_training_ranks_oos_fees_nav_and_saved_export():
    provider = _ObservedYahoo()
    manager = RunManager(
        store=InMemoryRunStore(), data_provider=provider, executor=_InlineExecutor()
    )
    previous = app.state.run_service
    app.state.run_service = manager

    async def verify():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://walk-real"
        ) as client:
            draft = {
                "shared": {
                    "run": {
                        "symbol": "QQQ",
                        "startDate": "2015-01-01",
                        "endDate": "2021-03-31",
                    },
                    "contribution": {"amount": 100, "day": 1},
                    "execution": {
                        "commission": "0.75",
                        "slippagePct": "0.05",
                        "spreadPct": "0.1",
                    },
                },
                "strategies": [
                    {
                        "id": "walk-real",
                        "presetId": "grid_search",
                        "params": {
                            "search.optimizationMode": "walk_forward",
                            "search.dimensions": ["vix.buyThreshold"],
                            "search.values.vix.buyThreshold": [20, 30],
                        },
                        "rules": {
                            "buy": {
                                "type": "condition",
                                "id": "walk-buy",
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
            }
            accepted = await client.post(
                "/api/v1/runs",
                json={"draft": draft, "scope": "all_enabled"},
                headers={"Idempotency-Key": "walk-real"},
            )
            assert accepted.status_code == 202, accepted.text
            run_id = accepted.json()["runId"]
            saved = (await client.get(f"/api/v1/runs/{run_id}")).json()
            assert saved["status"] == "completed", saved
            parent = next(
                row
                for row in saved["result"]["strategyRuns"]
                if row["id"] == "walk-real"
            )
            search = parent["searchResult"]
            assert (
                len(search["walkForwardWindows"]) == 2
                and search["totalCandidateCount"] == 4
            )
            assert saved["snapshot"]["dataProvenance"]["sources"] == ["yahoo"]
            base_cfg = saved["snapshot"]["config"]["strategies"][0]
            rules_by_date = {}
            for window in search["walkForwardWindows"]:
                candidates = [
                    row
                    for row in search["candidates"]
                    if row["candidateId"] in window["candidateIds"]
                ]
                for row in candidates:
                    detail = (
                        await client.get(
                            f"/api/v1/runs/{run_id}/candidates/{row['candidateId']}"
                        )
                    ).json()
                    shared = copy.deepcopy(saved["snapshot"]["config"]["shared"])
                    shared["run"].update(
                        {
                            "startDate": window["trainPeriod"]["startDate"],
                            "endDate": window["trainPeriod"]["endDate"],
                        }
                    )
                    cfg = copy.deepcopy(base_cfg)
                    cfg["params"].update(row["parameterValues"])
                    _override_search(
                        cfg["rules"]["buy"],
                        "vix.buyThreshold",
                        row["parameterValues"]["vix.buyThreshold"],
                    )
                    _verify_result(shared, cfg, detail, provider.observed["walk-real"])
                expected = sorted(
                    candidates,
                    key=lambda row: (
                        -Decimal(row["metrics"]["endingEquity"]),
                        abs(Decimal(row["metrics"]["maximumDrawdown"])),
                        row["sequence"],
                    ),
                )
                assert window["rankedCandidateIds"] == [
                    row["candidateId"] for row in expected
                ]
                assert window["selectedCandidateId"] == expected[0]["candidateId"]
                rules = copy.deepcopy(base_cfg["rules"])
                _override_search(
                    rules["buy"],
                    "vix.buyThreshold",
                    expected[0]["parameterValues"]["vix.buyThreshold"],
                )
                for asset in parent["dailyAssets"]:
                    if (
                        window["testPeriod"]["startDate"]
                        <= asset["date"]
                        <= window["testPeriod"]["endDate"]
                    ):
                        rules_by_date[asset["date"]] = rules
            shared = copy.deepcopy(saved["snapshot"]["config"]["shared"])
            shared["run"].update(
                {
                    "startDate": search["outOfSamplePeriod"]["startDate"],
                    "endDate": search["outOfSamplePeriod"]["endDate"],
                }
            )
            _verify_result(
                shared,
                base_cfg,
                parent,
                provider.observed["walk-real"],
                rules_by_date=rules_by_date,
            )
            assert Decimal(parent["metrics"]["totalContributed"]) == 1500
            assert any(
                Decimal(day["timingQuantity"]) > 0
                for day in parent["dailyAssets"]
                if day["date"].startswith("2021-01")
            )
            for baseline in search["periodBenchmarks"]:
                _verify_result(
                    shared,
                    {"presetId": baseline["presetId"], "params": {}, "rules": None},
                    baseline,
                    provider.observed["walk-real"],
                )
            file = (await client.get(f"/api/v1/runs/{run_id}/package")).json()
            assert len(file["candidateDetails"]) == 5
            assert (
                file["candidateDetails"][search["outOfSample"]["resultId"]][
                    "dailyAssets"
                ]
                == parent["dailyAssets"]
            )

    try:
        asyncio.run(verify())
    finally:
        app.state.run_service = previous

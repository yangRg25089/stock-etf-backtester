"""Identified SEC and real Yahoo: positive stock PE, trading, search and export.

This gate requires the local SEC contact or SEC_USER_AGENT in the environment;
an absent contact is a failed capability check, never a skipped positive test.
"""

import asyncio
import copy
import csv
import io
import json
from decimal import Decimal

import httpx

from app.main import app
from app.runs.manager import RunManager
from app.runs.store import InMemoryRunStore
from tests.runs.test_single_strategy_live import (
    _ObservedYahoo,
    _verify_result,
)
from tests.runs.test_yahoo_data_live import _InlineExecutor


def test_real_msft_historical_pe_trade_search_and_saved_csv():
    provider = _ObservedYahoo()
    manager = RunManager(
        store=InMemoryRunStore(), data_provider=provider, executor=_InlineExecutor()
    )
    previous = app.state.run_service
    app.state.run_service = manager

    async def verify():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://pe-real"
        ) as client:
            buy = {
                "type": "condition",
                "id": "pe-buy",
                "kind": "pe",
                "params": {"pe.threshold": 40},
            }
            sell = {
                "type": "condition",
                "id": "pe-sell",
                "kind": "pe",
                "params": {"pe.threshold": 45, "exit.ratio": "0.5"},
            }
            accepted = await client.post(
                "/api/v1/runs",
                headers={"Idempotency-Key": "pe-positive-real"},
                json={
                    "scope": "all_enabled",
                    "draft": {
                        "shared": {
                            "run": {
                                "symbol": "MSFT",
                                "startDate": "2024-01-01",
                                "endDate": "2024-12-31",
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
                                "id": "pe-real",
                                "presetId": "pe_dca",
                                "params": {},
                                "rules": {"buy": buy, "sell": sell},
                            },
                            {
                                "id": "pe-search",
                                "presetId": "grid_search",
                                "params": {
                                    "search.dimensions": [
                                        "accumulation.cashSafetyLimit"
                                    ],
                                    "search.values.accumulation.cashSafetyLimit": [
                                        600,
                                        1200,
                                    ],
                                },
                                "rules": {"buy": buy, "sell": None},
                            },
                        ],
                    },
                },
            )
            assert accepted.status_code == 202, accepted.text
            run_id = accepted.json()["runId"]
            saved = (await client.get(f"/api/v1/runs/{run_id}")).json()
            assert saved["status"] == "completed", json.dumps(
                [
                    (row["id"], row["status"], row["diagnostics"])
                    for row in saved["result"]["strategyRuns"]
                ]
            )
            assert saved["snapshot"]["dataProvenance"]["sources"] == [
                "sec:companyfacts",
                "yahoo",
            ]
            observations = provider.observed["pe-real"].snapshot.valuation.observations
            assert (
                len(observations)
                == len(provider.observed["pe-real"].snapshot.market.bars)
                == 252
            )
            assert observations[0].eps == Decimal("9.68")
            config = saved["snapshot"]["config"]
            primary = next(
                row for row in saved["result"]["strategyRuns"] if row["id"] == "pe-real"
            )
            assert any(trade["side"] == "buy" for trade in primary["trades"])
            assert any(trade["side"] == "sell" for trade in primary["trades"])
            for row in saved["result"]["strategyRuns"]:
                cfg = next(
                    (item for item in config["strategies"] if item["id"] == row["id"]),
                    {"presetId": row["presetId"], "params": {}, "rules": None},
                )
                if row["searchResult"]:
                    continue
                _verify_result(config["shared"], cfg, row, provider.observed["pe-real"])
                assert (
                    Decimal(row["metrics"]["actualInvested"])
                    <= Decimal(row["metrics"]["totalContributed"])
                    == 1200
                )
                summary = await client.get(
                    f"/api/v1/runs/{run_id}/export/summary",
                    params={"focusedResultId": row["id"]},
                )
                assert summary.status_code == 200
                exported = next(csv.DictReader(io.StringIO(summary.text)))
                for key in (
                    "endingEquity",
                    "totalContributed",
                    "actualInvested",
                    "xirr",
                ):
                    assert Decimal(exported[key]) == Decimal(row["metrics"][key])
            search = next(
                row["searchResult"]
                for row in saved["result"]["strategyRuns"]
                if row["id"] == "pe-search"
            )
            base = next(row for row in config["strategies"] if row["id"] == "pe-search")
            for row in search["candidates"]:
                detail = await client.get(
                    f"/api/v1/runs/{run_id}/candidates/{row['candidateId']}"
                )
                assert detail.status_code == 200
                cfg = copy.deepcopy(base)
                cfg["params"].update(row["parameterValues"])
                _verify_result(
                    config["shared"], cfg, detail.json(), provider.observed["pe-real"]
                )
            package = await client.get(f"/api/v1/runs/{run_id}/package")
            assert package.status_code == 200
            assert len(package.json()["candidateDetails"]) == 2

    try:
        asyncio.run(verify())
    finally:
        app.state.run_service = previous

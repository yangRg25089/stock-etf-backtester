"""Live Yahoo MA/Bollinger/RSI and search persistence acceptance."""

import asyncio
from decimal import Decimal

import httpx

from app.main import app
from app.runs.manager import RunManager
from app.runs.store import InMemoryRunStore
from app.runs.yahoo_data import YahooRunDataProvider
from tests.runs.test_yahoo_data_live import _InlineExecutor


def test_live_technical_values_and_grid_candidates_remain_in_current_runtime(tmp_path):
    previous = app.state.run_service
    store = InMemoryRunStore()
    app.state.run_service = RunManager(
        store=store, data_provider=YahooRunDataProvider(), executor=_InlineExecutor()
    )

    async def exercise():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://technical-live"
        ) as client:
            accepted = await client.post(
                "/api/v1/runs",
                headers={"Idempotency-Key": "technical-live"},
                json={
                    "draft": {
                        "shared": {
                            "run": {
                                "symbol": "QQQ",
                                "startDate": "2024-01-31",
                                "endDate": "2024-03-01",
                            },
                            "contribution": {"amount": 100, "day": 1},
                        },
                        "strategies": [
                            {
                                "id": "ma",
                                "presetId": "ma_trend",
                                "params": {"ma.period": 200},
                            },
                            {"id": "band", "presetId": "bollinger_dca", "params": {}},
                            {"id": "strength", "presetId": "rsi_dca", "params": {}},
                            {
                                "id": "grid",
                                "presetId": "grid_search",
                                "params": {
                                    "vix.buyEnabled": False,
                                    "ma.buyEnabled": True,
                                    "ma.period": 200,
                                    "bollinger.buyEnabled": True,
                                    "rsi.buyEnabled": True,
                                    "search.dimensions": ["rsi.buyThreshold"],
                                    "search.values.rsi.buyThreshold": [25, 35],
                                },
                            },
                        ],
                    },
                    "scope": "all_enabled",
                },
            )
            assert accepted.status_code == 202, accepted.text
            run_id = accepted.json()["runId"]
            saved = (await client.get(f"/api/v1/runs/{run_id}")).json()
            assert saved["snapshot"]["dataProvenance"]["sources"] == ["yahoo"]
            results = {
                result["id"]: result for result in saved["result"]["strategyRuns"]
            }
            for key in ("ma", "band", "strength", "grid"):
                assert results[key]["status"] == "completed", results[key][
                    "diagnostics"
                ]
                assert results[key]["technicalIndicators"]
            ma = results["ma"]["technicalIndicators"][0]
            assert ma["kind"] == "ma" and ma["period"] == 200
            assert ma["samples"][0]["value"] is not None, (
                "real pre-run quotes must warm MA200"
            )
            prices = {
                asset["date"]: Decimal(asset["simulationPrice"])
                for asset in results["ma"]["dailyAssets"]
            }
            ma_values = {
                sample["date"]: Decimal(sample["value"]) for sample in ma["samples"]
            }
            signals = [
                signal
                for signal in results["ma"]["signals"]
                if signal["conditionKind"] == "ma_trend"
            ]
            assert signals
            for signal in signals:
                assert abs(
                    prices[signal["date"]]
                    - ma_values[signal["date"]]
                    - Decimal(signal["observedValue"])
                ) < Decimal("1e-20")
            for sample in results["band"]["technicalIndicators"][0]["samples"]:
                assert (
                    Decimal(sample["lower"])
                    <= Decimal(sample["value"])
                    <= Decimal(sample["upper"])
                )
            rsi = results["strength"]["technicalIndicators"][0]
            assert rsi["kind"] == "rsi" and all(
                0 <= Decimal(sample["value"]) <= 100 for sample in rsi["samples"]
            )
            grid = results["grid"]
            candidates = grid["searchResult"]["candidates"]
            details = {}
            for candidate in candidates:
                detail = (
                    await client.get(
                        f"/api/v1/runs/{run_id}/candidates/{candidate['candidateId']}"
                    )
                ).json()
                assert detail["technicalIndicators"][0]["period"] == int(
                    candidate["parameterValues"]["ma.period"]
                )
                assert (
                    detail["technicalIndicators"][0]["samples"][0]["value"] is not None
                )
                band = next(
                    item
                    for item in detail["technicalIndicators"]
                    if item["kind"] == "bollinger"
                )
                assert Decimal(band["deviations"]) == Decimal("2")
                details[candidate["candidateId"]] = detail
            assert {
                detail["technicalIndicators"][0]["period"]
                for detail in details.values()
            } == {200}
            assert (
                grid["technicalIndicators"]
                == details[grid["searchResult"]["rankedCandidateIds"][0]][
                    "technicalIndicators"
                ]
            )
            return saved, details

    try:
        saved, details = asyncio.run(exercise())
        reopened = store
        # Read the same runtime store without a provider or recalculation.
        app.state.run_service = RunManager(store=reopened, executor=_InlineExecutor())

        async def restore():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://technical-restored",
            ) as client:
                response = await client.get(f"/api/v1/runs/{saved['runId']}")
                assert response.json() == saved
                for candidate_id, detail in details.items():
                    response = await client.get(
                        f"/api/v1/runs/{saved['runId']}/candidates/{candidate_id}"
                    )
                    assert response.json() == detail

        asyncio.run(restore())
    finally:
        app.state.run_service = previous

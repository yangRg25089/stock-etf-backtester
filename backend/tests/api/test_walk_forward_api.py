"""Full saved run, candidate and export boundaries for rolling optimization."""

import asyncio
import csv
import io
from decimal import Decimal

import httpx

from app.main import app
from app.runs.manager import RunManager
from app.runs.store import InMemoryRunStore
from tests.e2e.fixture_provider import ImmediateExecutor, WalkForwardFixtureProvider


def test_walk_forward_api_displays_oos_and_exports_every_saved_training_window():
    provider = WalkForwardFixtureProvider()
    manager = RunManager(
        store=InMemoryRunStore(), data_provider=provider, executor=ImmediateExecutor()
    )
    previous = app.state.run_service
    app.state.run_service = manager

    async def verify():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://walk-fixture"
        ) as client:
            draft = provider.source.config.model_dump(mode="json", by_alias=True)
            accepted = await client.post(
                "/api/v1/runs",
                json={"draft": draft, "scope": "all_enabled"},
                headers={"Idempotency-Key": "walk-fixture"},
            )
            assert accepted.status_code == 202, accepted.text
            run_id = accepted.json()["runId"]
            saved = (await client.get(f"/api/v1/runs/{run_id}")).json()
            assert saved["status"] == "completed", saved
            primary = next(
                row for row in saved["result"]["strategyRuns"] if row["id"] == "walk"
            )
            search = primary["searchResult"]
            assert primary["metrics"] == search["outOfSample"]["metrics"]
            assert primary["evaluationPeriod"] == search["outOfSamplePeriod"]
            oos_response = await client.get(
                f"/api/v1/runs/{run_id}/candidates/{search['outOfSample']['resultId']}"
            )
            assert oos_response.status_code == 200
            oos = oos_response.json()
            assert primary["dailyAssets"] == oos["dailyAssets"]
            assert primary["trades"] == oos["trades"]
            assert Decimal(primary["metrics"]["totalContributed"]) == 500
            assert abs(Decimal(primary["metrics"]["endingEquity"]) - 620) < Decimal(
                "1e-20"
            )
            assert (
                await client.get(f"/api/v1/runs/{run_id}/package")
            ).status_code == 404
            for window in search["walkForwardWindows"]:
                for identifier in window["candidateIds"]:
                    response = await client.get(
                        f"/api/v1/runs/{run_id}/candidates/{identifier}"
                    )
                    assert response.status_code == 200, response.text
                    detail = response.json()
                    assert detail["evaluationPeriod"] == window["trainPeriod"]
                    assert detail["dailyAssets"]
            exported = await client.get(
                f"/api/v1/runs/{run_id}/export/search-results",
                params={"focusedResultId": "walk"},
            )
            assert exported.status_code == 200
            rows = list(csv.DictReader(io.StringIO(exported.text)))
            assert len(rows) == 4
            assert [row["walkForwardWindow"] for row in rows] == ["1", "1", "2", "2"]
            assert sum(row["selectedForTesting"] == "true" for row in rows) == 2
            for row in rows:
                assert row["outOfSampleResultId"] == oos["id"]
                assert row["outOfSampleStartDate"] == "2020-01-01"
                assert Decimal(row["outOfSampleEndingEquity"]) == Decimal(
                    oos["metrics"]["endingEquity"]
                )

    try:
        asyncio.run(verify())
    finally:
        app.state.run_service = previous

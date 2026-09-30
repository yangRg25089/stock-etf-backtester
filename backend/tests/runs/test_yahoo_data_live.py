"""Live Yahoo acceptance for the default QQQ + VIX run path."""

from __future__ import annotations

import asyncio
from concurrent.futures import Executor, Future
from typing import Any

import httpx
from fastapi.encoders import jsonable_encoder

from app.main import app
from app.runs.manager import RunManager
from app.runs.sqlite_store import SQLiteRunStore
from app.runs.yahoo_data import YahooRunDataProvider


class _InlineExecutor(Executor):
    """Make the HTTP-level live run observable before the request returns."""

    def submit(self, fn: Any, /, *args: Any, **kwargs: Any) -> Future[Any]:
        future: Future[Any] = Future()
        try:
            future.set_result(fn(*args, **kwargs))
        except BaseException as error:
            future.set_exception(error)
        return future


def test_live_qqq_volatility_index_runs_use_real_yahoo_observations(tmp_path) -> None:
    previous_service = app.state.run_service
    store = SQLiteRunStore(tmp_path / "live-yahoo-runs.sqlite3")
    app.state.run_service = RunManager(
        store=store,
        data_provider=YahooRunDataProvider(),
        executor=_InlineExecutor(),
    )

    async def submit_and_read() -> dict[str, Any]:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://live-yahoo-test",
        ) as client:
            submitted = await client.post(
                "/api/v1/runs",
                headers={"Idempotency-Key": "live-yahoo-qqq-vix"},
                json=jsonable_encoder(
                    {
                        "draft": {
                            "shared": {
                                "run": {
                                    "symbol": "QQQ",
                                    "startDate": "2020-01-01",
                                    "endDate": "2020-01-01",
                                    "endMode": "latest",
                                },
                                "contribution": {"day": 1, "amount": 100},
                            },
                            "strategies": [
                                {
                                    "id": f"live-yahoo-{symbol[1:].lower()}",
                                    "presetId": "vix_dca",
                                    "enabled": True,
                                    "params": {"vix.symbol": symbol},
                                }
                                for symbol in ("^VIX", "^VXN", "^VXD")
                            ],
                        },
                        "scope": "all_enabled",
                    }
                ),
            )
            assert submitted.status_code == 202, submitted.text
            run_id = submitted.json()["runId"]
            completed = await client.get(f"/api/v1/runs/{run_id}")
            assert completed.status_code == 200, completed.text
            return completed.json()

    try:
        result = asyncio.run(submit_and_read())
    finally:
        app.state.run_service = previous_service
        store.close()

    assert result["snapshot"]["dataProvenance"]["sources"] == ["yahoo"]
    assert result["snapshot"]["config"]["shared"]["run"]["endDate"] is not None
    for symbol in ("^VIX", "^VXN", "^VXD"):
        strategy = next(
            item
            for item in result["result"]["strategyRuns"]
            if item["id"] == f"live-yahoo-{symbol[1:].lower()}"
        )
        assert strategy["status"] in {
            "completed",
            "completed_with_warning",
        }, strategy.get("diagnostics")
        assert all(
            diagnostic["severity"] == "warning"
            for diagnostic in strategy.get("diagnostics", [])
        )
        assert all(
            diagnostic["messageKey"] != "market.latest_quote_delayed"
            for diagnostic in strategy.get("diagnostics", [])
        )
        assert (
            strategy["dailyAssets"][-1]["date"]
            == result["snapshot"]["config"]["shared"]["run"]["endDate"]
        )
        assert strategy["metrics"]["relativeToDca"] is not None
        vix_signals = [
            item for item in strategy["signals"] if item["signalId"] == "vix.buy"
        ]
        assert vix_signals
        assert all(item["state"] != "unavailable" for item in vix_signals)
        assert any(item.get("observedValue") is not None for item in vix_signals)


def test_live_fixed_qqq_vix_run_matches_the_reported_date_range(tmp_path) -> None:
    previous_service = app.state.run_service
    store = SQLiteRunStore(tmp_path / "live-yahoo-fixed-runs.sqlite3")
    app.state.run_service = RunManager(
        store=store,
        data_provider=YahooRunDataProvider(),
        executor=_InlineExecutor(),
    )

    async def submit_and_read() -> dict[str, Any]:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://live-yahoo-fixed-test",
        ) as client:
            submitted = await client.post(
                "/api/v1/runs",
                headers={"Idempotency-Key": "live-yahoo-qqq-vix-fixed-20260928"},
                json=jsonable_encoder(
                    {
                        "draft": {
                            "shared": {
                                "run": {
                                    "symbol": "QQQ",
                                    "startDate": "2020-01-01",
                                    "endDate": "2026-09-28",
                                    "endMode": "fixed",
                                },
                                "contribution": {"day": 1, "amount": 100},
                            },
                            "strategies": [
                                {
                                    "id": "live-yahoo-qqq-vix-fixed",
                                    "presetId": "vix_dca",
                                    "enabled": True,
                                    "params": {"vix.symbol": "^VIX"},
                                }
                            ],
                        },
                        "scope": "all_enabled",
                    }
                ),
            )
            assert submitted.status_code == 202, submitted.text
            run_id = submitted.json()["runId"]
            completed = await client.get(f"/api/v1/runs/{run_id}")
            assert completed.status_code == 200, completed.text
            return completed.json()

    try:
        result = asyncio.run(submit_and_read())
    finally:
        app.state.run_service = previous_service
        store.close()

    assert result["snapshot"]["config"]["shared"]["run"]["endDate"] == "2026-09-28"
    strategy = next(
        item
        for item in result["result"]["strategyRuns"]
        if item["id"] == "live-yahoo-qqq-vix-fixed"
    )
    assert strategy["status"] == "completed", strategy.get("diagnostics")
    vix_signals = [
        item for item in strategy["signals"] if item["signalId"] == "vix.buy"
    ]
    assert vix_signals
    assert any(item.get("observedValue") is not None for item in vix_signals)
    assert strategy["dailyAssets"]
    assert all(
        all(
            asset.get(field) is not None
            for field in ("simulationOpen", "simulationHigh", "simulationLow")
        )
        for asset in strategy["dailyAssets"]
    )

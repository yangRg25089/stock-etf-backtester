"""Live Yahoo acceptance for the default QQQ + VIX run path."""

from __future__ import annotations

import asyncio
import csv
import io
from concurrent.futures import Executor, Future
from datetime import date
from decimal import Decimal
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


def test_live_repeated_trend_trades_save_first_use_principal_and_csv(tmp_path) -> None:
    previous_service = app.state.run_service
    path = tmp_path / "principal.sqlite3"
    store = SQLiteRunStore(path)
    restored_store = None
    app.state.run_service = RunManager(
        store=store, data_provider=YahooRunDataProvider(), executor=_InlineExecutor()
    )

    async def run_and_export():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://principal-live"
        ) as client:
            response = await client.post(
                "/api/v1/runs",
                headers={"Idempotency-Key": "principal-round-trip"},
                json={
                    "draft": {
                        "shared": {
                            "run": {
                                "symbol": "QQQ",
                                "startDate": "2024-01-01",
                                "endDate": "2024-03-01",
                            },
                            "contribution": {"day": 1, "amount": 100},
                        },
                        "strategies": [
                            {
                                "id": "round-trip",
                                "presetId": "ma_trend",
                                "params": {"ma.period": 2},
                            }
                        ],
                    },
                    "scope": "all_enabled",
                },
            )
            assert response.status_code == 202, response.text
            accepted = response.json()
            return (await client.get(f"/api/v1/runs/{accepted['runId']}")).json()

    try:
        saved = asyncio.run(run_and_export())
        result = next(
            row for row in saved["result"]["strategyRuns"] if row["id"] == "round-trip"
        )
        assert result["status"] == "completed", result["diagnostics"]
        buys = [trade for trade in result["trades"] if trade["side"] == "buy"]
        sells = [trade for trade in result["trades"] if trade["side"] == "sell"]
        assert len(buys) > 2 and len(sells) > 1
        metrics = result["metrics"]
        assert sum(Decimal(trade["cashAmount"]) for trade in buys) > Decimal(
            metrics["totalContributed"]
        )
        assert (
            0
            < Decimal(metrics["actualInvested"])
            <= Decimal(metrics["totalContributed"])
        )
        assert metrics["investmentBasis"] == "original_principal"
        for asset in result["dailyAssets"]:
            assert Decimal(asset["actualInvested"]) <= Decimal(
                asset["totalContributed"]
            )
            assert Decimal(asset["totalAsset"]) == Decimal(asset["cash"]) + (
                Decimal(asset["timingQuantity"]) + Decimal(asset["fixedQuantity"])
            ) * Decimal(asset["simulationPrice"])
        assert Decimal(metrics["netProfit"]) == Decimal(
            metrics["endingEquity"]
        ) - Decimal(metrics["totalContributed"])
        store.close()
        restored_store = SQLiteRunStore(path)
        app.state.run_service = RunManager(
            store=restored_store, executor=_InlineExecutor()
        )

        async def read_saved():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://principal-restored",
            ) as client:
                response = await client.get(f"/api/v1/runs/{saved['runId']}")
                assert response.json() == saved
                exports = {}
                for kind in ("summary", "daily-assets"):
                    csv_response = await client.get(
                        f"/api/v1/runs/{saved['runId']}/export/{kind}",
                        params={"focusedResultId": "round-trip"},
                    )
                    assert csv_response.status_code == 200
                    exports[kind] = list(csv.DictReader(io.StringIO(csv_response.text)))
                return exports

        exports = asyncio.run(read_saved())
        assert (
            Decimal(exports["daily-assets"][-1]["actualInvested"])
            == Decimal(exports["summary"][0]["actualInvested"])
            == Decimal(metrics["actualInvested"])
        )
        assert exports["summary"][0]["investmentBasis"] == "original_principal"
    finally:
        app.state.run_service = previous_service
        store.close()
        if restored_store is not None:
            restored_store.close()


def test_live_fixed_custom_and_indicator_rules_share_results_and_restore(
    tmp_path,
) -> None:
    previous_service = app.state.run_service
    path = tmp_path / "live-conditions.sqlite3"
    store = SQLiteRunStore(path)
    provider = YahooRunDataProvider()
    app.state.run_service = RunManager(
        store=store, data_provider=provider, executor=_InlineExecutor()
    )
    vix = {
        "type": "condition",
        "id": "buy-vix",
        "kind": "vix",
        "enabled": True,
        "params": {"vix.symbol": "^VIX", "vix.buyThreshold": 25},
    }
    strategies = [
        {"id": "fixed", "presetId": "vix_dca", "enabled": True},
        {
            "id": "custom",
            "presetId": "composite_dca",
            "enabled": True,
            "params": {
                "accumulation.maxSignalBuysPerMonth": 1,
            },
            "rules": {"buy": vix, "sell": None},
        },
        {"id": "rsi", "presetId": "rsi_dca", "enabled": True},
        {"id": "trend", "presetId": "ma_trend", "enabled": True},
    ]

    async def run_and_read():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://live-rules"
        ) as client:
            submitted = await client.post(
                "/api/v1/runs",
                headers={"Idempotency-Key": "real-condition-trees"},
                json={
                    "draft": {
                        "shared": {
                            "run": {
                                "symbol": "QQQ",
                                "startDate": "2024-01-01",
                                "endDate": "2024-03-28",
                                "endMode": "fixed",
                            }
                        },
                        "strategies": strategies,
                    },
                    "scope": "all_enabled",
                },
            )
            assert submitted.status_code == 202, submitted.text
            response = await client.get(f"/api/v1/runs/{submitted.json()['runId']}")
            assert response.status_code == 200, response.text
            return response.json()

    try:
        saved = asyncio.run(run_and_read())
        store.close()
        restored_store = SQLiteRunStore(path)
        app.state.run_service = RunManager(
            store=restored_store, data_provider=provider, executor=_InlineExecutor()
        )

        async def restore():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://restored-rules"
            ) as client:
                response = await client.get(f"/api/v1/runs/{saved['runId']}")
                assert response.status_code == 200
                exports = {}
                for kind in ("summary", "daily-assets", "trades"):
                    exported = await client.get(
                        f"/api/v1/runs/{saved['runId']}/export/{kind}",
                        params={"focusedResultId": "custom"},
                    )
                    assert exported.status_code == 200, exported.text
                    exports[kind] = exported.text
                return response.json(), exports

        restored, exports = asyncio.run(restore())
        assert saved == restored
        rows = {item["id"]: item for item in saved["result"]["strategyRuns"]}
        assert saved["snapshot"]["dataProvenance"]["sources"] == ["yahoo"]
        for strategy in strategies:
            row = rows[strategy["id"]]
            assert row["status"] == "completed", row.get("diagnostics")
            assert row["metrics"]["totalContributed"] == "300"
            assert len(row["dailyAssets"]) >= 60
            assert all(item["state"] != "unavailable" for item in row["signals"])
            buy_total = sum(
                (
                    Decimal(trade["cashAmount"])
                    for trade in row["trades"]
                    if trade["side"] == "buy"
                ),
                Decimal("0"),
            )
            assert Decimal(row["metrics"]["actualInvested"]) == buy_total
        assert rows["fixed"]["dailyAssets"] == rows["custom"]["dailyAssets"]
        assert rows["fixed"]["trades"] == rows["custom"]["trades"]
        assert rows["fixed"]["metrics"] == rows["custom"]["metrics"]
        saved_buy = saved["snapshot"]["config"]["strategies"][1]["rules"]["buy"]
        assert saved_buy["id"] == vix["id"]
        assert saved_buy["kind"] == vix["kind"]
        assert Decimal(saved_buy["params"]["vix.buyThreshold"]) == 25
        exported_assets = list(csv.DictReader(io.StringIO(exports["daily-assets"])))
        assert len(exported_assets) == len(rows["custom"]["dailyAssets"])
        assert Decimal(exported_assets[-1]["totalAsset"]) == Decimal(
            rows["custom"]["dailyAssets"][-1]["totalAsset"]
        )
        exported_summary = next(csv.DictReader(io.StringIO(exports["summary"])))
        assert Decimal(exported_summary["actualInvested"]) == Decimal(
            rows["custom"]["metrics"]["actualInvested"]
        )
        assert Decimal(exported_assets[-1]["actualInvested"]) == Decimal(
            exported_summary["actualInvested"]
        )
    finally:
        app.state.run_service = previous_service
        store.close()
        if "restored_store" in locals():
            restored_store.close()


def test_live_qqq_volatility_index_runs_use_real_yahoo_observations(tmp_path) -> None:
    previous_service = app.state.run_service
    store = SQLiteRunStore(tmp_path / "live-yahoo-runs.sqlite3")
    app.state.run_service = RunManager(
        store=store,
        data_provider=YahooRunDataProvider(),
        executor=_InlineExecutor(),
    )

    selected_end = date.today().isoformat()

    async def submit_and_read(symbol: str) -> dict[str, Any]:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://live-yahoo-test"
        ) as client:
            submitted = await client.post(
                "/api/v1/runs",
                headers={"Idempotency-Key": f"live-yahoo-qqq-{symbol}"},
                json={
                    "draft": {
                        "shared": {
                            "run": {
                                "symbol": "QQQ",
                                "startDate": "2020-01-01",
                                "endDate": selected_end,
                            },
                            "contribution": {"day": 1, "amount": 100},
                        },
                        "strategies": [
                            {
                                "id": "volatility",
                                "presetId": "vix_dca",
                                "params": {"vix.symbol": symbol},
                            }
                        ],
                    },
                    "scope": "all_enabled",
                },
            )
            assert submitted.status_code == 202, submitted.text
            completed = await client.get(f"/api/v1/runs/{submitted.json()['runId']}")
            assert completed.status_code == 200, completed.text
            return completed.json()

    try:
        results = [
            asyncio.run(submit_and_read(symbol)) for symbol in ("^VIX", "^VXN", "^VXD")
        ]
    finally:
        app.state.run_service = previous_service
        store.close()

    for result in results:
        snapshot = result["snapshot"]
        assert snapshot["dataProvenance"]["sources"] == ["yahoo"]
        assert snapshot["config"]["shared"]["run"]["endDate"] == selected_end
        strategy = next(
            item
            for item in result["result"]["strategyRuns"]
            if item["id"] == "volatility"
        )
        assert strategy["status"] in {"completed", "completed_with_warning"}, (
            strategy.get("diagnostics")
        )
        assert all(
            item["severity"] == "warning" for item in strategy.get("diagnostics", [])
        )
        assert all(
            item["messageKey"] != "market.latest_quote_delayed"
            for item in strategy.get("diagnostics", [])
        )
        assert (
            strategy["dailyAssets"][-1]["date"]
            == snapshot["dataProvenance"]["marketDataThrough"]
        )
        assert strategy["dailyAssets"][-1]["date"] <= selected_end
        assert "relativeToDca" not in strategy["metrics"]
        signals = [
            item for item in strategy["signals"] if item["signalId"] == "vix.buy"
        ]
        assert signals
        assert all(item["state"] != "unavailable" for item in signals)
        assert any(item.get("observedValue") is not None for item in signals)


def test_live_fixed_qqq_vix_run_matches_the_reported_date_range(tmp_path) -> None:
    previous_service = app.state.run_service
    store_path = tmp_path / "live-yahoo-fixed-runs.sqlite3"
    store = SQLiteRunStore(store_path)
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

    reopened_store = SQLiteRunStore(store_path)
    app.state.run_service = RunManager(
        store=reopened_store,
        data_provider=YahooRunDataProvider(),
        executor=_InlineExecutor(),
    )

    async def restore_and_export() -> tuple[dict[str, Any], dict[str, Any], str, str]:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://live-yahoo-restored-test",
        ) as client:
            run_id = result["runId"]
            restored = await client.get(f"/api/v1/runs/{run_id}")
            latest = await client.get("/api/v1/runs/latest")
            summary = await client.get(
                f"/api/v1/runs/{run_id}/export/summary",
                params={"focusedResultId": "live-yahoo-qqq-vix-fixed"},
            )
            daily_assets = await client.get(
                f"/api/v1/runs/{run_id}/export/daily-assets",
                params={"focusedResultId": "live-yahoo-qqq-vix-fixed"},
            )
            assert restored.status_code == 200, restored.text
            assert latest.status_code == 200, latest.text
            assert summary.status_code == 200, summary.text
            assert daily_assets.status_code == 200, daily_assets.text
            return restored.json(), latest.json(), summary.text, daily_assets.text

    try:
        restored, latest, summary_csv, daily_assets_csv = asyncio.run(
            restore_and_export()
        )
    finally:
        app.state.run_service = previous_service
        reopened_store.close()

    assert result["snapshot"]["config"]["shared"]["run"]["endDate"] == "2026-09-28"
    assert restored == result
    assert latest == result
    summary_row = next(csv.DictReader(io.StringIO(summary_csv)))
    assert summary_row["runId"] == result["runId"]
    assert summary_row["resultId"] == "live-yahoo-qqq-vix-fixed"
    assert summary_row["symbol"] == "QQQ"
    assert summary_row["endDate"] == "2026-09-28"
    daily_asset_rows = list(csv.DictReader(io.StringIO(daily_assets_csv)))
    assert len(daily_asset_rows) > 1000
    assert all(row["runId"] == result["runId"] for row in daily_asset_rows)
    assert all(
        row["resultId"] == "live-yahoo-qqq-vix-fixed" for row in daily_asset_rows
    )
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

    runs = result["result"]["strategyRuns"]
    monthly = next(item for item in runs if item["presetId"] == "monthly_dca")
    upfront = next(item for item in runs if item["presetId"] == "lump_sum")
    monthly_by_date = {item["date"]: item for item in monthly["dailyAssets"]}
    plan_by_date = {
        item["date"]: Decimal(item["cashAmount"]) for item in monthly["trades"]
    }
    budget = Decimal(monthly["metrics"]["totalContributed"])
    assert monthly["status"] == "completed"
    assert upfront["status"] == "completed"
    for saved_strategy in (strategy, monthly, upfront):
        cumulative = Decimal("0")
        first_price = Decimal(saved_strategy["dailyAssets"][0]["simulationPrice"])
        distinct_return_seen = False
        for asset in saved_strategy["dailyAssets"]:
            cumulative += plan_by_date.get(asset["date"], Decimal("0"))
            expected_principal = budget if saved_strategy is upfront else cumulative
            principal = Decimal(asset["totalContributed"])
            equity = Decimal(asset["totalAsset"])
            price = Decimal(asset["simulationPrice"])
            assert principal == expected_principal
            assert price == Decimal(monthly_by_date[asset["date"]]["simulationPrice"])
            valued_equity = Decimal(asset["cash"]) + price * (
                Decimal(asset["timingQuantity"]) + Decimal(asset["fixedQuantity"])
            )
            assert abs(equity - valued_equity) < Decimal("1e-20")
            if principal > 0:
                invested_index = equity / principal * 100
                price_index = price / first_price * 100
                if saved_strategy is upfront:
                    assert abs(invested_index - price_index) < Decimal("1e-20")
                elif abs(invested_index - price_index) > Decimal("1e-6"):
                    distinct_return_seen = True
        if saved_strategy is not upfront:
            assert distinct_return_seen, (
                "Monthly funding returns must differ from upfront price returns"
            )
        assert Decimal(saved_strategy["dailyAssets"][-1]["totalContributed"]) == budget
        assert Decimal(
            saved_strategy["dailyAssets"][-1]["totalAsset"]
        ) / budget == Decimal(saved_strategy["metrics"]["capitalMultiple"])
    assert [row["totalContributed"] for row in daily_asset_rows] == [
        asset["totalContributed"] for asset in strategy["dailyAssets"]
    ]


def test_live_instrument_metadata_resolves_real_usd_and_jpy_quotes():
    provider = YahooRunDataProvider()
    for symbol, currency in (("QQQ", "USD"), ("7203.T", "JPY")):
        metadata = provider.instrument_metadata(symbol)
        assert metadata.symbol == symbol
        assert metadata.currency == currency, metadata.diagnostics
        assert not metadata.diagnostics


def test_live_user_grid_values_freeze_trades_curves_and_csv_after_reopen(tmp_path):
    previous_service = app.state.run_service
    path = tmp_path / "user-grid.sqlite3"
    store = SQLiteRunStore(path)
    reopened = None
    app.state.run_service = RunManager(
        store=store, data_provider=YahooRunDataProvider(), executor=_InlineExecutor()
    )

    async def run_grid():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://grid-live"
        ) as client:
            accepted = await client.post(
                "/api/v1/runs",
                headers={"Idempotency-Key": "user-grid-live"},
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
                                "id": "user-grid",
                                "presetId": "grid_search",
                                "params": {
                                    "search.dimensions": ["vix.buyThreshold"],
                                    "search.values.vix.buyThreshold": [0, 200],
                                    "search.maxCombinations": 2,
                                    "rsi.buyEnabled": False,
                                    "ma.buyEnabled": False,
                                    "bollinger.buyEnabled": False,
                                    "rate.buyEnabled": False,
                                    "pe.buyEnabled": False,
                                    "accumulation.cashSafetyLimit": 100000000,
                                    "accumulation.maxSignalBuysPerMonth": None,
                                },
                            }
                        ],
                    },
                    "scope": "all_enabled",
                },
            )
            assert accepted.status_code == 202, accepted.text
            response = await client.get(f"/api/v1/runs/{accepted.json()['runId']}")
            assert response.status_code == 200, response.text
            return response.json()

    try:
        saved = asyncio.run(run_grid())
        assert saved["snapshot"]["dataProvenance"]["sources"] == ["yahoo"]
        assert saved["snapshot"]["config"]["strategies"][0]["params"][
            "search.values.vix.buyThreshold"
        ] == [0, 200]
        grid = next(
            row for row in saved["result"]["strategyRuns"] if row["id"] == "user-grid"
        )
        assert grid["status"] == "completed", grid["diagnostics"]
        search = grid["searchResult"]
        assert search["totalCandidateCount"] == 2
        assert search["dimensions"][0]["values"] == [0, 200]
        assert [
            Decimal(row["metrics"]["actualInvested"]) for row in search["candidates"]
        ] == [200, 0]
        assert all(
            Decimal(row["metrics"]["totalContributed"]) == 200
            for row in search["candidates"]
        )
        store.close()
        reopened = SQLiteRunStore(path)
        # Reopening uses no supplier: the curves and CSV must come from saved results.
        app.state.run_service = RunManager(store=reopened, executor=_InlineExecutor())

        async def read_saved():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://grid-restored"
            ) as client:
                restored = await client.get(f"/api/v1/runs/{saved['runId']}")
                assert restored.json() == saved
                exported = await client.get(
                    f"/api/v1/runs/{saved['runId']}/export/search-results",
                    params={"focusedResultId": "user-grid"},
                )
                assert exported.status_code == 200, exported.text
                rows = list(csv.DictReader(io.StringIO(exported.text)))
                assert [Decimal(row["vix.buyThreshold"]) for row in rows] == [0, 200]
                assert [Decimal(row["actualInvested"]) for row in rows] == [200, 0]
                for candidate in search["candidates"]:
                    response = await client.get(
                        f"/api/v1/runs/{saved['runId']}/candidates/{candidate['candidateId']}"
                    )
                    assert response.status_code == 200, response.text
                    detail = response.json()
                    assert detail["metrics"] == candidate["metrics"]
                    assert detail["dailyAssets"]
                    assert Decimal(
                        detail["dailyAssets"][-1]["actualInvested"]
                    ) == Decimal(candidate["metrics"]["actualInvested"])
                    signals = [
                        signal
                        for signal in detail["signals"]
                        if signal["signalId"] == "vix.buy"
                    ]
                    assert signals and all(
                        0 < Decimal(signal["observedValue"]) < 200 for signal in signals
                    )

        asyncio.run(read_saved())
    finally:
        app.state.run_service = previous_service
        store.close()
        if reopened is not None:
            reopened.close()

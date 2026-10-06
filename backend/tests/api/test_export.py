import asyncio
import csv
import io
from collections.abc import Callable, Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import httpx
from fastapi.encoders import jsonable_encoder

from app.calendar import ExchangeCalendar
from app.config.validation import DataRequirement
from app.domain.contracts import (
    DailyAsset,
    DataSnapshot,
    FrozenStrategyInstance,
    MacroObservation,
    MarketBar,
    MarketSnapshot,
    MetricSummary,
    ResultRole,
    RunResult,
    RunSnapshot,
    StrategyPresetId,
    StrategyRun,
)
from app.domain.status import StrategyStatus
from app.main import app
from app.runs.data import StrategyDataLoad
from app.runs.manager import RunManager
from app.runs.store import InMemoryRunStore
from app.runs.types import RunProgress, RunResponse


class _SavedRunService:
    def get_candidate(self, run_id, candidate_id):
        return None

    def __init__(self, run: RunResponse) -> None:
        self.run = run

    def get_run(self, run_id: str) -> RunResponse | None:
        return self.run if run_id == self.run.run_id else None


class _ImmediateExecutor:
    def submit(
        self, function: Callable[..., object], /, *args: object, **kwargs: object
    ) -> object:
        return function(*args, **kwargs)


class _PipelineDataProvider:
    version = "api-export-fixture-v1"

    def __init__(self) -> None:
        days = (date(2024, 1, 2), date(2024, 1, 3))
        self.calendar = ExchangeCalendar.from_dates(
            days,
            as_of_date=days[-1],
            latest_complete_date=days[-1],
            calendar_coverage_end_date=days[-1],
        )
        bars = tuple(
            MarketBar(
                date=day,
                symbol="QQQ",
                simulationPrice=Decimal("100"),
                currency="USD",
                source="fixture",
                observedAt=datetime.combine(day, datetime.min.time(), UTC),
            )
            for day in days
        )
        macro = tuple(
            MacroObservation(
                date=day - timedelta(days=1),
                symbol="^VIX",
                value=Decimal("10"),
                unit="index_points",
                source="fixture",
                observedAt=datetime.combine(
                    day - timedelta(days=1), datetime.min.time(), UTC
                ),
                alignedSessionDate=day,
            )
            for day in days
        )
        self.snapshot = DataSnapshot(
            market=MarketSnapshot(
                symbol="QQQ",
                currency="USD",
                bars=bars,
                source="fixture",
                fingerprint="api-export-market-v1",
            ),
            macro=macro,
            fingerprint="api-export-data-v1",
        )

    def load_for_strategy(
        self,
        *,
        shared: object,
        strategy: FrozenStrategyInstance,
        requirements: Sequence[DataRequirement],
    ) -> StrategyDataLoad:
        del shared, strategy, requirements
        return StrategyDataLoad(calendar=self.calendar, snapshot=self.snapshot)


def _run_response() -> RunResponse:
    validation_config = {
        "shared": {
            "run": {
                "symbol": "QQQ",
                "startDate": date(2024, 1, 2),
                "endDate": date(2024, 1, 3),
                "endMode": "fixed",
            },
            "contribution": {"day": 2, "amount": Decimal("100")},
        },
        "strategies": [
            {
                "id": "saved-result",
                "presetId": "monthly_dca",
                "enabled": True,
                "params": {},
            }
        ],
    }
    from app.config.validation import validate_draft

    validated = validate_draft(validation_config)
    config = validated.config_for(("saved-result",))
    assert config is not None
    metrics = MetricSummary(
        actualInvested=Decimal("100"),
        totalContributed=Decimal("100"),
        endingEquity=Decimal("101.25"),
        netProfit=Decimal("1.25"),
        returnOnContributions=Decimal("0.0125"),
        capitalMultiple=Decimal("1.0125"),
        maximumDrawdown=Decimal("0"),
        currency="USD",
    )
    result = RunResult(
        runId="run-api",
        strategyRuns=[
            StrategyRun(
                id="saved-result",
                presetId=StrategyPresetId.MONTHLY_DCA,
                role=ResultRole.STRATEGY,
                status=StrategyStatus.COMPLETED,
                dailyAssets=(
                    DailyAsset(
                        date=date(2024, 1, 2),
                        cash=Decimal("0"),
                        timingQuantity=Decimal("0"),
                        fixedQuantity=Decimal("1"),
                        simulationPrice=Decimal("101.25"),
                        totalAsset=Decimal("101.25"),
                        currency="USD",
                    ),
                ),
                metrics=metrics,
            )
        ],
    )
    snapshot = RunSnapshot(
        runId="run-api",
        config=config,
        catalogVersion="catalog-v1",
        dataFingerprint="fixture-fingerprint",
        engineVersion="engine-v1",
    )
    return RunResponse(
        runId="run-api",
        status=StrategyStatus.COMPLETED,
        selectedStrategyIds=("saved-result",),
        progress=RunProgress(completedStrategies=3, totalStrategies=3),
        snapshot=snapshot,
        result=result,
    )


def _request(
    path: str,
    *,
    run: RunResponse | None = None,
) -> httpx.Response:
    async def send() -> httpx.Response:
        previous = getattr(app.state, "run_service", None)
        had_previous = hasattr(app.state, "run_service")
        if run is not None:
            app.state.run_service = _SavedRunService(run)
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(
                transport=transport, base_url="http://test"
            ) as client:
                return await client.get(path)
        finally:
            if run is not None:
                if had_previous:
                    app.state.run_service = previous
                elif hasattr(app.state, "run_service"):
                    del app.state.run_service

    return asyncio.run(send())


def test_summary_export_matches_the_saved_run_api_result() -> None:
    run = _run_response()

    result_response = _request(f"/api/v1/runs/{run.run_id}", run=run)
    export_response = _request(
        f"/api/v1/runs/{run.run_id}/export/summary?focusedResultId=saved-result",
        run=run,
    )

    assert result_response.status_code == 200
    assert export_response.status_code == 200
    assert export_response.headers["content-type"].startswith("text/csv")
    assert "saved-result-summary.csv" in export_response.headers["content-disposition"]
    row = next(csv.DictReader(io.StringIO(export_response.text)))
    saved_result = result_response.json()["result"]["strategyRuns"][0]
    assert row["runId"] == result_response.json()["runId"]
    assert row["resultId"] == saved_result["id"]
    assert row["endingEquity"] == saved_result["metrics"]["endingEquity"]
    assert row["currency"] == saved_result["metrics"]["currency"]


def test_csv_content_is_independent_of_ui_locale() -> None:
    run = _run_response()
    japanese = _request(
        f"/api/v1/runs/{run.run_id}/export/summary"
        "?focusedResultId=saved-result&locale=ja",
        run=run,
    )
    chinese = _request(
        f"/api/v1/runs/{run.run_id}/export/summary"
        "?focusedResultId=saved-result&locale=zh",
        run=run,
    )

    assert japanese.status_code == chinese.status_code == 200
    assert japanese.content == chinese.content


def test_export_endpoint_returns_zero_trade_header_and_explicit_errors() -> None:
    run = _run_response()
    trade_export = _request(
        f"/api/v1/runs/{run.run_id}/export/trades?focusedResultId=saved-result",
        run=run,
    )
    missing_run = _request(
        "/api/v1/runs/missing/export/summary?focusedResultId=saved-result",
        run=run,
    )
    missing_focus = _request(
        f"/api/v1/runs/{run.run_id}/export/summary?focusedResultId=missing",
        run=run,
    )

    assert trade_export.status_code == 200
    assert trade_export.text.splitlines() == [
        "runId,resultId,date,side,reason,quantity,price,cashAmount,currency,"
        "signalId,dataSources,calendarAsOf,marketDataThrough,"
        "cashBefore,cashAfter,quantityBefore,quantityAfter,executionBasePrice,executionPrice,grossAmount,commission,slippageCost,spreadCost,capitalGainsTax,totalTradingCost"
    ]
    assert missing_run.status_code == 404
    assert missing_run.json()["error"]["code"] == "run_not_found"
    assert missing_focus.status_code == 404
    assert missing_focus.json()["error"]["code"] == "focused_result_not_found"


def test_export_endpoint_rejects_a_result_without_completed_metrics() -> None:
    run = _run_response()
    queued_result = run.result.strategy_runs[0].model_copy(
        update={"status": StrategyStatus.RUNNING, "metrics": None}
    )
    incomplete = run.model_copy(
        update={
            "status": StrategyStatus.RUNNING,
            "result": RunResult(runId=run.run_id, strategyRuns=(queued_result,)),
        }
    )

    response = _request(
        f"/api/v1/runs/{run.run_id}/export/summary?focusedResultId=saved-result",
        run=incomplete,
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "result_not_exportable"


def test_export_endpoint_documents_csv_and_structured_error_responses() -> None:
    response = _request("/openapi.json")
    operation = response.json()["paths"]["/api/v1/runs/{run_id}/export/{kind}"]["get"]

    assert operation["responses"]["200"]["content"]["text/csv"]["schema"] == {
        "type": "string"
    }
    assert operation["responses"]["404"]["content"]["application/json"]["schema"][
        "$ref"
    ].endswith("/APIErrorResponse")
    assert operation["responses"]["409"]["content"]["application/json"]["schema"][
        "$ref"
    ].endswith("/APIErrorResponse")


def test_submit_query_focus_and_export_work_as_one_api_flow() -> None:
    manager = RunManager(
        store=InMemoryRunStore(),
        data_provider=_PipelineDataProvider(),
        executor=_ImmediateExecutor(),  # type: ignore[arg-type]
    )

    async def exercise_flow() -> tuple[httpx.Response, httpx.Response, httpx.Response]:
        previous = getattr(app.state, "run_service", None)
        had_previous = hasattr(app.state, "run_service")
        app.state.run_service = manager
        transport = httpx.ASGITransport(app=app)
        draft = {
            "shared": {
                "run": {
                    "symbol": "QQQ",
                    "startDate": "2024-01-02",
                    "endDate": "2024-01-03",
                    "endMode": "fixed",
                },
                "contribution": {"day": 2, "amount": 100},
            },
            "strategies": [
                {
                    "id": "api-pipeline-vix",
                    "presetId": "vix_dca",
                    "enabled": True,
                    "params": {},
                }
            ],
        }
        try:
            async with httpx.AsyncClient(
                transport=transport, base_url="http://test"
            ) as client:
                submitted = await client.post(
                    "/api/v1/runs",
                    headers={"Idempotency-Key": "api-pipeline-key"},
                    json=jsonable_encoder(
                        {
                            "draft": draft,
                            "scope": "active",
                            "activeStrategyId": "api-pipeline-vix",
                        }
                    ),
                )
                run_id = submitted.json()["runId"]
                queried = await client.get(f"/api/v1/runs/{run_id}")
                exported = await client.get(
                    f"/api/v1/runs/{run_id}/export/summary",
                    params={"focusedResultId": "api-pipeline-vix"},
                )
                return submitted, queried, exported
        finally:
            if had_previous:
                app.state.run_service = previous
            elif hasattr(app.state, "run_service"):
                del app.state.run_service

    submitted, queried, exported = asyncio.run(exercise_flow())

    assert submitted.status_code == 202
    assert submitted.json()["status"] == "queued"
    assert queried.status_code == 200
    assert queried.json()["status"] == "completed"
    assert queried.json()["result"]["strategyRuns"][0]["id"] == "api-pipeline-vix"
    assert exported.status_code == 200
    row = next(csv.DictReader(io.StringIO(exported.text)))
    assert row["runId"] == queried.json()["runId"]
    assert row["resultId"] == "api-pipeline-vix"
    assert (
        row["endingEquity"]
        == queried.json()["result"]["strategyRuns"][0]["metrics"]["endingEquity"]
    )

import csv
import io
import json
from datetime import date
from decimal import Decimal

import pytest

from app.domain.contracts import (
    DailyAsset,
    FrozenRunConfig,
    FrozenStrategyInstance,
    MetricSummary,
    ResultRole,
    RunDataProvenance,
    RunResult,
    RunSettings,
    RunSnapshot,
    SearchCandidate,
    SearchResult,
    SharedSettings,
    StrategyPresetId,
    StrategyRun,
    Trade,
    TradeReason,
    TradeSide,
)
from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    DiagnosticSeverity,
    StrategyStatus,
)
from app.export.csv import ExportError, ExportKind, export_csv
from app.runs.types import RunProgress, RunResponse


def _summary() -> MetricSummary:
    return MetricSummary(
        totalContributed=Decimal("100.00"),
        endingEquity=Decimal("109.123456789"),
        netProfit=Decimal("9.123456789"),
        returnOnContributions=Decimal("0.09123456789"),
        capitalMultiple=Decimal("1.09123456789"),
        maximumDrawdown=Decimal("0.123400"),
        relativeToDca=Decimal("-1.234"),
        currency="USD",
    )


def _diagnostic() -> Diagnostic:
    return Diagnostic(
        code=DiagnosticCode.STALE_DATA,
        severity=DiagnosticSeverity.WARNING,
        messageKey="data.stale",
        fieldPath="run.endDate",
        details={"requestedEndDate": "2024-01-31"},
    )


def _response(*, trades: tuple[Trade, ...] = ()) -> RunResponse:
    summary = _summary()
    ordinary = FrozenStrategyInstance(
        id="ordinary",
        presetId=StrategyPresetId.MONTHLY_DCA,
        enabled=True,
        params={},
    )
    grid = FrozenStrategyInstance(
        id="grid-search",
        presetId=StrategyPresetId.GRID_SEARCH,
        enabled=True,
        params={"search.dimensions": ["vix.buyThreshold"]},
    )
    config = FrozenRunConfig(
        shared=SharedSettings(
            run=RunSettings(
                symbol="QQQ",
                startDate=date(2024, 1, 2),
                endDate=date(2024, 1, 4),
                endMode="fixed",
            ),
            contribution={"day": 2, "amount": Decimal("100")},
            data={
                "macroStalenessSessions": 3,
                "financialFactMaxAgeDays": 550,
                "etfHoldingsMaxAgeDays": 180,
            },
        ),
        strategies=(ordinary, grid),
    )
    candidate_metrics = summary.model_copy(update={"relative_to_dca": Decimal("0")})
    search = SearchResult(
        strategyId="grid-search",
        dimensions=[
            {
                "key": "vix.buyThreshold",
                "values": [Decimal("25"), Decimal("30")],
            }
        ],
        totalCandidateCount=2,
        candidates=[
            SearchCandidate(
                candidateId="grid-search:candidate:00001",
                sequence=1,
                status=StrategyStatus.COMPLETED,
                calculationFingerprint="candidate-fingerprint-1",
                parameterValues={
                    "vix.buyThreshold": Decimal("25"),
                    "accumulation.cashSafetyLimit": Decimal("1200"),
                },
                metrics=candidate_metrics,
            ),
            SearchCandidate(
                candidateId="grid-search:candidate:00002",
                sequence=2,
                status=StrategyStatus.FAILED,
                calculationFingerprint="candidate-fingerprint-2",
                parameterValues={
                    "vix.buyThreshold": Decimal("30"),
                    "accumulation.cashSafetyLimit": Decimal("1200"),
                },
                diagnostics=(
                    Diagnostic(
                        code=DiagnosticCode.INVALID_PARAMETER,
                        messageKey="diagnostics.configuration.invalid_parameter",
                        fieldPath="search.dimensions.vix.buyThreshold",
                    ),
                ),
            ),
        ],
        rankedCandidateIds=["grid-search:candidate:00001"],
    )
    result = RunResult(
        runId="run-123",
        strategyRuns=[
            StrategyRun(
                id="ordinary",
                presetId=StrategyPresetId.MONTHLY_DCA,
                role=ResultRole.STRATEGY,
                status=StrategyStatus.COMPLETED_WITH_WARNING,
                diagnostics=(_diagnostic(),),
                trades=trades,
                dailyAssets=(
                    DailyAsset(
                        date=date(2024, 1, 2),
                        cash=Decimal("10.00"),
                        timingQuantity=Decimal("1.5"),
                        fixedQuantity=Decimal("2"),
                        simulationPrice=Decimal("3.123456789"),
                        totalAsset=Decimal("20.1851851835"),
                        totalContributed=Decimal("19.87654321"),
                        currency="USD",
                        unitNav=Decimal("1.2345"),
                        drawdown=Decimal("-0.01"),
                    ),
                ),
                metrics=summary,
            ),
            StrategyRun(
                id="grid-search",
                presetId=StrategyPresetId.GRID_SEARCH,
                role=ResultRole.STRATEGY,
                status=StrategyStatus.COMPLETED_WITH_WARNING,
                diagnostics=(
                    Diagnostic(
                        code=DiagnosticCode.INVALID_PARAMETER,
                        messageKey="diagnostics.search.invalid_candidate",
                        fieldPath="strategies[1].params.search.dimensions",
                    ),
                ),
                metrics=candidate_metrics,
                searchResult=search,
            ),
        ],
    )
    snapshot = RunSnapshot(
        runId="run-123",
        config=config,
        catalogVersion="catalog-v1",
        dataFingerprint="data-fingerprint-v1",
        engineVersion="engine-v1",
        dataProvenance=RunDataProvenance(
            sources=("sec:companyfacts", "yahoo"),
            calendarAsOf=date(2024, 1, 4),
            marketDataThrough=date(2024, 1, 4),
        ),
    )
    return RunResponse(
        runId="run-123",
        status=result.status,
        selectedStrategyIds=("ordinary", "grid-search"),
        progress=RunProgress(completedStrategies=4, totalStrategies=4),
        snapshot=snapshot,
        result=result,
    )


def _rows(content: str) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(content)))


def test_summary_export_is_bound_to_run_and_focused_result() -> None:
    content = export_csv(
        _response(), kind=ExportKind.SUMMARY, focused_result_id="ordinary"
    )
    rows = _rows(content)

    assert content.splitlines()[0] == (
        "runId,resultId,role,presetId,status,symbol,startDate,endDate,"
        "totalContributed,endingEquity,netProfit,returnOnContributions,"
        "capitalMultiple,xirr,maximumDrawdown,relativeToDca,currency,diagnostics,"
        "dataSources,calendarAsOf,marketDataThrough"
    )
    assert rows == [
        {
            "runId": "run-123",
            "resultId": "ordinary",
            "role": "strategy",
            "presetId": "monthly_dca",
            "status": "completed_with_warning",
            "symbol": "QQQ",
            "startDate": "2024-01-02",
            "endDate": "2024-01-04",
            "totalContributed": "100.00",
            "endingEquity": "109.123456789",
            "netProfit": "9.123456789",
            "returnOnContributions": "0.09123456789",
            "capitalMultiple": "1.09123456789",
            "xirr": "",
            "maximumDrawdown": "0.123400",
            "relativeToDca": "-1.234",
            "currency": "USD",
            "dataSources": '["sec:companyfacts","yahoo"]',
            "calendarAsOf": "2024-01-04",
            "marketDataThrough": "2024-01-04",
            "diagnostics": json.dumps(
                [
                    {
                        "asOf": None,
                        "code": "stale_data",
                        "details": {"requestedEndDate": "2024-01-31"},
                        "fieldPath": "run.endDate",
                        "messageKey": "data.stale",
                        "severity": "warning",
                        "source": None,
                    }
                ],
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ),
        }
    ]


def test_daily_assets_export_preserves_iso_dates_precision_and_currency() -> None:
    content = export_csv(
        _response(), kind=ExportKind.DAILY_ASSETS, focused_result_id="ordinary"
    )

    assert content == (
        "runId,resultId,date,cash,timingQuantity,fixedQuantity,simulationPrice,"
        "totalAsset,currency,unitNav,drawdown,dataSources,calendarAsOf,"
        "marketDataThrough,totalContributed\n"
        "run-123,ordinary,2024-01-02,10.00,1.5,2,3.123456789,20.1851851835,"
        'USD,1.2345,-0.01,"[""sec:companyfacts"",""yahoo""]",2024-01-04,'
        "2024-01-04,19.87654321\n"
    )


def test_successful_zero_trade_export_still_contains_a_header() -> None:
    content = export_csv(
        _response(), kind=ExportKind.TRADES, focused_result_id="ordinary"
    )

    assert content == (
        "runId,resultId,date,side,reason,quantity,price,cashAmount,currency,"
        "signalId,dataSources,calendarAsOf,marketDataThrough\n"
    )


def test_trade_export_writes_stable_fields_without_rounding() -> None:
    trade = Trade(
        date=date(2024, 1, 3),
        side=TradeSide.BUY,
        reason=TradeReason.SIGNAL_BUY,
        quantity=Decimal("0.123456789"),
        price=Decimal("81.00000001"),
        cashAmount=Decimal("10.00000000"),
        currency="USD",
        signalId="vix.buy",
    )

    content = export_csv(
        _response(trades=(trade,)),
        kind=ExportKind.TRADES,
        focused_result_id="ordinary",
    )

    assert content == (
        "runId,resultId,date,side,reason,quantity,price,cashAmount,currency,"
        "signalId,dataSources,calendarAsOf,marketDataThrough\n"
        "run-123,ordinary,2024-01-03,buy,signal_buy,0.123456789,81.00000001,"
        '10.00000000,USD,vix.buy,"[""sec:companyfacts"",""yahoo""]",'
        "2024-01-04,2024-01-04\n"
    )


def test_search_export_includes_all_candidates_and_stable_parameter_keys() -> None:
    content = export_csv(
        _response(), kind=ExportKind.SEARCH_RESULTS, focused_result_id="grid-search"
    )
    rows = _rows(content)

    assert content.splitlines()[0] == (
        "runId,resultId,role,presetId,candidateId,sequence,status,"
        "calculationFingerprint,reusedCalculation,vix.buyThreshold,"
        "accumulation.cashSafetyLimit,"
        "totalContributed,endingEquity,netProfit,returnOnContributions,"
        "capitalMultiple,xirr,maximumDrawdown,relativeToDca,currency,diagnostics"
        ",dataSources,calendarAsOf,marketDataThrough"
    )
    assert [row["candidateId"] for row in rows] == [
        "grid-search:candidate:00001",
        "grid-search:candidate:00002",
    ]
    assert [row["vix.buyThreshold"] for row in rows] == ["25", "30"]
    assert [row["accumulation.cashSafetyLimit"] for row in rows] == ["1200", "1200"]
    assert rows[0]["endingEquity"] == "109.123456789"
    assert rows[0]["reusedCalculation"] == "false"
    assert rows[0]["dataSources"] == '["sec:companyfacts","yahoo"]'
    assert rows[0]["calendarAsOf"] == "2024-01-04"
    assert rows[0]["marketDataThrough"] == "2024-01-04"
    candidate_diagnostics = json.loads(rows[1]["diagnostics"])
    assert candidate_diagnostics[0]["code"] == "invalid_parameter"
    assert candidate_diagnostics[0]["messageKey"] == (
        "diagnostics.configuration.invalid_parameter"
    )
    assert candidate_diagnostics[0]["fieldPath"] == (
        "search.dimensions.vix.buyThreshold"
    )


def test_export_rejects_missing_incomplete_and_inapplicable_results() -> None:
    queued = _response().model_copy(update={"result": None})
    incomplete = _response().model_copy(
        update={
            "result": RunResult(
                runId="run-123",
                strategyRuns=(
                    StrategyRun(
                        id="pending",
                        presetId=StrategyPresetId.MONTHLY_DCA,
                        role=ResultRole.STRATEGY,
                        status=StrategyStatus.RUNNING,
                    ),
                ),
            )
        }
    )

    with pytest.raises(ExportError) as missing_result:
        export_csv(queued, kind=ExportKind.SUMMARY, focused_result_id="ordinary")
    with pytest.raises(ExportError) as missing_focus:
        export_csv(_response(), kind=ExportKind.SUMMARY, focused_result_id="not-found")
    with pytest.raises(ExportError) as running_result:
        export_csv(incomplete, kind=ExportKind.SUMMARY, focused_result_id="pending")
    with pytest.raises(ExportError) as wrong_kind:
        export_csv(
            _response(), kind=ExportKind.SEARCH_RESULTS, focused_result_id="ordinary"
        )

    assert missing_result.value.code == "result_not_exportable"
    assert missing_focus.value.code == "focused_result_not_found"
    assert running_result.value.code == "result_not_exportable"
    assert wrong_kind.value.code == "search_results_unavailable"

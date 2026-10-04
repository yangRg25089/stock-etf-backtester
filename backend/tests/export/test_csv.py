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
from app.domain.execution import TradingCosts
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
        actualInvested=Decimal("100.00"),
        totalContributed=Decimal("100.00"),
        endingEquity=Decimal("109.123456789"),
        netProfit=Decimal("9.123456789"),
        returnOnContributions=Decimal("0.09123456789"),
        capitalMultiple=Decimal("1.09123456789"),
        maximumDrawdown=Decimal("0.123400"),
        relativeToDca=Decimal("-1.234"),
        currency="USD",
    )


def test_saved_costs_have_the_same_decimal_columns_in_all_exports() -> None:
    costs = TradingCosts.from_components(
        Decimal("2.123456789"), Decimal("1"), Decimal("0.5")
    )
    response = _response()
    ordinary = response.result.strategy_runs[0]
    ordinary = ordinary.model_copy(
        update={
            "metrics": ordinary.metrics.model_copy(update={"trading_costs": costs}),
            "daily_assets": tuple(
                row.model_copy(update={"trading_costs": costs})
                for row in ordinary.daily_assets
            ),
        }
    )
    response = response.model_copy(
        update={
            "result": response.result.model_copy(
                update={"strategy_runs": (ordinary, *response.result.strategy_runs[1:])}
            )
        }
    )
    for kind in (ExportKind.SUMMARY, ExportKind.DAILY_ASSETS):
        row = _rows(export_csv(response, kind=kind, focused_result_id=ordinary.id))[0]
        assert row["commission"] == "2.123456789"
        assert row["slippageCost"] == "1"
        assert row["spreadCost"] == "0.5"
        assert row["totalTradingCost"] == "3.623456789"


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
    candidate_metrics = summary
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


EXPECTED_COST_FIELDS = ("commission", "slippageCost", "spreadCost", "totalTradingCost")


EXPECTED_ANALYSIS_FIELDS = (
    "analysisMethod",
    "tradingDaysPerYear",
    "durationUnit",
    "riskFreeAnnualRate",
    "annualizedReturn",
    "annualizedVolatility",
    "sharpeRatio",
    "sortinoRatio",
    "calmarRatio",
    "maximumDrawdownDuration",
    "recoveryDuration",
    "buyCount",
    "sellCount",
    "turnover",
    "averageCashRatio",
    "unavailableReasons",
    "annualReturns",
    "monthlyReturns",
    "drawdownEpisodes",
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
        "actualInvested,totalContributed,endingEquity,netProfit,returnOnContributions,"
        "capitalMultiple,xirr,maximumDrawdown,currency,diagnostics,"
        "dataSources,calendarAsOf,marketDataThrough,investmentBasis,"
        + ",".join((*EXPECTED_ANALYSIS_FIELDS, *EXPECTED_COST_FIELDS))
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
            "actualInvested": "100.00",
            "investmentBasis": "buy_turnover",
            **dict.fromkeys((*EXPECTED_ANALYSIS_FIELDS, *EXPECTED_COST_FIELDS), ""),
            "totalContributed": "100.00",
            "endingEquity": "109.123456789",
            "netProfit": "9.123456789",
            "returnOnContributions": "0.09123456789",
            "capitalMultiple": "1.09123456789",
            "xirr": "",
            "maximumDrawdown": "0.123400",
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
        "marketDataThrough,totalContributed,actualInvested,investmentBasis,commission,slippageCost,spreadCost,totalTradingCost\n"
        "run-123,ordinary,2024-01-02,10.00,1.5,2,3.123456789,20.1851851835,"
        'USD,1.2345,-0.01,"[""sec:companyfacts"",""yahoo""]",2024-01-04,'
        "2024-01-04,19.87654321,,buy_turnover,,,,\n"
    )


def test_legacy_daily_assets_export_does_not_recalculate_missing_principal() -> None:
    trade = Trade(
        date=date(2024, 1, 2),
        side=TradeSide.BUY,
        reason=TradeReason.SIGNAL_BUY,
        quantity=Decimal("1"),
        price=Decimal("10"),
        cashAmount=Decimal("10"),
        currency="USD",
    )

    content = export_csv(
        _response(trades=(trade,)),
        kind=ExportKind.DAILY_ASSETS,
        focused_result_id="ordinary",
    )

    row = _rows(content)[0]
    assert row["totalContributed"] == "19.87654321"
    assert row["actualInvested"] == ""
    assert row["investmentBasis"] == "buy_turnover"


def test_daily_assets_export_reads_saved_principal_without_recounting_trades() -> None:
    run = _response()
    result = run.result.strategy_runs[0]
    assert result.metrics is not None
    result = result.model_copy(
        update={
            "metrics": result.metrics.model_copy(
                update={
                    "investment_basis": "original_principal",
                    "actual_invested": Decimal("12.34"),
                }
            ),
            "daily_assets": tuple(
                asset.model_copy(update={"actual_invested": Decimal("12.34")})
                for asset in result.daily_assets
            ),
        }
    )
    run = run.model_copy(
        update={"result": run.result.model_copy(update={"strategy_runs": (result,)})}
    )
    daily = _rows(
        export_csv(run, kind=ExportKind.DAILY_ASSETS, focused_result_id=result.id)
    )[0]
    summary = _rows(
        export_csv(run, kind=ExportKind.SUMMARY, focused_result_id=result.id)
    )[0]
    assert daily["actualInvested"] == summary["actualInvested"] == "12.34"
    assert (
        daily["investmentBasis"] == summary["investmentBasis"] == "original_principal"
    )


def test_successful_zero_trade_export_still_contains_a_header() -> None:
    content = export_csv(
        _response(), kind=ExportKind.TRADES, focused_result_id="ordinary"
    )

    assert content == (
        "runId,resultId,date,side,reason,quantity,price,cashAmount,currency,"
        "signalId,dataSources,calendarAsOf,marketDataThrough,"
        "cashBefore,cashAfter,quantityBefore,quantityAfter,executionBasePrice,executionPrice,grossAmount,commission,slippageCost,spreadCost,totalTradingCost\n"
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
        "signalId,dataSources,calendarAsOf,marketDataThrough,"
        "cashBefore,cashAfter,quantityBefore,quantityAfter,executionBasePrice,executionPrice,grossAmount,commission,slippageCost,spreadCost,totalTradingCost\n"
        "run-123,ordinary,2024-01-03,buy,signal_buy,0.123456789,81.00000001,"
        '10.00000000,USD,vix.buy,"[""sec:companyfacts"",""yahoo""]",'
        "2024-01-04,2024-01-04,,,,,,,,,,,\n"
    )


def test_trade_export_reads_exact_saved_explanation_fields() -> None:
    trade = Trade(
        date="2024-01-03",
        side="buy",
        reason="signal_buy",
        quantity="1.25",
        price="80.000001",
        cashAmount="100.00000125",
        currency="USD",
        cashBefore="100.00000125",
        cashAfter="0",
        quantityBefore="2",
        quantityAfter="3.25",
        executionBasePrice="80.000001",
        executionPrice="80.000001",
    )
    exported = export_csv(
        _response(trades=(trade,)), kind=ExportKind.TRADES, focused_result_id="ordinary"
    )
    row = next(csv.DictReader(io.StringIO(exported)))
    for key in (
        "cashBefore",
        "cashAfter",
        "quantityBefore",
        "quantityAfter",
        "executionBasePrice",
        "executionPrice",
    ):
        assert row[key] == trade.model_dump(mode="json", by_alias=True)[key]


def test_search_export_includes_all_candidates_and_stable_parameter_keys() -> None:
    content = export_csv(
        _response(), kind=ExportKind.SEARCH_RESULTS, focused_result_id="grid-search"
    )
    rows = _rows(content)

    assert content.splitlines()[0] == (
        "runId,resultId,role,presetId,candidateId,sequence,status,"
        "calculationFingerprint,reusedCalculation,vix.buyThreshold,"
        "accumulation.cashSafetyLimit,"
        "actualInvested,totalContributed,endingEquity,netProfit,returnOnContributions,"
        "capitalMultiple,xirr,maximumDrawdown,currency,investmentBasis,"
        + ",".join((*EXPECTED_ANALYSIS_FIELDS, *EXPECTED_COST_FIELDS))
        + ",diagnostics,dataSources,calendarAsOf,marketDataThrough"
        + ",optimizationMode,trainStartDate,trainEndDate,testStartDate,testEndDate,"
        "testResultId,testStatus,testDiagnostics,"
        + ",".join(
            f"test{key[0].upper()}{key[1:]}"
            for key in (
                "actualInvested",
                "totalContributed",
                "endingEquity",
                "netProfit",
                "returnOnContributions",
                "capitalMultiple",
                "xirr",
                "maximumDrawdown",
                "currency",
                "investmentBasis",
                *EXPECTED_ANALYSIS_FIELDS,
                *EXPECTED_COST_FIELDS,
            )
        )
        + ",walkForwardWindow,selectedForTesting,outOfSampleResultId,outOfSampleStatus,"
        "outOfSampleStartDate,outOfSampleEndDate,outOfSampleDiagnostics,"
        + ",".join(
            f"outOfSample{key[0].upper()}{key[1:]}"
            for key in (
                "actualInvested",
                "totalContributed",
                "endingEquity",
                "netProfit",
                "returnOnContributions",
                "capitalMultiple",
                "xirr",
                "maximumDrawdown",
                "currency",
                "investmentBasis",
                *EXPECTED_ANALYSIS_FIELDS,
                *EXPECTED_COST_FIELDS,
            )
        )
    )
    assert [row["candidateId"] for row in rows] == [
        "grid-search:candidate:00001",
        "grid-search:candidate:00002",
    ]
    assert [row["vix.buyThreshold"] for row in rows] == ["25", "30"]
    assert [row["accumulation.cashSafetyLimit"] for row in rows] == ["1200", "1200"]
    assert rows[0]["endingEquity"] == "109.123456789"
    assert rows[0]["reusedCalculation"] == "false"
    assert rows[0]["optimizationMode"] == "full_period"
    assert rows[0]["testXirr"] == rows[0]["testStatus"] == ""
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


def test_search_array_parameters_use_json_instead_of_python_representations() -> None:
    run = _response()
    assert run.result is not None
    focused = run.result.strategy_runs[1]
    assert focused.search_result is not None
    candidates = tuple(
        item.model_copy(
            update={
                "parameter_values": {
                    **item.parameter_values,
                    "search.dimensions": ("vix.buyThreshold",),
                    "search.values.vix.buyThreshold": (
                        Decimal("25.00"),
                        Decimal("3E-7"),
                    ),
                }
            }
        )
        for item in focused.search_result.candidates
    )
    focused = focused.model_copy(
        update={
            "search_result": focused.search_result.model_copy(
                update={"candidates": candidates}
            )
        }
    )
    run = run.model_copy(
        update={"result": run.result.model_copy(update={"strategy_runs": (focused,)})}
    )
    rows = _rows(
        export_csv(run, kind=ExportKind.SEARCH_RESULTS, focused_result_id=focused.id)
    )
    assert json.loads(rows[0]["search.dimensions"]) == ["vix.buyThreshold"]
    assert json.loads(rows[0]["search.values.vix.buyThreshold"]) == ["25.00", "3E-7"]


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

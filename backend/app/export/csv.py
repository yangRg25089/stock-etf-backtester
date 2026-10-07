"""CSV documents rendered only from immutable run and result snapshots."""

from __future__ import annotations

import csv
import json
from collections.abc import Iterable, Mapping, Sequence
from datetime import date
from decimal import Decimal
from enum import StrEnum
from io import StringIO
from typing import get_args

from app.catalog.definitions import ParameterType
from app.catalog.service import get_catalog
from app.domain.contracts import (
    DailyAsset,
    MetricSummary,
    SearchResult,
    StrategyRun,
    Trade,
)
from app.domain.execution import TradingCosts
from app.domain.performance import PerformanceAnalysis
from app.domain.status import Diagnostic, StrategyStatus
from app.runs.types import RunResponse


class ExportKind(StrEnum):
    SUMMARY = "summary"
    DAILY_ASSETS = "daily-assets"
    TRADES = "trades"
    SEARCH_RESULTS = "search-results"


class ExportError(ValueError):
    """A saved result cannot satisfy the requested export."""

    def __init__(self, code: str, message_key: str, status_code: int) -> None:
        super().__init__(message_key)
        self.code = code
        self.message_key = message_key
        self.status_code = status_code


_ANALYSIS_FIELDS = tuple(
    field.alias or name for name, field in PerformanceAnalysis.model_fields.items()
)
_COST_FIELDS = tuple(
    field.alias or name for name, field in TradingCosts.model_fields.items()
)
_SUMMARY_FIELDS = (
    "runId",
    "resultId",
    "role",
    "presetId",
    "status",
    "symbol",
    "startDate",
    "endDate",
    "actualInvested",
    "totalContributed",
    "endingEquity",
    "netProfit",
    "returnOnContributions",
    "capitalMultiple",
    "xirr",
    "maximumDrawdown",
    "currency",
    "diagnostics",
    "dataSources",
    "calendarAsOf",
    "marketDataThrough",
    "investmentBasis",
    *_ANALYSIS_FIELDS,
    *_COST_FIELDS,
)
_DAILY_ASSET_FIELDS = (
    "runId",
    "resultId",
    "date",
    "cash",
    "timingQuantity",
    "fixedQuantity",
    "simulationPrice",
    "totalAsset",
    "currency",
    "unitNav",
    "drawdown",
    "dataSources",
    "calendarAsOf",
    "marketDataThrough",
    "totalContributed",
    "actualInvested",
    "investmentBasis",
    *_COST_FIELDS,
)
_TRADE_FIELDS = (
    "runId",
    "resultId",
    "date",
    "side",
    "reason",
    "quantity",
    "price",
    "cashAmount",
    "currency",
    "signalId",
    "dataSources",
    "calendarAsOf",
    "marketDataThrough",
    "cashBefore",
    "cashAfter",
    "quantityBefore",
    "quantityAfter",
    "executionBasePrice",
    "executionPrice",
    "grossAmount",
    *_COST_FIELDS,
    "totalAssetAfter",
)
_SEARCH_FIELDS = (
    "runId",
    "resultId",
    "role",
    "presetId",
    "candidateId",
    "sequence",
    "status",
    "calculationFingerprint",
    "reusedCalculation",
)
_DATA_PROVENANCE_FIELDS = ("dataSources", "calendarAsOf", "marketDataThrough")
_METRIC_FIELDS = (
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
    *_ANALYSIS_FIELDS,
    *_COST_FIELDS,
)
_TEST_METRIC_FIELDS = tuple(f"test{key[0].upper()}{key[1:]}" for key in _METRIC_FIELDS)
_OOS_METRIC_FIELDS = tuple(
    f"outOfSample{key[0].upper()}{key[1:]}" for key in _METRIC_FIELDS
)
_SEARCH_EVALUATION_FIELDS = (
    "optimizationMode",
    "trainStartDate",
    "trainEndDate",
    "testStartDate",
    "testEndDate",
    "testResultId",
    "testStatus",
    "testDiagnostics",
    *_TEST_METRIC_FIELDS,
    "walkForwardWindow",
    "selectedForTesting",
    "outOfSampleResultId",
    "outOfSampleStatus",
    "outOfSampleStartDate",
    "outOfSampleEndDate",
    "outOfSampleDiagnostics",
    *_OOS_METRIC_FIELDS,
)


def csv_field_groups() -> dict[str, tuple[str, ...]]:
    """Field order shared by the API exporter and offline file viewer."""
    return {
        "summary": _SUMMARY_FIELDS,
        "daily-assets": _DAILY_ASSET_FIELDS,
        "trades": _TRADE_FIELDS,
        "search-results": _SEARCH_FIELDS,
        "metrics": _METRIC_FIELDS,
        "search-evaluation": _SEARCH_EVALUATION_FIELDS,
        "test-metrics": _TEST_METRIC_FIELDS,
        "out-of-sample-metrics": _OOS_METRIC_FIELDS,
        "analysis": _ANALYSIS_FIELDS,
        "trading-costs": _COST_FIELDS,
        "provenance": _DATA_PROVENANCE_FIELDS,
        "decimal": tuple(
            sorted(
                {
                    field.alias or name
                    for model in (
                        MetricSummary,
                        DailyAsset,
                        Trade,
                        PerformanceAnalysis,
                        TradingCosts,
                    )
                    for name, field in model.model_fields.items()
                    if field.annotation is Decimal
                    or Decimal in get_args(field.annotation)
                }
            )
        ),
        "numeric-parameters": tuple(
            definition.key
            for definition in get_catalog().parameters
            if definition.type
            in {
                ParameterType.INTEGER,
                ParameterType.DECIMAL,
                ParameterType.RATIO,
                ParameterType.PERCENT_POINT,
            }
        ),
    }


def export_csv(
    run: RunResponse,
    *,
    kind: ExportKind,
    focused_result_id: str,
) -> str:
    """Render one CSV using only the selected result in the stored run."""

    if run.result is None:
        raise ExportError(
            "result_not_exportable",
            "api.errors.result_not_exportable",
            409,
        )
    focused = next(
        (item for item in run.result.strategy_runs if item.id == focused_result_id),
        None,
    )
    if focused is None:
        raise ExportError(
            "focused_result_not_found",
            "api.errors.focused_result_not_found",
            404,
        )
    if (
        focused.status
        not in {
            StrategyStatus.COMPLETED,
            StrategyStatus.COMPLETED_WITH_WARNING,
        }
        or focused.metrics is None
    ):
        raise ExportError(
            "result_not_exportable",
            "api.errors.result_not_exportable",
            409,
        )

    if kind is ExportKind.SUMMARY:
        return _summary_csv(run, focused)
    if kind is ExportKind.DAILY_ASSETS:
        return _daily_assets_csv(run, focused)
    if kind is ExportKind.TRADES:
        return _trades_csv(run, focused)
    if focused.search_result is None:
        raise ExportError(
            "search_results_unavailable",
            "api.errors.search_results_unavailable",
            409,
        )
    return _search_csv(run, focused, focused.search_result)


def _summary_csv(run: RunResponse, focused: StrategyRun) -> str:
    metrics = _require_metrics(focused)
    config = run.snapshot.effective_config
    row = {
        "runId": run.run_id,
        "resultId": focused.id,
        "role": focused.role,
        "presetId": focused.preset_id,
        "status": focused.status,
        "symbol": config.shared.run.symbol,
        "startDate": focused.evaluation_period.start_date
        if focused.evaluation_period
        else config.shared.run.start_date,
        "endDate": focused.evaluation_period.end_date
        if focused.evaluation_period
        else config.shared.run.end_date,
        **_metric_values(metrics),
        "diagnostics": _diagnostic_json(focused.diagnostics),
        **_provenance_values(run),
    }
    return _render(_SUMMARY_FIELDS, (row[field] for field in _SUMMARY_FIELDS))


def _daily_assets_csv(run: RunResponse, focused: StrategyRun) -> str:
    rows: list[dict[str, object]] = []
    for asset in focused.daily_assets:
        rows.append(
            {
                "runId": run.run_id,
                "resultId": focused.id,
                "date": asset.date,
                "cash": asset.cash,
                "timingQuantity": asset.timing_quantity,
                "fixedQuantity": asset.fixed_quantity,
                "simulationPrice": asset.simulation_price,
                "totalAsset": asset.total_asset,
                "totalContributed": asset.total_contributed,
                "actualInvested": asset.actual_invested,
                "investmentBasis": focused.metrics.investment_basis
                if focused.metrics
                else None,
                "currency": asset.currency,
                "unitNav": asset.unit_nav,
                "drawdown": asset.drawdown,
                **_cost_values(asset.trading_costs),
                **_provenance_values(run),
            }
        )
    return _render_rows(_DAILY_ASSET_FIELDS, rows)


def _trades_csv(run: RunResponse, focused: StrategyRun) -> str:
    rows = (
        {
            "runId": run.run_id,
            "resultId": focused.id,
            "date": trade.date,
            "side": trade.side,
            "reason": trade.reason,
            "quantity": trade.quantity,
            "price": trade.price,
            "cashAmount": trade.cash_amount,
            "currency": trade.currency,
            "signalId": trade.signal_id,
            "cashBefore": trade.cash_before,
            "cashAfter": trade.cash_after,
            "quantityBefore": trade.quantity_before,
            "quantityAfter": trade.quantity_after,
            "executionBasePrice": trade.execution_base_price,
            "executionPrice": trade.execution_price,
            "grossAmount": trade.gross_amount,
            "totalAssetAfter": trade.total_asset_after,
            **_cost_values(trade.trading_costs),
            **_provenance_values(run),
        }
        for trade in focused.trades
    )
    return _render_rows(_TRADE_FIELDS, rows)


def _search_csv(
    run: RunResponse,
    focused: StrategyRun,
    search_result: SearchResult,
) -> str:
    dimension_fields = tuple(dimension.key for dimension in search_result.dimensions)
    parameter_fields = tuple(
        sorted(
            {
                key
                for candidate in search_result.candidates
                for key in candidate.parameter_values
            }.difference(dimension_fields)
        )
    )
    parameter_fields = (*dimension_fields, *parameter_fields)
    fields = (
        *_SEARCH_FIELDS,
        *parameter_fields,
        *_METRIC_FIELDS,
        "diagnostics",
        *_DATA_PROVENANCE_FIELDS,
        *_SEARCH_EVALUATION_FIELDS,
    )
    rows: list[dict[str, object]] = []
    for candidate in search_result.candidates:
        metrics = candidate.metrics
        window = next(
            (
                item
                for item in search_result.walk_forward_windows
                if candidate.candidate_id in item.candidate_ids
            ),
            None,
        )
        train_period = window.train_period if window else search_result.train_period
        test_period = window.test_period if window else search_result.test_period
        oos = search_result.out_of_sample
        oos_metrics = _metric_values(oos.metrics if oos else None)
        testing_metrics = _metric_values(
            candidate.test_result.metrics if candidate.test_result else None
        )
        row: dict[str, object] = {
            "runId": run.run_id,
            "resultId": focused.id,
            "role": candidate.role,
            "presetId": focused.preset_id,
            "candidateId": candidate.candidate_id,
            "sequence": candidate.sequence,
            "status": candidate.status,
            "calculationFingerprint": candidate.calculation_fingerprint,
            "reusedCalculation": candidate.reused_calculation,
            **_metric_values(metrics),
            "diagnostics": _diagnostic_json(candidate.diagnostics),
            **_provenance_values(run),
            "optimizationMode": search_result.optimization_mode,
            "trainStartDate": train_period.start_date if train_period else None,
            "trainEndDate": train_period.end_date if train_period else None,
            "testStartDate": test_period.start_date if test_period else None,
            "testEndDate": test_period.end_date if test_period else None,
            "testResultId": candidate.test_result.result_id
            if candidate.test_result
            else None,
            "testStatus": candidate.test_result.status
            if candidate.test_result
            else None,
            "testDiagnostics": _diagnostic_json(candidate.test_result.diagnostics)
            if candidate.test_result
            else None,
            **{
                target: testing_metrics[key]
                for key, target in zip(_METRIC_FIELDS, _TEST_METRIC_FIELDS, strict=True)
            },
            "walkForwardWindow": window.sequence if window else None,
            "selectedForTesting": candidate.candidate_id == window.selected_candidate_id
            if window
            else None,
            "outOfSampleResultId": oos.result_id if oos else None,
            "outOfSampleStatus": oos.status if oos else None,
            "outOfSampleStartDate": search_result.out_of_sample_period.start_date
            if search_result.out_of_sample_period
            else None,
            "outOfSampleEndDate": search_result.out_of_sample_period.end_date
            if search_result.out_of_sample_period
            else None,
            "outOfSampleDiagnostics": _diagnostic_json(oos.diagnostics)
            if oos
            else None,
            **{
                target: oos_metrics[key]
                for key, target in zip(_METRIC_FIELDS, _OOS_METRIC_FIELDS, strict=True)
            },
        }
        row.update(
            {
                dimension_field: candidate.parameter_values.get(dimension_field)
                for dimension_field in parameter_fields
            }
        )
        rows.append(row)
    return _render_rows(fields, rows)


def _provenance_values(run: RunResponse) -> dict[str, object]:
    provenance = run.snapshot.data_provenance
    return {
        "dataSources": json.dumps(
            provenance.sources,
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        "calendarAsOf": provenance.calendar_as_of,
        "marketDataThrough": provenance.market_data_through,
    }


def _cost_values(costs: TradingCosts | None) -> dict[str, object]:
    return (
        costs.model_dump(by_alias=True)
        if costs is not None
        else dict.fromkeys(_COST_FIELDS)
    )


def _metric_values(metrics: MetricSummary | None) -> dict[str, object]:
    if metrics is None:
        return {field: None for field in _METRIC_FIELDS}
    return {
        "totalContributed": metrics.total_contributed,
        **_cost_values(metrics.trading_costs),
        "actualInvested": metrics.actual_invested,
        "investmentBasis": metrics.investment_basis,
        "endingEquity": metrics.ending_equity,
        "netProfit": metrics.net_profit,
        "returnOnContributions": metrics.return_on_contributions,
        "capitalMultiple": metrics.capital_multiple,
        "xirr": metrics.xirr,
        "maximumDrawdown": metrics.maximum_drawdown,
        "currency": metrics.currency,
        **(
            metrics.analysis.model_dump(by_alias=True)
            if metrics.analysis
            else dict.fromkeys(_ANALYSIS_FIELDS)
        ),
    }


def _require_metrics(focused: StrategyRun) -> MetricSummary:
    if focused.metrics is None:
        raise ExportError(
            "result_not_exportable",
            "api.errors.result_not_exportable",
            409,
        )
    return focused.metrics


def _diagnostic_json(diagnostics: Sequence[Diagnostic]) -> str:
    return json.dumps(
        [
            diagnostic.model_dump(mode="json", by_alias=True)
            for diagnostic in diagnostics
        ],
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _render(fields: Sequence[str], values: Iterable[object]) -> str:
    output = StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(fields)
    writer.writerow(tuple(_csv_value(value) for value in values))
    return output.getvalue()


def _render_rows(fields: Sequence[str], rows: Iterable[Mapping[str, object]]) -> str:
    output = StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(fields)
    for row in rows:
        writer.writerow(_csv_value(row.get(field)) for field in fields)
    return output.getvalue()


def _csv_value(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, (bool, StrEnum)):
        return str(value.value if isinstance(value, StrEnum) else value).lower()
    if isinstance(value, (Mapping, tuple, list)):
        return json.dumps(
            _json_value(value),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    return str(value)


def _json_value(value: object) -> object:
    """Match the saved JSON representation for structured parameter values."""
    if isinstance(value, Mapping):
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_json_value(item) for item in value]
    if isinstance(value, (Decimal, date, StrEnum)):
        return str(value.value) if isinstance(value, StrEnum) else str(value)
    return value

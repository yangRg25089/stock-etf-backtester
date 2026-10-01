"""CSV documents rendered only from immutable run and result snapshots."""

from __future__ import annotations

import csv
import json
from collections.abc import Iterable, Mapping, Sequence
from datetime import date
from decimal import Decimal
from enum import StrEnum
from io import StringIO

from app.domain.contracts import MetricSummary, SearchResult, StrategyRun
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
)


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
    config = run.snapshot.config
    row = {
        "runId": run.run_id,
        "resultId": focused.id,
        "role": focused.role,
        "presetId": focused.preset_id,
        "status": focused.status,
        "symbol": config.shared.run.symbol,
        "startDate": config.shared.run.start_date,
        "endDate": config.shared.run.end_date,
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
    )
    rows: list[dict[str, object]] = []
    for candidate in search_result.candidates:
        metrics = candidate.metrics
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


def _metric_values(metrics: MetricSummary | None) -> dict[str, object]:
    if metrics is None:
        return {field: None for field in _METRIC_FIELDS}
    return {
        "totalContributed": metrics.total_contributed,
        "actualInvested": metrics.actual_invested,
        "investmentBasis": metrics.investment_basis,
        "endingEquity": metrics.ending_equity,
        "netProfit": metrics.net_profit,
        "returnOnContributions": metrics.return_on_contributions,
        "capitalMultiple": metrics.capital_multiple,
        "xirr": metrics.xirr,
        "maximumDrawdown": metrics.maximum_drawdown,
        "currency": metrics.currency,
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
    return str(value)

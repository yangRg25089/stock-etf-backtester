"""Explicit portable files derived only from an immutable runtime record."""

from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Literal

from pydantic import Field

from app.domain.contracts import (
    FrozenRunConfig,
    RunDataProvenance,
    SearchCandidate,
    SearchPeriod,
    SearchResult,
    SearchTestResult,
    StrategyRun,
)
from app.domain.status import DomainModel, StrategyStatus, is_terminal
from app.runs.types import RunResponse


class BacktestPackage(DomainModel):
    format: Literal["stock-etf-backtester"] = "stock-etf-backtester"
    schema_version: Literal[1] = Field(default=1, alias="schemaVersion")
    type: Literal["backtest"] = "backtest"
    exported_at: datetime = Field(alias="exportedAt")
    engine_version: str = Field(alias="engineVersion", min_length=1)
    catalog_version: str = Field(alias="catalogVersion", min_length=1)
    config: FrozenRunConfig
    result: RunResponse
    candidate_details: Mapping[str, StrategyRun] = Field(alias="candidateDetails")
    data_provenance: RunDataProvenance = Field(alias="dataProvenance")


def build_backtest_package(
    run: RunResponse, load_candidate: Callable[[str], StrategyRun | None]
) -> BacktestPackage:
    """Collect all candidates without a supplier request or recalculation."""
    if not is_terminal(run.status) or run.result is None:
        raise ValueError("cannot export an unfinished run")
    details: dict[str, StrategyRun] = {}
    for parent in run.result.strategy_runs:
        if parent.search_result is None:
            continue
        for identifier, outcome, period in _search_outcomes(parent.search_result):
            detail = load_candidate(identifier)
            if detail is None and outcome.status in {
                StrategyStatus.COMPLETED,
                StrategyStatus.COMPLETED_WITH_WARNING,
            }:
                raise ValueError("completed candidate detail is unavailable")
            if detail is None:
                detail = StrategyRun(
                    id=identifier,
                    presetId=parent.preset_id,
                    role=parent.role,
                    status=outcome.status,
                    metrics=outcome.metrics,
                    diagnostics=outcome.diagnostics,
                    evaluationPeriod=period,
                )
            details[identifier] = detail
    return BacktestPackage(
        exportedAt=datetime.now(UTC),
        engineVersion=run.snapshot.engine_version,
        catalogVersion=run.snapshot.catalog_version,
        config=run.snapshot.config,
        result=run,
        candidateDetails=details,
        dataProvenance=run.snapshot.data_provenance,
    )


def _search_outcomes(
    search: SearchResult,
) -> list[tuple[str, SearchCandidate | SearchTestResult, SearchPeriod | None]]:
    outcomes: list[
        tuple[str, SearchCandidate | SearchTestResult, SearchPeriod | None]
    ] = []
    for row in search.candidates:
        outcomes.append(
            (row.candidate_id, row, search.candidate_period(row.candidate_id))
        )
        if row.test_result is not None:
            identifier = row.test_result.result_id
            outcomes.append(
                (identifier, row.test_result, search.candidate_period(identifier))
            )
    if search.out_of_sample is not None:
        identifier = search.out_of_sample.result_id
        outcomes.append(
            (identifier, search.out_of_sample, search.candidate_period(identifier))
        )
    return outcomes

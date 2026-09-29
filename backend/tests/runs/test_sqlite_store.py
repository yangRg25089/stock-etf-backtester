from concurrent.futures import ThreadPoolExecutor
from datetime import date
from decimal import Decimal
from threading import Barrier

import pytest

from app.catalog.service import default_data_settings
from app.domain.contracts import (
    ContributionSettings,
    FrozenRunConfig,
    FrozenStrategyInstance,
    MetricSummary,
    RunResult,
    RunSettings,
    RunSnapshot,
    SharedSettings,
    StrategyRun,
)
from app.domain.status import Diagnostic, DiagnosticCode, StrategyStatus
from app.runs.sqlite_store import SQLiteRunStore
from app.runs.store import IdempotencyConflict, RunReservation
from app.runs.types import RunProgress, RunResponse


def _response(
    run_id: str = "run-persisted",
    statuses: tuple[StrategyStatus, ...] = (StrategyStatus.COMPLETED,),
) -> RunResponse:
    strategy_ids = tuple(f"strategy-{index}" for index in range(len(statuses)))
    config = FrozenRunConfig(
        shared=SharedSettings(
            run=RunSettings(
                symbol="QQQ",
                startDate=date(2024, 1, 1),
                endDate=date(2024, 1, 31),
                endMode="fixed",
            ),
            contribution=ContributionSettings(day=1, amount=Decimal("100")),
            data=default_data_settings(),
        ),
        strategies=tuple(
            FrozenStrategyInstance(
                id=strategy_id,
                presetId="vix_dca",
                enabled=True,
                params={"vix.buyThreshold": 25},
            )
            for strategy_id in strategy_ids
        ),
    )
    snapshot = RunSnapshot(
        runId=run_id,
        config=config,
        catalogVersion="catalog-v1",
        dataFingerprint="data-v1",
        engineVersion="engine-v1",
    )
    metrics = MetricSummary(
        totalContributed=Decimal("100"),
        endingEquity=Decimal("110"),
        netProfit=Decimal("10"),
        returnOnContributions=Decimal("0.1"),
        capitalMultiple=Decimal("1.1"),
        maximumDrawdown=Decimal("0"),
        currency="USD",
    )
    strategy_runs = tuple(
        StrategyRun(
            id=strategy_id,
            presetId="vix_dca",
            role="strategy",
            status=status,
            metrics=metrics if status is StrategyStatus.COMPLETED else None,
            diagnostics=(
                (
                    Diagnostic(
                        code=DiagnosticCode.CALCULATION_FAILED,
                        messageKey="diagnostics.calculation_failed",
                    ),
                )
                if status is StrategyStatus.FAILED
                else ()
            ),
        )
        for strategy_id, status in zip(strategy_ids, statuses, strict=True)
    )
    result = RunResult(runId=run_id, strategyRuns=strategy_runs)
    return RunResponse(
        runId=run_id,
        status=result.status,
        selectedStrategyIds=strategy_ids,
        progress=RunProgress(
            completedStrategies=sum(
                status
                in {
                    StrategyStatus.COMPLETED,
                    StrategyStatus.COMPLETED_WITH_WARNING,
                    StrategyStatus.UNAVAILABLE,
                    StrategyStatus.FAILED,
                }
                for status in statuses
            ),
            totalStrategies=len(statuses),
        ),
        snapshot=snapshot,
        result=result,
    )


def _reservation(store: SQLiteRunStore) -> RunReservation:
    return store.reserve("retry-key", "request-fingerprint")


def test_sqlite_store_restores_completed_results_and_idempotency_after_reopen(
    tmp_path,
) -> None:
    path = tmp_path / "runs.sqlite3"
    first = SQLiteRunStore(path)
    reservation = _reservation(first)
    first.publish(
        reservation,
        _response(reservation.run_id, (StrategyStatus.RUNNING,)),
    )
    saved = _response(reservation.run_id)
    first.update(saved)
    first.close()

    reopened = SQLiteRunStore(path)
    retry = _reservation(reopened)

    assert retry.owner is False
    assert retry.run_id == saved.run_id
    assert reopened.wait_for_record(retry) == saved
    assert reopened.get(saved.run_id) == saved
    assert reopened.get_latest() == saved
    with pytest.raises(IdempotencyConflict):
        reopened.reserve("retry-key", "different-fingerprint")
    reopened.close()


def test_sqlite_store_marks_interrupted_runs_failed_and_keeps_completed_strategies(
    tmp_path,
) -> None:
    path = tmp_path / "runs.sqlite3"
    first = SQLiteRunStore(path)
    reservation = first.reserve("interrupted-key", "request-fingerprint")
    first.publish(
        reservation,
        _response(
            reservation.run_id,
            (StrategyStatus.COMPLETED, StrategyStatus.RUNNING),
        ),
    )
    first.close()

    reopened = SQLiteRunStore(path)
    recovered = reopened.get(reservation.run_id)

    assert recovered is not None
    assert recovered.status is StrategyStatus.COMPLETED_WITH_WARNING
    assert recovered.result is not None
    assert recovered.result.strategy_runs[0].status is StrategyStatus.COMPLETED
    interrupted = recovered.result.strategy_runs[1]
    assert interrupted.status is StrategyStatus.FAILED
    assert interrupted.diagnostics[-1].message_key == "runs.interrupted_by_restart"
    assert recovered.progress is not None
    assert recovered.progress.completed_strategies == 2
    reopened.close()


def test_sqlite_store_discards_unaccepted_reservations_after_restart(tmp_path) -> None:
    path = tmp_path / "runs.sqlite3"
    first = SQLiteRunStore(path)
    abandoned = first.reserve("unaccepted-key", "request-fingerprint")
    first.close()

    reopened = SQLiteRunStore(path)
    retry = reopened.reserve("unaccepted-key", "request-fingerprint")

    assert retry.owner is True
    assert retry.run_id != abandoned.run_id
    reopened.abort(retry, RuntimeError("fixture acceptance failure"))
    reopened.close()


def test_sqlite_store_concurrent_retries_share_one_durable_reservation(
    tmp_path,
) -> None:
    store = SQLiteRunStore(tmp_path / "runs.sqlite3")
    barrier = Barrier(8)

    def reserve() -> tuple[str, bool]:
        barrier.wait()
        reservation = store.reserve("shared-key", "same-fingerprint")
        return reservation.run_id, reservation.owner

    with ThreadPoolExecutor(max_workers=8) as pool:
        reservations = tuple(pool.map(lambda _: reserve(), range(8)))

    assert len({run_id for run_id, _ in reservations}) == 1
    assert sum(owner for _, owner in reservations) == 1
    store.close()

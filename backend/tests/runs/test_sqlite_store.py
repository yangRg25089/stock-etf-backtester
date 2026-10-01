from concurrent.futures import ThreadPoolExecutor
from datetime import date
from decimal import Decimal
from threading import Barrier

import pytest

from app.catalog.service import CATALOG_VERSION, default_data_settings
from app.domain.conditions import ConditionGroup, ConditionLeaf, StrategyRules
from app.domain.contracts import (
    ContributionSettings,
    FrozenRunConfig,
    FrozenStrategyInstance,
    MetricSummary,
    RunResult,
    RunSettings,
    RunSnapshot,
    SharedSettings,
    StrategyPresetId,
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
        catalogVersion=CATALOG_VERSION,
        dataFingerprint="data-v1",
        engineVersion="engine-v1",
    )
    metrics = MetricSummary(
        totalContributed=Decimal("100"),
        actualInvested=Decimal("75.50"),
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


def test_sqlite_store_preserves_decimal_strategy_parameters_after_reopen(
    tmp_path,
) -> None:
    path = tmp_path / "runs.sqlite3"
    store = SQLiteRunStore(path)
    reservation = _reservation(store)
    response = _response(reservation.run_id)
    strategy = response.snapshot.config.strategies[0].model_copy(
        update={
            "params": {
                "vix.buyThreshold": Decimal("25.00"),
                "accumulation.maxSignalBuysPerMonth": 1,
                "vix.buyEnabled": True,
                "vix.symbol": "^VIX",
                "search.dimensions": (Decimal("24.50"), Decimal("25.00")),
            }
        }
    )
    config = response.snapshot.config.model_copy(update={"strategies": (strategy,)})
    snapshot = response.snapshot.model_copy(update={"config": config})
    response = response.model_copy(update={"snapshot": snapshot})
    store.publish(reservation, response)
    store.close()

    reopened = SQLiteRunStore(path)
    restored = reopened.get(reservation.run_id)

    assert restored is not None
    assert restored == response
    value = restored.snapshot.config.strategies[0].params["vix.buyThreshold"]
    assert value == Decimal("25.00")
    assert isinstance(value, Decimal)
    restored_params = restored.snapshot.config.strategies[0].params
    assert type(restored_params["accumulation.maxSignalBuysPerMonth"]) is int
    assert restored_params["vix.buyEnabled"] is True
    assert restored_params["vix.symbol"] == "^VIX"
    assert restored_params["search.dimensions"] == (Decimal("24.50"), Decimal("25.00"))
    assert (
        response.model_dump(mode="json", by_alias=True)["snapshot"]["config"][
            "strategies"
        ][0]["params"]["vix.buyThreshold"]
        == "25.00"
    )
    assert (
        restored.model_dump(mode="json", by_alias=True)["snapshot"]["config"][
            "strategies"
        ][0]["params"]["vix.buyThreshold"]
        == "25.00"
    )
    reopened.close()


def test_sqlite_store_preserves_independent_nested_condition_values(tmp_path) -> None:
    path = tmp_path / "conditions.sqlite3"
    store = SQLiteRunStore(path)
    reservation = _reservation(store)
    response = _response(reservation.run_id)
    rules = StrategyRules(
        buy=ConditionGroup(
            id="root",
            operator="OR",
            children=(
                ConditionLeaf(
                    id="vix-low",
                    kind="vix",
                    params={"vix.buyThreshold": Decimal("25.01")},
                ),
                ConditionLeaf(
                    id="vix-high",
                    kind="vix",
                    params={"vix.buyThreshold": Decimal("35.02")},
                ),
            ),
        )
    )
    strategy = response.snapshot.config.strategies[0].model_copy(
        update={"preset_id": StrategyPresetId.COMPOSITE_DCA, "rules": rules}
    )
    config = response.snapshot.config.model_copy(update={"strategies": (strategy,)})
    saved = response.model_copy(
        update={"snapshot": response.snapshot.model_copy(update={"config": config})}
    )
    store.publish(reservation, saved)
    store.close()
    reopened = SQLiteRunStore(path)
    restored = reopened.get(saved.run_id)
    assert restored == saved
    restored_rules = restored.snapshot.config.strategies[0].rules
    assert restored_rules is not None and isinstance(restored_rules.buy, ConditionGroup)
    low, high = restored_rules.buy.children
    assert isinstance(low, ConditionLeaf) and isinstance(high, ConditionLeaf)
    assert low.params["vix.buyThreshold"] == Decimal("25.01")
    assert high.params["vix.buyThreshold"] == Decimal("35.02")
    assert isinstance(low.params["vix.buyThreshold"], Decimal)
    reopened.close()


@pytest.mark.parametrize("catalog_version", ["catalog-v4", "catalog-v5"])
def test_sqlite_store_upgrades_legacy_json_decimal_parameters_on_read(
    tmp_path, catalog_version
) -> None:
    path = tmp_path / "runs.sqlite3"
    store = SQLiteRunStore(path)
    reservation = _reservation(store)
    response = _response(reservation.run_id)
    strategy = response.snapshot.config.strategies[0].model_copy(
        update={
            "params": {
                "vix.buyThreshold": Decimal("25.00"),
                "vix.symbol": "25",
            }
        }
    )
    config = response.snapshot.config.model_copy(update={"strategies": (strategy,)})
    snapshot = response.snapshot.model_copy(
        update={"config": config, "catalog_version": catalog_version}
    )
    response = response.model_copy(update={"snapshot": snapshot})
    store.publish(reservation, response)
    store._connection.execute(
        "UPDATE run_records SET response_json = ? WHERE run_id = ?",
        (response.model_dump_json(by_alias=True), reservation.run_id),
    )
    store.close()

    reopened = SQLiteRunStore(path)
    restored = reopened.get(reservation.run_id)

    assert restored is not None
    assert restored.snapshot.catalog_version == catalog_version
    value = restored.snapshot.config.strategies[0].params["vix.buyThreshold"]
    assert isinstance(value, Decimal)
    assert value == Decimal("25.00")
    assert restored.snapshot.config.strategies[0].params["vix.symbol"] == "25"
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

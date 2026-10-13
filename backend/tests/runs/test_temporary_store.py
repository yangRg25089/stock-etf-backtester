"""Disk payloads preserve snapshots, limits, retries and terminal notifications."""

from concurrent.futures import ThreadPoolExecutor
from datetime import date
from decimal import Decimal
from threading import Barrier

import pytest

from app.domain.contracts import FrozenStrategyInstance, RunSnapshot, StrategyRun
from app.domain.resources import ResultStorageFull
from app.domain.status import StrategyStatus
from app.runs.temporary_store import TemporaryRunStore
from app.runs.types import RunResponse


def record(store, key="one", params=None):
    from tests.runs.test_manager import _submission

    submission = _submission("saved")
    config = submission.config
    if params:
        config = config.model_copy(
            update={
                "strategies": (
                    FrozenStrategyInstance.model_validate(
                        {**config.strategies[0].model_dump(), "params": params}
                    ),
                )
            }
        )
    claim = store.reserve(key, "fingerprint")
    response = RunResponse(
        runId=claim.run_id,
        status="queued",
        selectedStrategyIds=("saved",),
        snapshot=RunSnapshot(
            runId=claim.run_id,
            config=config,
            catalogVersion=submission.catalog_version,
            engineVersion=submission.engine_version,
            submissionFingerprint="frozen",
        ),
    )
    store.publish(claim, response)
    return claim, response


def test_runtime_uses_process_owned_temporary_payloads():
    from app.main import create_app

    app = create_app({})
    assert isinstance(app.state.run_service._store, TemporaryRunStore)


def test_disk_roundtrip_preserves_native_parameter_types_and_user_mapping():
    store = TemporaryRunStore()
    try:
        params = {
            "date": date(2024, 3, 1),
            "decimal": Decimal("0.1234567890123456789"),
            "nested": {"decimal": "user-text"},
            "values": [1, "2"],
        }
        claim, original = record(store, params=params)
        loaded = store.get(claim.run_id)
        assert loaded == original
        assert isinstance(loaded.snapshot.config.strategies[0].params["date"], date)
        assert isinstance(
            loaded.snapshot.config.strategies[0].params["decimal"], Decimal
        )
        assert store.wait_for_record(store.reserve("one", "fingerprint")) == original
        detail = StrategyRun(
            id="../../candidate",
            presetId="monthly_dca",
            role="strategy",
            status="queued",
        )
        store.save_candidate(claim.run_id, detail)
        assert store.get_candidate(claim.run_id, detail.id) == detail
        assert not isinstance(store._records, dict)
        assert not isinstance(store._candidates, dict)
    finally:
        store.close()


def test_run_count_limit_preserves_old_records_and_idempotent_retries():
    store = TemporaryRunStore(max_runs=2)
    try:
        first, original = record(store)
        record(store, "two")
        with pytest.raises(ResultStorageFull):
            store.reserve("three", "fingerprint")
        assert len(store._reservations) == 2
        assert store.get(first.run_id) == original
        assert not store.reserve("one", "fingerprint").owner
    finally:
        store.close()


def test_concurrent_claims_cannot_exceed_retained_run_limit():
    store = TemporaryRunStore(max_runs=3)
    barrier = Barrier(10)
    try:

        def claim(index):
            barrier.wait()
            try:
                store.reserve(str(index), "fingerprint")
                return True
            except ResultStorageFull:
                return False

        with ThreadPoolExecutor(max_workers=10) as executor:
            assert sum(executor.map(claim, range(10))) == 3
    finally:
        store.close()


def test_byte_limit_rolls_back_new_payload_and_can_save_failure_state():
    import random

    from app.domain.status import Diagnostic

    store = TemporaryRunStore(max_bytes=256 * 1024)
    try:
        claim, original = record(store)
        noise = random.Random(0).randbytes(100_000).hex()
        detail = StrategyRun(
            id="too-large",
            presetId="monthly_dca",
            role="strategy",
            status="failed",
            diagnostics=(
                Diagnostic(
                    code="calculation_failed",
                    messageKey="test.noise",
                    details={"noise": noise},
                ),
            ),
        )
        with pytest.raises(ResultStorageFull):
            store.save_candidate(claim.run_id, detail)
        assert store.get_candidate(claim.run_id, detail.id) is None
        assert store.get(claim.run_id) == original
        failed = original.model_copy(update={"status": StrategyStatus.FAILED})
        store.update(failed)
        assert store.wait_for_change(claim.run_id, 1, 0).response == failed
        path = store._database.path
        assert sum(file.stat().st_size for file in path.parent.iterdir()) <= 256 * 1024
    finally:
        store.close()


def test_new_process_store_cannot_restore_old_run_and_close_cleans_files():
    first = TemporaryRunStore()
    claim, _ = record(first)
    path = first._database.path
    second = TemporaryRunStore()
    try:
        assert second.get(claim.run_id) is None
        first.close()
        first.close()
        assert not path.parent.exists()
    finally:
        second.close()


def test_failed_initialization_retry_preserves_capacity_error():
    store = TemporaryRunStore(max_runs=1)
    try:
        claim = store.reserve("retry", "fingerprint")
        store.abort(claim, ResultStorageFull("private path"))
        with pytest.raises(ResultStorageFull):
            store.wait_for_record(store.reserve("retry", "fingerprint"))
        marker = store._reservations["retry"].error
        assert marker.__traceback__ is None
        assert marker.__context__ is None
        assert marker.__cause__ is None
    finally:
        store.close()


@pytest.mark.parametrize("grid", [False, True])
def test_disk_execution_preserves_results_candidates_and_native_snapshot(grid):
    from app.runs.manager import RunManager
    from tests.runs.test_manager import (
        _FixtureProvider,
        _grid_submission,
        _ManualExecutor,
        _submission,
    )

    store = TemporaryRunStore()
    executor = _ManualExecutor()
    manager = RunManager(
        store=store, data_provider=_FixtureProvider(), executor=executor
    )
    submission = (_grid_submission if grid else _submission)("disk-execution")
    try:
        accepted = manager.submit_run(submission, idempotency_key="execution")
        assert manager.get_run(accepted.run_id).snapshot == accepted.snapshot
        executor.run_next()
        completed = manager.get_run(accepted.run_id)
        assert completed.status in {
            StrategyStatus.COMPLETED,
            StrategyStatus.COMPLETED_WITH_WARNING,
        }
        assert completed.result is not None
        assert all(row.metrics is not None for row in completed.result.strategy_runs)
        assert manager.submit_run(submission, idempotency_key="execution") == completed
        if grid:
            assert len(store._candidates) > 0
            for key in store._candidates:
                assert manager.get_candidate(*key).metrics is not None
    finally:
        store.close()


def test_storage_failure_stops_search_and_preserves_completed_benchmarks():
    from app.runs.manager import RunManager
    from tests.runs.test_manager import (
        _FixtureProvider,
        _grid_submission,
        _ManualExecutor,
    )

    class FullCandidateStore(TemporaryRunStore):
        attempts = 0

        def save_candidate(self, run_id, candidate):
            self.attempts += 1
            # Exhaust normal pages after benchmarks have been saved. The
            # aggregate status is warning, so failure-state reserve is needed.
            self._database.normal_pages = 1
            raise ResultStorageFull("private sqlite path")

    store = FullCandidateStore()
    executor = _ManualExecutor()
    manager = RunManager(
        store=store, data_provider=_FixtureProvider(), executor=executor
    )
    try:
        accepted = manager.submit_run(
            _grid_submission("full-grid"), idempotency_key="full"
        )
        executor.run_next()
        completed = manager.get_run(accepted.run_id)
        assert completed.status is StrategyStatus.COMPLETED_WITH_WARNING
        assert store.attempts == 1
        rows = {row.id: row for row in completed.result.strategy_runs}
        assert rows["full-grid"].status is StrategyStatus.FAILED
        assert (
            rows["full-grid"].diagnostics[0].message_key == "runs.result_storage_full"
        )
        assert "private sqlite" not in completed.model_dump_json()
        assert rows["benchmark:monthly-dca"].metrics is not None
        assert not manager._cancellations
    finally:
        store.close()


def test_app_shutdown_closes_process_owned_database():
    import asyncio

    import httpx

    from app.main import create_app

    app = create_app({})
    path = app.state.run_service._store._database.path

    async def verify():
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://fixture"
            ) as client:
                assert (await client.get("/health")).status_code == 200
                assert path.exists()
        assert not path.parent.exists()

    asyncio.run(verify())


def test_rollback_journal_and_database_share_total_disk_budget():
    import random

    from app.domain.status import Diagnostic

    budget = 256 * 1024
    store = TemporaryRunStore(max_bytes=budget)
    observed = []
    try:
        claim, _ = record(store)

        def observe(statement):
            if statement == "COMMIT":
                observed.append(
                    sum(
                        file.stat().st_size
                        for file in store._database.path.parent.iterdir()
                    )
                )

        store._database.connection.set_trace_callback(observe)
        for seed in range(2):
            noise = random.Random(seed).randbytes(60_000).hex()
            detail = StrategyRun(
                id="journal",
                presetId="monthly_dca",
                role="strategy",
                status="failed",
                diagnostics=(
                    Diagnostic(
                        code="calculation_failed",
                        messageKey="test.noise",
                        details={"noise": noise},
                    ),
                ),
            )
            store.save_candidate(claim.run_id, detail)
            assert store.get_candidate(claim.run_id, "journal") == detail
        assert len(observed) == 2
        assert max(observed) <= budget
        assert max(observed) > store._database.path.stat().st_size
    finally:
        store.close()


def test_partial_success_can_use_terminal_reserve_at_real_sqlite_page_limit():
    import random

    from app.domain.contracts import RunResult
    from app.domain.status import Diagnostic
    from app.runs.manager import RunManager
    from app.runs.store import InMemoryRunStore
    from tests.runs.test_manager import _FixtureProvider, _ManualExecutor, _submission

    executor = _ManualExecutor()
    manager = RunManager(
        store=InMemoryRunStore(), data_provider=_FixtureProvider(), executor=executor
    )
    accepted = manager.submit_run(_submission("baseline"), idempotency_key="baseline")
    executor.run_next()
    benchmark = next(
        row
        for row in manager.get_run(accepted.run_id).result.strategy_runs
        if row.role.value == "benchmark"
    )
    store = TemporaryRunStore(max_bytes=256 * 1024)
    try:
        claim, original = record(store)
        for index in range(100):
            candidate = StrategyRun(
                id=f"fill-{index}",
                presetId="monthly_dca",
                role="strategy",
                status="failed",
                diagnostics=(
                    Diagnostic(
                        code="calculation_failed",
                        messageKey="fixture",
                        details={"noise": random.Random(index).randbytes(1500).hex()},
                    ),
                ),
            )
            try:
                store.save_candidate(claim.run_id, candidate)
            except ResultStorageFull:
                break
        else:
            pytest.fail("fixture must exhaust normal SQLite page budget")
        result = RunResult(
            runId=claim.run_id,
            strategyRuns=(
                benchmark,
                StrategyRun(
                    id="failed",
                    presetId="monthly_dca",
                    role="strategy",
                    status="failed",
                    diagnostics=(
                        Diagnostic(
                            code="calculation_failed",
                            messageKey="runs.result_storage_full",
                            details={"noise": random.Random(200).randbytes(4000).hex()},
                        ),
                    ),
                ),
            ),
        )
        warning = original.model_copy(
            update={"result": result, "status": result.status}
        )
        assert warning.status is StrategyStatus.COMPLETED_WITH_WARNING
        store.update(warning)
        assert store.get(claim.run_id) == warning
        pages = store._database.connection.execute("PRAGMA page_count").fetchone()[0]
        assert store._database.normal_pages < pages <= store._database.hard_pages
        with pytest.raises(ResultStorageFull):
            store.reserve("new", "fingerprint")
        assert store.wait_for_record(store.reserve("one", "fingerprint")) == warning
    finally:
        store.close()


def test_long_curve_encoding_does_not_expand_every_typed_scalar():
    import zlib
    from datetime import timedelta

    from app.runs.manager import RunManager
    from app.runs.store import InMemoryRunStore
    from tests.runs.test_manager import _FixtureProvider, _ManualExecutor, _submission

    executor = _ManualExecutor()
    manager = RunManager(
        store=InMemoryRunStore(), data_provider=_FixtureProvider(), executor=executor
    )
    accepted = manager.submit_run(_submission("long"), idempotency_key="long")
    executor.run_next()
    result = manager.get_run(accepted.run_id).result.strategy_runs[0]
    sample = result.daily_assets[0]
    curve = tuple(
        sample.model_copy(update={"date": date(2010, 1, 1) + timedelta(days=i)})
        for i in range(4200)
    )
    result = result.model_copy(update={"daily_assets": curve})
    store = TemporaryRunStore()
    try:
        store.save_candidate("long", result)
        body = store._database.connection.execute(
            "SELECT body FROM payloads WHERE kind='candidates'"
        ).fetchone()[0]
        assert len(zlib.decompress(body)) < len(result.model_dump_json().encode()) * 1.5
        assert store.get_candidate("long", result.id) == result
    finally:
        store.close()


def test_progress_and_idle_wait_do_not_decode_saved_curves(monkeypatch):
    from app.runs.temporary_store import _PayloadMap

    store = TemporaryRunStore()
    try:
        claim, original = record(store)

        original_read = _PayloadMap.__getitem__

        def forbidden_read(mapping, key):
            if mapping.kind == "runs":
                pytest.fail("progress must not hydrate full result payloads")
            return original_read(mapping, key)

        monkeypatch.setattr(_PayloadMap, "__getitem__", forbidden_read)
        change = store.wait_for_progress(claim.run_id, 0, 0)
        assert change.version == 1
        assert change.event.run_id == original.run_id
        assert store.get_progress(claim.run_id) == change.event
        assert not isinstance(store._progress, dict)
        assert store.wait_for_change(claim.run_id, 1, 0) is None
        assert store.wait_for_progress(claim.run_id, 1, 0) is None
        assert store.wait_for_progress("missing", 0, 0) is None
    finally:
        store.close()


def test_saved_http_json_does_not_hydrate_result_models(monkeypatch):
    import json

    from app.runs.temporary_store import _PayloadMap

    store = TemporaryRunStore()
    try:
        claim, original = record(store)

        def forbidden_read(mapping, key):
            pytest.fail("HTTP snapshot reads must not decode model trees")

        monkeypatch.setattr(_PayloadMap, "__getitem__", forbidden_read)
        assert json.loads(store.get_json(claim.run_id)) == json.loads(
            original.model_dump_json(by_alias=True)
        )
        assert store.get_json("missing") is None
    finally:
        store.close()


def test_untyped_search_dimension_preserves_decimal_values():
    from app.domain.contracts import SearchResultDimension
    from app.runs.temporary_store import _decode_model, _encode_model

    original = SearchResultDimension(
        key="rsi.buyThreshold", values=(Decimal("20.5"), Decimal("30"))
    )
    restored = _decode_model(_encode_model(original), SearchResultDimension)
    assert restored == original
    assert all(isinstance(value, Decimal) for value in restored.values)

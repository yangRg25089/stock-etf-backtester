from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.calendar import ExchangeCalendar
from app.catalog.service import get_catalog
from app.config.validation import DataRequirement, validate_draft
from app.domain.contracts import (
    DataSnapshot,
    FrozenRunConfig,
    FrozenStrategyInstance,
    MacroObservation,
    MarketBar,
    MarketSnapshot,
    RunScope,
    SharedSettings,
    StrategyRun,
)
from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    DiagnosticSeverity,
    StrategyStatus,
)
from app.runs.data import StrategyDataLoad
from app.runs.manager import RunManager, _calculation_diagnostic
from app.runs.store import IdempotencyConflict, InMemoryRunStore
from app.runs.types import RunResponse, RunSubmission

_DATES = (date(2024, 1, 2), date(2024, 1, 3), date(2024, 1, 4))


def test_calculation_diagnostic_exposes_only_safe_stage_and_run_identity() -> None:
    diagnostic = _calculation_diagnostic(
        ValueError("provider token and internal path must stay hidden"),
        run_id="run-safe-1",
        stage="strategy",
        strategy_id="strategy-vix-1",
    )

    assert diagnostic.message_key == "diagnostics.calculation_failed"
    assert diagnostic.field_path is None
    assert diagnostic.details == {
        "runId": "run-safe-1",
        "stage": "strategy",
        "strategyId": "strategy-vix-1",
    }
    assert "provider token" not in str(diagnostic.details)


class _ManualExecutor:
    def __init__(self) -> None:
        self.jobs: list[Callable[[], object]] = []

    def submit(
        self, function: Callable[..., object], /, *args: object, **kwargs: object
    ) -> None:
        self.jobs.append(lambda: function(*args, **kwargs))

    def run_next(self) -> object:
        return self.jobs.pop(0)()


class _FixtureProvider:
    version = "manager-fixture-v1"

    def __init__(
        self,
        failed_ids: frozenset[str] = frozenset(),
        *,
        provider_failed_ids: frozenset[str] = frozenset(),
        warning_ids: frozenset[str] = frozenset(),
        snapshot_error_ids: frozenset[str] = frozenset(),
        empty_market_ids: frozenset[str] = frozenset(),
    ) -> None:
        self.failed_ids = failed_ids
        self.provider_failed_ids = provider_failed_ids
        self.warning_ids = warning_ids
        self.snapshot_error_ids = snapshot_error_ids
        self.empty_market_ids = empty_market_ids
        self.snapshot = _snapshot()
        self.calendar = ExchangeCalendar.from_dates(
            _DATES,
            as_of_date=_DATES[-1],
            latest_complete_date=_DATES[-1],
            calendar_coverage_end_date=_DATES[-1],
        )

    def load_for_strategy(
        self,
        *,
        shared: SharedSettings,
        strategy: FrozenStrategyInstance,
        requirements: Sequence[DataRequirement],
    ) -> StrategyDataLoad:
        del shared, requirements
        strategy_id = strategy.id
        if strategy_id in self.failed_ids:
            return StrategyDataLoad(
                diagnostics=(
                    Diagnostic(
                        code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                        messageKey="data.fixture_missing",
                        fieldPath="run.symbol",
                        details={"strategyId": strategy_id},
                    ),
                )
            )
        if strategy_id in self.provider_failed_ids:
            return StrategyDataLoad(
                diagnostics=(
                    Diagnostic(
                        code=DiagnosticCode.PROVIDER_REQUEST_FAILED,
                        messageKey="data.fixture_provider_failed",
                        fieldPath="run.symbol",
                        details={"strategyId": strategy_id},
                    ),
                )
            )
        diagnostics = (
            (
                Diagnostic(
                    code=DiagnosticCode.STALE_DATA,
                    severity=DiagnosticSeverity.WARNING,
                    messageKey="data.fixture_stale_warning",
                    fieldPath="run.endDate",
                ),
            )
            if strategy_id in self.warning_ids
            else ()
        )
        if strategy_id in self.snapshot_error_ids:
            diagnostics = (
                *diagnostics,
                Diagnostic(
                    code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    messageKey="data.fixture_signal_requirement_missing",
                    fieldPath="strategies[0].params.vix.buyEnabled",
                ),
            )
        snapshot = self.snapshot
        if strategy_id in self.empty_market_ids:
            market = snapshot.market.model_copy(update={"bars": ()})
            snapshot = snapshot.model_copy(update={"market": market})
        return StrategyDataLoad(
            calendar=self.calendar,
            snapshot=snapshot,
            diagnostics=diagnostics,
        )


class _RecordingStore(InMemoryRunStore):
    def __init__(self) -> None:
        super().__init__()
        self.statuses: list[StrategyStatus] = []

    def update(self, response: RunResponse) -> None:
        super().update(response)
        self.statuses.append(response.status)


def _snapshot() -> DataSnapshot:
    bars = tuple(
        MarketBar(
            date=day,
            symbol="QQQ",
            simulationPrice=Decimal("100"),
            valuationPrice=Decimal("100"),
            currency="USD",
            source="fixture",
            observedAt=datetime.combine(day, datetime.min.time(), UTC),
        )
        for day in _DATES
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
            alignedSessionDate=session,
        )
        for day, session in zip(_DATES, _DATES, strict=True)
    )
    return DataSnapshot(
        market=MarketSnapshot(
            symbol="QQQ",
            currency="USD",
            bars=bars,
            source="fixture",
            fingerprint="market-manager-v1",
        ),
        macro=macro,
        fingerprint="snapshot-manager-v1",
    )


def _submission(
    *strategy_ids: str,
    scope: RunScope = RunScope.ALL_ENABLED,
    end_date: date = _DATES[-1],
) -> RunSubmission:
    strategies = [
        {
            "id": strategy_id,
            "presetId": "composite_dca" if index else "vix_dca",
            "enabled": True,
            "params": {},
            "rules": get_catalog()
            .preset("vix_dca")
            .default_rules.model_dump(mode="python", by_alias=True),
        }
        for index, strategy_id in enumerate(strategy_ids)
    ]
    validation = validate_draft(
        {
            "shared": {
                "run": {
                    "symbol": "QQQ",
                    "startDate": _DATES[0],
                    "endDate": end_date,
                    "endMode": "fixed",
                },
                "contribution": {"day": 2, "amount": Decimal("100")},
            },
            "strategies": strategies,
        }
    )
    selected = tuple(result for result in validation.strategies if result.enabled)
    config = validation.config_for(strategy_ids)
    assert config is not None
    selected_requirements = tuple(
        item
        for item in validation.data_requirements
        if item.strategy_id in strategy_ids
    )
    return RunSubmission(
        config=config,
        scope=scope,
        selectedStrategyIds=strategy_ids,
        catalogVersion=get_catalog().version,
        engineVersion="test-engine-v1",
        strategyValidations=selected,
        dataRequirements=selected_requirements,
    )


def _grid_submission(strategy_id: str) -> RunSubmission:
    base = _submission(strategy_id)
    draft = base.config.model_dump(mode="python", by_alias=True)
    draft["strategies"][0]["presetId"] = "grid_search"
    draft["strategies"][0]["params"] = {"search.dimensions": ["vix.buyThreshold"]}
    validation = validate_draft(draft)
    config = validation.config_for()
    assert config is not None, validation.diagnostics_for()
    return base.model_copy(
        update={
            "config": config,
            "strategy_validations": validation.strategies,
            "data_requirements": validation.data_requirements,
        }
    )


def _runs(response: RunResponse) -> Mapping[str, StrategyRun]:
    assert response.result is not None
    return {item.id: item for item in response.result.strategy_runs}


def test_resolved_listing_start_is_frozen_without_mutating_submission() -> None:
    class AdjustedProvider(_FixtureProvider):
        def load_for_strategy(self, **kwargs: object) -> StrategyDataLoad:
            loaded = super().load_for_strategy(**kwargs)
            return StrategyDataLoad(
                calendar=loaded.calendar,
                snapshot=loaded.snapshot,
                dateAdjustments=[
                    {
                        "field": "startDate",
                        "requestedDate": "2020-01-01",
                        "effectiveDate": "2024-01-02",
                        "reason": "market_available_from",
                    }
                ],
            )

    submission = _submission("listed")
    original_run = submission.config.shared.run.model_copy(
        update={"start_date": date(2020, 1, 1)}
    )
    submission = submission.model_copy(
        update={
            "config": submission.config.model_copy(
                update={
                    "shared": submission.config.shared.model_copy(
                        update={"run": original_run}
                    )
                },
            )
        }
    )
    executor = _ManualExecutor()
    manager = RunManager(
        store=InMemoryRunStore(), data_provider=AdjustedProvider(), executor=executor
    )
    accepted = manager.submit_run(
        submission=submission, idempotency_key="listing-adjustment"
    )
    assert accepted.snapshot.config.shared.run.start_date == date(2024, 1, 2)
    assert accepted.snapshot.date_adjustments[0].requested_date == date(2020, 1, 1)
    assert submission.config.shared.run.start_date == date(2020, 1, 1)
    assert (
        manager.submit_run(submission=submission, idempotency_key="listing-adjustment")
        == accepted
    )
    assert len(executor.jobs) == 1
    executor.run_next()
    completed = manager.get_run(accepted.run_id)
    assert completed is not None
    assert completed.snapshot == accepted.snapshot
    assert all(
        row.metrics and row.metrics.total_contributed == 100
        for row in _runs(completed).values()
    )


def test_manager_freezes_inputs_and_completes_zero_trade_result_and_benchmarks() -> (
    None
):
    store = _RecordingStore()
    executor = _ManualExecutor()
    submission = _submission("quiet-vix")
    manager = RunManager(
        store=store,
        data_provider=_FixtureProvider(),
        executor=executor,  # type: ignore[arg-type]
    )

    accepted = manager.submit_run(submission, idempotency_key="quiet-run")

    assert accepted.status is StrategyStatus.QUEUED
    assert accepted.snapshot.data_fingerprint
    assert accepted.snapshot.config == submission.config
    with pytest.raises(ValidationError):
        accepted.snapshot.config.shared.run.symbol = "SPY"
    executor.run_next()

    completed = manager.get_run(accepted.run_id)
    assert completed is not None
    runs = _runs(completed)
    strategy_run = runs["quiet-vix"]
    assert strategy_run.status is StrategyStatus.COMPLETED
    assert strategy_run.trades == ()
    assert strategy_run.metrics is not None
    assert strategy_run.is_zero_trade_success
    assert runs["benchmark:monthly-dca"].role.value == "benchmark"
    assert runs["benchmark:lump-sum"].role.value == "benchmark"
    assert completed.progress is not None
    assert (
        completed.progress.completed_strategies == completed.progress.total_strategies
    )
    assert StrategyStatus.LOADING in store.statuses
    assert StrategyStatus.RUNNING in store.statuses


def test_manager_preserves_selected_today_date_in_the_frozen_snapshot() -> None:
    executor = _ManualExecutor()
    manager = RunManager(
        store=InMemoryRunStore(),
        data_provider=_FixtureProvider(),
        executor=executor,  # type: ignore[arg-type]
    )

    accepted = manager.submit_run(
        _submission(
            "latest-vix",
            end_date=date(2024, 1, 31),
        ),
        idempotency_key="latest-run",
    )

    assert accepted.snapshot.config.shared.run.end_date == date(2024, 1, 31)
    assert accepted.snapshot.config.shared.run.end_mode.value == "fixed"
    executor.run_next()


def test_manager_preserves_fixed_end_date_for_auditable_clamping_warning() -> None:
    executor = _ManualExecutor()
    manager = RunManager(
        store=InMemoryRunStore(),
        data_provider=_FixtureProvider(),
        executor=executor,  # type: ignore[arg-type]
    )

    accepted = manager.submit_run(
        _submission("fixed-vix", end_date=date(2024, 1, 31)),
        idempotency_key="fixed-end-run",
    )
    executor.run_next()

    completed = manager.get_run(accepted.run_id)
    assert completed is not None
    assert completed.snapshot.config.shared.run.end_date == date(2024, 1, 31)
    assert _runs(completed)["fixed-vix"].status is StrategyStatus.COMPLETED_WITH_WARNING


def test_manager_keeps_required_data_failure_local_to_one_strategy() -> None:
    executor = _ManualExecutor()
    manager = RunManager(
        store=InMemoryRunStore(),
        data_provider=_FixtureProvider(frozenset({"missing-vix"})),
        executor=executor,  # type: ignore[arg-type]
    )
    submission = _submission("missing-vix", "healthy-vix")

    accepted = manager.submit_run(submission, idempotency_key="partial-run")
    executor.run_next()

    completed = manager.get_run(accepted.run_id)
    assert completed is not None
    runs = _runs(completed)
    assert runs["missing-vix"].status is StrategyStatus.UNAVAILABLE
    assert runs["healthy-vix"].status is StrategyStatus.COMPLETED
    assert completed.result is not None
    assert completed.result.is_partial_success
    assert runs["benchmark:monthly-dca"].status is StrategyStatus.COMPLETED


def test_signal_data_failure_does_not_contaminate_market_benchmarks() -> None:
    executor = _ManualExecutor()
    manager = RunManager(
        store=InMemoryRunStore(),
        data_provider=_FixtureProvider(
            snapshot_error_ids=frozenset({"missing-signal-vix"})
        ),
        executor=executor,  # type: ignore[arg-type]
    )
    submission = _submission("missing-signal-vix")

    accepted = manager.submit_run(submission, idempotency_key="signal-data-run")
    executor.run_next()

    completed = manager.get_run(accepted.run_id)
    assert completed is not None
    runs = _runs(completed)
    assert runs["missing-signal-vix"].status is StrategyStatus.UNAVAILABLE
    assert runs["benchmark:monthly-dca"].status is StrategyStatus.COMPLETED
    assert runs["benchmark:monthly-dca"].diagnostics == ()


def test_manager_aggregates_missing_required_data_as_unavailable() -> None:
    executor = _ManualExecutor()
    manager = RunManager(
        store=InMemoryRunStore(),
        data_provider=_FixtureProvider(failed_ids=frozenset({"unavailable-vix"})),
        executor=executor,  # type: ignore[arg-type]
    )

    accepted = manager.submit_run(
        _submission("unavailable-vix"), idempotency_key="unavailable-run"
    )
    executor.run_next()

    completed = manager.get_run(accepted.run_id)
    assert completed is not None
    assert completed.status is StrategyStatus.UNAVAILABLE
    assert completed.result is not None
    assert all(
        item.status is StrategyStatus.UNAVAILABLE
        for item in completed.result.strategy_runs
    )


def test_manager_distinguishes_all_provider_failures_from_unavailable_data() -> None:
    executor = _ManualExecutor()
    manager = RunManager(
        store=InMemoryRunStore(),
        data_provider=_FixtureProvider(provider_failed_ids=frozenset({"failed-vix"})),
        executor=executor,  # type: ignore[arg-type]
    )
    submission = _submission("failed-vix")

    accepted = manager.submit_run(submission, idempotency_key="failed-run")
    executor.run_next()

    completed = manager.get_run(accepted.run_id)
    assert completed is not None
    assert completed.status is StrategyStatus.FAILED
    assert completed.result is not None
    assert all(
        item.status is StrategyStatus.FAILED for item in completed.result.strategy_runs
    )
    assert all(
        item.diagnostics[0].code is DiagnosticCode.PROVIDER_REQUEST_FAILED
        for item in completed.result.strategy_runs
    )


@pytest.mark.parametrize("batch", [False, True])
def test_manager_labels_unexpected_data_code_errors_as_calculation_failures(
    batch, caplog
):
    class BrokenDataProvider(_FixtureProvider):
        def load_for_strategy(self, **_kwargs):
            raise ValueError("private-token-local-programming-bug")

    provider = BrokenDataProvider()
    if batch:
        provider.load_for_run = provider.load_for_strategy
    executor = _ManualExecutor()
    manager = RunManager(
        store=InMemoryRunStore(),
        data_provider=provider,
        executor=executor,  # type: ignore[arg-type]
    )
    accepted = manager.submit_run(
        _submission("broken-vix"), idempotency_key="broken-data-code"
    )
    executor.run_next()
    completed = manager.get_run(accepted.run_id)
    assert completed is not None and completed.result is not None
    assert completed.status is StrategyStatus.FAILED
    assert all(
        item.diagnostics[0].code is DiagnosticCode.CALCULATION_FAILED
        for item in completed.result.strategy_runs
    )
    assert "private-token" not in completed.model_dump_json()
    assert "private-token" not in caplog.text
    assert any(
        getattr(record, "stage", None) == "data_loading" for record in caplog.records
    )


def test_manager_preserves_warning_status_for_a_usable_snapshot() -> None:
    executor = _ManualExecutor()
    manager = RunManager(
        store=InMemoryRunStore(),
        data_provider=_FixtureProvider(warning_ids=frozenset({"stale-vix"})),
        executor=executor,  # type: ignore[arg-type]
    )
    submission = _submission("stale-vix")

    accepted = manager.submit_run(submission, idempotency_key="warning-run")
    executor.run_next()

    completed = manager.get_run(accepted.run_id)
    assert completed is not None
    assert _runs(completed)["stale-vix"].status is StrategyStatus.COMPLETED_WITH_WARNING
    assert completed.status is StrategyStatus.COMPLETED_WITH_WARNING


def test_calculation_failure_does_not_stop_later_strategy_results(
    monkeypatch: pytest.MonkeyPatch,
    caplog,
) -> None:
    caplog.set_level("INFO")
    from app.ledger import run_strategy as original_run_strategy

    executor = _ManualExecutor()
    manager = RunManager(
        store=InMemoryRunStore(),
        data_provider=_FixtureProvider(),
        executor=executor,  # type: ignore[arg-type]
    )

    def fail_one_strategy(
        config: FrozenRunConfig,
        strategy: FrozenStrategyInstance,
        *args: object,
        **kwargs: object,
    ):
        if strategy.id == "calculation-failure":
            raise ArithmeticError("fixture calculation error")
        return original_run_strategy(config, strategy, *args, **kwargs)

    monkeypatch.setattr("app.runs.manager.run_strategy", fail_one_strategy)
    submission = _submission("calculation-failure", "healthy-after-failure")

    accepted = manager.submit_run(submission, idempotency_key="calculation-run")
    executor.run_next()

    completed = manager.get_run(accepted.run_id)
    assert completed is not None
    runs = _runs(completed)
    assert runs["calculation-failure"].status is StrategyStatus.FAILED
    assert runs["calculation-failure"].diagnostics[0].code is (
        DiagnosticCode.CALCULATION_FAILED
    )
    assert runs["healthy-after-failure"].status is StrategyStatus.COMPLETED
    assert completed.result is not None
    assert completed.result.is_partial_success
    assert "fixture calculation error" not in caplog.text


def test_manager_reuses_same_submission_and_rejects_changed_body_for_key() -> None:
    executor = _ManualExecutor()
    manager = RunManager(
        store=InMemoryRunStore(),
        data_provider=_FixtureProvider(),
        executor=executor,  # type: ignore[arg-type]
    )
    submission = _submission("quiet-vix")

    first = manager.submit_run(submission, idempotency_key="retry-key")
    retry = manager.submit_run(submission, idempotency_key="retry-key")

    assert retry.run_id == first.run_id
    assert len(executor.jobs) == 1
    with pytest.raises(IdempotencyConflict):
        manager.submit_run(_submission("another-vix"), idempotency_key="retry-key")


def test_manager_logs_run_and_strategy_status_without_exception_or_config_values(
    caplog,
) -> None:
    caplog.set_level("INFO")
    executor = _ManualExecutor()
    manager = RunManager(
        store=InMemoryRunStore(),
        data_provider=_FixtureProvider(),
        executor=executor,  # type: ignore[arg-type]
    )

    accepted = manager.submit_run(_submission("logged-vix"), idempotency_key="log-run")
    executor.run_next()

    completed = manager.get_run(accepted.run_id)
    assert completed is not None
    assert completed.snapshot.data_provenance.sources == ("fixture",)
    assert completed.snapshot.data_provenance.calendar_as_of == _DATES[-1]
    assert completed.snapshot.data_provenance.market_data_through == _DATES[-1]
    events = [
        (record.event, getattr(record, "status", None))
        for record in caplog.records
        if record.name.endswith("manager")
    ]
    run_finished = next(
        record
        for record in caplog.records
        if record.name.endswith("manager") and record.event == "run_finished"
    )
    assert ("run_queued", "queued") in events
    assert ("strategy_finished", "completed") in events
    assert run_finished.data_sources == ["fixture"]
    assert run_finished.calendar_as_of == _DATES[-1].isoformat()
    assert run_finished.market_data_through == _DATES[-1].isoformat()
    assert "QQQ" not in caplog.text
    assert "amount" not in caplog.text


def test_market_data_coverage_is_unavailable_if_a_loaded_snapshot_has_no_quotes() -> (
    None
):
    executor = _ManualExecutor()
    manager = RunManager(
        store=InMemoryRunStore(),
        data_provider=_FixtureProvider(empty_market_ids=frozenset({"empty-market"})),
        executor=executor,  # type: ignore[arg-type]
    )

    accepted = manager.submit_run(
        _submission("quoted-market", "empty-market"), idempotency_key="empty-quotes"
    )

    assert accepted.snapshot.data_provenance.market_data_through is None


def test_stop_queued_run_is_terminal_idempotent_and_never_executes() -> None:
    from concurrent.futures import Executor
    from typing import cast

    executor = _ManualExecutor()
    manager = RunManager(
        store=InMemoryRunStore(),
        data_provider=_FixtureProvider(),
        executor=cast(Executor, executor),
    )
    accepted = manager.submit_run(
        _submission("stop-queued"), idempotency_key="stop-queued"
    )
    stopped = manager.stop_run(accepted.run_id)
    assert stopped is not None and stopped.status is StrategyStatus.CANCELLED
    assert all(
        item.status is StrategyStatus.CANCELLED and item.metrics is None
        for item in _runs(stopped).values()
    )
    assert manager.stop_run(accepted.run_id) == stopped
    executor.run_next()
    assert manager.get_run(accepted.run_id) == stopped
    assert manager.stop_run("missing") is None


def test_stop_running_preserves_completed_benchmarks_and_true_queue_states(
    monkeypatch,
) -> None:
    from concurrent.futures import Executor
    from typing import cast

    from app.ledger import run_strategy as original_run_strategy

    executor = _ManualExecutor()
    manager = RunManager(
        store=InMemoryRunStore(),
        data_provider=_FixtureProvider(),
        executor=cast(Executor, executor),
    )
    accepted = manager.submit_run(
        _submission("stop-running", "waiting"), idempotency_key="stop-running"
    )
    observed = []

    def stop_inside_calculation(config, strategy, *args, **kwargs):
        if strategy.id == "stop-running":
            current = manager.get_run(accepted.run_id)
            assert current is not None
            rows = _runs(current)
            assert rows["stop-running"].status is StrategyStatus.RUNNING
            assert rows["waiting"].status is StrategyStatus.QUEUED
            assert rows["benchmark:monthly-dca"].metrics is not None
            observed.append(current)
            manager.stop_run(accepted.run_id)
        return original_run_strategy(config, strategy, *args, **kwargs)

    monkeypatch.setattr("app.runs.manager.run_strategy", stop_inside_calculation)
    executor.run_next()
    assert observed
    stopped = manager.get_run(accepted.run_id)
    assert stopped is not None and stopped.status is StrategyStatus.CANCELLED
    rows = _runs(stopped)
    assert rows["stop-running"].metrics is None
    assert rows["waiting"].status is StrategyStatus.CANCELLED
    assert rows["benchmark:monthly-dca"].status is StrategyStatus.COMPLETED
    assert rows["benchmark:monthly-dca"].daily_assets


def test_stop_between_search_candidates_preserves_completed_results(
    monkeypatch,
) -> None:
    from concurrent.futures import Executor
    from typing import cast

    store = InMemoryRunStore()
    executor = _ManualExecutor()
    manager = RunManager(
        store=store, data_provider=_FixtureProvider(), executor=cast(Executor, executor)
    )
    accepted = manager.submit_run(
        _grid_submission("stop-grid"), idempotency_key="stop-search"
    )
    saved_ids: list[str] = []
    save_candidate = store.save_candidate

    def stop_after_first_candidate(run_id: str, candidate: StrategyRun) -> None:
        save_candidate(run_id, candidate)
        saved_ids.append(candidate.id)
        current = manager.get_run(run_id)
        assert current is not None
        assert _runs(current)["stop-grid"].status is StrategyStatus.RUNNING
        assert _runs(current)["benchmark:monthly-dca"].metrics is not None
        manager.stop_run(run_id)

    monkeypatch.setattr(store, "save_candidate", stop_after_first_candidate)
    executor.run_next()
    stopped = manager.get_run(accepted.run_id)
    assert stopped is not None and stopped.status is StrategyStatus.CANCELLED
    rows = _runs(stopped)
    assert rows["stop-grid"].status is StrategyStatus.CANCELLED
    assert rows["stop-grid"].search_result is None
    assert rows["stop-grid"].metrics is None
    for benchmark_id in ("benchmark:monthly-dca", "benchmark:lump-sum"):
        assert rows[benchmark_id].status is StrategyStatus.COMPLETED
        assert rows[benchmark_id].metrics is not None
        assert rows[benchmark_id].daily_assets
    assert saved_ids == ["stop-grid:candidate:00001"]
    first = manager.get_candidate(accepted.run_id, saved_ids[0])
    assert first is not None and first.metrics is not None and first.daily_assets
    assert manager.get_candidate(accepted.run_id, "stop-grid:candidate:00002") is None


def test_grid_best_and_every_candidate_curve_survive_restart_without_calculation(
    tmp_path,
) -> None:
    from concurrent.futures import Executor
    from typing import cast

    from app.runs.sqlite_store import SQLiteRunStore

    submission = _grid_submission("grid")
    executor = _ManualExecutor()
    path = tmp_path / "candidates.sqlite3"
    store = SQLiteRunStore(path)
    manager = RunManager(
        store=store, data_provider=_FixtureProvider(), executor=cast(Executor, executor)
    )
    accepted = manager.submit_run(submission, idempotency_key="saved-candidates")
    executor.run_next()
    completed = manager.get_run(accepted.run_id)
    assert completed is not None
    grid = _runs(completed)["grid"]
    assert grid.search_result is not None and grid.daily_assets
    candidates = grid.search_result.candidates
    assert len(candidates) == 4
    best = manager.get_candidate(
        accepted.run_id, grid.search_result.ranked_candidate_ids[0]
    )
    assert best is not None and grid.daily_assets == best.daily_assets
    saved = {
        item.candidate_id: manager.get_candidate(accepted.run_id, item.candidate_id)
        for item in candidates
    }
    store.close()
    restored = SQLiteRunStore(path)
    for candidate in candidates:
        detail = restored.get_candidate(accepted.run_id, candidate.candidate_id)
        assert detail == saved[candidate.candidate_id]
        assert detail is not None and detail.metrics == candidate.metrics
        assert len(detail.daily_assets) == len(_DATES)
    assert restored.get_candidate("other-run", candidates[0].candidate_id) is None
    restored.close()


def test_stop_and_candidate_http_contracts_use_saved_results(monkeypatch) -> None:
    import asyncio
    import csv
    import io
    import json
    from concurrent.futures import Executor
    from typing import cast

    import httpx
    from fastapi.encoders import jsonable_encoder

    from app.main import app

    executor = _ManualExecutor()
    manager = RunManager(
        store=InMemoryRunStore(),
        data_provider=_FixtureProvider(),
        executor=cast(Executor, executor),
    )
    monkeypatch.setattr(app.state, "run_service", manager)
    draft = jsonable_encoder(
        _submission("http-grid").config.model_dump(mode="python", by_alias=True),
        custom_encoder={Decimal: float},
    )
    draft["strategies"][0]["presetId"] = "grid_search"
    draft["strategies"][0]["params"] = {"search.dimensions": ["vix.buyThreshold"]}

    async def exercise():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://fixture"
        ) as client:
            payload = {"draft": draft, "scope": "all_enabled"}
            queued = await client.post(
                "/api/v1/runs", json=payload, headers={"Idempotency-Key": "stop-http"}
            )
            assert queued.status_code == 202, queued.text
            run_id = queued.json()["runId"]
            first = await client.post(f"/api/v1/runs/{run_id}/stop")
            second = await client.post(f"/api/v1/runs/{run_id}/stop")
            assert first.status_code == 200 and first.json()["status"] == "cancelled"
            assert second.json() == first.json()
            terminal = await client.get(f"/api/v1/runs/{run_id}/events")
            frame = json.loads(
                next(
                    line[6:]
                    for line in terminal.text.splitlines()
                    if line.startswith("data: ")
                )
            )
            assert frame["status"] == "cancelled"
            assert frame["strategyStatuses"]["http-grid"] == "cancelled"
            assert "strategySummaries" in frame
            assert (await client.post("/api/v1/runs/missing/stop")).status_code == 404
            executor.run_next()
            accepted = await client.post(
                "/api/v1/runs", json=payload, headers={"Idempotency-Key": "grid-http"}
            )
            assert accepted.status_code == 202, accepted.text
            run_id = accepted.json()["runId"]
            executor.run_next()
            finished = await client.get(f"/api/v1/runs/{run_id}")
            parent = next(
                row
                for row in finished.json()["result"]["strategyRuns"]
                if row["id"] == "http-grid"
            )
            assert parent["searchResult"] is not None, parent["diagnostics"]
            candidate_id = parent["searchResult"]["rankedCandidateIds"][-1]
            detail = await client.get(
                f"/api/v1/runs/{run_id}/candidates/{candidate_id}"
            )
            assert detail.status_code == 200, detail.text
            assets = detail.json()["dailyAssets"]
            assert len(assets) == len(_DATES)
            downloaded = await client.get(
                f"/api/v1/runs/{run_id}/export/daily-assets",
                params={"focusedResultId": candidate_id},
            )
            assert downloaded.status_code == 200, downloaded.text
            rows = list(csv.DictReader(io.StringIO(downloaded.text)))
            assert len(rows) == len(assets)
            assert Decimal(rows[-1]["totalAsset"]) == Decimal(assets[-1]["totalAsset"])
            assert (
                await client.get(f"/api/v1/runs/{run_id}/candidates/missing")
            ).status_code == 404
            assert (await client.get("/api/v1/instruments/qqq")).json()[
                "currency"
            ] == "USD"
            assert manager.stop_run(run_id).status is StrategyStatus.COMPLETED

    asyncio.run(exercise())

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
    end_mode: str = "fixed",
    end_date: date = _DATES[-1],
) -> RunSubmission:
    strategies = [
        {
            "id": strategy_id,
            "presetId": "vix_dca",
            "enabled": True,
            "params": {},
        }
        for strategy_id in strategy_ids
    ]
    validation = validate_draft(
        {
            "shared": {
                "run": {
                    "symbol": "QQQ",
                    "startDate": _DATES[0],
                    "endDate": end_date,
                    "endMode": end_mode,
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


def _runs(response: RunResponse) -> Mapping[str, StrategyRun]:
    assert response.result is not None
    return {item.id: item for item in response.result.strategy_runs}


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


def test_manager_resolves_latest_date_into_the_frozen_snapshot() -> None:
    executor = _ManualExecutor()
    manager = RunManager(
        store=InMemoryRunStore(),
        data_provider=_FixtureProvider(),
        executor=executor,  # type: ignore[arg-type]
    )

    accepted = manager.submit_run(
        _submission(
            "latest-vix",
            end_mode="latest",
            end_date=date(2024, 1, 31),
        ),
        idempotency_key="latest-run",
    )

    assert accepted.snapshot.config.shared.run.end_date == _DATES[-1]
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

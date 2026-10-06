"""Local orchestration for frozen runs, benchmarks, and independent results."""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Iterable, Mapping, Sequence
from concurrent.futures import Executor, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date
from threading import Event, RLock

from app.calendar import schedule
from app.catalog.service import Catalog, get_catalog
from app.config.validation import DataRequirement
from app.domain.cancellation import RunCancelled
from app.domain.contracts import (
    FrozenRunConfig,
    FrozenStrategyInstance,
    InstrumentMetadata,
    ResultRole,
    RunDataContext,
    RunDataProvenance,
    RunResult,
    RunSnapshot,
    SearchPeriod,
    SearchResult,
    StrategyPresetId,
    StrategyRun,
)
from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    DiagnosticSeverity,
    StrategyStatus,
    is_terminal,
    unique_diagnostics,
)
from app.runs.data import RunDataProvider, StrategyDataLoad, UnconfiguredRunDataProvider
from app.runs.store import RunChange, RunStore
from app.runs.types import RunProgress, RunResponse, RunSubmission
from app.search import GridSearchInput, run_grid_search
from app.simulation import SimulationResult, simulate_strategy

_BENCHMARKS: tuple[tuple[str, StrategyPresetId], ...] = (
    ("benchmark:monthly-dca", StrategyPresetId.MONTHLY_DCA),
    ("benchmark:lump-sum", StrategyPresetId.LUMP_SUM),
)
_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class _Outcome(SimulationResult):
    search_result: SearchResult | None = None
    evaluation_period: SearchPeriod | None = None


class RunManager:
    """Accept immutable submissions and execute each result independently."""

    def __init__(
        self,
        *,
        store: RunStore,
        data_provider: RunDataProvider | None = None,
        catalog: Catalog | None = None,
        executor: Executor | None = None,
    ) -> None:
        self._state_lock = RLock()
        self._cancellations: dict[str, Event] = {}
        self._store = store
        self._data_provider = data_provider or UnconfiguredRunDataProvider()
        self._catalog = get_catalog() if catalog is None else catalog
        self._executor = executor or ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="backtest-run"
        )

    def submit_run(
        self, submission: RunSubmission, *, idempotency_key: str
    ) -> RunResponse:
        """Freeze and publish the submission without waiting for the data provider."""

        request_fingerprint = _fingerprint(
            submission.model_dump(mode="json", by_alias=True)
        )
        reservation = self._store.reserve(idempotency_key, request_fingerprint)
        if not reservation.owner:
            return self._store.wait_for_record(reservation)

        with self._state_lock:
            self._cancellations[reservation.run_id] = Event()
        try:
            snapshot = RunSnapshot(
                runId=reservation.run_id,
                config=submission.config,
                catalogVersion=submission.catalog_version,
                engineVersion=submission.engine_version,
                submissionFingerprint=request_fingerprint,
            )
            response = self._queued_response(snapshot, submission)
            self._store.publish(reservation, response)
            _LOGGER.info(
                "Run accepted and queued",
                extra={
                    "event": "run_queued",
                    "run_id": reservation.run_id,
                    "status": StrategyStatus.QUEUED.value,
                    "strategy_count": len(submission.config.strategies),
                },
            )
        except BaseException as error:
            self._store.abort(reservation, error)
            with self._state_lock:
                self._cancellations.pop(reservation.run_id, None)
            raise

        try:
            self._executor.submit(
                self._execute_run,
                reservation.run_id,
                submission,
            )
        except Exception as error:
            _LOGGER.warning(
                "Run executor rejected the job",
                extra={
                    "event": "run_executor_failed",
                    "run_id": reservation.run_id,
                    "exception_type": type(error).__name__,
                },
            )
            diagnostic = _calculation_diagnostic(
                error, run_id=reservation.run_id, stage="queue"
            )
            self._fail_unfinished(reservation.run_id, diagnostic)
            with self._state_lock:
                self._cancellations.pop(reservation.run_id, None)
            current = self._store.get(reservation.run_id)
            return response if current is None else current
        return response

    def stop_run(self, run_id: str) -> RunResponse | None:
        with self._state_lock:
            response = self._store.get(run_id)
            if response is None or is_terminal(response.status):
                return response
            self._cancellations.setdefault(run_id, Event()).set()
            diagnostic = Diagnostic(
                code=DiagnosticCode.RUN_CANCELLED,
                severity=DiagnosticSeverity.INFO,
                messageKey="runs.cancelled",
            )
            assert response.result is not None
            self._save_result(
                response,
                tuple(
                    item
                    if is_terminal(item.status)
                    else item.with_status(
                        StrategyStatus.CANCELLED, diagnostics=(diagnostic,)
                    )
                    for item in response.result.strategy_runs
                ),
            )
            self._clear_current(run_id)
            return self._store.get(run_id)

    def get_candidate(self, run_id: str, candidate_id: str) -> StrategyRun | None:
        return self._store.get_candidate(run_id, candidate_id)

    def _check_cancelled(self, run_id: str) -> None:
        event = self._cancellations.get(run_id)
        if event is not None and event.is_set():
            raise RunCancelled()

    def _save_candidate(self, run_id: str, candidate: StrategyRun) -> None:
        with self._state_lock:
            self._check_cancelled(run_id)
            self._store.save_candidate(run_id, candidate)

    def get_run(self, run_id: str) -> RunResponse | None:
        return self._store.get(run_id)

    def instrument_metadata(self, symbol: str) -> InstrumentMetadata:
        suggestion = next(
            (
                item
                for item in self._catalog.symbol_suggestions
                if item.symbol == symbol
            ),
            None,
        )
        if suggestion is not None:
            return InstrumentMetadata(symbol=symbol, currency=suggestion.currency)
        loader = getattr(self._data_provider, "instrument_metadata", None)
        if callable(loader):
            metadata = loader(symbol)
            if isinstance(metadata, InstrumentMetadata):
                return metadata
        return InstrumentMetadata(
            symbol=symbol,
            diagnostics=(
                Diagnostic(
                    code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    messageKey="data.currency_missing",
                    fieldPath="run.symbol",
                ),
            ),
        )

    def wait_for_run_change(
        self, run_id: str, after_version: int, timeout_seconds: float
    ) -> RunChange | None:
        return self._store.wait_for_change(run_id, after_version, timeout_seconds)

    def _load_strategy_data(
        self, submission: RunSubmission, run_id: str
    ) -> dict[str, StrategyDataLoad]:
        self._check_cancelled(run_id)
        validations = {
            validation.strategy_id: validation
            for validation in submission.strategy_validations
        }
        requirements: dict[str, list[DataRequirement]] = {
            strategy_id: [] for strategy_id in submission.selected_strategy_ids
        }
        for requirement in submission.data_requirements:
            requirements[requirement.strategy_id].append(requirement)

        loaded: dict[str, StrategyDataLoad] = {}
        batch_loader = getattr(self._data_provider, "load_for_run", None)
        if callable(batch_loader):
            eligible_strategies = []
            for strategy in submission.config.strategies:
                validation = validations[strategy.id]
                if validation.diagnostics:
                    loaded[strategy.id] = StrategyDataLoad(
                        diagnostics=validation.diagnostics
                    )
                else:
                    eligible_strategies.append(strategy)
            if eligible_strategies:
                try:
                    self._check_cancelled(run_id)
                    batch = batch_loader(
                        shared=submission.config.shared,
                        strategies=tuple(eligible_strategies),
                        requirements={
                            strategy.id: tuple(requirements[strategy.id])
                            for strategy in eligible_strategies
                        },
                    )
                except RunCancelled:
                    raise
                except Exception as error:
                    for strategy in eligible_strategies:
                        loaded[strategy.id] = StrategyDataLoad(
                            diagnostics=(
                                _calculation_diagnostic(
                                    error,
                                    run_id=run_id,
                                    stage="data_loading",
                                    strategy_id=strategy.id,
                                ),
                            )
                        )
                else:
                    for strategy in eligible_strategies:
                        strategy_load = batch.get(strategy.id)
                        if isinstance(strategy_load, StrategyDataLoad):
                            loaded[strategy.id] = strategy_load
                        else:
                            loaded[strategy.id] = StrategyDataLoad(
                                diagnostics=(
                                    _calculation_diagnostic(
                                        ValueError(
                                            "batch data provider omitted strategy data"
                                        ),
                                        run_id=run_id,
                                        stage="data_loading",
                                        strategy_id=strategy.id,
                                    ),
                                )
                            )
            self._check_cancelled(run_id)
            return self._mark_incompatible_contexts(loaded)

        for strategy in submission.config.strategies:
            self._check_cancelled(run_id)
            validation = validations[strategy.id]
            if validation.diagnostics:
                loaded[strategy.id] = StrategyDataLoad(
                    diagnostics=validation.diagnostics
                )
                continue
            try:
                loaded[strategy.id] = self._data_provider.load_for_strategy(
                    shared=submission.config.shared,
                    strategy=strategy,
                    requirements=requirements[strategy.id],
                )
            except RunCancelled:
                raise
            except Exception as error:
                loaded[strategy.id] = StrategyDataLoad(
                    diagnostics=(
                        _calculation_diagnostic(
                            error,
                            run_id=run_id,
                            stage="data_loading",
                            strategy_id=strategy.id,
                        ),
                    )
                )

        self._check_cancelled(run_id)
        return self._mark_incompatible_contexts(loaded)

    def _mark_incompatible_contexts(
        self, loaded: dict[str, StrategyDataLoad]
    ) -> dict[str, StrategyDataLoad]:
        reference: StrategyDataLoad | None = next(
            (
                item
                for item in loaded.values()
                if item.calendar is not None and item.snapshot is not None
            ),
            None,
        )
        if reference is None:
            return loaded
        reference_calendar = reference.calendar
        reference_snapshot = reference.snapshot
        assert reference_calendar is not None
        assert reference_snapshot is not None
        for strategy_id, item in tuple(loaded.items()):
            if item.calendar is None or item.snapshot is None:
                continue
            if (
                item.calendar != reference_calendar
                or item.snapshot.market != reference_snapshot.market
                or item.date_adjustments != reference.date_adjustments
            ):
                diagnostic = Diagnostic(
                    code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    severity=DiagnosticSeverity.ERROR,
                    messageKey="data.run_context_mismatch",
                    fieldPath="run.symbol",
                    details={"strategyId": strategy_id},
                )
                loaded[strategy_id] = item.model_copy(
                    update={
                        "diagnostics": unique_diagnostics(
                            (*item.diagnostics, diagnostic)
                        )
                    }
                )
        return loaded

    def _make_data_context(
        self,
        submission: RunSubmission,
        data_loads: Mapping[str, StrategyDataLoad],
    ) -> RunDataContext:
        config = submission.config
        resolved = next(
            (
                item
                for item in data_loads.values()
                if item.snapshot is not None
                and item.calendar is not None
                and not any(
                    d.message_key == "data.run_context_mismatch"
                    for d in item.diagnostics
                )
            ),
            None,
        )
        adjustments = resolved.date_adjustments if resolved is not None else ()
        if adjustments:
            fields = {"startDate": "start_date", "endDate": "end_date"}
            updates = {fields[item.field]: item.effective_date for item in adjustments}
            for item in adjustments:
                if (
                    getattr(config.shared.run, fields[item.field])
                    != item.requested_date
                ):
                    raise ValueError("resolved date does not match the submitted range")
            config = config.model_copy(
                update={
                    "shared": config.shared.model_copy(
                        update={"run": config.shared.run.model_copy(update=updates)},
                    )
                }
            )
        data_payload = {
            "providerVersion": self._data_provider.version,
            "strategyData": [
                {
                    "strategyId": strategy_id,
                    "fingerprint": (
                        item.snapshot.fingerprint if item.snapshot is not None else None
                    ),
                    "calendar": (
                        item.calendar.model_dump(mode="json", by_alias=True)
                        if item.calendar is not None
                        else None
                    ),
                    "diagnostics": [
                        diagnostic.model_dump(mode="json", by_alias=True)
                        for diagnostic in item.diagnostics
                    ],
                    "dateAdjustments": [
                        adjustment.model_dump(mode="json", by_alias=True)
                        for adjustment in item.date_adjustments
                    ],
                }
                for strategy_id, item in sorted(data_loads.items())
            ],
        }
        return RunDataContext(
            dataFingerprint=_fingerprint(data_payload),
            dataProvenance=_data_provenance(data_loads),
            effectiveRun=config.shared.run,
            dateAdjustments=adjustments,
        )

    def _start_data_loading(self, run_id: str, strategy_id: str) -> None:
        with self._state_lock:
            self._check_cancelled(run_id)
            response = self._store.get(run_id)
            if response is None or response.result is None:
                raise RunCancelled()
            self._save_result(
                response,
                tuple(
                    item.with_status(StrategyStatus.LOADING)
                    if item.id == strategy_id
                    else item
                    for item in response.result.strategy_runs
                ),
            )

    def _freeze_data_context(self, run_id: str, context: RunDataContext) -> RunSnapshot:
        with self._state_lock:
            self._check_cancelled(run_id)
            response = self._store.get(run_id)
            if response is None or is_terminal(response.status):
                raise RunCancelled()
            snapshot = response.snapshot.with_data_context(context)
            self._store.update(response.model_copy(update={"snapshot": snapshot}))
            return snapshot

    def _queued_response(
        self, snapshot: RunSnapshot, submission: RunSubmission
    ) -> RunResponse:
        run_id = snapshot.run_id
        queued_runs = tuple(
            StrategyRun(
                id=strategy.id,
                presetId=strategy.preset_id,
                instanceNumber=strategy.instance_number,
                role=ResultRole.STRATEGY,
                status=StrategyStatus.QUEUED,
            )
            for strategy in snapshot.config.strategies
        ) + tuple(
            StrategyRun(
                id=benchmark_id,
                presetId=preset_id,
                role=ResultRole.BENCHMARK,
                status=StrategyStatus.QUEUED,
            )
            for benchmark_id, preset_id in _BENCHMARKS
        )
        return RunResponse(
            runId=run_id,
            status=StrategyStatus.QUEUED,
            selectedStrategyIds=submission.selected_strategy_ids,
            progress=RunProgress(
                completedStrategies=0,
                totalStrategies=len(queued_runs),
            ),
            snapshot=snapshot,
            result=RunResult(runId=run_id, strategyRuns=queued_runs),
        )

    def _execute_run(
        self,
        run_id: str,
        submission: RunSubmission,
    ) -> None:
        try:
            self._start_data_loading(run_id, submission.selected_strategy_ids[0])
            _LOGGER.info(
                "Run execution started",
                extra={
                    "event": "run_started",
                    "run_id": run_id,
                    "status": StrategyStatus.LOADING.value,
                },
            )
            self._check_cancelled(run_id)
            data_loads = self._load_strategy_data(submission, run_id)
            snapshot = self._freeze_data_context(
                run_id, self._make_data_context(submission, data_loads)
            )
            response = self._store.get(run_id)
            if response is None:
                return
            config = snapshot.effective_config
            reference_load = _reference_load(data_loads)

            if reference_load is None:
                unavailable = _context_failure(data_loads.values())
                for benchmark_id, _preset_id in _BENCHMARKS:
                    self._complete_run(
                        run_id,
                        benchmark_id,
                        _failure_outcome(unavailable),
                    )
            else:
                for benchmark_id, preset_id in _BENCHMARKS:
                    self._check_cancelled(run_id)
                    self._set_current(run_id, benchmark_id)
                    try:
                        benchmark_outcome = self._run_benchmark(
                            config,
                            reference_load,
                            run_id=run_id,
                            benchmark_id=benchmark_id,
                            preset_id=preset_id,
                        )
                    except RunCancelled:
                        raise
                    except Exception as error:
                        benchmark_outcome = _failure_outcome(
                            (
                                _calculation_diagnostic(
                                    error, run_id=run_id, stage=preset_id.value
                                ),
                            )
                        )
                    self._complete_run(run_id, benchmark_id, benchmark_outcome)

            validation_by_id = {
                validation.strategy_id: validation
                for validation in submission.strategy_validations
            }
            for strategy in config.strategies:
                self._check_cancelled(run_id)
                self._set_current(run_id, strategy.id)
                validation = validation_by_id[strategy.id]
                context = data_loads[strategy.id]
                try:
                    if validation.diagnostics:
                        outcome = _failure_outcome(validation.diagnostics)
                    elif reference_load is not None and _context_mismatch(
                        reference_load, context
                    ):
                        outcome = _failure_outcome(context.diagnostics)
                    elif _has_blocking_diagnostic(context.diagnostics):
                        outcome = _failure_outcome(context.diagnostics)
                    elif context.snapshot is None or context.calendar is None:
                        outcome = _failure_outcome(context.diagnostics)
                    else:
                        outcome = self._run_strategy(
                            config,
                            strategy,
                            context,
                            run_id=run_id,
                        )
                except RunCancelled:
                    raise
                except Exception as error:
                    outcome = _failure_outcome(
                        (
                            _calculation_diagnostic(
                                error,
                                run_id=run_id,
                                stage="strategy",
                                strategy_id=strategy.id,
                            ),
                        )
                    )
                self._complete_run(run_id, strategy.id, outcome)

            self._clear_current(run_id)
            response = self._store.get(run_id)
            if response is not None:
                _LOGGER.info(
                    "Run execution finished",
                    extra={
                        "event": "run_finished",
                        "run_id": run_id,
                        "status": response.status.value,
                        "data_sources": list(response.snapshot.data_provenance.sources),
                        "calendar_as_of": _iso_date(
                            response.snapshot.data_provenance.calendar_as_of
                        ),
                        "market_data_through": _iso_date(
                            response.snapshot.data_provenance.market_data_through
                        ),
                    },
                )
        except RunCancelled:
            return
        except Exception as error:
            _LOGGER.warning(
                "Run execution failed",
                extra={
                    "event": "run_failed",
                    "run_id": run_id,
                    "exception_type": type(error).__name__,
                },
            )
            self._fail_unfinished(
                run_id,
                _calculation_diagnostic(error, run_id=run_id, stage="execution"),
            )
        finally:
            with self._state_lock:
                self._cancellations.pop(run_id, None)

    def _run_benchmark(
        self,
        config: FrozenRunConfig,
        data_load: StrategyDataLoad,
        *,
        run_id: str,
        benchmark_id: str,
        preset_id: StrategyPresetId,
    ) -> _Outcome:
        strategy = _benchmark_strategy(self._catalog, benchmark_id, preset_id)
        if data_load.snapshot is None or data_load.calendar is None:
            return _failure_outcome(data_load.diagnostics)
        benchmark_data = data_load.model_copy(
            update={
                "diagnostics": tuple(
                    diagnostic
                    for diagnostic in data_load.diagnostics
                    if diagnostic.severity is not DiagnosticSeverity.ERROR
                )
            }
        )
        return self._run_basic_strategy(
            config,
            strategy,
            benchmark_data,
            run_id=run_id,
        )

    def _run_strategy(
        self,
        config: FrozenRunConfig,
        strategy: FrozenStrategyInstance,
        data_load: StrategyDataLoad,
        *,
        run_id: str,
    ) -> _Outcome:
        if strategy.preset_id is StrategyPresetId.GRID_SEARCH:
            assert data_load.snapshot is not None
            assert data_load.calendar is not None
            contribution_schedule = schedule(config.shared, data_load.calendar)
            result = run_grid_search(
                GridSearchInput(
                    config=FrozenRunConfig(
                        shared=config.shared,
                        strategies=(strategy,),
                    ),
                    strategy=strategy,
                    schedule=contribution_schedule,
                    exchange_calendar=data_load.calendar,
                    snapshot=data_load.snapshot,
                    catalog=self._catalog,
                ),
                check_cancelled=lambda: self._check_cancelled(run_id),
                save_candidate=lambda item: self._save_candidate(run_id, item),
                load_candidate=lambda item_id: self._store.get_candidate(
                    run_id, item_id
                ),
            )
            outcome = _search_outcome(result, data_load.diagnostics)
            best_id = (
                result.out_of_sample.result_id
                if result.out_of_sample is not None
                else result.ranked_candidate_ids[0]
                if result.ranked_candidate_ids
                else None
            )
            best = (
                None if best_id is None else self._store.get_candidate(run_id, best_id)
            )
            if best is not None:
                outcome = _Outcome(
                    status=outcome.status,
                    diagnostics=outcome.diagnostics,
                    search_result=result,
                    metrics=best.metrics,
                    daily_assets=best.daily_assets,
                    trades=best.trades,
                    signals=best.signals,
                    technical_indicators=best.technical_indicators,
                    unexecuted_signals=best.unexecuted_signals,
                    evaluation_period=best.evaluation_period,
                )
            return outcome

        return self._run_basic_strategy(
            config,
            strategy,
            data_load,
            run_id=run_id,
        )

    def _run_basic_strategy(
        self,
        config: FrozenRunConfig,
        strategy: FrozenStrategyInstance,
        data_load: StrategyDataLoad,
        *,
        run_id: str,
    ) -> _Outcome:
        assert data_load.snapshot is not None
        assert data_load.calendar is not None
        calculated = simulate_strategy(
            config,
            strategy,
            schedule(config.shared, data_load.calendar),
            data_load.snapshot,
            data_load.calendar,
            diagnostics=data_load.diagnostics,
            check_cancelled=lambda: self._check_cancelled(run_id),
        )
        return _Outcome(
            status=calculated.status,
            diagnostics=calculated.diagnostics,
            signals=calculated.signals,
            technical_indicators=calculated.technical_indicators,
            unexecuted_signals=calculated.unexecuted_signals,
            trades=calculated.trades,
            daily_assets=calculated.daily_assets,
            metrics=calculated.metrics,
        )

    def _set_current(self, run_id: str, strategy_id: str) -> None:
        with self._state_lock:
            response = self._store.get(run_id)
            if response is None or response.result is None or response.progress is None:
                return
            self._check_cancelled(run_id)
            for status in (StrategyStatus.LOADING, StrategyStatus.RUNNING):
                response = self._store.get(run_id)
                assert response is not None and response.result is not None
                self._save_result(
                    response,
                    tuple(
                        item.with_status(status) if item.id == strategy_id else item
                        for item in response.result.strategy_runs
                    ),
                )
            response = self._store.get(run_id)
            assert response is not None and response.progress is not None
            self._store.update(
                response.model_copy(
                    update={
                        "progress": response.progress.model_copy(
                            update={"current_strategy_id": strategy_id}
                        )
                    }
                )
            )

    def _clear_current(self, run_id: str) -> None:
        with self._state_lock:
            response = self._store.get(run_id)
            if response is None or response.progress is None:
                return
            completed = (
                0
                if response.result is None
                else sum(
                    is_terminal(item.status) for item in response.result.strategy_runs
                )
            )
            self._store.update(
                response.model_copy(
                    update={
                        "progress": response.progress.model_copy(
                            update={
                                "completed_strategies": completed,
                                "current_strategy_id": None,
                            }
                        )
                    }
                )
            )

    def _complete_run(self, run_id: str, strategy_id: str, outcome: _Outcome) -> None:
        with self._state_lock:
            response = self._store.get(run_id)
            if response is None or response.result is None:
                return
            runs: list[StrategyRun] = []
            found = False
            for item in response.result.strategy_runs:
                if item.id != strategy_id:
                    runs.append(item)
                    continue
                found = True
                if is_terminal(item.status):
                    return
                updated = item.model_copy(
                    update={
                        "signals": outcome.signals,
                        "technical_indicators": outcome.technical_indicators,
                        "unexecuted_signals": outcome.unexecuted_signals,
                        "trades": outcome.trades,
                        "daily_assets": outcome.daily_assets,
                        "metrics": outcome.metrics,
                        "search_result": outcome.search_result,
                        "evaluation_period": outcome.evaluation_period,
                    }
                )
                runs.append(
                    updated.with_status(outcome.status, diagnostics=outcome.diagnostics)
                )
            if not found:
                raise KeyError(f"run result does not contain strategy: {strategy_id}")
            self._save_result(response, tuple(runs))
            _LOGGER.info(
                "Strategy execution finished",
                extra={
                    "event": "strategy_finished",
                    "run_id": run_id,
                    "strategy_id": strategy_id,
                    "status": outcome.status.value,
                    "diagnostic_codes": [
                        item.code.value for item in outcome.diagnostics
                    ],
                },
            )

    def _save_result(
        self, response: RunResponse, strategy_runs: Sequence[StrategyRun]
    ) -> None:
        result = RunResult(runId=response.run_id, strategyRuns=tuple(strategy_runs))
        progress = response.progress
        if progress is not None:
            progress = progress.model_copy(
                update={
                    "completed_strategies": sum(
                        is_terminal(item.status) for item in result.strategy_runs
                    )
                }
            )
        self._store.update(
            response.model_copy(
                update={"status": result.status, "progress": progress, "result": result}
            )
        )

    def _fail_unfinished(self, run_id: str, diagnostic: Diagnostic) -> None:
        with self._state_lock:
            response = self._store.get(run_id)
            if response is None or response.result is None:
                return
            failed = tuple(
                item.with_status(
                    StrategyStatus.FAILED,
                    diagnostics=unique_diagnostics((*item.diagnostics, diagnostic)),
                )
                if not is_terminal(item.status)
                else item
                for item in response.result.strategy_runs
            )
            self._save_result(response, failed)


def _data_provenance(
    data_loads: Mapping[str, StrategyDataLoad],
) -> RunDataProvenance:
    sources: set[str] = set()
    calendar_as_of_dates = [
        item.calendar.as_of_date
        for item in data_loads.values()
        if item.calendar is not None
    ]
    market_data_through_dates: list[date | None] = []
    for item in data_loads.values():
        sources.update(
            diagnostic.source
            for diagnostic in item.diagnostics
            if diagnostic.source is not None
        )
        if item.snapshot is None:
            continue
        market = item.snapshot.market
        sources.add(market.source)
        sources.update(bar.source for bar in market.bars)
        market_dates = [bar.date for bar in market.bars]
        market_data_through_dates.append(max(market_dates, default=None))
        sources.update(observation.source for observation in item.snapshot.macro)
    return RunDataProvenance(
        sources=tuple(sources),
        calendarAsOf=(min(calendar_as_of_dates) if calendar_as_of_dates else None),
        marketDataThrough=(
            min(
                market_date
                for market_date in market_data_through_dates
                if market_date is not None
            )
            if market_data_through_dates
            and all(
                market_date is not None for market_date in market_data_through_dates
            )
            else None
        ),
    )


def _iso_date(value: date | None) -> str | None:
    return None if value is None else value.isoformat()


def _benchmark_strategy(
    catalog: Catalog,
    strategy_id: str,
    preset_id: StrategyPresetId,
) -> FrozenStrategyInstance:
    preset = catalog.preset(preset_id)
    return FrozenStrategyInstance(
        id=strategy_id,
        presetId=preset_id,
        enabled=True,
        params=preset.default_params,
    )


def _reference_load(
    data_loads: Mapping[str, StrategyDataLoad],
) -> StrategyDataLoad | None:
    return next(
        (
            item
            for item in data_loads.values()
            if item.calendar is not None and item.snapshot is not None
        ),
        None,
    )


def _context_mismatch(reference: StrategyDataLoad, candidate: StrategyDataLoad) -> bool:
    if (
        candidate.calendar is None
        or candidate.snapshot is None
        or reference.calendar is None
        or reference.snapshot is None
    ):
        return True
    return (
        candidate.calendar != reference.calendar
        or candidate.snapshot.market != reference.snapshot.market
    )


def _context_failure(data_loads: Iterable[StrategyDataLoad]) -> tuple[Diagnostic, ...]:
    diagnostics = unique_diagnostics(
        diagnostic for data_load in data_loads for diagnostic in data_load.diagnostics
    )
    if diagnostics:
        return diagnostics
    return (
        Diagnostic(
            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
            severity=DiagnosticSeverity.ERROR,
            messageKey="data.required_snapshot_unavailable",
            fieldPath="run.symbol",
        ),
    )


def _failure_outcome(diagnostics: Sequence[Diagnostic]) -> _Outcome:
    normalized = unique_diagnostics(diagnostics)
    if not normalized:
        normalized = _context_failure(())
    status = (
        StrategyStatus.UNAVAILABLE
        if any(
            item.code is DiagnosticCode.REQUIRED_DATA_UNAVAILABLE for item in normalized
        )
        else StrategyStatus.FAILED
    )
    return _Outcome(status=status, diagnostics=normalized)


def _search_outcome(
    search_result: SearchResult,
    context_diagnostics: Sequence[Diagnostic],
) -> _Outcome:
    successful = tuple(
        candidate
        for candidate in search_result.candidates
        if candidate.metrics is not None
        and candidate.status
        in {
            StrategyStatus.COMPLETED,
            StrategyStatus.COMPLETED_WITH_WARNING,
        }
    )
    diagnostics = unique_diagnostics(
        (
            *context_diagnostics,
            *(
                diagnostic
                for candidate in search_result.candidates
                for diagnostic in candidate.diagnostics
            ),
            *(
                diagnostic
                for candidate in search_result.candidates
                if candidate.test_result is not None
                for diagnostic in candidate.test_result.diagnostics
            ),
            *(
                diagnostic
                for baseline in search_result.period_benchmarks
                for diagnostic in baseline.diagnostics
            ),
            *(
                search_result.out_of_sample.diagnostics
                if search_result.out_of_sample is not None
                else ()
            ),
        )
    )
    if search_result.out_of_sample is not None:
        oos = search_result.out_of_sample
        status = oos.status
        if status is StrategyStatus.COMPLETED and (
            any(
                row.status is not StrategyStatus.COMPLETED
                for row in search_result.candidates
            )
            or any(
                row.status is not StrategyStatus.COMPLETED
                for row in search_result.period_benchmarks
            )
            or any(row.severity is DiagnosticSeverity.WARNING for row in diagnostics)
        ):
            status = StrategyStatus.COMPLETED_WITH_WARNING
        return _Outcome(
            status=status,
            diagnostics=diagnostics,
            metrics=oos.metrics,
            search_result=search_result,
        )
    if not successful:
        return _Outcome(
            status=(
                StrategyStatus.UNAVAILABLE
                if search_result.candidates
                and all(
                    candidate.status is StrategyStatus.UNAVAILABLE
                    for candidate in search_result.candidates
                )
                else StrategyStatus.FAILED
            ),
            diagnostics=diagnostics,
            search_result=search_result,
        )
    best_id = search_result.ranked_candidate_ids[0]
    best = next(
        candidate for candidate in successful if candidate.candidate_id == best_id
    )
    has_warnings = (
        any(
            candidate.status is not StrategyStatus.COMPLETED
            or candidate.test_result is not None
            and candidate.test_result.status is not StrategyStatus.COMPLETED
            for candidate in search_result.candidates
        )
        or any(
            baseline.status is not StrategyStatus.COMPLETED
            for baseline in search_result.period_benchmarks
        )
        or any(item.severity is DiagnosticSeverity.WARNING for item in diagnostics)
    )
    return _Outcome(
        status=(
            StrategyStatus.COMPLETED_WITH_WARNING
            if has_warnings
            else StrategyStatus.COMPLETED
        ),
        diagnostics=diagnostics,
        metrics=best.metrics,
        search_result=search_result,
    )


def _calculation_diagnostic(
    error: Exception,
    *,
    run_id: str,
    stage: str,
    strategy_id: str | None = None,
) -> Diagnostic:
    _LOGGER.warning(
        "Run calculation stage failed",
        extra={
            "event": "run_calculation_stage_failed",
            "run_id": run_id,
            "stage": stage,
            "strategy_id": strategy_id,
            "exception_type": type(error).__name__,
        },
    )
    details: dict[str, object] = {"runId": run_id, "stage": stage}
    if strategy_id is not None:
        details["strategyId"] = strategy_id
    return Diagnostic(
        code=DiagnosticCode.CALCULATION_FAILED,
        severity=DiagnosticSeverity.ERROR,
        messageKey="diagnostics.calculation_failed",
        details=details,
    )


def _has_blocking_diagnostic(diagnostics: Sequence[Diagnostic]) -> bool:
    return any(item.severity is DiagnosticSeverity.ERROR for item in diagnostics)


def _fingerprint(value: object) -> str:
    serialized = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

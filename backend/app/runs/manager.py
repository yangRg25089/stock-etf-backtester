"""Local orchestration for frozen runs, benchmarks, and independent results."""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Iterable, Mapping, Sequence
from concurrent.futures import Executor, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date

from app.calendar import ExchangeCalendar, schedule
from app.catalog.service import Catalog, get_catalog
from app.config.validation import DataRequirement
from app.domain.contracts import (
    DailyAsset,
    EndMode,
    FrozenRunConfig,
    FrozenStrategyInstance,
    MetricSummary,
    ResultRole,
    RunDataProvenance,
    RunResult,
    RunSnapshot,
    SearchResult,
    SignalEvaluation,
    StrategyPresetId,
    StrategyRun,
    Trade,
    UnexecutedSignal,
)
from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    DiagnosticSeverity,
    StrategyStatus,
    is_terminal,
)
from app.ledger import run_strategy
from app.metrics import MetricsInput, calculate_metrics
from app.runs.data import RunDataProvider, StrategyDataLoad, UnconfiguredRunDataProvider
from app.runs.store import RunChange, RunStore
from app.runs.types import RunProgress, RunResponse, RunSubmission
from app.search import GridSearchInput, run_grid_search
from app.signals import evaluate_signals

_BENCHMARKS: tuple[tuple[str, StrategyPresetId], ...] = (
    ("benchmark:monthly-dca", StrategyPresetId.MONTHLY_DCA),
    ("benchmark:lump-sum", StrategyPresetId.LUMP_SUM),
)
_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class _Outcome:
    status: StrategyStatus
    diagnostics: tuple[Diagnostic, ...] = ()
    signals: tuple[SignalEvaluation, ...] = ()
    unexecuted_signals: tuple[UnexecutedSignal, ...] = ()
    trades: tuple[Trade, ...] = ()
    daily_assets: tuple[DailyAsset, ...] = ()
    metrics: MetricSummary | None = None
    search_result: SearchResult | None = None


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
        self._store = store
        self._data_provider = data_provider or UnconfiguredRunDataProvider()
        self._catalog = get_catalog() if catalog is None else catalog
        self._executor = executor or ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="backtest-run"
        )

    def submit_run(
        self, submission: RunSubmission, *, idempotency_key: str
    ) -> RunResponse:
        """Atomically claim the retry key, freeze data identity, and queue work."""

        request_fingerprint = _fingerprint(
            submission.model_dump(mode="json", by_alias=True)
        )
        reservation = self._store.reserve(idempotency_key, request_fingerprint)
        if not reservation.owner:
            return self._store.wait_for_record(reservation)

        try:
            data_loads = self._load_strategy_data(submission)
            snapshot = self._make_snapshot(reservation.run_id, submission, data_loads)
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
            raise

        try:
            self._executor.submit(
                self._execute_run,
                reservation.run_id,
                submission,
                data_loads,
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
            current = self._store.get(reservation.run_id)
            return response if current is None else current
        return response

    def get_run(self, run_id: str) -> RunResponse | None:
        return self._store.get(run_id)

    def get_latest_run(self) -> RunResponse | None:
        return self._store.get_latest()

    def wait_for_run_change(
        self, run_id: str, after_version: int, timeout_seconds: float
    ) -> RunChange | None:
        return self._store.wait_for_change(run_id, after_version, timeout_seconds)

    def _load_strategy_data(
        self, submission: RunSubmission
    ) -> dict[str, StrategyDataLoad]:
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
                    batch = batch_loader(
                        shared=submission.config.shared,
                        strategies=tuple(eligible_strategies),
                        requirements={
                            strategy.id: tuple(requirements[strategy.id])
                            for strategy in eligible_strategies
                        },
                    )
                except Exception as error:
                    for strategy in eligible_strategies:
                        loaded[strategy.id] = StrategyDataLoad(
                            diagnostics=(_provider_diagnostic(strategy.id, error),)
                        )
                else:
                    for strategy in eligible_strategies:
                        strategy_load = batch.get(strategy.id)
                        if isinstance(strategy_load, StrategyDataLoad):
                            loaded[strategy.id] = strategy_load
                        else:
                            loaded[strategy.id] = StrategyDataLoad(
                                diagnostics=(
                                    _provider_diagnostic(
                                        strategy.id,
                                        ValueError(
                                            "batch data provider omitted strategy data"
                                        ),
                                    ),
                                )
                            )
            return self._mark_incompatible_contexts(loaded)

        for strategy in submission.config.strategies:
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
            except Exception as error:
                _LOGGER.warning(
                    "Strategy data load failed",
                    extra={
                        "event": "strategy_data_load_failed",
                        "strategy_id": strategy.id,
                        "exception_type": type(error).__name__,
                    },
                )
                loaded[strategy.id] = StrategyDataLoad(
                    diagnostics=(_provider_diagnostic(strategy.id, error),)
                )

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
            ):
                diagnostic = Diagnostic(
                    code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                    severity=DiagnosticSeverity.ERROR,
                    messageKey="data.run_context_mismatch",
                    fieldPath="run.symbol",
                    details={"strategyId": strategy_id},
                )
                loaded[strategy_id] = item.model_copy(
                    update={"diagnostics": _unique((*item.diagnostics, diagnostic))}
                )
        return loaded

    def _make_snapshot(
        self,
        run_id: str,
        submission: RunSubmission,
        data_loads: Mapping[str, StrategyDataLoad],
    ) -> RunSnapshot:
        calendars = tuple(
            item.calendar
            for item in data_loads.values()
            if item.calendar is not None and item.snapshot is not None
        )
        config = _resolve_latest_end(submission.config, calendars)
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
                }
                for strategy_id, item in sorted(data_loads.items())
            ],
        }
        return RunSnapshot(
            runId=run_id,
            config=config,
            catalogVersion=submission.catalog_version,
            dataFingerprint=_fingerprint(data_payload),
            engineVersion=submission.engine_version,
            dataProvenance=_data_provenance(data_loads),
        )

    def _queued_response(
        self, snapshot: RunSnapshot, submission: RunSubmission
    ) -> RunResponse:
        run_id = snapshot.run_id
        queued_runs = tuple(
            StrategyRun(
                id=strategy.id,
                presetId=strategy.preset_id,
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
        data_loads: Mapping[str, StrategyDataLoad],
    ) -> None:
        try:
            _LOGGER.info(
                "Run execution started",
                extra={
                    "event": "run_started",
                    "run_id": run_id,
                    "status": StrategyStatus.RUNNING.value,
                },
            )
            self._advance_all(run_id, StrategyStatus.LOADING)
            self._advance_all(run_id, StrategyStatus.RUNNING)
            response = self._store.get(run_id)
            if response is None:
                return
            config = response.snapshot.config
            reference_load = _reference_load(data_loads)
            baseline_input: MetricsInput | None = None

            if reference_load is None:
                unavailable = _context_failure(data_loads.values())
                for benchmark_id, _preset_id in _BENCHMARKS:
                    self._complete_run(
                        run_id,
                        benchmark_id,
                        _failure_outcome(unavailable),
                    )
            else:
                try:
                    dca_outcome, baseline_input = self._run_benchmark(
                        config,
                        reference_load,
                        benchmark_id=_BENCHMARKS[0][0],
                        preset_id=_BENCHMARKS[0][1],
                        dca_baseline=None,
                    )
                except Exception as error:
                    dca_outcome = _failure_outcome(
                        (
                            _calculation_diagnostic(
                                error, run_id=run_id, stage="monthly_dca"
                            ),
                        )
                    )
                    baseline_input = None
                self._complete_run(run_id, _BENCHMARKS[0][0], dca_outcome)
                try:
                    lump_outcome, _ = self._run_benchmark(
                        config,
                        reference_load,
                        benchmark_id=_BENCHMARKS[1][0],
                        preset_id=_BENCHMARKS[1][1],
                        dca_baseline=baseline_input,
                    )
                except Exception as error:
                    lump_outcome = _failure_outcome(
                        (
                            _calculation_diagnostic(
                                error, run_id=run_id, stage="lump_sum"
                            ),
                        )
                    )
                self._complete_run(run_id, _BENCHMARKS[1][0], lump_outcome)

            validation_by_id = {
                validation.strategy_id: validation
                for validation in submission.strategy_validations
            }
            for strategy in config.strategies:
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
                            baseline_input=baseline_input,
                        )
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

    def _run_benchmark(
        self,
        config: FrozenRunConfig,
        data_load: StrategyDataLoad,
        *,
        benchmark_id: str,
        preset_id: StrategyPresetId,
        dca_baseline: MetricsInput | None,
    ) -> tuple[_Outcome, MetricsInput | None]:
        strategy = _benchmark_strategy(self._catalog, benchmark_id, preset_id)
        if data_load.snapshot is None or data_load.calendar is None:
            return _failure_outcome(data_load.diagnostics), None
        benchmark_data = data_load.model_copy(
            update={
                "diagnostics": tuple(
                    diagnostic
                    for diagnostic in data_load.diagnostics
                    if diagnostic.severity is not DiagnosticSeverity.ERROR
                )
            }
        )
        outcome, metrics_input = self._run_basic_strategy(
            config,
            strategy,
            benchmark_data,
            dca_baseline=dca_baseline,
        )
        return outcome, metrics_input

    def _run_strategy(
        self,
        config: FrozenRunConfig,
        strategy: FrozenStrategyInstance,
        data_load: StrategyDataLoad,
        *,
        baseline_input: MetricsInput | None,
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
                    dca_baseline=baseline_input,
                )
            )
            return _search_outcome(result, data_load.diagnostics)

        return self._run_basic_strategy(
            config,
            strategy,
            data_load,
            dca_baseline=baseline_input,
        )[0]

    def _run_basic_strategy(
        self,
        config: FrozenRunConfig,
        strategy: FrozenStrategyInstance,
        data_load: StrategyDataLoad,
        *,
        dca_baseline: MetricsInput | None,
    ) -> tuple[_Outcome, MetricsInput | None]:
        assert data_load.snapshot is not None
        assert data_load.calendar is not None
        strategy_config = FrozenRunConfig(
            shared=config.shared,
            strategies=(strategy,),
        )
        contribution_schedule = schedule(config.shared, data_load.calendar)
        signal_batch = evaluate_signals(
            strategy_config,
            data_load.snapshot,
            sessions=data_load.calendar.trading_dates,
        )
        signals = signal_batch.strategy(strategy.id)
        ledger = run_strategy(
            strategy_config,
            strategy,
            contribution_schedule,
            data_load.snapshot,
            signals,
            exchange_calendar=data_load.calendar,
        )
        diagnostics = _unique(
            (
                *data_load.diagnostics,
                *contribution_schedule.diagnostics,
                *ledger.diagnostics,
            )
        )
        if not ledger.available:
            return (
                _Outcome(
                    status=StrategyStatus.UNAVAILABLE,
                    diagnostics=diagnostics,
                    signals=ledger.signals,
                    unexecuted_signals=ledger.unexecuted_signals,
                ),
                None,
            )

        metrics_input = MetricsInput(
            strategy=strategy,
            schedule=contribution_schedule,
            ledger=ledger,
            data_fingerprint=data_load.snapshot.fingerprint,
        )
        baseline = dca_baseline
        if strategy.preset_id is StrategyPresetId.MONTHLY_DCA and baseline is None:
            baseline = metrics_input
        metrics_result = calculate_metrics(metrics_input, dca_baseline=baseline)
        diagnostics = _unique((*diagnostics, *metrics_result.summary.diagnostics))
        outcome = _Outcome(
            status=(
                StrategyStatus.COMPLETED_WITH_WARNING
                if any(
                    diagnostic.severity is DiagnosticSeverity.WARNING
                    for diagnostic in diagnostics
                )
                else StrategyStatus.COMPLETED
            ),
            diagnostics=diagnostics,
            signals=ledger.signals,
            unexecuted_signals=ledger.unexecuted_signals,
            trades=ledger.trades,
            daily_assets=metrics_result.daily_assets,
            metrics=metrics_result.summary,
        )
        return outcome, metrics_input

    def _advance_all(self, run_id: str, target: StrategyStatus) -> None:
        response = self._store.get(run_id)
        if response is None or response.result is None:
            return
        updated_runs = tuple(
            item.with_status(target)
            for item in response.result.strategy_runs
            if not is_terminal(item.status)
        )
        terminal_runs = tuple(
            item for item in response.result.strategy_runs if is_terminal(item.status)
        )
        self._save_result(response, (*terminal_runs, *updated_runs))

    def _set_current(self, run_id: str, strategy_id: str) -> None:
        response = self._store.get(run_id)
        if response is None or response.result is None or response.progress is None:
            return
        completed = sum(
            is_terminal(item.status) for item in response.result.strategy_runs
        )
        self._store.update(
            response.model_copy(
                update={
                    "progress": response.progress.model_copy(
                        update={
                            "completed_strategies": completed,
                            "current_strategy_id": strategy_id,
                        }
                    )
                }
            )
        )

    def _clear_current(self, run_id: str) -> None:
        response = self._store.get(run_id)
        if response is None or response.progress is None:
            return
        completed = (
            0
            if response.result is None
            else sum(is_terminal(item.status) for item in response.result.strategy_runs)
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
            updated = item.model_copy(
                update={
                    "signals": outcome.signals,
                    "unexecuted_signals": outcome.unexecuted_signals,
                    "trades": outcome.trades,
                    "daily_assets": outcome.daily_assets,
                    "metrics": outcome.metrics,
                    "search_result": outcome.search_result,
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
                "diagnostic_codes": [item.code.value for item in outcome.diagnostics],
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
        response = self._store.get(run_id)
        if response is None or response.result is None:
            return
        failed = tuple(
            item.with_status(
                StrategyStatus.FAILED,
                diagnostics=_unique((*item.diagnostics, diagnostic)),
            )
            if not is_terminal(item.status)
            else item
            for item in response.result.strategy_runs
        )
        self._save_result(response, failed)


def _resolve_latest_end(
    config: FrozenRunConfig,
    calendars: Sequence[ExchangeCalendar],
) -> FrozenRunConfig:
    available_latest = tuple(
        calendar.latest_complete_date
        for calendar in calendars
        if calendar.latest_complete_date is not None
    )
    if not available_latest:
        return config
    if config.shared.run.end_mode is not EndMode.LATEST:
        return config
    latest = min(available_latest)
    if latest < config.shared.run.start_date:
        return config
    run_settings = config.shared.run.model_copy(
        update={"end_date": latest, "end_mode": EndMode.FIXED}
    )
    shared_settings = config.shared.model_copy(update={"run": run_settings})
    return config.model_copy(update={"shared": shared_settings})


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
        if item.snapshot.valuation is not None:
            sources.update(
                observation.source
                for observation in item.snapshot.valuation.observations
            )
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
    diagnostics = _unique(
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
    normalized = _unique(diagnostics)
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
    diagnostics = _unique(
        (
            *context_diagnostics,
            *(
                diagnostic
                for candidate in search_result.candidates
                for diagnostic in candidate.diagnostics
            ),
        )
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
    has_warnings = any(
        candidate.status is not StrategyStatus.COMPLETED
        for candidate in search_result.candidates
    ) or any(item.severity is DiagnosticSeverity.WARNING for item in diagnostics)
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


def _provider_diagnostic(strategy_id: str, error: Exception) -> Diagnostic:
    return Diagnostic(
        code=DiagnosticCode.PROVIDER_REQUEST_FAILED,
        severity=DiagnosticSeverity.ERROR,
        messageKey="data.provider_request_failed",
        fieldPath="run.symbol",
        details={"strategyId": strategy_id, "exceptionType": type(error).__name__},
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


def _unique(diagnostics: Iterable[Diagnostic]) -> tuple[Diagnostic, ...]:
    unique: list[Diagnostic] = []
    for diagnostic in diagnostics:
        if diagnostic not in unique:
            unique.append(diagnostic)
    return tuple(unique)


def _fingerprint(value: object) -> str:
    serialized = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

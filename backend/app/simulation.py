"""Pure shared signal → ledger → performance composition, without I/O."""

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import date
from itertools import groupby

from app.calendar import ExchangeCalendar, ScheduleResult
from app.domain.contracts import (
    DailyAsset,
    DataSnapshot,
    FrozenRunConfig,
    FrozenStrategyInstance,
    MetricSummary,
    ResultRole,
    SignalEvaluation,
    StrategyRun,
    TechnicalIndicatorSeries,
    Trade,
    UnexecutedSignal,
)
from app.domain.status import (
    Diagnostic,
    DiagnosticSeverity,
    StrategyStatus,
    unique_diagnostics,
)
from app.ledger import run_strategy
from app.metrics import MetricsInput, calculate_metrics
from app.signals import evaluate_signals
from app.signals.evaluate import StrategySignalSeries


@dataclass(frozen=True, slots=True)
class SimulationResult:
    status: StrategyStatus
    diagnostics: tuple[Diagnostic, ...] = ()
    signals: tuple[SignalEvaluation, ...] = ()
    technical_indicators: tuple[TechnicalIndicatorSeries, ...] = ()
    unexecuted_signals: tuple[UnexecutedSignal, ...] = ()
    trades: tuple[Trade, ...] = ()
    daily_assets: tuple[DailyAsset, ...] = ()
    metrics: MetricSummary | None = None

    def as_run(
        self,
        strategy: FrozenStrategyInstance,
        *,
        role: ResultRole = ResultRole.STRATEGY,
    ) -> StrategyRun:
        return StrategyRun(
            id=strategy.id,
            presetId=strategy.preset_id,
            instanceNumber=strategy.instance_number,
            role=role,
            status=self.status,
            diagnostics=self.diagnostics,
            signals=self.signals,
            technicalIndicators=self.technical_indicators,
            unexecutedSignals=self.unexecuted_signals,
            trades=self.trades,
            dailyAssets=self.daily_assets,
            metrics=self.metrics,
        )


def simulate_strategy(
    config: FrozenRunConfig,
    strategy: FrozenStrategyInstance,
    contribution_schedule: ScheduleResult,
    snapshot: DataSnapshot,
    exchange_calendar: ExchangeCalendar,
    *,
    diagnostics: Iterable[Diagnostic] = (),
    check_cancelled: Callable[[], None] | None = None,
    strategy_by_date: Mapping[date, FrozenStrategyInstance] | None = None,
) -> SimulationResult:
    """Keep validation, suppliers, exception handling and storage with callers."""
    if check_cancelled is not None:
        check_cancelled()
    strategy_config = FrozenRunConfig(shared=config.shared, strategies=(strategy,))
    series = (
        evaluate_signals(
            strategy_config, snapshot, sessions=exchange_calendar.trading_dates
        ).strategy(strategy.id)
        if strategy_by_date is None
        else _dated_signals(
            strategy_config,
            contribution_schedule,
            snapshot,
            exchange_calendar,
            strategy_by_date,
            check_cancelled,
        )
    )
    ledger = run_strategy(
        strategy_config,
        strategy,
        contribution_schedule,
        snapshot,
        series,
        exchange_calendar=exchange_calendar,
        check_cancelled=check_cancelled,
        strategy_by_date=strategy_by_date,
    )
    observed_diagnostics = unique_diagnostics(
        (
            *diagnostics,
            *contribution_schedule.diagnostics,
            *ledger.diagnostics,
        )
    )
    if not ledger.available:
        return SimulationResult(
            status=StrategyStatus.UNAVAILABLE,
            diagnostics=observed_diagnostics,
            signals=ledger.signals,
            technical_indicators=series.technical_indicators,
            unexecuted_signals=ledger.unexecuted_signals,
        )
    if check_cancelled is not None:
        check_cancelled()
    performance = calculate_metrics(
        MetricsInput(
            strategy=strategy,
            schedule=contribution_schedule,
            ledger=ledger,
            data_fingerprint=snapshot.fingerprint,
            analysis_settings=strategy_config.shared.analysis,
        )
    )
    observed_diagnostics = unique_diagnostics(
        (
            *observed_diagnostics,
            *performance.summary.diagnostics,
        )
    )
    return SimulationResult(
        status=StrategyStatus.COMPLETED_WITH_WARNING
        if any(
            row.severity is DiagnosticSeverity.WARNING for row in observed_diagnostics
        )
        else StrategyStatus.COMPLETED,
        diagnostics=observed_diagnostics,
        signals=ledger.signals,
        technical_indicators=series.technical_indicators,
        unexecuted_signals=ledger.unexecuted_signals,
        trades=ledger.trades,
        daily_assets=performance.daily_assets,
        metrics=performance.summary,
    )


def _dated_signals(
    config: FrozenRunConfig,
    contributions: ScheduleResult,
    snapshot: DataSnapshot,
    calendar: ExchangeCalendar,
    policies: Mapping[date, FrozenStrategyInstance],
    check_cancelled: Callable[[], None] | None,
) -> StrategySignalSeries:
    dates = contributions.trading_dates
    if set(policies) != set(dates):
        raise ValueError("dated rules must cover every simulated session")
    evaluations: list[SignalEvaluation] = []
    indicators: dict[tuple[str, int, object], TechnicalIndicatorSeries] = {}
    for strategy, group in groupby(dates, key=policies.__getitem__):
        if check_cancelled is not None:
            check_cancelled()
        days = tuple(group)
        run = config.shared.run.model_copy(
            update={"start_date": days[0], "end_date": days[-1]}
        )
        window = FrozenRunConfig(
            shared=config.shared.model_copy(update={"run": run}), strategies=(strategy,)
        )
        series = evaluate_signals(
            window, snapshot, sessions=calendar.trading_dates
        ).strategy(strategy.id)
        evaluations.extend(series.evaluations)
        for indicator in series.technical_indicators:
            key = (indicator.kind, indicator.period, indicator.deviations)
            existing = indicators.get(key)
            indicators[key] = (
                indicator
                if existing is None
                else indicator.model_copy(
                    update={"samples": (*existing.samples, *indicator.samples)}
                )
            )
    return StrategySignalSeries(
        strategyId=config.strategies[0].id,
        evaluations=tuple(evaluations),
        technicalIndicators=tuple(indicators.values()),
    )

"""Pure strategy ledger implementing the shared daily execution sequence."""

from calendar import monthrange
from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from app.calendar import ExchangeCalendar, ScheduleResult
from app.catalog.presets import ExecutionModule, get_preset_definition
from app.domain.contracts import (
    DailyAsset,
    DataSnapshot,
    FrozenRunConfig,
    FrozenStrategyInstance,
    MarketBar,
    SignalEvaluation,
    Trade,
    TradeReason,
    TradeSide,
    UnexecutedSignal,
    UnexecutedSignalReason,
)
from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    DiagnosticSeverity,
    SignalState,
)
from app.signals.evaluate import StrategySignalSeries

from .types import LedgerResult

LEDGER_METHOD_VERSION = "ledger-v2"


@dataclass(frozen=True, slots=True)
class _SellTrigger:
    signal_id: str
    ratio: Decimal


def run_strategy(
    config: FrozenRunConfig,
    strategy: FrozenStrategyInstance,
    contribution_schedule: ScheduleResult,
    snapshot: DataSnapshot,
    signals: StrategySignalSeries,
    *,
    exchange_calendar: ExchangeCalendar,
) -> LedgerResult:
    """Run one strategy over a frozen schedule and provider-neutral snapshot.

    Every decision is made from the close evaluation of the prior session.
    Fixed contributions happen before a pending sell; a sell transaction then
    suppresses same-session timing buys and the cash safety valve.
    """

    _require_matching_inputs(
        config, strategy, contribution_schedule, signals, exchange_calendar
    )
    preset = get_preset_definition(strategy.preset_id)
    if not signals.available:
        return _unavailable_result(strategy.id, signals, contribution_schedule)
    if (
        not contribution_schedule.trading_dates
        or contribution_schedule.total_amount <= 0
    ):
        return _unavailable_result(
            strategy.id,
            signals,
            contribution_schedule,
        )

    bar_by_date = _market_bars(snapshot)
    prices: dict[date, Decimal] = {}
    for day in contribution_schedule.trading_dates:
        bar = bar_by_date.get(day)
        if (
            bar is None
            or bar.symbol != config.shared.run.symbol
            or not bar.simulation_price.is_finite()
            or bar.simulation_price <= 0
        ):
            diagnostic = Diagnostic(
                code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                severity=DiagnosticSeverity.ERROR,
                messageKey="diagnostics.data.required_unavailable",
                fieldPath="run.symbol",
                asOf=day,
                details={"dataKind": "market", "strategyId": strategy.id},
            )
            return LedgerResult(
                strategyId=strategy.id,
                available=False,
                diagnostics=(diagnostic,),
                signals=signals.evaluations,
            )
        prices[day] = bar.simulation_price

    evaluation_by_key = {
        (evaluation.date, evaluation.signal_id): evaluation
        for evaluation in signals.evaluations
    }
    if len(evaluation_by_key) != len(signals.evaluations):
        raise ValueError("signal series contains duplicate date and signal IDs")
    signal_days = {evaluation.date for evaluation in signals.evaluations}
    if signal_days != set(contribution_schedule.trading_dates):
        raise ValueError("signal dates must match scheduled backtest sessions")

    contributions_by_date = {
        contribution.date: contribution.amount
        for contribution in contribution_schedule.contributions
    }
    month_end_dates = _actual_exchange_month_ends(exchange_calendar)
    currency = snapshot.market.currency
    params = strategy.params
    timing_cash = Decimal("0")
    timing_quantity = Decimal("0")
    fixed_quantity = Decimal("0")
    trades: list[Trade] = []
    daily_assets: list[DailyAsset] = []
    signal_buy_count_by_month: dict[tuple[int, int], int] = defaultdict(int)
    previous_day: date | None = None

    for day in contribution_schedule.trading_dates:
        price = prices[day]

        planned_amount = contributions_by_date.get(day, Decimal("0"))
        if preset.execution_module in {
            ExecutionModule.ACCUMULATION,
            ExecutionModule.SEARCH,
        }:
            timing_cash, fixed_quantity = _apply_accumulation_contribution(
                day,
                planned_amount,
                price,
                currency,
                strategy,
                timing_cash,
                fixed_quantity,
                trades,
            )
        elif preset.execution_module is ExecutionModule.SCHEDULED:
            funding_mode = str(params["scheduled.fundingMode"])
            if funding_mode == "upfront" and day == contribution_schedule.upfront_date:
                timing_cash += contribution_schedule.upfront_amount
                timing_cash, timing_quantity = _buy_all(
                    day,
                    TradeReason.UPFRONT,
                    None,
                    price,
                    currency,
                    timing_cash,
                    timing_quantity,
                    trades,
                )
            elif funding_mode == "monthly" and planned_amount > 0:
                timing_cash += planned_amount
                timing_cash, fixed_quantity = _buy_all(
                    day,
                    TradeReason.FIXED_DCA,
                    None,
                    price,
                    currency,
                    timing_cash,
                    fixed_quantity,
                    trades,
                )
            elif funding_mode not in {"monthly", "upfront"}:
                raise ValueError(f"unsupported scheduled funding mode: {funding_mode}")
        elif preset.execution_module is ExecutionModule.TREND:
            timing_cash += planned_amount
        elif planned_amount > 0:
            raise ValueError("unsupported contribution funding model")

        executed_sell = False
        if previous_day is not None:
            sell_triggers = _sell_triggers(
                strategy, preset.parameter_keys, previous_day, evaluation_by_key
            )
            if sell_triggers and timing_quantity > 0:
                maximum_ratio = max(trigger.ratio for trigger in sell_triggers)
                if maximum_ratio > 0:
                    signal_id = min(
                        trigger.signal_id
                        for trigger in sell_triggers
                        if trigger.ratio == maximum_ratio
                    )
                    quantity = timing_quantity * maximum_ratio
                    proceeds = quantity * price
                    timing_quantity -= quantity
                    timing_cash += proceeds
                    trades.append(
                        Trade(
                            date=day,
                            side=TradeSide.SELL,
                            reason=TradeReason.SIGNAL_SELL,
                            quantity=quantity,
                            price=price,
                            cashAmount=proceeds,
                            currency=currency,
                            signalId=signal_id,
                        )
                    )
                    executed_sell = True

            if not executed_sell:
                buy_signal_id = _buy_signal_id(preset.execution_module)
                if buy_signal_id is not None and _is_true(
                    evaluation_by_key.get((previous_day, buy_signal_id))
                ):
                    month_key = (day.year, day.month)
                    monthly_limit = _optional_integer_parameter(
                        params, "accumulation.maxSignalBuysPerMonth"
                    )
                    if (
                        monthly_limit is None
                        or signal_buy_count_by_month[month_key] < monthly_limit
                    ):
                        before_trades = len(trades)
                        timing_cash, timing_quantity = _buy_all(
                            day,
                            TradeReason.SIGNAL_BUY,
                            buy_signal_id,
                            price,
                            currency,
                            timing_cash,
                            timing_quantity,
                            trades,
                        )
                        if len(trades) > before_trades:
                            signal_buy_count_by_month[month_key] += 1

        if (
            not executed_sell
            and day in month_end_dates
            and preset.execution_module
            in {ExecutionModule.ACCUMULATION, ExecutionModule.SEARCH}
        ):
            safety_limit = _decimal_parameter(params, "accumulation.cashSafetyLimit")
            if timing_cash > 0 and timing_cash >= safety_limit:
                timing_cash, timing_quantity = _buy_all(
                    day,
                    TradeReason.SAFETY_VALVE,
                    None,
                    price,
                    currency,
                    timing_cash,
                    timing_quantity,
                    trades,
                )

        daily_assets.append(
            DailyAsset(
                date=day,
                cash=timing_cash,
                timingQuantity=timing_quantity,
                fixedQuantity=fixed_quantity,
                simulationOpen=bar_by_date[day].simulation_open,
                simulationHigh=bar_by_date[day].simulation_high,
                simulationLow=bar_by_date[day].simulation_low,
                simulationPrice=price,
                totalAsset=timing_cash + (timing_quantity + fixed_quantity) * price,
                currency=currency,
            )
        )
        previous_day = day

    unexecuted = _last_day_unexecuted_signals(
        strategy,
        preset.parameter_keys,
        contribution_schedule.trading_dates[-1],
        evaluation_by_key,
        preset.execution_module,
    )
    return LedgerResult(
        strategyId=strategy.id,
        diagnostics=contribution_schedule.diagnostics,
        signals=signals.evaluations,
        unexecutedSignals=unexecuted,
        trades=tuple(trades),
        dailyAssets=tuple(daily_assets),
    )


def _require_matching_inputs(
    config: FrozenRunConfig,
    strategy: FrozenStrategyInstance,
    contribution_schedule: ScheduleResult,
    signals: StrategySignalSeries,
    exchange_calendar: ExchangeCalendar,
) -> None:
    configured_strategy = next(
        (item for item in config.strategies if item.id == strategy.id), None
    )
    if configured_strategy != strategy:
        raise ValueError("strategy must be the matching frozen run configuration entry")
    if signals.strategy_id != strategy.id:
        raise ValueError("signal series belongs to a different strategy")
    if (
        contribution_schedule.requested_start_date != config.shared.run.start_date
        or contribution_schedule.requested_end_date != config.shared.run.end_date
    ):
        raise ValueError("contribution schedule does not match the frozen run dates")
    expected_sessions = tuple(
        day
        for day in exchange_calendar.trading_dates
        if config.shared.run.start_date <= day
        and contribution_schedule.effective_end_date is not None
        and day <= contribution_schedule.effective_end_date
    )
    if expected_sessions != contribution_schedule.trading_dates:
        raise ValueError("contribution schedule does not match the exchange calendar")


def _unavailable_result(
    strategy_id: str,
    signals: StrategySignalSeries,
    contribution_schedule: ScheduleResult,
) -> LedgerResult:
    diagnostics: list[Diagnostic] = []
    for diagnostic in (*signals.diagnostics, *contribution_schedule.diagnostics):
        if diagnostic not in diagnostics:
            diagnostics.append(diagnostic)
    if not diagnostics:
        diagnostics = [
            Diagnostic(
                code=DiagnosticCode.NO_VALID_CONTRIBUTION,
                severity=DiagnosticSeverity.ERROR,
                messageKey="calendar.no_valid_contribution",
                fieldPath="contribution.amount",
            )
        ]
    return LedgerResult(
        strategyId=strategy_id,
        available=False,
        diagnostics=tuple(diagnostics),
        signals=signals.evaluations,
    )


def _market_bars(snapshot: DataSnapshot) -> dict[date, MarketBar]:
    result: dict[date, MarketBar] = {}
    for bar in snapshot.market.bars:
        if bar.date in result:
            raise ValueError(f"duplicate market bar for {bar.date}")
        result[bar.date] = bar
    return result


def _apply_accumulation_contribution(
    day: date,
    amount: Decimal,
    price: Decimal,
    currency: str,
    strategy: FrozenStrategyInstance,
    timing_cash: Decimal,
    fixed_quantity: Decimal,
    trades: list[Trade],
) -> tuple[Decimal, Decimal]:
    fixed_enabled = strategy.params.get("accumulation.fixedDcaEnabled") is True
    fixed_ratio = (
        _decimal_parameter(strategy.params, "accumulation.fixedDcaRatio")
        if fixed_enabled
        else Decimal("0")
    )
    fixed_amount = amount * fixed_ratio
    timing_cash += amount - fixed_amount
    if fixed_amount > 0:
        shares = fixed_amount / price
        fixed_quantity += shares
        trades.append(
            Trade(
                date=day,
                side=TradeSide.BUY,
                reason=TradeReason.FIXED_DCA,
                quantity=shares,
                price=price,
                cashAmount=fixed_amount,
                currency=currency,
            )
        )
    return timing_cash, fixed_quantity


def _buy_all(
    day: date,
    reason: TradeReason,
    signal_id: str | None,
    price: Decimal,
    currency: str,
    cash: Decimal,
    quantity_held: Decimal,
    trades: list[Trade],
) -> tuple[Decimal, Decimal]:
    if cash <= 0:
        return cash, quantity_held
    quantity = cash / price
    trades.append(
        Trade(
            date=day,
            side=TradeSide.BUY,
            reason=reason,
            quantity=quantity,
            price=price,
            cashAmount=cash,
            currency=currency,
            signalId=signal_id,
        )
    )
    return Decimal("0"), quantity_held + quantity


def _sell_triggers(
    strategy: FrozenStrategyInstance,
    parameter_keys: tuple[str, ...],
    signal_date: date,
    evaluations: Mapping[tuple[date, str], SignalEvaluation],
) -> tuple[_SellTrigger, ...]:
    params = strategy.params
    triggers: list[_SellTrigger] = []
    if "exit.enabled" in parameter_keys and params.get("exit.enabled") is True:
        if "exit.vix.low1" in parameter_keys:
            if _is_true(evaluations.get((signal_date, "vix.exit.low2"))):
                triggers.append(
                    _SellTrigger(
                        "vix.exit.low2",
                        _decimal_parameter(params, "exit.vix.ratio2"),
                    )
                )
            elif _is_true(evaluations.get((signal_date, "vix.exit.low1"))):
                triggers.append(
                    _SellTrigger(
                        "vix.exit.low1",
                        _decimal_parameter(params, "exit.vix.ratio1"),
                    )
                )
        if params.get("exit.rsi.enabled") is True and _is_true(
            evaluations.get((signal_date, "rsi.exit"))
        ):
            triggers.append(
                _SellTrigger(
                    "rsi.exit",
                    _decimal_parameter(params, "exit.rsi.ratio"),
                )
            )
        if (
            params.get("exit.bollinger.enabled") is True
            and _is_true(evaluations.get((signal_date, "bollinger.exit")))
            and _is_true(evaluations.get((signal_date, "bollinger.exit.vix")))
        ):
            triggers.append(
                _SellTrigger(
                    "bollinger.exit",
                    _decimal_parameter(params, "exit.bollinger.ratio"),
                )
            )
    elif params.get("trend.sellBelowOrEqualMa") is True and _is_true(
        evaluations.get((signal_date, "ma.trend.sell"))
    ):
        triggers.append(_SellTrigger("ma.trend.sell", Decimal("1")))
    return tuple(triggers)


def _buy_signal_id(module: ExecutionModule) -> str | None:
    if module in {ExecutionModule.ACCUMULATION, ExecutionModule.SEARCH}:
        return "accumulation.buy"
    if module is ExecutionModule.TREND:
        return "ma.trend"
    return None


def _last_day_unexecuted_signals(
    strategy: FrozenStrategyInstance,
    parameter_keys: tuple[str, ...],
    last_day: date,
    evaluations: Mapping[tuple[date, str], SignalEvaluation],
    module: ExecutionModule,
) -> tuple[UnexecutedSignal, ...]:
    signal_ids: set[str] = set()
    buy_signal_id = _buy_signal_id(module)
    if buy_signal_id is not None and _is_true(
        evaluations.get((last_day, buy_signal_id))
    ):
        signal_ids.add(buy_signal_id)
    signal_ids.update(
        trigger.signal_id
        for trigger in _sell_triggers(strategy, parameter_keys, last_day, evaluations)
    )
    return tuple(
        UnexecutedSignal(
            signalDate=last_day,
            signalId=signal_id,
            reason=UnexecutedSignalReason.NO_FOLLOWING_BACKTEST_SESSION,
        )
        for signal_id in sorted(signal_ids)
    )


def _actual_exchange_month_ends(calendar: ExchangeCalendar) -> frozenset[date]:
    sessions_by_month: dict[tuple[int, int], list[date]] = defaultdict(list)
    for day in calendar.trading_dates:
        sessions_by_month[(day.year, day.month)].append(day)
    month_ends = set()
    for (year, month), sessions in sessions_by_month.items():
        last_calendar_day = date(year, month, monthrange(year, month)[1])
        if calendar.calendar_coverage_end_date >= last_calendar_day:
            month_ends.add(sessions[-1])
    return frozenset(month_ends)


def _is_true(evaluation: SignalEvaluation | None) -> bool:
    return evaluation is not None and evaluation.state is SignalState.TRUE


def _decimal_parameter(params: Mapping[str, object], key: str) -> Decimal:
    value = params.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        raise ValueError(f"{key} must be numeric")
    number = Decimal(str(value))
    if not number.is_finite() or number < 0:
        raise ValueError(f"{key} must be a non-negative finite number")
    return number


def _optional_integer_parameter(params: Mapping[str, object], key: str) -> int | None:
    value = params.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{key} must be an integer or None")
    return value

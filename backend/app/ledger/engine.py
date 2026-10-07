"""Pure strategy ledger implementing the shared daily execution sequence."""

from calendar import monthrange
from collections import defaultdict
from collections.abc import Callable, Mapping
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
from app.domain.execution import ExecutionSettings, TradingCosts
from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    DiagnosticSeverity,
    SignalState,
)
from app.signals.evaluate import StrategySignalSeries

from .execution import execute_trade
from .types import LedgerResult

LEDGER_METHOD_VERSION = "ledger-v7"


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
    check_cancelled: Callable[[], None] | None = None,
    strategy_by_date: Mapping[date, FrozenStrategyInstance] | None = None,
) -> LedgerResult:
    """Run one strategy over a frozen schedule and provider-neutral snapshot.

    Every decision is made from the close evaluation of the prior session.
    Fixed contributions happen before a pending sell; a sell transaction then
    suppresses same-session timing buys and the cash safety valve.
    """

    _require_matching_inputs(
        config, strategy, contribution_schedule, signals, exchange_calendar
    )
    if strategy_by_date is not None and (
        set(strategy_by_date) != set(contribution_schedule.trading_dates)
        or any(
            policy.id != strategy.id or policy.preset_id != strategy.preset_id
            for policy in strategy_by_date.values()
        )
    ):
        raise ValueError("dated rules require complete sessions and stable identity")
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
        if check_cancelled is not None:
            check_cancelled()
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
    timing_cash = Decimal("0")
    timing_quantity = Decimal("0")
    timing_cost_basis = Decimal("0")
    fixed_quantity = Decimal("0")
    trades: list[Trade] = []
    daily_assets: list[DailyAsset] = []
    signal_buy_count_by_month: dict[tuple[int, int], int] = defaultdict(int)
    previous_day: date | None = None

    for day in contribution_schedule.trading_dates:
        if check_cancelled is not None:
            check_cancelled()
        price = prices[day]
        current_strategy = (
            strategy if strategy_by_date is None else strategy_by_date[day]
        )
        params = current_strategy.params
        trade_start = len(trades)
        quantity_before_fills = timing_quantity + fixed_quantity

        planned_amount = contributions_by_date.get(day, Decimal("0"))
        if preset.execution_module in {
            ExecutionModule.ACCUMULATION,
            ExecutionModule.SEARCH,
        }:
            timing_cash += planned_amount
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
                    config.shared.execution,
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
                    config.shared.execution,
                )
            elif funding_mode not in {"monthly", "upfront"}:
                raise ValueError(f"unsupported scheduled funding mode: {funding_mode}")
        elif preset.execution_module is ExecutionModule.TREND:
            timing_cash += planned_amount
        elif planned_amount > 0:
            raise ValueError("unsupported contribution funding model")

        executed_sell = False
        if previous_day is not None:
            previous_strategy = (
                strategy if strategy_by_date is None else strategy_by_date[previous_day]
            )
            sell_triggers = _sell_triggers(
                previous_strategy,
                preset.parameter_keys,
                previous_day,
                evaluation_by_key,
            )
            if sell_triggers and timing_quantity > 0:
                maximum_ratio = max(trigger.ratio for trigger in sell_triggers)
                if maximum_ratio > 0:
                    signal_id = min(
                        trigger.signal_id
                        for trigger in sell_triggers
                        if trigger.ratio == maximum_ratio
                    )
                    trade = execute_trade(
                        day=day,
                        side=TradeSide.SELL,
                        reason=TradeReason.SIGNAL_SELL,
                        signal_id=signal_id,
                        base_price=price,
                        currency=currency,
                        cash=timing_cash,
                        held_quantity=timing_quantity + fixed_quantity,
                        sell_quantity=timing_quantity * maximum_ratio,
                        settings=config.shared.execution,
                        average_cost=timing_cost_basis / timing_quantity,
                    )
                    if trade is not None:
                        timing_cost_basis = (
                            Decimal(0)
                            if trade.quantity == timing_quantity
                            else timing_cost_basis
                            * (timing_quantity - trade.quantity)
                            / timing_quantity
                        )
                        timing_quantity -= trade.quantity
                        timing_cash += trade.cash_amount
                        trades.append(trade)
                        executed_sell = True

            if not executed_sell:
                buy_signal_id = _buy_signal_id(preset.execution_module)
                buy_evaluation = (
                    evaluation_by_key.get((previous_day, buy_signal_id))
                    if buy_signal_id is not None
                    else None
                )
                if buy_signal_id is not None and _is_true(buy_evaluation):
                    month_key = (day.year, day.month)
                    monthly_limit = _optional_integer_parameter(
                        previous_strategy.params, "accumulation.maxSignalBuysPerMonth"
                    )
                    if (
                        monthly_limit is None
                        or signal_buy_count_by_month[month_key] < monthly_limit
                    ):
                        before_trades = len(trades)
                        timing_cash, timing_quantity = _buy_all(
                            day,
                            TradeReason.SIGNAL_BUY,
                            _buy_trade_signal_id(buy_evaluation, buy_signal_id),
                            price,
                            currency,
                            timing_cash,
                            timing_quantity,
                            trades,
                            config.shared.execution,
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
                    config.shared.execution,
                )

        # Walk fills in their saved execution order, retaining each intermediate
        # account value (not the end-of-day balance or the slippage fill price).
        quantity_after_fill = quantity_before_fills
        for trade_index in range(trade_start, len(trades)):
            trade = trades[trade_index]
            quantity_after_fill += (
                trade.quantity if trade.side is TradeSide.BUY else -trade.quantity
            )
            assert trade.cash_after is not None
            trades[trade_index] = trade.model_copy(
                update={
                    "total_asset_after": trade.cash_after + quantity_after_fill * price
                }
            )

        timing_cost_basis += sum(
            (
                trade.cash_amount
                for trade in trades[trade_start:]
                if trade.side is TradeSide.BUY
                and trade.reason is not TradeReason.FIXED_DCA
            ),
            Decimal(0),
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
                tradingCosts=TradingCosts.aggregate(
                    trade.trading_costs
                    for trade in trades[trade_start:]
                    if trade.trading_costs is not None
                ),
            )
        )
        previous_day = day

    unexecuted = _last_day_unexecuted_signals(
        current_strategy,
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


def _buy_all(
    day: date,
    reason: TradeReason,
    signal_id: str | None,
    price: Decimal,
    currency: str,
    cash: Decimal,
    quantity_held: Decimal,
    trades: list[Trade],
    settings: ExecutionSettings | None,
) -> tuple[Decimal, Decimal]:
    trade = execute_trade(
        day=day,
        side=TradeSide.BUY,
        reason=reason,
        signal_id=signal_id,
        base_price=price,
        currency=currency,
        cash=cash,
        held_quantity=quantity_held,
        settings=settings,
    )
    if trade is None:
        return cash, quantity_held
    trades.append(trade)
    assert trade.cash_after is not None and trade.quantity_after is not None
    return trade.cash_after, trade.quantity_after


def _sell_triggers(
    strategy: FrozenStrategyInstance,
    parameter_keys: tuple[str, ...],
    signal_date: date,
    evaluations: Mapping[tuple[date, str], SignalEvaluation],
) -> tuple[_SellTrigger, ...]:
    combined = evaluations.get((signal_date, "conditions.sell"))
    if combined is not None:
        if (
            _is_true(combined)
            and combined.sell_ratio is not None
            and combined.sell_ratio > 0
        ):
            return (
                _SellTrigger(
                    combined.triggered_signal_ids[0]
                    if combined.triggered_signal_ids
                    else combined.signal_id,
                    combined.sell_ratio,
                ),
            )
        return ()
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


def _buy_trade_signal_id(evaluation: SignalEvaluation | None, fallback: str) -> str:
    """Keep the actual leaf for a single trigger; never invent one for a group."""
    if evaluation is not None and len(evaluation.triggered_signal_ids) == 1:
        return evaluation.triggered_signal_ids[0]
    return fallback


def _last_day_unexecuted_signals(
    strategy: FrozenStrategyInstance,
    parameter_keys: tuple[str, ...],
    last_day: date,
    evaluations: Mapping[tuple[date, str], SignalEvaluation],
    module: ExecutionModule,
) -> tuple[UnexecutedSignal, ...]:
    signal_ids: set[str] = set()
    buy_signal_id = _buy_signal_id(module)
    buy_evaluation = (
        evaluations.get((last_day, buy_signal_id))
        if buy_signal_id is not None
        else None
    )
    if buy_signal_id is not None and _is_true(buy_evaluation):
        signal_ids.update(
            buy_evaluation.triggered_signal_ids
            if buy_evaluation is not None and buy_evaluation.triggered_signal_ids
            else (buy_signal_id,)
        )
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

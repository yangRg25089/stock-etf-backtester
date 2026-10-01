from decimal import Decimal

from app.calendar import ExchangeCalendar, schedule
from app.catalog.service import get_catalog
from app.config.validation import validate_draft
from app.domain.status import SignalState
from app.ledger import run_strategy
from app.runs.yahoo_data import _indicator_lookback, _macro_key
from app.signals.evaluate import evaluate_signals
from tests.signals.test_evaluate import _SESSIONS, _snapshot


def leaf(node_id, kind, params=None, enabled=True):
    return {
        "type": "condition",
        "id": node_id,
        "kind": kind,
        "enabled": enabled,
        "params": params or {},
    }


def group(node_id, operator, *children, enabled=True):
    return {
        "type": "group",
        "id": node_id,
        "operator": operator,
        "enabled": enabled,
        "children": children,
    }


def config(buy, sell=None):
    validation = validate_draft(
        {
            "shared": {
                "run": {
                    "symbol": "QQQ",
                    "startDate": _SESSIONS[2],
                    "endDate": _SESSIONS[-1],
                    "endMode": "fixed",
                }
            },
            "strategies": [
                {
                    "id": "custom",
                    "presetId": "composite_dca",
                    "enabled": True,
                    "params": {"accumulation.fixedDcaEnabled": False},
                    "rules": {"buy": buy, "sell": sell},
                }
            ],
        }
    )
    frozen = validation.config_for()
    assert frozen is not None, validation.diagnostics_for()
    return frozen, validation


def test_nested_buy_rules_use_independent_thresholds_and_parentheses():
    buy = group(
        "entry",
        "AND",
        leaf("trend", "ma_trend", {"ma.period": 2}),
        group(
            "volatility",
            "OR",
            leaf("vix25", "vix", {"vix.buyThreshold": 25}),
            leaf("vix35", "vix", {"vix.buyThreshold": 35}),
        ),
    )
    frozen, _ = config(buy)
    snapshot = _snapshot(
        ("10", "11", "12", "13", "14", "15", "16"),
        vix_values={day: "30" for day in _SESSIONS[2:]},
    )
    series = evaluate_signals(frozen, snapshot, sessions=_SESSIONS).strategies[0]
    signals = {
        item.signal_id: item for item in series.evaluations if item.date == _SESSIONS[2]
    }
    assert series.available
    assert signals["accumulation.buy"].state is SignalState.TRUE
    assert signals["vix.buy:vix25"].state is SignalState.TRUE
    assert signals["vix.buy:vix35"].state is SignalState.FALSE
    assert signals["vix.buy:vix25"].observed_value == Decimal("30")


def test_or_does_not_hide_missing_enabled_data_and_disabled_groups_need_no_data():
    for disabled in (False, True):
        buy = group(
            "entry",
            "OR",
            leaf("vix", "vix"),
            group("optional", "AND", leaf("valuation", "pe"), enabled=not disabled),
        )
        frozen, validation = config(buy)
        snapshot = _snapshot(
            ("10",) * 7, vix_values={day: "30" for day in _SESSIONS[2:]}
        )
        series = evaluate_signals(frozen, snapshot, sessions=_SESSIONS).strategies[0]
        aggregate = next(
            item
            for item in series.evaluations
            if item.date == _SESSIONS[2] and item.signal_id == "accumulation.buy"
        )
        assert aggregate.state is (
            SignalState.TRUE if disabled else SignalState.UNAVAILABLE
        )
        assert series.available is disabled
        assert (
            any(item.kind.value == "valuation" for item in validation.data_requirements)
            is not disabled
        )


def test_sell_tree_uses_maximum_ratio_only_when_the_whole_group_is_true():
    for threshold, hit in ((70, True), (100, True), (100, False)):
        sell = group(
            "exit",
            "AND",
            leaf("volatility", "vix", {"exit.vix.low1": 12, "exit.vix.low2": 10}),
            leaf(
                "strength",
                "rsi",
                {
                    "rsi.period": 2,
                    "exit.rsi.threshold": threshold,
                    "exit.rsi.ratio": Decimal("0.8"),
                },
            ),
        )
        frozen, _ = config(None, sell)
        snapshot = _snapshot(
            ("10", "11", "12", "13", "14", "15", "16"),
            vix_values={day: "9" if hit else "15" for day in _SESSIONS[2:]},
        )
        series = evaluate_signals(frozen, snapshot, sessions=_SESSIONS).strategies[0]
        aggregate = next(
            item
            for item in series.evaluations
            if item.date == _SESSIONS[2] and item.signal_id == "conditions.sell"
        )
        assert aggregate.state is (SignalState.TRUE if hit else SignalState.FALSE)
        assert aggregate.sell_ratio == (Decimal("0.8") if hit else Decimal("0"))


def test_empty_buy_group_is_false_instead_of_vacuously_true():
    frozen, validation = config(group("empty", "AND"))
    assert {item.signal_id for item in validation.data_requirements} == {"market.price"}
    series = evaluate_signals(
        frozen, _snapshot(("10",) * 7), sessions=_SESSIONS
    ).strategies[0]
    assert series.available
    assert all(
        item.state is SignalState.FALSE
        for item in series.evaluations
        if item.signal_id == "accumulation.buy"
    )


def test_leaf_dependencies_keep_independent_periods_codes_and_units():
    frozen, validation = config(
        group(
            "root",
            "OR",
            leaf("short", "ma_trend", {"ma.period": 2}),
            leaf("long", "ma_trend", {"ma.period": 200}),
            leaf("rsi", "rsi", {"rsi.period": 250}),
            leaf("nasdaq", "vix", {"vix.symbol": "^VXN"}),
            leaf("yield", "rate", {"rate.sourceUnit": "decimal"}),
            group(
                "off", "AND", leaf("unused", "rsi", {"rsi.period": 300}), enabled=False
            ),
        )
    )
    strategy = frozen.strategies[0]
    requirements = validation.data_requirements
    assert _indicator_lookback(strategy, requirements, get_catalog()) == 251
    assert {item.condition_id for item in requirements} == {
        None,
        "short",
        "long",
        "rsi",
        "nasdaq",
        "yield",
    }
    assert _macro_key(
        strategy, next(item for item in requirements if item.condition_id == "nasdaq")
    ) == ("^VXN", "index", "index_points")
    assert _macro_key(
        strategy, next(item for item in requirements if item.condition_id == "yield")
    ) == ("^TNX", "rate", "decimal")


def test_each_pe_leaf_checks_its_own_etf_coverage_minimum():
    frozen, _ = config(
        group(
            "pe",
            "OR",
            leaf("covered", "pe", {"pe.etfMinCoverage": Decimal("0.6")}),
            leaf("incomplete", "pe", {"pe.etfMinCoverage": Decimal("0.9")}),
        )
    )
    snapshot = _snapshot(("10",) * 7, pe_values={day: "20" for day in _SESSIONS[2:]})
    valuation = snapshot.valuation
    assert valuation is not None
    snapshot = snapshot.model_copy(
        update={
            "valuation": valuation.model_copy(
                update={
                    "observations": tuple(
                        item.model_copy(
                            update={
                                "coverage": Decimal("0.8"),
                                "method": "etf_equity_earnings_yield",
                            }
                        )
                        for item in valuation.observations
                    )
                }
            )
        }
    )
    series = evaluate_signals(frozen, snapshot, sessions=_SESSIONS).strategies[0]
    signals = {
        item.signal_id: item for item in series.evaluations if item.date == _SESSIONS[2]
    }
    assert signals["pe.buy:covered"].state is SignalState.TRUE
    assert signals["pe.buy:incomplete"].state is SignalState.UNAVAILABLE
    assert signals["accumulation.buy"].state is SignalState.UNAVAILABLE
    assert (
        signals["pe.buy:incomplete"].diagnostics[0].details["minimumCoverage"] == "0.9"
    )


def test_nested_sell_rules_control_actual_next_day_trades():
    for operator, expected_sells in (("AND", 0), ("OR", 3)):
        frozen, _ = config(
            leaf("entry", "vix", {"vix.buyThreshold": 25}),
            group(
                "exit",
                operator,
                leaf(
                    "profit",
                    "rsi",
                    {
                        "rsi.period": 2,
                        "exit.rsi.threshold": 70,
                        "exit.rsi.ratio": Decimal("0.8"),
                    },
                ),
                leaf("volatility", "vix"),
            ),
        )
        # Fund on Jan 3; buy from that close on Jan 4, then sell on Jan 5.
        frozen = frozen.model_copy(
            update={
                "shared": frozen.shared.model_copy(
                    update={
                        "contribution": frozen.shared.contribution.model_copy(
                            update={"day": 3}
                        )
                    }
                )
            }
        )
        snapshot = _snapshot(
            ("10", "11", "12", "13", "14", "15", "16"),
            vix_values={day: "30" for day in _SESSIONS[2:]},
        )
        calendar = ExchangeCalendar.from_dates(
            _SESSIONS,
            as_of_date=_SESSIONS[-1],
            latest_complete_date=_SESSIONS[-1],
            calendar_coverage_end_date=_SESSIONS[-1],
        )
        result = run_strategy(
            frozen,
            frozen.strategies[0],
            schedule(frozen.shared, calendar),
            snapshot,
            evaluate_signals(frozen, snapshot, sessions=_SESSIONS).strategies[0],
            exchange_calendar=calendar,
        )
        assert result.available
        buys = [item for item in result.trades if item.side.value == "buy"]
        sells = [item for item in result.trades if item.side.value == "sell"]
        assert buys[0].date == _SESSIONS[3]
        assert buys[0].price == Decimal("13")
        assert len(sells) == expected_sells
        if sells:
            assert sells[0].date == _SESSIONS[4]
            assert sells[0].quantity == buys[0].quantity * Decimal("0.8")

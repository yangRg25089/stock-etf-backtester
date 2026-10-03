"""Exhaustive strict-missing logic, nested exits and input-order invariance."""

from datetime import date
from decimal import Decimal
from itertools import permutations, product

import pytest

from app.domain.conditions import ConditionLogic
from app.domain.contracts import SignalEvaluation
from app.domain.status import Diagnostic, SignalState
from app.signals.conditions import combine_conditions

DAY = date(2024, 2, 29)
T, F, U = SignalState.TRUE, SignalState.FALSE, SignalState.UNAVAILABLE
# Explicit domain truth tables: an enabled missing dependency always dominates.
TABLES = {
    ConditionLogic.AND: {
        (T, T): T,
        (T, F): F,
        (F, T): F,
        (F, F): F,
        (T, U): U,
        (U, T): U,
        (F, U): U,
        (U, F): U,
        (U, U): U,
    },
    ConditionLogic.OR: {
        (T, T): T,
        (T, F): T,
        (F, T): T,
        (F, F): F,
        (T, U): U,
        (U, T): U,
        (F, U): U,
        (U, F): U,
        (U, U): U,
    },
}
RATIOS = tuple(map(Decimal, ("0.125", "0.333333", "0.8", "1")))


def _leaf(index, state):
    identity = f"source-{index}"
    return SignalEvaluation(
        date=DAY,
        signalId=identity,
        state=state,
        sellRatio=RATIOS[index],
        triggeredSignalIds=(identity,) if state is T else (),
        diagnostics=(
            Diagnostic(
                code="required_data_unavailable",
                messageKey="diagnostics.data.required_unavailable",
                fieldPath=f"conditions.{identity}",
                asOf=DAY,
                source=f"fixture-{index}",
                details={"observation": identity},
            ),
        )
        if state is U
        else (),
    )


def _expected(operator, children):
    state = T if operator is ConditionLogic.AND else F
    for child_state, _ratio, _identity in children:
        state = TABLES[operator][state, child_state]
    if state is not T:
        return state, None if state is U else Decimal(0), ()
    winners = [row for row in children if row[0] is T]
    winner = sorted(winners, key=lambda row: row[1], reverse=True)[0]
    return state, winner[1], winner[2]


def _assert(result, expected, leaves, case):
    assert (result.state, result.sell_ratio, result.triggered_signal_ids) == expected, (
        case
    )
    assert result.date == DAY
    if result.state is U:
        assert {row.field_path: row for row in result.diagnostics} == {
            row.field_path: row for leaf in leaves for row in leaf.diagnostics
        }, case
        assert all(
            row.as_of == DAY and row.source and row.details
            for row in result.diagnostics
        )
    else:
        assert result.diagnostics == (), case


@pytest.mark.parametrize("operator", tuple(ConditionLogic))
def test_three_leaf_truth_tables_and_six_permutations(operator):
    for states in product((T, F, U), repeat=3):
        leaves = tuple(_leaf(index, state) for index, state in enumerate(states))
        expected = _expected(
            operator,
            tuple(
                (leaf.state, leaf.sell_ratio, leaf.triggered_signal_ids)
                for leaf in leaves
            ),
        )
        for order in permutations(leaves):
            actual = combine_conditions(DAY, "root", operator, order)
            _assert(actual, expected, leaves, (operator, states, order))


@pytest.mark.parametrize("operators", tuple(product(tuple(ConditionLogic), repeat=3)))
def test_nested_four_leaf_states_preserve_maximum_exit_and_all_missing_reasons(
    operators,
):
    root_op, left_op, right_op = operators
    for states in product((T, F, U), repeat=4):
        leaves = tuple(_leaf(index, state) for index, state in enumerate(states))
        raw = tuple(
            (leaf.state, leaf.sell_ratio, leaf.triggered_signal_ids) for leaf in leaves
        )
        expected = _expected(
            root_op,
            (
                _expected(left_op, raw[:2]),
                _expected(right_op, raw[2:]),
            ),
        )
        for reverse_left, reverse_right in product((False, True), repeat=2):
            left = leaves[:2][::-1] if reverse_left else leaves[:2]
            right = leaves[2:][::-1] if reverse_right else leaves[2:]
            groups = (
                combine_conditions(DAY, "left", left_op, left),
                combine_conditions(DAY, "right", right_op, right),
            )
            for order in (groups, groups[::-1]):
                actual = combine_conditions(DAY, "root", root_op, order)
                _assert(
                    actual,
                    expected,
                    leaves,
                    (operators, states, reverse_left, reverse_right),
                )


@pytest.mark.parametrize("operator", tuple(ConditionLogic))
def test_empty_condition_groups_never_trigger(operator):
    result = combine_conditions(DAY, "empty", operator, ())
    _assert(result, (F, Decimal(0), ()), (), operator)

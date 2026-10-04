"""Keep tree orchestration separate from atomic market/indicator evaluation."""

import ast
import inspect

from app.signals import evaluate as module
from app.signals import evaluate_signals


def test_signal_tree_delegates_atomic_condition_evaluation() -> None:
    tree = ast.parse(inspect.getsource(module._evaluate_strategy))
    names = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
    assert "evaluate_leaf" in names
    assert "ConditionKind" not in names
    assert evaluate_signals is module.evaluate_signals


def test_signal_orchestration_does_not_load_supplier_data() -> None:
    tree = ast.parse(inspect.getsource(module))
    imports = {
        node.module
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module
    }
    assert not any("providers" in name or "yahoo" in name for name in imports)

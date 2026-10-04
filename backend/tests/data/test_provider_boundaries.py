"""Supplier I/O must hand raw responses to a pure normalization boundary."""

import ast
import inspect

from app.data.providers.yahoo import YahooFinanceAdapter
from app.runs.yahoo_data import YahooRunDataProvider


def test_yahoo_market_loading_delegates_response_normalization() -> None:
    source = inspect.getsource(YahooFinanceAdapter.load)
    assert "normalize_market_frame(" in source
    assert "frame.iterrows()" not in source

    macro_source = inspect.getsource(YahooFinanceAdapter.load_macro)
    assert "normalize_macro_frame(" in macro_source
    assert "frame.iterrows()" not in macro_source


def test_run_planning_does_not_load_supplier_data() -> None:
    from app.data import run_planning

    tree = ast.parse(inspect.getsource(run_planning))
    imports = {
        node.module
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module
    }
    assert not any("providers" in name or "yahoo" in name for name in imports)


def test_run_loading_delegates_calendar_and_effective_interval_planning() -> None:
    source = inspect.getsource(YahooRunDataProvider.load_for_run)
    assert "plan_market_request(" in source
    assert "resolve_market_request(" in source
    assert "completed_before_request =" not in source
    assert "quote_dates =" not in source

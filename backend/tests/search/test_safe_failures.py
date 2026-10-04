import pytest

from app.search import run_grid_search
from tests.search.test_walk_forward import source


@pytest.mark.parametrize(
    "module,stage",
    [
        ("app.search.walk_forward", "walk_forward_oos"),
        ("app.search.evaluation", "search_period_baseline"),
        ("app.search.engine", "search_candidate"),
    ],
)
def test_public_search_failures_keep_private_exception_context_only_in_logs(
    monkeypatch, caplog, module, stage
):
    def failure(*args, **kwargs):
        raise RuntimeError("password=private-message")

    monkeypatch.setattr(f"{module}.simulate_strategy", failure)
    outcome = run_grid_search(source())
    public = outcome.model_dump_json()
    assert "exceptionType" not in public
    assert "RuntimeError" not in public
    assert "password=private-message" not in public
    assert stage in public
    assert any(record.exception_type == "RuntimeError" for record in caplog.records)
    diagnostics = [d for row in outcome.period_benchmarks for d in row.diagnostics]
    if outcome.out_of_sample:
        diagnostics.extend(outcome.out_of_sample.diagnostics)
    diagnostics.extend(d for row in outcome.candidates for d in row.diagnostics)
    assert diagnostics and all(d.field_path != "strategies[0]" for d in diagnostics)

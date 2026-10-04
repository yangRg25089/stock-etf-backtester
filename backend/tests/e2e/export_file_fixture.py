"""Produce portable fixture files and CSV oracles for frontend contract tests."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.api.runs import _build_submission
from app.api.types import RunSubmissionRequest
from app.catalog.service import get_catalog
from app.export.csv import ExportKind, export_csv
from app.export.packages import build_backtest_package
from app.runs.manager import RunManager
from app.runs.store import InMemoryRunStore
from e2e.fixture_provider import (
    ImmediateExecutor,
    WalkForwardFixtureProvider,
    create_fixture_run_manager,
)

manager = create_fixture_run_manager(immediate=True)
catalog = get_catalog()
submission = _build_submission(
    RunSubmissionRequest(
        draft={
            "shared": {
                "run": {
                    "symbol": "QQQ",
                    "startDate": "2024-02-01",
                    "endDate": "2024-03-01",
                },
                "contribution": {"amount": 100, "day": 1},
            },
            "strategies": [
                {
                    "id": "file-vix",
                    "presetId": "vix_dca",
                    "params": {"vix.buyThreshold": "not-numeric"}
                    if "--partial" in sys.argv
                    else {},
                },
                {
                    "id": "file-grid",
                    "presetId": "grid_search",
                    "params": {
                        "search.dimensions": ["vix.buyThreshold"],
                        "search.values.vix.buyThreshold": [20, 30],
                        **(
                            {
                                "search.optimizationMode": "train_test",
                                "search.trainEndDate": "2024-02-28",
                            }
                            if "--train-test" in sys.argv
                            else {}
                        ),
                    },
                    "rules": {
                        "buy": {
                            "type": "condition",
                            "id": "grid-buy",
                            "kind": "vix",
                            "params": {"vix.symbol": "^VIX", "vix.buyThreshold": 25},
                        },
                        "sell": None,
                    },
                },
            ],
        },
        scope="all_enabled",
    ),
    catalog,
)
if "--walk-forward" in sys.argv:
    provider = WalkForwardFixtureProvider()
    manager = RunManager(
        store=InMemoryRunStore(), data_provider=provider, executor=ImmediateExecutor()
    )
    submission = _build_submission(
        RunSubmissionRequest(
            draft=provider.source.config.model_dump(mode="json", by_alias=True),
            scope="all_enabled",
        ),
        catalog,
    )
accepted = manager.submit_run(submission, idempotency_key="file-fixture")
run = manager.get_run(accepted.run_id)
assert run is not None and run.result is not None
package = build_backtest_package(
    run, lambda key: manager.get_candidate(run.run_id, key)
)
assert package.candidate_details, run.result.strategy_runs[0].diagnostics
exports = {}
for result in (*run.result.strategy_runs, *package.candidate_details.values()):
    focused_run = run.model_copy(
        update={"result": run.result.model_copy(update={"strategy_runs": (result,)})}
    )
    for kind in ExportKind:
        if kind is ExportKind.SEARCH_RESULTS and result.search_result is None:
            continue
        if result.metrics is not None:
            exports[f"{result.id}/{kind.value}"] = export_csv(
                focused_run, kind=kind, focused_result_id=result.id
            )
print(
    json.dumps(
        {"package": package.model_dump(mode="json", by_alias=True), "csv": exports}
    )
)

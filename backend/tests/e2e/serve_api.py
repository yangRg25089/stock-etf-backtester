"""Start the API with the pinned fixture provider for browser acceptance tests."""

from __future__ import annotations

import os
import sys
from importlib import import_module
from pathlib import Path

import uvicorn

BACKEND_ROOT = Path(__file__).resolve().parents[2]
TESTS_ROOT = BACKEND_ROOT / "tests"
sys.path.insert(0, str(BACKEND_ROOT))
sys.path.insert(0, str(TESTS_ROOT))

app = import_module("app.main").app
create_fixture_run_manager = import_module(
    "e2e.fixture_provider"
).create_fixture_run_manager

app.state.run_service = create_fixture_run_manager(immediate=False)


if __name__ == "__main__":
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=int(os.environ.get("BACKTESTER_E2E_API_PORT", "8123")),
        log_level="warning",
    )

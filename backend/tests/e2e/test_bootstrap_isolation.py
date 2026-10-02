"""Browser fixture startup must leave a configured user run database alone."""

import os
import runpy
import subprocess
import sys
from pathlib import Path


def test_browser_fixture_import_does_not_open_configured_user_database(tmp_path):
    database = tmp_path / "user-runs.sqlite3"
    sentinel = b"user database must never be opened by fixture startup"
    database.write_bytes(sentinel)
    response = subprocess.run(
        [
            sys.executable,
            "-c",
            "import tests.e2e.serve_api; from app.main import _run_store_path; "
            "assert str(_run_store_path()) == ':memory:'",
        ],
        env={**os.environ, "STOCK_ETF_BACKTESTER_RUN_STORE_PATH": str(database)},
        capture_output=True,
        text=True,
        check=False,
    )
    assert response.returncode == 0, response.stderr
    assert database.read_bytes() == sentinel


def test_openapi_generation_does_not_open_configured_user_database(
    tmp_path, monkeypatch
):
    database = tmp_path / "user-runs.sqlite3"
    sentinel = b"user database must never be opened by schema generation"
    database.write_bytes(sentinel)
    monkeypatch.setenv("STOCK_ETF_BACKTESTER_RUN_STORE_PATH", str(database))
    generator = (
        Path(__file__).resolve().parents[3] / "frontend/scripts/generate_api_types.py"
    )
    namespace = runpy.run_path(str(generator))
    schemas = namespace["_load_schemas"]()
    assert "technicalIndicators" in schemas["StrategyRun"]["properties"]
    assert database.read_bytes() == sentinel

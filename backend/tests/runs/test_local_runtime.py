"""The application runtime owns no database and cannot restore a previous process."""

import os
import subprocess
import sys


def test_default_application_does_not_create_a_configured_run_database(tmp_path):
    database = tmp_path / "never-created.sqlite3"
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from app.main import app; from app.runs.store import InMemoryRunStore; "
            "assert isinstance(app.state.run_service._store, InMemoryRunStore)",
        ],
        env={**os.environ, "STOCK_ETF_BACKTESTER_RUN_STORE_PATH": str(database)},
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert not database.exists()

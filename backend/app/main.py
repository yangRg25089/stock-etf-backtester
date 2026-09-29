import os
from pathlib import Path
from typing import Literal

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel

from app.api.catalog import router as catalog_router
from app.api.errors import (
    APIException,
    api_exception_handler,
    request_validation_exception_handler,
)
from app.api.export import router as export_router
from app.api.runs import router as runs_router
from app.runs.data import UnconfiguredRunDataProvider
from app.runs.manager import RunManager
from app.runs.sqlite_store import SQLiteRunStore


class HealthResponse(BaseModel):
    status: Literal["ok"]


def _run_store_path() -> Path:
    configured_path = os.environ.get("STOCK_ETF_BACKTESTER_RUN_STORE_PATH")
    if configured_path:
        return Path(configured_path).expanduser()
    repository_root = Path(__file__).resolve().parents[2]
    return repository_root / ".local" / "runs.sqlite3"


app = FastAPI(
    title="Stock ETF Backtester API",
    version="0.1.0",
    description="Local-only API for the stock and ETF backtester.",
)
app.include_router(catalog_router)
app.include_router(runs_router)
app.include_router(export_router)
app.add_exception_handler(APIException, api_exception_handler)
app.add_exception_handler(RequestValidationError, request_validation_exception_handler)
app.state.run_service = RunManager(
    store=SQLiteRunStore(_run_store_path()),
    data_provider=UnconfiguredRunDataProvider(),
)


@app.get("/health", response_model=HealthResponse, tags=["system"])
def health() -> HealthResponse:
    """Report whether the local API process is ready to accept requests."""
    return HealthResponse(status="ok")

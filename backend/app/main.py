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
from app.runs.store import InMemoryRunStore


class HealthResponse(BaseModel):
    status: Literal["ok"]


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
    store=InMemoryRunStore(),
    data_provider=UnconfiguredRunDataProvider(),
)


@app.get("/health", response_model=HealthResponse, tags=["system"])
def health() -> HealthResponse:
    """Report whether the local API process is ready to accept requests."""
    return HealthResponse(status="ok")

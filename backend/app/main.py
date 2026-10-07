import os
from collections.abc import Mapping
from pathlib import Path
from typing import Literal

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel
from starlette.responses import PlainTextResponse
from starlette.staticfiles import StaticFiles

from app.api.catalog import router as catalog_router
from app.api.errors import (
    APIException,
    api_exception_handler,
    request_validation_exception_handler,
)
from app.api.export import router as export_router
from app.api.runs import router as runs_router
from app.runs.manager import RunManager
from app.runs.store import InMemoryRunStore
from app.runs.yahoo_data import YahooRunDataProvider
from app.security import PublicAccessMiddleware


class HealthResponse(BaseModel):
    status: Literal["ok"]


def create_app(environment: Mapping[str, str] | None = None) -> FastAPI:
    """Create the local or production app from its explicit runtime settings."""
    settings = os.environ if environment is None else environment
    public = settings.get("STOCK_ETF_BACKTESTER_SERVE_FRONTEND") == "1"
    app = FastAPI(
        title="Stock ETF Backtester API",
        version="0.1.0",
        description=(
            "Historical backtesting API for local or public single-instance use."
        ),
        docs_url=None if public else "/docs",
        redoc_url=None if public else "/redoc",
    )
    app.include_router(catalog_router)
    app.include_router(runs_router)
    app.include_router(export_router)
    app.add_exception_handler(APIException, api_exception_handler)
    app.add_exception_handler(
        RequestValidationError, request_validation_exception_handler
    )
    app.state.run_service = RunManager(
        store=InMemoryRunStore(),
        data_provider=YahooRunDataProvider(),
    )

    @app.get("/health", response_model=HealthResponse, tags=["system"])
    def health() -> HealthResponse:
        """Report whether the API process is ready to accept requests."""
        return HealthResponse(status="ok")

    @app.get("/robots.txt", include_in_schema=False)
    def robots() -> PlainTextResponse:
        return PlainTextResponse("User-agent: *\nDisallow: /\n")

    if public:
        app.add_middleware(
            PublicAccessMiddleware,
            trust_render_proxy=(
                settings.get("RENDER") == "true"
                and settings.get("STOCK_ETF_BACKTESTER_TRUST_RENDER_PROXY") == "1"
            ),
        )

    if public:
        configured_dir = Path(
            settings.get("STOCK_ETF_BACKTESTER_FRONTEND_DIR", "frontend/dist")
        )
        repository_root = Path(__file__).resolve().parents[2]
        frontend_dir = configured_dir
        if not frontend_dir.is_absolute():
            frontend_dir = repository_root / frontend_dir
        if not frontend_dir.is_dir():
            raise RuntimeError(
                f"frontend build directory does not exist: {frontend_dir}"
            )
        app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")

    return app


app = create_app()

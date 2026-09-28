from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: Literal["ok"]


app = FastAPI(
    title="Stock ETF Backtester API",
    version="0.1.0",
    description="Local-only API for the stock and ETF backtester.",
)


@app.get("/health", response_model=HealthResponse, tags=["system"])
def health() -> HealthResponse:
    """Report whether the local API process is ready to accept requests."""
    return HealthResponse(status="ok")

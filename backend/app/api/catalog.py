"""Read-only catalog and generated OpenAPI contract endpoints."""

from fastapi import APIRouter, Request

from app.catalog.service import Catalog, get_catalog

from .types import ContractVersionResponse

router = APIRouter(prefix="/api/v1", tags=["catalog"])


@router.get("/catalog", response_model=Catalog)
def read_catalog() -> Catalog:
    """Return the complete parameter registry and all strategy presets."""

    return get_catalog()


@router.get("/contracts", response_model=ContractVersionResponse)
def read_contract_version(request: Request) -> ContractVersionResponse:
    """Identify the generated OpenAPI contract currently served by this app."""

    return ContractVersionResponse.from_openapi(request.app.openapi())

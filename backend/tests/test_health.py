import asyncio

import httpx

from app.main import app


async def _get_health() -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get("/health")


def test_health_endpoint_reports_service_ready() -> None:
    response = asyncio.run(_get_health())

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}

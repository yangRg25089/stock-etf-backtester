"""Public production frontend serving, headers, and abuse controls."""

import asyncio
from pathlib import Path

import httpx
import pytest

from app.main import create_app


def _get(
    app: object,
    path: str,
) -> httpx.Response:
    async def send() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)  # type: ignore[arg-type]
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
            return await client.get(path)

    return asyncio.run(send())


def _production_environment(frontend_dir: Path, **values: str) -> dict[str, str]:
    return {
        "STOCK_ETF_BACKTESTER_SERVE_FRONTEND": "1",
        "STOCK_ETF_BACKTESTER_FRONTEND_DIR": str(frontend_dir),
        **values,
    }


def _write_frontend(frontend_dir: Path) -> None:
    (frontend_dir / "assets").mkdir(parents=True)
    (frontend_dir / "index.html").write_text(
        '<!doctype html><script type="module" src="/assets/app.js"></script>',
        encoding="utf-8",
    )
    (frontend_dir / "assets" / "app.js").write_text("document.body", encoding="utf-8")


def test_production_app_serves_frontend_health_catalog_and_assets(
    tmp_path: Path,
) -> None:
    frontend_dir = tmp_path / "dist"
    _write_frontend(frontend_dir)
    app = create_app(_production_environment(frontend_dir))

    assert _get(app, "/").status_code == 200
    assert _get(app, "/health").json() == {"status": "ok"}
    assert _get(app, "/api/v1/catalog").status_code == 200
    asset = _get(app, "/assets/app.js")
    assert asset.status_code == 200
    assert asset.text == "document.body"


def test_production_paths_are_public_and_discourage_crawlers(
    tmp_path: Path,
) -> None:
    frontend_dir = tmp_path / "dist"
    _write_frontend(frontend_dir)
    app = create_app(_production_environment(frontend_dir))

    assert _get(app, "/health").status_code == 200
    for path in ("/", "/assets/app.js", "/api/v1/catalog"):
        response = _get(app, path)
        assert response.status_code == 200
        assert "www-authenticate" not in response.headers
        assert "noindex" in response.headers["x-robots-tag"]
        assert response.headers["x-content-type-options"] == "nosniff"
    assert _get(app, "/robots.txt").text == "User-agent: *\nDisallow: /\n"
    assert _get(app, "/docs").status_code == 404


def test_production_invalid_submissions_share_the_execution_budget(
    tmp_path: Path,
) -> None:
    frontend_dir = tmp_path / "dist"
    _write_frontend(frontend_dir)
    app = create_app(_production_environment(frontend_dir))

    async def send() -> None:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            for _ in range(5):
                assert (await client.post("/api/v1/runs", json={})).status_code == 422
            assert (await client.post("/api/v1/runs", json={})).status_code == 429
            assert (await client.get("/health")).status_code == 200

    asyncio.run(send())


def test_enabling_frontend_requires_an_existing_build_directory(tmp_path: Path) -> None:
    environment = _production_environment(tmp_path / "missing")

    with pytest.raises(RuntimeError, match="frontend build directory"):
        create_app(environment)


def test_no_auth_variables_keeps_local_app_unauthenticated() -> None:
    app = create_app({"STOCK_ETF_BACKTESTER_SERVE_FRONTEND": "0"})

    assert _get(app, "/health").status_code == 200
    assert _get(app, "/api/v1/catalog").status_code == 200

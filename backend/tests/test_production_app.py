"""Production-only frontend serving and optional shared authentication."""

import asyncio
from pathlib import Path

import httpx
import pytest

from app.main import create_app


def _get(
    app: object,
    path: str,
    *,
    auth: tuple[str, str] | None = None,
) -> httpx.Response:
    async def send() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)  # type: ignore[arg-type]
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
            return await client.get(path, auth=auth)

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


@pytest.mark.parametrize(
    ("configured", "missing"),
    [
        ({"APP_BASIC_AUTH_USERNAME": "friend"}, "APP_BASIC_AUTH_PASSWORD"),
        ({"APP_BASIC_AUTH_PASSWORD": "secret"}, "APP_BASIC_AUTH_USERNAME"),
    ],
)
def test_one_basic_auth_variable_fails_app_creation(
    configured: dict[str, str], missing: str
) -> None:
    environment = {"STOCK_ETF_BACKTESTER_SERVE_FRONTEND": "0", **configured}

    with pytest.raises(ValueError, match=missing):
        create_app(environment)


def test_basic_auth_protects_frontend_api_and_assets_but_not_health(
    tmp_path: Path,
) -> None:
    frontend_dir = tmp_path / "dist"
    _write_frontend(frontend_dir)
    app = create_app(
        _production_environment(
            frontend_dir,
            APP_BASIC_AUTH_USERNAME="friends",
            APP_BASIC_AUTH_PASSWORD="shared secret",
        )
    )

    assert _get(app, "/health").status_code == 200
    for path in ("/", "/assets/app.js", "/api/v1/catalog", "/docs"):
        response = _get(app, path)
        assert response.status_code == 401
        assert response.headers["www-authenticate"].startswith("Basic ")
        assert "shared secret" not in response.text

    assert _get(app, "/", auth=("friends", "shared secret")).status_code == 200
    assert (
        _get(app, "/assets/app.js", auth=("friends", "shared secret")).status_code
        == 200
    )
    assert (
        _get(app, "/api/v1/catalog", auth=("friends", "shared secret")).status_code
        == 200
    )
    assert _get(app, "/", auth=("friends", "wrong")).status_code == 401


def test_enabling_frontend_requires_an_existing_build_directory(tmp_path: Path) -> None:
    environment = _production_environment(tmp_path / "missing")

    with pytest.raises(RuntimeError, match="frontend build directory"):
        create_app(environment)


def test_no_auth_variables_keeps_local_app_unauthenticated() -> None:
    app = create_app({"STOCK_ETF_BACKTESTER_SERVE_FRONTEND": "0"})

    assert _get(app, "/health").status_code == 200
    assert _get(app, "/api/v1/catalog").status_code == 200

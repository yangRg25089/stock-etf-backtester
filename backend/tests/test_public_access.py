"""HTTP abuse boundaries, with a fake clock and no provider calls."""

import asyncio
from collections.abc import AsyncIterator
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from fastapi import FastAPI, Request

from app.security import PublicAccessMiddleware, SlidingWindowLimiter, client_ip


def test_rolling_window_does_not_reset_at_a_wall_clock_minute() -> None:
    clock = [59.0]
    limiter = SlidingWindowLimiter(5, clock=lambda: clock[0])
    for _ in range(5):
        assert limiter.consume("visitor") is None
    clock[0] = 60.0
    assert limiter.consume("visitor") == 59
    clock[0] = 118.9
    assert limiter.consume("visitor") == 1
    clock[0] = 119.0
    assert limiter.consume("visitor") is None


def test_other_ips_are_independent_and_active_entries_are_not_evicted() -> None:
    clock = [0.0]
    limiter = SlidingWindowLimiter(1, max_keys=2, clock=lambda: clock[0])
    assert limiter.consume("a") is None
    assert limiter.consume("b") is None
    assert limiter.consume("c") == 60
    assert limiter.consume("a") == 60
    clock[0] = 60.0
    assert limiter.consume("c") is None
    assert limiter.consume("a") is None


def test_parallel_requests_cannot_overrun_the_per_ip_budget() -> None:
    limiter = SlidingWindowLimiter(5, clock=lambda: 0.0)
    with ThreadPoolExecutor(max_workers=12) as executor:
        answers = list(executor.map(lambda _: limiter.consume("same"), range(50)))
    assert answers.count(None) == 5
    assert answers.count(60) == 45


@pytest.mark.parametrize(
    ("headers", "render", "expected"),
    [
        ([(b"x-forwarded-for", b"1.2.3.4")], False, "203.0.113.9"),
        ([(b"cf-connecting-ip", b"1.2.3.4")], False, "203.0.113.9"),
        ([(b"cf-connecting-ip", b"1.2.3.4")], True, "1.2.3.4"),
        ([(b"cf-connecting-ip", b"2001:db8:0:0::1")], True, "2001:db8::1"),
        ([(b"cf-connecting-ip", b"::ffff:1.2.3.4")], True, "1.2.3.4"),
        ([(b"cf-connecting-ip", b"invalid")], True, "unverified-render-client"),
        ([(b"x-forwarded-for", b"1.2.3.4, 5.6.7.8")], True, "unverified-render-client"),
        (
            [(b"cf-connecting-ip", b"1.2.3.4, 5.6.7.8")],
            True,
            "unverified-render-client",
        ),
        (
            [(b"cf-connecting-ip", b"1.2.3.4"), (b"cf-connecting-ip", b"5.6.7.8")],
            True,
            "unverified-render-client",
        ),
    ],
)
def test_ip_source_is_explicit_and_validated(
    headers: list[tuple[bytes, bytes]], render: bool, expected: str
) -> None:
    assert (
        client_ip(
            {"client": ("203.0.113.9", 123), "headers": headers},
            trust_render_proxy=render,
        )
        == expected
    )


def _guarded_app(**options: object) -> FastAPI:
    app = FastAPI()
    app.state.submissions = 0

    @app.post("/api/v1/runs", status_code=202)
    async def submit(request: Request) -> dict[str, object]:
        app.state.submissions += 1
        return {"body": (await request.body()).decode()}

    @app.get("/api/v1/catalog")
    def catalog() -> dict[str, str]:
        return {"catalog": "ok"}

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/v1/instruments/{symbol}")
    def instrument(symbol: str) -> dict[str, str]:
        return {"symbol": symbol}

    @app.get("/robots.txt")
    def robots() -> dict[str, str]:
        return {"robots": "ok"}

    app.add_middleware(PublicAccessMiddleware, **options)
    return app


def test_sixth_submission_is_429_without_creating_a_job_or_blocking_reads() -> None:
    app = _guarded_app()

    async def send() -> None:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            for _ in range(5):
                assert (
                    await client.post("/api/v1/runs", content="{}")
                ).status_code == 202
            rejected = await client.post("/api/v1/runs", content="{}")
            assert rejected.status_code == 429
            seconds = rejected.json()["error"]["retryAfterSeconds"]
            assert 1 <= seconds <= 60
            assert rejected.headers["retry-after"] == str(seconds)
            assert rejected.json()["error"]["code"] == "rate_limited"
            assert rejected.headers["cache-control"] == "no-store"
            assert "noindex" in rejected.headers["x-robots-tag"]
            assert app.state.submissions == 5
            assert (await client.get("/api/v1/catalog")).status_code == 200
            assert (await client.get("/health")).status_code == 200

    asyncio.run(send())


def test_changing_untrusted_forwarding_headers_does_not_reset_the_budget() -> None:
    app = _guarded_app()

    async def send() -> None:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            for number in range(6):
                result = await client.post(
                    "/api/v1/runs",
                    headers={
                        "X-Forwarded-For": f"198.51.100.{number + 1}",
                        "CF-Connecting-IP": f"198.51.100.{number + 1}",
                    },
                )
                assert result.status_code == (202 if number < 5 else 429)

    asyncio.run(send())


def test_global_submission_budget_bounds_requests_from_many_ips() -> None:
    app = _guarded_app(trust_render_proxy=True)

    async def send() -> None:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            for number in range(21):
                result = await client.post(
                    "/api/v1/runs",
                    headers={
                        "CF-Connecting-IP": f"198.51.100.{number + 1}",
                    },
                )
                assert result.status_code == (202 if number < 20 else 429)
            assert app.state.submissions == 20

    asyncio.run(send())


def test_general_api_budget_and_health_exemption() -> None:
    app = _guarded_app()

    async def send() -> None:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            for _ in range(240):
                assert (await client.get("/api/v1/catalog")).status_code == 200
            assert (await client.get("/api/v1/catalog")).status_code == 429
            assert (await client.get("/health")).status_code == 200
            assert (await client.get("/robots.txt")).status_code == 200

    asyncio.run(send())


def test_metadata_budget_is_shared_across_symbols_but_does_not_block_catalog() -> None:
    app = _guarded_app()

    async def send() -> None:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            for number in range(20):
                assert (
                    await client.get(f"/api/v1/instruments/TEST{number}")
                ).status_code == 200
            assert (await client.get("/api/v1/instruments/QQQ")).status_code == 429
            assert (await client.get("/api/v1/catalog")).status_code == 200

    asyncio.run(send())


def test_body_limit_accepts_the_boundary_and_refuses_declared_oversize() -> None:
    app = _guarded_app()

    async def send() -> None:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            accepted = await client.post("/api/v1/runs", content=b"a" * 1024 * 1024)
            assert accepted.status_code == 202
            assert len(accepted.json()["body"]) == 1024 * 1024
            assert (
                await client.post("/api/v1/runs", content=b"a" * (1024 * 1024 + 1))
            ).status_code == 413
            assert app.state.submissions == 1

    asyncio.run(send())


def test_oversized_body_is_rejected_even_without_content_length() -> None:
    app = _guarded_app()

    async def chunks() -> AsyncIterator[bytes]:
        yield b"x" * (1024 * 1024)
        yield b"x"

    async def send() -> None:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            rejected = await client.post("/api/v1/runs", content=chunks())
            assert rejected.status_code == 413
            assert rejected.json()["error"]["code"] == "request_too_large"
            assert app.state.submissions == 0

    asyncio.run(send())


@pytest.mark.parametrize(
    "agent", ["Googlebot/2.1", "bingbot", "Scrapy/2", "Crawler", "Spider"]
)
def test_simple_crawlers_are_refused_but_can_read_robots_and_health(agent: str) -> None:
    app = _guarded_app()

    async def send() -> None:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
            headers={"User-Agent": agent},
        ) as client:
            assert (await client.get("/api/v1/catalog")).status_code == 403
            assert (await client.post("/api/v1/runs")).status_code == 403
            assert (await client.get("/robots.txt")).status_code == 200
            assert (await client.get("/health")).status_code == 200
            assert app.state.submissions == 0

    asyncio.run(send())

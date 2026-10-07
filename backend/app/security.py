"""Bounded abuse controls for the public, single-process deployment."""

from __future__ import annotations

import math
from collections import OrderedDict, deque
from collections.abc import Callable, Mapping
from ipaddress import IPv6Address, ip_address
from threading import Lock
from time import monotonic

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.api.types import APIError, APIErrorResponse

_BODY_LIMIT = 1024 * 1024
_CRAWLER_MARKERS = (b"bot", b"spider", b"crawler", b"scrapy")
_MESSAGES = {
    "rate_limited": "api.errors.rate_limited",
    "crawler_disallowed": "api.errors.crawler_disallowed",
    "invalid_request": "api.errors.invalid_request",
    "request_too_large": "api.errors.request_too_large",
}
_HEADERS = {
    b"x-robots-tag": b"noindex, nofollow, noarchive",
    b"x-content-type-options": b"nosniff",
    b"x-frame-options": b"DENY",
    b"referrer-policy": b"same-origin",
    b"content-security-policy": (
        b"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        b"img-src 'self' data: blob:; object-src 'none'; base-uri 'self'; "
        b"frame-ancestors 'none'; form-action 'self'"
    ),
}


class SlidingWindowLimiter:
    """Atomic rolling quota with expiry and no eviction of active counters."""

    def __init__(
        self,
        limit: int,
        *,
        max_keys: int = 4096,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        if limit < 1 or max_keys < 1:
            raise ValueError("rate limit and key capacity must be positive")
        self._limit = limit
        self._max_keys = max_keys
        self._clock = clock
        self._entries: OrderedDict[str, deque[float]] = OrderedDict()
        self._lock = Lock()

    def consume(self, key: str) -> int | None:
        """Return retry seconds on refusal; None reserves one request."""
        with self._lock:
            now = self._clock()
            cutoff = now - 60.0
            # Accepted requests move their entry to the end, so expiry is ordered.
            while self._entries:
                oldest = next(iter(self._entries.values()))
                if oldest[-1] > cutoff:
                    break
                self._entries.popitem(last=False)
            entry = self._entries.get(key)
            if entry is None:
                if len(self._entries) >= self._max_keys:
                    oldest = next(iter(self._entries.values()))
                    return max(1, math.ceil(oldest[-1] + 60.0 - now))
                entry = deque()
                self._entries[key] = entry
            while entry and entry[0] <= cutoff:
                entry.popleft()
            if len(entry) >= self._limit:
                return max(1, math.ceil(entry[0] + 60.0 - now))
            entry.append(now)
            self._entries.move_to_end(key)
            return None


def _canonical_ip(value: str) -> str | None:
    try:
        # Zone identifiers must not split one visitor's quota.
        if "%" in value:
            return None
        address = ip_address(value.strip())
    except ValueError:
        return None
    if isinstance(address, IPv6Address) and address.ipv4_mapped is not None:
        return str(address.ipv4_mapped)
    return str(address)


def client_ip(scope: Mapping[str, object], *, trust_render_proxy: bool) -> str:
    """Use the edge-overwritten header only in the explicit Render deployment.

    All public Render inbound traffic passes through Cloudflare. XFF's first
    entry may be client-supplied. Invalid edge identities share one quota rather
    than varying by load-balancer address. Local requests ignore proxy headers.
    """
    if trust_render_proxy:
        headers = scope.get("headers", ())
        assert isinstance(headers, (list, tuple))
        values = [
            value for name, value in headers if name.lower() == b"cf-connecting-ip"
        ]
        if len(values) == 1:
            identity = _canonical_ip(values[0].decode("latin-1"))
            if identity is not None:
                return identity
        return "unverified-render-client"
    peer = scope.get("client")
    if isinstance(peer, (tuple, list)) and peer:
        return _canonical_ip(str(peer[0])) or "unknown-client"
    return "unknown-client"


class PublicAccessMiddleware:
    """Guard HTTP work before parsing, provider requests or queue access."""

    def __init__(self, app: ASGIApp, *, trust_render_proxy: bool = False) -> None:
        self.app = app
        self._trust_render_proxy = trust_render_proxy
        self._api = SlidingWindowLimiter(240)
        self._runs = SlidingWindowLimiter(5)
        self._instruments = SlidingWindowLimiter(20)
        self._global_runs = SlidingWindowLimiter(20, max_keys=1)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def secured_send(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", ()))
                present = {name.lower() for name, _ in headers}
                headers.extend(
                    (key, value)
                    for key, value in _HEADERS.items()
                    if key not in present
                )
                message = {**message, "headers": headers}
            await send(message)

        path = scope["path"]
        if path in ("/health", "/robots.txt"):
            await self.app(scope, receive, secured_send)
            return
        agents = [
            value.lower()
            for name, value in scope["headers"]
            if name.lower() == b"user-agent"
        ]
        if any(marker in agent for marker in _CRAWLER_MARKERS for agent in agents):
            await self._reject(scope, receive, secured_send, 403, "crawler_disallowed")
            return
        if not path.startswith("/api/"):
            await self.app(scope, receive, secured_send)
            return
        ip = client_ip(scope, trust_render_proxy=self._trust_render_proxy)
        quotas = [(self._api, ip)]
        if path.rstrip("/") == "/api/v1/runs" and scope["method"] == "POST":
            quotas.extend(((self._runs, ip), (self._global_runs, "all")))
        if path.startswith("/api/v1/instruments/"):
            quotas.append((self._instruments, ip))
        for limiter, key in quotas:
            retry = limiter.consume(key)
            if retry is not None:
                await self._reject(
                    scope, receive, secured_send, 429, "rate_limited", retry
                )
                return

        if scope["method"] in ("POST", "PUT", "PATCH"):
            lengths = [
                value
                for name, value in scope["headers"]
                if name.lower() == b"content-length"
            ]
            if lengths and (len(lengths) != 1 or not lengths[0].isdigit()):
                await self._reject(scope, receive, secured_send, 400, "invalid_request")
                return
            declared = lengths[0].lstrip(b"0") or b"0" if lengths else b"0"
            if len(declared) > 7 or int(declared) > _BODY_LIMIT:
                await self._reject(
                    scope, receive, secured_send, 413, "request_too_large"
                )
                return
            buffered = bytearray()
            size = 0
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                chunk = message.get("body", b"")
                size += len(chunk)
                if size > _BODY_LIMIT:
                    await self._reject(
                        scope, receive, secured_send, 413, "request_too_large"
                    )
                    return
                buffered.extend(chunk)
                if not message.get("more_body", False):
                    break
            body = bytes(buffered)
            delivered = False
            original_receive = receive

            async def replay() -> Message:
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": body, "more_body": False}
                return await original_receive()

            receive = replay
        await self.app(scope, receive, secured_send)

    @staticmethod
    async def _reject(
        scope: Scope,
        receive: Receive,
        send: Send,
        status: int,
        code: str,
        retry: int | None = None,
    ) -> None:
        body = APIErrorResponse(
            error=APIError(
                code=code,
                messageKey=_MESSAGES[code],
                retryAfterSeconds=retry,
            )
        )
        headers = {"Cache-Control": "no-store"}
        if retry is not None:
            headers["Retry-After"] = str(retry)
        response = JSONResponse(
            status_code=status,
            headers=headers,
            content=body.model_dump(mode="json", by_alias=True),
        )
        await response(scope, receive, send)

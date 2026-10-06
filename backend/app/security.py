"""Small ASGI middleware for an optional shared HTTP Basic Auth gate."""

from __future__ import annotations

import base64
import binascii
from collections.abc import Mapping
from dataclasses import dataclass
from secrets import compare_digest

from starlette.responses import PlainTextResponse
from starlette.types import ASGIApp, Receive, Scope, Send


@dataclass(frozen=True, slots=True)
class BasicAuthCredentials:
    username: bytes
    password: bytes


def basic_auth_credentials(
    environment: Mapping[str, str],
) -> BasicAuthCredentials | None:
    username = environment.get("APP_BASIC_AUTH_USERNAME")
    password = environment.get("APP_BASIC_AUTH_PASSWORD")
    if (username is None) != (password is None):
        raise ValueError(
            "APP_BASIC_AUTH_USERNAME and APP_BASIC_AUTH_PASSWORD "
            "must be configured together"
        )
    if username is None and password is None:
        return None
    if not username or ":" in username:
        raise ValueError(
            "APP_BASIC_AUTH_USERNAME must be non-empty and contain no colon"
        )
    if not password:
        raise ValueError("APP_BASIC_AUTH_PASSWORD must be non-empty")
    return BasicAuthCredentials(username.encode("utf-8"), password.encode("utf-8"))


class BasicAuthMiddleware:
    """Protect every HTTP path except the platform health endpoint."""

    def __init__(self, app: ASGIApp, credentials: BasicAuthCredentials) -> None:
        self.app = app
        self._credentials = credentials

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] == "/health":
            await self.app(scope, receive, send)
            return
        if self._authorized(scope):
            await self.app(scope, receive, send)
            return
        response = PlainTextResponse(
            "Authentication required",
            status_code=401,
            headers={"WWW-Authenticate": 'Basic realm="Stock ETF Backtester"'},
        )
        await response(scope, receive, send)

    def _authorized(self, scope: Scope) -> bool:
        authorization_values = [
            value
            for name, value in scope["headers"]
            if name.lower() == b"authorization"
        ]
        if len(authorization_values) != 1:
            return False
        scheme, separator, token = authorization_values[0].partition(b" ")
        if not separator or scheme.lower() != b"basic" or not token:
            return False
        try:
            decoded = base64.b64decode(token, validate=True)
            username, colon, password = decoded.partition(b":")
        except (binascii.Error, ValueError):
            return False
        if not colon:
            return False
        username_matches = compare_digest(username, self._credentials.username)
        password_matches = compare_digest(password, self._credentials.password)
        return username_matches and password_matches

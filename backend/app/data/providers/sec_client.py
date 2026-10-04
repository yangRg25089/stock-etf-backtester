"""Bounded, identified, rate-limited reads from official SEC endpoints."""

from __future__ import annotations

import json
import os
import re
import time
from collections import OrderedDict
from contextlib import AbstractContextManager
from decimal import Decimal
from pathlib import Path
from threading import Lock
from typing import Protocol, cast
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

_REQUEST_LOCK = Lock()
_MAX_BYTES = 16_000_000
_CONTACT_FILE = Path(__file__).resolve().parents[4] / ".local" / "sec-user-agent"


class _Response(Protocol):
    status: int

    def read(self, size: int = -1) -> bytes: ...


class _Opener(Protocol):
    def __call__(
        self, request: Request, *, timeout: float
    ) -> AbstractContextManager[_Response]: ...


class SecRequestError(Exception):
    """Only bounded public reason/status information leaves the HTTP adapter."""

    def __init__(self, reason: str, status: int | None = None) -> None:
        self.reason = reason
        self.status = status
        super().__init__(f"SEC request unavailable: {reason}")


class SecEdgarClient:
    version = "sec-edgar-v1"

    def __init__(
        self,
        *,
        user_agent: str | None = None,
        contact_file: Path = _CONTACT_FILE,
        urlopen_fn: _Opener | None = None,
    ) -> None:
        agent = (
            os.environ.get("SEC_USER_AGENT", "") if user_agent is None else user_agent
        )
        if not agent and user_agent is None:
            try:
                agent = contact_file.read_text(encoding="utf-8").strip()
            except OSError:
                pass
        self._agent = agent
        self._open = cast(_Opener, urlopen) if urlopen_fn is None else urlopen_fn
        self._cache: OrderedDict[str, bytes] = OrderedDict()
        self._lock = Lock()

    def company_tickers(self) -> dict[str, object]:
        return self._json("https://www.sec.gov/files/company_tickers.json")

    def company_facts(self, cik: str) -> dict[str, object]:
        self._cik(cik)
        return self._json(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json")

    def submissions(self, cik: str) -> dict[str, object]:
        self._cik(cik)
        return self._json(f"https://data.sec.gov/submissions/CIK{cik}.json")

    def submissions_file(self, name: str) -> dict[str, object]:
        if not re.fullmatch(r"CIK[0-9]{10}-submissions-[0-9]{3}\.json", name):
            raise ValueError("invalid SEC history file")
        return self._json(f"https://data.sec.gov/submissions/{name}")

    def filing_document(self, cik: str, accession: str, name: str) -> str:
        self._cik(cik)
        if not re.fullmatch(r"[0-9]{10}-[0-9]{2}-[0-9]{6}", accession):
            raise ValueError("invalid SEC accession")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,255}", name):
            raise ValueError("invalid SEC document name")
        archive = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}"
        url = f"{archive}/{accession.replace('-', '')}/{name}"
        return self._request(url).decode("utf-8", errors="replace")

    @staticmethod
    def _cik(cik: str) -> None:
        if not re.fullmatch(r"[0-9]{10}", cik):
            raise ValueError("SEC issuer must be a ten-digit CIK")

    def _json(self, url: str) -> dict[str, object]:
        try:
            value = json.loads(self._request(url), parse_float=Decimal)
        except (ValueError, UnicodeDecodeError):
            raise SecRequestError("invalid_json") from None
        if not isinstance(value, dict):
            raise SecRequestError("invalid_json")
        return cast(dict[str, object], value)

    def _request(self, url: str) -> bytes:
        if (
            not self._agent
            or len(self._agent) > 256
            or "\n" in self._agent
            or "\r" in self._agent
            or not re.search(r"[^\s@]+@[^\s@]+\.[^\s@]+", self._agent)
        ):
            raise SecRequestError("contact_required")
        with self._lock:
            cached = self._cache.get(url)
            if cached is not None:
                self._cache.move_to_end(url)
                return cached
            request = Request(
                url,
                headers={
                    "User-Agent": self._agent,
                    "Accept": "application/json,text/html",
                },
            )
            try:
                # One shared gate, <=8 requests/s even across client instances.
                with _REQUEST_LOCK:
                    time.sleep(0.125)
                    with self._open(request, timeout=15) as response:
                        if not 200 <= response.status < 300:
                            raise SecRequestError("http_error", response.status)
                        body = response.read(_MAX_BYTES + 1)
            except HTTPError as error:
                raise SecRequestError("http_error", error.code) from None
            except (URLError, OSError, TimeoutError):
                raise SecRequestError("connection_failed") from None
            if len(body) > _MAX_BYTES:
                raise SecRequestError("response_too_large")
            self._cache[url] = body
            while len(self._cache) > 16:
                self._cache.popitem(last=False)
            return body

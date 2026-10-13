"""Process-owned, bounded temporary storage with the common run-state protocol."""

from __future__ import annotations

import atexit
import json
import sqlite3
import zlib
from collections.abc import Iterator, MutableMapping
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import RLock
from typing import Generic, TypeVar, cast

from pydantic import BaseModel

from app.domain.contracts import StrategyRun
from app.domain.resources import ResultStorageFull
from app.domain.status import StrategyStatus
from app.runs.store import InMemoryRunStore
from app.runs.types import RunResponse

_Key = TypeVar("_Key", str, tuple[str, str])
_Model = TypeVar("_Model", bound=BaseModel)
DEFAULT_STORAGE_BYTES = 512 * 1024 * 1024
DEFAULT_STORED_RUNS = 128


def _pack(value: object) -> object:
    """Tag every container so user dictionary keys cannot impersonate scalars."""
    if isinstance(value, dict):
        return {"map": [[key, _pack(item)] for key, item in value.items()]}
    if isinstance(value, (tuple, list)):
        return {
            "tuple" if isinstance(value, tuple) else "list": [
                _pack(item) for item in value
            ]
        }
    if isinstance(value, datetime):
        return {"datetime": value.isoformat()}
    if isinstance(value, date):
        return {"date": value.isoformat()}
    if isinstance(value, Decimal):
        return {"decimal": str(value)}
    return value


def _unpack(value: object) -> object:
    if not isinstance(value, dict):
        return value
    if "map" in value:
        return {key: _unpack(item) for key, item in value["map"]}
    if "tuple" in value:
        return tuple(_unpack(item) for item in value["tuple"])
    if "list" in value:
        return [_unpack(item) for item in value["list"]]
    if "datetime" in value:
        return datetime.fromisoformat(value["datetime"])
    if "date" in value:
        return date.fromisoformat(value["date"])
    if "decimal" in value:
        return Decimal(value["decimal"])
    raise ValueError("invalid stored model encoding")


class _PayloadDatabase:
    def __init__(self, max_bytes: int) -> None:
        if max_bytes < 128 * 1024:
            raise ValueError("storage budget must be at least 128 KiB")
        self.directory = TemporaryDirectory(prefix="stock-backtest-")
        self.path = Path(self.directory.name) / "results.sqlite3"
        self.lock = RLock()
        self.closed = False
        self.connection = sqlite3.connect(self.path, check_same_thread=False)
        self.connection.execute("PRAGMA journal_mode=DELETE")
        self.connection.execute("PRAGMA synchronous=FULL")
        self.connection.execute("PRAGMA cache_size=-2048")
        self.connection.execute("PRAGMA temp_store=FILE")
        page_size = self.connection.execute("PRAGMA page_size").fetchone()[0]
        # A rollback journal can contain every existing database page plus a
        # small header per sector/page. Bound both, not just JSON payload bytes.
        self.hard_pages = (max_bytes - max(16 * 1024, max_bytes // 512)) // (
            2 * page_size
        )
        self.normal_pages = self.hard_pages - max(4, min(4096, self.hard_pages // 8))
        self.connection.execute(f"PRAGMA max_page_count={self.hard_pages}")
        self.connection.execute(
            "CREATE TABLE payloads (kind TEXT NOT NULL, identity TEXT NOT NULL, "
            "body BLOB NOT NULL, PRIMARY KEY(kind, identity))"
        )
        self.connection.commit()
        atexit.register(self.close)

    def check_room(self) -> None:
        with self.lock:
            pages = self.connection.execute("PRAGMA page_count").fetchone()[0]
            if pages >= self.normal_pages:
                raise ResultStorageFull("temporary result storage is full")

    def write(self, kind: str, identity: str, body: bytes, *, control: bool) -> None:
        with self.lock:
            try:
                with self.connection:
                    # Release the old blob pages inside this same transaction.
                    # UPSERT can allocate a second large blob before freeing the
                    # first; that would exhaust even terminal-state reserves.
                    self.connection.execute(
                        "DELETE FROM payloads WHERE kind=? AND identity=?",
                        (kind, identity),
                    )
                    self.connection.execute(
                        "INSERT INTO payloads VALUES (?, ?, ?)",
                        (kind, identity, body),
                    )
                    pages = self.connection.execute("PRAGMA page_count").fetchone()[0]
                    if not control and pages > self.normal_pages:
                        raise ResultStorageFull("temporary result storage is full")
            except sqlite3.OperationalError as error:
                if error.sqlite_errorcode == sqlite3.SQLITE_FULL:
                    raise ResultStorageFull(
                        "temporary result storage is full"
                    ) from error
                raise

    def close(self) -> None:
        with self.lock:
            if self.closed:
                return
            self.closed = True
            self.connection.close()
            self.directory.cleanup()
            atexit.unregister(self.close)


class _PayloadMap(MutableMapping[_Key, _Model], Generic[_Key, _Model]):
    """Typed immutable model payloads; no result objects are cached in RAM."""

    def __init__(self, database: _PayloadDatabase, kind: str, model: type[_Model]):
        self.database, self.kind, self.model = database, kind, model

    def __getitem__(self, key: _Key) -> _Model:
        with self.database.lock:
            row = self.database.connection.execute(
                "SELECT body FROM payloads WHERE kind=? AND identity=?",
                (self.kind, json.dumps(key)),
            ).fetchone()
        if row is None:
            raise KeyError(key)
        return self.model.model_validate(_unpack(json.loads(zlib.decompress(row[0]))))

    def __setitem__(self, key: _Key, value: _Model) -> None:
        failure_states = {
            StrategyStatus.CANCELLED,
            StrategyStatus.FAILED,
            StrategyStatus.UNAVAILABLE,
        }
        control = isinstance(value, RunResponse) and (
            value.status is StrategyStatus.QUEUED
            or value.status in failure_states
            or (
                value.status is StrategyStatus.COMPLETED_WITH_WARNING
                and value.result is not None
                and any(
                    row.status in failure_states for row in value.result.strategy_runs
                )
            )
        )
        self.database.write(
            self.kind,
            json.dumps(key),
            zlib.compress(json.dumps(_pack(value.model_dump())).encode()),
            control=control,
        )

    def __contains__(self, key: object) -> bool:
        if not isinstance(key, (str, tuple)):
            return False
        with self.database.lock:
            return (
                self.database.connection.execute(
                    "SELECT 1 FROM payloads WHERE kind=? AND identity=?",
                    (self.kind, json.dumps(key)),
                ).fetchone()
                is not None
            )

    def __len__(self) -> int:
        with self.database.lock:
            return int(
                self.database.connection.execute(
                    "SELECT COUNT(*) FROM payloads WHERE kind=?",
                    (self.kind,),
                ).fetchone()[0]
            )

    def __iter__(self) -> Iterator[_Key]:
        with self.database.lock:
            rows = self.database.connection.execute(
                "SELECT identity FROM payloads WHERE kind=?",
                (self.kind,),
            ).fetchall()
        for row in rows:
            decoded = json.loads(row[0])
            yield cast(_Key, tuple(decoded) if isinstance(decoded, list) else decoded)

    def __delitem__(self, key: _Key) -> None:
        raise TypeError("saved results cannot be evicted")


class TemporaryRunStore(InMemoryRunStore):
    """Reuse common locks, retry claims and notifications with disk payloads."""

    def __init__(
        self,
        *,
        max_runs: int = DEFAULT_STORED_RUNS,
        max_bytes: int = DEFAULT_STORAGE_BYTES,
    ) -> None:
        super().__init__(max_runs=max_runs)
        self._database = _PayloadDatabase(max_bytes)
        self._records = _PayloadMap[str, RunResponse](
            self._database, "runs", RunResponse
        )
        self._candidates = _PayloadMap[tuple[str, str], StrategyRun](
            self._database, "candidates", StrategyRun
        )

    def _check_storage_room(self) -> None:
        super()._check_storage_room()
        self._database.check_room()

    def close(self) -> None:
        self._database.close()

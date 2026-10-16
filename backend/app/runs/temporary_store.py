"""Process-owned, bounded temporary storage with the common run-state protocol."""

from __future__ import annotations

import atexit
import json
import math
import sqlite3
import zlib
from collections.abc import Callable, Generator, Iterator, Mapping, MutableMapping
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import RLock
from typing import Any, Generic, TypeAlias, TypeVar, cast, get_args

from pydantic import BaseModel

from app.domain.contracts import StrategyRun
from app.domain.immutability import FrozenMap, freeze_mapping
from app.domain.resources import ResultStorageFull
from app.domain.status import StrategyStatus
from app.runs.store import JSON_CHUNK_BYTES, InMemoryRunStore
from app.runs.types import RunProgressEvent, RunResponse

_Key = TypeVar("_Key", str, tuple[str, str])
_Model = TypeVar("_Model", bound=BaseModel)
DEFAULT_STORAGE_BYTES = 512 * 1024 * 1024
DEFAULT_STORED_RUNS = 128


_NativeChange: TypeAlias = "dict[str | int, _NativeChange] | Decimal | date | float"
_NativeScalarPath: TypeAlias = tuple[list[str | int], str, str]


def _has_untyped_values(annotation: object) -> bool:
    return annotation in (object, Any) or any(
        _has_untyped_values(part) for part in get_args(annotation)
    )


def _native_scalar_paths(model: BaseModel) -> Iterator[_NativeScalarPath]:
    """Remember types only in arbitrary mappings; model fields have a schema."""

    def visit(
        value: object, path: list[str | int], arbitrary: bool = False
    ) -> Iterator[_NativeScalarPath]:
        if isinstance(value, BaseModel):
            for name, field in type(value).model_fields.items():
                yield from visit(
                    getattr(value, name),
                    [*path, name],
                    arbitrary or _has_untyped_values(field.annotation),
                )
        elif isinstance(value, Mapping):
            for key, item in value.items():
                yield from visit(item, [*path, key], True)
        elif isinstance(value, (tuple, list)):
            for index, item in enumerate(value):
                yield from visit(item, [*path, index], arbitrary)
        elif arbitrary:
            if isinstance(value, datetime):
                yield path, "datetime", value.isoformat()
            elif isinstance(value, date):
                yield path, "date", value.isoformat()
            elif isinstance(value, Decimal):
                yield path, "decimal", str(value)
            elif isinstance(value, float) and not math.isfinite(value):
                yield path, "float", str(value)

    yield from visit(model, [])


def _encode_model(model: BaseModel) -> bytes:
    # Stream native metadata rather than building a second tree of every value.
    compressor = zlib.compressobj()
    parts: list[bytes] = []

    def write(body: bytes) -> None:
        chunk = compressor.compress(body)
        if chunk:
            parts.append(chunk)

    write(b"[")
    for index, scalar in enumerate(_native_scalar_paths(model)):
        if index:
            write(b",")
        write(json.dumps(scalar, separators=(",", ":")).encode())
    write(b"]\n")
    write(model.model_dump_json(by_alias=True).encode())
    parts.append(compressor.flush())
    return b"".join(parts)


def _restore_native(value: object, changes: _NativeChange) -> object:
    if not isinstance(changes, dict):
        return changes
    if not changes:
        return value
    if isinstance(value, BaseModel):
        return value.model_copy(
            update={
                str(name): _restore_native(getattr(value, str(name)), change)
                for name, change in changes.items()
            }
        )
    if isinstance(value, Mapping):
        updated = dict(value)
        for key, change in changes.items():
            updated[key] = _restore_native(value[key], change)
        return freeze_mapping(updated) if isinstance(value, FrozenMap) else updated
    if isinstance(value, (tuple, list)):
        items = list(value)
        for index, change in changes.items():
            if not isinstance(index, int):
                raise ValueError("invalid stored sequence path")
            items[index] = _restore_native(items[index], change)
        return tuple(items) if isinstance(value, tuple) else items
    raise ValueError("invalid stored model path")


def _decode_model(body: bytes, model: type[_Model]) -> _Model:
    header, payload = zlib.decompress(body).split(b"\n", 1)
    # Pydantic's JSON reader avoids a complete intermediate Python dict tree.
    value = model.model_validate_json(payload)
    changes: dict[str | int, _NativeChange] = {}
    decoders: dict[str, Callable[[str], Decimal | date | float]] = {
        "decimal": Decimal,
        "float": float,
        "date": date.fromisoformat,
        "datetime": datetime.fromisoformat,
    }
    for path, kind, scalar in json.loads(header):
        target = changes
        for key in path[:-1]:
            child = target.setdefault(key, {})
            if not isinstance(child, dict):
                raise ValueError("invalid stored scalar path")
            target = child
        target[path[-1]] = decoders[kind](scalar)
    return cast(_Model, _restore_native(value, changes))


def _iter_wire_json(body: bytes) -> Generator[bytes, None, None]:
    """Bound decompressed output, discarding native metadata without buffering it."""
    decoder = zlib.decompressobj()
    in_header = True
    for offset in range(0, len(body), JSON_CHUNK_BYTES):
        compressed = body[offset : offset + JSON_CHUNK_BYTES]
        while True:
            block = decoder.decompress(compressed, JSON_CHUNK_BYTES)
            compressed = decoder.unconsumed_tail
            full_chunk = len(block) == JSON_CHUNK_BYTES
            if in_header:
                _, separator, block = block.partition(b"\n")
                in_header = not separator
            if block:
                yield block
            if not compressed and not full_chunk:
                break
    if not decoder.eof or in_header:
        raise zlib.error("incomplete saved result")


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

    def write(
        self, payloads: tuple[tuple[str, str, bytes], ...], *, control: bool
    ) -> None:
        with self.lock:
            try:
                with self.connection:
                    for kind, identity, body in payloads:
                        # Reuse old blob pages in the same transaction; UPSERT
                        # would allocate the new blob before freeing the old.
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


def _uses_terminal_reserve(value: BaseModel) -> bool:
    failure_states = {
        StrategyStatus.CANCELLED,
        StrategyStatus.FAILED,
        StrategyStatus.UNAVAILABLE,
    }
    return isinstance(value, RunResponse) and (
        value.status is StrategyStatus.QUEUED
        or value.status in failure_states
        or (
            value.status is StrategyStatus.COMPLETED_WITH_WARNING
            and value.result is not None
            and any(row.status in failure_states for row in value.result.strategy_runs)
        )
    )


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
        return _decode_model(row[0], self.model)

    def __setitem__(self, key: _Key, value: _Model) -> None:
        self.database.write(
            ((self.kind, json.dumps(key), _encode_model(value)),),
            control=_uses_terminal_reserve(value),
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
        self._progress = _PayloadMap[str, RunProgressEvent](
            self._database, "progress", RunProgressEvent
        )
        self._records = _PayloadMap[str, RunResponse](
            self._database, "runs", RunResponse
        )
        self._candidates = _PayloadMap[tuple[str, str], StrategyRun](
            self._database, "candidates", StrategyRun
        )

    def _save_payload(self, response: RunResponse, event: RunProgressEvent) -> None:
        identity = json.dumps(response.run_id)
        self._database.write(
            (
                ("runs", identity, _encode_model(response)),
                ("progress", identity, _encode_model(event)),
            ),
            control=_uses_terminal_reserve(response),
        )

    def iter_json(self, run_id: str) -> Generator[bytes, None, None] | None:
        """Capture one compressed snapshot, releasing locks before streaming it."""
        with self._lock, self._database.lock:
            row = self._database.connection.execute(
                "SELECT body FROM payloads WHERE kind='runs' AND identity=?",
                (json.dumps(run_id),),
            ).fetchone()
        return _iter_wire_json(row[0]) if row else None

    def _check_storage_room(self) -> None:
        super()._check_storage_room()
        self._database.check_room()

    def close(self) -> None:
        self._database.close()

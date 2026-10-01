"""SQLite-backed storage for local run snapshots and idempotency records."""

from __future__ import annotations

import json
import sqlite3
import time
import zlib
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from pathlib import Path
from threading import Condition, Event, RLock
from time import monotonic
from uuid import uuid4

from app.catalog.definitions import ALL_PARAMETER_DEFINITIONS, ParameterType
from app.catalog.service import CATALOG_VERSION
from app.domain.contracts import ResultRole, RunResult, StrategyRun
from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    StrategyStatus,
    is_terminal,
)
from app.runs.store import (
    IdempotencyConflict,
    RunChange,
    RunInitializationError,
    RunReservation,
)
from app.runs.types import RunProgress, RunResponse

_STORAGE_FORMAT_VERSION = 1
_STORAGE_TYPE_KEY = "__run_store_value_type__"


@dataclass(slots=True)
class _SQLiteReservationState:
    run_id: str
    request_fingerprint: str
    ready: Event = field(default_factory=Event)
    error: BaseException | None = None


class SQLiteRunStore:
    """Persist accepted run responses and retry keys in a local SQLite database."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._lock = RLock()
        self._changed = Condition(self._lock)
        self._closed = False
        self._states: dict[str, _SQLiteReservationState] = {}
        self._versions: dict[str, int] = {}
        self._connection = sqlite3.connect(
            self.path,
            timeout=5,
            isolation_level=None,
            check_same_thread=False,
        )
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA busy_timeout = 5000")
        self._connection.execute("PRAGMA journal_mode = WAL")
        self._connection.execute("PRAGMA synchronous = FULL")
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS run_records (
                record_id INTEGER PRIMARY KEY AUTOINCREMENT,
                idempotency_key TEXT NOT NULL UNIQUE,
                run_id TEXT NOT NULL UNIQUE,
                request_fingerprint TEXT NOT NULL,
                response_json TEXT,
                created_at_ns INTEGER NOT NULL,
                updated_at_ns INTEGER NOT NULL
            )
            """
        )
        self._connection.execute("""
            CREATE TABLE IF NOT EXISTS candidate_results (
                run_id TEXT NOT NULL,
                candidate_id TEXT NOT NULL,
                result_blob BLOB NOT NULL,
                PRIMARY KEY (run_id, candidate_id)
            )
        """)
        self._recover_after_restart()

    def save_candidate(self, run_id: str, candidate: StrategyRun) -> None:
        payload = zlib.compress(candidate.model_dump_json(by_alias=True).encode())
        with self._lock, self._transaction():
            self._ensure_open()
            self._connection.execute(
                "INSERT INTO candidate_results VALUES (?, ?, ?) "
                "ON CONFLICT(run_id, candidate_id) DO UPDATE "
                "SET result_blob=excluded.result_blob",
                (run_id, candidate.id, payload),
            )

    def get_candidate(self, run_id: str, candidate_id: str) -> StrategyRun | None:
        with self._lock:
            self._ensure_open()
            row = self._connection.execute(
                "SELECT result_blob FROM candidate_results "
                "WHERE run_id=? AND candidate_id=?",
                (run_id, candidate_id),
            ).fetchone()
        return (
            None
            if row is None
            else StrategyRun.model_validate_json(zlib.decompress(row[0]))
        )

    def reserve(self, idempotency_key: str, request_fingerprint: str) -> RunReservation:
        """Create a durable retry claim or return its original run identity."""

        if not idempotency_key.strip():
            raise ValueError("idempotency key must not be empty")
        if not request_fingerprint:
            raise ValueError("request fingerprint must not be empty")

        with self._lock, self._transaction():
            self._ensure_open()
            row = self._connection.execute(
                """
                SELECT run_id, request_fingerprint, response_json
                FROM run_records
                WHERE idempotency_key = ?
                """,
                (idempotency_key,),
            ).fetchone()
            if row is not None:
                if row["request_fingerprint"] != request_fingerprint:
                    raise IdempotencyConflict(
                        "idempotency key already belongs to a different submission"
                    )
                state = self._states.get(idempotency_key)
                if state is None:
                    state = _SQLiteReservationState(
                        run_id=row["run_id"],
                        request_fingerprint=request_fingerprint,
                    )
                    if row["response_json"] is not None:
                        state.ready.set()
                    else:
                        state.error = RunInitializationError(
                            "pending reservation has no active local owner"
                        )
                        state.ready.set()
                    self._states[idempotency_key] = state
                return RunReservation(
                    run_id=row["run_id"],
                    idempotency_key=idempotency_key,
                    request_fingerprint=request_fingerprint,
                    owner=False,
                )

            run_id = str(uuid4())
            now = time.time_ns()
            self._connection.execute(
                """
                INSERT INTO run_records (
                    idempotency_key, run_id, request_fingerprint,
                    response_json, created_at_ns, updated_at_ns
                ) VALUES (?, ?, ?, NULL, ?, ?)
                """,
                (idempotency_key, run_id, request_fingerprint, now, now),
            )
            self._states[idempotency_key] = _SQLiteReservationState(
                run_id=run_id,
                request_fingerprint=request_fingerprint,
            )
            return RunReservation(
                run_id=run_id,
                idempotency_key=idempotency_key,
                request_fingerprint=request_fingerprint,
                owner=True,
            )

    def publish(self, reservation: RunReservation, response: RunResponse) -> None:
        """Durably publish the immutable accepted snapshot before queueing work."""

        if response.run_id != reservation.run_id:
            raise ValueError("published response must match its reservation")
        payload = _serialize_response(response)
        with self._lock, self._transaction():
            self._ensure_open()
            state = self._state_for(reservation)
            cursor = self._connection.execute(
                """
                UPDATE run_records
                SET response_json = ?, updated_at_ns = ?
                WHERE idempotency_key = ? AND run_id = ?
                """,
                (
                    payload,
                    time.time_ns(),
                    reservation.idempotency_key,
                    reservation.run_id,
                ),
            )
            if cursor.rowcount != 1:
                raise ValueError("run reservation is no longer valid")
            state.ready.set()
            self._versions[reservation.run_id] = (
                self._versions.get(reservation.run_id, 0) + 1
            )
            self._changed.notify_all()

    def abort(self, reservation: RunReservation, error: BaseException) -> None:
        """Remove an unaccepted claim and wake local duplicate submitters."""

        with self._lock, self._transaction():
            self._ensure_open()
            state = self._state_for(reservation)
            self._connection.execute(
                """
                DELETE FROM run_records
                WHERE idempotency_key = ? AND run_id = ? AND response_json IS NULL
                """,
                (reservation.idempotency_key, reservation.run_id),
            )
            state.error = error
            state.ready.set()

    def wait_for_record(self, reservation: RunReservation) -> RunResponse:
        """Wait for local acceptance or return a previously persisted response."""

        with self._lock:
            self._ensure_open()
            state = self._state_for(reservation)
        state.ready.wait()
        with self._lock:
            if state.error is not None:
                raise RunInitializationError(
                    "the original run could not be initialized"
                ) from state.error
            response = self._get_locked(reservation.run_id)
            if response is None:
                raise RunInitializationError("the original run has no stored record")
            return response

    def update(self, response: RunResponse) -> None:
        """Persist the latest status, progress, and result for a known run."""

        with self._lock, self._transaction():
            self._ensure_open()
            cursor = self._connection.execute(
                """
                UPDATE run_records
                SET response_json = ?, updated_at_ns = ?
                WHERE run_id = ? AND response_json IS NOT NULL
                """,
                (
                    _serialize_response(response),
                    time.time_ns(),
                    response.run_id,
                ),
            )
            if cursor.rowcount != 1:
                raise KeyError(f"unknown run: {response.run_id}")
            self._versions[response.run_id] = self._versions.get(response.run_id, 0) + 1
            self._changed.notify_all()

    def get(self, run_id: str) -> RunResponse | None:
        with self._lock:
            self._ensure_open()
            return self._get_locked(run_id)

    def get_latest(self) -> RunResponse | None:
        with self._lock:
            self._ensure_open()
            row = self._connection.execute(
                """
                SELECT response_json
                FROM run_records
                WHERE response_json IS NOT NULL
                ORDER BY created_at_ns DESC, record_id DESC
                LIMIT 1
                """
            ).fetchone()
            if row is None:
                return None
            return _deserialize_response(row["response_json"])

    def close(self) -> None:
        """Close the database handle; callers may reopen the same path later."""

        with self._lock:
            if self._closed:
                return
            for state in self._states.values():
                if not state.ready.is_set():
                    state.error = RunInitializationError(
                        "the run store closed before the run was accepted"
                    )
                    state.ready.set()
            self._changed.notify_all()
            self._connection.close()
            self._closed = True

    def _get_locked(self, run_id: str) -> RunResponse | None:
        row = self._connection.execute(
            "SELECT response_json FROM run_records WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        if row is None or row["response_json"] is None:
            return None
        return _deserialize_response(row["response_json"])

    def wait_for_change(
        self, run_id: str, after_version: int, timeout_seconds: float
    ) -> RunChange | None:
        """Wait on local store updates; timeout lets SSE emit keepalives."""

        deadline = monotonic() + max(0.0, timeout_seconds)
        with self._changed:
            while True:
                self._ensure_open()
                version = self._versions.get(run_id, 0)
                if version > after_version:
                    response = self._get_locked(run_id)
                    if response is None:
                        return None
                    return RunChange(version=version, response=response)
                remaining = deadline - monotonic()
                if remaining <= 0:
                    return None
                self._changed.wait(remaining)

    def _state_for(self, reservation: RunReservation) -> _SQLiteReservationState:
        state = self._states.get(reservation.idempotency_key)
        if (
            state is None
            or state.run_id != reservation.run_id
            or state.request_fingerprint != reservation.request_fingerprint
        ):
            raise ValueError("run reservation is no longer valid")
        return state

    def _recover_after_restart(self) -> None:
        """Discard unaccepted claims and fail active work left by a dead process."""

        with self._lock, self._transaction():
            self._connection.execute(
                "DELETE FROM run_records WHERE response_json IS NULL"
            )
            rows = self._connection.execute(
                """
                SELECT run_id, response_json
                FROM run_records
                WHERE response_json IS NOT NULL
                ORDER BY record_id
                """
            ).fetchall()
            for row in rows:
                response = _deserialize_response(row["response_json"])
                self._versions[row["run_id"]] = 1
                recovered = _recover_interrupted_response(response)
                if recovered != response:
                    self._connection.execute(
                        """
                        UPDATE run_records
                        SET response_json = ?, updated_at_ns = ?
                        WHERE run_id = ?
                        """,
                        (
                            _serialize_response(recovered),
                            time.time_ns(),
                            row["run_id"],
                        ),
                    )
                    self._versions[row["run_id"]] += 1

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("SQLite run store is closed")

    @contextmanager
    def _transaction(self) -> Iterator[None]:
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self._connection.rollback()
            raise
        else:
            self._connection.commit()


def _recover_interrupted_response(response: RunResponse) -> RunResponse:
    result = response.result
    strategy_runs = () if result is None else result.strategy_runs
    should_recover = not is_terminal(response.status) or any(
        not is_terminal(strategy_run.status) for strategy_run in strategy_runs
    )
    if not should_recover:
        return response

    if not strategy_runs:
        strategy_runs = tuple(
            StrategyRun(
                id=strategy.id,
                presetId=strategy.preset_id,
                role=ResultRole.STRATEGY,
                status=StrategyStatus.QUEUED,
            )
            for strategy in response.snapshot.config.strategies
        )

    recovered_runs = tuple(
        _fail_interrupted_strategy(response.run_id, strategy_run)
        if not is_terminal(strategy_run.status)
        else strategy_run
        for strategy_run in strategy_runs
    )
    recovered_result = RunResult(
        runId=response.run_id,
        strategyRuns=recovered_runs,
    )
    completed = sum(is_terminal(run.status) for run in recovered_runs)
    return response.model_copy(
        update={
            "status": recovered_result.status,
            "result": recovered_result,
            "progress": RunProgress(
                completedStrategies=completed,
                totalStrategies=max(1, len(recovered_runs)),
                currentStrategyId=None,
            ),
        }
    )


def _serialize_response(response: RunResponse) -> str:
    """Store Decimal strategy parameters with tags without changing API JSON."""

    payload = response.model_dump(mode="json", by_alias=True)
    stored_strategies = payload["snapshot"]["config"]["strategies"]
    for stored, strategy in zip(
        stored_strategies,
        response.snapshot.config.strategies,
        strict=True,
    ):
        stored["params"] = _encode_parameter_value(strategy.params)
        if strategy.rules is not None:
            stored["rules"] = _encode_parameter_value(
                strategy.rules.model_dump(mode="python", by_alias=True)
            )
    envelope = {"storageFormatVersion": _STORAGE_FORMAT_VERSION, "response": payload}
    return json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))


def _deserialize_response(serialized: str) -> RunResponse:
    """Read current tagged records or upgrade a legacy response in memory."""

    payload = json.loads(serialized)
    if isinstance(payload, dict) and "storageFormatVersion" in payload:
        if payload["storageFormatVersion"] != _STORAGE_FORMAT_VERSION:
            raise ValueError("unsupported SQLite run storage format")
        response_data = payload.get("response")
        if not isinstance(response_data, dict):
            raise ValueError("SQLite run storage response must be an object")
        for strategy in response_data["snapshot"]["config"]["strategies"]:
            strategy["params"] = _decode_parameter_value(strategy["params"])
            if strategy.get("rules") is not None:
                strategy["rules"] = _decode_parameter_value(strategy["rules"])
        return RunResponse.model_validate(response_data)

    if not isinstance(payload, dict):
        raise ValueError("legacy SQLite run response must be an object")
    _restore_legacy_decimal_parameters(payload)
    return RunResponse.model_validate(payload)


def _encode_parameter_value(value: object) -> object:
    if isinstance(value, Decimal):
        return {_STORAGE_TYPE_KEY: "decimal", "value": str(value)}
    if isinstance(value, Mapping):
        return {key: _encode_parameter_value(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_encode_parameter_value(item) for item in value]
    return value


def _decode_parameter_value(value: object) -> object:
    if isinstance(value, dict):
        if set(value) == {_STORAGE_TYPE_KEY, "value"}:
            if value[_STORAGE_TYPE_KEY] != "decimal":
                raise ValueError("unsupported SQLite strategy parameter type")
            return Decimal(str(value["value"]))
        return {key: _decode_parameter_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_decode_parameter_value(item) for item in value]
    return value


def _restore_legacy_decimal_parameters(payload: dict[str, object]) -> None:
    snapshot = payload.get("snapshot")
    if (
        not isinstance(snapshot, dict)
        # Legacy snapshots keep their original catalog and decimal parameters.
        or snapshot.get("catalogVersion")
        not in {"catalog-v4", "catalog-v5", CATALOG_VERSION}
    ):
        return
    config = snapshot.get("config")
    if not isinstance(config, dict):
        return
    strategies = config.get("strategies")
    if not isinstance(strategies, list):
        return

    decimal_keys = {
        definition.key
        for definition in ALL_PARAMETER_DEFINITIONS
        if definition.type
        in {ParameterType.DECIMAL, ParameterType.RATIO, ParameterType.PERCENT_POINT}
    }
    for strategy in strategies:
        if not isinstance(strategy, dict):
            continue
        params = strategy.get("params")
        if not isinstance(params, dict):
            continue
        for key in decimal_keys:
            value = params.get(key)
            if not isinstance(value, str):
                continue
            try:
                decimal_value = Decimal(value)
            except InvalidOperation as error:
                raise ValueError(
                    "legacy SQLite decimal parameter is invalid"
                ) from error
            if not decimal_value.is_finite():
                raise ValueError("legacy SQLite decimal parameter is not finite")
            params[key] = decimal_value


def _fail_interrupted_strategy(run_id: str, strategy_run: StrategyRun) -> StrategyRun:
    diagnostic = Diagnostic(
        code=DiagnosticCode.RUN_INTERRUPTED,
        messageKey="runs.interrupted_by_restart",
        details={
            "runId": run_id,
            "previousStatus": strategy_run.status.value,
        },
    )
    return strategy_run.with_status(
        StrategyStatus.FAILED,
        diagnostics=(*strategy_run.diagnostics, diagnostic),
    )

"""SQLite-backed storage for local run snapshots and idempotency records."""

from __future__ import annotations

import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from threading import Event, RLock
from uuid import uuid4

from app.domain.contracts import ResultRole, RunResult, StrategyRun
from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    StrategyStatus,
    is_terminal,
)
from app.runs.store import (
    IdempotencyConflict,
    RunInitializationError,
    RunReservation,
)
from app.runs.types import RunProgress, RunResponse


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
        self._closed = False
        self._states: dict[str, _SQLiteReservationState] = {}
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
        self._recover_after_restart()

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
        payload = response.model_dump_json(by_alias=True)
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
                    response.model_dump_json(by_alias=True),
                    time.time_ns(),
                    response.run_id,
                ),
            )
            if cursor.rowcount != 1:
                raise KeyError(f"unknown run: {response.run_id}")

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
            return RunResponse.model_validate_json(row["response_json"])

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
            self._connection.close()
            self._closed = True

    def _get_locked(self, run_id: str) -> RunResponse | None:
        row = self._connection.execute(
            "SELECT response_json FROM run_records WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        if row is None or row["response_json"] is None:
            return None
        return RunResponse.model_validate_json(row["response_json"])

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
                response = RunResponse.model_validate_json(row["response_json"])
                recovered = _recover_interrupted_response(response)
                if recovered != response:
                    self._connection.execute(
                        """
                        UPDATE run_records
                        SET response_json = ?, updated_at_ns = ?
                        WHERE run_id = ?
                        """,
                        (
                            recovered.model_dump_json(by_alias=True),
                            time.time_ns(),
                            row["run_id"],
                        ),
                    )

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

"""Thread-safe in-memory storage for run state and idempotency claims."""

from __future__ import annotations

from dataclasses import dataclass, field
from threading import Event, RLock
from typing import Protocol
from uuid import uuid4

from app.runs.types import RunResponse


class IdempotencyConflict(ValueError):
    """An idempotency key was reused for a different frozen submission."""


class RunInitializationError(RuntimeError):
    """A run reservation could not be converted into an accepted record."""


@dataclass(frozen=True, slots=True)
class RunReservation:
    run_id: str
    idempotency_key: str
    request_fingerprint: str
    owner: bool


class RunStore(Protocol):
    """Storage operations required by the local run manager."""

    def reserve(
        self, idempotency_key: str, request_fingerprint: str
    ) -> RunReservation: ...

    def publish(self, reservation: RunReservation, response: RunResponse) -> None: ...

    def abort(self, reservation: RunReservation, error: BaseException) -> None: ...

    def wait_for_record(self, reservation: RunReservation) -> RunResponse: ...

    def update(self, response: RunResponse) -> None: ...

    def get(self, run_id: str) -> RunResponse | None: ...

    def get_latest(self) -> RunResponse | None: ...


@dataclass(slots=True)
class _ReservationState:
    run_id: str
    request_fingerprint: str
    ready: Event = field(default_factory=Event)
    error: BaseException | None = None


class InMemoryRunStore:
    """Atomically claim idempotency keys and retain each run's latest response."""

    def __init__(self) -> None:
        self._lock = RLock()
        self._reservations: dict[str, _ReservationState] = {}
        self._records: dict[str, RunResponse] = {}
        self._latest_run_id: str | None = None

    def reserve(self, idempotency_key: str, request_fingerprint: str) -> RunReservation:
        """Return the unique run reservation for this key and request identity."""

        if not idempotency_key.strip():
            raise ValueError("idempotency key must not be empty")
        if not request_fingerprint:
            raise ValueError("request fingerprint must not be empty")
        with self._lock:
            existing = self._reservations.get(idempotency_key)
            if existing is not None:
                if existing.request_fingerprint != request_fingerprint:
                    raise IdempotencyConflict(
                        "idempotency key already belongs to a different submission"
                    )
                return RunReservation(
                    run_id=existing.run_id,
                    idempotency_key=idempotency_key,
                    request_fingerprint=request_fingerprint,
                    owner=False,
                )

            run_id = str(uuid4())
            self._reservations[idempotency_key] = _ReservationState(
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
        """Make the full snapshot visible to retries and run queries."""

        if response.run_id != reservation.run_id:
            raise ValueError("published response must match its reservation")
        with self._lock:
            state = self._state_for(reservation)
            self._records[reservation.run_id] = response
            self._latest_run_id = reservation.run_id
            state.ready.set()

    def abort(self, reservation: RunReservation, error: BaseException) -> None:
        """Wake duplicate callers if acceptance failed before a record existed."""

        with self._lock:
            state = self._state_for(reservation)
            state.error = error
            state.ready.set()

    def wait_for_record(self, reservation: RunReservation) -> RunResponse:
        """Wait for the owning request to publish an accepted immutable snapshot."""

        with self._lock:
            state = self._state_for(reservation)
        state.ready.wait()
        with self._lock:
            if state.error is not None:
                raise RunInitializationError(
                    "the original run could not be initialized"
                ) from state.error
            response = self._records.get(reservation.run_id)
            if response is None:
                raise RunInitializationError("the original run has no stored record")
            return response

    def update(self, response: RunResponse) -> None:
        """Replace only the observable status/progress/result for a known run."""

        with self._lock:
            if response.run_id not in self._records:
                raise KeyError(f"unknown run: {response.run_id}")
            self._records[response.run_id] = response

    def get(self, run_id: str) -> RunResponse | None:
        with self._lock:
            return self._records.get(run_id)

    def get_latest(self) -> RunResponse | None:
        with self._lock:
            if self._latest_run_id is None:
                return None
            return self._records.get(self._latest_run_id)

    def _state_for(self, reservation: RunReservation) -> _ReservationState:
        state = self._reservations.get(reservation.idempotency_key)
        if (
            state is None
            or state.run_id != reservation.run_id
            or state.request_fingerprint != reservation.request_fingerprint
        ):
            raise ValueError("run reservation is no longer valid")
        return state

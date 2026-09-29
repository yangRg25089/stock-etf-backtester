from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from app.runs.store import IdempotencyConflict, InMemoryRunStore


def test_repeated_submission_key_reuses_the_original_run_reservation() -> None:
    store = InMemoryRunStore()

    original = store.reserve("client-key", "submission-fingerprint")
    retry = store.reserve("client-key", "submission-fingerprint")

    assert original.owner is True
    assert retry.owner is False
    assert retry.run_id == original.run_id


def test_reusing_a_submission_key_with_different_content_conflicts() -> None:
    store = InMemoryRunStore()
    store.reserve("client-key", "first-submission")

    with pytest.raises(IdempotencyConflict):
        store.reserve("client-key", "different-submission")


def test_concurrent_retries_have_only_one_reservation_owner() -> None:
    store = InMemoryRunStore()
    barrier = Barrier(12)

    def reserve() -> tuple[str, bool]:
        barrier.wait()
        reservation = store.reserve("shared-key", "same-submission")
        return reservation.run_id, reservation.owner

    with ThreadPoolExecutor(max_workers=12) as pool:
        reservations = tuple(pool.map(lambda _: reserve(), range(12)))

    run_ids = {run_id for run_id, _ in reservations}
    owners = sum(owner for _, owner in reservations)
    assert len(run_ids) == 1
    assert owners == 1

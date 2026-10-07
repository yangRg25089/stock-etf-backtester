from __future__ import annotations

import hashlib
import json
from datetime import date
from decimal import Decimal

import pytest

from app.catalog.service import default_data_settings
from app.data.fixtures import load_fixture
from app.domain.contracts import (
    ContributionSettings,
    RunConfig,
    RunSettings,
    RunSnapshot,
    SharedSettings,
)


def test_task4_fixture_loads_without_external_paths_and_has_stable_fingerprint() -> (
    None
):
    first = load_fixture("task4_core")
    second = load_fixture("task4_core")

    assert first.fixture_id == "task4-core"
    assert first.version == "2"
    assert first.fingerprint == second.fingerprint
    assert first.model_dump_json() == second.model_dump_json()
    assert len(first.snapshot.market.bars) >= 4
    assert first.snapshot.market.source == "fixture:task4-core"
    assert first.snapshot.fingerprint == first.fingerprint
    assert "path" not in first.model_dump()


def test_fixture_fingerprint_can_be_frozen_into_a_run_snapshot() -> None:
    fixture = load_fixture("task4_core")
    config = RunConfig(
        shared=SharedSettings(
            run=RunSettings(
                symbol="QQQ",
                startDate=date(2024, 1, 30),
                endDate=date(2024, 3, 1),
                endMode="fixed",
            ),
            contribution=ContributionSettings(day=1, amount=Decimal("100")),
            data=default_data_settings(),
        )
    )

    snapshot = RunSnapshot.from_config(
        run_id="fixture-run",
        config=config,
        catalog_version="catalog-test",
        data_fingerprint=fixture.fingerprint,
        engine_version="engine-test",
    )

    assert snapshot.data_fingerprint == fixture.fingerprint


def test_fixture_calendar_is_sorted_and_contains_cross_month_holiday_gap() -> None:
    fixture = load_fixture("task4_core")

    assert fixture.exchange_dates == tuple(sorted(fixture.exchange_dates))
    assert date(2024, 1, 31) in fixture.exchange_dates
    assert date(2024, 2, 1) in fixture.exchange_dates
    assert date(2024, 2, 19) in fixture.holidays
    assert date(2024, 2, 19) not in fixture.exchange_dates
    assert not any(
        item.symbol == "^VIX" and item.date == date(2024, 2, 28)
        for item in fixture.snapshot.macro
    )


def test_fixture_fingerprint_is_sha256_of_canonical_fixture_payload() -> None:
    fixture = load_fixture("task4_core")
    path = fixture.path
    canonical = json.dumps(
        json.loads(path.read_text(encoding="utf-8")),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")

    assert fixture.fingerprint == hashlib.sha256(canonical).hexdigest()


@pytest.mark.parametrize(
    "name", ["../task4_core", "unknown", "task4_core.json", None, ["task4_core"]]
)
def test_fixture_loader_rejects_unknown_or_path_like_names(name: object) -> None:
    with pytest.raises(ValueError, match="unknown fixture"):
        load_fixture(name)

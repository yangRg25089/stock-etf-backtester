from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from app.data.fixtures import load_fixture
from app.domain.contracts import MacroObservation, MarketBar, MarketSnapshot, RunResult
from app.domain.status import StrategyStatus


@pytest.mark.parametrize("order", [(1, 0), (0, 0)])
def test_market_snapshot_rejects_unsorted_or_duplicate_dates(order):
    market = load_fixture("task4_core").snapshot.market
    payload = market.model_dump(by_alias=True)
    payload["bars"] = [market.bars[index] for index in order]

    with pytest.raises(ValidationError, match="strictly increasing"):
        MarketSnapshot.model_validate(payload)


def test_market_snapshot_keeps_ordered_unique_dates_without_rewriting_prices():
    market = load_fixture("task4_core").snapshot.market
    assert MarketSnapshot.model_validate(market.model_dump()) == market


@pytest.mark.parametrize(
    "model,field",
    [
        (MarketBar, "observedAt"),
        (MacroObservation, "observedAt"),
        (MacroObservation, "publishedAt"),
    ],
)
def test_market_and_macro_timestamps_reject_naive_datetimes(model, field):
    snapshot = load_fixture("task4_core").snapshot
    sample = snapshot.market.bars[0] if model is MarketBar else snapshot.macro[0]
    payload = sample.model_dump(by_alias=True)
    payload[field] = datetime(2024, 1, 30, 20)

    with pytest.raises(ValidationError, match="timezone"):
        model.model_validate(payload)


def test_macro_accepts_aware_non_utc_timestamps_and_unknown_publication_time():
    sample = load_fixture("task4_core").snapshot.macro[0]
    payload = sample.model_dump(by_alias=True)
    payload["observedAt"] = datetime(
        2024, 1, 30, 20, tzinfo=timezone(timedelta(hours=9))
    )
    payload["publishedAt"] = None
    observation = MacroObservation.model_validate(payload)
    assert observation.observed_at.utcoffset() == timedelta(hours=9)
    assert observation.published_at is None


@pytest.mark.parametrize(
    "status", [s for s in StrategyStatus if s is not StrategyStatus.QUEUED]
)
def test_empty_run_result_cannot_claim_execution_or_completion(status):
    with pytest.raises(ValidationError, match="queued"):
        RunResult(runId="empty-run", strategyRuns=(), status=status)


def test_empty_run_result_is_queued():
    assert RunResult(runId="empty-run").status is StrategyStatus.QUEUED

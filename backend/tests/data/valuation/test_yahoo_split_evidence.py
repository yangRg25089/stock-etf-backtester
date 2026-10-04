from datetime import date, datetime
from decimal import Decimal

import pandas as pd
import pytest

from app.data.providers.yahoo import YahooFinanceAdapter
from app.data.providers.yahoo_splits import normalize_split_history

DAYS = (date(2024, 1, 2), date(2024, 1, 3), date(2024, 1, 4))


def frame(splits=(0, 0, 0)):
    return pd.DataFrame(
        {"Close": [100.0, 101.0, 102.0], "Stock Splits": splits},
        index=pd.DatetimeIndex(
            [datetime.combine(day, datetime.min.time()) for day in DAYS],
            tz="America/New_York",
        ),
    )


def test_zero_events_requires_complete_prices_and_the_split_column():
    proof = normalize_split_history(frame(), sessions=DAYS, symbol="ABC")
    assert proof.events == ()
    assert proof.prices == tuple(zip(DAYS, map(Decimal, [100, 101, 102]), strict=True))
    assert proof.is_unsplit_since(DAYS[0])
    for value in (
        frame().drop(columns="Stock Splits"),
        frame().iloc[1:],
        frame().iloc[:0],
    ):
        with pytest.raises(ValueError):
            normalize_split_history(value, sessions=DAYS, symbol="ABC")


@pytest.mark.parametrize("invalid", [float("nan"), float("inf"), -2])
def test_invalid_actions_do_not_mean_no_splits(invalid):
    with pytest.raises(ValueError):
        normalize_split_history(frame((0, invalid, 0)), sessions=DAYS, symbol="ABC")


def test_reverse_and_forward_splits_invalidate_older_eps_basis():
    proof = normalize_split_history(frame((0, 4, 0.25)), sessions=DAYS, symbol="ABC")
    assert proof.events == ((DAYS[1], Decimal(4)), (DAYS[2], Decimal("0.25")))
    assert not proof.is_unsplit_since(DAYS[0])
    assert not proof.is_unsplit_since(DAYS[2])
    assert proof.is_unsplit_since(date(2024, 1, 5))


def test_adapter_explicitly_requests_actions_without_adjusting_prices():
    requests = []

    class Ticker:
        def history(self, **values):
            requests.append(values)
            return frame()

    adapter = YahooFinanceAdapter(ticker_factory=lambda symbol: Ticker())
    proof, diagnostic = adapter.split_evidence("ABC", sessions=DAYS)
    assert diagnostic is None and proof is not None
    assert requests[0]["actions"] is True
    assert requests[0]["auto_adjust"] is False
    assert requests[0]["start"] == "2024-01-02"
    assert requests[0]["end"] == "2024-01-05"

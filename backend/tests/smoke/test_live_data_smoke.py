from __future__ import annotations

import json
from datetime import UTC, datetime

from app.data.smoke import main


class _Frame:
    columns = ["Close", "Adj Close"]

    def iterrows(self):
        return iter(
            [
                (
                    datetime(2024, 1, 30, 21, tzinfo=UTC),
                    {"Close": 100, "Adj Close": 99},
                ),
                (
                    datetime(2024, 1, 31, 21, tzinfo=UTC),
                    {"Close": 101, "Adj Close": 100},
                ),
                (
                    datetime(2024, 2, 2, 21, tzinfo=UTC),
                    {"Close": 103, "Adj Close": 102},
                ),
            ]
        )


class _Ticker:
    fast_info = {"currency": "USD"}
    history_metadata = {"currency": "USD"}

    def history(self, **kwargs: object) -> _Frame:
        self.history_kwargs = kwargs
        return _Frame()


def test_yahoo_smoke_reports_data_through_weekday_coverage_and_missing_sessions(
    capsys,
) -> None:
    ticker = _Ticker()

    exit_code = main(
        [
            "--live",
            "--source",
            "yahoo",
            "--symbol",
            "QQQ",
            "--start-date",
            "2024-01-30",
            "--end-date",
            "2024-02-02",
        ],
        ticker_factory=lambda _symbol: ticker,
    )

    report = json.loads(capsys.readouterr().out)
    assert exit_code == 1
    assert report["source"] == "yahoo"
    assert report["status"] == "partial"
    assert report["dataThrough"] == "2024-02-02"
    assert report["coverage"]["availableSessions"] == 3
    assert report["coverage"]["expectedWeekdays"] == 4
    assert report["coverage"]["ratio"] == 0.75
    assert report["failureReasons"][0]["messageKey"] == ("market.missing_sessions")
    assert ticker.history_kwargs["timeout"] == 10.0

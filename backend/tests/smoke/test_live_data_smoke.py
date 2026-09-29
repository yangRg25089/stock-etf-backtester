from __future__ import annotations

import io
import json
from datetime import UTC, datetime
from urllib.error import HTTPError

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


class _Response:
    status = 200

    def __init__(self, payload: dict[str, object]) -> None:
        self._payload = json.dumps(payload).encode("utf-8")

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, _limit: int = -1) -> bytes:
        return self._payload


def _company_facts_payload() -> dict[str, object]:
    return {
        "cik": 320193,
        "facts": {
            "us-gaap": {
                "EarningsPerShareDiluted": {
                    "units": {
                        "USD / shares": [
                            {
                                "start": "2024-01-01",
                                "end": "2024-03-31",
                                "val": 1.5,
                                "accn": "0000320193-24-000001",
                                "form": "10-Q",
                                "filed": "2024-05-02",
                            }
                        ]
                    }
                }
            }
        },
    }


def test_smoke_requires_live_opt_in_before_any_provider_is_called(capsys) -> None:
    opened: list[object] = []

    exit_code = main(
        ["--source", "sec", "--symbol", "AAPL", "--cik", "0000320193"],
        environment={},
        urlopen_fn=lambda *args, **kwargs: opened.append((args, kwargs)),
    )

    report = json.loads(capsys.readouterr().out)
    assert exit_code == 2
    assert report["status"] == "skipped"
    assert report["failureReasons"][0]["code"] == "live_access_not_enabled"
    assert opened == []


def test_sec_smoke_without_declared_user_agent_fails_before_network(capsys) -> None:
    opened: list[object] = []

    exit_code = main(
        [
            "--live",
            "--source",
            "sec",
            "--symbol",
            "AAPL",
            "--cik",
            "0000320193",
        ],
        environment={},
        urlopen_fn=lambda *args, **kwargs: opened.append((args, kwargs)),
    )

    report = json.loads(capsys.readouterr().out)
    assert exit_code == 2
    assert report["status"] == "unavailable"
    assert report["failureReasons"][0]["messageKey"] == (
        "smoke.sec_user_agent_required"
    )
    assert opened == []


def test_sec_smoke_reports_normalized_fact_coverage_without_echoing_user_agent(
    capsys,
) -> None:
    user_agent = "Stock ETF Backtester contact@example.test"
    seen: dict[str, object] = {}

    def fake_urlopen(request, *, timeout):
        seen["url"] = request.full_url
        seen["agent"] = request.get_header("User-agent")
        seen["timeout"] = timeout
        return _Response(_company_facts_payload())

    exit_code = main(
        [
            "--live",
            "--source",
            "sec",
            "--symbol",
            "AAPL",
            "--cik",
            "0000320193",
            "--timeout-seconds",
            "3",
        ],
        environment={"SEC_USER_AGENT": user_agent},
        urlopen_fn=fake_urlopen,
    )

    output = capsys.readouterr().out
    report = json.loads(output)
    assert exit_code == 0
    assert report["status"] == "completed"
    assert report["source"] == "sec:companyfacts"
    assert report["dataThrough"] == "2024-05-02"
    assert report["coverage"] == {
        "normalizedDilutedEpsFacts": 1,
        "sourceDilutedEpsRows": 1,
        "ratio": 1.0,
    }
    assert seen == {
        "url": ("https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json"),
        "agent": user_agent,
        "timeout": 3.0,
    }
    assert user_agent not in output


def test_sec_smoke_classifies_rate_limit_and_does_not_print_response_body(
    capsys,
) -> None:
    private_body = "private upstream payload"

    def rate_limited(_request, *, timeout):
        raise HTTPError(
            "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json",
            429,
            private_body,
            hdrs=None,
            fp=io.BytesIO(private_body.encode()),
        )

    exit_code = main(
        [
            "--live",
            "--source",
            "sec",
            "--symbol",
            "AAPL",
            "--cik",
            "0000320193",
        ],
        environment={"SEC_USER_AGENT": "contact@example.test"},
        urlopen_fn=rate_limited,
    )

    output = capsys.readouterr().out
    report = json.loads(output)
    assert exit_code == 1
    assert report["status"] == "unavailable"
    assert report["failureReasons"][0]["code"] == "provider_rate_limited"
    assert private_body not in output
    assert "contact@example.test" not in output


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
        environment={},
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

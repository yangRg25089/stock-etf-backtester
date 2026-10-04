from datetime import UTC, date, datetime, timedelta, timezone

from app.calendar import schedule
from app.config.validation import validate_draft
from app.data.run_planning import plan_market_request


def test_local_today_is_not_future_when_utc_is_still_the_previous_date():
    now = datetime(2026, 10, 5, 3, 0, tzinfo=timezone(timedelta(hours=9)))
    sessions = ((date(2026, 10, 2), datetime(2026, 10, 2, 20, 0, tzinfo=UTC)),)
    for end, warnings in [("2026-10-05", 0), ("2026-10-06", 1)]:
        config = validate_draft(
            {
                "shared": {"run": {"startDate": "2026-10-01", "endDate": end}},
                "strategies": [{"id": "vix", "presetId": "vix_dca"}],
            }
        ).config_for()
        plan = plan_market_request(
            config.shared,
            sessions,
            now=now,
            lookback_sessions=0,
            publication_delay=timedelta(minutes=15),
        )
        assert plan.request.exchange_calendar.as_of_date == date(2026, 10, 5)
        assert plan.request.end_date == date(2026, 10, 2)
        result = schedule(config.shared, plan.request.exchange_calendar)
        assert (
            len(
                [
                    d
                    for d in result.diagnostics
                    if d.message_key == "calendar.end_date_clamped"
                ]
            )
            == warnings
        )


def test_close_publication_checks_keep_utc_instant_with_local_calendar_date():
    now = datetime(2026, 10, 3, 5, 10, tzinfo=timezone(timedelta(hours=9)))
    sessions = (
        (date(2026, 10, 1), datetime(2026, 10, 1, 20, 0, tzinfo=UTC)),
        (date(2026, 10, 2), datetime(2026, 10, 2, 20, 0, tzinfo=UTC)),
    )
    config = validate_draft(
        {
            "shared": {"run": {"startDate": "2026-10-01", "endDate": "2026-10-03"}},
            "strategies": [{"id": "vix", "presetId": "vix_dca"}],
        }
    ).config_for()
    plan = plan_market_request(
        config.shared,
        sessions,
        now=now,
        lookback_sessions=0,
        publication_delay=timedelta(minutes=15),
    )
    assert plan.request.end_date == date(2026, 10, 1)
    assert plan.request.exchange_calendar.as_of_date == date(2026, 10, 3)

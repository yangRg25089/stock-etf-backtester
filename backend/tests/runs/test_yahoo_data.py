from datetime import date

from app.data.run_planning import _apply_market_gap_policy
from app.domain.status import Diagnostic, DiagnosticCode


def test_listing_boundary_removes_only_verified_pre_listing_sessions() -> None:
    days = (date(2024, 1, 29), date(2024, 1, 30), date(2024, 1, 31), date(2024, 2, 1))
    diagnostics = (
        Diagnostic(
            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
            messageKey="market.missing_sessions",
            source="yahoo",
            details={"missingSessions": ["2024-01-29", "2024-01-30"]},
        ),
    )
    sessions, retained = _apply_market_gap_policy(
        days,
        diagnostics,
        scheduled_end=days[-1],
        latest_quote=days[-1],
        available_from=date(2024, 1, 31),
    )
    assert sessions == days[2:]
    assert retained == ()


def test_listing_boundary_does_not_hide_consecutive_gaps_after_listing() -> None:
    days = (date(2024, 1, 29), date(2024, 1, 30), date(2024, 1, 31), date(2024, 2, 1))
    diagnostics = (
        Diagnostic(
            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
            messageKey="market.missing_sessions",
            source="yahoo",
            details={"missingSessions": ["2024-01-29", "2024-01-30", "2024-01-31"]},
        ),
    )
    sessions, retained = _apply_market_gap_policy(
        days,
        diagnostics,
        scheduled_end=days[-1],
        latest_quote=days[-1],
        available_from=date(2024, 1, 30),
    )
    assert sessions == days[1:]
    assert retained[0].details["missingSessions"] == ("2024-01-30", "2024-01-31")


def test_calendar_range_handles_weekends_at_both_requested_boundaries() -> None:
    from app.runs.yahoo_data import YahooRunDataProvider, _session_records

    provider = YahooRunDataProvider()
    start, end = date(2022, 11, 13), date(2022, 11, 20)
    calendar = provider._get_calendar("XNYS", start, end)
    records = _session_records(calendar, start, end)
    assert tuple(item[0] for item in records) == tuple(
        date(2022, 11, day) for day in range(14, 19)
    )


def test_latest_end_trims_trailing_unpublished_quote_sessions_without_warning() -> None:
    sessions = (date(2026, 9, 28), date(2026, 9, 29))
    diagnostics = (
        Diagnostic(
            code=DiagnosticCode.PRICE_BASIS_UNAVAILABLE,
            messageKey="market.price_basis_unavailable",
            asOf=date(2026, 9, 29),
            source="yahoo",
            details={"symbol": "QQQ", "date": "2026-09-29"},
        ),
        Diagnostic(
            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
            messageKey="market.missing_sessions",
            source="yahoo",
            details={"missingSessions": ["2026-09-29"]},
        ),
    )

    effective_sessions, effective_diagnostics = _apply_market_gap_policy(
        sessions,
        diagnostics,
        scheduled_end=date(2026, 9, 29),
        latest_quote=date(2026, 9, 28),
    )

    assert effective_sessions == (date(2026, 9, 28),)
    assert effective_diagnostics == ()


def test_latest_end_skips_an_isolated_interior_session_without_filling_prices() -> None:
    diagnostics = (
        Diagnostic(
            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
            messageKey="market.missing_sessions",
            source="yahoo",
            details={"missingSessions": ["2026-09-28"]},
        ),
    )

    effective_sessions, effective_diagnostics = _apply_market_gap_policy(
        (date(2026, 9, 28), date(2026, 9, 29), date(2026, 9, 30)),
        diagnostics,
        scheduled_end=date(2026, 9, 30),
        latest_quote=date(2026, 9, 30),
    )

    assert effective_sessions == (date(2026, 9, 29), date(2026, 9, 30))
    assert effective_diagnostics == ()


def test_latest_end_skips_one_interior_gap_and_trims_unpublished_tail() -> None:
    diagnostics = (
        Diagnostic(
            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
            messageKey="market.missing_sessions",
            source="yahoo",
            details={"missingSessions": ["2026-09-28", "2026-09-30"]},
        ),
        Diagnostic(
            code=DiagnosticCode.PRICE_BASIS_UNAVAILABLE,
            messageKey="market.price_basis_unavailable",
            asOf=date(2026, 9, 30),
            source="yahoo",
            details={"symbol": "QQQ", "date": "2026-09-30"},
        ),
    )

    effective_sessions, effective_diagnostics = _apply_market_gap_policy(
        (date(2026, 9, 28), date(2026, 9, 29), date(2026, 9, 30)),
        diagnostics,
        scheduled_end=date(2026, 9, 30),
        latest_quote=date(2026, 9, 29),
    )

    assert effective_sessions == (date(2026, 9, 29),)
    assert effective_diagnostics == ()


def test_fixed_end_skips_isolated_missing_session_without_inventing_price() -> None:
    diagnostics = (
        Diagnostic(
            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
            messageKey="market.missing_sessions",
            source="yahoo",
            details={"missingSessions": ["2026-09-29"]},
        ),
    )

    effective_sessions, effective_diagnostics = _apply_market_gap_policy(
        (date(2026, 9, 28), date(2026, 9, 29)),
        diagnostics,
        scheduled_end=date(2026, 9, 29),
        latest_quote=date(2026, 9, 28),
    )

    assert effective_sessions == (date(2026, 9, 28),)
    assert effective_diagnostics == ()


def test_consecutive_missing_sessions_remain_a_required_data_error() -> None:
    diagnostics = (
        Diagnostic(
            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
            messageKey="market.missing_sessions",
            source="yahoo",
            details={"missingSessions": ["2026-09-28", "2026-09-29"]},
        ),
    )

    effective_sessions, effective_diagnostics = _apply_market_gap_policy(
        (date(2026, 9, 28), date(2026, 9, 29), date(2026, 9, 30)),
        diagnostics,
        scheduled_end=date(2026, 9, 30),
        latest_quote=date(2026, 9, 30),
    )

    assert effective_sessions == (
        date(2026, 9, 28),
        date(2026, 9, 29),
        date(2026, 9, 30),
    )
    assert effective_diagnostics == diagnostics


def test_separate_single_session_gaps_are_each_skipped() -> None:
    sessions = (
        date(2026, 9, 28),
        date(2026, 9, 29),
        date(2026, 9, 30),
        date(2026, 10, 1),
        date(2026, 10, 2),
    )
    diagnostics = (
        Diagnostic(
            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
            messageKey="market.missing_sessions",
            source="yahoo",
            details={"missingSessions": ["2026-09-29", "2026-10-01"]},
        ),
    )

    effective_sessions, effective_diagnostics = _apply_market_gap_policy(
        sessions,
        diagnostics,
        scheduled_end=date(2026, 10, 2),
        latest_quote=date(2026, 10, 2),
    )

    assert effective_sessions == (
        date(2026, 9, 28),
        date(2026, 9, 30),
        date(2026, 10, 2),
    )
    assert effective_diagnostics == ()


def test_latest_end_keeps_original_calendar_when_quote_precedes_every_session() -> None:
    diagnostics = (
        Diagnostic(
            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
            messageKey="market.missing_sessions",
            source="yahoo",
            details={"missingSessions": ["2026-09-28", "2026-09-29"]},
        ),
    )

    effective_sessions, effective_diagnostics = _apply_market_gap_policy(
        (date(2026, 9, 28), date(2026, 9, 29)),
        diagnostics,
        scheduled_end=date(2026, 9, 29),
        latest_quote=date(2026, 9, 27),
    )

    assert effective_sessions == (date(2026, 9, 28), date(2026, 9, 29))
    assert effective_diagnostics == diagnostics

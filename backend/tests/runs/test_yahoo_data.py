from datetime import date

from app.domain.contracts import EndMode
from app.domain.status import Diagnostic, DiagnosticCode, DiagnosticSeverity
from app.runs.yahoo_data import _apply_latest_quote_fallback


def test_latest_end_trims_only_trailing_unpublished_quote_sessions() -> None:
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

    effective_sessions, effective_diagnostics = _apply_latest_quote_fallback(
        sessions,
        diagnostics,
        end_mode=EndMode.LATEST,
        scheduled_end=date(2026, 9, 29),
        latest_quote=date(2026, 9, 28),
        symbol="QQQ",
    )

    assert effective_sessions == (date(2026, 9, 28),)
    assert len(effective_diagnostics) == 1
    warning = effective_diagnostics[0]
    assert warning.code is DiagnosticCode.SOURCE_QUALITY_WARNING
    assert warning.severity is DiagnosticSeverity.WARNING
    assert warning.message_key == "market.latest_quote_delayed"
    assert warning.details["unavailableSessions"] == ("2026-09-29",)


def test_latest_end_keeps_interior_market_gaps_as_errors() -> None:
    diagnostics = (
        Diagnostic(
            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
            messageKey="market.missing_sessions",
            source="yahoo",
            details={"missingSessions": ["2026-09-28"]},
        ),
    )

    effective_sessions, effective_diagnostics = _apply_latest_quote_fallback(
        (date(2026, 9, 28), date(2026, 9, 29)),
        diagnostics,
        end_mode=EndMode.LATEST,
        scheduled_end=date(2026, 9, 29),
        latest_quote=date(2026, 9, 29),
        symbol="QQQ",
    )

    assert effective_sessions == (date(2026, 9, 28), date(2026, 9, 29))
    assert effective_diagnostics == diagnostics


def test_latest_end_reports_tail_delay_without_hiding_an_interior_gap() -> None:
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

    effective_sessions, effective_diagnostics = _apply_latest_quote_fallback(
        (date(2026, 9, 28), date(2026, 9, 29), date(2026, 9, 30)),
        diagnostics,
        end_mode=EndMode.LATEST,
        scheduled_end=date(2026, 9, 30),
        latest_quote=date(2026, 9, 29),
        symbol="QQQ",
    )

    assert effective_sessions == (date(2026, 9, 28), date(2026, 9, 29))
    assert len(effective_diagnostics) == 2
    missing = next(
        item
        for item in effective_diagnostics
        if item.message_key == "market.missing_sessions"
    )
    warning = next(
        item
        for item in effective_diagnostics
        if item.message_key == "market.latest_quote_delayed"
    )
    assert missing.details["missingSessions"] == ("2026-09-28",)
    assert warning.severity is DiagnosticSeverity.WARNING
    assert warning.details["unavailableSessions"] == ("2026-09-30",)


def test_fixed_end_does_not_trim_missing_quote_sessions() -> None:
    diagnostics = (
        Diagnostic(
            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
            messageKey="market.missing_sessions",
            source="yahoo",
            details={"missingSessions": ["2026-09-29"]},
        ),
    )

    effective_sessions, effective_diagnostics = _apply_latest_quote_fallback(
        (date(2026, 9, 28), date(2026, 9, 29)),
        diagnostics,
        end_mode=EndMode.FIXED,
        scheduled_end=date(2026, 9, 29),
        latest_quote=date(2026, 9, 28),
        symbol="QQQ",
    )

    assert effective_sessions == (date(2026, 9, 28), date(2026, 9, 29))
    assert effective_diagnostics == diagnostics


def test_latest_end_does_not_guess_numeric_looking_symbol_is_missing_data() -> None:
    diagnostics = (
        Diagnostic(
            code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
            messageKey="market.missing_sessions",
            source="yahoo",
            details={"missingSessions": ["2026-09-28", "2026-09-29"]},
        ),
    )

    effective_sessions, effective_diagnostics = _apply_latest_quote_fallback(
        (date(2026, 9, 28), date(2026, 9, 29)),
        diagnostics,
        end_mode=EndMode.LATEST,
        scheduled_end=date(2026, 9, 29),
        latest_quote=date(2026, 9, 27),
        symbol="QQQ",
    )

    assert effective_sessions == (date(2026, 9, 28), date(2026, 9, 29))
    assert effective_diagnostics == diagnostics

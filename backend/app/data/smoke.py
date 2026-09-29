"""Opt-in, read-only live checks for the Yahoo and SEC data boundaries.

Normal application startup and deterministic tests do not import this command's
provider dependencies or make network requests. Run it explicitly with
``python -m app.data.smoke --live``.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, date, datetime, timedelta
from typing import Protocol, cast
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from app.calendar import ExchangeCalendar
from app.data.market_data import MarketDataRequest
from app.data.providers.sec import SecCompanyFactsAdapter
from app.data.providers.yahoo import TickerFactory, YahooFinanceAdapter

_SEC_COMPANYFACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"
_MAX_SEC_RESPONSE_BYTES = 20 * 1024 * 1024


class _Response(Protocol):
    status: int

    def read(self, size: int = -1) -> bytes: ...

    def __enter__(self) -> _Response: ...

    def __exit__(self, *args: object) -> object: ...


_Urlopen = Callable[..., _Response]


def main(
    argv: Sequence[str] | None = None,
    *,
    environment: Mapping[str, str] | None = None,
    urlopen_fn: _Urlopen | None = None,
    ticker_factory: TickerFactory | None = None,
) -> int:
    """Run one opt-in provider check and print a sanitized JSON report."""

    args = _parser().parse_args(argv)
    source_name = "sec:companyfacts" if args.source == "sec" else "yahoo"
    report_base: dict[str, object] = {
        "asOf": datetime.now(UTC).isoformat(),
        "source": source_name,
        "symbol": args.symbol,
        "status": "unavailable",
        "dataThrough": None,
        "coverage": None,
        "failureReasons": [],
    }
    if not args.live:
        report_base["status"] = "skipped"
        report_base["failureReasons"] = [
            {
                "code": "live_access_not_enabled",
                "messageKey": "smoke.live_opt_in_required",
            }
        ]
        _print_report(report_base)
        return 2

    env = os.environ if environment is None else environment
    try:
        if args.source == "sec":
            report, exit_code = _run_sec_smoke(
                args,
                environment=env,
                urlopen_fn=urlopen if urlopen_fn is None else urlopen_fn,
                report_base=report_base,
            )
        else:
            report, exit_code = _run_yahoo_smoke(
                args,
                ticker_factory=ticker_factory,
                report_base=report_base,
            )
    except Exception as error:
        report_base["failureReasons"] = [
            {
                "code": "smoke_failed",
                "messageKey": "smoke.unexpected_failure",
                "exceptionType": type(error).__name__,
            }
        ]
        report_base["status"] = "unavailable"
        _print_report(report_base)
        return 1
    _print_report(report)
    return exit_code


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run an explicit live data smoke check"
    )
    parser.add_argument(
        "--live", action="store_true", help="allow one read-only request"
    )
    parser.add_argument("--source", choices=("yahoo", "sec"), default="yahoo")
    parser.add_argument("--symbol", default="QQQ")
    parser.add_argument("--cik")
    parser.add_argument("--start-date", type=_iso_date)
    parser.add_argument("--end-date", type=_iso_date)
    parser.add_argument("--timeout-seconds", type=_positive_timeout, default=10.0)
    return parser


def _run_yahoo_smoke(
    args: argparse.Namespace,
    *,
    ticker_factory: TickerFactory | None,
    report_base: dict[str, object],
) -> tuple[dict[str, object], int]:
    as_of = datetime.now(UTC).date()
    end_date = args.end_date or as_of
    start_date = args.start_date or end_date - timedelta(days=30)
    if start_date > end_date:
        return _unavailable(
            report_base,
            "invalid_date_range",
            "smoke.invalid_date_range",
        ), 2

    expected_weekdays = tuple(
        day
        for offset in range((end_date - start_date).days + 1)
        if (day := start_date + timedelta(days=offset)).weekday() < 5
    )
    if not expected_weekdays:
        return _unavailable(
            report_base,
            "no_expected_sessions",
            "smoke.no_expected_weekday_sessions",
        ), 2

    calendar = ExchangeCalendar.from_dates(
        expected_weekdays,
        as_of_date=as_of,
        latest_complete_date=(
            max(day for day in expected_weekdays if day <= as_of)
            if any(day <= as_of for day in expected_weekdays)
            else None
        ),
        calendar_coverage_end_date=expected_weekdays[-1],
    )
    request = MarketDataRequest(
        symbol=args.symbol,
        startDate=start_date,
        endDate=end_date,
        exchangeCalendar=calendar,
        macroStalenessSessions=0,
    )
    adapter = YahooFinanceAdapter(
        ticker_factory=ticker_factory,
        request_timeout_seconds=args.timeout_seconds,
    )
    result = adapter.load(request)
    bars = () if result.snapshot is None else result.snapshot.market.bars
    data_through = max((bar.date for bar in bars), default=None)
    available = len(bars)
    expected = len(expected_weekdays)
    ratio = available / expected
    reasons = [
        {"code": item.code.value, "messageKey": item.message_key}
        for item in result.diagnostics
    ]
    if available < expected and not any(
        reason["messageKey"] == "market.missing_sessions" for reason in reasons
    ):
        reasons.append(
            {
                "code": "missing_sessions",
                "messageKey": "market.missing_sessions",
            }
        )
    status = "completed" if not reasons else "partial" if bars else "unavailable"
    report = {
        **report_base,
        "source": "yahoo",
        "status": status,
        "dataThrough": None if data_through is None else data_through.isoformat(),
        "coverage": {
            "availableSessions": available,
            "expectedWeekdays": expected,
            "ratio": round(ratio, 6),
        },
        "failureReasons": reasons,
    }
    return report, 0 if status == "completed" else 1


def _run_sec_smoke(
    args: argparse.Namespace,
    *,
    environment: Mapping[str, str],
    urlopen_fn: _Urlopen,
    report_base: dict[str, object],
) -> tuple[dict[str, object], int]:
    user_agent = environment.get("SEC_USER_AGENT", "")
    if not user_agent.strip():
        return (
            _unavailable(
                {**report_base, "source": "sec:companyfacts"},
                "sec_user_agent_required",
                "smoke.sec_user_agent_required",
            ),
            2,
        )
    cik = _normalize_cik(args.cik)
    if cik is None:
        return (
            _unavailable(
                {**report_base, "source": "sec:companyfacts"},
                "invalid_cik",
                "smoke.sec_cik_required",
            ),
            2,
        )

    request = Request(
        _SEC_COMPANYFACTS_URL.format(cik=cik),
        headers={"User-Agent": user_agent, "Accept": "application/json"},
    )
    try:
        with urlopen_fn(request, timeout=args.timeout_seconds) as response:
            if response.status < 200 or response.status >= 300:
                return (
                    _unavailable(
                        {**report_base, "source": "sec:companyfacts"},
                        "provider_http_error",
                        "smoke.provider_http_error",
                    ),
                    1,
                )
            body = response.read(_MAX_SEC_RESPONSE_BYTES + 1)
    except HTTPError as error:
        code = "provider_rate_limited" if error.code == 429 else "provider_http_error"
        key = (
            "smoke.provider_rate_limited"
            if error.code == 429
            else "smoke.provider_http_error"
        )
        error.close()
        return _unavailable({**report_base, "source": "sec:companyfacts"}, code, key), 1
    except (TimeoutError, URLError) as error:
        timeout = isinstance(error, TimeoutError) or isinstance(
            getattr(error, "reason", None), TimeoutError
        )
        return (
            _unavailable(
                {**report_base, "source": "sec:companyfacts"},
                "provider_timeout" if timeout else "provider_request_failed",
                "smoke.provider_timeout" if timeout else "data.provider_request_failed",
                exception_type=type(error).__name__,
            ),
            1,
        )
    except OSError as error:
        return (
            _unavailable(
                {**report_base, "source": "sec:companyfacts"},
                "provider_request_failed",
                "data.provider_request_failed",
                exception_type=type(error).__name__,
            ),
            1,
        )

    if len(body) > _MAX_SEC_RESPONSE_BYTES:
        return (
            _unavailable(
                {**report_base, "source": "sec:companyfacts"},
                "provider_response_too_large",
                "smoke.provider_response_too_large",
            ),
            1,
        )
    try:
        payload_value = json.loads(body)
        if not isinstance(payload_value, Mapping):
            raise ValueError("CompanyFacts response must be an object")
        payload = cast(Mapping[str, object], payload_value)
        source_rows = _source_eps_row_count(payload)
        facts = SecCompanyFactsAdapter().parse(
            payload,
            symbol=args.symbol,
            expected_cik=cik,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError) as error:
        return (
            _unavailable(
                {**report_base, "source": "sec:companyfacts"},
                "provider_response_invalid",
                "smoke.provider_response_invalid",
                exception_type=type(error).__name__,
            ),
            1,
        )

    normalized_count = len(facts)
    ratio = normalized_count / source_rows if source_rows else 0.0
    reasons: list[dict[str, str]] = []
    if source_rows == 0:
        reasons.append(
            {
                "code": "eps_facts_unavailable",
                "messageKey": "smoke.sec_eps_facts_unavailable",
            }
        )
    elif normalized_count < source_rows:
        reasons.append(
            {
                "code": "normalized_fact_coverage_incomplete",
                "messageKey": "smoke.sec_coverage_incomplete",
            }
        )
    status = "completed" if not reasons else "partial" if facts else "unavailable"
    data_through = max((fact.filed for fact in facts), default=None)
    report = {
        **report_base,
        "source": "sec:companyfacts",
        "status": status,
        "dataThrough": None if data_through is None else data_through.isoformat(),
        "coverage": {
            "normalizedDilutedEpsFacts": normalized_count,
            "sourceDilutedEpsRows": source_rows,
            "ratio": round(ratio, 6),
        },
        "failureReasons": reasons,
    }
    return report, 0 if status == "completed" else 1


def _source_eps_row_count(payload: Mapping[str, object]) -> int:
    facts_value = payload.get("facts")
    if not isinstance(facts_value, Mapping):
        return 0
    us_gaap = facts_value.get("us-gaap")
    if not isinstance(us_gaap, Mapping):
        return 0
    concept = us_gaap.get("EarningsPerShareDiluted")
    if not isinstance(concept, Mapping):
        return 0
    units = concept.get("units")
    if not isinstance(units, Mapping):
        return 0
    return sum(len(rows) for rows in units.values() if isinstance(rows, list))


def _normalize_cik(value: str | None) -> str | None:
    if value is None or not value.isascii() or not value.isdigit() or len(value) > 10:
        return None
    return value.zfill(10)


def _unavailable(
    report: dict[str, object],
    code: str,
    message_key: str,
    *,
    exception_type: str | None = None,
) -> dict[str, object]:
    reason: dict[str, str] = {"code": code, "messageKey": message_key}
    if exception_type is not None:
        reason["exceptionType"] = exception_type
    return {**report, "status": "unavailable", "failureReasons": [reason]}


def _print_report(report: Mapping[str, object]) -> None:
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, default=_json_default))


def _json_default(value: object) -> object:
    if isinstance(value, date):
        return value.isoformat()
    raise TypeError(f"cannot encode value of type {type(value).__name__}")


def _iso_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("date must use YYYY-MM-DD") from error


def _positive_timeout(value: str) -> float:
    try:
        timeout = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("timeout must be a positive number") from error
    if not math.isfinite(timeout) or timeout <= 0:
        raise argparse.ArgumentTypeError("timeout must be a finite positive number")
    return timeout


if __name__ == "__main__":
    sys.exit(main())

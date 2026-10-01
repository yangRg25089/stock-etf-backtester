"""End-to-end API assertions against the pinned Task 4 data fixture."""

from __future__ import annotations

import asyncio
import csv
import io
import math
from collections.abc import Mapping
from decimal import Decimal

import httpx
from fastapi.encoders import jsonable_encoder

from app.main import app
from app.runs.types import RunResponse
from tests.e2e.fixture_provider import create_fixture_run_manager

_SHARED = {
    "run": {
        "symbol": "QQQ",
        "startDate": "2024-01-31",
        "endDate": "2024-02-02",
        "endMode": "fixed",
    },
    "contribution": {"day": 1, "amount": 100},
}


def _draft(
    params: Mapping[str, object] | None = None,
    *,
    preset_id: str = "vix_dca",
    strategy_id: str = "strategy-vix_dca-1",
    shared: Mapping[str, object] | None = None,
) -> dict[str, object]:
    return {
        "shared": _SHARED if shared is None else dict(shared),
        "strategies": [
            {
                "id": strategy_id,
                "presetId": preset_id,
                "enabled": True,
                "params": {} if params is None else dict(params),
            }
        ],
    }


async def _submit_and_read(
    client: httpx.AsyncClient,
    draft: Mapping[str, object],
    *,
    idempotency_key: str,
    scope: str = "active",
) -> tuple[httpx.Response, httpx.Response]:
    strategy_id = str(draft["strategies"][0]["id"])
    submitted = await client.post(
        "/api/v1/runs",
        headers={"Idempotency-Key": idempotency_key},
        json=jsonable_encoder(
            {
                "draft": draft,
                "scope": scope,
                "activeStrategyId": strategy_id,
            }
        ),
    )
    assert submitted.status_code == 202, submitted.text
    run_id = submitted.json()["runId"]
    queried = await client.get(f"/api/v1/runs/{run_id}")
    assert queried.status_code == 200, queried.text
    return submitted, queried


def _with_fixture_api(exercise):
    previous = getattr(app.state, "run_service", None)
    had_previous = hasattr(app.state, "run_service")
    app.state.run_service = create_fixture_run_manager()

    async def send():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://fixture-test",
        ) as client:
            return await exercise(client)

    try:
        return asyncio.run(send())
    finally:
        if had_previous:
            app.state.run_service = previous
        elif hasattr(app.state, "run_service"):
            del app.state.run_service


def test_fixture_run_preserves_t_plus_one_benchmark_identity_and_csv_values() -> None:
    async def exercise(client: httpx.AsyncClient):
        submitted, queried = await _submit_and_read(
            client,
            _draft(),
            idempotency_key="task4-fixture-vix",
        )
        run_id = submitted.json()["runId"]
        summary = await client.get(
            f"/api/v1/runs/{run_id}/export/summary",
            params={"focusedResultId": "strategy-vix_dca-1"},
        )
        trades = await client.get(
            f"/api/v1/runs/{run_id}/export/trades",
            params={"focusedResultId": "strategy-vix_dca-1"},
        )
        daily = await client.get(
            f"/api/v1/runs/{run_id}/export/daily-assets",
            params={"focusedResultId": "benchmark:monthly-dca"},
        )
        return queried.json(), summary, trades, daily

    saved, summary, trade_csv, daily_csv = _with_fixture_api(exercise)
    assert saved["status"] == "completed"
    results = saved["result"]["strategyRuns"]
    strategy = next(item for item in results if item["id"] == "strategy-vix_dca-1")
    dca = next(item for item in results if item["id"] == "benchmark:monthly-dca")
    assert strategy["role"] == "strategy"
    assert dca["role"] == "benchmark"
    assert strategy["status"] == dca["status"] == "completed"

    buy_signal_dates = [
        item["date"]
        for item in strategy["signals"]
        if item["signalId"] == "vix.buy" and item["state"] == "true"
    ]
    signal_buy = next(
        item for item in strategy["trades"] if item["reason"] == "signal_buy"
    )
    assert buy_signal_dates
    assert signal_buy["date"] > buy_signal_dates[0]
    assert signal_buy["date"] == "2024-02-02"

    summary_row = next(csv.DictReader(io.StringIO(summary.text)))
    assert summary_row["resultId"] == strategy["id"]
    assert summary_row["endingEquity"] == strategy["metrics"]["endingEquity"]
    exported_trades = list(csv.DictReader(io.StringIO(trade_csv.text)))
    assert [item["date"] for item in exported_trades] == [
        item["date"] for item in strategy["trades"]
    ]

    daily_rows = list(csv.DictReader(io.StringIO(daily_csv.text)))
    assert [item["date"] for item in daily_rows] == [
        item["date"] for item in dca["dailyAssets"]
    ]
    assert [item["totalAsset"] for item in daily_rows] == [
        item["totalAsset"] for item in dca["dailyAssets"]
    ]

    metrics = dca["metrics"]
    total_contributed = Decimal(metrics["totalContributed"])
    ending_equity = Decimal(metrics["endingEquity"])
    assert total_contributed == Decimal("100")
    assert Decimal(metrics["netProfit"]) == ending_equity - total_contributed
    assert Decimal(metrics["returnOnContributions"]) == (
        ending_equity / total_contributed - Decimal("1")
    )
    assert Decimal(metrics["capitalMultiple"]) == ending_equity / total_contributed
    expected_drawdown = (Decimal("202") - Decimal("198")) / Decimal("202")
    assert abs(Decimal(metrics["maximumDrawdown"]) - expected_drawdown) < Decimal(
        "1e-24"
    )
    expected_xirr = float(ending_equity / total_contributed) ** 365 - 1
    assert math.isclose(
        float(metrics["xirr"]), expected_xirr, rel_tol=1e-12, abs_tol=1e-12
    )


def test_no_signal_custom_funds_remain_cash_separate_from_monthly_benchmark() -> None:
    async def exercise(client: httpx.AsyncClient):
        _submitted, queried = await _submit_and_read(
            client,
            _draft(
                {
                    "vix.buyEnabled": True,
                    "vix.buyThreshold": 40,
                    "rsi.buyEnabled": False,
                    "ma.buyEnabled": False,
                    "bollinger.buyEnabled": False,
                },
                preset_id="composite_dca",
                strategy_id="strategy-composite-1",
            ),
            idempotency_key="task4-fixture-fixed-equivalence",
        )
        return queried.json()

    saved = _with_fixture_api(exercise)
    assert saved["status"] == "completed"
    results = saved["result"]["strategyRuns"]
    strategy = next(item for item in results if item["id"] == "strategy-composite-1")
    dca = next(item for item in results if item["id"] == "benchmark:monthly-dca")
    assert strategy["status"] == dca["status"] == "completed"
    assert strategy["trades"] == []
    assert len(dca["trades"]) == 1
    assert strategy["metrics"]["totalContributed"] == dca["metrics"]["totalContributed"]
    assert strategy["metrics"]["actualInvested"] == "0"
    assert (
        strategy["metrics"]["endingEquity"] == strategy["metrics"]["totalContributed"]
    )
    assert all(item["cash"] == item["totalAsset"] for item in strategy["dailyAssets"])


def test_successful_zero_trade_fixture_run_still_exports_the_trade_header() -> None:
    async def exercise(client: httpx.AsyncClient):
        submitted, queried = await _submit_and_read(
            client,
            _draft(
                {
                    "vix.buyEnabled": True,
                    "vix.buyThreshold": 40,
                    "rsi.buyEnabled": False,
                    "ma.buyEnabled": False,
                    "bollinger.buyEnabled": False,
                },
                preset_id="composite_dca",
                strategy_id="strategy-composite-1",
            ),
            idempotency_key="task4-fixture-zero-trades",
        )
        run_id = submitted.json()["runId"]
        exported = await client.get(
            f"/api/v1/runs/{run_id}/export/trades",
            params={"focusedResultId": "strategy-composite-1"},
        )
        return queried.json(), exported

    saved, exported = _with_fixture_api(exercise)
    strategy = next(
        item
        for item in saved["result"]["strategyRuns"]
        if item["id"] == "strategy-composite-1"
    )
    assert strategy["status"] == "completed"
    assert strategy["metrics"] is not None
    assert strategy["trades"] == []
    assert exported.status_code == 200
    assert exported.text.splitlines() == [
        "runId,resultId,date,side,reason,quantity,price,cashAmount,currency,"
        "signalId,dataSources,calendarAsOf,marketDataThrough"
    ]


def test_pe_signal_uses_valuation_price_and_does_not_read_future_publications() -> None:
    single_january_session = {
        "run": {
            "symbol": "QQQ",
            "startDate": "2024-01-31",
            "endDate": "2024-01-31",
            "endMode": "fixed",
        },
        "contribution": {"day": 31, "amount": 100},
    }

    async def exercise(client: httpx.AsyncClient):
        common_params = {
            "vix.buyEnabled": False,
            "rsi.buyEnabled": False,
            "ma.buyEnabled": False,
            "bollinger.buyEnabled": False,
            "rate.buyEnabled": False,
            "pe.buyEnabled": True,
            "pe.etfMinCoverage": 0.8,
        }
        price_basis_draft = _draft(
            {**common_params, "pe.threshold": 30},
            preset_id="composite_dca",
            strategy_id="strategy-pe-price-basis",
            shared=single_january_session,
        )
        _price_submitted, price_queried = await _submit_and_read(
            client,
            price_basis_draft,
            idempotency_key="task4-pe-price-basis",
        )
        threshold_draft = _draft(
            {**common_params, "pe.threshold": 40},
            preset_id="composite_dca",
            strategy_id="strategy-pe-threshold",
            shared=single_january_session,
        )
        _threshold_submitted, threshold_queried = await _submit_and_read(
            client,
            threshold_draft,
            idempotency_key="task4-pe-threshold",
        )
        late_draft = _draft(
            {**common_params, "pe.threshold": 25},
            preset_id="composite_dca",
            strategy_id="strategy-pe-late-publication",
            shared={
                "run": {
                    "symbol": "QQQ",
                    "startDate": "2024-02-01",
                    "endDate": "2024-02-01",
                    "endMode": "fixed",
                },
                "contribution": {"day": 1, "amount": 100},
            },
        )
        _late_submitted, late_queried = await _submit_and_read(
            client,
            late_draft,
            idempotency_key="task4-pe-late-publication",
        )
        return price_queried.json(), threshold_queried.json(), late_queried.json()

    price_saved, threshold_saved, late_saved = _with_fixture_api(exercise)
    price_run = next(
        item
        for item in price_saved["result"]["strategyRuns"]
        if item["id"] == "strategy-pe-price-basis"
    )
    price_signal = next(
        item for item in price_run["signals"] if item["signalId"] == "pe.buy"
    )
    assert price_run["status"] == "completed_with_warning"
    assert price_run["diagnostics"] == [
        {
            "code": "no_valid_xirr",
            "severity": "warning",
            "messageKey": "metrics.xirr_unavailable",
            "fieldPath": "metrics.xirr",
            "asOf": "2024-01-31",
            "source": None,
            "details": {"reason": "insufficient_time_span"},
        }
    ]
    assert price_signal["state"] == "false"
    # The fixture's simulation price is 200 while its valuation price is 400;
    # PE is 40, so threshold 30 must remain false.
    assert price_run["trades"] == []

    threshold_run = next(
        item
        for item in threshold_saved["result"]["strategyRuns"]
        if item["id"] == "strategy-pe-threshold"
    )
    threshold_signal = next(
        item for item in threshold_run["signals"] if item["signalId"] == "pe.buy"
    )
    assert threshold_run["status"] == "completed_with_warning"
    assert threshold_signal["state"] == "true"
    assert threshold_run["trades"] == []
    assert threshold_run["unexecutedSignals"] == [
        {
            "signalDate": "2024-01-31",
            "signalId": "accumulation.buy",
            "reason": "no_following_backtest_session",
        }
    ]

    late_run = next(
        item
        for item in late_saved["result"]["strategyRuns"]
        if item["id"] == "strategy-pe-late-publication"
    )
    late_signal = next(
        item for item in late_run["signals"] if item["signalId"] == "pe.buy"
    )
    assert late_run["status"] == "unavailable"
    assert late_signal["state"] == "unavailable"
    assert late_signal["diagnostics"][0]["asOf"] == "2024-02-01"


def test_unknown_rate_publication_is_unavailable_instead_of_a_false_signal() -> None:
    async def exercise(client: httpx.AsyncClient):
        submitted, queried = await _submit_and_read(
            client,
            _draft(
                {
                    "vix.buyEnabled": False,
                    "rsi.buyEnabled": False,
                    "ma.buyEnabled": False,
                    "bollinger.buyEnabled": False,
                    "rate.buyEnabled": True,
                    "rate.thresholdPct": 2.5,
                    "pe.buyEnabled": False,
                },
                preset_id="composite_dca",
                strategy_id="strategy-rate-as-of",
                shared={
                    "run": {
                        "symbol": "QQQ",
                        "startDate": "2024-02-02",
                        "endDate": "2024-02-02",
                        "endMode": "fixed",
                    },
                    "contribution": {"day": 2, "amount": 100},
                },
            ),
            idempotency_key="task4-rate-as-of",
        )
        return submitted.json(), queried.json()

    submitted, saved = _with_fixture_api(exercise)
    assert submitted["status"] == "queued"
    strategy = next(
        item
        for item in saved["result"]["strategyRuns"]
        if item["id"] == "strategy-rate-as-of"
    )
    rate_signal = next(
        item for item in strategy["signals"] if item["signalId"] == "rate.buy"
    )
    assert saved["status"] == "completed_with_warning"
    assert strategy["status"] == "unavailable"
    assert rate_signal["state"] == "unavailable"
    assert rate_signal["diagnostics"][0]["details"]["dataKind"] == "macro"


def test_grid_search_candidates_and_search_csv_share_the_saved_result() -> None:
    async def exercise(client: httpx.AsyncClient):
        submitted, queried = await _submit_and_read(
            client,
            _draft(
                {
                    "vix.buyEnabled": True,
                    "rsi.buyEnabled": False,
                    "ma.buyEnabled": False,
                    "bollinger.buyEnabled": False,
                    "rate.buyEnabled": False,
                    "pe.buyEnabled": False,
                    "search.dimensions": ["vix.buyThreshold"],
                    "search.maxCombinations": 10,
                },
                preset_id="grid_search",
                strategy_id="strategy-search-fixture",
            ),
            idempotency_key="task4-grid-search",
        )
        run_id = submitted.json()["runId"]
        exported = await client.get(
            f"/api/v1/runs/{run_id}/export/search-results",
            params={"focusedResultId": "strategy-search-fixture"},
        )
        return queried.json(), exported

    saved, exported = _with_fixture_api(exercise)
    search = next(
        item
        for item in saved["result"]["strategyRuns"]
        if item["id"] == "strategy-search-fixture"
    )
    search_result = search["searchResult"]
    candidates = search_result["candidates"]
    assert saved["status"] == "completed"
    assert search["status"] == "completed"
    assert [item["parameterValues"]["vix.buyThreshold"] for item in candidates] == [
        "25",
        "28",
        "30",
        "35",
    ]
    assert all(item["status"] == "completed" for item in candidates)
    assert search_result["rankedCandidateIds"] == [
        item["candidateId"] for item in candidates
    ]
    exported_rows = list(csv.DictReader(io.StringIO(exported.text)))
    assert exported.status_code == 200
    assert [item["candidateId"] for item in exported_rows] == [
        item["candidateId"] for item in candidates
    ]
    assert [item["endingEquity"] for item in exported_rows] == [
        item["metrics"]["endingEquity"] for item in candidates
    ]


def test_partial_run_keeps_successful_results_and_freezes_the_old_snapshot() -> None:
    async def exercise(client: httpx.AsyncClient):
        vix = _draft()["strategies"][0]
        pe = _draft(
            {
                "vix.buyEnabled": False,
                "rsi.buyEnabled": False,
                "ma.buyEnabled": False,
                "bollinger.buyEnabled": False,
                "rate.buyEnabled": False,
                "pe.buyEnabled": True,
            },
            preset_id="composite_dca",
            strategy_id="strategy-pe-partial",
        )["strategies"][0]
        rate = _draft(
            {
                "vix.buyEnabled": False,
                "rsi.buyEnabled": False,
                "ma.buyEnabled": False,
                "bollinger.buyEnabled": False,
                "rate.buyEnabled": True,
                "pe.buyEnabled": False,
            },
            preset_id="composite_dca",
            strategy_id="strategy-rate-partial",
        )["strategies"][0]
        draft = {"shared": _SHARED, "strategies": [vix, pe, rate]}
        submitted, queried = await _submit_and_read(
            client,
            draft,
            idempotency_key="task4-partial-snapshot",
            scope="all_enabled",
        )
        vix["params"]["vix.buyThreshold"] = 40
        reloaded = await client.get(f"/api/v1/runs/{submitted.json()['runId']}")
        summary = await client.get(
            f"/api/v1/runs/{submitted.json()['runId']}/export/summary",
            params={"focusedResultId": "strategy-vix_dca-1"},
        )
        return queried.json(), reloaded.json(), summary

    saved, reloaded, exported = _with_fixture_api(exercise)
    results = {item["id"]: item for item in saved["result"]["strategyRuns"]}
    assert saved["status"] == "completed_with_warning"
    assert results["strategy-vix_dca-1"]["status"] == "completed"
    assert results["strategy-pe-partial"]["status"] == "unavailable"
    assert results["strategy-rate-partial"]["status"] == "unavailable"
    assert results["benchmark:monthly-dca"]["status"] == "completed"
    frozen = reloaded["snapshot"]["config"]["strategies"][0]
    assert frozen["params"]["vix.buyThreshold"] == "25"
    exported_row = next(csv.DictReader(io.StringIO(exported.text)))
    assert exported_row["resultId"] == "strategy-vix_dca-1"
    assert (
        exported_row["endingEquity"]
        == results["strategy-vix_dca-1"]["metrics"]["endingEquity"]
    )


def test_fixture_run_result_is_a_complete_saved_response_model() -> None:
    async def exercise(client: httpx.AsyncClient):
        _submitted, queried = await _submit_and_read(
            client,
            _draft(),
            idempotency_key="task4-fixture-contract",
        )
        return queried.json()

    response = _with_fixture_api(exercise)
    saved = RunResponse.model_validate(response)
    assert saved.result is not None
    assert saved.snapshot.data_fingerprint

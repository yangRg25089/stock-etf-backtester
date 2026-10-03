"""Long real-data rules: isolated/batched/permuted/search/saved consistency."""

import asyncio
import copy
import csv
import io
import json
from decimal import Decimal

import httpx
from fastapi.encoders import jsonable_encoder

from app.catalog.presets import PRESET_DEFINITIONS
from app.domain.conditions import ConditionKind
from app.domain.contracts import StrategyPresetId
from app.domain.immutability import thaw_value
from app.main import app
from app.runs.manager import RunManager
from app.runs.sqlite_store import SQLiteRunStore
from tests.runs.test_single_strategy_live import (
    _condition,
    _ObservedYahoo,
    _override_search,
    _verify_result,
)
from tests.runs.test_yahoo_data_live import _InlineExecutor


def _leaf(kind, side, **values):
    node = _condition(ConditionKind(kind), side)
    node["params"].update(values)
    return node


def _group(node_id, operator, *children):
    return {"type": "group", "id": node_id, "operator": operator, "children": children}


def _strategy(identity, *, conjunction=False, search=False):
    buy = _group(
        "buy-root",
        "AND" if conjunction else "OR",
        _group(
            "buy-trend-rate",
            "AND",
            _leaf("ma_trend", "buy", **{"ma.period": 30}),
            _leaf("rate", "buy", **{"rate.thresholdPct": 2}),
        ),
        _group(
            "buy-volatility",
            "AND",
            _leaf("vix", "buy", **{"vix.buyThreshold": 22}),
            _group(
                "buy-technical",
                "OR",
                _leaf("rsi", "buy", **{"rsi.period": 7, "rsi.buyThreshold": 65}),
                _leaf(
                    "ma_deviation", "buy", **{"ma.period": 30, "ma.buyDeviationPct": 2}
                ),
                _leaf(
                    "bollinger",
                    "buy",
                    **{"bollinger.period": 10, "bollinger.stddev": 1},
                ),
            ),
        ),
    )
    sell = _group(
        "sell-root",
        "OR",
        _group(
            "sell-volatility",
            "AND",
            _leaf(
                "vix",
                "sell",
                **{
                    "vix.symbol": "^VXN",
                    "exit.vix.low1": 25,
                    "exit.vix.low2": 35,
                    "exit.vix.ratio1": 0.333333,
                    "exit.vix.ratio2": 0.666667,
                },
            ),
            _leaf(
                "ma_deviation",
                "sell",
                **{"ma.period": 30, "ma.buyDeviationPct": 2, "exit.ratio": 0.25},
            ),
        ),
        _group(
            "sell-technical",
            "AND",
            _leaf(
                "rsi",
                "sell",
                **{"rsi.period": 7, "exit.rsi.threshold": 45, "exit.rsi.ratio": 0.5},
            ),
            _leaf(
                "bollinger",
                "sell",
                **{
                    "bollinger.period": 10,
                    "bollinger.stddev": 1,
                    "exit.bollinger.vixCeiling": 80,
                    "exit.bollinger.ratio": 0.4,
                },
            ),
        ),
        _leaf("rate", "sell", **{"rate.thresholdPct": 1.5, "exit.ratio": 0.2}),
        _leaf("ma_trend", "sell", **{"ma.period": 30}),
    )
    preset = StrategyPresetId.GRID_SEARCH if search else StrategyPresetId.COMPOSITE_DCA
    params = jsonable_encoder(thaw_value(PRESET_DEFINITIONS[preset].default_params))
    params.update(
        {"accumulation.maxSignalBuysPerMonth": None, "accumulation.cashSafetyLimit": 50}
    )
    if search:
        params.update(
            {
                "search.dimensions": ["vix.buyThreshold"],
                "search.values.vix.buyThreshold": [22, 30],
            }
        )
    return {
        "id": identity,
        "presetId": preset.value,
        "params": params,
        "rules": {"buy": buy, "sell": sell},
    }


def _numeric_fields(result):
    return {
        key: result[key]
        for key in (
            "status",
            "metrics",
            "dailyAssets",
            "trades",
            "signals",
            "technicalIndicators",
            "unexecutedSignals",
        )
        if key in result
    }


def test_live_long_nested_rules_preserve_numeric_identity_across_execution_modes(
    tmp_path,
):
    provider = _ObservedYahoo()
    original_service = app.state.run_service
    path = tmp_path / "long-complex.sqlite3"
    store = SQLiteRunStore(path)
    app.state.run_service = RunManager(
        store=store, data_provider=provider, executor=_InlineExecutor()
    )
    shared = {
        "run": {"symbol": "QQQ", "startDate": "2019-12-16", "endDate": "2021-02-26"},
        "contribution": {"amount": 137.19, "day": 31},
    }

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://complex-stress"
        ) as client:

            async def submit(strategies, key):
                response = await client.post(
                    "/api/v1/runs",
                    headers={"Idempotency-Key": key},
                    json={
                        "draft": {"shared": shared, "strategies": strategies},
                        "scope": "all_enabled",
                    },
                )
                assert response.status_code == 202, response.text
                saved = (
                    await client.get(f"/api/v1/runs/{response.json()['runId']}")
                ).json()
                for result in saved["result"]["strategyRuns"]:
                    config = next(
                        (
                            row
                            for row in saved["snapshot"]["config"]["strategies"]
                            if row["id"] == result["id"]
                        ),
                        None,
                    )
                    if config is None:
                        defaults = PRESET_DEFINITIONS[result["presetId"]].model_dump(
                            mode="json", by_alias=True
                        )
                        config = {
                            "presetId": result["presetId"],
                            "params": defaults["defaultParams"],
                            "rules": defaults["defaultRules"],
                        }
                    if result["presetId"] != "grid_search":
                        _verify_result(
                            saved["snapshot"]["config"]["shared"],
                            config,
                            result,
                            provider.observed.get(
                                result["id"], provider.observed[strategies[0]["id"]]
                            ),
                        )
                    assert result["status"] == "completed", result.get("diagnostics")
                return saved

            a, b, duplicate = (
                _strategy("complex-a"),
                _strategy("complex-b", conjunction=True),
                _strategy("complex-copy"),
            )
            singles = [
                await submit([row], f"alone-{row['id']}") for row in (a, b, duplicate)
            ]
            batch = await submit([a, b, duplicate], "batched")
            reverse = await submit([duplicate, b, a], "permuted")
            for single in singles:
                identity = single["selectedStrategyIds"][0]
                expected = next(
                    row
                    for row in single["result"]["strategyRuns"]
                    if row["id"] == identity
                )
                assert any(row["side"] == "sell" for row in expected["trades"])
                assert len(expected["dailyAssets"]) > 300
                assert {
                    (row["kind"], row["period"])
                    for row in expected["technicalIndicators"]
                } == {("ma", 30), ("rsi", 7), ("bollinger", 10)}
                for saved in (batch, reverse):
                    actual = next(
                        row
                        for row in saved["result"]["strategyRuns"]
                        if row["id"] == identity
                    )
                    assert _numeric_fields(actual) == _numeric_fields(expected), (
                        identity
                    )
                for kind, records in (
                    ("daily-assets", expected["dailyAssets"]),
                    ("trades", expected["trades"]),
                    ("summary", [expected["metrics"]]),
                ):
                    exported = await client.get(
                        f"/api/v1/runs/{single['runId']}/export/{kind}",
                        params={"focusedResultId": identity},
                    )
                    assert exported.status_code == 200, exported.text
                    rows = list(csv.DictReader(io.StringIO(exported.text)))
                    assert len(rows) == len(records)
                    for row, original in zip(rows, records, strict=True):
                        assert row["runId"] == single["runId"]
                        assert row["resultId"] == identity
                        assert row["currency"] == expected["metrics"]["currency"]
                        provenance = single["snapshot"]["dataProvenance"]
                        assert json.loads(row["dataSources"]) == provenance["sources"]
                        assert row["calendarAsOf"] == provenance["calendarAsOf"]
                        assert (
                            row["marketDataThrough"] == provenance["marketDataThrough"]
                        )
                        for field in (
                            "date",
                            "totalAsset",
                            "cashAmount",
                            "actualInvested",
                            "totalContributed",
                            "endingEquity",
                        ):
                            if field in original:
                                assert (
                                    row[field] == original[field]
                                    if field == "date"
                                    else Decimal(row[field]) == Decimal(original[field])
                                )
            # Equal calculations remain separate identities, including saved cache hits.
            assert len({row["id"] for row in batch["result"]["strategyRuns"]}) == 5
            search = await submit(
                [_strategy("grid-complex", search=True)], "complex-grid"
            )
            parent = next(
                row
                for row in search["result"]["strategyRuns"]
                if row["id"] == "grid-complex"
            )
            summaries = parent["searchResult"]["candidates"]
            assert len(summaries) == 2
            candidates = []
            for summary in summaries:
                candidate = (
                    await client.get(
                        f"/api/v1/runs/{search['runId']}/candidates/{summary['candidateId']}"
                    )
                ).json()
                config = copy.deepcopy(search["snapshot"]["config"]["strategies"][0])
                config["presetId"] = "composite_dca"
                _override_search(
                    config["rules"]["buy"],
                    "vix.buyThreshold",
                    summary["parameterValues"]["vix.buyThreshold"],
                )
                _verify_result(
                    search["snapshot"]["config"]["shared"],
                    config,
                    candidate,
                    provider.observed["grid-complex"],
                )
                assert candidate["metrics"] == summary["metrics"]
                candidates.append(candidate)
            ranked = sorted(
                summaries,
                key=lambda row: (
                    -Decimal(row["metrics"]["endingEquity"]),
                    Decimal(row["metrics"]["maximumDrawdown"]),
                    row["sequence"],
                ),
            )
            assert parent["searchResult"]["rankedCandidateIds"] == [
                row["candidateId"] for row in ranked
            ]
            exported = await client.get(
                f"/api/v1/runs/{search['runId']}/export/search-results",
                params={"focusedResultId": "grid-complex"},
            )
            assert exported.status_code == 200, exported.text
            rows = list(csv.DictReader(io.StringIO(exported.text)))
            assert {row["candidateId"] for row in rows} == {
                row["id"] for row in candidates
            }
            for row in rows:
                summary = next(
                    entry
                    for entry in summaries
                    if entry["candidateId"] == row["candidateId"]
                )
                assert row["runId"] == search["runId"]
                assert row["resultId"] == "grid-complex"
                assert (
                    row["calculationFingerprint"] == summary["calculationFingerprint"]
                )
                assert int(row["sequence"]) == summary["sequence"]
                assert row["status"] == summary["status"]
                for field in (
                    "endingEquity",
                    "actualInvested",
                    "totalContributed",
                    "netProfit",
                    "returnOnContributions",
                    "capitalMultiple",
                    "maximumDrawdown",
                    "xirr",
                ):
                    assert Decimal(row[field]) == Decimal(summary["metrics"][field])
            return batch

    try:
        saved = asyncio.run(run())
        store.close()
        recovered = SQLiteRunStore(path)
        try:
            record = recovered.get(saved["runId"])
            assert record is not None
            assert jsonable_encoder(record) == saved
        finally:
            recovered.close()
    finally:
        app.state.run_service = original_service
        store.close()

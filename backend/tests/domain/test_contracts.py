from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.catalog.service import default_data_settings
from app.domain.contracts import (
    ContributionSettings,
    DailyAsset,
    DataSnapshot,
    MarketBar,
    MarketSnapshot,
    MetricSummary,
    ResultRole,
    RunConfig,
    RunResult,
    RunScope,
    RunSettings,
    RunSnapshot,
    SearchCandidate,
    SearchResult,
    SharedSettings,
    StrategyInstance,
    StrategyPresetId,
    StrategyRun,
    Trade,
    TradeReason,
    TradeSide,
    ValuationObservation,
    ValuationSnapshot,
)
from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    DiagnosticSeverity,
    StrategyStatus,
)


def _shared_settings() -> SharedSettings:
    return SharedSettings(
        run=RunSettings(
            symbol="QQQ",
            startDate=date(2020, 1, 1),
            endDate=date(2024, 1, 31),
            endMode="fixed",
        ),
        contribution=ContributionSettings(day=1, amount=Decimal("100")),
        data=default_data_settings(),
    )


def _draft_config() -> RunConfig:
    return RunConfig(
        shared=_shared_settings(),
        strategies=[
            StrategyInstance(
                id="strategy-1",
                presetId=StrategyPresetId.VIX_DCA,
                enabled=True,
                params={"vix.buyThreshold": 25},
            )
        ],
    )


def test_contract_rejects_missing_snapshot_fingerprints() -> None:
    with pytest.raises(ValidationError):
        RunSnapshot(runId="run-1", config=_draft_config())


def test_snapshot_copies_a_mutable_draft_and_freezes_config() -> None:
    draft = _draft_config()
    snapshot = RunSnapshot(
        runId="run-1",
        config=draft,
        catalogVersion="catalog-1",
        dataFingerprint="data-1",
        engineVersion="engine-1",
    )

    draft.strategies[0].params["vix.buyThreshold"] = 30
    draft.strategies[0].enabled = False
    draft.shared = SharedSettings(
        run=draft.shared.run,
        contribution=ContributionSettings(day=1, amount=Decimal("200")),
        data=default_data_settings(),
    )

    saved_strategy = snapshot.config.strategies[0]
    assert saved_strategy.params["vix.buyThreshold"] == 25
    assert saved_strategy.enabled is True
    assert snapshot.config.shared.contribution.amount == Decimal("100")
    with pytest.raises(TypeError):
        saved_strategy.params["vix.buyThreshold"] = 30  # type: ignore[index]
    with pytest.raises(ValidationError):
        snapshot.catalog_version = "changed"


def test_snapshot_freezes_and_serializes_data_provenance() -> None:
    sources = ["yahoo", "sec:companyfacts"]
    snapshot = RunSnapshot(
        runId="run-provenance",
        config=_draft_config(),
        catalogVersion="catalog-1",
        dataFingerprint="data-1",
        engineVersion="engine-1",
        dataProvenance={
            "sources": sources,
            "calendarAsOf": date(2024, 1, 31),
            "marketDataThrough": date(2024, 1, 30),
        },
    )
    sources.append("untrusted-later-change")

    assert snapshot.data_provenance.sources == ("sec:companyfacts", "yahoo")
    assert snapshot.model_dump(mode="json", by_alias=True)["dataProvenance"] == {
        "sources": ["sec:companyfacts", "yahoo"],
        "calendarAsOf": "2024-01-31",
        "marketDataThrough": "2024-01-30",
    }


@pytest.mark.parametrize("params", [[["vix.buyThreshold", 25]], None, 3])
def test_strategy_params_require_a_mapping(params: object) -> None:
    with pytest.raises(ValidationError):
        StrategyInstance(
            id="strategy-1",
            presetId=StrategyPresetId.VIX_DCA,
            enabled=True,
            params=params,
        )


def test_run_scope_and_preset_ids_are_stable_machine_values() -> None:
    assert RunScope.ALL_ENABLED.value == "all_enabled"
    assert ResultRole.BENCHMARK.value == "benchmark"
    assert [preset.value for preset in StrategyPresetId] == [
        "vix_dca",
        "composite_dca",
        "ma_trend",
        "ma_buy_only",
        "monthly_dca",
        "lump_sum",
        "grid_search",
    ]
    assert _draft_config().model_dump(by_alias=True)["strategies"][0]["presetId"] == (
        "vix_dca"
    )


def test_market_snapshot_keeps_simulation_and_valuation_prices_separate() -> None:
    bar = MarketBar(
        date=date(2024, 1, 2),
        symbol="QQQ",
        simulationPrice=Decimal("400"),
        valuationPrice=Decimal("398"),
        currency="USD",
        source="fixture",
        observedAt=datetime(2024, 1, 2, tzinfo=UTC),
    )
    snapshot = MarketSnapshot(
        symbol="QQQ",
        currency="USD",
        bars=[bar],
        source="fixture",
        fingerprint="market-1",
    )

    assert snapshot.bars[0].simulation_price == Decimal("400")
    assert snapshot.bars[0].valuation_price == Decimal("398")
    assert snapshot.model_dump_json()


def test_valuation_snapshot_rejects_non_positive_pe_and_mismatched_symbols() -> None:
    with pytest.raises(ValidationError):
        ValuationObservation(
            date=date(2024, 1, 2),
            symbol="QQQ",
            valuationPrice=Decimal("400"),
            eps=Decimal("10"),
            pe=Decimal("0"),
            currency="USD",
            method="annual_report",
            source="fixture",
            asOf=date(2024, 1, 1),
        )

    observation = ValuationObservation(
        date=date(2024, 1, 2),
        symbol="SPY",
        valuationPrice=Decimal("400"),
        eps=Decimal("10"),
        pe=Decimal("40"),
        currency="USD",
        method="annual_report",
        source="fixture",
        asOf=date(2024, 1, 1),
    )
    with pytest.raises(ValidationError):
        ValuationSnapshot(
            symbol="QQQ",
            observations=[observation],
            fingerprint="valuation-1",
        )

    market = MarketSnapshot(
        symbol="QQQ",
        currency="USD",
        source="fixture",
        fingerprint="market-1",
    )
    valuation = ValuationSnapshot(
        symbol="SPY",
        observations=[],
        fingerprint="valuation-1",
    )
    with pytest.raises(ValidationError):
        DataSnapshot(market=market, valuation=valuation, fingerprint="data-1")


def test_completed_zero_trade_strategy_and_partial_result_are_representable() -> None:
    strategy = StrategyRun(
        id="strategy-1",
        presetId=StrategyPresetId.VIX_DCA,
        role=ResultRole.STRATEGY,
        status=StrategyStatus.COMPLETED,
        trades=[],
        dailyAssets=[],
        metrics=MetricSummary(
            totalContributed=Decimal("100"),
            endingEquity=Decimal("100"),
            netProfit=Decimal("0"),
            returnOnContributions=Decimal("0"),
            capitalMultiple=Decimal("1"),
        ),
    )
    unavailable = StrategyRun(
        id="strategy-2",
        presetId=StrategyPresetId.COMPOSITE_DCA,
        role=ResultRole.STRATEGY,
        status=StrategyStatus.UNAVAILABLE,
        diagnostics=[
            {
                "code": DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
                "severity": DiagnosticSeverity.ERROR,
                "message_key": "diagnostics.required_data_unavailable",
            }
        ],
    )
    result = RunResult(runId="run-1", strategyRuns=[strategy, unavailable])

    assert strategy.trades == ()
    assert result.is_partial_success is True
    assert result.status is StrategyStatus.COMPLETED_WITH_WARNING


def test_grid_search_result_is_frozen_inside_its_strategy_run() -> None:
    summary = MetricSummary(
        totalContributed=Decimal("100"),
        endingEquity=Decimal("110"),
        netProfit=Decimal("10"),
        returnOnContributions=Decimal("0.1"),
        capitalMultiple=Decimal("1.1"),
        currency="USD",
    )
    search_result = SearchResult(
        strategyId="grid-1",
        dimensions=[{"key": "vix.buyThreshold", "values": [25, 30]}],
        totalCandidateCount=1,
        candidates=[
            SearchCandidate(
                candidateId="grid-1:candidate:00001",
                sequence=1,
                role=ResultRole.STRATEGY,
                status=StrategyStatus.COMPLETED,
                calculationFingerprint="fingerprint-1",
                parameterValues={"vix.buyThreshold": Decimal("25")},
                metrics=summary,
            )
        ],
        rankedCandidateIds=["grid-1:candidate:00001"],
    )
    run = StrategyRun(
        id="grid-1",
        presetId=StrategyPresetId.GRID_SEARCH,
        role=ResultRole.STRATEGY,
        status=StrategyStatus.COMPLETED,
        metrics=summary,
        searchResult=search_result,
    )

    restored = StrategyRun.model_validate(run.model_dump(mode="python", by_alias=True))

    assert restored.search_result == search_result
    assert restored.search_result.candidates[0].metrics == summary


def test_strategy_run_status_updates_return_a_new_validated_result() -> None:
    queued = StrategyRun(
        id="strategy-1",
        presetId=StrategyPresetId.VIX_DCA,
        role=ResultRole.STRATEGY,
    )

    running = queued.with_status("loading").with_status(StrategyStatus.RUNNING)

    assert running.status is StrategyStatus.RUNNING
    assert queued.status is StrategyStatus.QUEUED


def test_status_transition_preserves_diagnostic_invariants() -> None:
    strategy = StrategyRun(
        id="strategy-1",
        presetId=StrategyPresetId.VIX_DCA,
        role=ResultRole.STRATEGY,
    )

    with pytest.raises(ValueError, match="require diagnostics"):
        strategy.with_status(StrategyStatus.UNAVAILABLE)

    diagnostic = Diagnostic(
        code=DiagnosticCode.REQUIRED_DATA_UNAVAILABLE,
        severity=DiagnosticSeverity.ERROR,
        message_key="diagnostics.required_data_unavailable",
    )
    unavailable = strategy.with_status(
        StrategyStatus.UNAVAILABLE,
        diagnostics=(diagnostic,),
    )

    assert unavailable.status is StrategyStatus.UNAVAILABLE
    assert unavailable.diagnostics[0].code is DiagnosticCode.REQUIRED_DATA_UNAVAILABLE


def test_trade_and_daily_asset_contracts_keep_currency_and_reason() -> None:
    trade = Trade(
        date=date(2024, 1, 2),
        side=TradeSide.BUY,
        reason=TradeReason.FIXED_DCA,
        quantity=Decimal("0.25"),
        price=Decimal("400"),
        cashAmount=Decimal("100"),
        currency="USD",
    )
    asset = DailyAsset(
        date=date(2024, 1, 2),
        cash=Decimal("10"),
        timingQuantity=Decimal("0"),
        fixedQuantity=Decimal("0.25"),
        simulationPrice=Decimal("400"),
        totalAsset=Decimal("110"),
        currency="USD",
    )

    assert trade.reason is TradeReason.FIXED_DCA
    assert asset.total_asset == Decimal("110")

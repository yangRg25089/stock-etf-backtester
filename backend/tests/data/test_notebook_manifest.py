from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from app.catalog.definitions import PARAMETER_DEFINITIONS

_MANIFEST = Path(__file__).parents[3] / "docs" / "fixtures" / "notebook-mapping.json"


def _manifest() -> dict[str, object]:
    return json.loads(_MANIFEST.read_text(encoding="utf-8"))


def test_manifest_records_both_normative_sources_and_non_normative_variant() -> None:
    manifest = _manifest()
    sources = {item["id"]: item for item in manifest["sources"]}

    assert manifest["primarySourceIds"] == ["qqq_vix_dca", "compare_strategies"]
    assert sources["qqq_vix_dca"]["role"] == "primary"
    assert sources["compare_strategies"]["role"] == "primary"
    unreferenced = {item["id"]: item for item in manifest["unreferenced_sources"]}
    assert unreferenced["qqq_vix_dca_copy_variant"]["role"] == "unreferencedVariant"
    for source in [*sources.values(), *unreferenced.values()]:
        assert re.fullmatch(r"[0-9a-f]{64}", source["sha256"])
        assert re.fullmatch(r"[0-9a-f]{64}", source["sourceSha256"])


def test_manifest_contains_every_explicit_compare_input_mapping() -> None:
    manifest = _manifest()
    mappings = [
        item
        for item in manifest["mappings"]
        if item["sourceId"] == "compare_strategies"
    ]
    target_keys: set[str] = set()
    for mapping in mappings:
        targets = mapping["targetKey"]
        if isinstance(targets, str):
            target_keys.add(re.sub(r"\[.*\]", "", targets))
        else:
            target_keys.update(re.sub(r"\[.*\]", "", target) for target in targets)

    expected = {
        "run.symbol",
        "run.startDate",
        "run.endDate",
        "contribution.day",
        "contribution.amount",
        "accumulation.cashSafetyLimit",
        "accumulation.conditionLogic",
        "vix.buyEnabled",
        "vix.symbol",
        "vix.buyThreshold",
        "rsi.buyEnabled",
        "rsi.period",
        "rsi.buyThreshold",
        "ma.buyEnabled",
        "ma.period",
        "ma.buyDeviationPct",
        "bollinger.buyEnabled",
        "bollinger.period",
        "bollinger.stddev",
        "rate.buyEnabled",
        "rate.symbol",
        "rate.thresholdPct",
        "rate.sourceUnit",
        "exit.enabled",
        "exit.vix.low1",
        "exit.vix.ratio1",
        "exit.vix.low2",
        "exit.vix.ratio2",
        "exit.rsi.enabled",
        "exit.rsi.threshold",
        "exit.rsi.ratio",
        "exit.bollinger.enabled",
        "exit.bollinger.ratio",
        "exit.bollinger.vixCeiling",
        "display.showChart",
        "search.dimensions",
        "search.values.vix.buyThreshold",
        "search.values.rsi.buyThreshold",
        "search.values.accumulation.cashSafetyLimit",
        "search.maxCombinations",
    }
    assert expected <= target_keys
    assert expected <= set(PARAMETER_DEFINITIONS)


def test_notebook_trade_output_is_preserved_without_a_visibility_parameter() -> None:
    mappings = [
        item for item in _manifest()["mappings"] if item["sourceKey"] == "买入记录输出"
    ]
    assert {item["sourceId"] for item in mappings} == {
        "qqq_vix_dca",
        "compare_strategies",
    }
    assert all(item["targetKey"] == [] for item in mappings)
    assert all(item["mappingKind"] == "alwaysAvailableOutput" for item in mappings)


def test_strategy_mode_mapping_does_not_reintroduce_a_run_scope_ui_parameter():
    mappings = [
        item for item in _manifest()["mappings"] if item["sourceKey"] == "策略模式"
    ]
    assert mappings
    assert all(item["targetKey"] == "StrategyPresetId" for item in mappings)


def test_retired_notebook_inputs_have_no_active_parameter_mapping() -> None:
    retired = {
        "启用固定比例定投",
        "固定定投比例",
        "网格固定比例列表",
        "启用PE",
        "PE阈值",
        "PE ETF覆盖率(V1新增)",
    }
    mappings = [
        item for item in _manifest()["mappings"] if item["sourceKey"] in retired
    ]
    assert {item["sourceKey"] for item in mappings} == retired
    assert all(item["targetKey"] == [] for item in mappings)
    assert all(item["mappingKind"] == "retiredInput" for item in mappings)
    assert all(item["reason"] for item in mappings)


def test_manifest_is_self_contained_and_does_not_read_external_notebooks() -> None:
    manifest = _manifest()
    raw = _MANIFEST.read_bytes()

    assert _MANIFEST.is_file()
    assert hashlib.sha256(raw).hexdigest()
    assert all(
        "/Users/ronny/workspace/Fin_app" in source["path"]
        for source in manifest["sources"]
    )
    # Source paths are provenance strings only; no source file is opened by this test.
    assert "notebook-mapping.json" in _MANIFEST.name

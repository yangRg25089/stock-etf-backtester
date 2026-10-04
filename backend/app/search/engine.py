"""Grid candidate enumeration and execution through the shared core modules."""

from collections.abc import Callable, Mapping, MutableMapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from hashlib import sha256
from itertools import product
from json import dumps
from math import prod
from typing import cast

from app.calendar import ExchangeCalendar, ScheduleResult
from app.catalog.definitions import ParameterDefinition
from app.catalog.presets import ExecutionModule
from app.catalog.service import Catalog, get_catalog
from app.config.conditions import materialize_legacy_rules
from app.config.validation import validate_draft
from app.diagnostics import calculation_diagnostic
from app.domain.cancellation import RunCancelled
from app.domain.conditions import override_rule_parameters
from app.domain.contracts import (
    DataSnapshot,
    FrozenRunConfig,
    FrozenStrategyInstance,
    ResultRole,
    RunSettings,
    StrategyPresetId,
    StrategyRun,
)
from app.domain.immutability import thaw_value
from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    DiagnosticSeverity,
    StrategyStatus,
)
from app.ledger.engine import LEDGER_METHOD_VERSION
from app.metrics import (
    METRIC_METHOD_VERSION,
    MetricsResult,
)
from app.search.types import (
    SearchCandidate,
    SearchHeatmapSlice,
    SearchResult,
    SearchResultDimension,
)
from app.signals import (
    INDICATOR_METHOD_VERSION,
    SIGNAL_METHOD_VERSION,
)
from app.simulation import simulate_strategy

SEARCH_METHOD_VERSION = "search-v4"


@dataclass(frozen=True, slots=True)
class GridSearchInput:
    """Frozen inputs shared by every candidate in one search."""

    config: FrozenRunConfig
    strategy: FrozenStrategyInstance
    schedule: ScheduleResult
    exchange_calendar: ExchangeCalendar
    snapshot: DataSnapshot
    catalog: Catalog | None = None
    evaluation_run: RunSettings | None = None


@dataclass(frozen=True, slots=True)
class _CandidateValidation:
    config: FrozenRunConfig | None = None
    strategy: FrozenStrategyInstance | None = None
    diagnostics: tuple[Diagnostic, ...] = ()

    @property
    def valid(self) -> bool:
        return self.config is not None and self.strategy is not None


_CalculationCache = MutableMapping[str, tuple[MetricsResult, tuple[Diagnostic, ...]]]


def run_grid_search(
    source: GridSearchInput,
    *,
    calculation_cache: _CalculationCache | None = None,
    check_cancelled: Callable[[], None] | None = None,
    save_candidate: Callable[[StrategyRun], None] | None = None,
    load_candidate: Callable[[str], StrategyRun | None] | None = None,
) -> SearchResult:
    """Enumerate and run every selected combination, preserving each outcome."""

    catalog = get_catalog() if source.catalog is None else source.catalog
    preset = catalog.preset(source.strategy.preset_id)
    if source.strategy.preset_id is not StrategyPresetId.GRID_SEARCH:
        raise ValueError("grid search requires a grid_search strategy instance")
    _require_source_strategy(source.config, source.strategy)

    validated_base = _validate_candidate_config(
        source.config,
        source.strategy,
        source.strategy.id,
        dict(source.strategy.params),
        catalog,
    )
    if not validated_base.valid:
        raise ValueError("grid search base configuration is invalid")
    assert validated_base.config is not None
    assert validated_base.strategy is not None
    base_config, base_strategy = validated_base.config, validated_base.strategy
    dimension_keys = _dimension_keys(base_strategy)
    dimension_map = {dimension.key: dimension for dimension in preset.search_dimensions}
    dimensions = tuple(dimension_map[key] for key in dimension_keys)
    maximum = _integer_parameter(base_strategy.params, "search.maxCombinations")
    dimension_values = tuple(
        dimension.configured_values(base_strategy.params) for dimension in dimensions
    )
    combination_count = prod(len(values) for values in dimension_values)
    hard_limit = _hard_combination_limit(catalog)
    if combination_count > min(maximum, hard_limit):
        raise ValueError(
            f"search has {combination_count} combinations, above its configured limit"
        )

    if (save_candidate is None) != (load_candidate is None):
        raise ValueError("candidate persistence requires both save and load callbacks")

    mode = base_strategy.params.get("search.optimizationMode")
    if mode in {"train_test", "walk_forward"} and source.evaluation_run is None:
        from app.search.optimization import run_train_test
        from app.search.walk_forward import run_walk_forward

        optimizer = run_train_test if mode == "train_test" else run_walk_forward
        return optimizer(
            source,
            calculation_cache=calculation_cache,
            check_cancelled=check_cancelled,
            save_candidate=save_candidate,
            load_candidate=load_candidate,
        )

    cache = {} if calculation_cache is None else calculation_cache
    candidates: list[SearchCandidate] = []
    detail_ids: dict[str, str] = {}
    for sequence, values in enumerate(product(*dimension_values), start=1):
        if check_cancelled is not None:
            check_cancelled()
        candidate_id = f"{source.strategy.id}:candidate:{sequence:05d}"
        candidate_params = dict(base_strategy.params)
        candidate_params.update(
            {
                dimension.key: value
                for dimension, value in zip(dimensions, values, strict=True)
            }
        )
        validation = _validate_candidate_config(
            base_config,
            base_strategy,
            candidate_id,
            candidate_params,
            catalog,
        )
        if not validation.valid:
            if not validation.diagnostics:
                raise RuntimeError("invalid candidate validation has no diagnostic")
            candidate_strategy = FrozenStrategyInstance(
                id=candidate_id,
                presetId=base_strategy.preset_id,
                enabled=True,
                params=candidate_params,
                rules=override_rule_parameters(
                    base_strategy.rules,
                    {key: candidate_params[key] for key in dimension_keys},
                ),
            )
            fingerprint = calculation_fingerprint(
                source,
                strategy=candidate_strategy,
                catalog_version=catalog.version,
            )
            candidates.append(
                SearchCandidate(
                    candidateId=candidate_id,
                    sequence=sequence,
                    role=ResultRole.STRATEGY,
                    status=StrategyStatus.FAILED,
                    calculationFingerprint=fingerprint,
                    parameterValues=candidate_params,
                    diagnostics=validation.diagnostics,
                )
            )
            continue

        assert validation.config is not None
        assert validation.strategy is not None
        candidate_config, candidate_strategy = validation.config, validation.strategy
        if source.evaluation_run is not None:
            candidate_config = candidate_config.model_copy(
                update={
                    "shared": candidate_config.shared.model_copy(
                        update={"run": source.evaluation_run}
                    ),
                }
            )
        fingerprint = calculation_fingerprint(
            source,
            strategy=candidate_strategy,
            catalog_version=catalog.version,
        )
        cached = cache.get(fingerprint)
        if save_candidate is not None and fingerprint not in detail_ids:
            cached = None  # A metrics-only cache cannot supply a saved curve.
        if cached is not None:
            if save_candidate is not None and load_candidate is not None:
                original = load_candidate(detail_ids[fingerprint])
                if original is None:
                    raise RuntimeError("saved candidate detail is missing")
                save_candidate(original.model_copy(update={"id": candidate_id}))
            metrics_result, diagnostics = cached
            candidates.append(
                _completed_candidate(
                    candidate_id,
                    sequence,
                    candidate_strategy,
                    fingerprint,
                    metrics_result,
                    diagnostics,
                    reused=True,
                )
            )
            continue

        try:
            calculated = simulate_strategy(
                candidate_config,
                candidate_strategy,
                source.schedule,
                source.snapshot,
                source.exchange_calendar,
                check_cancelled=check_cancelled,
            )
            if calculated.status is StrategyStatus.UNAVAILABLE:
                candidates.append(
                    SearchCandidate(
                        candidateId=candidate_id,
                        sequence=sequence,
                        role=ResultRole.STRATEGY,
                        status=StrategyStatus.UNAVAILABLE,
                        calculationFingerprint=fingerprint,
                        parameterValues=candidate_strategy.params,
                        diagnostics=calculated.diagnostics,
                    )
                )
                continue
            assert calculated.metrics is not None
            metrics_result = MetricsResult(
                summary=calculated.metrics, daily_assets=calculated.daily_assets
            )
            diagnostics = calculated.diagnostics
            if save_candidate is not None:
                save_candidate(calculated.as_run(candidate_strategy))
                detail_ids[fingerprint] = candidate_id
            cache[fingerprint] = (metrics_result, diagnostics)
            candidates.append(
                _completed_candidate(
                    candidate_id,
                    sequence,
                    candidate_strategy,
                    fingerprint,
                    metrics_result,
                    diagnostics,
                    reused=False,
                )
            )
        except RunCancelled:
            raise
        except Exception as error:
            diagnostic = calculation_diagnostic(
                error,
                stage="search_candidate",
                strategy_id=source.strategy.id,
                candidate_id=candidate_id,
            )
            candidates.append(
                SearchCandidate(
                    candidateId=candidate_id,
                    sequence=sequence,
                    role=ResultRole.STRATEGY,
                    status=StrategyStatus.FAILED,
                    calculationFingerprint=fingerprint,
                    parameterValues=candidate_strategy.params,
                    diagnostics=(diagnostic,),
                )
            )

    candidate_rows = tuple(candidates)
    return SearchResult(
        strategyId=source.strategy.id,
        dimensions=tuple(
            SearchResultDimension(
                key=dimension.key,
                values=values,
                translationKey=dimension.translation_key,
            )
            for dimension, values in zip(dimensions, dimension_values, strict=True)
        ),
        totalCandidateCount=combination_count,
        candidates=candidate_rows,
        rankedCandidateIds=rank_candidates(candidate_rows),
    )


def calculation_fingerprint(
    source: GridSearchInput,
    *,
    strategy: FrozenStrategyInstance,
    catalog_version: str | None = None,
) -> str:
    """Return an identity-independent hash of all calculation-affecting inputs."""

    catalog = get_catalog() if source.catalog is None else source.catalog
    version = catalog.version if catalog_version is None else catalog_version
    payload = {
        "catalogVersion": version,
        "shared": source.config.shared.model_copy(
            update={"run": source.evaluation_run or source.config.shared.run}
        ).model_dump(mode="json", by_alias=True),
        "schedule": source.schedule.model_dump(mode="json", by_alias=True),
        "exchangeCalendar": source.exchange_calendar.model_dump(
            mode="json", by_alias=True
        ),
        "dataFingerprint": source.snapshot.fingerprint,
        "strategy": _strategy_calculation_payload(strategy, catalog),
        "indicatorMethod": INDICATOR_METHOD_VERSION,
        "signalMethod": SIGNAL_METHOD_VERSION,
        "ledgerMethod": LEDGER_METHOD_VERSION,
        "metricMethod": METRIC_METHOD_VERSION,
    }
    serialized = dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        default=_json_default,
    )
    return sha256(serialized.encode("utf-8")).hexdigest()


def rank_candidates(candidates: Sequence[SearchCandidate]) -> tuple[str, ...]:
    """Rank successful candidates by equity, drawdown, then stable sequence."""

    ranked = [
        candidate
        for candidate in candidates
        if candidate.status
        in {
            StrategyStatus.COMPLETED,
            StrategyStatus.COMPLETED_WITH_WARNING,
        }
        and candidate.metrics is not None
    ]
    ranked.sort(key=_candidate_rank_key)
    return tuple(candidate.candidate_id for candidate in ranked)


def build_heatmap_slice(
    result: SearchResult,
    *,
    x_dimension: str,
    y_dimension: str,
    fixed_values: Mapping[str, object],
) -> SearchHeatmapSlice:
    """Build an explicit two-axis view, freezing all remaining dimensions."""

    dimension_map = {dimension.key: dimension for dimension in result.dimensions}
    if x_dimension not in dimension_map or y_dimension not in dimension_map:
        raise ValueError("heatmap axes must use selected search dimensions")
    if x_dimension == y_dimension:
        raise ValueError("heatmap axes must be distinct")
    expected_fixed = set(dimension_map).difference({x_dimension, y_dimension})
    if set(fixed_values) != expected_fixed:
        raise ValueError("fixed values must name every non-axis dimension")
    for key, value in fixed_values.items():
        if value not in dimension_map[key].values:
            raise ValueError(f"fixed value is outside the selected dimension: {key}")
    selected_candidates = tuple(
        candidate
        for candidate in result.candidates
        if all(
            candidate.parameter_values.get(key) == value
            for key, value in fixed_values.items()
        )
    )
    return SearchHeatmapSlice(
        xDimension=x_dimension,
        yDimension=y_dimension,
        xValues=dimension_map[x_dimension].values,
        yValues=dimension_map[y_dimension].values,
        fixedValues=fixed_values,
        candidates=selected_candidates,
    )


def _require_source_strategy(
    config: FrozenRunConfig,
    strategy: FrozenStrategyInstance,
) -> None:
    configured = next(
        (item for item in config.strategies if item.id == strategy.id), None
    )
    if configured != strategy:
        raise ValueError("search strategy must match its frozen configuration entry")


def _validate_candidate_config(
    config: FrozenRunConfig,
    base_strategy: FrozenStrategyInstance,
    candidate_id: str,
    parameters: Mapping[str, object],
    catalog: Catalog,
) -> _CandidateValidation:
    draft = {
        "shared": config.shared.model_dump(mode="python", by_alias=True),
        "strategies": [
            {
                "id": candidate_id,
                "presetId": base_strategy.preset_id.value,
                "enabled": True,
                "params": parameters,
                "rules": override_rule_parameters(
                    base_strategy.rules,
                    {key: parameters[key] for key in _dimension_keys(base_strategy)},
                ),
            }
        ],
    }
    validation = validate_draft(draft, catalog=catalog)
    diagnostics = validation.diagnostics_for((candidate_id,))
    if diagnostics:
        return _CandidateValidation(diagnostics=diagnostics)
    candidate_config = validation.config_for((candidate_id,))
    if candidate_config is None or not candidate_config.strategies:
        return _CandidateValidation(
            diagnostics=(
                Diagnostic(
                    code=DiagnosticCode.INVALID_PARAMETER,
                    severity=DiagnosticSeverity.ERROR,
                    messageKey="diagnostics.configuration.invalid_parameter",
                    fieldPath="strategies[0]",
                    details={"strategyId": candidate_id},
                ),
            )
        )
    return _CandidateValidation(
        config=candidate_config,
        strategy=candidate_config.strategies[0],
    )


def _dimension_keys(strategy: FrozenStrategyInstance) -> tuple[str, ...]:
    raw = strategy.params.get("search.dimensions")
    if (
        not isinstance(raw, (list, tuple))
        or not raw
        or any(not isinstance(key, str) for key in raw)
    ):
        raise ValueError("grid search requires a non-empty dimension list")
    if len(raw) != len(set(raw)):
        raise ValueError("grid search dimensions must be unique")
    return tuple(raw)


def _hard_combination_limit(catalog: Catalog) -> int:
    definition: ParameterDefinition = catalog.parameter("search.maxCombinations")
    if definition.maximum is None or definition.maximum <= 0:
        raise ValueError("catalog must define the search hard combination limit")
    return int(definition.maximum)


def _integer_parameter(params: Mapping[str, object], key: str) -> int:
    value = params.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{key} must be a positive integer")
    if value <= 0:
        raise ValueError(f"{key} must be a positive integer")
    return value


def _strategy_calculation_payload(
    strategy: FrozenStrategyInstance,
    catalog: Catalog,
) -> dict[str, object]:
    preset = catalog.preset(strategy.preset_id)
    module = preset.execution_module
    module_id = (
        ExecutionModule.ACCUMULATION.value
        if module is ExecutionModule.SEARCH
        else module.value
    )
    params = dict(cast(Mapping[str, object], thaw_value(strategy.params)))
    if module is ExecutionModule.SEARCH:
        params = {
            key: value for key, value in params.items() if not key.startswith("search.")
        }
    rules = strategy.rules or materialize_legacy_rules(preset, params)
    return {
        "executionModule": module_id,
        "params": params,
        "rules": rules.model_dump(mode="json", by_alias=True)
        if rules is not None
        else None,
    }


def _completed_candidate(
    candidate_id: str,
    sequence: int,
    strategy: FrozenStrategyInstance,
    fingerprint: str,
    result: MetricsResult,
    diagnostics: tuple[Diagnostic, ...],
    *,
    reused: bool,
) -> SearchCandidate:
    has_warning = any(
        diagnostic.severity is DiagnosticSeverity.WARNING for diagnostic in diagnostics
    )
    return SearchCandidate(
        candidateId=candidate_id,
        sequence=sequence,
        role=ResultRole.STRATEGY,
        status=(
            StrategyStatus.COMPLETED_WITH_WARNING
            if has_warning
            else StrategyStatus.COMPLETED
        ),
        calculationFingerprint=fingerprint,
        parameterValues=strategy.params,
        reusedCalculation=reused,
        metrics=result.summary,
        diagnostics=diagnostics,
    )


def _candidate_rank_key(candidate: SearchCandidate) -> tuple[Decimal, Decimal, int]:
    metrics = candidate.metrics
    if metrics is None:
        raise ValueError("only candidates with metrics can be ranked")
    drawdown = (
        metrics.maximum_drawdown
        if metrics.maximum_drawdown is not None
        else Decimal("Infinity")
    )
    return -metrics.ending_equity, drawdown, candidate.sequence


def _json_default(value: object) -> str:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Enum):
        return str(value.value)
    raise TypeError(f"unsupported fingerprint value: {type(value).__name__}")

"""Serializable domain contracts for configurations, snapshots, and results.

The models in this module contain stable machine keys only.  Display labels and
localized messages belong to catalog/i18n layers and never enter a calculation
contract.
"""

from collections.abc import Mapping
from datetime import UTC, datetime
from datetime import date as Date
from decimal import Decimal
from enum import StrEnum

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_serializer,
    field_validator,
    model_validator,
)

from app.domain.conditions import ConditionKind, StrategyRules
from app.domain.conditions import ConditionLogic as ConditionLogic
from app.domain.immutability import FrozenMap, freeze_mapping, thaw_value
from app.domain.status import (
    Diagnostic,
    DomainModel,
    SignalState,
    StrategyStatus,
    transition_status,
)
from app.domain.valuation import ValuationObservation as ValuationObservation


class StrategyPresetId(StrEnum):
    """Stable strategy catalog identifiers, including fixed condition templates."""

    VIX_DCA = "vix_dca"
    COMPOSITE_DCA = "composite_dca"
    MA_TREND = "ma_trend"
    MA_BUY_ONLY = "ma_buy_only"
    MONTHLY_DCA = "monthly_dca"
    LUMP_SUM = "lump_sum"
    GRID_SEARCH = "grid_search"
    RSI_DCA = "rsi_dca"
    MA_DEVIATION_DCA = "ma_deviation_dca"
    BOLLINGER_DCA = "bollinger_dca"
    RATE_DCA = "rate_dca"
    PE_DCA = "pe_dca"


class ResultRole(StrEnum):
    """Whether a result is an automatic benchmark or a user strategy."""

    BENCHMARK = "benchmark"
    STRATEGY = "strategy"


class RunScope(StrEnum):
    ACTIVE = "active"
    ALL_ENABLED = "all_enabled"


class EndMode(StrEnum):
    FIXED = "fixed"
    LATEST = "latest"


class TradeSide(StrEnum):
    BUY = "buy"
    SELL = "sell"


class TradeReason(StrEnum):
    FIXED_DCA = "fixed_dca"
    UPFRONT = "upfront"
    SIGNAL_BUY = "signal_buy"
    SIGNAL_SELL = "signal_sell"
    SAFETY_VALVE = "safety_valve"


class UnexecutedSignalReason(StrEnum):
    NO_FOLLOWING_BACKTEST_SESSION = "no_following_backtest_session"


class MutableDomainModel(BaseModel):
    """Base for editable drafts; snapshots use the frozen models below."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=False,
        populate_by_name=True,
        str_strip_whitespace=True,
        validate_assignment=True,
    )


class RunSettings(DomainModel):
    symbol: str = Field(min_length=1)
    start_date: Date = Field(alias="startDate")
    end_date: Date = Field(alias="endDate")
    end_mode: EndMode = Field(default=EndMode.FIXED, alias="endMode")

    @model_validator(mode="after")
    def validate_date_range(self) -> "RunSettings":
        if self.start_date > self.end_date:
            raise ValueError("startDate must not be after endDate")
        return self


class ContributionSettings(DomainModel):
    day: int = Field(ge=1, le=31)
    amount: Decimal = Field(ge=0)


class DataSettings(DomainModel):
    """Validated data policy frozen with each run's settings.

    Defaults and parameter-catalog range validation are materialized at the
    catalog/config boundary; domain contracts do not depend on the catalog.
    """

    macro_staleness_sessions: int = Field(
        alias="macroStalenessSessions",
        strict=True,
        ge=0,
    )
    financial_fact_max_age_days: int = Field(
        alias="financialFactMaxAgeDays",
        strict=True,
        ge=1,
    )
    etf_holdings_max_age_days: int = Field(
        alias="etfHoldingsMaxAgeDays",
        strict=True,
        ge=1,
    )


class SharedSettings(DomainModel):
    """Settings shared by every strategy and automatic benchmark."""

    run: RunSettings
    contribution: ContributionSettings
    data: DataSettings


class InstrumentMetadata(DomainModel):
    symbol: str
    currency: str | None = None
    diagnostics: tuple[Diagnostic, ...] = ()


class StrategyInstance(MutableDomainModel):
    """Editable draft instance; its values are copied when a run is submitted."""

    id: str = Field(min_length=1)
    preset_id: StrategyPresetId = Field(alias="presetId")
    enabled: bool = True
    instance_number: int | None = Field(default=None, alias="instanceNumber", ge=1)
    params: dict[str, object] = Field(default_factory=dict)
    rules: StrategyRules | None = None

    @field_validator("params", mode="before")
    @classmethod
    def copy_params(cls, value: object) -> dict[str, object]:
        if not isinstance(value, Mapping):
            raise ValueError("params must be a mapping")
        return dict(value)


class RunConfig(MutableDomainModel):
    """Editable configuration before it is frozen into a ``RunSnapshot``."""

    shared: SharedSettings
    strategies: list[StrategyInstance] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_unique_strategy_ids(self) -> "RunConfig":
        ids = [strategy.id for strategy in self.strategies]
        if len(ids) != len(set(ids)):
            raise ValueError("strategy instance ids must be unique")
        return self


class FrozenStrategyInstance(DomainModel):
    """Immutable strategy copy stored inside a run snapshot."""

    id: str = Field(min_length=1)
    preset_id: StrategyPresetId = Field(alias="presetId")
    enabled: bool = True
    instance_number: int | None = Field(default=None, alias="instanceNumber", ge=1)
    params: Mapping[str, object] = Field(default_factory=dict, validate_default=True)
    rules: StrategyRules | None = None

    @field_validator("params", mode="after")
    @classmethod
    def freeze_params(cls, value: Mapping[str, object]) -> FrozenMap:
        return freeze_mapping(value)

    @field_serializer("params")
    def serialize_params(self, value: Mapping[str, object]) -> object:
        return thaw_value(value)


class FrozenRunConfig(DomainModel):
    """Immutable copy of shared settings and all strategy drafts."""

    shared: SharedSettings
    strategies: tuple[FrozenStrategyInstance, ...] = ()

    @model_validator(mode="after")
    def validate_unique_strategy_ids(self) -> "FrozenRunConfig":
        ids = [strategy.id for strategy in self.strategies]
        if len(ids) != len(set(ids)):
            raise ValueError("strategy instance ids must be unique")
        return self

    @classmethod
    def from_config(cls, config: RunConfig) -> "FrozenRunConfig":
        return cls(
            shared=config.shared.model_copy(deep=True),
            strategies=tuple(
                FrozenStrategyInstance(
                    id=strategy.id,
                    presetId=strategy.preset_id,
                    enabled=strategy.enabled,
                    instanceNumber=strategy.instance_number,
                    params=strategy.params,
                    rules=strategy.rules,
                )
                for strategy in config.strategies
            ),
        )


class RunDataProvenance(DomainModel):
    """Stable source and coverage markers frozen with a submitted run."""

    sources: tuple[str, ...] = ()
    calendar_as_of: Date | None = Field(default=None, alias="calendarAsOf")
    market_data_through: Date | None = Field(default=None, alias="marketDataThrough")

    @field_validator("sources")
    @classmethod
    def sort_unique_sources(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        return tuple(sorted(set(value)))


class RunSnapshot(DomainModel):
    """The immutable input boundary for one submitted run."""

    run_id: str = Field(alias="runId", min_length=1)
    config: FrozenRunConfig
    catalog_version: str = Field(alias="catalogVersion", min_length=1)
    data_fingerprint: str = Field(alias="dataFingerprint", min_length=1)
    engine_version: str = Field(alias="engineVersion", min_length=1)
    data_provenance: RunDataProvenance = Field(
        default_factory=RunDataProvenance, alias="dataProvenance"
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC), alias="createdAt"
    )

    @field_validator("config", mode="before")
    @classmethod
    def freeze_config(
        cls, value: FrozenRunConfig | RunConfig | Mapping[str, object]
    ) -> FrozenRunConfig | Mapping[str, object]:
        if isinstance(value, RunConfig):
            return FrozenRunConfig.from_config(value)
        return value

    @field_validator("created_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("createdAt must include a timezone")
        return value

    @classmethod
    def from_config(
        cls,
        *,
        run_id: str,
        config: RunConfig,
        catalog_version: str,
        data_fingerprint: str,
        engine_version: str,
        created_at: datetime | None = None,
    ) -> "RunSnapshot":
        values: dict[str, object] = {
            "runId": run_id,
            "config": FrozenRunConfig.from_config(config),
            "catalogVersion": catalog_version,
            "dataFingerprint": data_fingerprint,
            "engineVersion": engine_version,
        }
        if created_at is not None:
            values["createdAt"] = created_at
        return cls.model_validate(values)


class MarketBar(DomainModel):
    """One normalized market observation with both price bases preserved."""

    date: Date
    symbol: str = Field(min_length=1)
    simulation_open: Decimal | None = Field(default=None, alias="simulationOpen", gt=0)
    simulation_high: Decimal | None = Field(default=None, alias="simulationHigh", gt=0)
    simulation_low: Decimal | None = Field(default=None, alias="simulationLow", gt=0)
    simulation_price: Decimal = Field(alias="simulationPrice", gt=0)
    valuation_price: Decimal = Field(alias="valuationPrice", gt=0)
    currency: str = Field(min_length=1)
    source: str = Field(min_length=1)
    observed_at: datetime = Field(alias="observedAt")

    @model_validator(mode="after")
    def validate_simulation_ohlc(self) -> "MarketBar":
        values = (self.simulation_open, self.simulation_high, self.simulation_low)
        if any(value is not None for value in values) and not all(
            value is not None for value in values
        ):
            raise ValueError("simulation OHLC values must be complete")
        if all(value is not None for value in values):
            assert self.simulation_open is not None
            assert self.simulation_high is not None
            assert self.simulation_low is not None
            if (
                self.simulation_high < max(self.simulation_open, self.simulation_price)
                or self.simulation_low
                > min(self.simulation_open, self.simulation_price)
                or self.simulation_high < self.simulation_low
            ):
                raise ValueError(
                    "simulation OHLC values must contain the closing price"
                )
        return self


class MarketSnapshot(DomainModel):
    symbol: str = Field(min_length=1)
    currency: str = Field(min_length=1)
    bars: tuple[MarketBar, ...] = ()
    source: str = Field(min_length=1)
    fingerprint: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_bar_identity(self) -> "MarketSnapshot":
        if any(
            bar.symbol != self.symbol or bar.currency != self.currency
            for bar in self.bars
        ):
            raise ValueError("market bars must use the snapshot symbol and currency")
        return self


class MacroObservation(DomainModel):
    """A source observation, optionally normalized onto a target session.

    ``date`` remains the provider's original observation date.  Alignment never
    overwrites it; ``alignedSessionDate`` records the session where the
    as-of-selected value is usable.
    """

    date: Date
    symbol: str = Field(min_length=1)
    value: Decimal
    unit: str = Field(min_length=1)
    source: str = Field(min_length=1)
    observed_at: datetime = Field(alias="observedAt")
    published_at: datetime | None = Field(default=None, alias="publishedAt")
    source_unit: str | None = Field(default=None, alias="sourceUnit", min_length=1)
    aligned_session_date: Date | None = Field(default=None, alias="alignedSessionDate")


class ValuationSnapshot(DomainModel):
    symbol: str = Field(min_length=1)
    observations: tuple[ValuationObservation, ...] = ()
    fingerprint: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_observation_identity(self) -> "ValuationSnapshot":
        if any(observation.symbol != self.symbol for observation in self.observations):
            raise ValueError("valuation observations must use the snapshot symbol")
        return self


class DataSnapshot(DomainModel):
    """Provider-neutral data bundle consumed by signals and the ledger."""

    market: MarketSnapshot
    macro: tuple[MacroObservation, ...] = ()
    valuation: ValuationSnapshot | None = None
    fingerprint: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_valuation_identity(self) -> "DataSnapshot":
        if self.valuation is not None and self.valuation.symbol != self.market.symbol:
            raise ValueError("valuation must use the market snapshot symbol")
        return self


class SignalEvaluation(DomainModel):
    date: Date
    signal_id: str = Field(alias="signalId", min_length=1)
    state: SignalState
    observed_value: Decimal | None = Field(default=None, alias="observedValue")
    observed_unit: str | None = Field(default=None, alias="observedUnit", min_length=1)
    condition_id: str | None = Field(default=None, alias="conditionId")
    condition_kind: ConditionKind | None = Field(default=None, alias="conditionKind")
    source_symbol: str | None = Field(default=None, alias="sourceSymbol")
    sell_ratio: Decimal | None = Field(default=None, alias="sellRatio", ge=0, le=1)
    triggered_signal_ids: tuple[str, ...] = Field(
        default=(), alias="triggeredSignalIds"
    )
    diagnostics: tuple[Diagnostic, ...] = ()

    @model_validator(mode="after")
    def require_unavailable_reason(self) -> "SignalEvaluation":
        if self.state is SignalState.UNAVAILABLE and not self.diagnostics:
            raise ValueError("unavailable signals require a diagnostic")
        return self


class UnexecutedSignal(DomainModel):
    """A true close signal with no later session inside the requested run."""

    signal_date: Date = Field(alias="signalDate")
    signal_id: str = Field(alias="signalId", min_length=1)
    reason: UnexecutedSignalReason


class Trade(DomainModel):
    date: Date
    side: TradeSide
    reason: TradeReason
    quantity: Decimal = Field(gt=0)
    price: Decimal = Field(gt=0)
    cash_amount: Decimal = Field(alias="cashAmount", gt=0)
    currency: str = Field(min_length=1)
    signal_id: str | None = Field(default=None, alias="signalId")


class DailyAsset(DomainModel):
    date: Date
    cash: Decimal = Field(ge=0)
    timing_quantity: Decimal = Field(alias="timingQuantity", ge=0)
    fixed_quantity: Decimal = Field(alias="fixedQuantity", ge=0)
    simulation_open: Decimal | None = Field(default=None, alias="simulationOpen", gt=0)
    simulation_high: Decimal | None = Field(default=None, alias="simulationHigh", gt=0)
    simulation_low: Decimal | None = Field(default=None, alias="simulationLow", gt=0)
    simulation_price: Decimal = Field(alias="simulationPrice", gt=0)
    total_asset: Decimal = Field(alias="totalAsset", ge=0)
    total_contributed: Decimal | None = Field(
        default=None, alias="totalContributed", ge=0
    )
    currency: str = Field(min_length=1)
    unit_nav: Decimal | None = Field(default=None, alias="unitNav", ge=0)
    drawdown: Decimal | None = Field(default=None, ge=-1, le=0)

    @model_validator(mode="after")
    def validate_simulation_ohlc(self) -> "DailyAsset":
        values = (self.simulation_open, self.simulation_high, self.simulation_low)
        if any(value is not None for value in values) and not all(
            value is not None for value in values
        ):
            raise ValueError("simulation OHLC values must be complete")
        if all(value is not None for value in values):
            assert self.simulation_open is not None
            assert self.simulation_high is not None
            assert self.simulation_low is not None
            if (
                self.simulation_high < max(self.simulation_open, self.simulation_price)
                or self.simulation_low
                > min(self.simulation_open, self.simulation_price)
                or self.simulation_high < self.simulation_low
            ):
                raise ValueError(
                    "simulation OHLC values must contain the closing price"
                )
        return self


class MetricSummary(DomainModel):
    total_contributed: Decimal = Field(alias="totalContributed", ge=0)
    actual_invested: Decimal | None = Field(default=None, alias="actualInvested", ge=0)
    ending_equity: Decimal = Field(alias="endingEquity", ge=0)
    net_profit: Decimal = Field(alias="netProfit")
    return_on_contributions: Decimal | None = Field(
        default=None, alias="returnOnContributions"
    )
    capital_multiple: Decimal | None = Field(default=None, alias="capitalMultiple")
    xirr: Decimal | None = None
    maximum_drawdown: Decimal | None = Field(default=None, alias="maximumDrawdown")
    currency: str | None = Field(default=None, min_length=1)
    diagnostics: tuple[Diagnostic, ...] = ()

    @model_validator(mode="before")
    @classmethod
    def read_legacy_summary(cls, value: object) -> object:
        if not isinstance(value, Mapping):
            return value
        fields = dict(value)
        fields.pop("relativeToDca", None)
        fields.pop("relative_to_dca", None)
        return fields


class SearchResultDimension(DomainModel):
    """A stable search axis captured with its persisted candidate results."""

    key: str = Field(min_length=1)
    values: tuple[object, ...] = Field(min_length=1)
    translation_key: str = Field(default="", alias="translationKey")

    @model_validator(mode="after")
    def require_unique_values(self) -> "SearchResultDimension":
        if len(set(self.values)) != len(self.values):
            raise ValueError("search result dimension values must be unique")
        if not self.translation_key:
            object.__setattr__(self, "translation_key", f"parameters.{self.key}")
        return self


class SearchCandidate(DomainModel):
    """One stable candidate result, including invalid or unavailable rows."""

    candidate_id: str = Field(alias="candidateId", min_length=1)
    sequence: int = Field(ge=1)
    role: ResultRole = ResultRole.STRATEGY
    status: StrategyStatus
    calculation_fingerprint: str = Field(alias="calculationFingerprint", min_length=1)
    parameter_values: Mapping[str, object] = Field(
        alias="parameterValues", validate_default=True
    )
    reused_calculation: bool = Field(default=False, alias="reusedCalculation")
    metrics: MetricSummary | None = None
    diagnostics: tuple[Diagnostic, ...] = ()

    @field_validator("parameter_values", mode="after")
    @classmethod
    def freeze_parameter_values(cls, value: Mapping[str, object]) -> FrozenMap:
        return freeze_mapping(value)

    @field_serializer("parameter_values")
    def serialize_parameter_values(self, value: Mapping[str, object]) -> object:
        return thaw_value(value)

    @model_validator(mode="after")
    def validate_candidate_result(self) -> "SearchCandidate":
        if (
            self.status
            in {
                StrategyStatus.COMPLETED,
                StrategyStatus.COMPLETED_WITH_WARNING,
            }
            and self.metrics is None
        ):
            raise ValueError("completed search candidates require metrics")
        if self.status in {StrategyStatus.FAILED, StrategyStatus.UNAVAILABLE} and not (
            self.diagnostics
        ):
            raise ValueError("failed or unavailable candidates require diagnostics")
        if self.reused_calculation and self.metrics is None:
            raise ValueError("only completed candidates can reuse metric calculations")
        return self


class SearchResult(DomainModel):
    """Complete candidate set and stable ranking for one search strategy."""

    strategy_id: str = Field(alias="strategyId", min_length=1)
    dimensions: tuple[SearchResultDimension, ...]
    total_candidate_count: int = Field(alias="totalCandidateCount", ge=1)
    candidates: tuple[SearchCandidate, ...]
    ranked_candidate_ids: tuple[str, ...] = Field(alias="rankedCandidateIds")

    @model_validator(mode="after")
    def validate_candidate_identity(self) -> "SearchResult":
        candidate_ids = tuple(candidate.candidate_id for candidate in self.candidates)
        sequences = tuple(candidate.sequence for candidate in self.candidates)
        if len(set(candidate_ids)) != len(candidate_ids):
            raise ValueError("search candidate IDs must be unique")
        if sequences != tuple(range(1, len(sequences) + 1)):
            raise ValueError("search candidate sequence must be complete and one-based")
        if len(self.candidates) != self.total_candidate_count:
            raise ValueError("every search combination must have a result row")
        if len(set(self.ranked_candidate_ids)) != len(self.ranked_candidate_ids):
            raise ValueError("ranked candidate IDs must be unique")
        expected_ranked_ids = {
            candidate.candidate_id
            for candidate in self.candidates
            if candidate.metrics is not None
            and candidate.status
            in {
                StrategyStatus.COMPLETED,
                StrategyStatus.COMPLETED_WITH_WARNING,
            }
        }
        if set(self.ranked_candidate_ids) != expected_ranked_ids:
            raise ValueError("ranking must include every completed candidate once")
        return self


class SearchHeatmapSlice(DomainModel):
    """A two-axis candidate view with every other dimension frozen."""

    x_dimension: str = Field(alias="xDimension", min_length=1)
    y_dimension: str = Field(alias="yDimension", min_length=1)
    x_values: tuple[object, ...] = Field(alias="xValues")
    y_values: tuple[object, ...] = Field(alias="yValues")
    fixed_values: Mapping[str, object] = Field(alias="fixedValues")
    candidates: tuple[SearchCandidate, ...]

    @field_validator("fixed_values", mode="after")
    @classmethod
    def freeze_fixed_values(cls, value: Mapping[str, object]) -> FrozenMap:
        return freeze_mapping(value)

    @field_serializer("fixed_values")
    def serialize_fixed_values(self, value: Mapping[str, object]) -> object:
        return thaw_value(value)

    @model_validator(mode="after")
    def require_distinct_axes(self) -> "SearchHeatmapSlice":
        if self.x_dimension == self.y_dimension:
            raise ValueError("heatmap axes must use distinct dimensions")
        if (
            self.x_dimension in self.fixed_values
            or self.y_dimension in self.fixed_values
        ):
            raise ValueError("heatmap axis dimensions cannot also be fixed")
        return self


class StrategyRun(DomainModel):
    """One strategy result; zero trades is valid when metrics are complete."""

    id: str = Field(min_length=1)
    preset_id: StrategyPresetId = Field(alias="presetId")
    instance_number: int | None = Field(default=None, alias="instanceNumber", ge=1)
    role: ResultRole
    status: StrategyStatus = StrategyStatus.QUEUED
    diagnostics: tuple[Diagnostic, ...] = ()
    signals: tuple[SignalEvaluation, ...] = ()
    unexecuted_signals: tuple[UnexecutedSignal, ...] = Field(
        default=(), alias="unexecutedSignals"
    )
    trades: tuple[Trade, ...] = ()
    daily_assets: tuple[DailyAsset, ...] = Field(default=(), alias="dailyAssets")
    metrics: MetricSummary | None = None
    search_result: SearchResult | None = Field(default=None, alias="searchResult")

    @model_validator(mode="after")
    def validate_terminal_result(self) -> "StrategyRun":
        if self.search_result is not None and self.search_result.strategy_id != self.id:
            raise ValueError("search result must belong to its strategy run")
        if (
            self.search_result is not None
            and self.preset_id is not StrategyPresetId.GRID_SEARCH
        ):
            raise ValueError("only grid-search runs can contain search results")
        if (
            self.status
            in {
                StrategyStatus.COMPLETED,
                StrategyStatus.COMPLETED_WITH_WARNING,
            }
            and self.metrics is None
        ):
            raise ValueError("completed strategy runs require metrics")
        if self.status in {StrategyStatus.UNAVAILABLE, StrategyStatus.FAILED} and not (
            self.diagnostics
        ):
            raise ValueError("unavailable or failed runs require diagnostics")
        return self

    def with_status(
        self,
        target: StrategyStatus,
        *,
        diagnostics: tuple[Diagnostic, ...] | None = None,
    ) -> "StrategyRun":
        """Return a new result after validating the shared state transition."""

        next_status = transition_status(self.status, target)
        next_diagnostics = (
            self.diagnostics if diagnostics is None else tuple(diagnostics)
        )
        if (
            next_status
            in {
                StrategyStatus.COMPLETED,
                StrategyStatus.COMPLETED_WITH_WARNING,
            }
            and self.metrics is None
        ):
            raise ValueError("completed strategy runs require metrics")
        if next_status in {StrategyStatus.UNAVAILABLE, StrategyStatus.FAILED} and not (
            next_diagnostics
        ):
            raise ValueError("unavailable or failed runs require diagnostics")
        return self.model_copy(
            update={"status": next_status, "diagnostics": next_diagnostics}
        )

    @property
    def is_zero_trade_success(self) -> bool:
        return (
            self.status
            in {
                StrategyStatus.COMPLETED,
                StrategyStatus.COMPLETED_WITH_WARNING,
            }
            and self.metrics is not None
            and not self.trades
        )


class RunResult(DomainModel):
    """Saved result collection, including partial success across strategies."""

    run_id: str = Field(alias="runId", min_length=1)
    strategy_runs: tuple[StrategyRun, ...] = Field(default=(), alias="strategyRuns")
    status: StrategyStatus = StrategyStatus.QUEUED

    @model_validator(mode="after")
    def derive_status(self) -> "RunResult":
        if self.strategy_runs:
            object.__setattr__(self, "status", _aggregate_status(self.strategy_runs))
        return self

    @property
    def is_partial_success(self) -> bool:
        successes = [
            run.status
            in {StrategyStatus.COMPLETED, StrategyStatus.COMPLETED_WITH_WARNING}
            for run in self.strategy_runs
        ]
        return any(successes) and not all(successes)


# Stable descriptive aliases for consumers that use data/result terminology.
StandardizedDataSnapshot = DataSnapshot
PerformanceMetrics = MetricSummary


def _aggregate_status(strategy_runs: tuple[StrategyRun, ...]) -> StrategyStatus:
    statuses = {run.status for run in strategy_runs}
    if StrategyStatus.RUNNING in statuses:
        return StrategyStatus.RUNNING
    if StrategyStatus.LOADING in statuses:
        return StrategyStatus.LOADING
    if StrategyStatus.QUEUED in statuses:
        return StrategyStatus.QUEUED

    if StrategyStatus.CANCELLED in statuses:
        return StrategyStatus.CANCELLED

    successes = {
        StrategyStatus.COMPLETED,
        StrategyStatus.COMPLETED_WITH_WARNING,
    }
    if statuses <= {StrategyStatus.UNAVAILABLE}:
        return StrategyStatus.UNAVAILABLE
    if statuses <= {StrategyStatus.FAILED, StrategyStatus.UNAVAILABLE}:
        return StrategyStatus.FAILED
    if statuses & successes and statuses - successes:
        return StrategyStatus.COMPLETED_WITH_WARNING
    if StrategyStatus.COMPLETED_WITH_WARNING in statuses:
        return StrategyStatus.COMPLETED_WITH_WARNING
    return StrategyStatus.COMPLETED

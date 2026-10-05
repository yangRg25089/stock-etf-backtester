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
from itertools import combinations, pairwise
from typing import Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_serializer,
    field_validator,
    model_validator,
)
from pydantic.config import JsonDict

from app.domain.conditions import ConditionKind, StrategyRules
from app.domain.conditions import ConditionLogic as ConditionLogic
from app.domain.execution import ExecutionSettings, TradingCosts
from app.domain.immutability import FrozenMap, freeze_mapping, thaw_mapping
from app.domain.performance import AnalysisSettings, PerformanceAnalysis
from app.domain.status import (
    Diagnostic,
    DomainModel,
    SignalState,
    StrategyStatus,
    transition_status,
)
from app.domain.valuation import ValuationObservation as ValuationObservation
from app.domain.values import AwareTimestamp, Symbol


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
    symbol: Symbol
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
    analysis: AnalysisSettings | None = None
    execution: ExecutionSettings | None = None


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
    def serialize_params(self, value: Mapping[str, object]) -> dict[str, object]:
        return thaw_mapping(value)


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


class RunDateAdjustment(DomainModel):
    """A verified date resolution recorded after the submitted config is frozen."""

    field: Literal["startDate", "endDate"]
    requested_date: Date = Field(alias="requestedDate")
    effective_date: Date = Field(alias="effectiveDate")
    reason: Literal["market_available_from", "indicator_warmup"]

    @model_validator(mode="after")
    def require_changed_date(self) -> "RunDateAdjustment":
        if self.requested_date == self.effective_date:
            raise ValueError("a date adjustment must change the requested date")
        return self


class RunDataContext(DomainModel):
    """Data identity and resolved range, available only after the worker loads data."""

    data_fingerprint: str = Field(alias="dataFingerprint", min_length=1)
    data_provenance: RunDataProvenance = Field(
        default_factory=RunDataProvenance, alias="dataProvenance"
    )
    effective_run: RunSettings = Field(alias="effectiveRun")
    date_adjustments: tuple[RunDateAdjustment, ...] = Field(
        default=(), alias="dateAdjustments"
    )

    @model_validator(mode="after")
    def validate_adjustments(self) -> "RunDataContext":
        dates = {
            "startDate": self.effective_run.start_date,
            "endDate": self.effective_run.end_date,
        }
        fields = [item.field for item in self.date_adjustments]
        if len(set(fields)) != len(fields) or any(
            dates[item.field] != item.effective_date for item in self.date_adjustments
        ):
            raise ValueError("date adjustments must uniquely match resolved dates")
        return self


class RunSnapshot(DomainModel):
    """The immutable input boundary for one submitted run."""

    run_id: str = Field(alias="runId", min_length=1)
    config: FrozenRunConfig
    catalog_version: str = Field(alias="catalogVersion", min_length=1)
    engine_version: str = Field(alias="engineVersion", min_length=1)
    submission_fingerprint: str | None = Field(
        default=None, alias="submissionFingerprint", min_length=1
    )
    data_context: RunDataContext | None = Field(default=None, alias="dataContext")
    # Compatibility projections are derived from data_context, like RunResult.status.
    data_fingerprint: str | None = Field(
        default=None,
        alias="dataFingerprint",
        min_length=1,
        json_schema_extra={"readOnly": True},
    )
    data_provenance: RunDataProvenance = Field(
        default_factory=RunDataProvenance,
        alias="dataProvenance",
        json_schema_extra={"readOnly": True},
    )
    date_adjustments: tuple[RunDateAdjustment, ...] = Field(
        default=(), alias="dateAdjustments", json_schema_extra={"readOnly": True}
    )
    created_at: AwareTimestamp = Field(
        default_factory=lambda: datetime.now(UTC), alias="createdAt"
    )

    @model_validator(mode="before")
    @classmethod
    def read_data_projections(cls, value: object) -> object:
        """Read schema-1 snapshots; projections never become a second data authority."""
        if not isinstance(value, Mapping):
            return value
        values = dict(value)
        projections: dict[str, object] = {}
        for name, alias in (
            ("data_fingerprint", "dataFingerprint"),
            ("data_provenance", "dataProvenance"),
            ("date_adjustments", "dateAdjustments"),
        ):
            present = [values.pop(key) for key in (name, alias) if key in values]
            if present:
                if any(item != present[0] for item in present):
                    raise ValueError("conflicting snapshot data aliases")
                projections[name] = present[0]
        context_value = values.get("dataContext", values.get("data_context"))
        if context_value is not None:
            context = RunDataContext.model_validate(context_value)
            for name, projected in projections.items():
                if name == "data_provenance":
                    projected = RunDataProvenance.model_validate(projected)
                elif name == "date_adjustments":
                    if not isinstance(projected, (list, tuple)):
                        raise ValueError("invalid date adjustments projection")
                    projected = tuple(
                        RunDateAdjustment.model_validate(item) for item in projected
                    )
                if projected != getattr(context, name):
                    raise ValueError("snapshot data projection does not match context")
        elif projections.get("data_fingerprint") is not None:
            config_value = values.get("config")
            config = (
                FrozenRunConfig.from_config(config_value)
                if isinstance(config_value, RunConfig)
                else FrozenRunConfig.model_validate(config_value)
            )
            context = RunDataContext.model_validate(
                {"effectiveRun": config.shared.run, **projections}
            )
            values["dataContext"] = context
        elif projections:
            provenance = RunDataProvenance.model_validate(
                projections.get("data_provenance", {})
            )
            if provenance != RunDataProvenance() or projections.get("date_adjustments"):
                raise ValueError(
                    "data provenance and date resolution require data identity"
                )
        return values

    @field_validator("config", mode="before")
    @classmethod
    def freeze_config(
        cls, value: FrozenRunConfig | RunConfig | Mapping[str, object]
    ) -> FrozenRunConfig | Mapping[str, object]:
        if isinstance(value, RunConfig):
            return FrozenRunConfig.from_config(value)
        return value

    @model_validator(mode="after")
    def validate_data_context(self) -> "RunSnapshot":
        if self.data_context is None:
            if self.submission_fingerprint is None:
                raise ValueError(
                    "a submission fingerprint is required before data is loaded"
                )
            return self
        object.__setattr__(self, "data_fingerprint", self.data_context.data_fingerprint)
        object.__setattr__(self, "data_provenance", self.data_context.data_provenance)
        object.__setattr__(self, "date_adjustments", self.data_context.date_adjustments)
        requested = self.config.shared.run
        updates = {}
        for adjustment in self.date_adjustments:
            field = "start_date" if adjustment.field == "startDate" else "end_date"
            # Legacy snapshots already stored resolved dates in their config.
            expected = (
                {adjustment.requested_date}
                if self.submission_fingerprint
                else {adjustment.requested_date, adjustment.effective_date}
            )
            if getattr(requested, field) not in expected:
                raise ValueError("date adjustment does not match submitted dates")
            updates[field] = adjustment.effective_date
        if requested.model_copy(update=updates) != self.data_context.effective_run:
            raise ValueError(
                "data context may only resolve documented date adjustments"
            )
        return self

    @property
    def effective_config(self) -> FrozenRunConfig:
        if (
            self.data_context is None
            or self.data_context.effective_run == self.config.shared.run
        ):
            return self.config
        return self.config.model_copy(
            update={
                "shared": self.config.shared.model_copy(
                    update={"run": self.data_context.effective_run}
                )
            }
        )

    def with_data_context(self, context: RunDataContext) -> "RunSnapshot":
        if self.data_context is not None and self.data_context != context:
            raise ValueError("the loaded data context is already frozen")
        return RunSnapshot(
            runId=self.run_id,
            config=self.config,
            catalogVersion=self.catalog_version,
            engineVersion=self.engine_version,
            submissionFingerprint=self.submission_fingerprint,
            createdAt=self.created_at,
            dataContext=context,
        )

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
    observed_at: AwareTimestamp = Field(alias="observedAt")

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
        if any(left.date >= right.date for left, right in pairwise(self.bars)):
            raise ValueError("market bar dates must be strictly increasing and unique")
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
    observed_at: AwareTimestamp = Field(alias="observedAt")
    published_at: AwareTimestamp | None = Field(default=None, alias="publishedAt")
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
    cash_before: Decimal | None = Field(default=None, alias="cashBefore", ge=0)
    cash_after: Decimal | None = Field(default=None, alias="cashAfter", ge=0)
    quantity_before: Decimal | None = Field(default=None, alias="quantityBefore", ge=0)
    quantity_after: Decimal | None = Field(default=None, alias="quantityAfter", ge=0)
    execution_base_price: Decimal | None = Field(
        default=None, alias="executionBasePrice", gt=0
    )
    execution_price: Decimal | None = Field(default=None, alias="executionPrice", gt=0)
    gross_amount: Decimal | None = Field(default=None, alias="grossAmount", gt=0)
    trading_costs: TradingCosts | None = Field(default=None, alias="tradingCosts")

    @model_validator(mode="after")
    def validate_execution_price(self) -> "Trade":
        if self.execution_price is not None and self.execution_price != self.price:
            raise ValueError("executionPrice must match the saved trade price")
        return self


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
    actual_invested: Decimal | None = Field(default=None, alias="actualInvested", ge=0)
    currency: str = Field(min_length=1)
    unit_nav: Decimal | None = Field(default=None, alias="unitNav", ge=0)
    drawdown: Decimal | None = Field(default=None, ge=-1, le=0)
    trading_costs: TradingCosts | None = Field(default=None, alias="tradingCosts")

    @model_validator(mode="after")
    def validate_simulation_ohlc(self) -> "DailyAsset":
        if (
            self.actual_invested is not None
            and self.total_contributed is not None
            and self.actual_invested > self.total_contributed
        ):
            raise ValueError("invested principal cannot exceed contributed principal")
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
    investment_basis: Literal["original_principal", "buy_turnover"] | None = Field(
        default=None, alias="investmentBasis"
    )
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
    analysis: PerformanceAnalysis | None = None
    trading_costs: TradingCosts | None = Field(default=None, alias="tradingCosts")

    @model_validator(mode="before")
    @classmethod
    def read_legacy_summary(cls, value: object) -> object:
        if not isinstance(value, Mapping):
            return value
        fields = dict(value)
        fields.pop("relativeToDca", None)
        fields.pop("relative_to_dca", None)
        if (
            fields.get("investmentBasis", fields.get("investment_basis")) is None
            and fields.get("actualInvested", fields.get("actual_invested")) is not None
        ):
            fields["investmentBasis"] = "buy_turnover"
        return fields

    @model_validator(mode="after")
    def validate_invested_principal(self) -> "MetricSummary":
        if self.investment_basis == "original_principal" and (
            self.actual_invested is None
            or self.actual_invested > self.total_contributed
        ):
            raise ValueError(
                "original invested principal must be present "
                "and cannot exceed contributions"
            )
        return self


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


class SearchPeriod(DomainModel):
    """Saved independent evaluation window, including actual session coverage."""

    phase: Literal["train", "test"]
    start_date: Date = Field(alias="startDate")
    end_date: Date = Field(alias="endDate")
    effective_start_date: Date | None = Field(default=None, alias="effectiveStartDate")
    effective_end_date: Date | None = Field(default=None, alias="effectiveEndDate")

    @model_validator(mode="after")
    def validate_period(self) -> "SearchPeriod":
        if self.start_date > self.end_date:
            raise ValueError("search period must be ordered")
        if (self.effective_start_date is None) != (self.effective_end_date is None):
            raise ValueError("search period session bounds must be saved together")
        if self.effective_start_date is not None:
            assert self.effective_end_date is not None
            if (
                not self.start_date
                <= self.effective_start_date
                <= self.effective_end_date
                <= self.end_date
            ):
                raise ValueError("effective sessions must lie within the search period")
        return self


class SearchTestResult(DomainModel):
    """Test summary references its own saved detail; never participates in ranking."""

    result_id: str = Field(alias="resultId", min_length=1)
    status: StrategyStatus
    metrics: MetricSummary | None = None
    diagnostics: tuple[Diagnostic, ...] = ()

    @model_validator(mode="after")
    def validate_outcome(self) -> "SearchTestResult":
        if (
            self.status
            in {StrategyStatus.COMPLETED, StrategyStatus.COMPLETED_WITH_WARNING}
            and self.metrics is None
        ):
            raise ValueError("completed test outcomes require metrics")
        if (
            self.status in {StrategyStatus.FAILED, StrategyStatus.UNAVAILABLE}
            and not self.diagnostics
        ):
            raise ValueError("unsuccessful test outcomes require diagnostics")
        return self


class WalkForwardWindow(DomainModel):
    sequence: int = Field(ge=1)
    train_period: SearchPeriod = Field(alias="trainPeriod")
    test_period: SearchPeriod = Field(alias="testPeriod")
    candidate_ids: tuple[str, ...] = Field(alias="candidateIds", min_length=1)
    ranked_candidate_ids: tuple[str, ...] = Field(alias="rankedCandidateIds")
    selected_candidate_id: str | None = Field(default=None, alias="selectedCandidateId")

    @model_validator(mode="after")
    def validate_window(self) -> "WalkForwardWindow":
        if (
            self.train_period.phase != "train"
            or self.test_period.phase != "test"
            or self.train_period.end_date >= self.test_period.start_date
        ):
            raise ValueError("walk-forward training must precede its testing")
        if len(set(self.candidate_ids)) != len(self.candidate_ids) or not set(
            self.ranked_candidate_ids
        ) <= set(self.candidate_ids):
            raise ValueError("walk-forward window identities must be distinct")
        if self.selected_candidate_id != (
            self.ranked_candidate_ids[0] if self.ranked_candidate_ids else None
        ):
            raise ValueError("walk-forward parameters must use the training winner")
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
    test_result: SearchTestResult | None = Field(default=None, alias="testResult")

    @field_validator("parameter_values", mode="after")
    @classmethod
    def freeze_parameter_values(cls, value: Mapping[str, object]) -> FrozenMap:
        return freeze_mapping(value)

    @field_serializer("parameter_values")
    def serialize_parameter_values(
        self, value: Mapping[str, object]
    ) -> dict[str, object]:
        return thaw_mapping(value)

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
    optimization_mode: Literal["full_period", "train_test", "walk_forward"] = Field(
        default="full_period", alias="optimizationMode"
    )
    train_period: SearchPeriod | None = Field(default=None, alias="trainPeriod")
    test_period: SearchPeriod | None = Field(default=None, alias="testPeriod")
    period_benchmarks: tuple["StrategyRun", ...] = Field(
        default=(), alias="periodBenchmarks"
    )
    walk_forward_windows: tuple[WalkForwardWindow, ...] = Field(
        default=(), alias="walkForwardWindows"
    )
    out_of_sample: SearchTestResult | None = Field(default=None, alias="outOfSample")
    out_of_sample_period: SearchPeriod | None = Field(
        default=None, alias="outOfSamplePeriod"
    )

    def candidate_period(self, result_id: str) -> SearchPeriod | None:
        if self.out_of_sample is not None and result_id == self.out_of_sample.result_id:
            return self.out_of_sample_period
        for window in self.walk_forward_windows:
            if result_id in window.candidate_ids:
                return window.train_period
        if any(
            row.test_result is not None and row.test_result.result_id == result_id
            for row in self.candidates
        ):
            return self.test_period
        return self.train_period

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
        if self.optimization_mode == "walk_forward":
            _validate_walk_forward_search(self, candidate_ids, expected_ranked_ids)
        elif (
            self.walk_forward_windows
            or self.out_of_sample is not None
            or self.out_of_sample_period is not None
        ):
            raise ValueError("rolling results require walk-forward mode")
        elif self.optimization_mode == "train_test":
            _validate_split_search(self, candidate_ids)
        else:
            _validate_full_period_search(self)
        return self


def _validate_walk_forward_search(
    result: SearchResult, candidate_ids: tuple[str, ...], expected_ranked_ids: set[str]
) -> None:
    windows = result.walk_forward_windows
    if (
        not windows
        or result.out_of_sample is None
        or result.out_of_sample_period is None
        or result.train_period is not None
        or result.test_period is not None
    ):
        raise ValueError(
            "walk-forward requires windows and a saved out-of-sample result"
        )
    window_ids = tuple(
        identifier for window in windows for identifier in window.candidate_ids
    )
    if window_ids != candidate_ids or [window.sequence for window in windows] != list(
        range(1, len(windows) + 1)
    ):
        raise ValueError("walk-forward windows must partition ordered candidates")
    if result.ranked_candidate_ids != tuple(
        identifier for window in windows for identifier in window.ranked_candidate_ids
    ) or any(row.test_result is not None for row in result.candidates):
        raise ValueError("walk-forward keeps separate training rankings")
    if (
        result.out_of_sample.result_id in set(candidate_ids)
        or result.out_of_sample_period.phase != "test"
    ):
        raise ValueError("out-of-sample identity must be separate from training")
    for index, window in enumerate(windows):
        completed = expected_ranked_ids.intersection(window.candidate_ids)
        if set(window.ranked_candidate_ids) != completed or len(
            set(window.ranked_candidate_ids)
        ) != len(window.ranked_candidate_ids):
            raise ValueError("every window must retain its complete training ranking")
        if (
            index
            and (
                window.test_period.start_date - windows[index - 1].test_period.end_date
            ).days
            != 1
        ):
            raise ValueError("out-of-sample windows must be contiguous")
    if (
        result.out_of_sample_period.start_date != windows[0].test_period.start_date
        or result.out_of_sample_period.end_date != windows[-1].test_period.end_date
    ):
        raise ValueError("out-of-sample period must cover every testing window")
    if (
        len(result.period_benchmarks) != 2
        or len({row.id for row in result.period_benchmarks}) != 2
        or {row.preset_id for row in result.period_benchmarks}
        != {StrategyPresetId.MONTHLY_DCA, StrategyPresetId.LUMP_SUM}
        or any(
            row.role != ResultRole.BENCHMARK
            or row.evaluation_period != result.out_of_sample_period
            for row in result.period_benchmarks
        )
    ):
        raise ValueError("walk-forward requires matching out-of-sample benchmarks")


def _validate_split_search(
    result: SearchResult, candidate_ids: tuple[str, ...]
) -> None:
    if result.train_period is None or result.test_period is None:
        raise ValueError("split search requires both saved periods")
    if (
        result.train_period.phase != "train"
        or result.test_period.phase != "test"
        or result.train_period.end_date >= result.test_period.start_date
    ):
        raise ValueError("train and test periods must be disjoint and ordered")
    test_ids = tuple(
        row.test_result.result_id
        for row in result.candidates
        if row.test_result is not None
    )
    if len(test_ids) != len(candidate_ids) or len(
        set((*candidate_ids, *test_ids))
    ) != 2 * len(candidate_ids):
        raise ValueError("every split candidate requires a distinct test identity")
    if (
        len(result.period_benchmarks) != 4
        or len({row.id for row in result.period_benchmarks}) != 4
    ):
        raise ValueError("split search requires four distinct period baselines")
    for period in (result.train_period, result.test_period):
        baselines = [
            row
            for row in result.period_benchmarks
            if row.evaluation_period == period and row.role == ResultRole.BENCHMARK
        ]
        if {row.preset_id for row in baselines} != {
            StrategyPresetId.MONTHLY_DCA,
            StrategyPresetId.LUMP_SUM,
        } or len(baselines) != 2:
            raise ValueError("each period requires matching DCA and lump-sum baselines")


def _validate_full_period_search(result: SearchResult) -> None:
    if (
        result.train_period is not None
        or result.test_period is not None
        or result.period_benchmarks
        or any(row.test_result is not None for row in result.candidates)
    ):
        raise ValueError("full-period search cannot contain split evaluation results")


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
    def serialize_fixed_values(self, value: Mapping[str, object]) -> dict[str, object]:
        return thaw_mapping(value)

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


class TechnicalIndicatorSample(DomainModel):
    date: Date
    value: Decimal | None = Field(default=None, allow_inf_nan=False)
    lower: Decimal | None = Field(default=None, allow_inf_nan=False)
    upper: Decimal | None = Field(default=None, allow_inf_nan=False)


class TechnicalIndicatorSeries(DomainModel):
    """Exact signal-cache values; null samples retain explicit warmup/gaps."""

    kind: Literal["ma", "bollinger", "rsi"]
    period: int = Field(ge=1)
    deviations: Decimal | None = Field(default=None, gt=0, allow_inf_nan=False)
    samples: tuple[TechnicalIndicatorSample, ...] = ()

    @model_validator(mode="after")
    def validate_series(self) -> "TechnicalIndicatorSeries":
        if (self.kind == "bollinger") != (self.deviations is not None):
            raise ValueError("only Bollinger series require deviations")
        dates = [sample.date for sample in self.samples]
        if dates != sorted(set(dates)):
            raise ValueError("indicator samples must have unique ascending dates")
        for sample in self.samples:
            if self.kind == "bollinger":
                values = (sample.lower, sample.value, sample.upper)
                if any(value is None for value in values) != all(
                    value is None for value in values
                ):
                    raise ValueError(
                        "Bollinger samples require all three bands or none"
                    )
                if (
                    sample.lower is not None
                    and sample.upper is not None
                    and sample.value is not None
                    and not (sample.lower <= sample.value <= sample.upper)
                ):
                    raise ValueError("Bollinger bands must be ordered")
            elif sample.lower is not None or sample.upper is not None:
                raise ValueError("only Bollinger samples contain bands")
            if (
                self.kind == "rsi"
                and sample.value is not None
                and not (0 <= sample.value <= 100)
            ):
                raise ValueError("RSI values must be between zero and one hundred")
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
    technical_indicators: tuple[TechnicalIndicatorSeries, ...] = Field(
        default=(), alias="technicalIndicators"
    )
    unexecuted_signals: tuple[UnexecutedSignal, ...] = Field(
        default=(), alias="unexecutedSignals"
    )
    trades: tuple[Trade, ...] = ()
    daily_assets: tuple[DailyAsset, ...] = Field(default=(), alias="dailyAssets")
    metrics: MetricSummary | None = None
    search_result: SearchResult | None = Field(default=None, alias="searchResult")
    evaluation_period: SearchPeriod | None = Field(
        default=None, alias="evaluationPeriod"
    )

    @model_validator(mode="after")
    def validate_terminal_result(self) -> "StrategyRun":
        if self.evaluation_period is not None and any(
            not self.evaluation_period.start_date
            <= day
            <= self.evaluation_period.end_date
            for day in (
                *[row.date for row in self.daily_assets],
                *[row.date for row in self.trades],
            )
        ):
            raise ValueError(
                "saved trades and assets must belong to their evaluation period"
            )
        if self.search_result is not None and self.search_result.strategy_id != self.id:
            raise ValueError("search result must belong to its strategy run")
        if (
            self.search_result is not None
            and self.preset_id is not StrategyPresetId.GRID_SEARCH
        ):
            raise ValueError("only grid-search runs can contain search results")
        if (
            self.search_result is not None
            and self.search_result.out_of_sample is not None
            and (
                self.metrics != self.search_result.out_of_sample.metrics
                or self.evaluation_period != self.search_result.out_of_sample_period
            )
        ):
            raise ValueError(
                "walk-forward parent must display its out-of-sample result"
            )
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


def _result_status_schema(schema: JsonDict) -> None:
    """Readers check the domain's aggregation table instead of copying its rules."""
    statuses = sorted(StrategyStatus, key=lambda status: status.value)
    table: JsonDict = {"": StrategyStatus.QUEUED.value}
    for count in range(1, len(statuses) + 1):
        for group in combinations(statuses, count):
            key = "|".join(status.value for status in group)
            rows = tuple(StrategyRun.model_construct(status=status) for status in group)
            table[key] = _aggregate_status(rows).value
    schema["x-aggregate-status"] = table


class RunResult(DomainModel):
    """Saved result collection, including partial success across strategies."""

    model_config = ConfigDict(json_schema_extra=_result_status_schema)

    run_id: str = Field(alias="runId", min_length=1)
    strategy_runs: tuple[StrategyRun, ...] = Field(default=(), alias="strategyRuns")
    status: StrategyStatus = StrategyStatus.QUEUED

    @model_validator(mode="after")
    def derive_status(self) -> "RunResult":
        if self.strategy_runs:
            object.__setattr__(self, "status", _aggregate_status(self.strategy_runs))
        elif self.status is not StrategyStatus.QUEUED:
            raise ValueError("an empty result collection must be queued")
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

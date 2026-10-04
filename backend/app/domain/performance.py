"""Saved cash-flow-adjusted analysis, separate from investor cash-flow returns."""

from collections.abc import Mapping
from datetime import date as Date
from decimal import Decimal
from typing import Literal

from pydantic import (
    Field,
    ValidationInfo,
    field_serializer,
    field_validator,
    model_validator,
)

from .immutability import FrozenMap, freeze_mapping
from .status import DomainModel

PeriodUnavailableReason = Literal["no_funding", "missing_nav", "undefined_nav"]


class PeriodReturn(DomainModel):
    year: int = Field(ge=1, le=9999)
    month: int | None = Field(default=None, ge=1, le=12)
    start_date: Date = Field(alias="startDate")
    end_date: Date = Field(alias="endDate")
    nav_return: Decimal | None = Field(alias="navReturn", ge=-1)
    price_return: Decimal = Field(alias="priceReturn", ge=-1)
    unavailable_reason: PeriodUnavailableReason | None = Field(
        default=None, alias="unavailableReason"
    )

    @model_validator(mode="after")
    def validate_period(self) -> "PeriodReturn":
        if (
            self.start_date > self.end_date
            or self.start_date.year != self.year
            or self.end_date.year != self.year
            or (
                self.month is not None
                and (
                    self.start_date.month != self.month
                    or self.end_date.month != self.month
                )
            )
        ):
            raise ValueError("period dates must belong to the stated period")
        if (self.nav_return is None) != (self.unavailable_reason is not None):
            raise ValueError("unavailable NAV return requires its saved reason")
        return self


class DrawdownEpisode(DomainModel):
    peak_date: Date = Field(alias="peakDate")
    bottom_date: Date = Field(alias="bottomDate")
    recovered_date: Date | None = Field(alias="recoveredDate")
    end_date: Date = Field(alias="endDate")
    drawdown: Decimal = Field(ge=-1, lt=0)
    duration_days: int = Field(alias="durationDays", ge=0)
    recovery_days: int | None = Field(alias="recoveryDays", ge=0)
    state: Literal["recovered", "ongoing"]

    @model_validator(mode="after")
    def validate_episode(self) -> "DrawdownEpisode":
        if not self.peak_date <= self.bottom_date <= self.end_date:
            raise ValueError("drawdown dates must be ordered")
        if self.duration_days != (self.end_date - self.peak_date).days:
            raise ValueError("drawdown duration must match saved dates")
        if self.state == "recovered":
            if (
                self.recovered_date != self.end_date
                or self.recovery_days != (self.end_date - self.bottom_date).days
            ):
                raise ValueError(
                    "recovered drawdown must record the recovery date and duration"
                )
        elif self.recovered_date is not None or self.recovery_days is not None:
            raise ValueError("ongoing drawdown has no recovery date or duration")
        return self


class AnalysisSettings(DomainModel):
    # Defaults and upper/lower configuration limits belong to the registry.
    risk_free_annual_rate_pct: Decimal = Field(alias="riskFreeAnnualRatePct", gt=-100)


class PerformanceAnalysis(DomainModel):
    method: Literal["unit-nav-v1"] = Field(alias="analysisMethod")
    trading_days_per_year: Literal[252] = Field(alias="tradingDaysPerYear")
    duration_unit: Literal["calendar_days"] = Field(alias="durationUnit")
    risk_free_annual_rate: Decimal = Field(alias="riskFreeAnnualRate", gt=-1)
    annualized_return: Decimal | None = Field(
        default=None, alias="annualizedReturn", ge=-1
    )
    annualized_volatility: Decimal | None = Field(
        default=None, alias="annualizedVolatility", ge=0
    )
    sharpe_ratio: Decimal | None = Field(default=None, alias="sharpeRatio")
    sortino_ratio: Decimal | None = Field(default=None, alias="sortinoRatio")
    calmar_ratio: Decimal | None = Field(default=None, alias="calmarRatio")
    maximum_drawdown_duration: int | None = Field(
        default=None, alias="maximumDrawdownDuration", ge=0
    )
    recovery_duration: int | None = Field(default=None, alias="recoveryDuration", ge=0)
    buy_count: int = Field(alias="buyCount", ge=0)
    sell_count: int = Field(alias="sellCount", ge=0)
    turnover: Decimal | None = Field(default=None, ge=0)
    average_cash_ratio: Decimal | None = Field(
        default=None, alias="averageCashRatio", ge=0, le=1
    )
    unavailable_reasons: Mapping[str, str] = Field(
        default_factory=dict, alias="unavailableReasons", validate_default=True
    )
    annual_returns: tuple[PeriodReturn, ...] | None = Field(
        default=None, alias="annualReturns"
    )
    monthly_returns: tuple[PeriodReturn, ...] | None = Field(
        default=None, alias="monthlyReturns"
    )
    drawdown_episodes: tuple[DrawdownEpisode, ...] | None = Field(
        default=None, alias="drawdownEpisodes"
    )

    @field_validator("annual_returns", "monthly_returns")
    @classmethod
    def validate_periods(
        cls, value: tuple[PeriodReturn, ...] | None, info: ValidationInfo
    ) -> tuple[PeriodReturn, ...] | None:
        if value is None:
            return value
        monthly = info.field_name == "monthly_returns"
        keys = [(row.year, row.month or 0) for row in value]
        if any((row.month is not None) != monthly for row in value) or any(
            left >= right for left, right in zip(keys, keys[1:], strict=False)
        ):
            raise ValueError("period series must have unique ordered matching periods")
        return value

    @field_validator("drawdown_episodes")
    @classmethod
    def validate_episode_order(
        cls, value: tuple[DrawdownEpisode, ...] | None
    ) -> tuple[DrawdownEpisode, ...] | None:
        keys = [(row.drawdown, row.peak_date) for row in value or ()]
        if len({row.peak_date for row in value or ()}) != len(keys) or any(
            left > right for left, right in zip(keys, keys[1:], strict=False)
        ):
            raise ValueError("drawdown episodes must be ranked by depth and peak date")
        return value

    @field_validator("unavailable_reasons", mode="after")
    @classmethod
    def freeze_reasons(cls, value: Mapping[str, str]) -> FrozenMap:
        return freeze_mapping(value)

    @field_serializer("unavailable_reasons")
    def serialize_reasons(self, value: Mapping[str, str]) -> dict[str, str]:
        return dict(value)

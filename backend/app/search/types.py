"""Search result contracts with explicit candidate and role identities."""

from collections.abc import Mapping

from pydantic import Field, field_serializer, field_validator, model_validator

from app.catalog.presets import SearchDimension
from app.domain.contracts import MetricSummary, ResultRole
from app.domain.immutability import FrozenMap, freeze_mapping, thaw_value
from app.domain.status import Diagnostic, DomainModel, StrategyStatus


class SearchCandidate(DomainModel):
    """One stable candidate row, including failed or unavailable combinations."""

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
    def freeze_parameters(cls, value: Mapping[str, object]) -> FrozenMap:
        return freeze_mapping(value)

    @field_serializer("parameter_values")
    def serialize_parameters(self, value: Mapping[str, object]) -> object:
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
    """Complete candidate set and the stable ranking of valid outcomes."""

    strategy_id: str = Field(alias="strategyId", min_length=1)
    dimensions: tuple[SearchDimension, ...]
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
            raise ValueError("candidate sequence must be complete and one-based")
        if len(self.candidates) != self.total_candidate_count:
            raise ValueError("every search combination must have a result row")
        if len(set(self.ranked_candidate_ids)) != len(self.ranked_candidate_ids):
            raise ValueError("ranked candidate IDs must be unique")
        candidate_by_id = {
            candidate.candidate_id: candidate for candidate in self.candidates
        }
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
            raise ValueError(
                "ranking must include every completed candidate exactly once"
            )
        for candidate_id in self.ranked_candidate_ids:
            candidate = candidate_by_id.get(candidate_id)
            if (
                candidate is None
                or candidate.metrics is None
                or candidate.status
                not in {
                    StrategyStatus.COMPLETED,
                    StrategyStatus.COMPLETED_WITH_WARNING,
                }
            ):
                raise ValueError("only completed candidates may be ranked")
        return self


class SearchHeatmapSlice(DomainModel):
    """A two-dimensional view with the values of every other dimension frozen."""

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

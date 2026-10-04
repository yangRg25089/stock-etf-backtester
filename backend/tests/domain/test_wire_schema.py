"""Serialized mapping shape and aggregate states remain a generated contract."""

import pytest

from app.domain.conditions import ConditionLeaf
from app.domain.contracts import (
    FrozenStrategyInstance,
    SearchCandidate,
    SearchHeatmapSlice,
)
from app.domain.status import Diagnostic


@pytest.mark.parametrize(
    ("model", "field"),
    [
        (FrozenStrategyInstance, "params"),
        (SearchCandidate, "parameterValues"),
        (SearchHeatmapSlice, "fixedValues"),
        (ConditionLeaf, "params"),
        (Diagnostic, "details"),
    ],
)
def test_serialized_mapping_schema_requires_an_object(model, field):
    schema = model.model_json_schema(mode="serialization", by_alias=True)
    mapping = schema["properties"][field]
    assert mapping.get("type") == "object"
    assert mapping.get("additionalProperties") is True

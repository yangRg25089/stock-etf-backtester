"""Full results keep the model wire contract without a Python JSON copy tree."""

import json

import pytest
from pydantic import ValidationError

from app.api.responses import ModelJSONResponse
from app.runs.store import InMemoryRunStore
from tests.runs.test_temporary_store import record


def test_model_response_uses_native_json_and_preserves_aliases(monkeypatch):
    _, saved = record(InMemoryRunStore())
    expected = saved.model_dump(mode="json", by_alias=True)

    def forbidden_python_json(*args, **kwargs):
        pytest.fail("full results must not create a Python JSON serialization tree")

    monkeypatch.setattr(json, "dumps", forbidden_python_json)
    response = ModelJSONResponse(saved, status_code=202, headers={"Location": "/saved"})
    assert response.status_code == 202
    assert response.headers["Location"] == "/saved"
    assert response.headers["content-type"] == "application/json"
    assert json.loads(response.body) == expected
    assert "runId" in json.loads(response.body)


def test_model_response_still_checks_root_contract():
    _, saved = record(InMemoryRunStore())
    invalid = saved.model_copy(update={"selected_strategy_ids": ("wrong",)})
    with pytest.raises(ValidationError):
        ModelJSONResponse(invalid)

import asyncio
from collections.abc import Mapping
from hashlib import sha256
from json import dumps

import httpx
from fastapi.encoders import jsonable_encoder

from app.api.runs import RunSubmission
from app.api.types import RunProgress, RunResponse
from app.catalog.service import get_catalog
from app.domain.contracts import RunScope, RunSnapshot
from app.domain.immutability import thaw_value
from app.domain.status import StrategyStatus
from app.main import app
from app.runs.manager import RunManager
from app.runs.sqlite_store import SQLiteRunStore
from app.runs.store import IdempotencyConflict, InMemoryRunStore


class _FakeRunService:
    def __init__(self) -> None:
        self.submissions: list[RunSubmission] = []
        self.idempotency_keys: list[str] = []
        self.responses: dict[str, RunResponse] = {}

    def submit_run(
        self, submission: RunSubmission, *, idempotency_key: str
    ) -> RunResponse:
        self.submissions.append(submission)
        self.idempotency_keys.append(idempotency_key)
        run_id = f"run-{len(self.submissions)}"
        snapshot = RunSnapshot(
            runId=run_id,
            config=submission.config,
            catalogVersion=submission.catalog_version,
            dataFingerprint=f"fixture-data-{run_id}",
            engineVersion=submission.engine_version,
        )
        response = RunResponse(
            runId=run_id,
            status=StrategyStatus.QUEUED,
            selectedStrategyIds=submission.selected_strategy_ids,
            snapshot=snapshot,
            progress=RunProgress(
                completedStrategies=0,
                totalStrategies=len(submission.selected_strategy_ids),
            ),
        )
        self.responses[response.run_id] = response
        return response

    def get_run(self, run_id: str) -> RunResponse | None:
        return self.responses.get(run_id)

    def get_latest_run(self) -> RunResponse | None:
        if not self.responses:
            return None
        return list(self.responses.values())[-1]


class _ConflictingRunService(_FakeRunService):
    def submit_run(
        self, submission: RunSubmission, *, idempotency_key: str
    ) -> RunResponse:
        del submission, idempotency_key
        raise IdempotencyConflict("submission differs from the original request")


def _request(
    method: str,
    path: str,
    *,
    service: _FakeRunService | None = None,
    clear_service: bool = False,
    headers: dict[str, str] | None = None,
    json_body: object | None = None,
) -> httpx.Response:
    async def send() -> httpx.Response:
        previous = getattr(app.state, "run_service", None)
        had_previous = hasattr(app.state, "run_service")
        if service is not None:
            app.state.run_service = service
        elif clear_service and had_previous:
            del app.state.run_service
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(
                transport=transport, base_url="http://test"
            ) as client:
                return await client.request(
                    method,
                    path,
                    headers=headers,
                    json=jsonable_encoder(json_body),
                )
        finally:
            if service is not None or clear_service:
                if not had_previous:
                    if hasattr(app.state, "run_service"):
                        del app.state.run_service
                else:
                    app.state.run_service = previous

    return asyncio.run(send())


def _draft(
    strategies: list[dict[str, object]],
) -> dict[str, object]:
    return {
        "shared": {
            "run": {
                "symbol": "QQQ",
                "startDate": "2024-01-01",
                "endDate": "2024-01-03",
                "endMode": "fixed",
            },
            "contribution": {"day": 2, "amount": 100},
        },
        "strategies": strategies,
    }


def _strategy(
    strategy_id: str,
    *,
    enabled: bool = True,
    threshold: int = 25,
) -> dict[str, object]:
    params = thaw_value(get_catalog().preset("vix_dca").default_params)
    assert isinstance(params, Mapping)
    copied_params = dict(params)
    copied_params["vix.buyThreshold"] = threshold
    return {
        "id": strategy_id,
        "presetId": "vix_dca",
        "enabled": enabled,
        "params": copied_params,
    }


def test_catalog_and_generated_contract_version_are_available() -> None:
    catalog_response = _request("GET", "/api/v1/catalog")
    contract_response = _request("GET", "/api/v1/contracts")

    assert catalog_response.status_code == 200
    assert {preset["id"] for preset in catalog_response.json()["presets"]} == {
        "vix_dca",
        "composite_dca",
        "ma_trend",
        "ma_buy_only",
        "monthly_dca",
        "lump_sum",
        "grid_search",
    }
    assert catalog_response.json()["parameters"]
    assert contract_response.status_code == 200
    schema = app.openapi()
    expected = sha256(
        dumps(schema, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:16]
    assert contract_response.json() == {
        "apiVersion": "v1",
        "contractVersion": expected,
        "openapiUrl": "/openapi.json",
    }


def test_draft_validation_returns_registry_field_paths_and_data_needs() -> None:
    draft = _draft([_strategy("bad", threshold=999)])

    response = _request("POST", "/api/v1/config/validate", json_body={"draft": draft})

    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is False
    assert body["strategies"][0]["diagnostics"][0]["code"] == "invalid_parameter"
    assert body["strategies"][0]["diagnostics"][0]["fieldPath"] == (
        "strategies[0].params.vix.buyThreshold"
    )


def test_active_run_ignores_errors_from_unselected_instances() -> None:
    service = _FakeRunService()
    draft = _draft([_strategy("active"), _strategy("other", threshold=999)])

    response = _request(
        "POST",
        "/api/v1/runs",
        service=service,
        headers={"Idempotency-Key": "active-run-intent"},
        json_body={
            "draft": draft,
            "scope": "active",
            "activeStrategyId": "active",
        },
    )

    assert response.status_code == 202
    assert response.json()["status"] == "queued"
    assert response.json()["selectedStrategyIds"] == ["active"]
    assert response.json()["snapshot"]["dataFingerprint"] == "fixture-data-run-1"
    assert response.json()["snapshot"]["config"]["strategies"][0]["id"] == ("active")
    submission = service.submissions[0]
    assert submission.scope is RunScope.ACTIVE
    assert submission.config.strategies[0].id == "active"
    assert submission.strategy_validations[0].diagnostics == ()
    assert service.idempotency_keys == ["active-run-intent"]
    lookup = _request("GET", "/api/v1/runs/run-1", service=service)
    latest = _request("GET", "/api/v1/runs/latest", service=service)
    assert lookup.status_code == 200
    assert lookup.json()["runId"] == "run-1"
    assert latest.status_code == 200
    assert latest.json()["runId"] == "run-1"


def test_latest_run_is_null_when_no_run_has_been_saved() -> None:
    response = _request("GET", "/api/v1/runs/latest", service=_FakeRunService())

    assert response.status_code == 200
    assert response.json() is None


def test_default_local_manager_accepts_and_exposes_a_run_record() -> None:
    default_service = app.state.run_service
    assert isinstance(default_service, RunManager)
    assert isinstance(default_service._store, SQLiteRunStore)
    service = RunManager(store=InMemoryRunStore())

    accepted = _request(
        "POST",
        "/api/v1/runs",
        service=service,
        headers={"Idempotency-Key": "default-local-run"},
        json_body={
            "draft": _draft([_strategy("default-local")]),
            "scope": "active",
            "activeStrategyId": "default-local",
        },
    )
    assert accepted.status_code == 202
    run_id = accepted.json()["runId"]
    lookup = _request("GET", f"/api/v1/runs/{run_id}", service=service)

    assert accepted.json()["snapshot"]["dataFingerprint"]
    assert lookup.status_code == 200
    assert lookup.json()["runId"] == run_id


def test_all_enabled_submission_keeps_invalid_strategy_as_local_diagnostic() -> None:
    service = _FakeRunService()
    draft = _draft([_strategy("valid"), _strategy("invalid", threshold=999)])

    response = _request(
        "POST",
        "/api/v1/runs",
        service=service,
        headers={"Idempotency-Key": "all-run-intent"},
        json_body={"draft": draft, "scope": "all_enabled"},
    )

    assert response.status_code == 202
    assert response.json()["selectedStrategyIds"] == ["valid", "invalid"]
    submission = service.submissions[0]
    assert tuple(item.id for item in submission.config.strategies) == (
        "valid",
        "invalid",
    )
    assert submission.strategy_validations[1].diagnostics[0].field_path == (
        "strategies[1].params.vix.buyThreshold"
    )
    assert submission.catalog_version == get_catalog().version
    assert submission.engine_version


def test_run_scope_errors_and_missing_run_use_the_structured_error_envelope() -> None:
    service = _FakeRunService()
    no_enabled = _draft([_strategy("disabled", enabled=False)])

    empty_response = _request(
        "POST",
        "/api/v1/runs",
        service=service,
        headers={"Idempotency-Key": "empty-run-intent"},
        json_body={"draft": no_enabled, "scope": "all_enabled"},
    )
    missing_response = _request("GET", "/api/v1/runs/missing", service=service)

    assert empty_response.status_code == 422
    assert empty_response.json()["error"]["code"] == "no_enabled_strategies"
    assert missing_response.status_code == 404
    assert missing_response.json()["error"]["code"] == "run_not_found"


def test_idempotency_body_conflict_uses_stable_http_error_contract() -> None:
    response = _request(
        "POST",
        "/api/v1/runs",
        service=_ConflictingRunService(),
        headers={"Idempotency-Key": "reused-key"},
        json_body={
            "draft": _draft([_strategy("active")]),
            "scope": "active",
            "activeStrategyId": "active",
        },
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "idempotency_conflict"
    assert response.json()["error"]["messageKey"] == "api.errors.idempotency_conflict"


def test_active_run_requires_an_enabled_selected_instance() -> None:
    service = _FakeRunService()

    response = _request(
        "POST",
        "/api/v1/runs",
        service=service,
        headers={"Idempotency-Key": "disabled-run-intent"},
        json_body={
            "draft": _draft([_strategy("disabled", enabled=False)]),
            "scope": "active",
            "activeStrategyId": "disabled",
        },
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "active_strategy_not_enabled"
    assert service.submissions == []


def test_active_run_rejects_invalid_selected_config_with_field_path() -> None:
    service = _FakeRunService()

    response = _request(
        "POST",
        "/api/v1/runs",
        service=service,
        headers={"Idempotency-Key": "invalid-run-intent"},
        json_body={
            "draft": _draft([_strategy("active", threshold=999)]),
            "scope": "active",
            "activeStrategyId": "active",
        },
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "configuration_invalid"
    assert response.json()["error"]["diagnostics"][0]["fieldPath"] == (
        "strategies[0].params.vix.buyThreshold"
    )
    assert service.submissions == []


def test_request_shape_errors_use_the_structured_error_envelope() -> None:
    response = _request(
        "POST",
        "/api/v1/runs",
        headers={"Idempotency-Key": "bad-shape-intent"},
        json_body={"draft": {}, "scope": "unknown"},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"
    assert response.json()["error"]["diagnostics"][0]["fieldPath"] == "scope"


def test_run_submission_requires_an_idempotency_key() -> None:
    response = _request(
        "POST",
        "/api/v1/runs",
        json_body={
            "draft": _draft([_strategy("active")]),
            "scope": "active",
            "activeStrategyId": "active",
        },
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"
    assert response.json()["error"]["diagnostics"][0]["fieldPath"] == (
        "header.Idempotency-Key"
    )


def test_run_submission_reports_missing_orchestration_service_explicitly() -> None:
    response = _request(
        "POST",
        "/api/v1/runs",
        clear_service=True,
        headers={"Idempotency-Key": "missing-service-intent"},
        json_body={
            "draft": _draft([_strategy("active")]),
            "scope": "active",
            "activeStrategyId": "active",
        },
    )

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "run_service_unavailable"

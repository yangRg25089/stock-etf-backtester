"""Versioned draft validation and run submission/query endpoints."""

import asyncio
import json
from collections.abc import AsyncIterator, Mapping
from typing import Protocol, cast

from fastapi import APIRouter, Header, Request, Response
from fastapi.responses import StreamingResponse

from app.catalog.service import Catalog, get_catalog
from app.config.validation import (
    DraftValidationResult,
    StrategyValidationResult,
    validate_draft,
)
from app.domain.contracts import (
    FrozenRunConfig,
    FrozenStrategyInstance,
    InstrumentMetadata,
    RunScope,
    StrategyInstance,
    StrategyRun,
)
from app.domain.status import (
    Diagnostic,
    DiagnosticCode,
    DiagnosticSeverity,
    is_terminal,
)
from app.engine_version import ENGINE_VERSION
from app.runs.store import IdempotencyConflict, RunChange
from app.runs.types import RunProgressEvent, RunStrategySummary

from .errors import APIException
from .types import (
    APIErrorResponse,
    DraftValidationRequest,
    DraftValidationResponse,
    RunResponse,
    RunSubmission,
    RunSubmissionRequest,
)

router = APIRouter(prefix="/api/v1", tags=["runs"])


class RunService(Protocol):
    """Service that freezes the snapshot and atomically honors retry keys.

    Reusing a key with the same submission returns the original run. Reusing a
    key with a different submission must raise an idempotency conflict.
    """

    def submit_run(
        self, submission: RunSubmission, *, idempotency_key: str
    ) -> RunResponse: ...

    def get_run(self, run_id: str) -> RunResponse | None: ...

    def stop_run(self, run_id: str) -> RunResponse | None: ...

    def get_candidate(self, run_id: str, candidate_id: str) -> StrategyRun | None: ...

    def instrument_metadata(self, symbol: str) -> InstrumentMetadata: ...

    def get_active_run(self) -> RunResponse | None: ...

    def wait_for_run_change(
        self, run_id: str, after_version: int, timeout_seconds: float
    ) -> RunChange | None: ...


@router.post(
    "/config/validate",
    response_model=DraftValidationResponse,
    responses={422: {"model": APIErrorResponse}},
)
def validate_configuration(
    request: DraftValidationRequest,
) -> DraftValidationResponse:
    """Return catalog-backed diagnostics without rejecting editable drafts."""

    result = validate_draft(request.draft)
    return _validation_response(result)


@router.post(
    "/runs",
    response_model=RunResponse,
    status_code=202,
    responses={
        422: {"model": APIErrorResponse},
        409: {"model": APIErrorResponse},
        503: {"model": APIErrorResponse},
    },
)
def submit_run(
    body: RunSubmissionRequest,
    response: Response,
    request: Request,
    idempotency_key: str = Header(
        alias="Idempotency-Key", min_length=1, max_length=128
    ),
) -> RunResponse:
    """Freeze the selected strategy inputs and enqueue them with the run service."""

    catalog = get_catalog()
    submission = _build_submission(body, catalog)
    service = _run_service(request)
    try:
        accepted = service.submit_run(submission, idempotency_key=idempotency_key)
    except IdempotencyConflict as error:
        raise APIException(
            409,
            "idempotency_conflict",
            "api.errors.idempotency_conflict",
        ) from error
    response.headers["Location"] = f"/api/v1/runs/{accepted.run_id}"
    return accepted


@router.get(
    "/instruments/{symbol}",
    response_model=InstrumentMetadata,
)
def read_instrument(symbol: str, request: Request) -> InstrumentMetadata:
    return _run_service(request).instrument_metadata(symbol.strip().upper())


@router.get(
    "/runs/active",
    response_model=RunResponse | None,
    responses={503: {"model": APIErrorResponse}},
)
def read_active_run(request: Request) -> RunResponse | None:
    """Reconnect only a queued, loading or running job in this API process."""

    return _run_service(request).get_active_run()


@router.get(
    "/runs/{run_id}",
    response_model=RunResponse,
    responses={404: {"model": APIErrorResponse}, 503: {"model": APIErrorResponse}},
)
def read_run(run_id: str, request: Request) -> RunResponse:
    """Return the current immutable snapshot and progress for a submitted run."""

    record = _run_service(request).get_run(run_id)
    if record is None:
        raise APIException(
            404,
            "run_not_found",
            "api.errors.run_not_found",
        )
    return record


@router.post("/runs/{run_id}/stop", response_model=RunResponse)
def stop_run(run_id: str, request: Request) -> RunResponse:
    record = _run_service(request).stop_run(run_id)
    if record is None:
        raise APIException(404, "run_not_found", "api.errors.run_not_found")
    return record


@router.get("/runs/{run_id}/candidates/{candidate_id}", response_model=StrategyRun)
def read_candidate(run_id: str, candidate_id: str, request: Request) -> StrategyRun:
    candidate = _run_service(request).get_candidate(run_id, candidate_id)
    if candidate is None:
        raise APIException(404, "result_not_found", "api.errors.result_not_found")
    return candidate


@router.get(
    "/runs/{run_id}/events",
    response_class=StreamingResponse,
    response_model=RunProgressEvent,
    responses={
        200: {
            "content": {
                "text/event-stream": {
                    "schema": {
                        "type": "string",
                        "description": "SSE frames with RunProgressEvent JSON data.",
                    }
                }
            }
        },
        404: {"model": APIErrorResponse},
        503: {"model": APIErrorResponse},
    },
)
async def stream_run_events(run_id: str, request: Request) -> StreamingResponse:
    """Stream small run status updates; fetch the full result once at terminal."""

    service = _run_service(request)
    if service.get_run(run_id) is None:
        raise APIException(
            404,
            "run_not_found",
            "api.errors.run_not_found",
        )

    async def events() -> AsyncIterator[str]:
        version = 0
        while not await request.is_disconnected():
            change = await asyncio.to_thread(
                service.wait_for_run_change,
                run_id,
                version,
                15.0,
            )
            if change is None:
                yield ": keep-alive\n\n"
                continue
            version = change.version
            payload = _run_event_payload(change)
            event = "terminal" if is_terminal(change.response.status) else "progress"
            serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            yield (f"id: {change.version}\nevent: {event}\ndata: {serialized}\n\n")
            if event == "terminal":
                return

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


def _run_event_payload(change: RunChange) -> dict[str, object]:
    response = change.response
    strategy_runs = () if response.result is None else response.result.strategy_runs
    return RunProgressEvent(
        runId=response.run_id,
        status=response.status,
        progress=response.progress,
        strategyStatuses={item.id: item.status for item in strategy_runs},
        strategySummaries={
            item.id: RunStrategySummary(
                metrics=item.metrics, diagnostics=item.diagnostics
            )
            for item in strategy_runs
            if is_terminal(item.status)
        },
    ).model_dump(mode="json", by_alias=True)


def _build_submission(
    body: RunSubmissionRequest,
    catalog: Catalog,
) -> RunSubmission:
    validation = validate_draft(body.draft, catalog=catalog)
    if validation.shared_settings is None or validation.diagnostics:
        raise _configuration_error(validation.diagnostics)

    selected = _select_strategies(body, validation)
    selected_ids = tuple(item.strategy_id for item in selected)
    strategy_inputs = _raw_strategies(body.draft)
    frozen_strategies: list[FrozenStrategyInstance] = []
    for result in selected:
        if result.normalized is not None:
            frozen_strategies.append(result.normalized)
            continue
        raw = strategy_inputs.get(result.strategy_id)
        if raw is None:
            raise _configuration_error(result.diagnostics)
        frozen_strategies.append(
            FrozenStrategyInstance(
                id=raw.id,
                presetId=raw.preset_id,
                enabled=True,
                params=raw.params,
                rules=raw.rules,
                instanceNumber=raw.instance_number,
            )
        )

    config = FrozenRunConfig(
        shared=validation.shared_settings,
        strategies=tuple(frozen_strategies),
    )
    selected_set = set(selected_ids)
    requirements = tuple(
        requirement
        for requirement in validation.data_requirements
        if requirement.strategy_id in selected_set
    )
    return RunSubmission(
        config=config,
        scope=body.scope,
        selectedStrategyIds=selected_ids,
        catalogVersion=catalog.version,
        engineVersion=ENGINE_VERSION,
        strategyValidations=tuple(selected),
        dataRequirements=requirements,
    )


def _select_strategies(
    body: RunSubmissionRequest,
    validation: DraftValidationResult,
) -> tuple[StrategyValidationResult, ...]:
    by_id = {result.strategy_id: result for result in validation.strategies}
    if body.scope is RunScope.ACTIVE:
        if body.active_strategy_id is None:
            raise APIException(
                422,
                "active_strategy_required",
                "api.errors.active_strategy_required",
                (_scope_diagnostic("activeStrategyId", "required_value_missing"),),
            )
        active = by_id.get(body.active_strategy_id)
        if active is None:
            raise APIException(
                422,
                "active_strategy_not_found",
                "api.errors.active_strategy_not_found",
                (_scope_diagnostic("activeStrategyId", "unknown_strategy"),),
            )
        if active.diagnostics:
            raise _configuration_error(active.diagnostics)
        return (active,)

    selected = tuple(validation.strategies)
    if not selected:
        raise APIException(
            422,
            "no_strategies",
            "api.errors.no_strategies",
            (_scope_diagnostic("strategies", "no_strategies"),),
        )
    return selected


def _raw_strategies(draft: Mapping[str, object]) -> dict[str, StrategyInstance]:
    raw_strategies = draft.get("strategies", ())
    if not isinstance(raw_strategies, (list, tuple)):
        return {}
    parsed: dict[str, StrategyInstance] = {}
    for raw in raw_strategies:
        if not isinstance(raw, Mapping):
            continue
        try:
            strategy = StrategyInstance.model_validate(raw)
        except ValueError:
            continue
        parsed[strategy.id] = strategy
    return parsed


def _configuration_error(diagnostics: tuple[Diagnostic, ...]) -> APIException:
    return APIException(
        422,
        "configuration_invalid",
        "api.errors.configuration_invalid",
        diagnostics,
    )


def _scope_diagnostic(field_path: str, issue: str) -> Diagnostic:
    return Diagnostic(
        code=DiagnosticCode.INVALID_PARAMETER,
        severity=DiagnosticSeverity.ERROR,
        messageKey=f"diagnostics.configuration.{issue}",
        fieldPath=field_path,
    )


def _validation_response(
    result: DraftValidationResult,
) -> DraftValidationResponse:
    return DraftValidationResponse(
        valid=result.valid,
        sharedSettings=result.shared_settings,
        diagnostics=result.diagnostics,
        strategies=result.strategies,
        dataRequirements=result.data_requirements,
    )


def _run_service(request: Request) -> RunService:
    service = getattr(request.app.state, "run_service", None)
    if service is None:
        raise APIException(
            503,
            "run_service_unavailable",
            "api.errors.run_service_unavailable",
        )
    return cast(RunService, service)

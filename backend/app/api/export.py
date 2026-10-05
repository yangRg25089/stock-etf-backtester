"""CSV exports for a focused, already stored run result."""

from urllib.parse import quote

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response

from app.api.errors import APIException
from app.api.runs import _run_service
from app.api.types import APIErrorResponse
from app.export.csv import ExportError, ExportKind, export_csv

router = APIRouter(prefix="/api/v1", tags=["exports"])


@router.get(
    "/runs/{run_id}/export/{kind}",
    response_class=Response,
    responses={
        200: {
            "description": "CSV generated from the focused stored run result.",
            "content": {"text/csv": {"schema": {"type": "string"}}},
        },
        404: {"model": APIErrorResponse},
        409: {"model": APIErrorResponse},
        422: {"model": APIErrorResponse},
    },
)
def export_run_result(
    run_id: str,
    kind: ExportKind,
    request: Request,
    focused_result_id: str = Query(alias="focusedResultId", min_length=1),
) -> Response:
    """Return a stable CSV derived from the selected stored result."""

    run = _run_service(request).get_run(run_id)
    if run is None:
        raise APIException(
            404,
            "run_not_found",
            "api.errors.run_not_found",
        )
    if run.result is not None and not any(
        item.id == focused_result_id for item in run.result.strategy_runs
    ):
        candidate = _run_service(request).get_candidate(run_id, focused_result_id)
        if candidate is not None:
            run = run.model_copy(
                update={
                    "result": run.result.model_copy(
                        update={"strategy_runs": (candidate,)}
                    )
                }
            )
    try:
        content = export_csv(
            run,
            kind=kind,
            focused_result_id=focused_result_id,
        )
    except ExportError as error:
        raise APIException(
            error.status_code,
            error.code,
            error.message_key,
        ) from error

    filename = quote(
        f"{run.run_id}-{focused_result_id}-{kind.value}.csv",
        safe="",
    )
    return Response(
        content=content,
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )

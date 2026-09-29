"""Uniform HTTP error mapping for request, configuration, and run failures."""

from collections.abc import Mapping

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.domain.status import Diagnostic, DiagnosticCode, DiagnosticSeverity

from .types import APIError, APIErrorResponse


class APIException(Exception):
    def __init__(
        self,
        status_code: int,
        code: str,
        message_key: str,
        diagnostics: tuple[Diagnostic, ...] = (),
    ) -> None:
        super().__init__(message_key)
        self.status_code = status_code
        self.body = APIErrorResponse(
            error=APIError(
                code=code,
                messageKey=message_key,
                diagnostics=diagnostics,
            )
        )


async def api_exception_handler(
    _request: Request, exception: Exception
) -> JSONResponse:
    if not isinstance(exception, APIException):
        raise TypeError("API exception handler received an unexpected error")
    return JSONResponse(
        status_code=exception.status_code,
        content=exception.body.model_dump(mode="json", by_alias=True),
    )


async def request_validation_exception_handler(
    _request: Request, exception: Exception
) -> JSONResponse:
    if not isinstance(exception, RequestValidationError):
        raise TypeError("request validation handler received an unexpected error")
    diagnostics = tuple(
        Diagnostic(
            code=DiagnosticCode.INVALID_PARAMETER,
            severity=DiagnosticSeverity.ERROR,
            messageKey="diagnostics.configuration.invalid_request",
            fieldPath=_field_path(error),
            details={"issue": str(error.get("type", "invalid"))},
        )
        for error in exception.errors()
    )
    body = APIErrorResponse(
        error=APIError(
            code="invalid_request",
            messageKey="api.errors.invalid_request",
            diagnostics=diagnostics,
        )
    )
    return JSONResponse(
        status_code=422,
        content=body.model_dump(mode="json", by_alias=True),
    )


def _field_path(error: Mapping[str, object]) -> str:
    location = error.get("loc", ())
    if not isinstance(location, (tuple, list)):
        return "request"
    parts = tuple(str(part) for part in location if str(part) != "body")
    return ".".join(parts) or "request"

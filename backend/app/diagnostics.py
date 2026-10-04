"""Record private failure context and return safe public calculation diagnostics."""

import logging

from app.domain.status import Diagnostic, DiagnosticCode, DiagnosticSeverity

_LOGGER = logging.getLogger(__name__)


def calculation_diagnostic(
    error: Exception,
    *,
    stage: str,
    run_id: str | None = None,
    strategy_id: str | None = None,
    result_id: str | None = None,
    candidate_id: str | None = None,
) -> Diagnostic:
    details: dict[str, object] = {"stage": stage}
    for key, value in (
        ("runId", run_id),
        ("strategyId", strategy_id),
        ("resultId", result_id),
        ("candidateId", candidate_id),
    ):
        if value is not None:
            details[key] = value
    _LOGGER.warning(
        "Calculation stage failed",
        extra={
            "event": "run_calculation_stage_failed",
            "run_id": run_id,
            "stage": stage,
            "strategy_id": strategy_id,
            "result_id": result_id,
            "candidate_id": candidate_id,
            "exception_type": type(error).__name__,
        },
    )
    return Diagnostic(
        code=DiagnosticCode.CALCULATION_FAILED,
        severity=DiagnosticSeverity.ERROR,
        messageKey="diagnostics.calculation_failed",
        details=details,
    )

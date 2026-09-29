"""Configuration validation and stable diagnostic contracts."""

from .diagnostics import (
    ConfigurationIssue,
    invalid_parameter,
    provider_request_failed,
    required_data_unavailable,
)
from .validation import (
    DataKind,
    DataRequirement,
    DraftValidationResult,
    StrategyValidationResult,
    diagnose_capabilities,
    validate_draft,
)

__all__ = [
    "ConfigurationIssue",
    "DataKind",
    "DataRequirement",
    "DraftValidationResult",
    "StrategyValidationResult",
    "diagnose_capabilities",
    "invalid_parameter",
    "provider_request_failed",
    "required_data_unavailable",
    "validate_draft",
]

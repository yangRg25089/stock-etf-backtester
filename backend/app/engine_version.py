"""Calculation method versions frozen into every run snapshot."""

from app.ledger.engine import LEDGER_METHOD_VERSION
from app.metrics.engine import METRIC_METHOD_VERSION
from app.search.engine import SEARCH_METHOD_VERSION
from app.signals.evaluate import SIGNAL_METHOD_VERSION
from app.signals.indicators import INDICATOR_METHOD_VERSION

ENGINE_VERSION = "/".join(
    (
        INDICATOR_METHOD_VERSION,
        SIGNAL_METHOD_VERSION,
        LEDGER_METHOD_VERSION,
        METRIC_METHOD_VERSION,
        SEARCH_METHOD_VERSION,
    )
)

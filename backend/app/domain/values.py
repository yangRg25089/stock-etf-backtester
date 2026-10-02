"""Shared primitive constraints for catalog and provider-neutral contracts."""

from datetime import datetime
from typing import Annotated, Final

from pydantic import AwareDatetime, StringConstraints

SYMBOL_PATTERN: Final[str] = r"^[A-Za-z0-9.^=_-]{1,32}$"
Symbol = Annotated[str, StringConstraints(min_length=1, pattern=SYMBOL_PATTERN)]
AwareTimestamp = Annotated[datetime, AwareDatetime()]

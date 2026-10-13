"""Serialize validated models without an intermediate Python JSON object tree."""

from collections.abc import Mapping

from pydantic import BaseModel
from starlette.responses import Response


class ModelJSONResponse(Response):
    media_type = "application/json"

    def __init__(
        self,
        model: BaseModel,
        *,
        status_code: int = 200,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        validated = type(model).model_validate(model)
        super().__init__(
            validated.model_dump_json(by_alias=True),
            status_code=status_code,
            headers=headers,
        )

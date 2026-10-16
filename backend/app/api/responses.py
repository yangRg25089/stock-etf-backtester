"""Serialize validated models without an intermediate Python JSON object tree."""

from collections.abc import Generator, Mapping

from pydantic import BaseModel
from starlette.responses import Response, StreamingResponse
from starlette.types import Receive, Scope, Send


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


class StreamingJSONResponse(StreamingResponse):
    """Release the captured snapshot on completion, disconnect or send failure."""

    def __init__(self, chunks: Generator[bytes, None, None]) -> None:
        self._chunks = chunks
        super().__init__(chunks, media_type="application/json")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            self._chunks.close()

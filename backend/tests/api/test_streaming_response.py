"""Large saved JSON keeps its bytes and frees its snapshot on disconnect."""

import asyncio

import pytest
from starlette.requests import ClientDisconnect


@pytest.mark.parametrize("spec_version", ["2.0", "2.4"])
def test_streaming_json_closes_source_when_client_disconnects(spec_version):
    from app.api.responses import StreamingJSONResponse

    closed = []

    def chunks():
        try:
            yield b'{"status":'
            yield b'"completed"}'
        finally:
            closed.append(True)

    async def exercise():
        sent_body = asyncio.Event()

        async def send(message):
            if message["type"] == "http.response.body":
                sent_body.set()
                if spec_version == "2.4":
                    raise OSError("fixture disconnected")
                await asyncio.Event().wait()

        async def receive():
            await sent_body.wait()
            return {"type": "http.disconnect"}

        response = StreamingJSONResponse(chunks())
        assert response.headers["content-type"] == "application/json"
        scope = {"type": "http", "asgi": {"spec_version": spec_version}}
        if spec_version == "2.4":
            with pytest.raises(ClientDisconnect):
                await response(scope, receive, send)
        else:
            await asyncio.wait_for(response(scope, receive, send), timeout=2)
        assert closed == [True]

    asyncio.run(exercise())


def test_full_result_http_stream_keeps_wire_bytes_and_missing_run_error():
    from app.runs.manager import RunManager
    from app.runs.temporary_store import TemporaryRunStore
    from tests.api.test_api import _request
    from tests.runs.test_temporary_store import record

    store = TemporaryRunStore()
    manager = RunManager(store=store)
    try:
        claim, saved = record(store, params={"unicode": "中文🙂" * 30_000})
        response = _request("GET", f"/api/v1/runs/{claim.run_id}", service=manager)
        assert response.status_code == 200
        assert response.content == saved.model_dump_json(by_alias=True).encode()
        assert response.headers["content-type"] == "application/json"
        missing = _request("GET", "/api/v1/runs/missing", service=manager)
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "run_not_found"
    finally:
        manager.shutdown()
        store.close()


def test_terminal_stop_reuses_saved_wire_without_serializing_result_again(monkeypatch):
    from app.domain.status import StrategyStatus
    from app.runs.manager import RunManager
    from app.runs.temporary_store import TemporaryRunStore
    from app.runs.types import RunResponse
    from tests.api.test_api import _request
    from tests.runs.test_temporary_store import record

    store = TemporaryRunStore()
    manager = RunManager(store=store)
    try:
        claim, original = record(store, params={"padding": "x" * 200_000})
        saved = original.model_copy(update={"status": StrategyStatus.FAILED})
        store.update(saved)
        expected = saved.model_dump_json(by_alias=True).encode()

        def forbidden_dump(*args, **kwargs):
            pytest.fail("terminal Stop must stream the saved wire snapshot")

        monkeypatch.setattr(RunResponse, "model_dump_json", forbidden_dump)
        response = _request(
            "POST", f"/api/v1/runs/{claim.run_id}/stop", service=manager
        )
        assert response.status_code == 200
        assert response.content == expected
    finally:
        manager.shutdown()
        store.close()

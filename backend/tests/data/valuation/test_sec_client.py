"""SEC transport keeps credentials local and payloads outside the domain."""

from io import BytesIO
from urllib.error import HTTPError

import pytest

from app.data.providers.sec_client import SecEdgarClient, SecRequestError


class Response(BytesIO):
    status = 200


def test_exact_numbers_cache_and_declared_contact() -> None:
    requests = []

    def fetch(request, *, timeout):
        requests.append(request)
        assert timeout <= 20
        return Response(b'{"cik": 789019, "value": 0.123456789012345678901}')

    client = SecEdgarClient(
        user_agent="Local Backtester user@example.com", urlopen_fn=fetch
    )
    first = client.company_facts("0000789019")
    first["cik"] = 0
    second = client.company_facts("0000789019")
    assert second["cik"] == 789019
    assert str(second["value"]) == "0.123456789012345678901"
    assert len(requests) == 1
    assert requests[0].get_header("User-agent") == "Local Backtester user@example.com"
    assert (
        requests[0].full_url
        == "https://data.sec.gov/api/xbrl/companyfacts/CIK0000789019.json"
    )


def test_failure_contains_no_contact_or_response_body() -> None:
    contact = "Local Backtester private@example.com"

    def fetch(request, *, timeout):
        raise HTTPError(request.full_url, 403, "private body", {}, None)

    client = SecEdgarClient(user_agent=contact, urlopen_fn=fetch)
    with pytest.raises(SecRequestError) as error:
        client.company_facts("0000789019")
    assert error.value.reason == "http_error"
    assert contact not in str(error.value)
    assert "private body" not in str(error.value)


@pytest.mark.parametrize("cik", ["../etc", "789019", "12345678901", "000078901x"])
def test_bad_issuer_cannot_change_request_target(cik: str) -> None:
    client = SecEdgarClient(user_agent="Local Backtester user@example.com")
    with pytest.raises(ValueError):
        client.company_facts(cik)


@pytest.mark.parametrize("name", ["../secret", "https://example.com", "a/b.htm"])
def test_bad_filing_document_cannot_change_request_target(name: str) -> None:
    client = SecEdgarClient(user_agent="Local Backtester user@example.com")
    with pytest.raises(ValueError):
        client.filing_document("0000789019", "0001193125-26-323660", name)


@pytest.mark.parametrize("body", [b"[]", b"not json", b"{}" * 9_000_000])
def test_malformed_or_oversized_json_is_a_provider_error(body: bytes) -> None:
    client = SecEdgarClient(
        user_agent="Local Backtester user@example.com",
        urlopen_fn=lambda request, timeout: Response(body),
    )
    with pytest.raises(SecRequestError):
        client.company_facts("0000789019")


def test_missing_contact_stops_before_network(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("SEC_USER_AGENT", raising=False)
    called = []
    client = SecEdgarClient(
        contact_file=tmp_path / "missing",
        urlopen_fn=lambda *args, **kwargs: called.append(args),
    )
    with pytest.raises(SecRequestError) as error:
        client.company_facts("0000789019")
    assert error.value.reason == "contact_required"
    assert not called

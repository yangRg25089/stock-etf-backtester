from datetime import UTC, date, datetime

import pytest

from app.data.providers.sec_evidence import parse_filings, verified_common_class


def document(title="Common stock, par value $0.001", symbol="ABC", extra=""):
    return (
        '<ix:nonNumeric name="dei:Security12bTitle" contextRef="common">'
        f'{title}</ix:nonNumeric><ix:nonNumeric name="dei:TradingSymbol" '
        f'contextRef="common">{symbol}</ix:nonNumeric>{extra}'
    )


def test_registered_class_requires_matching_common_security_not_a_bond_ticker():
    bond = (
        '<ix:nonNumeric name="dei:Security12bTitle" contextRef="bond">'
        "3.25% Notes due 2030</ix:nonNumeric>"
        '<ix:nonNumeric name="dei:TradingSymbol" contextRef="bond">'
        "ABC</ix:nonNumeric>"
    )
    assert (
        verified_common_class(document(extra=bond), symbol="ABC", cik="0000123456")
        == "sec:0000123456:common:ABC"
    )
    for source in [
        document(symbol="OTHER"),
        bond,
        "",
        document(title="Preferred stock"),
    ]:
        assert verified_common_class(source, symbol="ABC", cik="0000123456") is None
    two_classes = document(
        extra=document(title="Class B Common stock", symbol="ABCB").replace(
            'contextRef="common"', 'contextRef="second"'
        )
    )
    assert verified_common_class(two_classes, symbol="ABC", cik="0000123456") is None


def test_inline_class_handles_nested_text_and_refuses_conflicting_context_values():
    assert (
        verified_common_class(
            document(title="<span>Common</span> stock"), symbol="ABC", cik="0000123456"
        )
        is not None
    )
    assert (
        verified_common_class(
            document() + document(symbol="OTHER"), symbol="ABC", cik="0000123456"
        )
        is None
    )


def filings():
    return {
        "accessionNumber": ["0000123456-24-000001"],
        "filingDate": ["2024-02-15"],
        "acceptanceDateTime": ["2024-02-15T21:04:00Z"],
        "form": ["10-K"],
        "primaryDocument": ["abc-20231231.htm"],
    }


def test_named_or_unlisted_classes_cannot_be_treated_as_single_common_class():
    for extra in (
        '<xbrldi:explicitMember dimension="us-gaap:StatementClassOfStockAxis">'
        "abc:ClassBCommonStockMember</xbrldi:explicitMember>",
        '<xbrldi:explicitMember dimension="abc:ShareClassAxis">'
        "abc:ClassBMember</xbrldi:explicitMember>",
    ):
        assert (
            verified_common_class(document(extra=extra), symbol="ABC", cik="0000123456")
            is None
        )
    assert (
        verified_common_class(
            document(title="Class A Common Stock"), symbol="ABC", cik="0000123456"
        )
        is None
    )


def test_registered_notes_are_not_extra_equity_classes():
    resources = (
        '<xbrli:context id="bond"><xbrldi:explicitMember '
        'dimension="us-gaap:StatementClassOfStockAxis">'
        "abc:NotesDue2030Member</xbrldi:explicitMember></xbrli:context>"
    )
    bond = (
        '<ix:nonNumeric name="dei:Security12bTitle" contextRef="bond">'
        "Notes due 2030</ix:nonNumeric>"
        '<ix:nonNumeric name="dei:TradingSymbol" contextRef="bond">'
        "ABC</ix:nonNumeric>"
    )
    assert (
        verified_common_class(
            resources + document(extra=bond), symbol="ABC", cik="0000123456"
        )
        is not None
    )


def test_submissions_metadata_preserves_acceptance_time_and_unknown_time():
    parsed = parse_filings(filings())
    row = parsed["0000123456-24-000001"]
    assert row.filed == date(2024, 2, 15)
    assert row.published_at == datetime(2024, 2, 15, 21, 4, tzinfo=UTC)
    value = filings()
    value["acceptanceDateTime"] = [""]
    assert parse_filings(value)[row.accession].published_at is None


def test_eps_disclosures_include_required_8k_but_not_unrelated_current_reports():
    value = filings()
    value["form"] = ["8-K"]
    accession = value["accessionNumber"][0]
    assert not parse_filings(value)
    assert accession in parse_filings(value, financial_accessions={accession})


def test_old_legacy_document_does_not_invalidate_a_later_requested_period():
    value = filings()
    for key, legacy in (
        ("accessionNumber", "0000123456-99-000001"),
        ("filingDate", "1999-02-15"),
        ("acceptanceDateTime", ""),
        ("form", "10-K"),
        ("primaryDocument", ""),
    ):
        value[key].append(legacy)
    assert list(parse_filings(value, filed_from=date(2023, 1, 1))) == [
        "0000123456-24-000001"
    ]
    with pytest.raises(ValueError, match="primary document"):
        parse_filings(value)


@pytest.mark.parametrize(
    "change",
    [
        lambda value: value.update(form=[]),
        lambda value: value.update(filingDate=["2024-02-30"]),
        lambda value: value.update(acceptanceDateTime=["2024-02-15T21:04:00"]),
        lambda value: value.update(primaryDocument=["../../private.htm"]),
        lambda value: value.update(accessionNumber=["invalid"]),
    ],
)
def test_malformed_metadata_is_rejected(change):
    value = filings()
    change(value)
    with pytest.raises(ValueError):
        parse_filings(value)

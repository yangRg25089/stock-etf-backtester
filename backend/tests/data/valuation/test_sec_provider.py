from __future__ import annotations

from collections.abc import Iterator, Mapping
from datetime import UTC, date, datetime
from decimal import Decimal

import pytest

from app.data.providers.sec import SecCompanyFactsAdapter, SecNportAdapter
from app.domain.valuation import ETFProfile, SecurityIdentity


def _company_facts_payload() -> dict[str, object]:
    return {
        "cik": 123456,
        "entityName": "Example Corp",
        "facts": {
            "us-gaap": {
                "EarningsPerShareDiluted": {
                    "label": "Earnings Per Share, Diluted",
                    "units": {
                        "USD / shares": [
                            {
                                "start": "2023-10-01",
                                "end": "2023-12-31",
                                "val": 1.25,
                                "accn": "0000123456-24-000001",
                                "form": "10-K",
                                "filed": "2024-02-15",
                                "fy": 2023,
                                "fp": "FY",
                                "frame": "CY2023Q4",
                            },
                            {
                                "start": "2023-01-01",
                                "end": "2023-12-31",
                                "val": 4.5,
                                "accn": "0000123456-24-000001",
                                "form": "10-K",
                                "filed": "2024-02-15",
                                "fy": 2023,
                                "fp": "FY",
                                "frame": "CY2023",
                            },
                        ]
                    },
                },
                "EarningsPerShareBasic": {
                    "units": {
                        "USD / shares": [
                            {
                                "start": "2023-01-01",
                                "end": "2023-12-31",
                                "val": 9.0,
                                "accn": "0000123456-24-000001",
                                "form": "10-K",
                                "filed": "2024-02-15",
                            }
                        ]
                    }
                },
            },
            "custom": {"IssuerDilutedEPS": {"units": {"USD / shares": [{"val": 999}]}}},
        },
    }


def test_companyfacts_adapter_normalizes_standard_diluted_eps_and_provenance() -> None:
    accession = "0000123456-24-000001"
    published_at = datetime(2024, 2, 15, 21, 3, tzinfo=UTC)

    facts = SecCompanyFactsAdapter(data_version="sec-companyfacts-fixture-1").parse(
        _company_facts_payload(),
        symbol="ABC",
        expected_cik="0000123456",
        published_at_by_accession={accession: published_at},
        split_basis_by_accession={accession: "post-split"},
        verified_stock_class_by_accession={accession: "ABC:common"},
    )

    assert len(facts) == 2
    assert {fact.concept for fact in facts} == {"us-gaap:EarningsPerShareDiluted"}
    assert {fact.value for fact in facts} == {Decimal("1.25"), Decimal("4.5")}
    assert all(fact.currency == "USD" for fact in facts)
    assert all(fact.published_at == published_at for fact in facts)
    assert all(fact.split_basis == "post-split" for fact in facts)
    assert all(fact.stock_class_id == "ABC:common" for fact in facts)
    assert all(fact.source == "sec:companyfacts" for fact in facts)
    assert all(fact.source_version == "sec-companyfacts-fixture-1" for fact in facts)


def test_companyfacts_adapter_does_not_infer_share_class_from_symbol() -> None:
    facts = SecCompanyFactsAdapter().parse(
        _company_facts_payload(),
        symbol="ABC",
        expected_cik="0000123456",
    )

    assert facts
    assert all(fact.stock_class_id is None for fact in facts)


def test_companyfacts_adapter_fails_closed_on_wrong_cik_malformed_rows_and_size() -> (
    None
):
    adapter = SecCompanyFactsAdapter(max_fact_rows=1)

    with pytest.raises(ValueError, match="CIK"):
        adapter.parse(
            _company_facts_payload(),
            symbol="ABC",
            expected_cik="0000000001",
        )

    with pytest.raises(ValueError, match="row limit"):
        adapter.parse(
            _company_facts_payload(),
            symbol="ABC",
            expected_cik="0000123456",
        )

    payload = _company_facts_payload()
    facts = payload["facts"]
    assert isinstance(facts, dict)
    taxonomy = facts["us-gaap"]
    assert isinstance(taxonomy, dict)
    diluted = taxonomy["EarningsPerShareDiluted"]
    assert isinstance(diluted, dict)
    units = diluted["units"]
    assert isinstance(units, dict)
    unit_rows = units["USD / shares"]
    assert isinstance(unit_rows, list)
    malformed_row = dict(unit_rows[0])
    malformed_row["val"] = "NaN"
    unit_rows[0] = malformed_row

    with pytest.raises(ValueError, match="finite"):
        SecCompanyFactsAdapter().parse(
            payload,
            symbol="ABC",
            expected_cik="0000123456",
        )


def _profile(**updates: object) -> ETFProfile:
    values: dict[str, object] = {
        "instrumentType": "etf",
        "physical": True,
        "longOnly": True,
        "leveraged": False,
        "inverse": False,
        "synthetic": False,
        "fundOfFunds": False,
        "hasDerivatives": False,
    }
    values.update(updates)
    return ETFProfile.model_validate(values)


def test_nport_adapter_joins_as_filed_rows_by_accession_and_identifier() -> None:
    accession = "0000123456-24-000002"
    submission = {
        "ACCESSION_NUMBER": accession,
        "FILING_DATE": "2024-05-01",
        "SUB_TYPE": "NPORT-P/A",
        "REPORT_DATE": "2024-03-31",
    }
    holdings = [
        {
            "ACCESSION_NUMBER": accession,
            "HOLDING_ID": "1",
            "ISSUER_NAME": "Example Corp",
            "ISSUER_CUSIP": "123456789",
            "PERCENTAGE": "75",
            "ASSET_CAT": "EC",
            "ISSUER_TYPE": "CORP",
            "PAYOFF_PROFILE": "Long",
            "CURRENCY_CODE": "USD",
        },
        {
            "ACCESSION_NUMBER": accession,
            "HOLDING_ID": "2",
            "ISSUER_NAME": "Treasury",
            "PERCENTAGE": "25",
            "ASSET_CAT": "DBT",
            "ISSUER_TYPE": "UST",
            "PAYOFF_PROFILE": "Long",
            "CURRENCY_CODE": "USD",
        },
        {
            "ACCESSION_NUMBER": "0000123456-24-999999",
            "HOLDING_ID": "3",
            "PERCENTAGE": "1",
            "ASSET_CAT": "EC",
            "ISSUER_TYPE": "CORP",
            "PAYOFF_PROFILE": "Long",
        },
    ]
    identifiers = [
        {"HOLDING_ID": "1", "IDENTIFIER_TICKER": "ABC"},
        {"HOLDING_ID": "2", "IDENTIFIER_TICKER": "UST"},
    ]

    snapshot = SecNportAdapter(data_version="sec-nport-fixture-1").parse(
        submission,
        holdings,
        identifiers,
        fund="FUND",
        capabilities=_profile(),
        published_at=datetime(2024, 5, 1, 20, 0, tzinfo=UTC),
        security_identities={
            "1": SecurityIdentity(
                symbol="ABC",
                cik="0000123456",
                cusip="123456789",
                stockClassId="ABC:common",
            )
        },
    )

    assert snapshot.form == "NPORT-P/A"
    assert snapshot.report_date == date(2024, 3, 31)
    assert snapshot.filed == date(2024, 5, 1)
    assert snapshot.published_at == datetime(2024, 5, 1, 20, 0, tzinfo=UTC)
    assert snapshot.accession == accession
    assert snapshot.source == "sec:nport"
    assert snapshot.source_version == "sec-nport-fixture-1"
    assert len(snapshot.holdings) == 2
    common_equity = snapshot.holdings[0]
    assert common_equity.asset_type == "equity-common"
    assert common_equity.issuer_type == "corporate"
    assert common_equity.is_direct_common_equity
    assert common_equity.identity_matched is True
    assert common_equity.stock_class_id == "ABC:common"
    assert common_equity.symbol == "ABC"
    assert common_equity.cik == "0000123456"
    assert common_equity.weight == Decimal("0.75")
    assert snapshot.holdings[1].asset_type == "debt"
    assert snapshot.holdings[1].weight == Decimal("0.25")
    assert snapshot.holdings[1].is_direct_common_equity is False


def test_nport_adapter_preserves_zero_percentage_for_matched_holding() -> None:
    accession = "0000123456-24-000007"
    submission = {
        "ACCESSION_NUMBER": accession,
        "FILING_DATE": "2024-05-01",
        "SUB_TYPE": "NPORT-P",
        "REPORT_DATE": "2024-03-31",
    }
    holding = {
        "ACCESSION_NUMBER": accession,
        "HOLDING_ID": "1",
        "ISSUER_CUSIP": "123456789",
        "PERCENTAGE": "0",
        "ASSET_CAT": "EC",
        "ISSUER_TYPE": "CORP",
        "PAYOFF_PROFILE": "Long",
    }

    snapshot = SecNportAdapter().parse(
        submission,
        [holding],
        [],
        fund="FUND",
        capabilities=_profile(),
        security_identities={
            "1": SecurityIdentity(
                symbol="ABC",
                cik="0000123456",
                cusip="123456789",
                stockClassId="ABC:common",
            )
        },
    )

    normalized = snapshot.holdings[0]
    assert normalized.identity_matched is True
    assert normalized.weight == Decimal("0")


def test_nport_adapter_rejects_unmatched_identity_and_detects_derivatives() -> None:
    accession = "0000123456-24-000003"
    submission = {
        "ACCESSION_NUMBER": accession,
        "FILING_DATE": "2024-05-01",
        "SUB_TYPE": "NPORT-P",
        "REPORT_DATE": "2024-03-31",
    }
    holding = {
        "ACCESSION_NUMBER": accession,
        "HOLDING_ID": "1",
        "ISSUER_CUSIP": "123456789",
        "PERCENTAGE": "1",
        "ASSET_CAT": "DE",
        "ISSUER_TYPE": "CORP",
        "PAYOFF_PROFILE": "N/A",
    }

    snapshot = SecNportAdapter().parse(
        submission,
        [holding],
        [],
        fund="FUND",
        capabilities=_profile(),
        security_identities={
            "1": SecurityIdentity(symbol="ABC", cik="0000123456", cusip="999999999")
        },
    )

    assert snapshot.holdings[0].identity_matched is False
    assert snapshot.holdings[0].symbol is None
    assert snapshot.capabilities.has_derivatives is True
    assert snapshot.capabilities.supports_equity_pe is False


def test_nport_identity_does_not_ignore_conflicting_identifiers() -> None:
    accession = "0000123456-24-000006"
    submission = {
        "ACCESSION_NUMBER": accession,
        "FILING_DATE": "2024-05-01",
        "SUB_TYPE": "NPORT-P",
        "REPORT_DATE": "2024-03-31",
    }
    holding = {
        "ACCESSION_NUMBER": accession,
        "HOLDING_ID": "1",
        "ISSUER_CUSIP": "123456789",
        "PERCENTAGE": "1",
        "ASSET_CAT": "EC",
        "ISSUER_TYPE": "CORP",
        "PAYOFF_PROFILE": "Long",
    }
    identifiers = [
        {"HOLDING_ID": "1", "IDENTIFIER_ISIN": "US1234567890"},
    ]

    snapshot = SecNportAdapter().parse(
        submission,
        [holding],
        identifiers,
        fund="FUND",
        capabilities=_profile(),
        security_identities={
            "1": SecurityIdentity(
                symbol="ABC",
                cik="0000123456",
                cusip="999999999",
                isin="US1234567890",
            )
        },
    )

    assert snapshot.holdings[0].identity_matched is False
    assert snapshot.holdings[0].symbol is None
    assert snapshot.holdings[0].cik is None


def test_nport_adapter_preserves_signed_nav_percentage_and_rejects_short_fund() -> None:
    accession = "0000123456-24-000005"
    submission = {
        "ACCESSION_NUMBER": accession,
        "FILING_DATE": "2024-05-01",
        "SUB_TYPE": "NPORT-P",
        "REPORT_DATE": "2024-03-31",
    }
    holding = {
        "ACCESSION_NUMBER": accession,
        "HOLDING_ID": "1",
        "PERCENTAGE": "-0.25",
        "ASSET_CAT": "DE",
        "ISSUER_TYPE": "OTHER",
        "PAYOFF_PROFILE": "N/A",
    }

    snapshot = SecNportAdapter().parse(
        submission,
        [holding],
        [],
        fund="FUND",
        capabilities=_profile(),
    )

    assert snapshot.holdings[0].weight == Decimal("-0.0025")
    assert snapshot.capabilities.has_derivatives is True
    assert snapshot.capabilities.supports_equity_pe is False


def test_nport_adapter_rejects_unrecognized_or_oversized_remote_payloads() -> None:
    accession = "0000123456-24-000004"
    submission = {
        "ACCESSION_NUMBER": accession,
        "FILING_DATE": "2024-05-01",
        "SUB_TYPE": "NPORT-P",
        "REPORT_DATE": "2024-03-31",
    }
    rows = [
        {
            "ACCESSION_NUMBER": accession,
            "HOLDING_ID": "1",
            "PERCENTAGE": "1",
            "ASSET_CAT": "EC",
            "ISSUER_TYPE": "CORP",
        }
    ]

    with pytest.raises(ValueError, match="filing type"):
        SecNportAdapter().parse(
            {**submission, "SUB_TYPE": "NPORT-NT"},
            rows,
            [],
            fund="FUND",
            capabilities=_profile(),
        )

    with pytest.raises(ValueError, match="row limit"):
        SecNportAdapter(max_holding_rows=0).parse(
            submission,
            rows,
            [],
            fund="FUND",
            capabilities=_profile(),
        )

    consumed: list[int] = []

    def oversized_rows() -> Iterator[Mapping[str, object]]:
        for index in range(3):
            consumed.append(index)
            yield rows[0]

    with pytest.raises(ValueError, match="row limit"):
        SecNportAdapter(max_holding_rows=1).parse(
            submission,
            oversized_rows(),
            [],
            fund="FUND",
            capabilities=_profile(),
        )
    assert len(consumed) == 2

    with pytest.raises(ValueError, match="percentage"):
        malformed = dict(rows[0], PERCENTAGE="Infinity")
        SecNportAdapter().parse(
            submission,
            [malformed],
            [],
            fund="FUND",
            capabilities=_profile(),
        )

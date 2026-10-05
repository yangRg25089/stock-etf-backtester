"""Native SEC data must parse without treating unsupported holdings as missing.

This is a source-normalization gate, not positive ETF P/E acceptance. The native
filing has derivatives and its ETF registration remains unverified here.
"""

from datetime import date, datetime
from decimal import Decimal
from xml.etree import ElementTree as ET

from app.data.providers.sec_client import SecEdgarClient
from app.data.providers.sec_evidence import FilingEvidence
from app.data.providers.sec_funds import FundIdentity, nport_xml


def test_real_qqq_native_nport_retains_conditional_issuers_and_publication():
    client = SecEdgarClient()
    # Identity is from this historical filing, not today's fund ticker table.
    fund = FundIdentity("0001067839", "S000101292", "C000271435", "QQQ")
    accession = "0001067839-26-000030"
    recent = client.submissions(fund.cik)["filings"]["recent"]
    index = recent["accessionNumber"].index(accession)
    filing = FilingEvidence(
        accession,
        date.fromisoformat(recent["filingDate"][index]),
        datetime.fromisoformat(recent["acceptanceDateTime"][index]),
        recent["form"][index],
        "primary_doc.xml",
    )
    document = client.filing_document(fund.cik, accession, filing.document)
    snapshot = nport_xml(document, fund=fund, filing=filing, registered_etf=False)
    assert snapshot is not None
    assert snapshot.report_date == date(2026, 6, 30)
    assert snapshot.filed == date(2026, 8, 28)
    assert snapshot.published_at == filing.published_at
    assert snapshot.accession == accession
    ns = {"n": "http://www.sec.gov/edgar/nport"}
    positions = ET.fromstring(document).findall(
        "n:formData/n:invstOrSecs/n:invstOrSec", ns
    )
    assert len(snapshot.holdings) == len(positions) == 105
    for holding, position in zip(snapshot.holdings, positions, strict=True):
        assert (
            holding.weight
            == Decimal(position.findtext("n:pctVal", namespaces=ns)) / 100
        )
        assert holding.cusip == position.findtext("n:cusip", namespaces=ns)
        assert not holding.identity_matched
    conditional = [
        holding
        for holding, position in zip(snapshot.holdings, positions, strict=True)
        if position.find("n:issuerConditional", ns) is not None
    ]
    assert len(conditional) == 1
    assert conditional[0].issuer_type == "unknown:other"
    assert conditional[0].asset_type == "derivative-equity"
    assert snapshot.capabilities.has_derivatives
    assert snapshot.capabilities.fund_of_funds
    assert snapshot.capabilities.physical is False
    assert not snapshot.capabilities.supports_equity_pe

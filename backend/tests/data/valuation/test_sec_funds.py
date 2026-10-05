"""Historical fund identity and native XML must carry verifiable evidence."""

from datetime import UTC, date, datetime

import pytest

from app.data.providers.sec_evidence import FilingEvidence
from app.data.providers.sec_funds import fund_identity, ncen_etf_identity, nport_xml


@pytest.mark.parametrize("field", ["weight", "borrowing"])
@pytest.mark.parametrize("value", ["invalid", "NaN", "Infinity", "1e5000", "0.1e-4096"])
def test_xml_numeric_evidence_has_bounded_value_errors(field, value):
    with pytest.raises(ValueError):
        nport_xml(
            portfolio(**{field: value}),
            fund=identity(),
            filing=evidence(),
            registered_etf=True,
        )


def identity():
    return fund_identity(
        {
            "fields": ["cik", "seriesId", "classId", "symbol"],
            "data": [[123456, "S000006409", "C000017595", "ABC"]],
        },
        "ABC",
    )


def census(ticker="ABC", kind="Exchange-Traded Fund"):
    return f'''<edgarSubmission xmlns="http://www.sec.gov/edgar/ncen">
    <headerData><filerInfo><filer><issuerCredentials><cik>0000123456</cik>
    </issuerCredentials></filer></filerInfo></headerData><formData>
    <managementInvestmentQuestion><mgmtInvSeriesId>S000006409</mgmtInvSeriesId>
    <sharesOutstandings><sharesOutstanding sharesOutstandingClassId="C000017595"
    sharesOutstandingTickerSymbol="{ticker}"/></sharesOutstandings>
    <fundTypes><fundType>{kind}</fundType></fundTypes></managementInvestmentQuestion>
    <exchangeTradedFund><etfSeriesId>S000006409</etfSeriesId><securityExchanges>
    <securityExchange fundsTickerSymbol="{ticker}" fundExchange="ARCX"/>
    </securityExchanges></exchangeTradedFund></formData></edgarSubmission>'''


def portfolio(asset="EC", payoff="Long", weight="99", borrowing="0"):
    return f"""<edgarSubmission xmlns="http://www.sec.gov/edgar/nport"><headerData>
    <submissionType>NPORT-P</submissionType><filerInfo><filer><issuerCredentials>
    <cik>0000123456</cik></issuerCredentials></filer><seriesClassInfo>
    <seriesId>S000006409</seriesId><classId>C000017595</classId></seriesClassInfo>
    </filerInfo></headerData><formData><genInfo><regCik>0000123456</regCik>
    <seriesId>S000006409</seriesId><repPdDate>2024-03-31</repPdDate></genInfo>
    <fundInfo><netAssets>100000</netAssets><amtPayOneYrBanksBorr>{borrowing}</amtPayOneYrBanksBorr>
    <amtPayOneYrCtrldComp>0</amtPayOneYrCtrldComp><amtPayOneYrOthAffil>0</amtPayOneYrOthAffil>
    <amtPayOneYrOther>0</amtPayOneYrOther><amtPayAftOneYrBanksBorr>0</amtPayAftOneYrBanksBorr>
    <amtPayAftOneYrCtrldComp>0</amtPayAftOneYrCtrldComp><amtPayAftOneYrOthAffil>0</amtPayAftOneYrOthAffil>
    <amtPayAftOneYrOther>0</amtPayAftOneYrOther><delayDeliv>0</delayDeliv>
    <standByCommit>0</standByCommit><liquidPref>0</liquidPref></fundInfo>
    <invstOrSecs><invstOrSec><cusip>594918104</cusip><identifiers>
    <isin value="US5949181045"/></identifiers><pctVal>{weight}</pctVal>
    <curCd>USD</curCd><payoffProfile>{payoff}</payoffProfile><assetCat>{asset}</assetCat>
    <issuerCat>CORP</issuerCat></invstOrSec></invstOrSecs></formData></edgarSubmission>"""


def evidence():
    return FilingEvidence(
        "0000123456-24-000001",
        date(2024, 5, 28),
        datetime(2024, 5, 28, 18, 12, tzinfo=UTC),
        "NPORT-P",
        "primary_doc.xml",
    )


def test_census_requires_historical_series_class_ticker_and_etf_registration():
    fund = identity()
    assert fund is not None and fund.cik == "0000123456"
    assert ncen_etf_identity(census(), fund)
    assert not ncen_etf_identity(census(ticker="OLD"), fund)
    assert not ncen_etf_identity(census(kind="Mutual Fund"), fund)
    assert identity() is not None


def test_nport_native_xml_reuses_flat_file_normalizer_and_publication_metadata():
    fund = identity()
    assert fund is not None
    parsed = nport_xml(portfolio(), fund=fund, filing=evidence(), registered_etf=True)
    assert parsed is not None and parsed.capabilities.supports_equity_pe
    assert parsed.report_date == date(2024, 3, 31)
    assert parsed.published_at == evidence().published_at
    assert str(parsed.holdings[0].weight) == "0.99"
    assert parsed.holdings[0].isin == "US5949181045"
    assert not parsed.holdings[0].identity_matched
    assert (
        nport_xml(
            portfolio().replace("S000006409", "S000006410"),
            fund=fund,
            filing=evidence(),
            registered_etf=True,
        )
        is None
    )


@pytest.mark.parametrize(
    "change",
    [
        {"asset": "DE"},
        {"payoff": "Short"},
        {"weight": "101"},
        {"borrowing": "10"},
    ],
)
def test_ineligible_portfolio_cannot_be_declared_unlevered_physical_equity(change):
    parsed = nport_xml(
        portfolio(**change), fund=identity(), filing=evidence(), registered_etf=True
    )
    assert parsed is not None and not parsed.capabilities.supports_equity_pe


def test_xml_rejects_entities_unknown_namespace_and_unconfirmed_etf():
    for source in [
        '<!DOCTYPE root [<!ENTITY secret SYSTEM "file:///private/file">]>'
        + portfolio(),
        portfolio().replace("http://www.sec.gov/edgar/nport", "https://other.invalid"),
    ]:
        with pytest.raises(ValueError):
            nport_xml(source, fund=identity(), filing=evidence(), registered_etf=True)
    parsed = nport_xml(
        portfolio(), fund=identity(), filing=evidence(), registered_etf=False
    )
    assert parsed is not None and not parsed.capabilities.supports_equity_pe


def test_fund_locator_never_guesses_an_ambiguous_or_invalid_class():
    source = {
        "fields": ["cik", "seriesId", "classId", "symbol"],
        "data": [
            [123456, "S000006409", "C000017595", "ABC"],
            [123456, "S000006410", "C000017596", "ABC"],
        ],
    }
    assert fund_identity(source, "ABC") is None
    source["data"] = [["../../private", "S000006409", "C000017595", "ABC"]]
    with pytest.raises(ValueError):
        fund_identity(source, "ABC")


def test_native_conditional_issuer_category_keeps_the_reported_unsupported_position():
    source = portfolio(asset="DE", payoff="N/A").replace(
        "<issuerCat>CORP</issuerCat>",
        '<issuerConditional issuerCat="OTHER" desc="N/A"/>',
    )
    parsed = nport_xml(source, fund=identity(), filing=evidence(), registered_etf=True)
    assert parsed is not None
    assert len(parsed.holdings) == 1
    assert parsed.holdings[0].issuer_type == "unknown:other"
    assert parsed.holdings[0].asset_type == "derivative-equity"
    assert parsed.capabilities.has_derivatives
    assert not parsed.capabilities.supports_equity_pe


@pytest.mark.parametrize(
    "category",
    [
        "",
        '<issuerConditional desc="N/A"/>',
        '<issuerConditional issuerCat="" desc="N/A"/>',
        '<issuerConditional issuerCat="CORP" desc="N/A"/>',
        '<issuerCat>CORP</issuerCat><issuerConditional issuerCat="OTHER" desc="N/A"/>',
        '<issuerConditional issuerCat="OTHER"/><issuerConditional issuerCat="OTHER"/>',
    ],
)
def test_native_issuer_category_rejects_missing_invalid_or_ambiguous_choices(category):
    source = portfolio().replace("<issuerCat>CORP</issuerCat>", category)
    with pytest.raises(ValueError):
        nport_xml(source, fund=identity(), filing=evidence(), registered_etf=True)

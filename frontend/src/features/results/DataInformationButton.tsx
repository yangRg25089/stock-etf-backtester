import { useEffect, useState } from "react";
import type { RunResponse } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { ResultDialog } from "../../shared/ui/ResultDialog";
import { DiagnosticList } from "../runs/DiagnosticList";
import { savedDataInformation } from "./dataInformation";
import { formatPercent } from "./format";

export function DataInformationButton({ run, locale, busy = false }: { run: RunResponse | null; locale: Locale; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [run?.runId, busy]);
  const information = open && run && !busy ? savedDataInformation(run) : null;
  return <>
    <button type="button" className="button icon-only-button saved-data-button" disabled={!run || busy}
      aria-label={translate(locale, "data.savedInfo")} title={translate(locale, "data.savedInfo")} aria-haspopup="dialog"
      aria-expanded={Boolean(information)} onClick={() => setOpen(true)}><span aria-hidden="true">ⓘ</span></button>
    {information && <ResultDialog title={`${information.symbol} · ${translate(locale, "data.savedInfo")}`} locale={locale} onClose={() => setOpen(false)}>
      <dl className="explanation-values saved-data-values">
        <div><dt>{translate(locale, "data.providers")}</dt><dd>{information.sources.map(source => source === "yahoo" ? "Yahoo Finance" : source).join(" · ") || "—"}</dd></div>
        <div><dt>{translate(locale, "data.currency")}</dt><dd>{information.currency ?? "—"}</dd></div>
        <div><dt>{translate(locale, "data.requestedPeriod")}</dt><dd>{information.requested.start} → {information.requested.end}</dd></div>
        <div><dt>{translate(locale, "data.actualPeriod")}</dt><dd>{information.actual ? `${information.actual.start} → ${information.actual.end}` : "—"}</dd></div>
        <div><dt>{translate(locale, "data.marketSessions")}</dt><dd>{information.sessions ?? "—"}</dd></div>
        <div><dt>{translate(locale, "data.simulationBasis")}</dt><dd>{information.sessions ? translate(locale, "data.simulationBasisValue") : "—"}</dd></div>
        <div><dt>{translate(locale, "data.valuationBasis")}</dt><dd>{information.sessions ? translate(locale, "data.valuationBasisValue") : "—"}</dd></div>
      </dl>
      {information.series.length > 0 && <section className="explanation-section">
        <h3>{translate(locale, "data.savedCoverage")}</h3>
        <ul className="saved-data-series">{information.series.map(series => <li key={`${series.kind}:${series.symbol}`}>
          <div><strong>{series.symbol ?? translate(locale, `conditions.${series.kind}`)}</strong>
            <span>{series.total === null ? "—" : `${formatPercent(series.available / series.total, locale)} · ${series.available}/${series.total}`}</span></div>
          <DiagnosticList locale={locale} diagnostics={series.diagnostics} />
        </li>)}</ul>
      </section>}
    </ResultDialog>}
  </>;
}

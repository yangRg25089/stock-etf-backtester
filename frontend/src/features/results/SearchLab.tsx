import { useState, type CSSProperties } from "react";
import type { SearchCandidate } from "../../api/generated";
import { compareDecimals, decimalIdentity } from "../../api/contractReader";
import { translate, type Locale } from "../../i18n/messages";
import { formatPercent, formatPlainNumber } from "./format";
import { savedCandidate } from "./savedConfiguration";
import { buildSearchHeatmap, buildSearchNeighborhood, searchMetricValue, searchOutcomeId, searchParameters, searchValue,
  sortedSearchValues, type SearchMetric, type SearchStage, type SearchSlice } from "./searchLabModel";

const AXIS_PAGE_SIZE = 20;

export function SearchLab({ result, locale, selectedId, pending, onSelect }: {
  result: SearchSlice; locale: Locale; selectedId?: string; pending?: boolean; onSelect?(id: string): void;
}) {
  const dimensions = result.dimensions;
  const seed = savedCandidate(result, selectedId ?? result.rankedCandidateIds[0]) ?? result.candidates[0];
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(dimensions.map(item => {
    const saved = searchParameters(seed)[item.key];
    return [item.key, sortedSearchValues(item).find(value => searchValue(saved) && compareDecimals(value, saved) === 0) ?? item.values[0]];
  })));
  const [view, setView] = useState<"heatmap" | "neighbors">(dimensions.length >= 2 ? "heatmap" : "neighbors");
  const [stage, setStage] = useState<SearchStage>("train");
  const [metric, setMetric] = useState<SearchMetric>("xirr");
  const [xKey, setXKey] = useState(dimensions[0].key);
  const [yKey, setYKey] = useState(dimensions[1]?.key ?? "");
  const [pages, setPages] = useState({ x: 0, y: 0 });
  const fixed = Object.fromEntries(dimensions.filter(item => item.key !== xKey && (view !== "heatmap" || item.key !== yKey)).map(item => [item.key, values[item.key]]));
  const matrix = view === "heatmap" ? buildSearchHeatmap(result, xKey, yKey, fixed) : null;
  const neighbors = view === "neighbors" ? buildSearchNeighborhood(result, xKey, fixed) : null;
  const label = (key: string) => translate(locale, dimensions.find(item => item.key === key)?.translationKey ?? `parameters.${key}`);
  const metricLabel = translate(locale, `search.metric.${metric}`);
  const formatted = (value: string | null) => metric === "xirr" || metric === "drawdown" ? formatPercent(value, locale) : formatPlainNumber(value, locale);
  const currentId = selectedId ?? result.rankedCandidateIds[0];
  const cell = (candidate: SearchCandidate | null) => {
    const number = searchMetricValue(candidate, stage, metric);
    const id = searchOutcomeId(candidate, stage);
    const tone = number == null ? "missing" : compareDecimals(number, 0) === 0 ? "neutral" : compareDecimals(number, 0) < 0 ? "negative" : "positive";
    const strength = number == null ? 0 : Math.min(.3, .07 + Math.abs(Number(number)) / (metric === "sharpe" || metric === "calmar" ? 20 : 3));
    const status = candidate ? translate(locale, `status.${stage === "test" ? candidate.testResult?.status ?? "unavailable" : candidate.status}`) : translate(locale, "performance.noObservation");
    const parameters = candidate ? dimensions.map(item => `${label(item.key)} ${String(searchParameters(candidate)[item.key])}`).join(" · ") : "";
    return <button type="button" className={`search-heat-cell is-${tone}`} disabled={!id || pending}
      aria-pressed={id === currentId} style={{ "--heat-strength": strength } as CSSProperties}
      aria-label={`${parameters} · ${metricLabel} ${formatted(number)} · ${status}`}
      title={`${parameters} · ${metricLabel} ${formatted(number)} · ${status}`}
      onClick={() => { if (id) onSelect?.(id); }}>
      {number == null ? "—" : formatted(number)}
    </button>;
  };
  const axisControl = (axis: "x" | "y", count: number) => {
    const total = Math.ceil(count / AXIS_PAGE_SIZE);
    return total > 1 && <div className="search-axis-pages">
      <button className="icon-button" type="button" disabled={pages[axis] === 0 || pending}
        aria-label={translate(locale, "search.previousAxis", { axis: axis.toUpperCase() })}
        onClick={() => setPages(before => ({ ...before, [axis]: before[axis] - 1 }))}>‹</button>
      <span>{axis.toUpperCase()} {pages[axis] + 1} / {total}</span>
      <button className="icon-button" type="button" disabled={pages[axis] + 1 >= total || pending}
        aria-label={translate(locale, "search.nextAxis", { axis: axis.toUpperCase() })}
        onClick={() => setPages(before => ({ ...before, [axis]: before[axis] + 1 }))}>›</button>
    </div>;
  };
  const xOffset = pages.x * AXIS_PAGE_SIZE, yOffset = pages.y * AXIS_PAGE_SIZE;
  return <details className="search-lab">
    <summary>{translate(locale, "search.lab")}</summary>
    <div className="search-lab-toolbar">
      <div className="search-lab-views" role="group" aria-label={translate(locale, "search.lab")}>
        {dimensions.length >= 2 && <button className="button" type="button" aria-pressed={view === "heatmap"} disabled={pending}
          onClick={() => { if (xKey === yKey) setYKey(dimensions.find(item => item.key !== xKey)!.key); setView("heatmap"); setPages({ x: 0, y: 0 }); }}>{translate(locale, "search.heatmap")}</button>}
        <button className="button" type="button" aria-pressed={view === "neighbors"} disabled={pending}
          onClick={() => { setView("neighbors"); setPages({ x: 0, y: 0 }); }}>{translate(locale, "search.neighbors")}</button>
      </div>
      {result.optimizationMode === "train_test" && <label>{translate(locale, "parameters.search.optimizationMode")}<select className="input" aria-label={translate(locale, "parameters.search.optimizationMode")} value={stage} disabled={pending}
        onChange={event => setStage(event.target.value as SearchStage)}>{["train", "test"].map(value => <option value={value} key={value}>{translate(locale, `search.phase.${value}`)}</option>)}</select></label>}
      <label>{translate(locale, "search.metric")}<select className="input" aria-label={translate(locale, "search.metric")} value={metric} disabled={pending}
        onChange={event => setMetric(event.target.value as SearchMetric)}>{["xirr", "sharpe", "calmar", "drawdown"].map(value => <option key={value} value={value}>{translate(locale, `search.metric.${value}`)}</option>)}</select></label>
      {["x", ...(view === "heatmap" ? ["y"] : [])].map(axis => <label key={axis}>{view === "heatmap" ? axis.toUpperCase() : translate(locale, "search.parameters")}<select className="input" aria-label={view === "heatmap" ? axis.toUpperCase() : translate(locale, "search.parameters")} disabled={pending} value={axis === "x" ? xKey : yKey}
        onChange={event => { if (axis === "x") setXKey(event.target.value); else setYKey(event.target.value); setPages({ x: 0, y: 0 }); }}>
        {dimensions.filter(item => view !== "heatmap" || item.key !== (axis === "x" ? yKey : xKey)).map(item => <option key={item.key} value={item.key}>{label(item.key)}</option>)}</select></label>)}
      {Object.keys(fixed).map(key => <label key={key}>{label(key)}<select className="input" aria-label={label(key)} value={decimalIdentity(fixed[key] as string | number)} disabled={pending}
        onChange={event => setValues(before => ({ ...before, [key]: sortedSearchValues(dimensions.find(item => item.key === key)!).find(value => decimalIdentity(value) === event.target.value) }))}>
        {sortedSearchValues(dimensions.find(item => item.key === key)!).map(value => <option key={decimalIdentity(value)} value={decimalIdentity(value)}>{String(value)}</option>)}</select></label>)}
    </div>
    <p className="field-hint">{translate(locale, "search.fixedSliceHelp")}</p>
    <div className="search-axis-pages-row">{axisControl("x", matrix?.xValues.length ?? neighbors?.values.length ?? 0)}{matrix && axisControl("y", matrix.yValues.length)}</div>
    <div className="data-table-scroll search-lab-scroll" tabIndex={0} role="region" aria-label={translate(locale, view === "heatmap" ? "search.heatmap" : "search.neighbors")}>
      {matrix ? <table className="data-table search-heatmap-table"><caption>{label(yKey)} ↓ · {label(xKey)} → · {metricLabel}</caption>
        <thead><tr><th scope="col">{label(yKey)}</th>{matrix.xValues.slice(xOffset, xOffset + AXIS_PAGE_SIZE).map(value => <th scope="col" key={decimalIdentity(value)}>{String(value)}</th>)}</tr></thead>
        <tbody>{matrix.yValues.slice(yOffset, yOffset + AXIS_PAGE_SIZE).map((value, row) => <tr key={decimalIdentity(value)}><th scope="row">{String(value)}</th>
          {matrix.cells[row + yOffset].slice(xOffset, xOffset + AXIS_PAGE_SIZE).map((candidate, column) => <td key={column}>{cell(candidate)}</td>)}</tr>)}</tbody>
      </table> : neighbors && <table className="data-table search-neighbor-table"><caption>{label(xKey)}</caption><thead><tr><th scope="col">{label(xKey)}</th><th scope="col">{metricLabel}</th></tr></thead>
        <tbody>{neighbors.values.slice(xOffset, xOffset + AXIS_PAGE_SIZE).map((value, index) => <tr key={decimalIdentity(value)}><th scope="row">{String(value)}</th><td>{cell(neighbors.candidates[index + xOffset])}</td></tr>)}</tbody></table>}
    </div>
  </details>;
}

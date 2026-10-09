import { translate, type Locale } from "../../../i18n/messages";
import type { useChartInteraction } from "../useChartInteraction";
import type { TechnicalChartLine } from "../technicalIndicators";
import { MIN_CHART_VIEWPORT_SPAN } from "../chartViewport";
import type { SeriesDefinition } from "./chartTypes";
import { SERIES } from "./chartSeriesModel";
import { seriesLabel } from "./chartFormat";
import { usePhoneMenu } from "../../../shared/ui/usePhoneMenu";

interface ChartControlsProps {
  locale: Locale;
  currency?: string;
  busy: boolean;
  available: SeriesDefinition[];
  selected: SeriesDefinition[];
  savedLines: TechnicalChartLine[];
  hiddenTechnicalKinds: string[];
  visibleStartDate: string;
  visibleEndDate: string;
  onSeriesChange(id: string, visible: boolean): void;
  onTechnicalToggle(kind: string, visible: boolean): void;
  interaction: Pick<ReturnType<typeof useChartInteraction>, "cursor" | "touchMode" | "selectTouchMode" | "viewport" | "wheelZoomEnabled" | "toggleWheelZoom" | "zoomAt" | "resetRange">;
}

export function ChartControls({ locale, currency, busy, available, selected, savedLines, hiddenTechnicalKinds,
  visibleStartDate, visibleEndDate, onSeriesChange, onTechnicalToggle, interaction }: ChartControlsProps) {
  const { touchMode, selectTouchMode, viewport, wheelZoomEnabled, toggleWheelZoom, zoomAt, resetRange } = interaction;
  const viewportSpan = viewport.end - viewport.start;
  const technicalKinds = [...new Set(savedLines.map(line => line.kind))];
  const { open, setOpen, trigger, panel, id } = usePhoneMenu();
  const wheelZoomLabel = translate(locale, wheelZoomEnabled ? "chart.disableWheelZoom" : "chart.enableWheelZoom");
  const wheelZoomButton = (className = "") => <button className={`icon-only-button chart-wheel-zoom-toggle${className ? ` ${className}` : ""}`}
    type="button" aria-label={wheelZoomLabel} title={wheelZoomLabel} aria-pressed={wheelZoomEnabled} onClick={toggleWheelZoom}>
    <span aria-hidden="true"><svg viewBox="0 0 20 20" focusable="false"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg></span>
  </button>;
  return (<div className="chart-toolbar">
        <div ref={panel} id={id} className={`chart-controls${open ? " is-phone-open" : ""}`}>
          <div className="chart-legend" role="group" aria-label={translate(locale, "chart.legend")}>
            {SERIES.map((series) => {
              const isAvailable = available.includes(series);
              const isVisible = selected.includes(series) && isAvailable;
              return (
                <button
                  className={`legend-toggle${isVisible ? " is-visible" : ""}`}
                  type="button"
                  key={series.id}
                  data-series={series.id}
                  aria-pressed={isVisible}
                  disabled={busy || !isAvailable}
                  onClick={() => onSeriesChange(series.id, !isVisible)}
                >
                  <span className="legend-swatch" style={{ backgroundColor: series.color }} aria-hidden="true" />
                  <span className="legend-check" aria-hidden="true">{isVisible ? "✓" : "−"}</span>
                  {seriesLabel(locale, series, currency)}
                </button>
              );
            })}
            {technicalKinds.map(kind => {
              const visible = !hiddenTechnicalKinds.includes(kind);
              const label = kind === "bollinger" ? "BOLL" : kind.toUpperCase();
              return <button className={`legend-toggle${visible ? " is-visible" : ""}`} type="button" key={kind}
                data-series={kind} aria-pressed={visible} disabled={busy}
                onClick={() => {
                  onTechnicalToggle(kind, visible);
                }}>
                <span className="legend-swatch" style={{ backgroundColor: savedLines.find(line => line.kind === kind)?.color }} aria-hidden="true" />
                <span className="legend-check" aria-hidden="true">{visible ? "✓" : "−"}</span>{label}
              </button>;
            })}
          </div>
          <div className="chart-phone-advanced-controls">
            {wheelZoomEnabled && <span className="chart-wheel-zoom-status" role="status">{translate(locale, "chart.wheelZoomActive")}</span>}
            {wheelZoomButton()}
          </div>
        </div>
        <div className="chart-phone-action-row">
        <div className="chart-touch-controls" role="group" aria-label={translate(locale, "chart.touchMode")}>
          {(["inspect", "pan"] as const).map(mode => <button type="button" key={mode} disabled={busy} aria-pressed={touchMode === mode}
            onClick={() => selectTouchMode(mode)}>{translate(locale, `chart.touch.${mode}`)}</button>)}
        </div>
        <div className="chart-range-controls" role="group" aria-label={translate(locale, "chart.rangeControls")}>
          {wheelZoomEnabled && (
            <span className="chart-wheel-zoom-status" role="status">
              {translate(locale, "chart.wheelZoomActive")}
            </span>
          )}
          <span className="chart-range-label sr-only">
            {translate(locale, "chart.visibleRange", { start: visibleStartDate, end: visibleEndDate })}
          </span>
          {wheelZoomButton()}
          <button type="button" aria-label={translate(locale, "chart.zoomOut")} title={translate(locale, "chart.zoomOut")} disabled={viewportSpan >= 1} onClick={() => zoomAt(1.25)}>
            <span aria-hidden="true">−</span>
          </button>
          <button type="button" aria-label={translate(locale, "chart.zoomIn")} title={translate(locale, "chart.zoomIn")} disabled={viewportSpan <= MIN_CHART_VIEWPORT_SPAN + 1e-6} onClick={() => zoomAt(0.8)}>
            <span aria-hidden="true">+</span>
          </button>
          <button className="icon-only-button chart-range-reset" type="button" aria-label={translate(locale, "chart.resetRange")} title={translate(locale, "chart.resetRange")} disabled={busy || (viewportSpan >= 1 && !interaction.cursor)} onClick={resetRange}>
            <span aria-hidden="true">↺</span>
          </button>
        </div>
        <button ref={trigger} id={`${id}-toggle`} className="chart-phone-menu-toggle" type="button"
          aria-label={translate(locale, "chart.displayControls")} aria-expanded={open} aria-controls={id}
          onClick={() => setOpen(value => !value)}><span aria-hidden="true">⋯</span></button>
        </div>
      </div>);
}

import { translate, type Locale } from "../../../i18n/messages";
import type { useChartInteraction } from "../useChartInteraction";
import type { TechnicalChartLine } from "../technicalIndicators";
import { MIN_CHART_VIEWPORT_SPAN } from "../chartViewport";
import type { SeriesDefinition } from "./chartTypes";
import { SERIES } from "./chartSeriesModel";
import { seriesLabel } from "./chartFormat";

interface ChartControlsProps {
  locale: Locale;
  currency?: string;
  busy: boolean;
  available: SeriesDefinition[];
  selected: SeriesDefinition[];
  savedLines: TechnicalChartLine[];
  hiddenTechnicalKinds: string[];
  priceVisible: boolean;
  visibleStartDate: string;
  visibleEndDate: string;
  onSeriesChange(id: string, visible: boolean): void;
  onTechnicalToggle(kind: string, visible: boolean): void;
  interaction: Pick<ReturnType<typeof useChartInteraction>, "viewport" | "wheelZoomEnabled" | "toggleWheelZoom" | "zoomAt" | "resetRange">;
}

export function ChartControls({ locale, currency, busy, available, selected, savedLines, hiddenTechnicalKinds,
  priceVisible, visibleStartDate, visibleEndDate, onSeriesChange, onTechnicalToggle, interaction }: ChartControlsProps) {
  const { viewport, wheelZoomEnabled, toggleWheelZoom, zoomAt, resetRange } = interaction;
  const viewportSpan = viewport.end - viewport.start;
  const technicalKinds = [...new Set(savedLines.map(line => line.kind))];
  return (<div className="chart-toolbar">
        <div className="chart-controls">
          <div className="chart-legend" role="group" aria-label={translate(locale, "chart.legend")}>
            {SERIES.map((series) => {
              const isAvailable = available.includes(series);
              const isVisible = selected.includes(series) && isAvailable;
              const isLastCore = isVisible && (series.id === "price" || series.id === "totalAsset")
                && selected.filter(item => item.id === "price" || item.id === "totalAsset").length === 1;
              const alternativeCore = available.find(item => item.id !== series.id && (item.id === "price" || item.id === "totalAsset"));
              const cannotHide = isLastCore && !alternativeCore;
              return (
                <button
                  className={`legend-toggle${isVisible ? " is-visible" : ""}`}
                  type="button"
                  key={series.id}
                  data-series={series.id}
                  aria-pressed={isVisible}
                  disabled={busy || !isAvailable || cannotHide}
                  title={cannotHide ? translate(locale, "chart.keepCoreSeries") : undefined}
                  onClick={() => {
                    if (isLastCore && alternativeCore) onSeriesChange(alternativeCore.id, true);
                    onSeriesChange(series.id, !isVisible);
                  }}
                >
                  <span className="legend-swatch" style={{ backgroundColor: series.color }} aria-hidden="true" />
                  <span className="legend-check" aria-hidden="true">{isVisible ? "✓" : "−"}</span>
                  {seriesLabel(locale, series, currency)}
                </button>
              );
            })}
            {technicalKinds.map(kind => {
              const visible = !hiddenTechnicalKinds.includes(kind) && (kind === "rsi" || priceVisible);
              const label = kind === "bollinger" ? "BOLL" : kind.toUpperCase();
              return <button className={`legend-toggle${visible ? " is-visible" : ""}`} type="button" key={kind}
                data-series={kind} aria-pressed={visible} disabled={busy}
                onClick={() => {
                  if (!visible && kind !== "rsi" && !priceVisible) onSeriesChange("price", true);
                  onTechnicalToggle(kind, visible);
                }}>
                <span className="legend-swatch" style={{ backgroundColor: savedLines.find(line => line.kind === kind)?.color }} aria-hidden="true" />
                <span className="legend-check" aria-hidden="true">{visible ? "✓" : "−"}</span>{label}
              </button>;
            })}
          </div>
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
          <button
            className="icon-only-button chart-wheel-zoom-toggle"
            type="button"
            aria-label={translate(locale, wheelZoomEnabled ? "chart.disableWheelZoom" : "chart.enableWheelZoom")}
            title={translate(locale, wheelZoomEnabled ? "chart.disableWheelZoom" : "chart.enableWheelZoom")}
            aria-pressed={wheelZoomEnabled}
            onClick={toggleWheelZoom}
          >
            <span aria-hidden="true">
              <svg viewBox="0 0 20 20" focusable="false">
                <circle cx="8.5" cy="8.5" r="5.5" />
                <path d="m13 13 4 4" />
              </svg>
            </span>
          </button>
          <button type="button" aria-label={translate(locale, "chart.zoomOut")} title={translate(locale, "chart.zoomOut")} disabled={viewportSpan >= 1} onClick={() => zoomAt(1.25)}>
            <span aria-hidden="true">−</span>
          </button>
          <button type="button" aria-label={translate(locale, "chart.zoomIn")} title={translate(locale, "chart.zoomIn")} disabled={viewportSpan <= MIN_CHART_VIEWPORT_SPAN + 1e-6} onClick={() => zoomAt(0.8)}>
            <span aria-hidden="true">+</span>
          </button>
          <button className="icon-only-button chart-range-reset" type="button" aria-label={translate(locale, "chart.resetRange")} title={translate(locale, "chart.resetRange")} disabled={viewportSpan >= 1} onClick={resetRange}>
            <span aria-hidden="true">↺</span>
          </button>
        </div>
      </div>);
}

import { useId, type CSSProperties, type ReactNode } from "react";
import type { ReturnTone } from "./returnTone";

export interface ChartCursor {
  index: number;
  chartId: string;
  yRatio: number;
}

export interface CursorReading {
  label: string;
  value: string;
  color?: string;
  tone?: ReturnTone;
  series?: { id: string; label: string; seriesId?: string };
}

export interface StrategyReading {
  id: string;
  label: string;
  color: string;
  rank?: number;
  seriesId?: string;
  readings: CursorReading[];
}

export interface SeriesInspection {
  highlightedId: string | null;
  selectedId: string | null;
  inspect(id: string | null, source: "hoveredId" | "focusedId" | "selectedId", pointer?: boolean, touch?: boolean): void;
}

function SeriesControl({ id, label, description, color, seriesId, resultId, date, className = "", inspection, children }: {
  id: string;
  label: string;
  description: string;
  color?: string;
  seriesId?: string;
  resultId?: string;
  date?: string;
  className?: string;
  inspection: SeriesInspection;
  children: ReactNode;
}) {
  const descriptionId = useId();
  const selected = inspection.selectedId === id;
  return (
    <button type="button"
      className={`chart-series-control${className ? ` ${className}` : ""}${inspection.highlightedId === id ? " is-highlighted" : ""}${selected ? " is-selected" : ""}`}
      aria-label={label} aria-pressed={selected} aria-describedby={descriptionId}
      style={{ "--series-color": color } as CSSProperties}
      data-series={seriesId ?? id} data-result-id={resultId} data-date={date}
      onMouseEnter={() => inspection.inspect(id, "hoveredId")}
      onMouseLeave={() => inspection.inspect(null, "hoveredId")}
      onFocus={() => inspection.inspect(id, "focusedId")}
      onBlur={() => inspection.inspect(null, "focusedId")}
      onClick={event => inspection.inspect(id, "selectedId", event.detail > 0,
        (event.nativeEvent as PointerEvent).pointerType === "touch")}>
      {children}
      <span className="chart-series-selection" aria-hidden="true">{selected ? "✓" : ""}</span>
      <span id={descriptionId} className="sr-only">{description}</span>
    </button>
  );
}

function ReadingValues({ readings, inspection }: { readings: CursorReading[]; inspection?: SeriesInspection }) {
  return readings.map(({ label, value, color, series, tone }) => {
    const reading = <span key={series?.id ?? label} className="chart-cursor-reading" style={color ? { "--reading-color": color } as CSSProperties : undefined}>
      <span>{label}</span> <strong className={tone ? `return-value is-${tone}` : undefined}>{value}</strong>
    </span>;
    return series && inspection
      ? <SeriesControl key={series.id} {...series} description={value} color={color} inspection={inspection}>{reading}</SeriesControl>
      : reading;
  });
}

export function ChartReadout({ date, readings, strategies = [], inspection }: {
  date?: string;
  readings: CursorReading[];
  strategies?: StrategyReading[];
  inspection: SeriesInspection;
}) {
  if (!date) return null;
  return (
    <div className="chart-crosshair-readout" data-date={date}>
      <div className="chart-market-readout" data-date={date}>
        <time dateTime={date}>{date}</time>
        <ReadingValues readings={readings} inspection={inspection} />
      </div>
      <div className="chart-strategy-readouts">{strategies.map(strategy => (
        <SeriesControl key={strategy.id} id={strategy.id} label={strategy.label} color={strategy.color} seriesId={strategy.seriesId}
          description={strategy.readings.map(reading => `${reading.label} ${reading.value}`).join(" · ")}
          resultId={strategy.id} date={date}
          className="chart-strategy-readout" inspection={inspection}>
          <span className="chart-strategy-rank" aria-hidden="true">{strategy.rank}</span>
          <span className="chart-strategy-name" title={strategy.label}>{strategy.label}</span>
          <ReadingValues readings={strategy.readings} />
        </SeriesControl>
      ))}</div>
    </div>
  );
}

export function ChartCrosshair({
  date, x, y, valueLabel, geometry, points,
}: {
  date?: string;
  x: number;
  y?: number;
  valueLabel?: string;
  geometry: { width: number; height: number; left: number; right: number; top: number; bottom: number };
  points: Array<{ y: number; color: string }>;
}) {
  if (!date) return null;
  const bottom = geometry.height - geometry.bottom;
  return (
    <g className="chart-crosshair" data-date={date} aria-hidden="true">
      <line className="chart-cursor-vertical" x1={x} x2={x} y1={geometry.top} y2={bottom} />
      {y !== undefined && (
        <>
          <line className="chart-cursor-horizontal" x1={geometry.left} x2={geometry.width - geometry.right} y1={y} y2={y} />
          <rect className="chart-cursor-tag" x={geometry.left - 69} y={y - 9} width="65" height="18" rx="2" />
          <text className="chart-cursor-label" x={geometry.left - 36} y={y + 4} textAnchor="middle">{valueLabel}</text>
        </>
      )}
      {points.filter((point) => point.y >= geometry.top && point.y <= bottom).map((point, index) => (
        <circle className="chart-cursor-point" key={index} cx={x} cy={point.y} r="3.5" fill={point.color} />
      ))}
    </g>
  );
}

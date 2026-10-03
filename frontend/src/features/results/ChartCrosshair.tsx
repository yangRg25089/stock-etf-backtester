export interface ChartCursor {
  index: number;
  chartId: string;
  yRatio: number;
}

export interface CursorReading {
  label: string;
  value: string;
  color?: string;
}

export interface StrategyReading {
  id: string;
  label: string;
  color: string;
  rank?: number;
  readings: CursorReading[];
}

function ReadingValues({ readings }: { readings: CursorReading[] }) {
  return readings.map(({ label, value, color }) => (
    <span key={label} className="chart-cursor-reading" style={color ? { color } : undefined}>
      <span>{label}</span> <strong>{value}</strong>
    </span>
  ));
}

export function ChartReadout({ date, readings, strategies = [] }: {
  date?: string;
  readings: CursorReading[];
  strategies?: StrategyReading[];
}) {
  if (!date) return null;
  return (
    <div className="chart-crosshair-readout" data-date={date}>
      <div className="chart-market-readout" data-date={date}>
        <time dateTime={date}>{date}</time>
        <ReadingValues readings={readings} />
      </div>
      {strategies.map(strategy => (
        <div className="chart-strategy-readout" data-result-id={strategy.id} data-date={date} key={strategy.id}>
          <span className="chart-strategy-rank" aria-hidden="true">{strategy.rank}</span>
          <span className="chart-strategy-name" title={strategy.label} style={{ color: strategy.color }}>{strategy.label}</span>
          <ReadingValues readings={strategy.readings} />
        </div>
      ))}
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

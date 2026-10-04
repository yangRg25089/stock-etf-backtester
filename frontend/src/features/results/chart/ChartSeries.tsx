import { CHART } from "./chartScale";

export function HighlightArea({ points, color, gradientId, bottom = CHART.height - CHART.bottom }: {
  points: Array<{ x: number; y: number }>;
  color: string;
  gradientId: string;
  bottom?: number;
}) {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || points.length < 2) return null;
  const path = `M ${first.x},${bottom} L ${points.map((point) => `${point.x},${point.y}`).join(" L ")} L ${last.x},${bottom} Z`;
  return (
    <g aria-hidden="true" className="chart-highlight-fill">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path className="chart-highlight-area" d={path} fill={`url(#${gradientId})`} />
    </g>
  );
}

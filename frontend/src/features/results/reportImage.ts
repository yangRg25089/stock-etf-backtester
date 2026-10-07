import { heatmapIntensity } from "./heatmapIntensity";
import { formatPercent } from "./format";
import { returnTone } from "./returnTone";
import { reportBitmapSize, wrapReportText, type ResultReport } from "./reportModel";

const WIDTH = 1200;
const MARGIN = 48;
const BODY_WIDTH = WIDTH - MARGIN * 2;
const FONT = 'system-ui, -apple-system, "Hiragino Sans", "Noto Sans CJK JP", "Microsoft YaHei", sans-serif';

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Report cancelled", "AbortError");
}

/** A detached, origin-clean bitmap of the frozen result, independent of on-screen chart controls. */
export async function renderResultReport(report: ResultReport, signal?: AbortSignal): Promise<Blob> {
  await document.fonts.ready;
  checkAbort(signal);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  const styles = getComputedStyle(document.querySelector(".app-frame") ?? document.documentElement);
  const color = (key: string) => styles.getPropertyValue(key).trim();
  const palette = { background: color("--app-surface"), soft: color("--app-surface-muted"),
    text: color("--app-foreground"), muted: color("--app-muted"), border: color("--app-border"), accent: color("--app-accent") };
  const font = (size: number, weight = 400) => { context.font = `${weight} ${size}px ${FONT}`; };
  const wrap = (value: string, size: number, width = BODY_WIDTH, weight = 400) => {
    font(size, weight);
    return wrapReportText(value, width, text => context.measureText(text).width);
  };
  const title = wrap(report.title, 32, BODY_WIDTH, 700);
  const metricRows = report.metrics.map(metric => {
    font(28, 700);
    const valueSize = Math.max(18, Math.min(28, 28 * 240 / Math.max(context.measureText(metric.value).width, 1)));
    return { ...metric, labelLines: wrap(metric.label, 18, 240), valueSize,
      valueLines: wrap(metric.value, valueSize, 240, 700) };
  });
  const metricHeight = Math.max(...metricRows.map(metric => metric.labelLines.length * 24
    + metric.valueLines.length * (metric.valueSize + 6))) + 38;
  const legend = report.lines.map(line => ({ ...line, labelLines: wrap(line.label, 19, BODY_WIDTH - 34) }));
  const legendHeight = legend.reduce((height, line) => height + line.labelLines.length * 26, 0);
  const sections = report.sections.map(section => ({ ...section,
    wrapped: section.lines.flatMap(line => wrap(line, 20, BODY_WIDTH - 40)) }));
  const notes = report.notes.flatMap(note => wrap(note, 18));
  const footer = report.footer.flatMap(line => wrap(line, 16));
  const headerHeight = 194 + title.length * 40;
  const chartHeight = 395 + legendHeight;
  const sectionsHeight = sections.reduce((height, section) => height + 64 + section.wrapped.length * 28, 0);
  const heatmap = report.periodReturns;
  const years = [...new Set([...heatmap.monthly, ...heatmap.annual].map(row => row.year))].sort((a, b) => a - b);
  const heatmapHeight = 84 + Math.max(1, years.length) * 42;
  const height = headerHeight + metricHeight * 2 + 28 + chartHeight + 200 + sectionsHeight
    + heatmapHeight + notes.length * 26 + footer.length * 24 + 112;
  const bitmap = reportBitmapSize(WIDTH, height);
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  context.scale(bitmap.scale, bitmap.scale);
  context.fillStyle = palette.background;
  context.fillRect(0, 0, WIDTH, height);
  context.textBaseline = "top";
  const text = (value: string, x: number, y: number, size = 20, fill = palette.text, weight = 400) => {
    font(size, weight); context.fillStyle = fill; context.fillText(value, x, y);
  };
  const textLines = (lines: string[], x: number, y: number, step: number, size: number, fill = palette.text, weight = 400) => {
    lines.forEach((line, index) => text(line, x, y + index * step, size, fill, weight));
  };
  context.fillStyle = palette.accent;
  context.fillRect(0, 0, WIDTH, 9);
  text(report.heading, MARGIN, 36, 19, palette.muted, 600);
  textLines(title, MARGIN, 74, 40, 32, palette.text, 700);
  const titleBottom = 74 + title.length * 40;
  text(`${report.symbol} · ${report.period}`, MARGIN, titleBottom + 12, 21);
  text(report.funding, MARGIN, titleBottom + 49, 20, palette.muted);
  text(report.tradeSummary, MARGIN, titleBottom + 81, 18, palette.muted);
  let y = headerHeight;
  metricRows.forEach((metric, index) => {
    const x = MARGIN + index % 4 * 280;
    const top = y + Math.floor(index / 4) * metricHeight;
    context.fillStyle = palette.soft; context.fillRect(x, top, 264, metricHeight - 12);
    textLines(metric.labelLines, x + 12, top + 12, 24, 18, palette.muted);
    textLines(metric.valueLines, x + 12, top + 16 + metric.labelLines.length * 24,
      metric.valueSize + 6, metric.valueSize, palette.text, 700);
  });
  y += metricHeight * 2 + 28;
  text(report.chartTitle, MARGIN, y, 24, palette.text, 700);
  y += 37;
  for (const line of legend) {
    context.strokeStyle = line.color; context.lineWidth = 2;
    context.beginPath(); context.moveTo(MARGIN, y + 12); context.lineTo(MARGIN + 23, y + 12); context.stroke();
    textLines(line.labelLines, MARGIN + 34, y, 26, 19, line.color);
    y += line.labelLines.length * 26;
  }
  y += 12;
  const plot = { left: MARGIN + 70, width: BODY_WIDTH - 90, top: y, height: 270 };
  const values = report.lines.flatMap(line => line.points.map(point => point.indexValue));
  const lowest = values.reduce((minimum, value) => Math.min(minimum, value), values.length ? 100 : 0);
  const highest = values.reduce((maximum, value) => Math.max(maximum, value), 100);
  const padding = Math.max((highest - lowest) * 0.08, 5);
  const min = lowest - padding;
  const max = highest + padding;
  const lastIndex = report.lines.reduce((last, line) => line.points.reduce((last, point) => Math.max(last, point.index), last), 1);
  const xAt = (index: number) => plot.left + index / lastIndex * plot.width;
  const yAt = (value: number) => plot.top + (max - value) / (max - min) * plot.height;
  const grid = (top: number, plotHeight: number, yLabel: (fraction: number) => string) => {
    context.strokeStyle = palette.border; context.lineWidth = 0.8;
    for (let index = 0; index < 8; index++) {
      const fraction = index / 7;
      const gy = top + fraction * plotHeight;
      context.beginPath(); context.moveTo(plot.left, gy); context.lineTo(plot.left + plot.width, gy); context.stroke();
      text(yLabel(fraction), MARGIN, gy - 9, 16, palette.muted);
      const gx = plot.left + fraction * plot.width;
      context.beginPath(); context.moveTo(gx, top); context.lineTo(gx, top + plotHeight); context.stroke();
    }
  };
  grid(plot.top, plot.height, fraction => (max - fraction * (max - min)).toFixed(1));
  const strokeSegments = (points: { index: number; value: number }[], toY: (value: number) => number) => {
    context.beginPath();
    points.forEach((point, index) => {
      if (!index || point.index !== points[index - 1].index + 1) context.moveTo(xAt(point.index), toY(point.value));
      else context.lineTo(xAt(point.index), toY(point.value));
    });
    context.stroke();
  };
  for (const line of report.lines) {
    context.strokeStyle = line.color;
    context.lineWidth = line.id === report.resultId ? 2 : 1.3;
    strokeSegments(line.points.map(point => ({ index: point.index, value: point.indexValue })), yAt);
  }
  y += plot.height + 19;
  text(report.chartAxis, plot.left, y, 16, palette.muted);
  y += 40;
  text(report.drawdownTitle, MARGIN, y, 21, palette.text, 600);
  y += 35;
  const drawdownMin = report.drawdown.reduce((minimum, point) => Math.min(minimum, point.value), -1);
  const ddHeight = 105;
  grid(y, ddHeight, fraction => `${(drawdownMin * fraction).toFixed(1)}%`);
  context.strokeStyle = report.lines.find(line => line.id === report.resultId)?.color ?? palette.accent;
  context.lineWidth = 1.5;
  strokeSegments(report.drawdown, value => y + value / drawdownMin * ddHeight);
  y += ddHeight + 12;
  const [firstDate, lastDate] = report.period.split(" → ");
  text(firstDate, plot.left, y, 16, palette.muted);
  font(16); text(lastDate, plot.left + plot.width - context.measureText(lastDate).width, y, 16, palette.muted);
  y += 41;
  for (const section of sections) {
    checkAbort(signal);
    const sectionHeight = 64 + section.wrapped.length * 28;
    context.fillStyle = palette.soft; context.fillRect(MARGIN, y, BODY_WIDTH, sectionHeight - 12);
    text(section.title, MARGIN + 20, y + 13, 23, palette.text, 700);
    textLines(section.wrapped, MARGIN + 20, y + 47, 28, 20);
    y += sectionHeight;
  }
  text(heatmap.title, MARGIN, y + 4, 23, palette.text, 700);
  y += 40;
  const cellWidth = BODY_WIDTH / 14;
  const monthCells = new Map(heatmap.monthly.map(row => [`${row.year}-${row.month}`, row]));
  const annualCells = new Map(heatmap.annual.map(row => [row.year, row]));
  text(heatmap.yearTitle, MARGIN + 8, y, 16, palette.muted);
  for (let month = 1; month <= 12; month++) text(String(month), MARGIN + month * cellWidth + 8, y, 16, palette.muted);
  const annualHeading = wrap(heatmap.annualTitle, 12, cellWidth - 4, 600);
  textLines(annualHeading, MARGIN + 13 * cellWidth + 3, y, 14, 12, palette.text, 600);
  y += 28;
  for (const year of years) {
    checkAbort(signal);
    text(String(year), MARGIN + 8, y + 9, 16, palette.text, 600);
    for (let column = 1; column <= 13; column++) {
      const row = column === 13 ? annualCells.get(year) : monthCells.get(`${year}-${column}`);
      const tone = returnTone(row?.navReturn);
      const x = MARGIN + column * cellWidth;
      const fill = tone === "positive" ? color("--return-positive") : tone === "negative" ? color("--return-negative") : palette.soft;
      context.fillStyle = palette.background; context.fillRect(x + 2, y, cellWidth - 4, 34);
      const minimum = parseFloat(color("--heatmap-min")) / 100;
      const range = parseFloat(color("--heatmap-range")) / 100;
      context.globalAlpha = tone === "positive" || tone === "negative" ? minimum + heatmapIntensity(row?.navReturn, column === 13) * range : 1;
      context.fillStyle = fill; context.fillRect(x + 2, y, cellWidth - 4, 34);
      context.globalAlpha = 1;
      if (column === 13) { context.strokeStyle = palette.accent; context.lineWidth = 2; context.strokeRect(x + 2, y, cellWidth - 4, 34); }
      const value = `${tone === "positive" ? "+" : ""}${formatPercent(row?.navReturn, "en")}`;
      const size = Math.max(10, Math.min(14, 14 * (cellWidth - 8) / Math.max(1, (() => { font(14, 600); return context.measureText(value).width; })())));
      text(value, x + 6, y + 10, size, tone === "positive" || tone === "negative" ? palette.text : palette.muted, 600);
    }
    y += 42;
  }
  if (!years.length) { text(heatmap.empty, MARGIN, y, 18, palette.muted); y += 42; }
  y += 16;
  textLines(notes, MARGIN, y + 8, 26, 18, palette.muted);
  y += 28 + notes.length * 26;
  textLines(footer, MARGIN, y, 24, 16, palette.muted);
  try {
    checkAbort(signal);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => {
      if (value) resolve(value); else reject(new Error("PNG encoding failed"));
    }, "image/png"));
    checkAbort(signal);
    return blob;
  } finally {
    // The image Blob owns its pixels; release the temporary bitmap also on cancellation.
    canvas.width = canvas.height = 0;
  }
}

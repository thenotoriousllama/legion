import type { Snapshot } from "../../driver/snapshotManager";
import { CHART, INNER, MATURITY_COLORS, emptyChart, escHtml, renderXAxis } from "./chartUtils";

type Band = keyof typeof MATURITY_COLORS;
const BANDS: Band[] = ["seed", "developing", "mature", "evergreen"];

/**
 * Render a stacked area chart showing the 4 maturity bands over time.
 * Requires at least 2 snapshots.
 */
export function renderStackedAreaChart(snapshots: Snapshot[]): string {
  if (snapshots.length < 2) return emptyChart("Maturity Distribution");

  const maxTotal = Math.max(...snapshots.map((s) => s.entityCount)) * 1.1 || 1;
  const minDate = new Date(snapshots[0].date).getTime();
  const maxDate = new Date(snapshots[snapshots.length - 1].date).getTime();
  const dateRange = maxDate - minDate || 1;

  const toX = (date: string): number =>
    CHART.padding.left + ((new Date(date).getTime() - minDate) / dateRange) * INNER.w;

  const toY = (value: number): number =>
    CHART.padding.top + INNER.h - (value / maxTotal) * INNER.h;

  // Build polygon per band (cumulative from bottom)
  const polygons = BANDS.map((band, bandIdx) => {
    // Sum of all bands below this one at each snapshot
    const lowerBands = BANDS.slice(0, bandIdx);

    const topPoints = snapshots.map((s) => {
      const lower = lowerBands.reduce((sum, b) => sum + (s.byStatus[b] ?? 0), 0);
      const upper = lower + (s.byStatus[band] ?? 0);
      return { x: toX(s.date), y: toY(upper) };
    });

    const bottomPoints = snapshots.map((s) => {
      const lower = lowerBands.reduce((sum, b) => sum + (s.byStatus[b] ?? 0), 0);
      return { x: toX(s.date), y: toY(lower) };
    });

    const allPoints = [
      ...topPoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`),
      ...bottomPoints.slice().reverse().map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`),
    ].join(" ");

    return `<polygon points="${allPoints}" fill="${MATURITY_COLORS[band]}" opacity="0.8"/>`;
  });

  // Legend
  const legendItems = BANDS.map((band, i) => {
    const lx = CHART.padding.left + i * 120;
    const ly = CHART.height - 8;
    return `<rect x="${lx}" y="${ly - 8}" width="12" height="12" fill="${MATURITY_COLORS[band]}"/>
<text x="${lx + 16}" y="${ly + 2}" font-size="10" fill="#555">${band}</text>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CHART.width}" height="${CHART.height}" role="img">
  <title>Maturity Distribution Over Time</title>
  ${renderXAxis(snapshots.map((s) => s.date))}
  ${polygons.join("\n  ")}
  ${legendItems.join("\n  ")}
  <text x="${CHART.width / 2}" y="${CHART.height - 24}" text-anchor="middle" font-size="11" fill="#555">${escHtml("Maturity Distribution Over Time")}</text>
</svg>`;
}

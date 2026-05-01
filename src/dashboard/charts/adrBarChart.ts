import type { Snapshot } from "../../driver/snapshotManager";
import { CHART, INNER, emptyChart, escHtml } from "./chartUtils";

/**
 * Render a monthly grouped bar chart of ADR filing counts.
 * Groups snapshots by calendar month (YYYY-MM) and sums adrCount.
 */
export function renderAdrBarChart(snapshots: Snapshot[]): string {
  if (snapshots.length === 0) return emptyChart("ADR Filing Rate (Monthly)");

  // Group by month
  const byMonth: Map<string, number> = new Map();
  for (const s of snapshots) {
    const month = s.date.slice(0, 7); // "YYYY-MM"
    byMonth.set(month, (byMonth.get(month) ?? 0) + s.adrCount);
  }

  const months = [...byMonth.keys()].sort();
  if (months.length === 0) return emptyChart("ADR Filing Rate (Monthly)");

  const maxVal = Math.max(...byMonth.values()) * 1.1 || 1;
  const barW = Math.min(40, Math.floor(INNER.w / months.length) - 4);

  const bars = months.map((month, i) => {
    const val = byMonth.get(month) ?? 0;
    const x = CHART.padding.left + (i / months.length) * INNER.w + (INNER.w / months.length - barW) / 2;
    const barH = (val / maxVal) * INNER.h;
    const y = CHART.padding.top + INNER.h - barH;
    const label = month.slice(5); // "MM"

    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW}" height="${barH.toFixed(1)}" fill="#6366f1" rx="2"/>
<text x="${(x + barW / 2).toFixed(1)}" y="${(CHART.padding.top + INNER.h + 14).toFixed(1)}" text-anchor="middle" font-size="9" fill="#666">${escHtml(label)}</text>`;
  });

  // Y-axis grid lines
  const gridLines: string[] = [];
  for (let i = 0; i <= 5; i++) {
    const val = Math.round((maxVal / 5) * i);
    const y = CHART.padding.top + INNER.h - (i / 5) * INNER.h;
    gridLines.push(
      `<line x1="${CHART.padding.left}" y1="${y.toFixed(1)}" x2="${CHART.padding.left + INNER.w}" y2="${y.toFixed(1)}" stroke="#eee"/>`,
      `<text x="${CHART.padding.left - 4}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#666">${val}</text>`
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CHART.width}" height="${CHART.height}" role="img">
  <title>ADR Filing Rate (Monthly)</title>
  ${gridLines.join("\n  ")}
  ${bars.join("\n  ")}
  <text x="${CHART.width / 2}" y="${CHART.height - 4}" text-anchor="middle" font-size="12" fill="#666">ADR Filing Rate (Monthly)</text>
</svg>`;
}

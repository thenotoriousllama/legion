import type { ModuleCoverage } from "../../driver/snapshotManager";
import { escHtml } from "./chartUtils";

const BAR_H = 22;
const GAP = 4;
const LEFT_PAD = 130;
const RIGHT_PAD = 24;
const TOP_PAD = 32;
const CHART_W = 700;

/**
 * Render a horizontal bar chart of per-module coverage, sorted lowest-first.
 * Each bar is colored by pct: 0=red, 50=amber, 100=green (HSL interpolation).
 */
export function renderModuleCoverageChart(
  byModule: Record<string, ModuleCoverage>
): string {
  const entries = Object.entries(byModule)
    .filter(([, v]) => v.total > 0)
    .sort(([, a], [, b]) => a.pct - b.pct); // lowest first

  if (entries.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${CHART_W}" height="80" role="img">
  <text x="${CHART_W / 2}" y="40" text-anchor="middle" font-size="13" fill="#888">No module data yet.</text>
</svg>`;
  }

  const totalH = entries.length * (BAR_H + GAP) + TOP_PAD + 20;
  const barAreaW = CHART_W - LEFT_PAD - RIGHT_PAD;

  const bars = entries.map(([mod, cov], i) => {
    const y = TOP_PAD + i * (BAR_H + GAP);
    const pct = cov.pct;
    const barW = Math.max(1, (pct / 100) * barAreaW);
    const hue = pct * 1.2; // 0=red(0°), 100=green(120°)
    const color = `hsl(${hue.toFixed(0)},70%,50%)`;
    const label = mod.length > 18 ? mod.slice(0, 16) + "…" : mod;

    return `<text x="${LEFT_PAD - 6}" y="${(y + BAR_H / 2 + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#555">${escHtml(label)}</text>
<rect x="${LEFT_PAD}" y="${y}" width="${barAreaW}" height="${BAR_H}" fill="#f1f5f9" rx="2"/>
<rect x="${LEFT_PAD}" y="${y}" width="${barW.toFixed(1)}" height="${BAR_H}" fill="${color}" rx="2"/>
<text x="${(LEFT_PAD + barAreaW + 4).toFixed(1)}" y="${(y + BAR_H / 2 + 4).toFixed(1)}" font-size="10" fill="#555">${pct}%</text>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CHART_W}" height="${totalH}" role="img">
  <title>Coverage by Module</title>
  <text x="${CHART_W / 2}" y="20" text-anchor="middle" font-size="12" fill="#666">Coverage by Module (latest snapshot, lowest first)</text>
  ${bars.join("\n  ")}
</svg>`;
}

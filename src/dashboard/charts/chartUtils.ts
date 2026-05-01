/**
 * Shared constants and helpers for all SVG chart renderers.
 * No external dependencies — pure TypeScript generating SVG strings.
 */

export const CHART = {
  width: 700,
  height: 300,
  padding: { top: 20, right: 20, bottom: 40, left: 60 },
};

export const INNER = {
  w: CHART.width - CHART.padding.left - CHART.padding.right,   // 620
  h: CHART.height - CHART.padding.top - CHART.padding.bottom,  // 240
};

export const MATURITY_COLORS = {
  seed:       "#e53935",
  developing: "#f59e0b",
  mature:     "#3b82f6",
  evergreen:  "#22c55e",
} as const;

/** Render an empty chart placeholder. */
export function emptyChart(title: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CHART.width}" height="${CHART.height}" role="img">
  <title>${escHtml(title)}</title>
  <text x="${CHART.width / 2}" y="${CHART.height / 2}" text-anchor="middle"
    font-size="13" fill="#888">No data — run Legion to collect snapshots.</text>
</svg>`;
}

/** Escape HTML special characters in attribute values and text. */
export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Format a date string (ISO) as a short label like "Apr 30". */
export function shortDate(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Render x-axis tick labels for a series of dates. Max 8 ticks shown. */
export function renderXAxis(dates: string[]): string {
  if (dates.length === 0) return "";
  const step = Math.max(1, Math.ceil(dates.length / 8));
  const minT = new Date(dates[0]).getTime();
  const maxT = new Date(dates[dates.length - 1]).getTime();
  const range = maxT - minT || 1;

  const ticks = dates
    .filter((_, i) => i % step === 0 || i === dates.length - 1)
    .map((d) => {
      const x = CHART.padding.left + ((new Date(d).getTime() - minT) / range) * INNER.w;
      return `<text x="${x.toFixed(1)}" y="${CHART.padding.top + INNER.h + 18}"
        text-anchor="middle" font-size="10" fill="#666">${escHtml(shortDate(d))}</text>`;
    });

  const lineY = CHART.padding.top + INNER.h;
  return `<line x1="${CHART.padding.left}" y1="${lineY}" x2="${CHART.padding.left + INNER.w}" y2="${lineY}" stroke="#ddd"/>
${ticks.join("\n")}`;
}

/** Render y-axis tick labels for a 0-maxY scale. */
export function renderYAxis(maxY: number, label: string): string {
  const ticks = 5;
  const lines: string[] = [];
  for (let i = 0; i <= ticks; i++) {
    const val = Math.round((maxY / ticks) * i);
    const y = CHART.padding.top + INNER.h - (i / ticks) * INNER.h;
    lines.push(
      `<line x1="${CHART.padding.left}" y1="${y.toFixed(1)}" x2="${CHART.padding.left + INNER.w}" y2="${y.toFixed(1)}" stroke="#eee"/>`,
      `<text x="${CHART.padding.left - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#666">${val}</text>`
    );
  }
  lines.push(
    `<text transform="rotate(-90)" x="${-(CHART.padding.top + INNER.h / 2)}" y="14"
      text-anchor="middle" font-size="10" fill="#666">${escHtml(label)}</text>`
  );
  return lines.join("\n");
}

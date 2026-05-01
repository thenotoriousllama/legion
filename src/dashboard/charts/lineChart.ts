import { CHART, INNER, emptyChart, escHtml, renderXAxis, renderYAxis } from "./chartUtils";

export interface LineSeries {
  date: string;
  value: number;
}

export interface LineChartOptions {
  title: string;
  yLabel: string;
  color: string;
}

/**
 * Render a simple line chart as an SVG string.
 * Data points are rendered as circles on a polyline.
 */
export function renderLineChart(series: LineSeries[], opts: LineChartOptions): string {
  if (series.length === 0) return emptyChart(opts.title);

  const maxY = Math.max(...series.map((s) => s.value)) * 1.1 || 1;
  const minDate = new Date(series[0].date).getTime();
  const maxDate = new Date(series[series.length - 1].date).getTime();
  const dateRange = maxDate - minDate || 1;

  const toX = (date: string): number =>
    CHART.padding.left + ((new Date(date).getTime() - minDate) / dateRange) * INNER.w;

  const toY = (value: number): number =>
    CHART.padding.top + INNER.h - (value / maxY) * INNER.h;

  const pointsStr = series
    .map((s) => `${toX(s.date).toFixed(1)},${toY(s.value).toFixed(1)}`)
    .join(" ");

  const circles = series
    .map(
      (s) =>
        `<circle cx="${toX(s.date).toFixed(1)}" cy="${toY(s.value).toFixed(1)}" r="3" fill="${opts.color}"/>`
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CHART.width}" height="${CHART.height}" role="img">
  <title>${escHtml(opts.title)}</title>
  ${renderYAxis(maxY, opts.yLabel)}
  ${renderXAxis(series.map((s) => s.date))}
  <polyline fill="none" stroke="${opts.color}" stroke-width="2" points="${pointsStr}"/>
  ${circles}
  <text x="${CHART.width / 2}" y="${CHART.height - 4}" text-anchor="middle" font-size="12" fill="#666">${escHtml(opts.title)}</text>
</svg>`;
}

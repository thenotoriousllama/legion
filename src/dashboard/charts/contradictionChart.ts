import type { Snapshot } from "../../driver/snapshotManager";
import { renderLineChart } from "./lineChart";

/**
 * Render a line chart of contradiction rate (contradictionsDetected per snapshot pass).
 */
export function renderContradictionChart(snapshots: Snapshot[]): string {
  const series = snapshots.map((s) => ({
    date: s.date,
    value: s.contradictionsDetected,
  }));

  return renderLineChart(series, {
    title: "Contradiction Rate Over Time",
    yLabel: "Count",
    color: "#ef4444",
  });
}

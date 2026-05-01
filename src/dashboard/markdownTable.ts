import type { Snapshot } from "../driver/snapshotManager";

/**
 * Build a Markdown table string for clipboard export from a given chart ID.
 */
export function buildMarkdownTable(chartId: string, snapshots: Snapshot[]): string {
  switch (chartId) {
    case "entity-count":
      return entityCountTable(snapshots);
    case "maturity":
      return maturityTable(snapshots);
    case "adr-rate":
      return adrRateTable(snapshots);
    case "contradiction-rate":
      return contradictionTable(snapshots);
    default:
      return `No table available for chart "${chartId}".`;
  }
}

function entityCountTable(snapshots: Snapshot[]): string {
  const header = "| Date | Total Entities |\n|---|---|";
  const rows = snapshots.map(
    (s) => `| ${s.date.slice(0, 10)} | ${s.entityCount} |`
  );
  return [header, ...rows].join("\n");
}

function maturityTable(snapshots: Snapshot[]): string {
  const header = "| Date | Seed | Developing | Mature | Evergreen |\n|---|---|---|---|---|";
  const rows = snapshots.map(
    (s) =>
      `| ${s.date.slice(0, 10)} | ${s.byStatus.seed} | ${s.byStatus.developing} | ${s.byStatus.mature} | ${s.byStatus.evergreen} |`
  );
  return [header, ...rows].join("\n");
}

function adrRateTable(snapshots: Snapshot[]): string {
  // Group by month
  const byMonth = new Map<string, number>();
  for (const s of snapshots) {
    const month = s.date.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + s.adrCount);
  }
  const header = "| Month | ADRs Filed |\n|---|---|";
  const rows = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, count]) => `| ${month} | ${count} |`);
  return [header, ...rows].join("\n");
}

function contradictionTable(snapshots: Snapshot[]): string {
  const header = "| Date | Contradictions Detected |\n|---|---|";
  const rows = snapshots.map(
    (s) => `| ${s.date.slice(0, 10)} | ${s.contradictionsDetected} |`
  );
  return [header, ...rows].join("\n");
}

import * as fs from "fs/promises";
import * as path from "path";
import { parseFrontmatter } from "../util/frontmatter";

const WIKI_ENTITY_DIR = path.join("library", "knowledge-base", "wiki", "entities");
const CONFIG_PATH = path.join(".legion", "config.json");

const STATUS_ORDER = ["evergreen", "mature", "developing", "seed", "stub"];

export interface WikiCoverage {
  total: number;
  /** e.g. { seed: 12, developing: 8, mature: 3, evergreen: 2, stub: 4 } */
  byStatus: Record<string, number>;
  /** e.g. { "src/auth": { total: 5, mature: 3 } } */
  byModule: Record<string, { total: number; mature: number }>;
  /** Percentage of entities at status "mature" or "evergreen" */
  maturityPct: number;
  updatedAt: string;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function computeCoverage(repoRoot: string): Promise<WikiCoverage> {
  const entityDir = path.join(repoRoot, WIKI_ENTITY_DIR);
  const byStatus: Record<string, number> = {};
  const byModule: Record<string, { total: number; mature: number }> = {};
  let total = 0;

  let files: string[];
  try {
    files = await fs.readdir(entityDir);
  } catch {
    return emptycoverage();
  }

  for (const file of files) {
    if (!file.endsWith(".md") || file.startsWith("_")) continue;

    try {
      const content = await fs.readFile(path.join(entityDir, file), "utf8");
      const fm = parseFrontmatter(content);
      const status = fm["status"] ?? "seed";
      const modulePath = (fm["path"] ?? "").split("/")[0] ?? "other";

      byStatus[status] = (byStatus[status] ?? 0) + 1;

      if (!byModule[modulePath]) byModule[modulePath] = { total: 0, mature: 0 };
      byModule[modulePath].total++;
      if (status === "mature" || status === "evergreen") {
        byModule[modulePath].mature++;
      }

      total++;
    } catch {
      // skip unreadable
    }
  }

  const matureCount = (byStatus["mature"] ?? 0) + (byStatus["evergreen"] ?? 0);
  const maturityPct = total > 0 ? Math.round((matureCount / total) * 100) : 0;

  return { total, byStatus, byModule, maturityPct, updatedAt: new Date().toISOString() };
}

export async function saveCoverage(repoRoot: string, coverage: WikiCoverage): Promise<void> {
  const configPath = path.join(repoRoot, CONFIG_PATH);
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch {}
  config.wiki_coverage = coverage;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

export async function loadCoverage(repoRoot: string): Promise<WikiCoverage | null> {
  const configPath = path.join(repoRoot, CONFIG_PATH);
  try {
    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
    return (config.wiki_coverage as WikiCoverage) ?? null;
  } catch {
    return null;
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────

/**
 * Build a compact progress bar string using Unicode block characters.
 * e.g. "████░░░░░░ 40%"
 */
export function buildProgressBar(pct: number, width = 10): string {
  const filled = Math.round((pct / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled) + ` ${pct}%`;
}

/**
 * Build a one-line coverage summary for the sidebar status card.
 * e.g. "████░░░░░░ 40% mature  (25 entities)"
 */
export function buildCoverageSummary(c: WikiCoverage): string {
  const bar = buildProgressBar(c.maturityPct);
  const parts = STATUS_ORDER
    .filter((s) => (c.byStatus[s] ?? 0) > 0)
    .map((s) => `${c.byStatus[s]} ${s}`);
  return `${bar} mature  (${c.total} entities: ${parts.join(" · ")})`;
}

/**
 * Build per-module breakdown lines for the Quick Pick detail view.
 */
export function buildModuleBreakdown(c: WikiCoverage): string[] {
  return Object.entries(c.byModule)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([mod, { total, mature }]) => {
      const pct = total > 0 ? Math.round((mature / total) * 100) : 0;
      return `${mod}: ${buildProgressBar(pct, 8)} (${mature}/${total} mature)`;
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptycoverage(): WikiCoverage {
  return {
    total: 0,
    byStatus: {},
    byModule: {},
    maturityPct: 0,
    updatedAt: new Date().toISOString(),
  };
}

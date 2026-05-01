import * as fs from "fs/promises";
import * as path from "path";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Snapshot {
  date: string;
  entityCount: number;
  byStatus: {
    seed: number;
    developing: number;
    mature: number;
    evergreen: number;
  };
  byModule: Record<string, ModuleCoverage>;
  adrCount: number;
  contradictionsDetected: number;
  contradictionsResolved: number;
  maturityPct: number;
}

export interface ModuleCoverage {
  total: number;
  mature: number;
  pct: number; // 0-100
}

// ── Constants ──────────────────────────────────────────────────────────────────

const SNAPSHOT_DIR = ".legion/snapshots";
const MAX_SNAPSHOTS = 90;

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Persist a snapshot to `.legion/snapshots/<ISO-timestamp>.json`.
 * Automatically prunes old snapshots beyond MAX_SNAPSHOTS.
 */
export async function writeSnapshot(
  repoRoot: string,
  data: Omit<Snapshot, "date">
): Promise<void> {
  const dir = path.join(repoRoot, SNAPSHOT_DIR);
  await fs.mkdir(dir, { recursive: true });

  const snapshot: Snapshot = { date: new Date().toISOString(), ...data };
  // Replace colons and dots with hyphens so the filename is safe on all platforms
  const filename = snapshot.date.replace(/[:.]/g, "-") + ".json";
  await fs.writeFile(path.join(dir, filename), JSON.stringify(snapshot, null, 2), "utf8");

  await pruneOld(repoRoot);
}

/**
 * Load all snapshots from `.legion/snapshots/`, sorted chronologically.
 * Silently skips malformed JSON files.
 */
export async function loadSnapshots(repoRoot: string): Promise<Snapshot[]> {
  const dir = path.join(repoRoot, SNAPSHOT_DIR);
  try {
    const files = (await fs.readdir(dir))
      .filter((f) => f.endsWith(".json"))
      .sort(); // ISO date filenames sort lexicographically = chronologically

    const snapshots: Snapshot[] = [];
    for (const file of files) {
      try {
        const raw = await fs.readFile(path.join(dir, file), "utf8");
        snapshots.push(JSON.parse(raw) as Snapshot);
      } catch {
        // skip malformed file
      }
    }
    return snapshots;
  } catch {
    return [];
  }
}

/**
 * Delete the oldest snapshot files when count exceeds MAX_SNAPSHOTS.
 */
export async function pruneOld(repoRoot: string): Promise<void> {
  const dir = path.join(repoRoot, SNAPSHOT_DIR);
  try {
    const files = (await fs.readdir(dir))
      .filter((f) => f.endsWith(".json"))
      .sort();

    if (files.length <= MAX_SNAPSHOTS) return;

    const toDelete = files.slice(0, files.length - MAX_SNAPSHOTS);
    await Promise.all(
      toDelete.map((f) => fs.unlink(path.join(dir, f)).catch(() => undefined))
    );
  } catch {
    // non-fatal
  }
}

/**
 * Tests for src/driver/snapshotManager.ts
 *
 * NOTE: Stubs. Full coverage tracked in library/qa/2026-04-30-qa-report.md.
 * Integration tests require a real temp directory.
 */

import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { writeSnapshot, loadSnapshots, pruneOld } from "./snapshotManager";

const STUB_SNAPSHOT = {
  entityCount: 42,
  byStatus: { seed: 10, developing: 15, mature: 12, evergreen: 5 },
  byModule: {},
  adrCount: 3,
  contradictionsDetected: 1,
  contradictionsResolved: 0,
  maturityPct: 40,
};

describe("snapshotManager", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "legion-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writeSnapshot creates a file", async () => {
    await writeSnapshot(tmpDir, STUB_SNAPSHOT);
    const snapshots = await loadSnapshots(tmpDir);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].entityCount).toBe(42);
  });

  it("loadSnapshots returns empty array when directory missing", async () => {
    const snapshots = await loadSnapshots(path.join(tmpDir, "nonexistent"));
    expect(snapshots).toEqual([]);
  });

  it("pruneOld removes files beyond 90", async () => {
    // Write 92 snapshots (via direct file creation to avoid real delays)
    const snapshotsDir = path.join(tmpDir, ".legion", "snapshots");
    await fs.mkdir(snapshotsDir, { recursive: true });
    for (let i = 0; i < 92; i++) {
      const d = new Date(2026, 0, 1, 0, i).toISOString().replace(/[:.]/g, "-");
      await fs.writeFile(
        path.join(snapshotsDir, `${d}.json`),
        JSON.stringify({ ...STUB_SNAPSHOT, date: new Date(2026, 0, 1, 0, i).toISOString() })
      );
    }
    await pruneOld(tmpDir);
    const files = (await fs.readdir(snapshotsDir)).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(90);
  });
});

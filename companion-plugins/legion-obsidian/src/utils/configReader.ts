import type { App } from "obsidian";

export interface Contradiction {
  id: string;
  pageA: string;
  pageB: string;
  description: string;
  detectedAt: string;
  resolved: boolean;
}

export interface LegionConfig {
  initialized?: boolean;
  lastScanDate?: string;
  entityCount?: number;
  wikiPath?: string;
  contradictions?: Contradiction[];
  coveragePct?: number;
}

const CONFIG_PATH = ".legion/config.json";

/** Read and parse `.legion/config.json`. Returns null if absent or malformed. */
export async function readConfig(app: App): Promise<LegionConfig | null> {
  try {
    const raw = await app.vault.adapter.read(CONFIG_PATH);
    return JSON.parse(raw) as LegionConfig;
  } catch {
    return null;
  }
}

/**
 * Write updated config back to `.legion/config.json`.
 * Always writes a `.bak` backup first as a single-slot safety net.
 */
export async function writeConfig(app: App, config: LegionConfig): Promise<void> {
  try {
    const current = await app.vault.adapter.read(CONFIG_PATH);
    await app.vault.adapter.write(CONFIG_PATH + ".bak", current);
  } catch {
    // backup failed (file may not exist yet) — proceed anyway
  }

  // Write guard: abort if file was modified within the last 500ms by another process
  try {
    const stat = await app.vault.adapter.stat(CONFIG_PATH);
    if (stat && Date.now() - stat.mtime < 500) {
      throw new Error("Config file was recently modified. Retry in a moment.");
    }
  } catch (e) {
    if ((e as Error).message.includes("recently modified")) throw e;
    // stat failed = file doesn't exist yet — fine
  }

  await app.vault.adapter.write(CONFIG_PATH, JSON.stringify(config, null, 2));
}

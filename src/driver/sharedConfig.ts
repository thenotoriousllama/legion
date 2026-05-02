import * as fs from "fs/promises";
import * as path from "path";
import type { LegionIgnore } from "./legionignore";
import { loadLegionIgnore } from "./legionignore";

const SHARED_DIR = ".legion-shared";
const SHARED_CONFIG = path.join(SHARED_DIR, "config.json");
const SHARED_IGNORE = path.join(SHARED_DIR, "legionignore");

export interface SharedConfig {
  version: number;
  /** Guardian names to pre-select on Initialize */
  guardians_default?: string[];
  /** Extra file extensions to ignore (e.g. [".min.js", ".bundle.js"]) */
  ignore_extensions?: string[];
  /** Log fold schedule hint */
  fold_schedule?: "daily" | "weekly" | "manual";
  /** Override for maxParallelAgents */
  max_parallel_agents?: number;
  /** Override for the default Claude model */
  model?: string;
  /** API provider override */
  api_provider?: "anthropic" | "openrouter";
  /** Shared research topics — processed on every Drain Agenda, never marked done */
  research_agenda_shared?: string[];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load `.legion-shared/config.json` if it exists.
 * Returns null when no shared config is present (first-time repo, no team config yet).
 */
export async function loadSharedConfig(repoRoot: string): Promise<SharedConfig | null> {
  const p = path.join(repoRoot, SHARED_CONFIG);
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as SharedConfig;
  } catch {
    return null;
  }
}

/**
 * Write `.legion-shared/config.json`.
 */
export async function saveSharedConfig(repoRoot: string, config: SharedConfig): Promise<void> {
  const dir = path.join(repoRoot, SHARED_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(repoRoot, SHARED_CONFIG), JSON.stringify(config, null, 2));
}

/**
 * Merge `.legion-shared/legionignore` patterns into the base `LegionIgnore` instance.
 * Returns the base instance unmodified when no shared ignore file exists.
 */
export async function mergeSharedIgnore(
  repoRoot: string,
  baseIgnore: LegionIgnore
): Promise<LegionIgnore> {
  const sharedIgnorePath = path.join(repoRoot, SHARED_IGNORE);
  try {
    await fs.access(sharedIgnorePath);
    // A shared legionignore exists — load it as a separate LegionIgnore and combine
    const sharedIgnore = await loadLegionIgnoreFromPath(repoRoot, sharedIgnorePath);
    return combinedIgnore(baseIgnore, sharedIgnore);
  } catch {
    return baseIgnore; // No shared ignore — use base as-is
  }
}

/**
 * Ensure the `.legion-shared/` directory exists with a README explaining it
 * should be committed.
 */
export async function ensureSharedDir(repoRoot: string): Promise<void> {
  const dir = path.join(repoRoot, SHARED_DIR);
  await fs.mkdir(dir, { recursive: true });
  const readmePath = path.join(dir, "README.md");
  try {
    await fs.access(readmePath);
  } catch {
    await fs.writeFile(
      readmePath,
      [
        `# .legion-shared/`,
        ``,
        `This directory contains team-wide Legion configuration.`,
        `**Commit this directory to share it with all collaborators.**`,
        ``,
        `## Files`,
        ``,
        `- \`config.json\` — guardian defaults, model, parallel agents, research agenda topics`,
        `- \`legionignore\` — additional ignore patterns (extends \`.legionignore\`)`,
        ``,
        `## Notes`,
        ``,
        `- \`.legion/\` (sibling directory) contains local-only machine state — do NOT commit it.`,
        `- \`.legion-shared/\` is safe to commit and should be committed.`,
        ``,
      ].join("\n")
    );
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

async function loadLegionIgnoreFromPath(
  repoRoot: string,
  filePath: string
): Promise<LegionIgnore> {
  // We can't call loadLegionIgnore() directly (it reads .legionignore by name),
  // so we construct a temporary root pointing at the shared ignore file's directory.
  // Instead, inline a minimal pattern loader:
  const content = await fs.readFile(filePath, "utf8");
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  const matchers = lines.map((pattern) => compilePattern(repoRoot, pattern));

  return {
    shouldIgnore(absPath: string): boolean {
      return matchers.some((m) => m(absPath));
    },
  };
}

function compilePattern(repoRoot: string, raw: string): (absPath: string) => boolean {
  // Minimal gitignore-style pattern matcher (same logic as legionignore.ts)
  let pattern = raw;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  }

  const isDir = pattern.endsWith("/");
  if (isDir) pattern = pattern.slice(0, -1);

  let r = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  r = r.replace(/\*\*/g, "::DS::").replace(/\*/g, "[^/]*").replace(/::DS::/g, ".*").replace(/\?/g, "[^/]");

  if (r.startsWith("/")) {
    r = "^" + r.slice(1);
  } else {
    // v1.2.19: was `(^|.*/)$` — the trailing `$` was a typo that anchored
    // mid-pattern, making every shared-ignore pattern a dead match.
    r = "(^|.*/)" + r;
  }
  if (isDir) {
    r += "(/.*)?$";
  } else {
    r += "($|/.*)";
  }

  const regex = new RegExp(r);
  return (absPath: string) => {
    const rel = absPath.replace(repoRoot, "").replace(/\\/g, "/").replace(/^\//, "");
    const match = regex.test(rel);
    return negated ? !match : match;
  };
}

function combinedIgnore(a: LegionIgnore, b: LegionIgnore): LegionIgnore {
  return {
    shouldIgnore(absPath: string): boolean {
      return a.shouldIgnore(absPath) || b.shouldIgnore(absPath);
    },
  };
}

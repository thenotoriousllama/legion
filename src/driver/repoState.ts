import * as fs from "fs/promises";
import * as path from "path";
import { loadManifest, saveManifest } from "./hashDiff";

export interface RepoState {
  /** True if `library/knowledge-base/wiki/` exists in the repo root. */
  initialized: boolean;
  /** ISO-8601 string of last successful scan, or null if never scanned. */
  lastScan: string | null;
  /** Number of entity pages currently in the wiki. */
  pageCount: number;
  /** True if `.legion/` local-state folder exists. */
  hasLocalState: boolean;
}

const WIKI_REL = path.join("library", "knowledge-base", "wiki");
const LEGION_DIR = ".legion";
const ENTITY_DIR = path.join(WIKI_REL, "entities");

/**
 * Probe the repo root and return the current initialization state.
 *
 * This is the single source of truth for whether Legion has been set up in
 * this repo. The canonical signal is the presence of `library/knowledge-base/wiki/`
 * (which is committed and shared by all collaborators), NOT `.legion/` (which
 * is gitignored local state and may be absent on a fresh clone).
 */
export async function detectRepoState(repoRoot: string): Promise<RepoState> {
  if (!repoRoot) {
    return { initialized: false, lastScan: null, pageCount: 0, hasLocalState: false };
  }

  const wikiPath = path.join(repoRoot, WIKI_REL);
  const legionPath = path.join(repoRoot, LEGION_DIR);

  const [wikiExists, legionExists] = await Promise.all([
    exists(wikiPath),
    exists(legionPath),
  ]);

  if (!wikiExists) {
    return { initialized: false, lastScan: null, pageCount: 0, hasLocalState: legionExists };
  }

  // Wiki exists — read last_scan from the local manifest (if available)
  const manifest = await loadManifest(repoRoot);

  // Count entity pages as a proxy for wiki richness
  let pageCount = 0;
  try {
    const entityDir = path.join(repoRoot, ENTITY_DIR);
    const files = await fs.readdir(entityDir);
    pageCount = files.filter((f) => f.endsWith(".md") && !f.startsWith("_")).length;
  } catch {
    // entities/ not yet populated — that's fine
  }

  return {
    initialized: true,
    lastScan: manifest.last_scan,
    pageCount,
    hasLocalState: legionExists,
  };
}

/**
 * If the repo wiki exists but the local `.legion/` state folder is missing
 * (fresh clone by a collaborator), scaffold the minimal local state so
 * Document/Update commands work without requiring re-initialization.
 *
 * This is idempotent and safe to call on every activation.
 */
export async function ensureLocalState(repoRoot: string): Promise<void> {
  if (!repoRoot) return;

  const legionDir = path.join(repoRoot, LEGION_DIR);
  const wikiPath = path.join(repoRoot, WIKI_REL);

  // Only scaffold if wiki exists but .legion/ doesn't
  if (!(await exists(wikiPath))) return;
  if (await exists(legionDir)) return;

  // Scaffold the local state dirs
  await Promise.all([
    fs.mkdir(path.join(legionDir, "queue"), { recursive: true }),
    fs.mkdir(path.join(legionDir, "git-cache"), { recursive: true }),
    fs.mkdir(path.join(legionDir, "chunks"), { recursive: true }),
  ]);

  // Write an empty hash manifest so Update doesn't treat everything as new
  // Note: last_scan = null means Update will treat all files as "added",
  // which is the safest behavior for a fresh clone (equivalent to Document).
  await saveManifest(repoRoot, { files: {}, last_scan: null });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

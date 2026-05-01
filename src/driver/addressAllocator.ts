import * as fs from "fs/promises";
import * as path from "path";
import { parseFrontmatter } from "../util/frontmatter";

const COUNTER_PATH = path.join(".legion", "address-counter.txt");
const WIKI_REL = path.join("library", "knowledge-base", "wiki");

/** Dirs whose pages should NOT receive addresses (meta/operational). */
const SKIP_DIRS = new Set(["meta", "folds"]);

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read the next address that would be allocated without consuming it.
 * Returns "c-000001" if the counter file doesn't exist yet.
 */
export async function peekNextAddress(repoRoot: string): Promise<string> {
  const n = await readCounter(repoRoot);
  return formatAddress(n);
}

/**
 * Atomically reserve the next address, increment the counter, and return
 * the reserved address. Caller is responsible for serialising calls —
 * do NOT call from parallel workers.
 */
export async function allocateAddress(repoRoot: string): Promise<string> {
  const n = await readCounter(repoRoot);
  await writeCounter(repoRoot, n + 1);
  return formatAddress(n);
}

/**
 * Rebuild the counter by scanning all wiki pages for existing `address:` fields
 * and setting the counter to max+1. Safe to call at any time.
 */
export async function rebuildCounter(repoRoot: string): Promise<void> {
  const wikiRoot = path.join(repoRoot, WIKI_REL);
  let max = 0;

  const dirs = ["entities", "concepts", "decisions", "comparisons", "questions", "sources"];
  for (const dir of dirs) {
    const dirPath = path.join(wikiRoot, dir);
    let files: string[];
    try {
      files = await fs.readdir(dirPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      try {
        const content = await fs.readFile(path.join(dirPath, file), "utf8");
        const fm = parseFrontmatter(content);
        const addr = fm["address"] ?? "";
        const m = addr.match(/^c-(\d+)$/);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      } catch {
        // skip
      }
    }
  }
  await writeCounter(repoRoot, max + 1);
}

/**
 * Post-process newly created wiki pages to inject `address:` frontmatter
 * for any page that doesn't already have one. Called sequentially (no
 * parallel allocation) to preserve counter monotonicity.
 *
 * @param repoRoot  Absolute path to repo root
 * @param wikiRoot  Absolute path to wiki root (library/knowledge-base/wiki)
 * @param newPages  Wiki-root-relative paths of newly created pages
 */
export async function injectAddresses(
  repoRoot: string,
  wikiRoot: string,
  newPages: string[]
): Promise<void> {
  // Only inject if the counter file exists (feature flag: created by Initialize)
  if (!(await counterExists(repoRoot))) return;

  for (const pagePath of newPages) {
    // Skip meta and fold pages
    const firstSegment = pagePath.replace(/\\/g, "/").split("/")[0];
    if (SKIP_DIRS.has(firstSegment)) continue;

    const absPath = path.join(wikiRoot, pagePath.replace(/\//g, path.sep));
    try {
      const content = await fs.readFile(absPath, "utf8");
      const fm = parseFrontmatter(content);
      if (fm["address"]) continue; // already has one

      const address = await allocateAddress(repoRoot);
      const updated = injectFrontmatterField(content, "address", address);
      await fs.writeFile(absPath, updated);
    } catch {
      // Page may have been deleted or never written — skip silently.
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatAddress(n: number): string {
  return `c-${String(n).padStart(6, "0")}`;
}

async function readCounter(repoRoot: string): Promise<number> {
  const p = path.join(repoRoot, COUNTER_PATH);
  try {
    const raw = (await fs.readFile(p, "utf8")).trim();
    const n = parseInt(raw, 10);
    return isNaN(n) || n < 1 ? 1 : n;
  } catch {
    return 1;
  }
}

async function writeCounter(repoRoot: string, n: number): Promise<void> {
  const p = path.join(repoRoot, COUNTER_PATH);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, String(n));
}

async function counterExists(repoRoot: string): Promise<boolean> {
  try {
    await fs.access(path.join(repoRoot, COUNTER_PATH));
    return true;
  } catch {
    return false;
  }
}

/**
 * Inject a frontmatter field immediately after the opening `---` line.
 * If no frontmatter exists, prepend a minimal block.
 */
function injectFrontmatterField(content: string, field: string, value: string): string {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() === "---") {
    // Insert after opening ---
    lines.splice(1, 0, `${field}: ${value}`);
    return lines.join("\n");
  }
  // No frontmatter — prepend
  return `---\n${field}: ${value}\n---\n\n${content}`;
}

import * as fs from "fs/promises";
import * as path from "path";
import type { ChunkFile, Mode } from "../types/payload";

export interface PlannedChunk {
  /** Human-readable label for logging/UI ("src/auth (3 files)"). */
  label: string;
  /** Files in this chunk (repo-relative, forward-slash). */
  files: string[];
}

/**
 * Default cap when the caller doesn't pass an explicit `maxFilesPerChunk`.
 * Was 6 in v1.2.15 and earlier (bottom of the wiki-weapon sweet spot).
 * Bumped to 8 (top of sweet spot) in v1.2.16 to halve LLM call counts on
 * large repos. Users can override via `legion.maxFilesPerChunk` (4–30).
 */
const DEFAULT_MAX_FILES_PER_CHUNK = 8;

/**
 * Plan chunks for a Document/Update/Scan-Directory pass.
 *
 * Groups `filesToScan` (absolute paths) by their top-level module boundary.
 * If a module group exceeds `maxFilesPerChunk`, it is split into ordered
 * sub-chunks so each stays under the 8–15 page-per-chunk target from the
 * wiki-weapon atomic-page rule (roughly 1 file → 1–3 pages, so 4–8 files
 * per chunk is the sweet spot; 12–20 trades atomicity for speed on huge
 * repos and is opt-in via the user setting).
 *
 * The planner is mode-agnostic: the caller is responsible for filtering
 * `filesToScan` to just the files that need processing.
 */
export function planChunks(
  repoRoot: string,
  filesToScan: string[], // absolute paths
  _mode: Mode,
  maxFilesPerChunk: number = DEFAULT_MAX_FILES_PER_CHUNK
): PlannedChunk[] {
  const cap = Math.max(1, Math.floor(maxFilesPerChunk));
  if (filesToScan.length === 0) return [];

  // Group files by top-level module
  const groups = new Map<string, string[]>();
  for (const abs of filesToScan) {
    const mod = topLevelModule(repoRoot, abs);
    const rel = path.relative(repoRoot, abs).replace(/\\/g, "/");
    const list = groups.get(mod) ?? [];
    list.push(rel);
    groups.set(mod, list);
  }

  const chunks: PlannedChunk[] = [];
  for (const [mod, files] of groups) {
    const totalParts = Math.ceil(files.length / cap);
    for (let i = 0; i < files.length; i += cap) {
      const slice = files.slice(i, i + cap);
      const partSuffix =
        totalParts > 1
          ? ` [${Math.floor(i / cap) + 1}/${totalParts}]`
          : "";
      chunks.push({
        label: `${mod} (${slice.length} file${slice.length !== 1 ? "s" : ""})${partSuffix}`,
        files: slice,
      });
    }
  }

  return chunks;
}

export interface LoadChunkResult {
  files: ChunkFile[];
  /** Files dropped because they exceeded `maxFileSizeBytes`. */
  oversize: { path: string; sizeBytes: number }[];
  /** Files we couldn't read (deleted between walk and load, perms, etc.). */
  unreadable: { path: string; reason: string }[];
}

/**
 * Hydrate a planned chunk's file list into the ChunkFile[] shape the
 * InvocationPayload expects (repo-relative path + full UTF-8 content).
 *
 * Files that disappear between the walk and the read are silently skipped —
 * the agent receives whatever is still on disk.
 *
 * v1.2.21: also drops files larger than `maxFileSizeBytes` (default ~200 KB
 * ≈ 50k tokens). The classic offender is a generated bundle, minified
 * asset, or base64-encoded blob landing in a code chunk and pushing the
 * whole prompt past the model's context window. Dropped files are surfaced
 * via the returned `oversize` array so the caller can warn the user.
 */
export async function loadChunkContent(
  repoRoot: string,
  chunk: PlannedChunk,
  maxFileSizeBytes: number = Number.POSITIVE_INFINITY
): Promise<ChunkFile[]> {
  const detailed = await loadChunkContentDetailed(repoRoot, chunk, maxFileSizeBytes);
  return detailed.files;
}

export async function loadChunkContentDetailed(
  repoRoot: string,
  chunk: PlannedChunk,
  maxFileSizeBytes: number = Number.POSITIVE_INFINITY
): Promise<LoadChunkResult> {
  const files: ChunkFile[] = [];
  const oversize: { path: string; sizeBytes: number }[] = [];
  const unreadable: { path: string; reason: string }[] = [];

  for (const rel of chunk.files) {
    const abs = path.join(repoRoot, rel.replace(/\//g, path.sep));
    const normalized = rel.replace(/\\/g, "/");
    try {
      // Stat first so we can short-circuit on huge files without buffering
      // them. Cheaper than read + .length check on multi-MB blobs.
      const st = await fs.stat(abs);
      if (st.size > maxFileSizeBytes) {
        oversize.push({ path: normalized, sizeBytes: st.size });
        continue;
      }
      const content = await fs.readFile(abs, "utf8");
      files.push({ path: normalized, content });
    } catch (e) {
      unreadable.push({
        path: normalized,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { files, oversize, unreadable };
}

/**
 * Derive the top-level module key for a file. Handles common monorepo and
 * single-package layouts (`src/<module>`, `apps/<app>`, `packages/<pkg>`).
 * Falls back to the first path segment for anything else.
 */
export function topLevelModule(repoRoot: string, absFile: string): string {
  const rel = path.relative(repoRoot, absFile).replace(/\\/g, "/");
  const segments = rel.split("/");
  if (segments[0] === "src" && segments.length > 2) return `src/${segments[1]}`;
  if (segments[0] === "apps" && segments.length > 2) return `apps/${segments[1]}`;
  if (segments[0] === "packages" && segments.length > 2) return `packages/${segments[1]}`;
  return segments[0];
}

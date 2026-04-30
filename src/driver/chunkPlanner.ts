import * as path from "path";
import type { ChunkFile, Mode } from "../types/payload";

export interface PlannedChunk {
  /** Human-readable label for logging/UI ("auth module", "PR diff"). */
  label: string;
  /** Files in this chunk (repo-relative, forward-slash). */
  files: string[];
}

/**
 * Plan chunks for a Document/Update/Scan-Directory pass.
 *
 * v0.1.0: stub. The real implementation is the brain of the extension —
 *  - For `document`: cluster files by directory boundary, with each top-level
 *    module getting its own chunk (≤ ~10 files per chunk to fit context windows).
 *  - For `update`: each set of co-modified files in the diff becomes a chunk.
 *  - For `scan-directory`: the user-selected subtree becomes one chunk (or many
 *    if it's large).
 *
 * The 8–15 pages-per-chunk target from wiki-weapon's atomic-page rule informs
 * file count: roughly 1 file → 1–3 pages, so target 4–8 files per chunk.
 */
export function planChunks(
  _repoRoot: string,
  _filesToScan: string[],
  _mode: Mode
): PlannedChunk[] {
  // TODO v0.2.0
  return [];
}

/**
 * Convert a planned chunk's file list into the ChunkFile[] shape
 * (path + content) the InvocationPayload expects.
 */
export async function loadChunkContent(
  _repoRoot: string,
  _chunk: PlannedChunk
): Promise<ChunkFile[]> {
  // TODO v0.2.0: fs.readFile each file, return [{path, content}, ...]
  return [];
}

// Helper for v0.2.0 implementation
export function topLevelModule(repoRoot: string, absFile: string): string {
  const rel = path.relative(repoRoot, absFile).replace(/\\/g, "/");
  const segments = rel.split("/");
  // Common src layouts: src/<module>/..., apps/<app>/..., packages/<pkg>/...
  if (segments[0] === "src" && segments.length > 2) return `src/${segments[1]}`;
  if (segments[0] === "apps" && segments.length > 2) return `apps/${segments[1]}`;
  if (segments[0] === "packages" && segments.length > 2) return `packages/${segments[1]}`;
  return segments[0];
}

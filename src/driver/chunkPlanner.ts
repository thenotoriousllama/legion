import * as fs from "fs/promises";
import * as path from "path";
import type { ChunkFile, Mode } from "../types/payload";

export interface PlannedChunk {
  /** Human-readable label for logging/UI ("src/auth (3 files)"). */
  label: string;
  /** Files in this chunk (repo-relative, forward-slash). */
  files: string[];
}

/** Soft cap: split modules larger than this into sub-chunks. */
const MAX_FILES_PER_CHUNK = 6;

/**
 * Plan chunks for a Document/Update/Scan-Directory pass.
 *
 * Groups `filesToScan` (absolute paths) by their top-level module boundary.
 * If a module group exceeds MAX_FILES_PER_CHUNK, it is split into ordered
 * sub-chunks so each stays under the 8–15 page-per-chunk target from the
 * wiki-weapon atomic-page rule (roughly 1 file → 1–3 pages, so 4–8 files
 * per chunk is the sweet spot).
 *
 * The planner is mode-agnostic: the caller is responsible for filtering
 * `filesToScan` to just the files that need processing (all files for
 * `document`, only added+modified for `update`, subtree for `scan-directory`).
 */
export function planChunks(
  repoRoot: string,
  filesToScan: string[], // absolute paths
  _mode: Mode
): PlannedChunk[] {
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
    const totalParts = Math.ceil(files.length / MAX_FILES_PER_CHUNK);
    for (let i = 0; i < files.length; i += MAX_FILES_PER_CHUNK) {
      const slice = files.slice(i, i + MAX_FILES_PER_CHUNK);
      const partSuffix =
        totalParts > 1
          ? ` [${Math.floor(i / MAX_FILES_PER_CHUNK) + 1}/${totalParts}]`
          : "";
      chunks.push({
        label: `${mod} (${slice.length} file${slice.length !== 1 ? "s" : ""})${partSuffix}`,
        files: slice,
      });
    }
  }

  return chunks;
}

/**
 * Hydrate a planned chunk's file list into the ChunkFile[] shape the
 * InvocationPayload expects (repo-relative path + full UTF-8 content).
 *
 * Files that disappear between the walk and the read are silently skipped —
 * the agent receives whatever is still on disk.
 */
export async function loadChunkContent(
  repoRoot: string,
  chunk: PlannedChunk
): Promise<ChunkFile[]> {
  const result: ChunkFile[] = [];
  for (const rel of chunk.files) {
    const abs = path.join(repoRoot, rel.replace(/\//g, path.sep));
    try {
      const content = await fs.readFile(abs, "utf8");
      result.push({ path: rel.replace(/\\/g, "/"), content });
    } catch (e) {
      console.warn(
        `Legion [chunkPlanner]: skipping unreadable file "${rel}" — ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }
  return result;
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

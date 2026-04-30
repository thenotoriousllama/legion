import * as fs from "fs/promises";
import * as crypto from "crypto";
import * as path from "path";

export interface FileHashEntry {
  hash: string; // SHA-256 hex
  ingested_at: string; // ISO-8601
  /** Wiki page paths (relative to wiki_root) created from this source file. */
  pages_created: string[];
  /** Wiki page paths updated from this source file. */
  pages_updated: string[];
}

export interface HashManifest {
  files: Record<string, FileHashEntry>;
  /** ISO-8601 timestamp of the most recent reconciled scan, or null if never. */
  last_scan: string | null;
}

const MANIFEST_PATH = path.join(".legion", "file-hashes.json");

export async function loadManifest(repoRoot: string): Promise<HashManifest> {
  const p = path.join(repoRoot, MANIFEST_PATH);
  try {
    const content = await fs.readFile(p, "utf8");
    return JSON.parse(content);
  } catch {
    return { files: {}, last_scan: null };
  }
}

export async function saveManifest(repoRoot: string, manifest: HashManifest): Promise<void> {
  const p = path.join(repoRoot, MANIFEST_PATH);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(manifest, null, 2));
}

export async function hashFile(absPath: string): Promise<string> {
  const content = await fs.readFile(absPath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

export interface DiffResult {
  /** Files present in the chunk but not in the manifest. */
  added: string[];
  /** Files whose hash differs from the manifest. */
  modified: string[];
  /** Files unchanged since last scan. */
  unchanged: string[];
}

/**
 * Compute the hash diff for a set of absolute file paths against the manifest.
 * All result paths are repo-relative and forward-slash-normalized.
 */
export async function diffFiles(
  repoRoot: string,
  absFiles: string[]
): Promise<DiffResult> {
  const manifest = await loadManifest(repoRoot);
  const added: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];

  for (const abs of absFiles) {
    const rel = path.relative(repoRoot, abs).replace(/\\/g, "/");
    const currentHash = await hashFile(abs);
    const prior = manifest.files[rel];
    if (!prior) {
      added.push(rel);
    } else if (prior.hash !== currentHash) {
      modified.push(rel);
    } else {
      unchanged.push(rel);
    }
  }

  return { added, modified, unchanged };
}

/**
 * Update the manifest with new entries from a completed scan.
 * Caller is responsible for invoking saveManifest() after.
 */
export function updateManifestEntry(
  manifest: HashManifest,
  relPath: string,
  hash: string,
  pagesCreated: string[],
  pagesUpdated: string[]
): void {
  manifest.files[relPath] = {
    hash,
    ingested_at: new Date().toISOString(),
    pages_created: pagesCreated,
    pages_updated: pagesUpdated,
  };
}

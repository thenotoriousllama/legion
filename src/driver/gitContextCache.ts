/**
 * Disk cache for per-file git context, keyed on HEAD SHA.
 *
 * Lives at `.legion/git-context-cache.json` next to the existing
 * file-hashes manifest. The cache stores:
 *   - `head_sha` of the HEAD when the cache was last validated
 *   - `entries[relPath]` = the FileGitContext we computed for that file
 *
 * Invalidation is staged:
 *   1. Cheap (most-common path): if `git rev-parse HEAD` matches the cached
 *      head_sha, every entry is still valid — no recompute, just lookup.
 *   2. Diff-based: if HEAD has moved, run ONE
 *        `git diff --name-only <cachedHead> HEAD`
 *      to learn which files were touched. Recompute only those plus any
 *      file that wasn't in the cache to begin with. Reuse the rest.
 *
 * Net effect on a typical Update flow (small commits, ~few files touched):
 * 95–99% cache hit → git phase drops from "spawn 4 git subprocesses per
 * file" to "1 git rev-parse + 1 git diff + cold-compute the touched files".
 */
import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { FileGitContext } from "../types/payload";
import { getGitContextMany } from "./gitContext";

const exec = promisify(execFile);
const CACHE_FILE = path.join(".legion", "git-context-cache.json");
const CACHE_VERSION = 1 as const;

interface GitContextCache {
  version: typeof CACHE_VERSION;
  /** HEAD SHA at the time the cache was last (re-)validated. */
  head_sha: string;
  /** Repo-relative forward-slash path → cached context. */
  entries: Record<string, FileGitContext>;
}

async function loadCache(repoRoot: string): Promise<GitContextCache | null> {
  try {
    const raw = await fs.readFile(path.join(repoRoot, CACHE_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<GitContextCache>;
    if (parsed.version !== CACHE_VERSION) return null;
    if (typeof parsed.head_sha !== "string" || !parsed.head_sha) return null;
    if (!parsed.entries || typeof parsed.entries !== "object") return null;
    return parsed as GitContextCache;
  } catch {
    return null;
  }
}

async function saveCache(repoRoot: string, cache: GitContextCache): Promise<void> {
  const p = path.join(repoRoot, CACHE_FILE);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(cache, null, 2));
}

async function getCurrentHead(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
    const sha = stdout.trim();
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * Return the set of repo-relative paths changed between two commits.
 * Returns an empty set if the diff fails (e.g. cached HEAD no longer
 * exists after a rebase) — the caller will then treat the entire cache
 * as invalid and recompute everything.
 */
async function getChangedFilesSince(
  repoRoot: string,
  fromSha: string,
  toSha: string
): Promise<Set<string> | null> {
  if (fromSha === toSha) return new Set();
  try {
    const { stdout } = await exec(
      "git",
      ["diff", "--name-only", fromSha, toSha],
      { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 }
    );
    const set = new Set<string>();
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) set.add(trimmed.replace(/\\/g, "/"));
    }
    return set;
  } catch {
    return null;
  }
}

/**
 * Cached wrapper around `getGitContextMany`. Drops in wherever the
 * uncached version was used; on first run it just calls through and
 * persists the result.
 *
 * NOTE: a change in `includeBlame` flag silently invalidates the cache for
 * affected files because cached entries with empty blame would otherwise
 * persist forever. We bake includeBlame into the cache check by recomputing
 * any entry whose `blame_summary.top_authors.length === 0` when the caller
 * asked for blame.
 */
export async function getGitContextManyCached(
  context: vscode.ExtensionContext | null,
  repoRoot: string,
  absFiles: string[],
  concurrency: number,
  includeBlame: boolean
): Promise<Record<string, FileGitContext>> {
  const _unused = context; // reserved for future telemetry
  void _unused;

  // Bypass cache entirely when not in a git repo.
  const currentHead = await getCurrentHead(repoRoot);
  if (!currentHead) {
    return getGitContextMany(repoRoot, absFiles, concurrency, includeBlame);
  }

  const cache = await loadCache(repoRoot);
  let invalidated: Set<string> | null = null;

  if (cache) {
    if (cache.head_sha === currentHead) {
      invalidated = new Set();
    } else {
      invalidated = await getChangedFilesSince(repoRoot, cache.head_sha, currentHead);
      // Diff failed → cached HEAD is unreachable (rebase / shallow clone).
      // Treat all cached entries as invalid by passing null, which forces
      // the recompute path below to skip cache lookups entirely.
    }
  }

  const result: Record<string, FileGitContext> = {};
  const toRecompute: string[] = [];
  for (const abs of absFiles) {
    const rel = path.relative(repoRoot, abs).replace(/\\/g, "/");
    const cached = cache?.entries[rel];
    const blameMissing =
      includeBlame && cached !== undefined && cached.blame_summary.top_authors.length === 0;
    const fileChanged = invalidated === null || invalidated.has(rel);
    if (cached && !fileChanged && !blameMissing) {
      result[rel] = cached;
    } else {
      toRecompute.push(abs);
    }
  }

  if (toRecompute.length > 0) {
    const fresh = await getGitContextMany(repoRoot, toRecompute, concurrency, includeBlame);
    Object.assign(result, fresh);
  }

  // Persist a merged cache so that files outside this pass's scope (e.g.
  // touched by other modes) keep their entries. Entries persist across runs
  // until either the file is changed in git OR the cache file is deleted.
  const merged: GitContextCache = {
    version: CACHE_VERSION,
    head_sha: currentHead,
    entries: { ...(cache?.entries ?? {}), ...result },
  };
  try {
    await saveCache(repoRoot, merged);
  } catch {
    // Cache write failures are non-fatal — pass succeeds, next pass will
    // simply recompute. (Writable disk, perms, etc. are caller's concern.)
  }

  return result;
}

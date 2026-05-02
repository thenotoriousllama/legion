import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import type { FileGitContext } from "../types/payload";

const exec = promisify(execFile);

/**
 * Pre-compute git context for a single file, packaged in the shape
 * wiki-guardian expects in the canonical invocation payload.
 *
 * Shells out to `git` directly — no library dependency. Caller is responsible
 * for ensuring `git` is on PATH and `repoRoot` is inside a git repo.
 *
 * `includeBlame` (default false in v1.2.16+, was unconditionally true before):
 * controls whether `git blame --line-porcelain` runs. Blame is the slowest
 * git call by 5–50x; most agents only need commit history, not authorship.
 * Toggle on via the `legion.includeGitBlame` setting if you want top-author
 * and churn data in your wiki pages.
 */
export async function getGitContext(
  repoRoot: string,
  absFilePath: string,
  includeBlame: boolean = false
): Promise<FileGitContext> {
  const rel = path.relative(repoRoot, absFilePath).replace(/\\/g, "/");
  const opts = { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 };

  // Creation commit (first commit that added the file)
  let created_commit = "";
  let created_at = "";
  try {
    const { stdout } = await exec(
      "git",
      ["log", "--format=%H|%aI", "--diff-filter=A", "--", rel],
      opts
    );
    const lines = stdout.trim().split("\n").filter(Boolean);
    if (lines.length > 0) {
      const last = lines[lines.length - 1];
      const [sha, date] = last.split("|");
      created_commit = sha;
      created_at = date;
    }
  } catch {
    // file may not yet be committed
  }

  // Last commit
  let last_commit = { sha: "", author: "", timestamp: "", message: "" };
  try {
    const { stdout } = await exec(
      "git",
      ["log", "-1", "--format=%H|%an|%aI|%s", "--", rel],
      opts
    );
    const parts = stdout.trim().split("|");
    if (parts.length >= 4) {
      last_commit = {
        sha: parts[0],
        author: parts[1],
        timestamp: parts[2],
        message: parts.slice(3).join("|"),
      };
    }
  } catch {
    // ignore
  }

  // Recent commits (up to 10)
  let recent_commits: Array<{ sha: string; message: string; timestamp: string }> = [];
  try {
    const { stdout } = await exec(
      "git",
      ["log", "-10", "--format=%H|%aI|%s", "--", rel],
      opts
    );
    recent_commits = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, timestamp, ...msg] = line.split("|");
        return { sha, timestamp, message: msg.join("|") };
      });
  } catch {
    // ignore
  }

  // Blame summary — top 3 contributors by line count.
  // Skipped by default in v1.2.16+ (5–50x slower than git log). Opt-in via
  // legion.includeGitBlame. When skipped, churn_rate is still derived from
  // the cheap `git log -10` we already ran above.
  let top_authors: string[] = [];
  let churn_rate = `${recent_commits.length} commits in last 10`;
  if (includeBlame) {
    try {
      const { stdout } = await exec(
        "git",
        ["blame", "--line-porcelain", rel],
        opts
      );
      const authors = stdout
        .split("\n")
        .filter((l) => l.startsWith("author "))
        .map((l) => l.slice(7));
      const counts = new Map<string, number>();
      for (const a of authors) {
        counts.set(a, (counts.get(a) ?? 0) + 1);
      }
      const total = authors.length || 1;
      top_authors = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, n]) => `${name} (${Math.round((n / total) * 100)}%)`);
    } catch {
      // file may be untracked or binary
    }
  }

  return {
    created_commit,
    created_at,
    last_commit,
    recent_commits,
    blame_summary: { top_authors, churn_rate },
  };
}

/**
 * Pre-compute git context for many files in parallel, with a concurrency limit
 * so a giant repo doesn't fork-bomb the OS.
 */
export async function getGitContextMany(
  repoRoot: string,
  absFiles: string[],
  concurrency = 8,
  includeBlame: boolean = false
): Promise<Record<string, FileGitContext>> {
  const result: Record<string, FileGitContext> = {};
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, absFiles.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= absFiles.length) return;
      const abs = absFiles[i];
      const rel = path.relative(repoRoot, abs).replace(/\\/g, "/");
      try {
        result[rel] = await getGitContext(repoRoot, abs, includeBlame);
      } catch (e) {
        result[rel] = {
          created_commit: "",
          created_at: "",
          last_commit: { sha: "", author: "", timestamp: "", message: "" },
          recent_commits: [],
          blame_summary: { top_authors: [], churn_rate: "unknown" },
        };
      }
    }
  });
  await Promise.all(workers);
  return result;
}

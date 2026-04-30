/**
 * Invocation payload schema — matches `wiki-weapon/guides/01-canonical-invocation.md`.
 * The TS driver constructs this and hands it to wiki-guardian via the agent invoker.
 */

export type Mode = "document" | "update" | "scan-directory" | "lint";

export interface ChunkFile {
  /** Repo-relative path. */
  path: string;
  /** Full file content. */
  content: string;
}

export interface CommitInfo {
  sha: string;
  author: string;
  timestamp: string; // ISO-8601
  message: string;
}

export interface RecentCommit {
  sha: string;
  message: string;
  timestamp: string; // ISO-8601
}

export interface BlameSummary {
  /** Top 3 contributors as strings like "alice (62%)". */
  top_authors: string[];
  /** Human-readable churn estimate. */
  churn_rate: string;
}

export interface FileGitContext {
  created_commit: string;
  created_at: string; // ISO-8601
  last_commit: CommitInfo;
  recent_commits: RecentCommit[];
  blame_summary: BlameSummary;
}

export interface PriorPage {
  /** Path under `library/knowledge-base/wiki/` (e.g. "entities/get-user.md"). */
  path: string;
  /** Parsed YAML frontmatter as an object. */
  frontmatter: Record<string, unknown>;
}

export interface PageCaps {
  max_lines_per_page: number;
  target_pages_per_chunk: [number, number];
}

export interface InvocationPayload {
  mode: Mode;
  chunk: ChunkFile[];
  /** Keyed by file path. */
  git_context: Record<string, FileGitContext>;
  prior_state: PriorPage[];
  /** Absolute path to library/knowledge-base/wiki/ in the target repo. */
  wiki_root: string;
  page_caps: PageCaps;
  callout_vocabulary: string[];
}

import type { InvocationResponse } from "../types/response";

export interface ReconciliationSummary {
  pagesAffected: number;
  contradictions: number;
  decisionsAllocated: number;
  notifications: number;
  errors: string[];
}

/**
 * Post-pass reconciliation: walks every InvocationResponse from a Document/Update
 * pass and updates the wiki's global state files.
 *
 * v0.1.0: stub. v0.2.0 implementation:
 *
 * For each response:
 *  1. Append entries to `library/knowledge-base/wiki/log.md` at the TOP, one per
 *     touched page, using the `## [YYYY-MM-DD HH:MM] <mode> | <chunk> | …` format.
 *  2. Update `library/knowledge-base/wiki/index.md` with new entries grouped by type.
 *  3. Update `library/knowledge-base/wiki/<type>/_index.md` for each type touched.
 *  4. Refresh `library/knowledge-base/wiki/hot.md` with the most-recent N commits
 *     and currently-active modules (driver computes from git_context delta).
 *  5. For every entry in `decisions_filed` that has `<pending>` adr_number,
 *     allocate the next sequential number atomically and rename the file.
 *  6. Update `.legion/file-hashes.json` per `entities_detected[]` —
 *     map each source file to its `pages_created` + `pages_updated`.
 *  7. Emit notification_flags to the sidebar via webview postMessage.
 *  8. Validate response invariants:
 *     - if contradictions_flagged.length > 0 then meta_reports_written.length > 0
 *       AND notification_flags.length > 0 (incomplete contradiction handling = bug)
 *     - if decisions_filed.length > 0 then every entry is in pages_created
 *
 * If `partial_scan: true` on any response, set a flag in .legion/config.json so
 * the next run knows to re-reconcile global state from scratch.
 */
export async function reconcile(
  _repoRoot: string,
  _responses: InvocationResponse[]
): Promise<ReconciliationSummary> {
  // TODO v0.2.0
  return {
    pagesAffected: 0,
    contradictions: 0,
    decisionsAllocated: 0,
    notifications: 0,
    errors: [],
  };
}

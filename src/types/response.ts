/**
 * Response payload schema — matches `wiki-weapon/guides/10-response-payload.md`
 * and `wiki-weapon/reports/response-payload-schema.md`.
 * wiki-guardian returns this; the TS driver consumes it for state reconciliation.
 */

export type EntityType =
  | "function" | "class" | "module" | "service" | "endpoint"
  | "env-var" | "config-key" | "data-model" | "react-component"
  | "sql-table" | "queue" | "cron-job" | "feature-flag";

export interface Contradiction {
  /** Old page path (relative to wiki_root). */
  old: string;
  /** New page path (relative to wiki_root). */
  new: string;
  /** One-line summary of what changed. */
  reason: string;
  /** Commit SHA where the contradiction was introduced. */
  commit: string;
}

export interface NotificationFlag {
  severity: "info" | "warning" | "error";
  title: string;
  /** Page that triggered the notification. */
  page: string;
  /** Optional path to a meta report. */
  report?: string;
}

export interface DetectedEntity {
  name: string;
  type: EntityType;
  /** Repo-relative source file. */
  file: string;
  line: number;
}

export interface Gap {
  entity: string;
  /** "<file>:<line>" where the entity was referenced. */
  referenced_in: string;
  reason: string;
}

export interface LintFinding {
  severity: "error" | "warning" | "info";
  category:
    | "frontmatter"
    | "unresolved-in-chunk"
    | "pairing"
    | "stub-stale"
    | "page-too-long"
    | "low-citation-density"
    | "non-standard-callout"
    | "adr-integrity";
  /** Page path the finding applies to. */
  page: string;
  details: Record<string, unknown>;
}

export interface InvocationError {
  code: "validation_failed" | "phase_failed" | "partial_write";
  message: string;
  phase?: number;
  details?: Record<string, unknown>;
}

export interface InvocationResponse {
  pages_created: string[];
  pages_updated: string[];
  decisions_filed: string[];
  contradictions_flagged: Contradiction[];
  meta_reports_written: string[];
  notification_flags: NotificationFlag[];
  entities_detected: DetectedEntity[];
  gaps: Gap[];
  lint_findings: LintFinding[];
  partial_scan: boolean;
  /** Present only on validation/phase failure. */
  error?: InvocationError;
}

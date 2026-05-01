import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import type { InvocationPayload } from "../types/payload";
import type { InvocationResponse } from "../types/response";
import {
  loadManifest,
  saveManifest,
  hashFile,
  updateManifestEntry,
} from "./hashDiff";
import { buildEntityGraph } from "./graphBuilder";
import { publishFederationManifest } from "./federationPublisher";
import { fetchFederationPeers } from "./federationFetcher";
import { injectAddresses } from "./addressAllocator";
import { computeCoverage, saveCoverage } from "./coverageTracker";
import { writeSnapshot } from "./snapshotManager";
import { injectClaudeContext } from "../context/claudeMdWriter";

// ── Public types ─────────────────────────────────────────────────────────────

export interface ChunkResult {
  /** Human-readable label matching the PlannedChunk that produced this result. */
  label: string;
  /** The payload that was sent to the agent — carried for git_context access. */
  payload: InvocationPayload;
  /** The structured response returned by the agent. */
  response: InvocationResponse;
}

export interface ReconciliationSummary {
  pagesAffected: number;
  contradictions: number;
  decisionsAllocated: number;
  notifications: number;
  errors: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const WIKI_REL = path.join("library", "knowledge-base", "wiki");

const SECTION_MAP: Array<{ prefix: string; heading: string }> = [
  { prefix: "entities/", heading: "## Entities" },
  { prefix: "concepts/", heading: "## Concepts" },
  { prefix: "decisions/", heading: "## Decisions (ADRs)" },
  { prefix: "comparisons/", heading: "## Comparisons" },
  { prefix: "questions/", heading: "## Questions" },
  { prefix: "meta/", heading: "## Meta" },
];

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Post-pass reconciliation. Runs after ALL parallel agent invocations complete.
 * Updates the wiki's global state files and the hash manifest. Validates
 * response invariants and throws descriptive errors with offending payloads
 * for any violation.
 *
 * Steps:
 *   0  Validate response invariants (skip errored responses)
 *   1  Prepend entries to log.md (newest-first)
 *   2  Update index.md (append new page links grouped by type)
 *   3  Update per-type _index.md files
 *   4  Refresh hot.md (recently touched files from git_context)
 *   5  Allocate sequential ADR numbers (rename pending-* decision files)
 *   6  Update .legion/file-hashes.json
 *   7  Emit notification flags via VS Code messages
 *   8  Set partial_scan_pending flag in .legion/config.json if needed
 */
export async function reconcile(
  repoRoot: string,
  chunkResults: ChunkResult[]
): Promise<ReconciliationSummary> {
  const summary: ReconciliationSummary = {
    pagesAffected: 0,
    contradictions: 0,
    decisionsAllocated: 0,
    notifications: 0,
    errors: [],
  };

  if (chunkResults.length === 0) return summary;

  const wikiRoot = path.join(repoRoot, WIKI_REL);
  const now = new Date();

  // ── Step 0: Validate invariants ──────────────────────────────────────────
  const validResults: ChunkResult[] = [];
  for (const cr of chunkResults) {
    const errs = validateResponse(cr.response, cr.label);
    if (errs.length > 0) {
      summary.errors.push(...errs);
      // Responses with error.code skip reconciliation but non-fatal invariant
      // violations still get included (agent wrote pages; we must reconcile them).
      if (cr.response.error) continue;
    }
    validResults.push(cr);
  }

  // Aggregate page sets across all valid results
  const allCreated = new Set<string>();
  const allUpdated = new Set<string>();
  for (const { response } of validResults) {
    for (const p of response.pages_created) allCreated.add(p);
    for (const p of response.pages_updated) allUpdated.add(p);
  }
  summary.pagesAffected = allCreated.size + allUpdated.size;
  summary.contradictions = validResults.reduce(
    (n, { response }) => n + response.contradictions_flagged.length,
    0
  );
  summary.notifications = validResults.reduce(
    (n, { response }) => n + response.notification_flags.length,
    0
  );

  if (validResults.length === 0) return summary;

  // ── Step 0.5: Inject stable page addresses ────────────────────────────────
  try {
    await injectAddresses(repoRoot, wikiRoot, [...allCreated]);
  } catch (e) {
    summary.errors.push(`address injection failed: ${errMsg(e)}`);
  }

  // ── Step 1: Prepend log entries ──────────────────────────────────────────
  try {
    await prependToLog(wikiRoot, validResults, now);
  } catch (e) {
    summary.errors.push(`log.md update failed: ${errMsg(e)}`);
  }

  // ── Step 2: Update index.md ──────────────────────────────────────────────
  try {
    await updateIndex(wikiRoot, [...allCreated], now);
  } catch (e) {
    summary.errors.push(`index.md update failed: ${errMsg(e)}`);
  }

  // ── Step 3: Update per-type _index.md files ──────────────────────────────
  try {
    await updateTypeIndexes(wikiRoot, [...allCreated]);
  } catch (e) {
    summary.errors.push(`_index.md update failed: ${errMsg(e)}`);
  }

  // ── Step 4: Refresh hot.md ────────────────────────────────────────────────
  try {
    await refreshHot(wikiRoot, validResults, now);
  } catch (e) {
    summary.errors.push(`hot.md update failed: ${errMsg(e)}`);
  }

  // ── Step 5: Allocate ADR numbers ─────────────────────────────────────────
  for (const { response } of validResults) {
    for (const decision of response.decisions_filed) {
      const filename = path.basename(decision);
      if (!filename.startsWith("pending-")) continue;
      try {
        await allocateAdrNumber(wikiRoot, filename);
        summary.decisionsAllocated++;
      } catch (e) {
        summary.errors.push(`ADR allocation failed for "${decision}": ${errMsg(e)}`);
      }
    }
  }

  // ── Step 6: Update .legion/file-hashes.json ──────────────────────────────
  try {
    const manifest = await loadManifest(repoRoot);
    for (const { payload, response } of validResults) {
      for (const chunkFile of payload.chunk) {
        const rel = chunkFile.path.replace(/\\/g, "/");
        try {
          const abs = path.join(repoRoot, rel.replace(/\//g, path.sep));
          const hash = await hashFile(abs);
          updateManifestEntry(
            manifest,
            rel,
            hash,
            response.pages_created,
            response.pages_updated
          );
        } catch {
          // File was deleted between chunk load and reconciliation — skip.
        }
      }
    }
    manifest.last_scan = now.toISOString();
    await saveManifest(repoRoot, manifest);
  } catch (e) {
    summary.errors.push(`file-hashes.json update failed: ${errMsg(e)}`);
  }

  // ── Step 7: Emit notification flags ──────────────────────────────────────
  for (const { response } of validResults) {
    for (const flag of response.notification_flags) {
      if (flag.severity === "error" || flag.severity === "warning") {
        vscode.window.showWarningMessage(`Legion: ${flag.title} — ${flag.page}`);
      }
      // info-level flags are surfaced only in the summary count, not as popups.
    }
  }

  // ── Step 8: Set partial_scan_pending flag ─────────────────────────────────
  const hasPartialScan = validResults.some((cr) => cr.response.partial_scan);
  if (hasPartialScan) {
    try {
      const configPath = path.join(repoRoot, ".legion", "config.json");
      const raw = await fs.readFile(configPath, "utf8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      config.partial_scan_pending = true;
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    } catch (e) {
      summary.errors.push(`partial_scan flag update failed: ${errMsg(e)}`);
    }
  }

  // ── Step 9: Rebuild entity graph (graph.md) ───────────────────────────────
  try {
    await buildEntityGraph(repoRoot);
  } catch (e) {
    summary.errors.push(`graph.md build failed: ${errMsg(e)}`);
  }

  // ── Step 10: Requirements → entity traceability ──────────────────────────
  try {
    await linkRequirementsToEntities(repoRoot, validResults);
  } catch (e) {
    summary.errors.push(`requirements traceability failed: ${errMsg(e)}`);
  }

  // ── Step 11: Inject hot.md into .cursor/rules/wiki-hot-context.md ────────
  const injectContext = vscode.workspace
    .getConfiguration("legion")
    .get<boolean>("injectCursorContext", true);
  if (injectContext) {
    try {
      await injectHotContext(repoRoot, wikiRoot);
    } catch (e) {
      summary.errors.push(`cursor context injection failed: ${errMsg(e)}`);
    }
  }

  // ── Step 12: Federation publish + fetch ──────────────────────────────────
  const fedConfig = vscode.workspace.getConfiguration("legion").get<{
    publishManifest?: boolean;
    peers?: string[];
  }>("federation", {});
  if (fedConfig.publishManifest) {
    try {
      await publishFederationManifest(repoRoot);
    } catch (e) {
      summary.errors.push(`federation publish failed: ${errMsg(e)}`);
    }
  }
  if (fedConfig.peers && fedConfig.peers.length > 0) {
    try {
      await fetchFederationPeers(repoRoot, fedConfig.peers);
    } catch (e) {
      summary.errors.push(`federation fetch failed: ${errMsg(e)}`);
    }
  }

  // ── Step 13: Persist contradiction inbox to .legion/config.json ───────────
  const newContradictions = validResults.flatMap((cr) =>
    cr.response.contradictions_flagged.map((c) => ({
      ...c,
      date: now.toISOString().slice(0, 10),
    }))
  );
  if (newContradictions.length > 0) {
    try {
      await appendContradictionInbox(repoRoot, newContradictions);
    } catch (e) {
      summary.errors.push(`contradiction inbox update failed: ${errMsg(e)}`);
    }
  }

  // ── Step 14: Compute and save wiki coverage (knowledge debt tracker) ───────
  let coverage: Awaited<ReturnType<typeof computeCoverage>> | undefined;
  try {
    coverage = await computeCoverage(repoRoot);
    await saveCoverage(repoRoot, coverage);
    // Push to sidebar
    void vscode.commands.executeCommand("legion.internal.coverageUpdate", coverage);
  } catch (e) {
    summary.errors.push(`coverage tracker failed: ${errMsg(e)}`);
  }

  // ── Step 15: Claude Code context injection (feature-007) ──────────────────
  if (coverage && vscode.workspace.getConfiguration("legion").get<boolean>("injectClaudeContext", true)) {
    try {
      await injectClaudeContext(repoRoot, coverage.total);
    } catch (e) {
      summary.errors.push(`CLAUDE.md injection failed: ${errMsg(e)}`);
    }
  }

  // ── Step 16: Persist analytics snapshot (feature-010) ────────────────────
  if (coverage) {
    try {
      await writeSnapshot(repoRoot, {
        entityCount: coverage.total,
        byStatus: {
          seed: coverage.byStatus["seed"] ?? 0,
          developing: coverage.byStatus["developing"] ?? 0,
          mature: coverage.byStatus["mature"] ?? 0,
          evergreen: coverage.byStatus["evergreen"] ?? 0,
        },
        byModule: Object.fromEntries(
          Object.entries(coverage.byModule).map(([k, v]) => [
            k,
            {
              total: v.total,
              mature: v.mature,
              pct: v.total > 0 ? Math.round((v.mature / v.total) * 100) : 0,
            },
          ])
        ),
        adrCount: summary.decisionsAllocated,
        contradictionsDetected: summary.contradictions,
        contradictionsResolved: 0,
        maturityPct: coverage.maturityPct,
      });
      void vscode.commands.executeCommand("legion.internal.dashboardRefresh");
    } catch (e) {
      summary.errors.push(`snapshot write failed: ${errMsg(e)}`);
    }
  }

  // Refresh wiki tree after each pass
  void vscode.commands.executeCommand("legion.refreshWikiTree");

  return summary;
}

// ── Contradiction inbox helpers ───────────────────────────────────────────────

export interface ContradictionEntry {
  old: string;
  new: string;
  reason: string;
  commit: string;
  date: string;
}

async function appendContradictionInbox(
  repoRoot: string,
  entries: ContradictionEntry[]
): Promise<void> {
  const configPath = path.join(repoRoot, ".legion", "config.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    // Config may not exist yet — start fresh.
  }
  const existing = (config.contradiction_inbox as ContradictionEntry[] | undefined) ?? [];
  config.contradiction_inbox = [...existing, ...entries];
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

export async function readContradictionInbox(repoRoot: string): Promise<ContradictionEntry[]> {
  const configPath = path.join(repoRoot, ".legion", "config.json");
  try {
    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
    return (config.contradiction_inbox as ContradictionEntry[] | undefined) ?? [];
  } catch {
    return [];
  }
}

export async function removeContradictionFromInbox(
  repoRoot: string,
  index: number
): Promise<void> {
  const configPath = path.join(repoRoot, ".legion", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  const inbox = (config.contradiction_inbox as ContradictionEntry[] | undefined) ?? [];
  inbox.splice(index, 1);
  config.contradiction_inbox = inbox;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

// ── Cursor context injection ──────────────────────────────────────────────────

/**
 * Write `.cursor/rules/wiki-hot-context.md` in the target repo so Cursor's
 * context system automatically picks up the recently-touched entities and
 * modules on every chat session.
 *
 * The file wraps `hot.md` content in a Cursor rules frontmatter block.
 * Controlled by `legion.injectCursorContext` (default `true`).
 */
export async function injectHotContext(repoRoot: string, wikiRoot: string): Promise<void> {
  const hotPath = path.join(wikiRoot, "hot.md");
  let hotContent: string;
  try {
    hotContent = await fs.readFile(hotPath, "utf8");
  } catch {
    return; // hot.md not yet written
  }

  // Strip frontmatter from hot.md before embedding
  const bodyStart = hotContent.indexOf("\n# ");
  const body = bodyStart >= 0 ? hotContent.slice(bodyStart + 1) : hotContent;

  const rulesContent = [
    `---`,
    `description: Legion wiki hot cache — recently touched entities and modules.`,
    `globs: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]`,
    `alwaysApply: false`,
    `---`,
    ``,
    `<!-- Auto-generated by Legion after each Document/Update pass. Do not edit. -->`,
    ``,
    body.trim(),
  ].join("\n");

  const rulesDir = path.join(repoRoot, ".cursor", "rules");
  await fs.mkdir(rulesDir, { recursive: true });
  await fs.writeFile(path.join(rulesDir, "wiki-hot-context.md"), rulesContent);
}

// ── Requirements → entity traceability ───────────────────────────────────────

/**
 * Cross-reference detected entities against requirement files in
 * `library/requirements/features/*.md` and `library/requirements/issues/*.md`.
 *
 * For each match (entity name found in requirement title or body):
 *  - Appends `satisfies: [[requirements/features/<name>]]` to the entity page
 *  - Appends `implemented_by: [[entities/<entity>]]` to the requirement page
 *
 * All writes are idempotent — checks for existing links before appending.
 */
async function linkRequirementsToEntities(
  repoRoot: string,
  results: ChunkResult[]
): Promise<void> {
  const reqDirs = [
    path.join(repoRoot, "library", "requirements", "features"),
    path.join(repoRoot, "library", "requirements", "issues"),
  ];
  const wikiEntityDir = path.join(repoRoot, "library", "knowledge-base", "wiki", "entities");

  // Collect all requirement files
  const reqFiles: Array<{ absPath: string; relPath: string; content: string }> = [];
  for (const dir of reqDirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".md")) continue;
      const absPath = path.join(dir, file);
      try {
        const content = await fs.readFile(absPath, "utf8");
        const relPath = path
          .relative(path.join(repoRoot, "library"), absPath)
          .replace(/\\/g, "/");
        reqFiles.push({ absPath, relPath, content });
      } catch {
        // skip
      }
    }
  }

  if (reqFiles.length === 0) return;

  // For each detected entity, search requirement files
  const allEntities = results.flatMap((r) => r.response.entities_detected);
  for (const entity of allEntities) {
    const entityName = entity.name;
    const entityPageAbs = path.join(wikiEntityDir, `${entityName}.md`);
    // Try kebab-case fallback
    const kebabName = entityName.replace(/([A-Z])/g, "-$1").toLowerCase().replace(/^-/, "");
    const entityPageKebab = path.join(wikiEntityDir, `${kebabName}.md`);

    let entityAbsPath = "";
    for (const candidate of [entityPageAbs, entityPageKebab]) {
      try {
        await fs.access(candidate);
        entityAbsPath = candidate;
        break;
      } catch {
        // try next
      }
    }
    if (!entityAbsPath) continue;

    for (const req of reqFiles) {
      // Simple name match — entity name appears in the requirement file
      if (!req.content.includes(entityName)) continue;

      const reqWikilink = `[[${req.relPath.replace(/\.md$/, "")}]]`;
      const entityWikilink = `[[entities/${path.basename(entityAbsPath, ".md")}]]`;

      // Append `satisfies:` to entity page if not already present
      let entityContent = await fs.readFile(entityAbsPath, "utf8");
      if (!entityContent.includes(reqWikilink)) {
        entityContent = appendFrontmatterField(entityContent, "satisfies", reqWikilink);
        await fs.writeFile(entityAbsPath, entityContent);
      }

      // Append `implemented_by:` to requirement page if not already present
      if (!req.content.includes(entityWikilink)) {
        const newReqContent = appendFrontmatterField(req.content, "implemented_by", entityWikilink);
        await fs.writeFile(req.absPath, newReqContent);
        req.content = newReqContent; // update in-memory to avoid re-writing
      }
    }
  }
}

/**
 * Append a value to a YAML frontmatter field. If the field already exists,
 * appends to the existing value (comma-separated). If not, adds a new field
 * after the closing `---` delimiter.
 */
function appendFrontmatterField(content: string, field: string, value: string): string {
  const lines = content.split("\n");
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (closeIdx === -1) return content;

  // Check if field already exists in frontmatter
  const fieldIdx = lines.findIndex(
    (l, i) => i > 0 && i < closeIdx && l.startsWith(`${field}:`)
  );

  if (fieldIdx >= 0) {
    // Append to existing field
    lines[fieldIdx] = `${lines[fieldIdx].trimEnd()}, ${value}`;
  } else {
    // Insert new field before closing ---
    lines.splice(closeIdx, 0, `${field}: ${value}`);
  }
  return lines.join("\n");
}

// ── Step 0: Invariant validation ─────────────────────────────────────────────

function validateResponse(response: InvocationResponse, label: string): string[] {
  const errors: string[] = [];

  if (response.error) {
    errors.push(
      `[${label}] Agent returned error (${response.error.code}): ${response.error.message}`
    );
    return errors; // Don't validate further — arrays are sentinel values per schema.
  }

  // Invariant 1: contradictions must have meta report AND notification flag.
  if (
    response.contradictions_flagged.length > 0 &&
    (response.meta_reports_written.length === 0 || response.notification_flags.length === 0)
  ) {
    const sample = JSON.stringify(response.contradictions_flagged.slice(0, 2));
    errors.push(
      `[${label}] Invariant violation: contradictions_flagged.length=${response.contradictions_flagged.length} ` +
        `but meta_reports_written.length=${response.meta_reports_written.length}, ` +
        `notification_flags.length=${response.notification_flags.length}. ` +
        `Offending contradictions: ${sample}`
    );
  }

  // Invariant 2: every filed decision must appear in pages_created.
  for (const d of response.decisions_filed) {
    if (!response.pages_created.includes(d)) {
      errors.push(
        `[${label}] Invariant violation: decisions_filed contains "${d}" which is absent from pages_created. ` +
          `pages_created=${JSON.stringify(response.pages_created)}`
      );
    }
  }

  // Invariant 3: no absolute paths or directory traversal in page lists.
  for (const p of [...response.pages_created, ...response.pages_updated]) {
    if (path.isAbsolute(p)) {
      errors.push(
        `[${label}] Invariant violation: absolute path in response payload: "${p}"`
      );
    }
    if (p.replace(/\\/g, "/").includes("../")) {
      errors.push(
        `[${label}] Invariant violation: directory traversal in response payload: "${p}"`
      );
    }
  }

  return errors;
}

// ── Step 1: log.md ───────────────────────────────────────────────────────────

async function prependToLog(
  wikiRoot: string,
  results: ChunkResult[],
  now: Date
): Promise<void> {
  const logPath = path.join(wikiRoot, "log.md");
  const timestamp = fmtTimestamp(now);

  // Build the new block to insert (newest at top means all new results go in
  // one block prepended after the "## Entries" heading).
  const newLines: string[] = [];
  for (const { label, payload, response } of results) {
    const created = response.pages_created.length;
    const updated = response.pages_updated.length;
    const contradictions = response.contradictions_flagged.length;
    let line = `## [${timestamp}] ${payload.mode} | ${label} | created: ${created}, updated: ${updated}`;
    if (contradictions > 0) line += `, contradictions: ${contradictions}`;
    newLines.push(line, "");
  }
  const insertBlock = newLines.join("\n");

  let existing = "";
  try {
    existing = await fs.readFile(logPath, "utf8");
  } catch {
    // No log.md yet — will be created.
  }

  // Insert after the "## Entries" sentinel if present; otherwise after the
  // first top-level `#` header; otherwise prepend.
  const entriesMarker = "## Entries";
  if (existing.includes(entriesMarker)) {
    const idx = existing.indexOf(entriesMarker) + entriesMarker.length;
    // Skip the rest of the heading line.
    const afterHeading = existing.indexOf("\n", idx) + 1;
    await fs.writeFile(
      logPath,
      existing.slice(0, afterHeading) + "\n" + insertBlock + existing.slice(afterHeading)
    );
    return;
  }

  const firstHeaderMatch = existing.match(/^#[^\n]*\n/m);
  if (firstHeaderMatch && firstHeaderMatch.index !== undefined) {
    const insertAt = firstHeaderMatch.index + firstHeaderMatch[0].length;
    await fs.writeFile(
      logPath,
      existing.slice(0, insertAt) + "\n" + insertBlock + existing.slice(insertAt)
    );
    return;
  }

  await fs.writeFile(logPath, insertBlock + existing);
}

// ── Step 2: index.md ─────────────────────────────────────────────────────────

async function updateIndex(
  wikiRoot: string,
  newPages: string[],
  now: Date
): Promise<void> {
  if (newPages.length === 0) return;

  const indexPath = path.join(wikiRoot, "index.md");
  let content = "";
  try {
    content = await fs.readFile(indexPath, "utf8");
  } catch {
    content = "# Wiki Index\n";
  }

  // Build set of existing wikilink targets to avoid duplicates.
  const existing = new Set(
    [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1])
  );

  // Group new pages by section heading.
  const bySection = new Map<string, string[]>();
  for (const p of newPages) {
    const norm = p.replace(/\\/g, "/");
    const def = SECTION_MAP.find((s) => norm.startsWith(s.prefix));
    const heading = def?.heading ?? "## Other";
    const linkTarget = norm.replace(/\.md$/, "");
    if (existing.has(linkTarget)) continue;
    existing.add(linkTarget);
    const list = bySection.get(heading) ?? [];
    list.push(linkTarget);
    bySection.set(heading, list);
  }

  // Insert new entries under their section headings (line-based for precision).
  let lines = content.split("\n");
  for (const [heading, pages] of bySection) {
    const headingIdx = lines.findIndex((l) => l === heading);
    const newEntries = pages.map((p) => `- [[${p}]]`);
    if (headingIdx >= 0) {
      // Insert immediately after the heading line.
      lines.splice(headingIdx + 1, 0, ...newEntries);
    } else {
      // Append a new section.
      lines.push("", heading, ...newEntries);
    }
  }

  // Update the "Last reconciled" footer.
  const reconLine = `*Last reconciled: ${fmtTimestamp(now)}*`;
  const reconIdx = lines.findIndex((l) => l.startsWith("*Last reconciled:"));
  if (reconIdx >= 0) {
    lines[reconIdx] = reconLine;
  } else {
    lines.push("", reconLine);
  }

  await fs.writeFile(indexPath, lines.join("\n"));
}

// ── Step 3: per-type _index.md ───────────────────────────────────────────────

async function updateTypeIndexes(wikiRoot: string, newPages: string[]): Promise<void> {
  // Group pages by their parent directory (= entity type folder).
  const byDir = new Map<string, string[]>();
  for (const p of newPages) {
    const norm = p.replace(/\\/g, "/");
    const slashIdx = norm.indexOf("/");
    if (slashIdx === -1) continue;
    const dir = norm.slice(0, slashIdx);
    const basename = norm.slice(slashIdx + 1).replace(/\.md$/, "");
    const list = byDir.get(dir) ?? [];
    list.push(basename);
    byDir.set(dir, list);
  }

  for (const [dir, pages] of byDir) {
    const indexPath = path.join(wikiRoot, dir, "_index.md");
    let content = "";
    try {
      content = await fs.readFile(indexPath, "utf8");
    } catch {
      const heading = dir.charAt(0).toUpperCase() + dir.slice(1);
      content = `# ${heading}\n`;
    }

    const existingLinks = new Set(
      [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1])
    );
    const toAdd = pages.filter((p) => !existingLinks.has(p));
    if (toAdd.length === 0) continue;

    content = content.trimEnd() + "\n" + toAdd.map((p) => `- [[${p}]]`).join("\n") + "\n";
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(indexPath, content);
  }
}

// ── Step 4: hot.md ───────────────────────────────────────────────────────────

async function refreshHot(
  wikiRoot: string,
  results: ChunkResult[],
  now: Date
): Promise<void> {
  const hotPath = path.join(wikiRoot, "hot.md");

  // Collect files with their last-commit metadata from all chunk payloads.
  type HotEntry = { file: string; timestamp: string; author: string; commit: string };
  const entries: HotEntry[] = [];
  const seen = new Set<string>();

  for (const { payload } of results) {
    for (const [file, ctx] of Object.entries(payload.git_context)) {
      if (seen.has(file)) continue;
      seen.add(file);
      entries.push({
        file,
        timestamp: ctx.last_commit.timestamp ?? "",
        author: ctx.last_commit.author ?? "",
        commit: ctx.last_commit.sha ? ctx.last_commit.sha.slice(0, 7) : "",
      });
    }
  }

  // Sort newest-first, cap at 10.
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const top = entries.slice(0, 10);

  const dateStr = fmtTimestamp(now);
  const tableLines = [
    "## Recent commits affecting documented entities",
    "",
    `_Updated: ${dateStr}_`,
    "",
    "| File | Date | Author | Commit |",
    "|------|------|--------|--------|",
    ...top.map(
      (e) =>
        `| \`${e.file}\` | ${e.timestamp ? e.timestamp.slice(0, 10) : "—"} | ${e.author || "—"} | ${e.commit || "—"} |`
    ),
    "",
  ];

  // Also build active-modules section from results.
  const activeModules = [...new Set(results.map((r) => r.label))];
  const modulesLines = [
    "## Currently-active modules",
    "",
    ...activeModules.map((m) => `- ${m}`),
    "",
  ];

  // Build contradiction recaps.
  const contradictionLines: string[] = ["## Recent contradictions", ""];
  for (const { response } of results) {
    for (const c of response.contradictions_flagged) {
      contradictionLines.push(`- \`${c.old}\` → \`${c.new}\`: ${c.reason} (${c.commit})`);
    }
  }
  if (contradictionLines.length === 2) {
    contradictionLines.push("_(none this pass)_");
  }
  contradictionLines.push("");

  // Footer timestamp.
  const footerLine = `*Last refreshed: ${dateStr}*`;

  let existing = "";
  try {
    existing = await fs.readFile(hotPath, "utf8");
  } catch {
    // Will be created.
  }

  // Preserve any frontmatter (lines before the first `#` body heading).
  const bodyStart = existing.search(/^#[^#]/m);
  const frontmatter = bodyStart > 0 ? existing.slice(0, bodyStart) : "";
  const header = existing.match(/^# [^\n]+\n/m)?.[0] ?? "# Hot Cache\n";

  // Replace body with the refreshed sections, preserving "Recent ADRs" if present.
  const adrSection = extractSection(existing, "## Recent ADRs");

  const bodyParts: string[] = [
    header,
    "\n",
    ...tableLines.map((l) => l + "\n"),
    "\n",
    ...modulesLines.map((l) => l + "\n"),
    "\n",
    ...contradictionLines.map((l) => l + "\n"),
    adrSection ? "\n" + adrSection + "\n" : "",
    "\n---\n\n",
    footerLine + "\n",
  ];

  await fs.writeFile(hotPath, frontmatter + bodyParts.join(""));
}

/** Extract a named `## Section` block (up to the next `##` or EOF). */
function extractSection(content: string, heading: string): string {
  const idx = content.indexOf(heading);
  if (idx === -1) return "";
  const rest = content.slice(idx);
  const next = rest.slice(1).search(/^## /m);
  return next >= 0 ? rest.slice(0, next + 1).trimEnd() : rest.trimEnd();
}

// ── Step 5: ADR number allocation ─────────────────────────────────────────────

async function allocateAdrNumber(wikiRoot: string, filename: string): Promise<string> {
  const decisionsDir = path.join(wikiRoot, "decisions");

  // Find current max ADR number from existing files.
  let maxNum = 0;
  try {
    const entries = await fs.readdir(decisionsDir);
    for (const entry of entries) {
      const m = entry.match(/^ADR-(\d+)/i);
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    }
  } catch {
    // decisions/ may not exist yet — that's fine.
  }

  const nextNum = maxNum + 1;
  const paddedNum = String(nextNum).padStart(3, "0");

  // Strip "pending-<sha>-" prefix to derive the slug.
  const slugMatch = filename.match(/^pending-[0-9a-f]{4,40}-(.+)$/i);
  const slug = slugMatch ? slugMatch[1] : filename;

  const newFilename = `ADR-${paddedNum}-${slug}`;
  const oldPath = path.join(decisionsDir, filename);
  const newPath = path.join(decisionsDir, newFilename);

  await fs.rename(oldPath, newPath);
  return newFilename;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

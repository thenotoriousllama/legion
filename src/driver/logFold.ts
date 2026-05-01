import * as fs from "fs/promises";
import * as path from "path";

const WIKI_REL = path.join("library", "knowledge-base", "wiki");
const LOG_ENTRY_RE = /^## \[(\d{4}-\d{2}-\d{2}[^\]]*)\]/gm;

export interface FoldResult {
  foldId: string;
  content: string;
  wrote: boolean;
  entryCount: number;
}

/**
 * Roll up the last `2^k` log entries from `wiki/log.md` into a checkpoint
 * page at `wiki/folds/<foldId>.md`.
 *
 * - Additive: never deletes or modifies existing log entries
 * - Deterministic fold ID: idempotent (existing fold = no-op)
 * - dryRun=true: return proposed content without writing anything
 */
export async function foldLog(
  repoRoot: string,
  k: number,
  dryRun: boolean
): Promise<FoldResult> {
  const wikiRoot = path.join(repoRoot, WIKI_REL);
  const logPath = path.join(wikiRoot, "log.md");

  let logContent: string;
  try {
    logContent = await fs.readFile(logPath, "utf8");
  } catch {
    throw new Error("wiki/log.md not found — run Document Repository first.");
  }

  // Extract all log entries as {header, body} blocks
  const entries = parseLogEntries(logContent);
  if (entries.length === 0) {
    throw new Error("wiki/log.md contains no scanned entries to fold.");
  }

  const count = Math.min(Math.pow(2, k), entries.length);
  const toFold = entries.slice(-count); // last 2^k entries

  // Build deterministic fold ID from date range
  const earliest = extractDate(toFold[0].header);
  const latest = extractDate(toFold[toFold.length - 1].header);
  const foldId = `fold-k${k}-from-${earliest}-to-${latest}-n${count}`;
  const foldPath = path.join(wikiRoot, "folds", `${foldId}.md`);

  // Idempotency check
  try {
    await fs.access(foldPath);
    // Already exists — return early
    const existing = await fs.readFile(foldPath, "utf8");
    return { foldId, content: existing, wrote: false, entryCount: count };
  } catch {
    // Doesn't exist — proceed
  }

  const now = new Date().toISOString().slice(0, 10);
  const content = buildFoldPage(foldId, k, count, earliest, latest, toFold, now);

  if (dryRun) {
    return { foldId, content, wrote: false, entryCount: count };
  }

  // Write fold page
  await fs.mkdir(path.dirname(foldPath), { recursive: true });
  await fs.writeFile(foldPath, content);

  // Append fold reference to log.md
  const foldEntry = `\n## [${now}] fold | ${foldId} | folded ${count} entries\n`;
  await fs.appendFile(logPath, foldEntry);

  // Update index.md — append fold link
  const indexPath = path.join(wikiRoot, "index.md");
  try {
    let indexContent = await fs.readFile(indexPath, "utf8");
    const foldLink = `- [[folds/${foldId}]]`;
    if (!indexContent.includes(foldId)) {
      const foldsHeading = "## Folds";
      if (indexContent.includes(foldsHeading)) {
        const lines = indexContent.split("\n");
        const hIdx = lines.findIndex((l) => l === foldsHeading);
        lines.splice(hIdx + 1, 0, foldLink);
        indexContent = lines.join("\n");
      } else {
        indexContent = indexContent.trimEnd() + `\n\n${foldsHeading}\n${foldLink}\n`;
      }
      await fs.writeFile(indexPath, indexContent);
    }
  } catch {
    // index.md missing — skip
  }

  return { foldId, content, wrote: true, entryCount: count };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface LogEntry {
  header: string; // the full `## [...]` line
  body: string;   // lines after the header until the next header
}

function parseLogEntries(logContent: string): LogEntry[] {
  const lines = logContent.split("\n");
  const entries: LogEntry[] = [];
  let current: LogEntry | null = null;

  for (const line of lines) {
    if (/^## \[/.test(line)) {
      if (current) entries.push(current);
      current = { header: line, body: "" };
    } else if (current) {
      current.body += line + "\n";
    }
  }
  if (current) entries.push(current);
  return entries;
}

function extractDate(header: string): string {
  const m = header.match(/\[(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "unknown";
}

function buildFoldPage(
  foldId: string,
  k: number,
  count: number,
  earliest: string,
  latest: string,
  entries: LogEntry[],
  createdDate: string
): string {
  const lines = [
    `---`,
    `type: fold`,
    `fold_k: ${k}`,
    `entry_count: ${count}`,
    `date_range_from: "${earliest}"`,
    `date_range_to: "${latest}"`,
    `created: "${createdDate}"`,
    `tags: [fold, meta]`,
    `---`,
    ``,
    `# Fold — k=${k}, ${count} entries (${earliest} → ${latest})`,
    ``,
    `> Extractive rollup of ${count} log entries. Source entries are preserved in \`wiki/log.md\`.`,
    ``,
    `## Themes`,
    ``,
    `_(Extracted from entry headers below)_`,
    ``,
  ];

  // Group entries by mode for the themes section
  const byMode: Record<string, number> = {};
  for (const e of entries) {
    const modeMatch = e.header.match(/\]\s+(\w+)\s+\|/);
    if (modeMatch) {
      byMode[modeMatch[1]] = (byMode[modeMatch[1]] ?? 0) + 1;
    }
  }
  for (const [mode, n] of Object.entries(byMode)) {
    lines.push(`- ${mode}: ${n} pass(es)`);
  }

  lines.push(``, `## Log Entries`, ``);
  for (const e of entries) {
    lines.push(e.header);
    if (e.body.trim()) lines.push(e.body.trimEnd());
    lines.push("");
  }

  return lines.join("\n");
}

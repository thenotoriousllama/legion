import * as fs from "fs/promises";
import * as path from "path";

// ── Constants ──────────────────────────────────────────────────────────────────

const FENCE_START = "<!-- legion-wiki-start -->";
const FENCE_END = "<!-- legion-wiki-end -->";
const SECTION_HEADER = "## Legion Wiki";

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Write or update the `## Legion Wiki` section in `CLAUDE.md` at the repo root.
 *
 * Behaviour:
 * - If `CLAUDE.md` does not exist, create it with just the Legion block.
 * - If the Legion fence markers are present, surgically replace the block
 *   (only the timestamp/count line changes; user additions outside the fences
 *   are preserved).
 * - If the file exists without Legion fences, append non-destructively.
 *
 * The written block is ≤ 20 lines — it describes where to look, not the content.
 */
export async function injectClaudeContext(
  repoRoot: string,
  entityCount: number,
  wikiPath = "library/knowledge-base/wiki"
): Promise<void> {
  const claudeMdPath = path.join(repoRoot, "CLAUDE.md");
  const block = buildLegionBlock(entityCount, wikiPath);

  let existing = "";
  try {
    existing = await fs.readFile(claudeMdPath, "utf8");
  } catch {
    // File does not exist — create it with just the Legion block
    await fs.writeFile(claudeMdPath, block, "utf8");
    return;
  }

  if (existing.includes(FENCE_START)) {
    // Surgical replace between fences
    const fenceRegex = new RegExp(
      `${escapeRegex(FENCE_START)}[\\s\\S]*?${escapeRegex(FENCE_END)}`,
      "g"
    );
    const inner = block.slice(block.indexOf(FENCE_START));
    const updated = existing.replace(fenceRegex, inner.trimEnd());
    await fs.writeFile(claudeMdPath, updated, "utf8");
  } else {
    // Append non-destructively
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    await fs.writeFile(claudeMdPath, existing + separator + block, "utf8");
  }
}

// ── Block builder ──────────────────────────────────────────────────────────────

function buildLegionBlock(entityCount: number, wikiPath: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${FENCE_START}
${SECTION_HEADER}
Last updated: ${date}. Entities: ${entityCount}. Path: ${wikiPath}/

When you need codebase context, use this lookup order:
1. Read \`${wikiPath}/hot.md\` first — recent high-signal entities (~500 words).
2. Read \`${wikiPath}/index.md\` for the full entity catalog (name, type, file:line).
3. Drill into \`${wikiPath}/entities/<EntityName>.md\` for full spec, changelog, and backlinks.
4. Check \`${wikiPath}/decisions/\` for architecture decisions (ADRs) affecting the relevant domain.

Do NOT read the wiki for general coding questions unrelated to this codebase.
${FENCE_END}
`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

import * as fs from "fs/promises";
import * as path from "path";
import { loadSharedConfig } from "./sharedConfig";

const WIKI_REL = path.join("library", "knowledge-base", "wiki");
const AGENDA_FILENAME = "research-agenda.md";

export interface AgendaItem {
  topic: string;
  /** 0-based line index in the file. -1 for shared items (never marked done). */
  lineIdx: number;
  /** True if this item comes from .legion-shared/config.json — never marked done. */
  shared?: boolean;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load all unchecked agenda items from `wiki/research-agenda.md` plus any
 * shared topics from `.legion-shared/config.json`. Shared items are never
 * marked done — they recur on every Drain Agenda run.
 */
export async function loadAgenda(repoRoot: string): Promise<AgendaItem[]> {
  const filePath = agendaPath(repoRoot);
  const items: AgendaItem[] = [];

  // Local wiki agenda
  try {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^-\s+\[\s+\]\s+(.+)$/);
      if (m) {
        items.push({ topic: m[1].trim(), lineIdx: i });
      }
    }
  } catch {
    // File doesn't exist yet — OK
  }

  // Shared team agenda from .legion-shared/config.json
  const sharedCfg = await loadSharedConfig(repoRoot).catch(() => null);
  for (const topic of sharedCfg?.research_agenda_shared ?? []) {
    if (topic.trim() && !items.some((i) => i.topic === topic.trim())) {
      items.push({ topic: topic.trim(), lineIdx: -1, shared: true });
    }
  }

  return items;
}

/**
 * Mark an agenda item as done by replacing `- [ ]` with `- [x]` at `lineIdx`.
 * Shared items (lineIdx === -1) are skipped.
 */
export async function markDone(repoRoot: string, lineIdx: number): Promise<void> {
  if (lineIdx === -1) return; // shared item — never mark done
  const filePath = agendaPath(repoRoot);
  const content = await fs.readFile(filePath, "utf8");
  const lines = content.split("\n");
  if (lineIdx < lines.length) {
    lines[lineIdx] = lines[lineIdx].replace(/^(-\s+)\[\s+\]/, "$1[x]");
    await fs.writeFile(filePath, lines.join("\n"));
  }
}

/**
 * Create a default `wiki/research-agenda.md` if it doesn't exist.
 */
export async function ensureAgendaFile(repoRoot: string): Promise<void> {
  const filePath = agendaPath(repoRoot);
  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      [
        `---`,
        `type: meta`,
        `title: "Research Agenda"`,
        `tags: [agenda, research]`,
        `---`,
        ``,
        `# Research Agenda`,
        ``,
        `Add topics below to research automatically with \`Legion: Drain Research Agenda\`.`,
        ``,
        `## Pending`,
        ``,
        `- [ ] Example topic — replace with your own`,
        ``,
        `## Completed`,
        ``,
        `_(Completed items are moved here automatically)_`,
        ``,
      ].join("\n")
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function agendaPath(repoRoot: string): string {
  return path.join(repoRoot, WIKI_REL, AGENDA_FILENAME);
}

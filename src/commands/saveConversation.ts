import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { injectAddresses } from "../driver/addressAllocator";

const WIKI_REL = path.join("library", "knowledge-base", "wiki");

/**
 * Legion: Save Note — file the current conversation, meeting notes, or any
 * insight as a structured wiki source page.
 *
 * Equivalent to claude-obsidian's `/save` command.
 */
export async function saveConversation(repoRoot: string): Promise<void> {
  if (!repoRoot) {
    vscode.window.showErrorMessage("Legion: Open a folder first.");
    return;
  }

  const wikiRoot = path.join(repoRoot, WIKI_REL);

  // ── Step 1: Title ──────────────────────────────────────────────────────────
  const title = await vscode.window.showInputBox({
    prompt: "Title for this wiki note",
    placeHolder: "e.g. Auth strategy decision, Sprint retro 2026-04-30",
    validateInput: (v) => (v.trim() ? undefined : "Title is required"),
  });
  if (!title) return;

  // ── Step 2: Note type ──────────────────────────────────────────────────────
  const noteType = await vscode.window.showQuickPick(
    [
      { label: "$(comment) Conversation / chat", type: "conversation" },
      { label: "$(calendar) Meeting notes", type: "meeting" },
      { label: "$(lightbulb) Insight / idea", type: "insight" },
      { label: "$(law) Decision / ADR", type: "decision" },
      { label: "$(book) Reference / research", type: "source" },
    ],
    { placeHolder: "Note type" }
  );
  if (!noteType) return;

  // ── Step 3: Open scratch document for content entry ────────────────────────
  const dateStr = new Date().toISOString().slice(0, 10);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  const template = buildTemplate(title, noteType.type, dateStr);

  const doc = await vscode.workspace.openTextDocument({
    content: template,
    language: "markdown",
  });
  const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);

  // Position cursor at the body section
  const bodyLine = template.split("\n").findIndex((l) => l === "## Content") + 1;
  if (bodyLine > 0) {
    const pos = new vscode.Position(bodyLine + 1, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos));
  }

  // ── Step 4: Prompt to save ─────────────────────────────────────────────────
  const save = await vscode.window.showInformationMessage(
    `Legion: Edit your note above, then click "Save to Wiki" to file it.`,
    "Save to Wiki",
    "Cancel"
  );
  if (save !== "Save to Wiki") return;

  const content = editor.document.getText();
  const destDir = noteType.type === "decision"
    ? path.join(wikiRoot, "decisions")
    : path.join(wikiRoot, "sources");
  const destPath = path.join(destDir, `${slug}.md`);

  try {
    await fs.mkdir(destDir, { recursive: true });
    // Don't overwrite — add timestamp suffix if exists
    let finalPath = destPath;
    try {
      await fs.access(destPath);
      const ts = Date.now();
      finalPath = path.join(destDir, `${slug}-${ts}.md`);
    } catch {}

    await fs.writeFile(finalPath, content);

    // Inject address
    const relPath = `${noteType.type === "decision" ? "decisions" : "sources"}/${path.basename(finalPath)}`;
    await injectAddresses(repoRoot, wikiRoot, [relPath]).catch(() => undefined);

    // Append to log.md
    const logPath = path.join(wikiRoot, "log.md");
    const logEntry = `\n## [${dateStr}] save | ${title} | created: 1\n`;
    await fs.appendFile(logPath, logEntry).catch(() => undefined);

    vscode.window.showInformationMessage(
      `Legion: Saved to wiki — ${relPath}`
    );
  } catch (e) {
    vscode.window.showErrorMessage(
      `Legion: Save failed — ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

function buildTemplate(title: string, type: string, dateStr: string): string {
  const typeMap: Record<string, string> = {
    conversation: "source",
    meeting: "source",
    insight: "concept",
    decision: "decision",
    source: "source",
  };

  return [
    `---`,
    `type: ${typeMap[type] ?? "source"}`,
    `title: "${title}"`,
    `note_type: ${type}`,
    `created: "${dateStr}"`,
    `tags: [${type}]`,
    `---`,
    ``,
    `# ${title}`,
    ``,
    `## Content`,
    ``,
    `_(Write your notes here)_`,
    ``,
    `## Key takeaways`,
    ``,
    `- `,
    ``,
  ].join("\n");
}

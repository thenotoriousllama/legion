import { type App, TFile, MarkdownPostProcessorContext } from "obsidian";

const WIKI_PATH_MARKER = "library/knowledge-base/wiki";
const HUMAN_NOTES_HEADING = "## Human Notes";

/**
 * A MarkdownPostProcessor that injects an "Annotate" button into wiki entity pages.
 * Clicking the button appends a `## Human Notes` section (if absent) and opens
 * the file for editing. Legion's wiki-guardian is instructed never to overwrite
 * `## Human Notes` sections.
 */
export function createAnnotateProcessor(app: App) {
  return (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
    // Only activate for files inside the Legion wiki directory
    if (!ctx.sourcePath.includes(WIKI_PATH_MARKER)) return;

    const actionBar = el.createEl("div", { cls: "legion-annotate-bar" });
    const btn = actionBar.createEl("button", {
      text: "✎ Annotate",
      cls: "legion-annotate-btn",
    });
    btn.title = "Append a ## Human Notes section to this wiki page";

    btn.addEventListener("click", () => {
      void appendHumanNotes(app, ctx.sourcePath);
    });

    // Insert at the very beginning of the rendered output so it's always visible
    el.prepend(actionBar);
  };
}

async function appendHumanNotes(app: App, filePath: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) return;

  const content = await app.vault.read(file);

  if (content.includes(HUMAN_NOTES_HEADING)) {
    // Section already exists — just open for editing
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(file);
    return;
  }

  // Append the Human Notes section
  const separator = content.endsWith("\n") ? "\n" : "\n\n";
  const updated = content + separator + HUMAN_NOTES_HEADING + "\n\n";
  await app.vault.modify(file, updated);

  // Open in editing mode
  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(file);
}

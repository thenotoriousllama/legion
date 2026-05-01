import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { parseFrontmatter } from "../util/frontmatter";

const WIKI_REL = path.join("library", "knowledge-base", "wiki");
const WIKI_DIRS = ["entities", "concepts", "decisions", "sources", "questions", "comparisons", "folds", "meta"];

interface PageEntry {
  name: string;
  relPath: string; // e.g. "entities/get-user"
  type: string;
  status: string;
}

/**
 * Provides wikilink autocompletion in any Markdown file inside the wiki.
 *
 * Trigger: typing double-open-bracket inside library/knowledge-base/wiki.
 * Each completion inserts PageName plus closing brackets.
 * The description shows the entity type and status badge.
 *
 * The page index is lazily built on first use and invalidated when a wiki file
 * is saved (watcher registered in extension.ts).
 */
export class WikilinkCompletionProvider implements vscode.CompletionItemProvider {
  private _cache: PageEntry[] | null = null;

  constructor(private readonly repoRoot: string) {}

  invalidateCache(): void {
    this._cache = null;
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionItem[] | undefined> {
    // Only trigger inside the wiki directory
    if (!this.isInsideWiki(document.uri.fsPath)) return undefined;

    // Check that we're inside a `[[...` trigger
    const lineText = document.lineAt(position).text;
    const charBefore = lineText.slice(0, position.character);
    if (!charBefore.endsWith("[[")) return undefined; // eslint-disable-line no-useless-escape

    const pages = await this.getPages();
    return pages.map((p) => {
      const item = new vscode.CompletionItem(p.name, vscode.CompletionItemKind.Reference);
      // Insert the page name + closing ]] to complete the wikilink
      item.insertText = `${p.name}]]`;
      item.detail = `${p.relPath}.md`;
      item.documentation = new vscode.MarkdownString(
        `**${p.type}** · ${p.status || "seed"}`
      );
      item.sortText = p.name.toLowerCase();
      return item;
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private isInsideWiki(fsPath: string): boolean {
    const wikiRoot = path.join(this.repoRoot, WIKI_REL);
    return fsPath.startsWith(wikiRoot);
  }

  private async getPages(): Promise<PageEntry[]> {
    if (this._cache) return this._cache;

    const wikiRoot = path.join(this.repoRoot, WIKI_REL);
    const pages: PageEntry[] = [];

    for (const dir of WIKI_DIRS) {
      const dirPath = path.join(wikiRoot, dir);
      let files: string[];
      try {
        files = await fs.readdir(dirPath);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".md") || file.startsWith("_")) continue;
        const name = file.replace(/\.md$/, "");
        let type = dir.replace(/s$/, ""); // "entities" → "entity"
        let status = "";
        try {
          const content = await fs.readFile(path.join(dirPath, file), "utf8");
          const fm = parseFrontmatter(content);
          type = fm["entity_type"] ?? fm["type"] ?? type;
          status = fm["status"] ?? "";
        } catch {}
        pages.push({ name, relPath: `${dir}/${name}`, type, status });
      }
    }

    this._cache = pages;
    return pages;
  }
}

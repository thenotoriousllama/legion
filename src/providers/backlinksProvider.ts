import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";

const WIKI_REL = path.join("library", "knowledge-base", "wiki");
const WIKILINK_RE = /\[\[([^\]|#]+?)(?:[|#][^\]]*?)?\]\]/g;

export class BacklinkItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly sourcePath: string,
    public readonly lineNumber: number,
    public readonly linePreview: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = linePreview.trim().slice(0, 60);
    this.tooltip = `${sourcePath}:${lineNumber + 1}`;
    this.command = {
      command: "vscode.open",
      title: "Go to backlink",
      arguments: [
        vscode.Uri.file(sourcePath),
        {
          selection: new vscode.Range(lineNumber, 0, lineNumber, 0),
          viewColumn: vscode.ViewColumn.Active,
        },
      ],
    };
    this.iconPath = new vscode.ThemeIcon("references");
  }
}

/**
 * Shows all wiki pages that link to the currently active wiki page via `[[wikilinks]]`.
 *
 * Automatically updates when:
 * - The active editor changes to a file inside the wiki
 * - A wiki file is saved (cache invalidation)
 *
 * The backlink index is a simple in-memory map built from a full wiki scan
 * (lazy, cached, invalidated on save).
 */
export class BacklinksProvider implements vscode.TreeDataProvider<BacklinkItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BacklinkItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** map: page name (without .md) → list of {sourcePath, lineNumber, lineText} */
  private _index: Map<string, Array<{ sourcePath: string; line: number; text: string }>> | null = null;
  private _currentPageName: string | null = null;

  constructor(private readonly repoRoot: string) {}

  invalidateCache(): void {
    this._index = null;
    this._onDidChangeTreeData.fire(null);
  }

  setActiveFile(fsPath: string | undefined): void {
    const wikiRoot = path.join(this.repoRoot, WIKI_REL);
    if (!fsPath || !fsPath.startsWith(wikiRoot)) {
      this._currentPageName = null;
      this._onDidChangeTreeData.fire(null);
      return;
    }
    const name = path.basename(fsPath, ".md");
    if (name !== this._currentPageName) {
      this._currentPageName = name;
      this._onDidChangeTreeData.fire(null);
    }
  }

  getTreeItem(element: BacklinkItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<BacklinkItem[]> {
    if (!this.repoRoot || !this._currentPageName) return [];

    const index = await this.getIndex();
    const backlinks = index.get(this._currentPageName.toLowerCase()) ?? [];

    if (backlinks.length === 0) {
      const empty = new vscode.TreeItem("No backlinks found");
      empty.description = `Nothing links to [[${this._currentPageName}]] yet`;
      empty.iconPath = new vscode.ThemeIcon("info");
      return [empty as BacklinkItem];
    }

    return backlinks.map(
      (b) =>
        new BacklinkItem(
          path.basename(b.sourcePath, ".md"),
          b.sourcePath,
          b.line,
          b.text
        )
    );
  }

  // ── Index builder ──────────────────────────────────────────────────────────

  private async getIndex(): Promise<Map<string, Array<{ sourcePath: string; line: number; text: string }>>> {
    if (this._index) return this._index;

    const wikiRoot = path.join(this.repoRoot, WIKI_REL);
    const index = new Map<string, Array<{ sourcePath: string; line: number; text: string }>>();

    await this.scanDir(wikiRoot, index);

    this._index = index;
    return index;
  }

  private async scanDir(
    dir: string,
    index: Map<string, Array<{ sourcePath: string; line: number; text: string }>>
  ): Promise<void> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.scanDir(absPath, index);
      } else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("_")) {
        await this.indexFile(absPath, index);
      }
    }
  }

  private async indexFile(
    absPath: string,
    index: Map<string, Array<{ sourcePath: string; line: number; text: string }>>
  ): Promise<void> {
    let content: string;
    try {
      content = await fs.readFile(absPath, "utf8");
    } catch {
      return;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      WIKILINK_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = WIKILINK_RE.exec(line)) !== null) {
        // Target is the last path segment, lowercased
        const target = m[1].trim().split("/").pop()?.replace(/\.md$/, "")?.toLowerCase() ?? "";
        if (!target) continue;
        const existing = index.get(target) ?? [];
        existing.push({ sourcePath: absPath, line: i, text: line });
        index.set(target, existing);
      }
    }
  }
}

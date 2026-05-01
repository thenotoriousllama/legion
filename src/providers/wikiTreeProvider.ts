import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { parseFrontmatter } from "../util/frontmatter";

const WIKI_REL = path.join("library", "knowledge-base", "wiki");

const WIKI_FOLDERS: Array<{ id: string; label: string; dir: string; icon: string }> = [
  { id: "entities", label: "Entities", dir: "entities", icon: "symbol-method" },
  { id: "concepts", label: "Concepts", dir: "concepts", icon: "lightbulb" },
  { id: "decisions", label: "Decisions (ADRs)", dir: "decisions", icon: "law" },
  { id: "sources", label: "Sources", dir: "sources", icon: "references" },
  { id: "questions", label: "Questions", dir: "questions", icon: "question" },
  { id: "comparisons", label: "Comparisons", dir: "comparisons", icon: "diff" },
  { id: "folds", label: "Folds", dir: "folds", icon: "fold" },
  { id: "meta", label: "Meta", dir: "meta", icon: "info" },
];

const STATUS_ICONS: Record<string, string> = {
  evergreen: "$(star-full)",
  mature: "$(verified)",
  developing: "$(sync~spin)",
  seed: "$(circle-outline)",
  stub: "$(dash)",
};

export class WikiTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: "folder" | "page",
    public readonly absPath?: string,
    public readonly status?: string
  ) {
    super(label, collapsibleState);
    if (itemType === "page" && absPath) {
      this.command = {
        command: "vscode.open",
        title: "Open wiki page",
        arguments: [vscode.Uri.file(absPath)],
      };
      this.tooltip = absPath;
      const icon = status ? STATUS_ICONS[status] : undefined;
      this.description = status ? icon || status : undefined;
      this.resourceUri = vscode.Uri.file(absPath);
    }
  }
}

/**
 * Provides a tree view of the wiki organized by type folder.
 * Each leaf node is a wiki page — clicking opens it in the native VS Code editor.
 */
export class WikiTreeProvider implements vscode.TreeDataProvider<WikiTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<WikiTreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly repoRoot: string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(null);
  }

  getTreeItem(element: WikiTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: WikiTreeItem): Promise<WikiTreeItem[]> {
    if (!this.repoRoot) return [];

    const wikiRoot = path.join(this.repoRoot, WIKI_REL);

    if (!element) {
      // Root level: return folder nodes
      const items: WikiTreeItem[] = [];
      for (const folder of WIKI_FOLDERS) {
        const dirPath = path.join(wikiRoot, folder.dir);
        let fileCount = 0;
        try {
          const files = await fs.readdir(dirPath);
          fileCount = files.filter((f) => f.endsWith(".md") && !f.startsWith("_")).length;
        } catch {}
        if (fileCount > 0) {
          const item = new WikiTreeItem(
            `${folder.label} (${fileCount})`,
            vscode.TreeItemCollapsibleState.Collapsed,
            "folder"
          );
          item.iconPath = new vscode.ThemeIcon(folder.icon);
          item.contextValue = `wikiFolder:${folder.id}`;
          // Store folder info for getChildren
          (item as WikiTreeItem & { _folderId: string })._folderId = folder.id;
          items.push(item);
        }
      }
      return items;
    }

    // Folder level: return page nodes
    const folderId = (element as WikiTreeItem & { _folderId?: string })._folderId;
    if (!folderId) return [];
    const folder = WIKI_FOLDERS.find((f) => f.id === folderId);
    if (!folder) return [];

    const dirPath = path.join(wikiRoot, folder.dir);
    let files: string[];
    try {
      files = await fs.readdir(dirPath);
    } catch {
      return [];
    }

    const pages: WikiTreeItem[] = [];
    for (const file of files.filter((f) => f.endsWith(".md") && !f.startsWith("_"))) {
      const absPath = path.join(dirPath, file);
      const name = file.replace(/\.md$/, "");
      let status = "";
      try {
        const content = await fs.readFile(absPath, "utf8");
        const fm = parseFrontmatter(content);
        status = fm["status"] ?? "";
      } catch {}

      pages.push(
        new WikiTreeItem(name, vscode.TreeItemCollapsibleState.None, "page", absPath, status)
      );
    }

    return pages.sort((a, b) => a.label.localeCompare(b.label as string));
  }
}

import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";

const WIKI_ENTITY_DIR = path.join("library", "knowledge-base", "wiki", "entities");

// Matches top-level export function/class/const/arrow-function declarations.
const DEFINITION_RE =
  /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\s+(\w+)|class\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$]\w*)\s*=>)/gm;

/**
 * Shows a "Legion: wiki page ↗" code lens above every exported function, class,
 * or arrow-function definition that has a matching entity page in the wiki.
 *
 * Controlled by the `legion.showCodeLens` setting (default `true`).
 */
export class EntityCodeLensProvider implements vscode.CodeLensProvider {
  private _entityCache: Set<string> | null = null;

  constructor(private readonly repoRoot: string) {}

  invalidateCache(): void {
    this._entityCache = null;
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const config = vscode.workspace.getConfiguration("legion");
    if (!config.get<boolean>("showCodeLens", true)) return [];

    const entityNames = await this.getEntityNames();
    if (entityNames.size === 0) return [];

    const text = document.getText();
    const lenses: vscode.CodeLens[] = [];
    let match: RegExpExecArray | null;

    DEFINITION_RE.lastIndex = 0;
    while ((match = DEFINITION_RE.exec(text)) !== null) {
      const name = match[1] ?? match[2] ?? match[3];
      if (!name) continue;

      // Check exact, kebab, and lowercase variants
      const found =
        entityNames.has(name.toLowerCase()) ||
        entityNames.has(toKebabCase(name));

      if (!found) continue;

      const pos = document.positionAt(match.index);
      const range = new vscode.Range(pos, pos);
      const wikiName = entityNames.has(name.toLowerCase()) ? name.toLowerCase() : toKebabCase(name);
      const wikiPageAbs = path.join(
        this.repoRoot,
        WIKI_ENTITY_DIR,
        `${wikiName}.md`
      );

      lenses.push(
        new vscode.CodeLens(range, {
          title: "$(book) Legion wiki page",
          command: "vscode.open",
          arguments: [vscode.Uri.file(wikiPageAbs), { viewColumn: vscode.ViewColumn.Beside }],
          tooltip: `Open ${wikiName}.md`,
        })
      );
    }

    return lenses;
  }

  private async getEntityNames(): Promise<Set<string>> {
    if (this._entityCache) return this._entityCache;

    const entityDir = path.join(this.repoRoot, WIKI_ENTITY_DIR);
    const set = new Set<string>();
    try {
      const files = await fs.readdir(entityDir);
      for (const file of files) {
        if (file.endsWith(".md") && !file.startsWith("_")) {
          set.add(file.replace(/\.md$/, "").toLowerCase());
        }
      }
    } catch {
      // Wiki not initialized yet.
    }
    this._entityCache = set;
    return set;
  }
}

function toKebabCase(s: string): string {
  return s
    .replace(/([A-Z])/g, "-$1")
    .toLowerCase()
    .replace(/^-/, "");
}

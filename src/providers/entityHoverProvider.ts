import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { parseFrontmatter, extractFirstBody } from "../util/frontmatter";

const WIKI_ENTITY_DIR = path.join("library", "knowledge-base", "wiki", "entities");

/**
 * Provides inline hover cards for code symbols that have a matching wiki
 * entity page. When the user hovers over a function or class name, Legion
 * checks `library/knowledge-base/wiki/entities/<name>.md` (trying both
 * camelCase and kebab-case variants) and renders a compact mini-card.
 *
 * The entity index is cached in memory for the session and invalidated
 * whenever a reconcile pass runs (call `invalidateCache()`).
 */
export class EntityHoverProvider implements vscode.HoverProvider {
  private _cache: Map<string, string> | null = null;

  constructor(private readonly repoRoot: string) {}

  invalidateCache(): void {
    this._cache = null;
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_$][A-Za-z0-9_$]*/);
    if (!wordRange) return undefined;
    const word = document.getText(wordRange);
    if (word.length < 3) return undefined;

    const pagePath = await this.resolveEntityPage(word);
    if (!pagePath) return undefined;

    let content: string;
    try {
      content = await fs.readFile(pagePath, "utf8");
    } catch {
      return undefined;
    }

    const fm = parseFrontmatter(content);
    const firstBody = extractFirstBody(content);
    const entityName = path.basename(pagePath, ".md");
    const entityType = fm["entity_type"] ?? fm["type"] ?? "entity";
    const status = fm["status"] ?? "";
    const lastCommit = fm["last_commit_hash"] ? fm["last_commit_hash"].slice(0, 7) : "";
    const sourcePath = fm["path"] ?? "";

    const md = new vscode.MarkdownString("", true);
    md.isTrusted = true;
    md.appendMarkdown(`**$(book) Legion — ${entityName}**\n\n`);
    md.appendMarkdown(`| | |\n|---|---|\n`);
    md.appendMarkdown(`| Type | \`${entityType}\` |\n`);
    if (status) md.appendMarkdown(`| Status | ${status} |\n`);
    if (lastCommit) md.appendMarkdown(`| Last commit | \`${lastCommit}\` |\n`);
    if (sourcePath) md.appendMarkdown(`| Source | \`${sourcePath}\` |\n`);
    if (firstBody) {
      md.appendMarkdown(`\n${firstBody}\n`);
    }
    const wikiRelPath = path.relative(this.repoRoot, pagePath).replace(/\\/g, "/");
    md.appendMarkdown(
      `\n\n[Open wiki page](command:vscode.open?${encodeURIComponent(JSON.stringify([vscode.Uri.file(pagePath)]))})`
    );

    void wikiRelPath; // used implicitly via pagePath

    return new vscode.Hover(md, wordRange);
  }

  private async resolveEntityPage(word: string): Promise<string | undefined> {
    const cache = await this.getCache();

    // Try exact match first, then kebab-case conversion
    const candidates = [
      word,
      toKebabCase(word),
      word.charAt(0).toLowerCase() + word.slice(1),
    ];

    for (const candidate of candidates) {
      const found = cache.get(candidate.toLowerCase());
      if (found) return found;
    }
    return undefined;
  }

  private async getCache(): Promise<Map<string, string>> {
    if (this._cache) return this._cache;

    const entityDir = path.join(this.repoRoot, WIKI_ENTITY_DIR);
    const map = new Map<string, string>();
    try {
      const files = await fs.readdir(entityDir);
      for (const file of files) {
        if (!file.endsWith(".md") || file.startsWith("_")) continue;
        const name = file.replace(/\.md$/, "").toLowerCase();
        map.set(name, path.join(entityDir, file));
      }
    } catch {
      // Wiki not yet initialized — return empty cache.
    }
    this._cache = map;
    return map;
  }
}

function toKebabCase(s: string): string {
  return s
    .replace(/([A-Z])/g, "-$1")
    .toLowerCase()
    .replace(/^-/, "");
}

import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { parseFrontmatter } from "../util/frontmatter";
import { resolveRepoRoot, resolveWikiRoot } from "../util/repoRoot";
import { query as semanticQuery, type SearchResult } from "../driver/semanticSearch";

const WIKI_SUBDIRS = ["entities", "concepts", "decisions", "comparisons", "questions"];

interface EntityItem extends vscode.QuickPickItem {
  wikiPageAbs: string;
  sourcePath: string;
  sourceLine: number;
}

/**
 * Legion: Find Entity — searches wiki pages using semantic search (Cohere or TF-IDF)
 * when `legion.semanticSearchEnabled` is true, falling back to VS Code fuzzy match otherwise.
 */
export async function findEntity(context: vscode.ExtensionContext): Promise<void> {
  const repoRoot = await resolveRepoRoot({ context });
  if (!repoRoot) return;

  const cfg = vscode.workspace.getConfiguration("legion");
  const semanticEnabled = cfg.get<boolean>("semanticSearchEnabled", true);

  if (semanticEnabled) {
    await findEntitySemantic(repoRoot);
  } else {
    await findEntityFuzzy(repoRoot);
  }
}

async function findEntitySemantic(repoRoot: string): Promise<void> {
  const wikiRoot = resolveWikiRoot(repoRoot);
  const cfg = vscode.workspace.getConfiguration("legion");
  const cohereKey = cfg.get<string>("cohereApiKey", "").trim() ||
    process.env.LEGION_COHERE_API_KEY || "";
  const mode = cohereKey ? "semantic" : "TF-IDF";

  const queryText = await vscode.window.showInputBox({
    prompt: `Search wiki (${mode})…`,
    placeHolder: "e.g. how auth tokens are validated",
  });
  if (!queryText) return;

  let results: SearchResult[];
  try {
    results = await semanticQuery(repoRoot, queryText, 15);
  } catch (err) {
    vscode.window.showErrorMessage(`Legion: Search failed — ${String(err)}`);
    return;
  }

  if (results.length === 0) {
    vscode.window.showInformationMessage(
      "Legion: No results found. Run Document Repository first."
    );
    return;
  }

  const items: EntityItem[] = results.map((r) => {
    const absPath = path.isAbsolute(r.pagePath)
      ? r.pagePath
      : path.join(wikiRoot, r.pagePath);
    const scoreLabel = `score ${r.score.toFixed(2)}`;
    return {
      label: r.title || path.basename(r.pagePath, ".md"),
      description: `$(search) ${scoreLabel}`,
      detail: r.snippet,
      wikiPageAbs: absPath,
      sourcePath: "",
      sourceLine: 1,
    };
  });

  await openPickedEntity(items);
}

async function findEntityFuzzy(repoRoot: string): Promise<void> {
  const wikiRoot = resolveWikiRoot(repoRoot);
  const items: EntityItem[] = [];

  for (const dir of WIKI_SUBDIRS) {
    const dirPath = path.join(wikiRoot, dir);
    let files: string[];
    try {
      files = await fs.readdir(dirPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".md") || file.startsWith("_")) continue;
      const absPath = path.join(dirPath, file);
      let content = "";
      try {
        content = await fs.readFile(absPath, "utf8");
      } catch {
        continue;
      }

      const fm = parseFrontmatter(content);
      const entityName = file.replace(/\.md$/, "");
      const entityType = fm["entity_type"] ?? fm["type"] ?? dir.replace(/s$/, "");
      const sourcePath = fm["path"] ?? "";
      const sourceLine = parseInt(fm["line"] ?? "1", 10) || 1;
      const status = fm["status"] ?? "";

      items.push({
        label: entityName,
        description: `$(symbol-${iconForType(entityType)}) ${entityType}${status ? ` · ${status}` : ""}`,
        detail: sourcePath ? `${sourcePath}:${sourceLine}` : `${dir}/${file}`,
        wikiPageAbs: absPath,
        sourcePath,
        sourceLine,
      });
    }
  }

  if (items.length === 0) {
    vscode.window.showInformationMessage(
      "Legion: No entity pages found. Run Document Repository first."
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Search ${items.length} entity/concept/decision pages…`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  await openPickedEntity([picked]);
}

async function openPickedEntity(items: EntityItem[]): Promise<void> {
  let picked: EntityItem | undefined;
  if (items.length === 1) {
    picked = items[0];
  } else {
    picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Select a wiki page to open",
      matchOnDescription: true,
      matchOnDetail: true,
    });
  }
  if (!picked) return;

  const action = await vscode.window.showQuickPick(
    [
      { label: "$(book) Open wiki page", id: "wiki" },
      { label: "$(go-to-file) Jump to source file", id: "source" },
    ],
    { placeHolder: picked.label }
  );
  if (!action) return;

  if (action.id === "wiki") {
    const doc = await vscode.workspace.openTextDocument(picked.wikiPageAbs);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  } else if (action.id === "source" && picked.sourcePath) {
    const repoRootGuess = picked.wikiPageAbs.split(path.sep + "library")[0];
    const absSource = path.isAbsolute(picked.sourcePath)
      ? picked.sourcePath
      : path.join(repoRootGuess, picked.sourcePath);
    try {
      const doc = await vscode.workspace.openTextDocument(absSource);
      const editor = await vscode.window.showTextDocument(doc);
      const line = Math.max(0, picked.sourceLine - 1);
      const range = new vscode.Range(line, 0, line, 0);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(range.start, range.start);
    } catch {
      vscode.window.showWarningMessage(
        `Legion: Source file not found: ${picked.sourcePath}`
      );
    }
  } else {
    vscode.window.showInformationMessage("Legion: No source path recorded for this page.");
  }
}

function iconForType(type: string): string {
  switch (type) {
    case "function": return "method";
    case "class": return "class";
    case "module": return "module";
    case "service": return "server";
    case "endpoint": return "globe";
    case "react-component": return "symbol-class";
    case "data-model": return "database";
    case "sql-table": return "database";
    case "feature-flag": return "flag";
    case "decision": return "law";
    case "concept": return "lightbulb";
    default: return "symbol-misc";
  }
}

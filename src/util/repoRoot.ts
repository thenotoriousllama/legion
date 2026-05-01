import * as vscode from "vscode";
import * as path from "path";

export interface RootResolutionOptions {
  context: vscode.ExtensionContext;
  /** When true, QuickPick includes an "All roots" option. Returns "__all__" for that case. */
  allowAll?: boolean;
}

/**
 * Resolve the active repo root for a command invocation.
 *
 * Resolution order:
 * 1. `legion.activeRoot` setting (absolute, or relative to folders[0])
 * 2. Persisted session selection in `context.workspaceState`
 * 3. If only one workspace folder, return it directly (no picker)
 * 4. If multiple folders, show QuickPick and persist selection
 */
export async function resolveRepoRoot(
  options: RootResolutionOptions
): Promise<string> {
  const { context, allowAll } = options;
  const folders = vscode.workspace.workspaceFolders;

  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage("Legion: Open a folder first.");
    return "";
  }

  // 1. Pinned setting
  const cfg = vscode.workspace.getConfiguration("legion");
  const activeRoot = cfg.get<string>("activeRoot", "").trim();
  if (activeRoot) {
    return path.isAbsolute(activeRoot)
      ? activeRoot
      : path.resolve(folders[0].uri.fsPath, activeRoot);
  }

  // 2. Single root — no picker needed
  if (folders.length === 1) {
    return folders[0].uri.fsPath;
  }

  // 3. Session-persisted root
  const sessionRoot = context.workspaceState.get<string>("legion.sessionActiveRoot");
  if (sessionRoot && folders.some((f) => f.uri.fsPath === sessionRoot)) {
    return sessionRoot;
  }

  // 4. QuickPick
  const items: Array<{ label: string; description: string; fsPath: string }> = folders.map((f) => ({
    label: `$(folder) ${f.name}`,
    description: f.uri.fsPath,
    fsPath: f.uri.fsPath,
  }));

  if (allowAll) {
    items.push({
      label: "$(check) All roots",
      description: "Run on all workspace folders sequentially",
      fsPath: "__all__",
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Which workspace root?",
    title: "Legion — select workspace root",
  });

  if (!picked) return "";

  if (picked.fsPath !== "__all__") {
    await context.workspaceState.update("legion.sessionActiveRoot", picked.fsPath);
  }

  return picked.fsPath;
}

/** Clear the persisted session root. Called by legion.clearActiveRoot. */
export function clearSessionRoot(context: vscode.ExtensionContext): void {
  void context.workspaceState.update("legion.sessionActiveRoot", undefined);
}

/**
 * Resolve the wiki output directory for a repo root.
 * Respects `legion.wikiRoot` setting; falls back to `<repoRoot>/library/knowledge-base/wiki/`.
 */
export function resolveWikiRoot(repoRoot: string): string {
  if (!repoRoot) return "";
  const cfg = vscode.workspace.getConfiguration("legion");
  const override = cfg.get<string>("wikiRoot", "").trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(repoRoot, override);
  }
  return path.join(repoRoot, "library", "knowledge-base", "wiki");
}

/**
 * Returns the list of scan roots for monorepo mode.
 * Returns [repoRoot] when `legion.scanRoots` is empty (single-root mode).
 */
export function resolveScanRoots(repoRoot: string): string[] {
  if (!repoRoot) return [];
  const cfg = vscode.workspace.getConfiguration("legion");
  const scanRoots = cfg.get<string[]>("scanRoots", []);
  if (!scanRoots || scanRoots.length === 0) return [repoRoot];
  return scanRoots.map((r) => (path.isAbsolute(r) ? r : path.resolve(repoRoot, r)));
}
